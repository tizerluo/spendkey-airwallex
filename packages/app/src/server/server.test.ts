import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AirwallexClient, loadAirwallexConfig } from '@sk/airwallex';
import { InMemoryLedgerStore, verifyChain } from '@sk/ledger';
import { termsHash, type ApprovalRequest } from '@sk/policy';
import { CONSOLE_CSP } from '../views/html.js';
import { createFakeAirwallex } from '../demo/fake-airwallex.js';
import { createConsoleServer } from './http.js';
import { ApprovalService } from './service.js';
import { JsonApprovalStore, MemoryApprovalStore, type ApprovalStore } from './store.js';
import { monthWindow, spentInWindowMinor, TransactionLoop } from './transactions.js';

const instant = '2026-11-11T10:00:00.000Z';
function approvalRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return { approvalRequestId: 'request_test_01', offerId: 'offer_test_monthly', vendor: 'DesignCo', product: 'Team plan',
    plan: 'monthly', rail: 'card', currency: 'USD', amountMinor: 6000, interval: 'MONTHLY', allowedTransactionCount: 'MULTIPLE',
    merchantCategoryCode: '7372', commitmentMonths: 0, priceStatus: 'price_unverified', createdAt: instant,
    expiresAt: '2026-11-11T10:15:00.000Z', ...overrides };
}
async function fixture(options: { unconfirmedCreate?: boolean; store?: ApprovalStore; noMcc?: boolean } = {}) {
  let time = new Date(instant);
  const now = () => time;
  const fake = createFakeAirwallex({ now, ...(options.unconfirmedCreate ? { unconfirmedCreate: true } : {}) });
  const client = new AirwallexClient(loadAirwallexConfig({ AIRWALLEX_CLIENT_ID: 'test-client-id', AIRWALLEX_API_KEY: 'test-api-key' }), { fetch: fake.fetch });
  const ledger = new InMemoryLedgerStore(); const store = options.store ?? new MemoryApprovalStore();
  const printed: string[] = [];
  const service = new ApprovalService({ client, ledger, store, now, cardholderId: 'cardholder_test_01', printNonce: line => printed.push(line) });
  const request = approvalRequest(); if (options.noMcc) delete request.merchantCategoryCode;
  const submitted = await service.submit(request);
  const nonce = printed[0]!.split(': ')[1]!;
  const fields = { nonce, csrf: service.get(submitted.id).csrf, presentedTermsHash: termsHash(request),
    ...(options.noMcc ? { merchantCategoryCode: '7372' } : {}) };
  return { service, client, ledger, store, fake, request, nonce, fields, printed, loop: new TransactionLoop(service),
    setTime(value: string) { time = new Date(value); },
    grant: () => service.grant(request.approvalRequestId, fields),
  };
}
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  vi.restoreAllMocks();
});
async function start(service: ApprovalService, webhookSecret?: string) {
  const server = createConsoleServer(service, webhookSecret ? { webhookSecret } : {}); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('test_listen_failed');
  return async (path: string, body?: unknown, headers: Record<string, string> = {}, raw?: string) => {
    const data = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    return new Promise<{ status: number; text: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: address.port, path, method: data === undefined ? 'GET' : 'POST',
        headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }), ...headers },
      }, response => {
        const parts: Buffer[] = []; response.on('data', (chunk: Buffer) => parts.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode!, text: Buffer.concat(parts).toString(), headers: response.headers }));
      });
      req.on('error', reject); req.end(data);
    });
  };
}

describe('durable approval state machine', () => {
  it('persists approval identity before create, then concurrent issue/reuse never creates twice', async () => {
    const f = await fixture(); const original = f.client.createCard.bind(f.client);
    vi.spyOn(f.client, 'createCard').mockImplementation(async input => {
      expect(f.store.get(f.request.approvalRequestId)).toMatchObject({ status: 'issuing', attempted: true,
        approval: { approvalId: expect.any(String) }, input: { request_id: input.request_id } });
      return original(input);
    });
    const granted = f.grant();
    const recovered = f.service.issue(f.request.approvalRequestId);
    const [first, second] = await Promise.all([granted, recovered]);
    expect(first.card).toEqual(second.card);
    const approvalId = first.approval!.approvalId;
    await f.service.issue(f.request.approvalRequestId);
    await expect(f.grant()).rejects.toThrow('approval_issued');
    expect(f.service.get(f.request.approvalRequestId).approval!.approvalId).toBe(approvalId);
    expect(f.fake.createCalls).toBe(1);
    expect(f.ledger.read().filter(({ event }) => event.kind === 'card_issued')).toHaveLength(1);
  });
  it('expires using the server clock and rejects a late human approval', async () => {
    const f = await fixture(); f.setTime(f.request.expiresAt);
    await expect(f.grant()).rejects.toThrow('approval_expired');
    expect(f.service.get(f.request.approvalRequestId).status).toBe('expired'); expect(f.fake.createCalls).toBe(0);
  });
  it('checks expiry again between approval persistence and issuance', async () => {
    const f = await fixture(); const save = f.store.save.bind(f.store);
    vi.spyOn(f.store, 'save').mockImplementation(record => { save(record); if (record.status === 'approved') f.setTime(f.request.expiresAt); });
    await expect(f.grant()).rejects.toThrow('approval_expired'); expect(f.fake.createCalls).toBe(0);
    expect(f.store.get(f.request.approvalRequestId)?.status).toBe('expired');
  });
  it('recovers an unconfirmed create by original request id, including across service restart', async () => {
    const f = await fixture({ unconfirmedCreate: true });
    const lookup = vi.spyOn(f.client, 'findCardByRequestId').mockRejectedValueOnce(new Error('test_lookup_failed'));
    await expect(f.grant()).rejects.toThrow('card_issue_unconfirmed');
    const stored = f.store.get(f.request.approvalRequestId)!;
    expect(stored).toMatchObject({ status: 'failed', attempted: true });
    const restarted = new ApprovalService(f.service.options);
    lookup.mockRestore();
    f.setTime('2026-11-11T10:20:00.000Z'); // Recover a created card even after approval expiry.
    const result = await restarted.issue(f.request.approvalRequestId);
    expect(result.status).toBe('issued'); expect(result.approval?.approvalId).toBe(stored.approval!.approvalId);
    expect(result.input?.request_id).toBe(stored.input!.request_id); expect(f.fake.createCalls).toBe(1);
    expect(f.ledger.read().map(({ event }) => event.kind)).toEqual([
      'approval_requested', 'approval_granted', 'card_issue_unconfirmed', 'raw_response', 'card_issued',
    ]);
    expect(verifyChain(f.ledger.read()).ok).toBe(true);
    const raw = f.ledger.read().find(({ event }) => event.kind === 'raw_response')!.event;
    expect(JSON.stringify(raw)).not.toMatch(/test-session|test-api-key|test-cvv|synthetic-disallowed-field/);
  });
  it('retains a partial created card id when polling fails', async () => {
    const f = await fixture(); vi.spyOn(f.client, 'getCard').mockRejectedValueOnce(new Error('test_poll_failed'));
    await expect(f.grant()).rejects.toThrow('card_issue_unconfirmed');
    expect(f.store.get(f.request.approvalRequestId)?.card?.cardId).toBe('card_test_1');
    await f.service.issue(f.request.approvalRequestId); expect(f.fake.createCalls).toBe(1);
  });
  it('never replays a create whose response was lost after the side effect', async () => {
    const f = await fixture(); const original = f.client.createCard.bind(f.client);
    vi.spyOn(f.client, 'createCard').mockImplementationOnce(async input => { await original(input); throw new Error('test_response_lost'); });
    await expect(f.grant()).rejects.toThrow('card_issue_unconfirmed');
    await f.service.issue(f.request.approvalRequestId); expect(f.fake.createCalls).toBe(1);
  });
  it('does not create again when an uncertain attempt cannot yet be found', async () => {
    const f = await fixture(); vi.spyOn(f.client, 'createCard').mockRejectedValueOnce(new Error('test_network_failure'));
    await expect(f.grant()).rejects.toThrow('card_issue_unconfirmed');
    await expect(f.service.issue(f.request.approvalRequestId)).rejects.toThrow('card_issue_unconfirmed');
    expect(f.client.createCard).toHaveBeenCalledOnce();
  });
  it('persists the approval JSON atomically and excludes the plaintext nonce', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spendkey-store-')); const path = join(dir, 'approvals.json');
    try {
      const store = new JsonApprovalStore(path); const f = await fixture({ store }); await f.grant();
      expect(readFileSync(path, 'utf8')).not.toContain(f.nonce);
      expect(() => new JsonApprovalStore(path)).toThrow();
      const approvalId = f.store.get(f.request.approvalRequestId)!.approval!.approvalId; store.close();
      const reopened = new JsonApprovalStore(path);
      expect(reopened.get(f.request.approvalRequestId)?.approval?.approvalId).toBe(approvalId);
      reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('HTTP approval boundary and console', () => {
  it.each(['', 'wrong-test-nonce'])('requires the terminal nonce (%s)', async nonce => {
    const f = await fixture(); const send = await start(f.service);
    const response = await send('/approvals/request_test_01/approve', { ...f.fields, nonce });
    expect(response.status).toBe(403); expect(f.fake.createCalls).toBe(0);
  });
  it.each(['', 'wrong-test-csrf'])('requires CSRF (%s)', async csrf => {
    const f = await fixture(); const send = await start(f.service);
    expect((await send('/approvals/request_test_01/approve', { ...f.fields, csrf })).status).toBe(403);
    expect((await send('/approvals/request_test_01/reject', { csrf })).status).toBe(403);
    expect(f.fake.createCalls).toBe(0);
  });
  it('requires the displayed terms hash without consuming the nonce on validation errors', async () => {
    const f = await fixture(); const send = await start(f.service);
    expect((await send('/approvals/request_test_01/approve', { ...f.fields, presentedTermsHash: 'wrong' })).status).toBe(409);
    expect((await send('/approvals/request_test_01/approve', f.fields)).status).toBe(303);
    expect((await send('/approvals/request_test_01/approve', f.fields)).status).toBe(409);
    expect(f.fake.createCalls).toBe(1);
  });
  it('serves existing renderers with security headers and never leaks nonce in any response or ledger', async () => {
    const f = await fixture(); const send = await start(f.service);
    expect(f.printed[0]).toBe(`APPROVAL NONCE request_test_01: ${f.nonce}`);
    for (const path of ['/', '/approvals/request_test_01', '/audit']) {
      const response = await send(path);
      expect(response.status).toBe(200); expect(response.headers['content-security-policy']).toBe(CONSOLE_CSP);
      expect(response.headers['x-content-type-options']).toBe('nosniff'); expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.text).not.toContain(f.nonce); expect(response.text).not.toContain(f.store.get(f.request.approvalRequestId)!.nonceHash);
    }
    expect(JSON.parse((await send('/approvals', f.request)).text)).toEqual({ id: 'request_test_01' });
    expect(f.printed).toHaveLength(1);
    await send('/approvals/request_test_01/approve', f.fields);
    for (const path of ['/', '/approvals/request_test_01', '/audit', '/audit.jsonl']) expect((await send(path)).text).not.toContain(f.nonce);
    expect(JSON.stringify(f.ledger.read())).not.toContain(f.nonce);
  });
  it('records both hashes when the human supplies a missing MCC', async () => {
    const f = await fixture({ noMcc: true }); const send = await start(f.service);
    const page = await send('/approvals/request_test_01'); expect(page.text).toContain('merchantCategoryCode');
    await send('/approvals/request_test_01/approve', f.fields);
    const event = f.ledger.read().find(({ event }) => event.kind === 'approval_granted')!.event;
    expect(event.kind).toBe('approval_granted');
    if (event.kind === 'approval_granted') {
      expect(event.presentedTermsHash).toBe(termsHash(f.request)); expect(event.termsHash).not.toBe(event.presentedTermsHash);
      expect(event.demoAutoApproved).toBe(false); expect(event.approver).toEqual({ kind: 'human', id: 'console-operator' });
    }
  });
  it('rejects requests without card rail, with expired timestamps, or conflicting ids', async () => {
    const f = await fixture(); const send = await start(f.service);
    expect((await send('/approvals', { ...f.request, rail: 'x402' })).status).toBe(400);
    expect((await send('/approvals', { ...f.request, amountMinor: 6100 })).status).toBe(409);
    expect((await send('/approvals', { ...f.request, approvalRequestId: 'new_test', createdAt: '2026-11-10T00:00:00.000Z', expiresAt: instant })).status).toBe(400);
    expect(f.fake.createCalls).toBe(0);
  });
  it('rejects and expires requests without issuing', async () => {
    const f = await fixture(); const send = await start(f.service);
    expect((await send('/approvals/request_test_01/reject', { csrf: f.fields.csrf })).status).toBe(303);
    expect((await send('/approvals/request_test_01/approve', f.fields)).status).toBe(409);
    expect(f.service.get(f.request.approvalRequestId).status).toBe('rejected'); expect(f.fake.createCalls).toBe(0);
    expect(f.ledger.read().at(-1)?.event).toMatchObject({ kind: 'approval_rejected' });
  });
  it('supports browser form posts and rejects cross-origin posts and DNS rebinding hosts', async () => {
    const f = await fixture(); const send = await start(f.service);
    expect((await send('/approvals/request_test_01/approve', f.fields, { Origin: 'https://untrusted.example' })).status).toBe(403);
    expect((await send('/', undefined, { Host: 'untrusted.example:8787' })).status).toBe(403);
    const form = new URLSearchParams(f.fields).toString();
    expect((await send('/approvals/request_test_01/approve', {}, { 'Content-Type': 'application/x-www-form-urlencoded' }, form)).status).toBe(303);
  });
});

describe('signed webhooks and transaction loop', () => {
  it('returns 404 without a configured webhook secret', async () => {
    const f = await fixture(); const send = await start(f.service);
    expect((await send('/webhooks/airwallex', {})).status).toBe(404);
  });
  it('verifies exact raw bytes, rejects stale/invalid signatures, dedupes across receiver restart', async () => {
    const f = await fixture(); await f.grant(); const key = 'test-webhook-key';
    const send = await start(f.service, key); const timestamp = String(Date.parse(instant));
    const raw = JSON.stringify({ id: 'event_test_01', name: 'issuing.transaction.succeeded', created_at: instant,
      data: { transaction_id: 'transaction_test_webhook', card_id: 'card_test_1', transaction_amount: '10.00', transaction_currency: 'USD', status: 'SUCCEEDED' } });
    const signature = createHmac('sha256', key).update(timestamp).update(raw).digest('hex');
    const headers = { 'x-timestamp': timestamp, 'x-signature': signature };
    expect((await send('/webhooks/airwallex', {}, { ...headers, 'x-signature': 'bad' }, raw)).status).toBe(401);
    expect((await send('/webhooks/airwallex', {}, headers, raw + ' ')).status).toBe(401);
    f.setTime('2026-11-11T10:06:00.000Z');
    expect((await send('/webhooks/airwallex', {}, headers, raw)).status).toBe(401);
    f.setTime(instant);
    expect((await send('/webhooks/airwallex', {}, headers, raw)).status).toBe(200);
    const restarted = await start(f.service, key);
    expect((await restarted('/webhooks/airwallex', {}, headers, raw)).status).toBe(200);
    expect(f.ledger.read().filter(({ event }) => event.kind === 'webhook_received').map(({ event }) => event)).toMatchObject([{ deduped: false }, { deduped: true }]);
    expect(f.ledger.read().filter(({ event }) => event.kind === 'authorization' && event.source === 'observed')).toHaveLength(1);
    expect(spentInWindowMinor(f.ledger, 'USD', monthWindow(new Date(instant)))).toBe(0); // polling is primary
  });
  it('enforces MONTHLY aggregate, MCC, currency, freeze, and emits reconciliation via routes', async () => {
    const f = await fixture(); await f.grant(); const send = await start(f.service);
    const simulate = (amount: string, currency = 'USD', mcc = '7372') => send('/cards/card_test_1/simulate', { amount, currency, mcc, csrf: f.fields.csrf });
    expect(JSON.parse((await simulate('40.00')).text)).toEqual({ mapped: 'approved' });
    expect(JSON.parse((await simulate('25.00')).text)).toEqual({ mapped: 'limit_exceeded' });
    expect(JSON.parse((await simulate('1.00', 'USD', '5812')).text)).toEqual({ mapped: 'merchant_category_not_allowed' });
    expect(JSON.parse((await simulate('1.00', 'EUR')).text)).toEqual({ mapped: 'currency_not_allowed' });
    expect((await send('/cards/card_test_1/freeze', { csrf: 'wrong' })).status).toBe(403);
    expect((await send('/cards/card_test_1/freeze', { csrf: f.fields.csrf })).status).toBe(200);
    expect(JSON.parse((await simulate('1.00')).text)).toEqual({ mapped: 'card_inactive' });
    const reconciliation = await send('/reconcile', { cardId: 'card_test_1', csrf: f.fields.csrf });
    expect(JSON.parse(reconciliation.text)).toMatchObject({ settledMinor: 4000, pendingMinor: 0, failedCount: 4 });
    expect(f.store.get(f.request.approvalRequestId)?.card?.status).toBe('INACTIVE');
    expect((await send('/audit')).text).toContain('INACTIVE');
    expect(f.ledger.read().map(({ event }) => event.kind)).toContain('card_frozen');
    expect(verifyChain(f.ledger.read()).ok).toBe(true);
  });
  it('sums signed settled and pending amounts, excludes failed, and dedupes polls and pages', async () => {
    const f = await fixture(); await f.grant();
    const row = { card_id: 'card_test_1', transaction_currency: 'USD', transaction_date: instant, extra: {} };
    f.fake.transactions.push(
      { ...row, transaction_id: 'transaction_test_a', transaction_amount: '20.00', status: 'SUCCEEDED' },
      { ...row, transaction_id: 'transaction_test_b', transaction_amount: '-3.00', status: 'SUCCEEDED' },
      { ...row, transaction_id: 'transaction_test_c', transaction_amount: '4.00', status: 'PENDING' },
      { ...row, transaction_id: 'transaction_test_d', transaction_amount: '99.00', status: 'FAILED' },
    );
    const listing = vi.spyOn(f.client, 'listTransactions');
    listing.mockResolvedValueOnce({ items: f.fake.transactions, unparsed: [], has_more: true });
    listing.mockResolvedValueOnce({ items: [f.fake.transactions[0]!], unparsed: [], has_more: false });
    expect(await f.loop.reconcile('card_test_1')).toMatchObject({ settledMinor: 1700, pendingMinor: 400, failedCount: 1 });
    expect(spentInWindowMinor(f.ledger, 'USD', monthWindow(new Date(instant)))).toBe(2100);
    await f.loop.reconcile('card_test_1');
    expect(spentInWindowMinor(f.ledger, 'USD', monthWindow(new Date(instant)))).toBe(2100);
    expect(f.ledger.read().filter(({ event }) => event.kind === 'authorization')).toHaveLength(4);
    f.fake.transactions[2]!.status = 'FAILED'; await f.loop.reconcile('card_test_1');
    expect(spentInWindowMinor(f.ledger, 'USD', monthWindow(new Date(instant)))).toBe(1700);
    expect(spentInWindowMinor(f.ledger, 'USD', { from: '2026-12-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' })).toBe(0);
  });
  it('fails closed on unparsed, unknown-status, and unbounded transaction pages', async () => {
    const f = await fixture(); await f.grant();
    const listing = vi.spyOn(f.client, 'listTransactions');
    listing.mockResolvedValueOnce({ items: [], unparsed: [{ unfamiliar: true }], has_more: false });
    await expect(f.loop.reconcile('card_test_1')).rejects.toThrow('reconciliation_unparsed_transactions');
    listing.mockResolvedValueOnce({ items: [{ transaction_id: 'transaction_test_unknown', transaction_amount: '1.00', transaction_currency: 'USD', status: 'UNKNOWN', extra: {} }], unparsed: [] });
    await expect(f.loop.reconcile('card_test_1')).rejects.toThrow('transaction_status_unknown');
    listing.mockResolvedValue({ items: [], unparsed: [], has_more: true });
    await expect(f.loop.reconcile('card_test_1')).rejects.toThrow('transaction_pagination_limit');
    expect(f.ledger.read().some(({ event }) => event.kind === 'reconciliation')).toBe(false);
  });
});

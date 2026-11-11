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
import { demoContext } from '../demo/run.js';
import { createConsoleServer } from './http.js';
import { recordDecision } from './decision-fixture.test-support.js';
import { ApprovalService, digest } from './service.js';
import { seedDesignCoRequest } from './seed.js';
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
  const printed: string[] = []; const operatorLines: string[] = [];
  const service = new ApprovalService({ client, ledger, store, now, cardholderId: 'cardholder_test_01', printNonce: line => printed.push(line),
    printOperatorToken: line => operatorLines.push(line) });
  const operatorToken = operatorLines[0]!.split(': ')[1]!;
  const request = approvalRequest(); if (options.noMcc) delete request.merchantCategoryCode;
  recordDecision(ledger, request);
  const submitted = await service.submit(request);
  const nonce = printed[0]!.split(': ')[1]!;
  const fields = { nonce, csrf: service.get(submitted.id).csrf, presentedTermsHash: termsHash(request),
    ...(options.noMcc ? { merchantCategoryCode: '7372' } : {}) };
  return { service, client, ledger, store, fake, request, nonce, fields, printed, operatorToken, operatorLines, loop: new TransactionLoop(service),
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
      const requestHeaders = { ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }), ...headers };
      if (headers['Content-Type'] === '') delete requestHeaders['Content-Type'];
      const req = httpRequest({ hostname: '127.0.0.1', port: address.port, path, method: data === undefined ? 'GET' : 'POST',
        headers: requestHeaders,
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
      'offers_snapshot', 'comparison', 'decision', 'approval_requested', 'approval_granted', 'card_issue_unconfirmed', 'raw_response', 'controls_readback', 'card_issued',
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
    expect(f.ledger.read().filter(({ event }) => event.kind === 'card_issue_unconfirmed')).toHaveLength(1);
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
  it('caps lifetimes at one hour, allows canonical retries, and bounds open requests at 20', async () => {
    const f = await fixture(); const send = await start(f.service);
    const reordered = Object.fromEntries(Object.entries(f.request).reverse());
    expect((await send('/approvals', reordered)).status).toBe(201);
    // Fields outside the binding terms hash must still participate in conflicts.
    expect((await send('/approvals', { ...f.request, product: 'Other test product' })).status).toBe(409);
    expect((await send('/approvals', { ...f.request, approvalRequestId: 'too_long_test', expiresAt: '2026-11-11T11:00:00.001Z' })).status).toBe(400);
    for (let i = 1; i < 20; i++) {
      expect((await send('/approvals', { ...f.request, approvalRequestId: `request_cap_test_${i}`, expiresAt: '2026-11-11T11:00:00.000Z' })).status).toBe(201);
    }
    expect((await send('/approvals', f.request)).status).toBe(201);
    expect((await send('/approvals', { ...f.request, approvalRequestId: 'request_over_cap_test' })).status).toBe(429);
    expect(f.store.list()).toHaveLength(20);
    f.setTime('2026-11-11T10:16:00.000Z');
    expect((await send('/approvals', { ...f.request, approvalRequestId: 'request_after_expiry_test', expiresAt: '2026-11-11T10:30:00.000Z' })).status).toBe(201);
  });
  it('rotates startup operator tokens and pending nonces, expires stale requests, and avoids duplicate DesignCo seeds', async () => {
    const f = await fixture();
    const stale = { ...f.store.get(f.request.approvalRequestId)!, request: approvalRequest({ approvalRequestId: 'stale_test',
      createdAt: '2026-11-11T09:00:00.000Z', expiresAt: instant }) };
    f.store.save(stale);
    const restarted = new ApprovalService(f.service.options);
    expect(f.operatorLines).toHaveLength(2);
    const freshToken = f.operatorLines[1]!.split(': ')[1]!;
    expect(freshToken).not.toBe(f.operatorToken);
    expect(() => restarted.authenticateOperator(f.operatorToken)).toThrow('operator_token_required');
    expect(restarted.authenticateOperator(freshToken)).toEqual({ kind: 'human' });
    expect(restarted.get('stale_test').status).toBe('expired');
    const freshNonce = f.printed[1]!.split(': ')[1]!;
    expect(freshNonce).not.toBe(f.nonce);
    await expect(restarted.grant(f.request.approvalRequestId, f.fields)).rejects.toThrow('nonce_required');
    const count = f.ledger.read().length;
    await seedDesignCoRequest(restarted);
    expect(f.ledger.read()).toHaveLength(count);
    expect(f.store.list().filter(record => record.status === 'requested')).toHaveLength(1);
    await restarted.grant(f.request.approvalRequestId, { ...f.fields, nonce: freshNonce });
    expect(f.fake.createCalls).toBe(1);
  });
  it('rejects oversized bodies and missing Content-Type; every response including redirects is no-store', async () => {
    const f = await fixture(); const send = await start(f.service);
    const responses = [
      await send('/approvals', {}, {}, 'x'.repeat(64 * 1024 + 1)),
      await send('/approvals', {}, { 'Content-Type': '' }),
      await send('/approvals/request_test_01/approve', { ...f.fields, nonce: 'wrong-test-nonce' }),
      await send('/missing'), await send('/'), await send('/audit'), await send('/audit.jsonl'),
      await send('/approvals/request_test_01/approve', f.fields),
    ];
    expect(responses.map(response => response.status)).toEqual([413, 415, 403, 404, 200, 200, 200, 303]);
    for (const response of responses) expect(response.headers['cache-control']).toBe('no-store');
  });
  it.each(['', 'wrong-test-operator-token'])('blocks scraped CSRF on every operator route without a valid operator token (%s)', async operatorToken => {
    const f = await fixture(); await f.grant(); const send = await start(f.service);
    const page = await send('/approvals/request_test_01');
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)![1]!;
    expect(csrf).toBe(f.fields.csrf);
    const count = f.ledger.read().length;
    const simulate = vi.spyOn(f.client, 'simulateAuthorization');
    const freeze = vi.spyOn(f.client, 'freezeCard'); const list = vi.spyOn(f.client, 'listTransactions');
    const lookup = vi.spyOn(f.client, 'findCardByRequestId');
    for (const path of ['/cards/card_test_1/simulate', '/cards/card_test_1/freeze', '/reconcile', '/approvals/request_test_01/recover']) {
      const response = await send(path, { csrf, cardId: 'card_test_1', amount: '1.00', currency: 'USD', mcc: '7372', operatorToken });
      expect(response.status).toBe(403);
      expect(JSON.parse(response.text)).toEqual({ error: 'operator_token_required' });
    }
    for (const spy of [simulate, freeze, list, lookup]) expect(spy).not.toHaveBeenCalled();
    expect(f.ledger.read()).toHaveLength(count);
  });
  it('keeps CSRF as a second layer on all operator routes', async () => {
    const f = await fixture(); await f.grant(); const send = await start(f.service);
    for (const path of ['/cards/card_test_1/simulate', '/cards/card_test_1/freeze', '/reconcile', '/approvals/request_test_01/recover']) {
      const response = await send(path, { cardId: 'card_test_1', operatorToken: f.operatorToken });
      expect(response.status).toBe(403); expect(JSON.parse(response.text)).toEqual({ error: 'csrf_required' });
    }
  });
  it('accepts a pasted form operator token, attributes freeze to the principal, and never echoes or persists the token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spendkey-operator-')); const path = join(dir, 'approvals.json');
    const store = new JsonApprovalStore(path);
    try {
      const f = await fixture({ store }); await f.grant(); const send = await start(f.service);
      expect(f.operatorLines).toEqual([`OPERATOR TOKEN: ${f.operatorToken}`]);
      const page = await send('/approvals/request_test_01');
      expect(page.text).toContain('name="operatorToken" type="password" required');
      expect(page.text).not.toMatch(/name="operatorToken"[^>]*\bvalue=/);
      const form = new URLSearchParams({ csrf: f.fields.csrf, operatorToken: f.operatorToken }).toString();
      const response = await send('/cards/card_test_1/freeze', {}, { 'Content-Type': 'application/x-www-form-urlencoded' }, form);
      expect(response.status).toBe(200);
      expect(f.ledger.read().at(-1)?.event).toMatchObject({ kind: 'card_frozen', by: 'human' });
      const failed = await send('/cards/card_test_1/freeze', { operatorToken: f.operatorToken, csrf: 'wrong-test-csrf' });
      const output = JSON.stringify([page, response, failed, f.ledger.read(), f.store.list(), f.service]) + readFileSync(path, 'utf8');
      for (const secret of [f.operatorToken, digest(f.operatorToken)]) expect(output).not.toContain(secret);
      for (const route of ['/', '/approvals/request_test_01', '/audit', '/audit.jsonl']) {
        const current = await send(route);
        expect(current.text).not.toContain(f.operatorToken); expect(current.text).not.toContain(digest(f.operatorToken));
      }
      expect(f.operatorLines).toHaveLength(1);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['requested', 'approved', 'issuing', 'failed'] as const)('blocks simulation/reconciliation on a %s card but allows a safe freeze', async status => {
    const f = await fixture(); const record = await f.grant(); record.status = status; f.store.save(record);
    const send = await start(f.service); const auth = { csrf: f.fields.csrf, operatorToken: f.operatorToken, cardId: 'card_test_1' };
    const simulate = vi.spyOn(f.client, 'simulateAuthorization'); const list = vi.spyOn(f.client, 'listTransactions');
    expect((await send('/cards/card_test_1/simulate', { ...auth, amount: '1.00', currency: 'USD', mcc: '7372' })).status).toBe(409);
    expect((await send('/reconcile', auth)).status).toBe(409);
    expect(simulate).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
    expect((await send('/cards/card_test_1/freeze', auth)).status).toBe(200);
    expect(f.ledger.read().at(-1)?.event).toMatchObject({ kind: 'card_frozen', by: 'human' });
    expect((await send('/cards/card_test_unknown/freeze', auth)).status).toBe(404);
  });
  it('recovers only attempted issuance by lookup, preserves request identity, and dedupes unconfirmed events', async () => {
    const f = await fixture(); const send = await start(f.service);
    const auth = { csrf: f.fields.csrf, operatorToken: f.operatorToken };
    expect((await send('/approvals/request_test_01/recover', auth)).status).toBe(409);
    expect(f.fake.createCalls).toBe(0);
    const create = f.client.createCard.bind(f.client);
    vi.spyOn(f.client, 'createCard').mockImplementationOnce(async input => { await create(input); throw new Error('test_response_lost'); });
    await expect(f.grant()).rejects.toThrow('card_issue_unconfirmed');
    const requestId = f.service.get(f.request.approvalRequestId).input!.request_id;
    const lookup = vi.spyOn(f.client, 'findCardByRequestId').mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('test_lookup_failed'));
    expect((await send('/approvals/request_test_01/recover', auth)).status).toBe(409);
    expect((await send('/approvals/request_test_01/recover', auth)).status).toBe(409);
    expect((await send('/approvals/request_test_01/recover', auth)).status).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(lookup).toHaveBeenLastCalledWith(requestId, { cardholderId: 'cardholder_test_01' });
    expect(f.client.createCard).toHaveBeenCalledOnce(); expect(f.fake.createCalls).toBe(1);
    expect(f.service.get(f.request.approvalRequestId).status).toBe('issued');
    expect(f.ledger.read().filter(({ event }) => event.kind === 'card_issue_unconfirmed')).toHaveLength(1);
  });
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
  it('processes a legacy receipt without a success marker before deduping it', async () => {
    const f = await fixture(); await f.grant(); const key = 'test-webhook-key'; const send = await start(f.service, key);
    f.ledger.append({ kind: 'webhook_received', eventId: 'event_legacy_test', name: 'issuing.transaction.succeeded', deduped: false }, instant);
    const timestamp = String(Date.parse(instant));
    const raw = JSON.stringify({ id: 'event_legacy_test', name: 'issuing.transaction.succeeded', created_at: instant, data: {
      transaction_id: 'transaction_legacy_test', card_id: 'card_test_1', transaction_amount: '1.00', transaction_currency: 'USD', status: 'SUCCEEDED',
    } });
    const headers = { 'x-timestamp': timestamp, 'x-signature': createHmac('sha256', key).update(timestamp).update(raw).digest('hex') };
    expect((await send('/webhooks/airwallex', {}, headers, raw)).status).toBe(200);
    expect(f.ledger.read().at(-1)?.event).toMatchObject({ processResult: 'success', deduped: false });
    expect(f.ledger.read().filter(({ event }) => event.kind === 'authorization')).toHaveLength(1);
    expect((await send('/webhooks/airwallex', {}, headers, raw)).status).toBe(200);
    expect(f.ledger.read().at(-1)?.event).toMatchObject({ processResult: 'success', deduped: true });
  });
  it('records a ledger-rejected transaction amount as a processing error on every retry', async () => {
    const f = await fixture(); await f.grant(); const key = 'test-webhook-key'; const send = await start(f.service, key);
    const timestamp = String(Date.parse(instant));
    const raw = JSON.stringify({ id: 'event_invalid_amount_test', name: 'issuing.transaction.succeeded', created_at: instant, data: {
      transaction_id: 'transaction_invalid_amount_test', card_id: 'card_test_1', transaction_amount: '0.001', transaction_currency: 'USD', status: 'SUCCEEDED',
    } });
    const headers = { 'x-timestamp': timestamp, 'x-signature': createHmac('sha256', key).update(timestamp).update(raw).digest('hex') };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await send('/webhooks/airwallex', {}, headers, raw);
      expect(response.status).toBe(500); expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(f.ledger.read().filter(({ event }) => event.kind === 'webhook_received').map(({ event }) => event)).toMatchObject([
      { processResult: 'error', deduped: false }, { processResult: 'error', deduped: false },
    ]);
    expect(f.ledger.read().filter(({ event }) => event.kind === 'authorization')).toHaveLength(0);
    expect(verifyChain(f.ledger.read()).ok).toBe(true);
  });
  it('allows a webhook tunnel host only on the exact signature-protected path', async () => {
    const f = await fixture(); const key = 'test-webhook-key'; const send = await start(f.service, key);
    const timestamp = String(Date.parse(instant)); const raw = JSON.stringify({ id: 'event_tunnel_test', name: 'issuing.card.updated', created_at: instant, data: {} });
    const signature = createHmac('sha256', key).update(timestamp).update(raw).digest('hex');
    const headers = { Host: 'synthetic-tunnel.example', 'x-timestamp': timestamp, 'x-signature': signature };
    expect((await send('/webhooks/airwallex', {}, headers, raw)).status).toBe(200);
    expect((await send('/webhooks/airwallex', {}, { ...headers, 'x-signature': 'invalid-test-signature' }, raw)).status).toBe(401);
    for (const route of ['/', '/approvals', '/webhooks/airwallex/other', '/webhooks/airwallex/']) {
      expect((await send(route, {}, headers, raw)).status).toBe(403);
    }
  });
  it.each(['observation', 'receipt'] as const)('records %s failures and processes a provider retry before deduping it', async failure => {
    const f = await fixture(); await f.grant(); const key = 'test-webhook-key'; const send = await start(f.service, key);
    const timestamp = String(Date.parse(instant));
    const raw = JSON.stringify({ id: 'event_retry_test', name: 'issuing.transaction.succeeded', created_at: instant, data: {
      transaction_id: 'transaction_retry_test', card_id: 'card_test_1', transaction_amount: '10.00', transaction_currency: 'USD', status: 'SUCCEEDED',
    } });
    const headers = { 'x-timestamp': timestamp, 'x-signature': createHmac('sha256', key).update(timestamp).update(raw).digest('hex') };
    const append = f.ledger.append.bind(f.ledger); let failed = false;
    vi.spyOn(f.ledger, 'append').mockImplementation((event, at) => {
      if (!failed && (failure === 'observation' ? event.kind === 'authorization' : event.kind === 'webhook_received')) {
        failed = true; throw new Error('test_storage_failure');
      }
      return append(event, at);
    });
    expect((await send('/webhooks/airwallex', {}, headers, raw)).status).toBe(500);
    expect(f.ledger.read().at(-1)?.event).toMatchObject({ kind: 'webhook_received', processResult: 'error', deduped: false });
    expect((await send('/webhooks/airwallex', {}, headers, raw)).status).toBe(200);
    expect((await send('/webhooks/airwallex', {}, headers, raw)).status).toBe(200);
    expect(f.ledger.read().filter(({ event }) => event.kind === 'webhook_received').map(({ event }) => event)).toMatchObject([
      { processResult: 'error', deduped: false }, { processResult: 'success', deduped: false }, { processResult: 'success', deduped: true },
    ]);
    expect(f.ledger.read().filter(({ event }) => event.kind === 'authorization')).toHaveLength(1);
    expect(verifyChain(f.ledger.read()).ok).toBe(true);
  });
  it('reconciles current spend before both demo and CLI agent decisions and fails closed on polling errors', async () => {
    const f = await fixture(); await f.grant();
    await f.loop.simulate('card_test_1', { amount: '10.00', currency: 'USD', mcc: '7372' });
    expect(spentInWindowMinor(f.ledger, 'USD', monthWindow(f.service.now()))).toBe(0);
    expect(await demoContext(f.service).spentInWindowMinor()).toBe(1000);
    await f.loop.simulate('card_test_1', { amount: '5.00', currency: 'USD', mcc: '7372' });
    const start = f.ledger.read().length;
    await seedDesignCoRequest(f.service);
    const events = f.ledger.read().slice(start).map(({ event }) => event.kind);
    expect(events.indexOf('reconciliation')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('reconciliation')).toBeLessThan(events.indexOf('decision'));
    expect(spentInWindowMinor(f.ledger, 'USD', monthWindow(f.service.now()))).toBe(1500);
    const open = f.store.list().find(record => record.status === 'requested')!;
    f.service.reject(open.request.approvalRequestId, open.csrf);
    vi.spyOn(f.client, 'listTransactions').mockRejectedValue(new Error('test_poll_failed'));
    await expect(demoContext(f.service).spentInWindowMinor()).rejects.toThrow('test_poll_failed');
    const before = f.ledger.read().filter(({ event }) => event.kind === 'decision').length;
    await expect(seedDesignCoRequest(f.service)).rejects.toThrow('test_poll_failed');
    expect(f.ledger.read().filter(({ event }) => event.kind === 'decision')).toHaveLength(before);
  });
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
    const operatorHeaders = { 'X-Operator-Token': f.operatorToken };
    const simulate = (amount: string, currency = 'USD', mcc = '7372') => send('/cards/card_test_1/simulate', { amount, currency, mcc, csrf: f.fields.csrf }, operatorHeaders);
    expect(JSON.parse((await simulate('40.00')).text)).toEqual({ mapped: 'approved' });
    expect(JSON.parse((await simulate('25.00')).text)).toEqual({ mapped: 'limit_exceeded' });
    expect(JSON.parse((await simulate('1.00', 'USD', '5812')).text)).toEqual({ mapped: 'merchant_category_not_allowed' });
    expect(JSON.parse((await simulate('1.00', 'EUR')).text)).toEqual({ mapped: 'currency_not_allowed' });
    expect((await send('/cards/card_test_1/freeze', { csrf: 'wrong' }, operatorHeaders)).status).toBe(403);
    expect((await send('/cards/card_test_1/freeze', { csrf: f.fields.csrf }, operatorHeaders)).status).toBe(200);
    expect(JSON.parse((await simulate('1.00')).text)).toEqual({ mapped: 'card_inactive' });
    const reconciliation = await send('/reconcile', { cardId: 'card_test_1', csrf: f.fields.csrf }, operatorHeaders);
    expect(JSON.parse(reconciliation.text)).toMatchObject({ settledMinor: 4000, pendingMinor: 0, failedCount: 4 });
    expect(f.store.get(f.request.approvalRequestId)?.card?.status).toBe('INACTIVE');
    expect((await send('/audit')).text).toContain('INACTIVE');
    expect(f.ledger.read().find(({ event }) => event.kind === 'card_frozen')?.event).toMatchObject({ by: 'human' });
    expect(verifyChain(f.ledger.read()).ok).toBe(true);
  });
  it('sums signed settled and pending amounts, excludes failed, and dedupes polls and pages', async () => {
    const f = await fixture(); await f.grant();
    const row = { card_id: 'card_test_1', transaction_currency: 'USD', transaction_date: instant, extra: {} };
    f.fake.transactions.push(
      { ...row, transaction_id: 'transaction_test_a', transaction_amount: '20.00', signedAmount: '20.00', status: 'SUCCEEDED' },
      { ...row, transaction_id: 'transaction_test_b', transaction_amount: '-3.00', signedAmount: '-3.00', status: 'SUCCEEDED' },
      { ...row, transaction_id: 'transaction_test_c', transaction_amount: '4.00', signedAmount: '4.00', status: 'PENDING' },
      { ...row, transaction_id: 'transaction_test_d', transaction_amount: '99.00', signedAmount: '99.00', status: 'FAILED' },
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
    listing.mockResolvedValueOnce({ items: [{ transaction_id: 'transaction_test_unknown', transaction_amount: '1.00', signedAmount: '1.00', transaction_currency: 'USD', status: 'UNKNOWN', extra: {} }], unparsed: [] });
    await expect(f.loop.reconcile('card_test_1')).rejects.toThrow('transaction_status_unknown');
    listing.mockResolvedValue({ items: [], unparsed: [], has_more: true });
    await expect(f.loop.reconcile('card_test_1')).rejects.toThrow('transaction_pagination_limit');
    expect(f.ledger.read().some(({ event }) => event.kind === 'reconciliation')).toBe(false);
  });
  it.each([
    ['REFUND', '3.00'], ['REVERSAL', 3], ['REFUND', '-3.00'], ['REVERSAL', -3],
  ])('uses signedAmount from parsed %s amounts (%s) in totals and audit events', async (transactionType, amount) => {
    const f = await fixture(); await f.grant();
    const row = { card_id: 'card_test_1', transaction_currency: 'USD', transaction_date: instant, status: 'SUCCEEDED', extra: {} };
    f.fake.transactions.push(
      { ...row, transaction_id: 'transaction_test_purchase', transaction_amount: '20.00', signedAmount: '20.00' },
      { ...row, transaction_id: 'transaction_test_credit', transaction_type: transactionType,
        transaction_amount: amount, signedAmount: '-3.00' },
      { ...row, transaction_id: 'transaction_test_pending_credit', transaction_type: transactionType,
        transaction_amount: '1.00', signedAmount: '-1.00', status: 'PENDING' },
    );
    // The injected fake transport returns provider fields; the real client computes signedAmount.
    const parsed = await f.client.listTransactions({ card_id: 'card_test_1' });
    expect(parsed.items[1]).toMatchObject({ transaction_amount: amount, signedAmount: typeof amount === 'number' ? -3 : '-3.00' });
    expect(await f.loop.reconcile('card_test_1')).toMatchObject({ settledMinor: 1700, pendingMinor: -100 });
    expect(spentInWindowMinor(f.ledger, 'USD', monthWindow(new Date(instant)))).toBe(1600);
    await f.loop.reconcile('card_test_1');
    expect(spentInWindowMinor(f.ledger, 'USD', monthWindow(new Date(instant)))).toBe(1600);
    expect(f.ledger.read().filter(({ event }) => event.kind === 'authorization')).toHaveLength(3);
    expect(f.ledger.read().find(({ event }) => event.kind === 'authorization'
      && event.transactionId === 'transaction_test_credit')?.event).toMatchObject({ amount: typeof amount === 'number' ? '-3' : '-3.00' });
    expect(verifyChain(f.ledger.read()).ok).toBe(true);
  });
});

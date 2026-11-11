import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AirwallexApiError, AirwallexResponseError, AirwallexClient, loadAirwallexConfig } from '@sk/airwallex';
import { InMemoryLedgerStore, verifyChain } from '@sk/ledger';
import { termsHash, type ApprovalRequest } from '@sk/policy';
import { createFakeAirwallex } from '../demo/fake-airwallex.js';
import { describeDemoFailure, runPreflight } from '../demo/preflight.js';
import { cleanupDemoCards, installDemoSignalHandlers } from '../demo/safety.js';
import { recordConsoleRun } from './seed.js';
import { recordDecision } from './decision-fixture.test-support.js';
import { createConsoleServer } from './http.js';
import { ApprovalService, normalizeControls } from './service.js';
import { JsonApprovalStore, MemoryApprovalStore } from './store.js';
import { TransactionLoop } from './transactions.js';

const at = '2026-11-11T10:00:00.000Z';
function fixture(evidence = true) {
  const now = () => new Date(at);
  const fake = createFakeAirwallex({ now });
  const client = new AirwallexClient(loadAirwallexConfig({ AIRWALLEX_CLIENT_ID: 'test-client-id', AIRWALLEX_API_KEY: 'test-api-key' }), { fetch: fake.fetch });
  const ledger = new InMemoryLedgerStore(); const store = new MemoryApprovalStore();
  const sleep = vi.fn(async () => {}); let nonce = ''; let token = '';
  const service = new ApprovalService({ client, ledger, store, now, sleep, cardholderId: 'cardholder_test_01',
    printNonce: line => { nonce = line.split(': ')[1]!; }, printOperatorToken: line => { token = line.split(': ')[1]!; } });
  const request: ApprovalRequest = { approvalRequestId: 'request_test_m4', offerId: 'offer_test_monthly', vendor: 'DesignCo', product: 'Team plan',
    plan: 'monthly', rail: 'card', currency: 'USD', amountMinor: 6000, interval: 'MONTHLY', allowedTransactionCount: 'MULTIPLE',
    merchantCategoryCode: '7372', commitmentMonths: 0, priceStatus: 'price_unverified', createdAt: at, expiresAt: '2026-11-11T10:15:00.000Z' };
  if (evidence) recordDecision(ledger, request);
  const submit = () => service.submit(request);
  const grant = () => service.grant(request.approvalRequestId, { nonce, csrf: service.get(request.approvalRequestId).csrf, presentedTermsHash: termsHash(request) });
  const events = () => ledger.read().map(row => row.event);
  return { fake, client, ledger, store, sleep, service, request, submit, grant, events, loop: new TransactionLoop(service), get token() { return token; } };
}
afterEach(() => vi.restoreAllMocks());

describe('M4 policy decision binding', () => {
  it('refuses the empty-ledger forgery before persisting anything', async () => {
    const f = fixture(false);
    await expect(f.service.submit({ ...f.request, amountMinor: 999900, priceStatus: 'verified' })).rejects.toMatchObject({ code: 'decision_not_found' });
    expect(f.store.list()).toEqual([]); expect(f.fake.createCalls).toBe(0);
  });
  it.each([
    { amountMinor: 999900 }, { merchantCategoryCode: '5812' }, { interval: 'ALL_TIME' as const },
    { priceStatus: 'verified' as const }, { allowedTransactionCount: 'SINGLE' as const },
    { currency: 'EUR' }, { commitmentMonths: 12 }, { plan: 'annual' as const }, { vendor: 'Other synthetic vendor' },
  ])('refuses terms altered after policy: %j', async changes => {
    const f = fixture();
    await expect(f.service.submit({ ...f.request, ...changes })).rejects.toMatchObject({ code: 'terms_not_from_decision' });
    expect(f.store.list()).toEqual([]);
  });
  it.each(['refuse', 'other_offer', 'old', 'future'] as const)('requires a matching ask within request lifetime (%s)', async change => {
    const f = fixture(false); recordDecision(f.ledger, f.request);
    const rows = f.ledger.read().map(row => row.event);
    const ledger = new InMemoryLedgerStore();
    for (const event of rows) {
      const edited = event.kind === 'decision' ? { ...event,
        ...(change === 'refuse' ? { action: 'refuse' as const } : {}),
        ...(change === 'other_offer' ? { chosenOfferId: 'offer_other_test' } : {}) } : event;
      ledger.append(edited, change === 'old' ? '2026-11-11T09:59:59.000Z' : change === 'future' ? '2026-11-11T10:01:00.000Z' : at);
    }
    const service = new ApprovalService({ ...f.service.options, ledger });
    await expect(service.submit(f.request)).rejects.toMatchObject({ code: 'decision_not_found' });
  });
  it('does not pair a decision with a later or legacy comparison', async () => {
    const f = fixture(false);
    f.ledger.append({ kind: 'decision', action: 'ask', chosenOfferId: f.request.offerId, reasons: [], ruleResults: [] }, at);
    await expect(f.submit()).rejects.toMatchObject({ code: 'terms_not_from_decision' });
    recordDecision(f.ledger, f.request);
    await expect(f.submit()).resolves.toEqual({ id: f.request.approvalRequestId });
  });
  it('rejects snapshot priceStatus mismatch independently of the comparison terms', async () => {
    const f = fixture(false);
    const source = new InMemoryLedgerStore(); recordDecision(source, f.request);
    for (const { event } of source.read()) {
      f.ledger.append(event.kind === 'offers_snapshot' ? { ...event, offers: event.offers.map(offer => ({ ...offer, priceStatus: 'verified' as const })) } : event, at);
    }
    await expect(f.submit()).rejects.toMatchObject({ code: 'terms_not_from_decision' });
  });
});

describe('M4 issuance controls, activation, and crash ordering', () => {
  it('normalizes numeric strings, arrays and object order without hiding changed values', () => {
    expect(normalizeControls({ z: ['USD', 'EUR'], limits: [{ amount: '60.00', interval: 'MONTHLY' }, { interval: 'ALL_TIME', amount: 100 }] }))
      .toEqual(normalizeControls({ limits: [{ amount: '100.0', interval: 'ALL_TIME' }, { interval: 'MONTHLY', amount: 60 }], z: ['EUR', 'USD'] }));
    expect(normalizeControls({ amount: '61' })).not.toEqual(normalizeControls({ amount: 60 }));
  });
  it('accepts normalized provider readback and writes it before card_issued', async () => {
    const f = fixture(); await f.submit();
    const get = f.client.getCard.bind(f.client);
    vi.spyOn(f.client, 'getCard').mockImplementation(async id => {
      const card = await get(id); const controls = card.authorization_controls!;
      return { ...card, authorization_controls: { ...controls,
        transaction_limits: { ...controls.transaction_limits, limits: controls.transaction_limits.limits.map(limit => ({ ...limit, amount: String(limit.amount) + '.00' })) } } };
    });
    await f.grant();
    expect(f.events().slice(-2)).toMatchObject([{ kind: 'controls_readback', matches: true }, { kind: 'card_issued' }]);
    expect(f.sleep).not.toHaveBeenCalled();
  });
  it.each(['amount', 'missing', 'mcc'] as const)('auto-freezes and fails when controls differ (%s)', async change => {
    const f = fixture(); await f.submit(); const get = f.client.getCard.bind(f.client);
    vi.spyOn(f.client, 'getCard').mockImplementation(async id => {
      const card = await get(id);
      if (change === 'missing') { delete card.authorization_controls; return card; }
      const controls = card.authorization_controls!;
      if (change === 'amount') controls.transaction_limits.limits[0]!.amount = 999;
      else controls.allowed_merchant_categories = ['5812'];
      return card;
    });
    await expect(f.grant()).rejects.toMatchObject({ code: 'controls_mismatch' });
    expect(f.events()).toContainEqual(expect.objectContaining({ kind: 'controls_readback', matches: false }));
    expect(f.events()).toContainEqual({ kind: 'card_frozen', cardId: 'card_test_1', by: 'system', reason: 'auto-freeze: controls mismatch' });
    expect(f.service.get(f.request.approvalRequestId)).toMatchObject({ status: 'failed', card: { status: 'INACTIVE' } });
    expect(f.events().some(event => event.kind === 'card_issued')).toBe(false);
  });
  it('polls activation using 0.5/1/2/4 second back-off', async () => {
    const f = fixture(); await f.submit(); const get = f.client.getCard.bind(f.client); let calls = 0;
    vi.spyOn(f.client, 'getCard').mockImplementation(async id => ({ ...await get(id), card_status: ++calls < 5 ? 'PENDING' : 'ACTIVE' }));
    await f.grant(); expect(f.sleep.mock.calls).toEqual([[500], [1000], [2000], [4000]]);
    expect(f.fake.createCalls).toBe(1);
  });
  it('bounds activation failure and never issues twice on recovery', async () => {
    const f = fixture(); await f.submit(); const get = vi.spyOn(f.client, 'getCard');
    get.mockResolvedValue({ card_id: 'card_test_1', card_status: 'PENDING' });
    await expect(f.grant()).rejects.toMatchObject({ code: 'card_not_active' });
    expect(get).toHaveBeenCalledTimes(5); expect(f.sleep).toHaveBeenCalledTimes(4);
    get.mockRestore(); await f.service.recover(f.request.approvalRequestId); expect(f.fake.createCalls).toBe(1);
  });
  it('commits card_issued before an issued record can be saved', async () => {
    const f = fixture(); await f.submit(); const save = f.store.save.bind(f.store); let crash = true;
    vi.spyOn(f.store, 'save').mockImplementation(record => {
      if (record.status === 'issued') {
        expect(f.events().filter(event => event.kind === 'card_issued')).toHaveLength(1);
        if (crash) { crash = false; throw new Error('test_crash_before_issued_save'); }
      }
      save(record);
    });
    await expect(f.grant()).rejects.toThrow('card_issue_unconfirmed');
    await f.service.recover(f.request.approvalRequestId);
    expect(f.fake.createCalls).toBe(1); expect(f.events().filter(event => event.kind === 'card_issued')).toHaveLength(1);
  });
});

describe('M4 diagnostic evidence and freeze confirmation', () => {
  it.each(['issuance', 'simulate', 'freeze', 'reconcile'] as const)('preserves redacted API diagnostics for %s', async step => {
    const f = fixture(); await f.submit();
    if (step !== 'issuance') await f.grant();
    const error = new AirwallexApiError(422, 'TEST_PROVIDER_REJECTED', 'synthetic provider failure');
    let action: () => Promise<unknown>; let endpoint: string;
    if (step === 'issuance') {
      vi.spyOn(f.client, 'createCard').mockRejectedValue(error); action = f.grant; endpoint = '/api/v1/issuing/cards/create';
    } else if (step === 'simulate') {
      vi.spyOn(f.client, 'simulateAuthorization').mockRejectedValue(error);
      action = () => f.loop.simulate('card_test_1', { amount: '1.00', currency: 'USD', mcc: '7372' }); endpoint = '/api/v1/simulation/issuing/create';
    } else if (step === 'freeze') {
      vi.spyOn(f.client, 'freezeCard').mockRejectedValue(error); action = () => f.loop.freeze('card_test_1', 'human', 'test operator'); endpoint = '/api/v1/issuing/cards/card_test_1/update';
    } else {
      vi.spyOn(f.client, 'listTransactions').mockRejectedValue(error); action = () => f.loop.reconcile('card_test_1'); endpoint = '/api/v1/issuing/transactions';
    }
    await expect(action()).rejects.toMatchObject({ code: 'airwallex_api_error', provider: { status: 422, code: 'TEST_PROVIDER_REJECTED', message: error.message, step } });
    expect(f.events()).toContainEqual(expect.objectContaining({ kind: 'raw_response', endpoint, status: 422, body: { code: error.code, message: error.message } }));
    expect(verifyChain(f.ledger.read()).ok).toBe(true);
  });
  it('supports transport status 0 and redacts secret-like API messages', async () => {
    const f = fixture(); await f.submit();
    vi.spyOn(f.client, 'createCard').mockRejectedValue(new AirwallexApiError(0, 'NETWORK_ERROR', 'Bearer ' + 'synthetic'.repeat(3)));
    await expect(f.grant()).rejects.toMatchObject({ provider: { status: 0, code: 'NETWORK_ERROR' } });
    expect(JSON.stringify(f.events())).not.toContain('synthetic'.repeat(3));
  });
  it('prints safe status, code, message, and failing step for the sandbox CLI', () => {
    expect(describeDemoFailure(new AirwallexApiError(403, 'TEST_DENIED', 'synthetic denial'), 'issuance')).toBe('issuance: status=403 code=TEST_DENIED message=synthetic denial');
    const f = fixture();
    try { f.service.providerFailure(new AirwallexApiError(409, 'TEST_REJECTED', 'synthetic rejection'), '/test', 'activation'); }
    catch (error) { expect(describeDemoFailure(error, 'sandbox demo')).toBe('activation: status=409 code=TEST_REJECTED message=synthetic rejection'); }
    expect(describeDemoFailure(new Error('untrusted synthetic error'), 'startup')).not.toContain('untrusted synthetic error');
  });
  it('re-reads an unparseable freeze response and reports freeze_not_confirmed for unparseable readback', async () => {
    const f = fixture(); await f.submit(); await f.grant();
    vi.spyOn(f.client, 'freezeCard').mockRejectedValue(new AirwallexResponseError());
    const get = vi.spyOn(f.client, 'getCard').mockRejectedValueOnce(new AirwallexResponseError());
    await expect(f.loop.freeze('card_test_1', 'human', 'test')).rejects.toMatchObject({ code: 'freeze_not_confirmed' });
    get.mockResolvedValue({ card_id: 'card_test_1', card_status: 'INACTIVE' });
    await f.loop.freeze('card_test_1', 'human', 'test');
    expect(f.events().filter(event => event.kind === 'card_frozen')).toHaveLength(1);
  });
  it('re-reads an inconclusive freeze response and only records confirmed INACTIVE', async () => {
    const f = fixture(); await f.submit(); await f.grant();
    vi.spyOn(f.client, 'freezeCard').mockResolvedValue({ card_id: 'card_test_1', card_status: 'ACTIVE' });
    await expect(f.loop.freeze('card_test_1', 'human', 'test')).rejects.toMatchObject({ code: 'freeze_not_confirmed' });
    expect(f.events().some(event => event.kind === 'card_frozen')).toBe(false);
    expect(f.service.get(f.request.approvalRequestId).card?.status).toBe('ACTIVE');
    f.fake.cards.get('card_test_1')!.card_status = 'INACTIVE';
    await f.loop.freeze('card_test_1', 'human', 'test');
    expect(f.events().at(-1)).toMatchObject({ kind: 'card_frozen', by: 'human' });
  });
});

async function withHttp(f: ReturnType<typeof fixture>, task: (send: (path: string, body: unknown, token?: string) => Promise<{ status: number; body: unknown }>) => Promise<void>) {
  const server = createConsoleServer(f.service);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('test_listen_failed');
  try {
    await task((path, body, token) => new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = httpRequest({ hostname: '127.0.0.1', port: address.port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(token ? { 'X-Operator-Token': token } : {}) } }, response => {
        let text = ''; response.on('data', chunk => { text += String(chunk); });
        response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(text) as unknown }));
      });
      req.on('error', reject); req.end(data);
    }));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

describe('M4 operator abandon route', () => {
  async function failed() {
    const f = fixture(); await f.submit(); vi.spyOn(f.client, 'createCard').mockRejectedValue(new Error('test_send_failed'));
    await expect(f.grant()).rejects.toThrow(); return f;
  }
  it('requires independent operator token and CSRF, then looks up before abandoning', async () => {
    const f = await failed(); const lookup = vi.spyOn(f.client, 'findCardByRequestId');
    await withHttp(f, async send => {
      const path = `/approvals/${f.request.approvalRequestId}/abandon`;
      const csrf = f.service.get(f.request.approvalRequestId).csrf;
      expect((await send(path, { csrf })).status).toBe(403);
      expect((await send(path, {}, f.token)).status).toBe(403); expect(lookup).not.toHaveBeenCalled();
      expect(await send(path, { csrf }, f.token)).toEqual({ status: 200, body: { ok: true } });
      expect(lookup).toHaveBeenCalledOnce();
    });
    expect(f.service.get(f.request.approvalRequestId).status).toBe('rejected');
    await expect(f.service.recover(f.request.approvalRequestId)).rejects.toMatchObject({ code: 'approval_rejected' });
    expect(f.events().at(-1)).toMatchObject({ kind: 'approval_rejected', code: 'operator_abandoned' });
  });
  it('refuses abandoning an existing card and preserves its ID for recovery', async () => {
    const f = await failed(); vi.spyOn(f.client, 'findCardByRequestId').mockResolvedValue({ card_id: 'card_test_recovered', card_status: 'ACTIVE' });
    await expect(f.service.abandon(f.request.approvalRequestId)).rejects.toMatchObject({ code: 'card_exists_recover_required' });
    expect(f.service.get(f.request.approvalRequestId)).toMatchObject({ status: 'failed', card: { cardId: 'card_test_recovered' } });
  });
  it('fails closed on lookup error, requested records, and issued cards', async () => {
    const f = await failed(); vi.spyOn(f.client, 'findCardByRequestId').mockRejectedValue(new AirwallexApiError(503, 'TEST_UNAVAILABLE', 'synthetic unavailable'));
    await expect(f.service.abandon(f.request.approvalRequestId)).rejects.toMatchObject({ code: 'airwallex_api_error' });
    expect(f.service.get(f.request.approvalRequestId).status).toBe('failed');
    const fresh = fixture(); await fresh.submit();
    await expect(fresh.service.abandon(fresh.request.approvalRequestId)).rejects.toMatchObject({ code: 'abandon_not_allowed' });
    await fresh.grant(); await expect(fresh.service.abandon(fresh.request.approvalRequestId)).rejects.toMatchObject({ code: 'abandon_not_allowed' });
  });
  it('rejects a forged POST /approvals at the HTTP boundary', async () => {
    const f = fixture(false);
    await withHttp(f, async send => {
      expect(await send('/approvals', { ...f.request, amountMinor: 999900 })).toEqual({ status: 409, body: { error: 'decision_not_found' } });
    });
    expect(f.store.list()).toEqual([]);
  });
  it('surfaces provider status/code over HTTP', async () => {
    const f = fixture(); await f.submit(); await f.grant();
    vi.spyOn(f.client, 'simulateAuthorization').mockRejectedValue(new AirwallexApiError(422, 'TEST_REJECTED', 'synthetic denial'));
    await withHttp(f, async send => {
      const response = await send('/cards/card_test_1/simulate', { csrf: f.service.get(f.request.approvalRequestId).csrf, amount: '1.00', currency: 'USD', mcc: '7372' }, f.token);
      expect(response).toMatchObject({ status: 502, body: { error: 'airwallex_api_error', provider: { status: 422, code: 'TEST_REJECTED', step: 'simulate' } } });
    });
  });
});

describe('M4 demo cleanup, signal handlers, store locks and preflight', () => {
  it('writes the console mode and reserve policy before any recovery or agent events on every start', () => {
    const f = fixture(false);
    recordConsoleRun(f.ledger, new Date(at));
    expect(f.events()[0]).toMatchObject({ kind: 'run_started', mode: 'console_sandbox', policyNotes: [expect.stringContaining('reserve floor 500.00 USD'), expect.any(String)] });
    recordConsoleRun(f.ledger, new Date(at));
    expect(f.events()[1]).toMatchObject({ kind: 'run_started', mode: 'console_sandbox' });
  });
  it('suppresses the operator token in demo mode', () => {
    const f = fixture(); const print = vi.fn();
    new ApprovalService({ ...f.service.options, demoMode: true, printOperatorToken: print });
    expect(print).not.toHaveBeenCalled();
  });
  it.each(['SIGINT', 'SIGTERM'] as const)('freezes active demo cards before a non-zero exit on %s', async signal => {
    const f = fixture(); await f.submit(); await f.grant();
    const host = Object.assign(new EventEmitter(), { exit: vi.fn() }); const close = vi.fn(); const log = vi.fn();
    const uninstall = installDemoSignalHandlers(f.service, log, host, close);
    host.emit(signal);
    expect(host.listenerCount(signal)).toBe(1); // Repeated signals must not restore Node's default immediate exit.
    host.emit(signal);
    await vi.waitFor(() => expect(host.exit).toHaveBeenCalledWith(1));
    expect(f.fake.cards.get('card_test_1')?.card_status).toBe('INACTIVE'); expect(close).toHaveBeenCalledOnce();
    expect(f.events().at(-1)).toMatchObject({ kind: 'card_frozen', by: 'human', reason: 'demo-operator: cleanup' });
    uninstall(); expect(host.listenerCount('SIGINT')).toBe(0); expect(host.listenerCount('SIGTERM')).toBe(0);
  });
  it('waits for in-flight issuance before signal cleanup closes stores and exits', async () => {
    const f = fixture(); await f.submit(); const create = f.client.createCard.bind(f.client);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.client, 'createCard').mockImplementation(async input => { const result = await create(input); await gate; return result; });
    const host = Object.assign(new EventEmitter(), { exit: vi.fn() }); const close = vi.fn();
    const uninstall = installDemoSignalHandlers(f.service, () => {}, host, close);
    const issuing = f.grant();
    await vi.waitFor(() => expect(f.fake.createCalls).toBe(1));
    host.emit('SIGINT'); expect(close).not.toHaveBeenCalled(); expect(host.exit).not.toHaveBeenCalled();
    release(); await issuing;
    await vi.waitFor(() => expect(host.exit).toHaveBeenCalledWith(1));
    expect(f.fake.cards.get('card_test_1')?.card_status).toBe('INACTIVE'); uninstall();
  });
  it('exits non-zero and closes resources even when signal cleanup fails', async () => {
    const f = fixture(); await f.submit(); await f.grant();
    vi.spyOn(f.client, 'freezeCard').mockRejectedValue(new AirwallexApiError(503, 'TEST_UNAVAILABLE', 'synthetic unavailable'));
    const host = Object.assign(new EventEmitter(), { exit: vi.fn() }); const close = vi.fn(); const log = vi.fn();
    const uninstall = installDemoSignalHandlers(f.service, log, host, close);
    host.emit('SIGTERM');
    await vi.waitFor(() => expect(host.exit).toHaveBeenCalledWith(1));
    expect(close).toHaveBeenCalledOnce(); expect(log).toHaveBeenCalledWith(expect.stringContaining('status=503'));
    uninstall();
  });
  it('finds and freezes an uncertain attempted card during cleanup without creating another', async () => {
    const f = fixture(); await f.submit(); const create = f.client.createCard.bind(f.client);
    vi.spyOn(f.client, 'createCard').mockImplementation(async input => { await create(input); throw new Error('test_response_lost'); });
    await expect(f.grant()).rejects.toThrow(); expect(f.service.get(f.request.approvalRequestId).card).toBeUndefined();
    await cleanupDemoCards(f.service, () => {});
    expect(f.fake.createCalls).toBe(1); expect(f.fake.cards.get('card_test_1')?.card_status).toBe('INACTIVE');
    expect(f.service.get(f.request.approvalRequestId).card).toEqual({ cardId: 'card_test_1', status: 'INACTIVE' });
  });
  it('cleans every non-INACTIVE card, skips inactive cards, and reports failures', async () => {
    const f = fixture(); await f.submit(); await f.grant();
    const original = f.store.get(f.request.approvalRequestId)!;
    for (const [id, status] of [['card_test_pending', 'PENDING'], ['card_test_inactive', 'INACTIVE']] as const) {
      f.fake.cards.set(id, { card_id: id, card_status: status });
      f.store.save({ ...original, request: { ...original.request, approvalRequestId: `request_${id}` }, card: { cardId: id, status } });
    }
    const freeze = vi.spyOn(f.client, 'freezeCard'); const log = vi.fn();
    await cleanupDemoCards(f.service, log);
    expect(freeze.mock.calls).toEqual([['card_test_1'], ['card_test_pending']]);
    expect([...f.fake.cards.values()].every(card => card.card_status === 'INACTIVE')).toBe(true);
    f.fake.cards.get('card_test_1')!.card_status = 'ACTIVE'; freeze.mockRejectedValue(new AirwallexApiError(503, 'TEST_UNAVAILABLE', 'synthetic unavailable'));
    await expect(cleanupDemoCards(f.service, log)).rejects.toThrow('demo_cleanup_failed');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Demo card cleanup failed; freeze: status=503 code=TEST_UNAVAILABLE'));
  });
  it('detects live and stale locks using owner PID and age without deleting them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spendkey-m4-lock-')); const path = join(dir, 'approvals.json');
    try {
      const store = new JsonApprovalStore(path);
      expect(JSON.parse(readFileSync(`${path}.lock`, 'utf8'))).toMatchObject({ pid: process.pid, createdAt: expect.any(Number) });
      expect(() => new JsonApprovalStore(path)).toThrow('approval_store_locked: owner process is alive'); store.close();
      writeFileSync(`${path}.lock`, JSON.stringify({ pid: 2147483647, createdAt: Date.now() - 120000 }));
      expect(() => new JsonApprovalStore(path)).toThrow(/approval_store_stale_lock:.*age 120s.*cleanup/);
      expect(readFileSync(`${path}.lock`, 'utf8')).toContain('2147483647');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('runs a read-only pass/fail preflight through injected transport', async () => {
    const f = fixture(); const log = vi.fn();
    const create = vi.spyOn(f.client, 'createCard'); const cardholder = vi.spyOn(f.client, 'getCardholder');
    expect(await runPreflight(f.client, 'cardholder_test_01', log)).toBe(true);
    expect(cardholder).toHaveBeenCalledWith('cardholder_test_01'); expect(create).not.toHaveBeenCalled();
    expect(log.mock.calls.map(call => call[0])).toEqual(['Check | Result | Detail',
      'USD balance | PASS | at least 160.00 USD available', 'Issuing config | PASS | primary currency USD', 'Cardholder | PASS | usable status']);
    vi.spyOn(f.client, 'getBalances').mockResolvedValue([]);
    vi.spyOn(f.client, 'getIssuingConfig').mockResolvedValue({ primary_currency: 'HKD' });
    cardholder.mockResolvedValue({ cardholder_id: 'cardholder_test_01', status: 'PENDING' }); log.mockClear();
    expect(await runPreflight(f.client, 'cardholder_test_01', log)).toBe(false);
    expect(log.mock.calls.filter(call => String(call[0]).includes('| FAIL |'))).toHaveLength(3);
  });
  it('continues preflight checks after provider or schema failure without printing cardholder data', async () => {
    const f = fixture(); const log = vi.fn();
    vi.spyOn(f.client, 'getBalances').mockRejectedValue(new AirwallexApiError(403, 'TEST_DENIED', 'synthetic denial'));
    vi.spyOn(f.client, 'getCardholder').mockResolvedValue({ cardholder_id: 'cardholder_test_01', status: 'ACTIVE', email: 'user@example.com' });
    expect(await runPreflight(f.client, 'cardholder_test_01', log)).toBe(false);
    expect(log.mock.calls.map(call => call[0]).join('\n')).toContain('status=403 code=TEST_DENIED');
    expect(JSON.stringify(log.mock.calls)).not.toContain('user@example.com');
  });
});

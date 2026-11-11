import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  AirwallexApiError, AirwallexClient, AirwallexResponseError, AirwallexSafetyError,
  assertSafeCardPath, cardholderInputSchema, cardRequestIdFromApproval, createCardInputSchema, loadAirwallexConfig,
  mapFailureReason,
} from './index.js';
import type { Amount, CreateCardInput, SimulateAuthorizationInput } from './index.js';

const START = Date.parse('2030-01-01T00:00:00Z');
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
interface Call { method: string; path: string; query: URLSearchParams; init: RequestInit }
type Handler = (call: Call, count: number) => Response | Promise<Response>;
function harness(overrides: Record<string, Handler> = {}, baseUrl?: string, timeoutMs?: number) {
  let now = START;
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const routes: Record<string, string> = {
    'POST /api/v1/authentication/login': 'login',
    'GET /api/v1/balances/current': 'balances',
    'GET /api/v1/issuing/config': 'issuing-config',
    'POST /api/v1/issuing/cardholders/create': 'cardholder-create',
    'GET /api/v1/issuing/cardholders/cardholder_test_01': 'cardholder-get',
    'POST /api/v1/issuing/cards/create': 'card-create',
    'GET /api/v1/issuing/cards/card_test_01': 'card-create',
    'GET /api/v1/issuing/cards/card_test_01/limits': 'limits',
    'POST /api/v1/issuing/cards/card_test_01/update': 'card-update-inactive',
    'GET /api/v1/issuing/transactions': 'transactions',
    'POST /api/v1/simulation/issuing/create': 'simulation-approved',
  };
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const call = { method: init.method ?? 'GET', path: url.pathname, query: url.searchParams, init };
    calls.push(call);
    const key = `${call.method} ${call.path}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (overrides[key]) return overrides[key](call, count);
    const route = routes[key];
    if (!route) throw new Error('Unexpected offline request');
    return json(fixture(route));
  };
  const config = loadAirwallexConfig({
    AIRWALLEX_CLIENT_ID: 'test-client-id', AIRWALLEX_API_KEY: 'test-api-key',
    ...(baseUrl === undefined ? {} : { AIRWALLEX_BASE_URL: baseUrl }),
  });
  const client = new AirwallexClient(config, {
    fetch, now: () => now, ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { client, calls, counts, setNow: (value: number) => { now = value; } };
}
const cardInput: CreateCardInput = createCardInputSchema.parse({
  ...(fixture('card-create') as object), request_id: 'request_test_01',
});
const simulationInput: SimulateAuthorizationInput = {
  card_id: 'card_test_01', transaction_amount: '20.00', transaction_currency: 'USD',
  merchant_category_code: '5734', merchant_info: { name: 'Test Merchant', city: 'Example City' },
};
function body(call: Call | undefined): unknown {
  return JSON.parse(String(call?.init.body));
}
function controlsWithAmount(amount: Amount) {
  return {
    ...cardInput.authorization_controls,
    transaction_limits: {
      currency: 'USD',
      limits: [{ amount, interval: 'PER_TRANSACTION' }, { amount, interval: 'ALL_TIME' }],
    },
  };
}

describe('authentication', () => {
  it('caches login, sends credentials only to login, and refreshes at 60 seconds before expiry', async () => {
    const h = harness();
    await h.client.getBalances();
    h.setNow(START + 28 * 60_000 + 59_999);
    await h.client.getBalances();
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(1);
    h.setNow(START + 29 * 60_000);
    await h.client.getBalances();
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(2);
    const login = h.calls[0];
    expect(login?.init).toEqual({
      method: 'POST', redirect: 'error', signal: expect.any(AbortSignal),
      headers: { 'x-client-id': 'test-client-id', 'x-api-key': 'test-api-key' },
    });
    expect(login?.init).not.toHaveProperty('body');
    expect(h.calls[1]?.init.headers).toEqual({ Authorization: 'Bearer test-token-01' });
  });

  it('shares an in-flight login across concurrent calls', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = harness({ 'POST /api/v1/authentication/login': async () => { await gate; return json(fixture('login')); } });
    const pending = [h.client.getBalances(), h.client.getIssuingConfig(), h.client.getCard('card_test_01')];
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(1);
    release?.();
    await Promise.all(pending);
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(1);
  });

  it('relogs in and retries once on 401', async () => {
    const h = harness({
      'POST /api/v1/authentication/login': (_call, count) => json({ token: `test-token-0${count}`, expires_at: '2030-01-01T00:30:00Z' }),
      'GET /api/v1/balances/current': (_call, count) => count === 1 ? json({ code: 'TOKEN_EXPIRED', message: 'Expired' }, 401) : json(fixture('balances')),
    });
    await h.client.getBalances();
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(2);
    expect(h.calls.at(-1)?.init.headers).toEqual({ Authorization: 'Bearer test-token-02' });
  });

  it('stops after the second 401', async () => {
    const h = harness({ 'GET /api/v1/balances/current': () => json({ code: 'UNAUTHORIZED', message: 'Denied' }, 401) });
    await expect(h.client.getBalances()).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED', message: 'Denied' });
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(2);
    expect(h.counts.get('GET /api/v1/balances/current')).toBe(2);
  });

  it('dedupes refresh and tolerates a delayed 401 from an older token', async () => {
    let releaseOld: (() => void) | undefined;
    let retrySeen: (() => void) | undefined;
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
    const retryGate = new Promise<void>(resolve => { retrySeen = resolve; });
    const h = harness({
      'POST /api/v1/authentication/login': (_call, count) => json({ token: `test-token-0${count}`, expires_at: '2030-01-01T00:30:00Z' }),
      'GET /api/v1/balances/current': async (_call, count) => {
        if (count === 1) { await oldGate; return json({}, 401); }
        if (count === 2) return json({}, 401);
        retrySeen?.();
        return json(fixture('balances'));
      },
    });
    const first = h.client.getBalances();
    const second = h.client.getBalances();
    await retryGate;
    releaseOld?.();
    await Promise.all([first, second]);
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(2);
  });

  it('recovers after a failed login without an infinite retry', async () => {
    const h = harness({ 'POST /api/v1/authentication/login': (_call, count) => count === 1 ? json({ code: 'DENIED', message: 'Login denied' }, 401) : json(fixture('login')) });
    await expect(h.client.getBalances()).rejects.toBeInstanceOf(AirwallexApiError);
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(1);
    await h.client.getBalances();
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(2);
  });
});

describe('issuing methods', () => {
  it('derives a stable request ID from an approval ID within the API length limit', () => {
    const approvalId = 'approval_test_01'.repeat(20);
    const requestId = cardRequestIdFromApproval(approvalId);
    expect(cardRequestIdFromApproval(approvalId)).toBe(requestId);
    expect(requestId).toMatch(/^spk_[a-f0-9]{40}$/);
    expect(requestId.length).toBeLessThanOrEqual(50);
    expect(cardRequestIdFromApproval('approval_test_02')).not.toBe(requestId);
  });

  it('does not match the repository secret scanner pattern', () => {
    // Let bash evaluate the exact pattern assignment (including POSIX quoting).
    const script = readFileSync(new URL('../../../scripts/check-secrets.sh', import.meta.url), 'utf8');
    const assignment = script.split('\n').find(line => line.startsWith('pattern='));
    expect(assignment).toBeDefined();
    const scanned = spawnSync('bash', ['-c', `${assignment}\ngrep -qE -- "$pattern"`], {
      input: JSON.stringify({ request_id: cardRequestIdFromApproval('approval_test_01') }),
      encoding: 'utf8',
    });
    expect(scanned.error).toBeUndefined();
    expect(scanned.status).toBe(1);
  });

  it.each(['50.00', 50, '12.34', 12.34, '0.01', 0.01, 0.29, 1.1, 1e21])('sends numeric amounts for create, update and simulation: %s', async amount => {
    const h = harness();
    const controls = controlsWithAmount(amount);
    const expected = {
      ...controls,
      transaction_limits: {
        currency: 'USD',
        limits: [{ amount: Number(amount), interval: 'PER_TRANSACTION' }, { amount: Number(amount), interval: 'ALL_TIME' }],
      },
    };
    const input = { ...cardInput, authorization_controls: controls };
    await h.client.createCard(input);
    expect(body(h.calls.at(-1))).toEqual({ ...input, authorization_controls: expected });
    await h.client.updateCardControls('card_test_01', controls);
    expect(body(h.calls.at(-1))).toEqual({ authorization_controls: expected });
    await h.client.simulateAuthorization({ ...simulationInput, transaction_amount: amount });
    expect(body(h.calls.at(-1))).toEqual({ ...simulationInput, transaction_amount: Number(amount) });
    expect(controls.transaction_limits.limits[0]?.amount).toBe(amount);
  });

  it.each([
    0, -1, -0.01, NaN, Infinity, -Infinity, 1.001, 0.001,
    '0', '0.00', '-1.00', '1.001', '0.001', '1.000', '', ' 1.00', 'NaN', 'Infinity', '1e2', '9'.repeat(400),
  ])('rejects invalid outgoing amounts before any fetch: %s', amount => {
    const h = harness();
    const controls = controlsWithAmount(amount);
    expect(() => h.client.createCard({ ...cardInput, authorization_controls: controls })).toThrow();
    expect(() => h.client.updateCardControls('card_test_01', controls)).toThrow();
    expect(() => h.client.simulateAuthorization({ ...simulationInput, transaction_amount: amount })).toThrow();
    expect(h.calls).toHaveLength(0);
  });

  it('routes balance, config, cardholder, card, limits and transaction reads', async () => {
    const h = harness();
    expect((await h.client.getBalances())[0]?.available_amount).toBe('1000.00');
    expect((await h.client.getIssuingConfig()).primary_currency).toBe('USD');
    const holderFixture = fixture('cardholder-create') as Record<string, unknown>;
    const holderInput = cardholderInputSchema.parse({
      ...holderFixture, individual: {
        ...(holderFixture['individual'] as object), express_consent_obtained: 'yes', nationality: 'US',
      },
    });
    expect((await h.client.createCardholder(holderInput)).status).toBe('PENDING');
    expect(body(h.calls.at(-1))).toEqual(holderInput);
    expect((await h.client.getCardholder('cardholder_test_01')).status).toBe('READY');
    expect((await h.client.getCard('card_test_01')).card_status).toBe('ACTIVE');
    const limits = await h.client.getCardLimits('card_test_01');
    expect(limits.limits[0]).toEqual({ amount: '50.00', interval: 'PER_TRANSACTION', remaining: 50 });
    const transactions = await h.client.listTransactions({ card_id: 'card_test_01', from: '2030-01-01T00:00:00Z', to: '2030-01-02T00:00:00Z', page: 0 });
    expect(transactions.items).toHaveLength(5);
    expect(transactions.items[0]).toMatchObject({ transaction_id: 'transaction_test_01', transaction_type: 'AUTHORIZATION' });
    expect(Object.fromEntries(h.calls.at(-1)?.query ?? [])).toEqual({ card_id: 'card_test_01', from_created_at: '2030-01-01T00:00:00Z', to_created_at: '2030-01-02T00:00:00Z', page_num: '0' });
    await h.client.listTransactions();
    expect(h.calls.at(-1)?.query.size).toBe(0);
    for (const call of h.calls.filter(call => call.method === 'GET')) expect(call.init.body).toBeUndefined();
    expect(h.calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'POST /api/v1/authentication/login', 'GET /api/v1/balances/current', 'GET /api/v1/issuing/config',
      'POST /api/v1/issuing/cardholders/create', 'GET /api/v1/issuing/cardholders/cardholder_test_01',
      'GET /api/v1/issuing/cards/card_test_01', 'GET /api/v1/issuing/cards/card_test_01/limits',
      'GET /api/v1/issuing/transactions', 'GET /api/v1/issuing/transactions',
    ]);
  });

  it('creates the complete card body and preserves a caller-supplied request ID', async () => {
    const h = harness();
    const card = await h.client.createCard(cardInput);
    expect(card.card?.card_number).toBe('************0000');
    expect(h.calls.at(-1)?.path).toBe('/api/v1/issuing/cards/create');
    expect(h.calls.at(-1)?.method).toBe('POST');
    expect(body(h.calls.at(-1))).toEqual({
      request_id: 'request_test_01', cardholder_id: 'cardholder_test_01', created_by: 'Test User',
      form_factor: 'VIRTUAL', is_personalized: true, program: { purpose: 'COMMERCIAL' }, nick_name: 'test-purchase',
      authorization_controls: {
        allowed_transaction_count: 'MULTIPLE', allowed_currencies: ['USD'], allowed_merchant_categories: ['5734'],
        transaction_limits: { currency: 'USD', limits: [{ amount: 50, interval: 'PER_TRANSACTION' }] },
      },
    });
  });

  it('requires a caller request ID before making any request', () => {
    const h = harness();
    const { request_id: requestId, ...input } = cardInput;
    expect(requestId).toBe('request_test_01');
    // @ts-expect-error A stable caller-supplied request_id is required.
    expect(() => h.client.createCard(input)).toThrow();
    expect(h.calls).toEqual([]);
  });

  it('preserves the caller request ID across a 401 retry and separate calls', async () => {
    const h = harness({ 'POST /api/v1/issuing/cards/create': (_call, count) => count === 1 ? json({}, 401) : json(fixture('card-create')) });
    await h.client.createCard(cardInput);
    await h.client.createCard(cardInput);
    const creates = h.calls.filter(call => call.path === '/api/v1/issuing/cards/create');
    expect(creates).toHaveLength(3);
    for (const create of creates) expect(body(create)).toMatchObject({ request_id: 'request_test_01' });
    expect(body(creates[0])).toEqual(body(creates[1]));
    expect(body(creates[0])).toEqual(body(creates[2]));
  });

  it('freezes, unfreezes, closes explicitly and updates controls via POST update', async () => {
    const h = harness({ 'POST /api/v1/issuing/cards/card_test_01/update': call => {
      const update = body(call) as { card_status?: string };
      return json({ ...(fixture('card-create') as object), card_status: update.card_status ?? 'ACTIVE' });
    } });
    expect((await h.client.freezeCard('card_test_01')).card_status).toBe('INACTIVE');
    expect(body(h.calls.at(-1))).toEqual({ card_status: 'INACTIVE' });
    expect((await h.client.unfreezeCard('card_test_01')).card_status).toBe('ACTIVE');
    expect(body(h.calls.at(-1))).toEqual({ card_status: 'ACTIVE' });
    // @ts-expect-error CLOSED requires explicit consent, also enforced at runtime.
    expect(() => h.client.updateCardStatus('card_test_01', 'CLOSED')).toThrow(AirwallexSafetyError);
    expect((await h.client.updateCardStatus('card_test_01', 'CLOSED', { irreversible: true })).card_status).toBe('CLOSED');
    await h.client.updateCardControls('card_test_01', cardInput.authorization_controls);
    expect(body(h.calls.at(-1))).toEqual({ authorization_controls: cardInput.authorization_controls });
    expect(h.calls.slice(1).every(call => call.method === 'POST' && call.path === '/api/v1/issuing/cards/card_test_01/update')).toBe(true);
  });

  it.each(['approved', 'limit-exceeded', 'merchant-category-not-allowed', 'currency-not-allowed', 'card-inactive'])('simulates authorization: %s', async outcome => {
    const h = harness({ 'POST /api/v1/simulation/issuing/create': () => json(fixture(`simulation-${outcome}`), 201) });
    const result = await h.client.simulateAuthorization(simulationInput);
    expect(result.process_result).toBe(outcome === 'approved' ? 'APPROVED' : 'DECLINED');
    expect(result.failure_reason).toBe(outcome === 'approved' ? null : outcome.toUpperCase().replaceAll('-', '_'));
    expect(h.calls.at(-1)?.method).toBe('POST');
    expect(h.calls.at(-1)?.path).toBe('/api/v1/simulation/issuing/create');
    expect(body(h.calls.at(-1))).toEqual({ ...simulationInput, transaction_amount: 20 });
  });

  it('rejects a non-sandbox origin at configuration', () => {
    expect(() => harness({}, 'https://example.com')).toThrow('AIRWALLEX_BASE_URL must use the sandbox host');
  });

  it.each(['card_test_01/details', 'card_test_01/%64etails', 'details', '../details', 'card_test_01\\details'])('blocks card details paths before login: %s', id => {
    const h = harness();
    expect(() => h.client.getCard(id)).toThrow(AirwallexSafetyError);
    expect(h.calls).toHaveLength(0);
    expect(() => assertSafeCardPath(`/api/v1/issuing/cards/${id}`)).toThrow(AirwallexSafetyError);
  });

  it('rejects path traversal resource IDs', () => {
    const h = harness();
    expect(() => h.client.getCard('../config')).toThrow(AirwallexSafetyError);
    expect(() => h.client.getCardholder('../config')).toThrow(AirwallexSafetyError);
    expect(() => h.client.listTransactions({ page: -1 })).toThrow(AirwallexSafetyError);
    expect(h.calls).toHaveLength(0);
  });
});

describe('errors and validation', () => {
  it('redacts the invalidated token when re-login fails after a 401', async () => {
    const h = harness({
      'POST /api/v1/authentication/login': (_call, count) => count === 1
        ? json(fixture('login'))
        : json({ code: 'DENIED_test-token-01', message: 'Expired test-token-01 test-api-key test-client-id' }, 403),
      'GET /api/v1/balances/current': () => json({}, 401),
    });
    await expect(h.client.getBalances()).rejects.toMatchObject({
      status: 403, code: 'DENIED_[redacted]', message: 'Expired [redacted] [redacted] [redacted]',
    });
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(2);
    expect(h.counts.get('GET /api/v1/balances/current')).toBe(1);
  });

  it('redacts both the invalidated and current token in a retry error', async () => {
    const h = harness({
      'POST /api/v1/authentication/login': (_call, count) => json({ token: `test-token-0${count}`, expires_at: '2030-01-01T00:30:00Z' }),
      'GET /api/v1/balances/current': (_call, count) => count === 1
        ? json({}, 401)
        : json({ code: 'DENIED_test-token-01_test-token-02', message: 'Denied test-token-01 test-token-02' }, 401),
    });
    await expect(h.client.getBalances()).rejects.toMatchObject({
      status: 401, code: 'DENIED_[redacted]_[redacted]', message: 'Denied [redacted] [redacted]',
    });
    expect(h.counts.get('GET /api/v1/balances/current')).toBe(2);
  });

  it('exposes typed API errors without request headers, body or credentials', async () => {
    const h = harness({ 'GET /api/v1/balances/current': () => json({ code: 'BAD_REQUEST', message: 'Invalid test-api-key test-client-id test-token-01', headers: { 'x-api-key': 'test-api-key' } }, 400) });
    try {
      await h.client.getBalances();
      expect.fail('Expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(AirwallexApiError);
      expect(error).toMatchObject({ status: 400, code: 'BAD_REQUEST', message: 'Invalid [redacted] [redacted] [redacted]' });
      expect(JSON.stringify(error)).not.toContain('test-api-key');
      expect(error).not.toHaveProperty('headers');
    }
    expect(h.counts.get('GET /api/v1/balances/current')).toBe(1);
  });

  it('sanitizes transport exceptions', async () => {
    const h = harness({ 'POST /api/v1/authentication/login': () => { throw new Error('test-api-key'); } });
    await expect(h.client.getBalances()).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR', message: 'Airwallex request failed' });
  });

  it('uses a 30s AbortSignal.timeout on every request unless the client overrides it', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const h = harness();
    await h.client.getBalances();
    expect(timeout.mock.calls.map(call => call[0])).toEqual([30_000, 30_000]);
    expect(h.calls.every(call => call.init.signal instanceof AbortSignal)).toBe(true);
    timeout.mockRestore();
    const custom = vi.spyOn(AbortSignal, 'timeout');
    const short = harness({}, undefined, 25);
    await short.client.getIssuingConfig();
    expect(custom.mock.calls.map(call => call[0])).toEqual([25, 25]);
  });

  it('fails a hung createCard as NETWORK_TIMEOUT and recovers by lookup only', async () => {
    const h = harness({
      'POST /api/v1/issuing/cards/create': () => new Promise<Response>(() => {}),
      'GET /api/v1/issuing/cards': () => json({ items: [], has_more: false }),
    }, undefined, 30);
    await expect(h.client.createCard(cardInput)).rejects.toMatchObject({
      status: 0, code: 'NETWORK_TIMEOUT', message: 'Airwallex request timed out',
    });
    const create = h.calls.filter(call => call.path === '/api/v1/issuing/cards/create');
    expect(create).toHaveLength(1);
    expect(create[0]?.init.signal?.aborted).toBe(true);
    await expect(h.client.findCardByRequestId('request_test_01', {
      cardholderId: 'cardholder_test_01', createdAfter: '2030-01-01T00:00:00Z',
    })).resolves.toBeUndefined();
    expect(h.calls.filter(call => call.path === '/api/v1/issuing/cards/create')).toHaveLength(1);
    expect(h.counts.get('GET /api/v1/issuing/cards')).toBe(1);
  });

  it('does not retry a non-timeout createCard transport failure', async () => {
    const h = harness({ 'POST /api/v1/issuing/cards/create': () => { throw new Error('socket hang up'); } });
    await expect(h.client.createCard(cardInput)).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR', message: 'Airwallex request failed' });
    expect(h.counts.get('POST /api/v1/issuing/cards/create')).toBe(1);
  });

  it('rejects a non-positive timeout before any request', () => {
    expect(() => harness({}, undefined, 0)).toThrow(AirwallexSafetyError);
  });

  it('reports zod paths and codes without response values', async () => {
    const pan = '4111111111111111';
    const token = 'tok_test_secret_looking';
    const leaked = (value: unknown) => `${String(value)}\n${JSON.stringify(value)}\n${inspect(value, { depth: null, showHidden: true })}`;
    const balances = harness({
      'GET /api/v1/balances/current': () => json([{
        currency: 'USD', available_amount: token, pending_amount: '0.00', reserved_amount: '0.00',
        total_amount: '10.00', prepayment_amount: '0.00', account_type: 'CURRENT', pan, access_token: token,
      }]),
    });
    const balanceError = await balances.client.getBalances().catch((reason: unknown) => reason);
    expect(balanceError).toBeInstanceOf(AirwallexResponseError);
    expect(balanceError).toMatchObject({
      endpoint: '/api/v1/balances/current',
      issues: [{ path: '0.available_amount', code: 'invalid_string' }],
    });
    expect(leaked(balanceError)).not.toContain(pan);
    expect(leaked(balanceError)).not.toContain(token);
    const config = harness({
      'GET /api/v1/issuing/config': () => json({ primary_currency: { pan, token }, note: token }),
    });
    const configError = await config.client.getIssuingConfig().catch((reason: unknown) => reason);
    expect(configError).toMatchObject({
      endpoint: '/api/v1/issuing/config',
      issues: [{ path: 'primary_currency', code: 'invalid_type' }],
    });
    expect(leaked(configError)).not.toContain(pan);
    expect(leaked(configError)).not.toContain(token);
    const scrubbed = new AirwallexResponseError(`/api/v1/balances/current?note=${token}`, [
      { path: `items.${pan}.token`, code: `invalid ${token}` },
    ]);
    expect(scrubbed.endpoint).toBe('/api/v1/balances/current');
    expect(scrubbed.issues).toEqual([{ path: 'items._.token', code: 'invalid' }]);
    expect(leaked(scrubbed)).not.toContain(pan);
    expect(leaked(scrubbed)).not.toContain(token);
  });

  it('rejects malformed successful responses without exposing their contents', async () => {
    const h = harness({ 'GET /api/v1/balances/current': () => json([{ currency: 'USD', available_amount: 'not-an-amount' }]) });
    await expect(h.client.getBalances()).rejects.toBeInstanceOf(AirwallexResponseError);
  });

  it('rejects invalid login expiry and unmasked card numbers', async () => {
    const h = harness({ 'POST /api/v1/authentication/login': () => json({ token: 'test-token', expires_at: 'invalid-date' }) });
    await expect(h.client.getBalances()).rejects.toBeInstanceOf(AirwallexResponseError);
    const card = harness({ 'GET /api/v1/issuing/cards/card_test_01': () => json({ ...(fixture('card-create') as object), card_number: 'unmasked-test-value' }) });
    await expect(card.client.getCard('card_test_01')).rejects.toBeInstanceOf(AirwallexResponseError);
  });

  it('strips unmodeled response fields, including remote auth secrets', async () => {
    const h = harness({ 'GET /api/v1/issuing/config': () => json({ primary_currency: 'USD', remote_auth_settings: { shared_secret: 'test-secret' } }) });
    expect(await h.client.getIssuingConfig()).toEqual({ primary_currency: 'USD' });
  });

  it.each([
    ['LIMIT_EXCEEDED', 'limit_exceeded'], ['MERCHANT_CATEGORY_NOT_ALLOWED', 'merchant_category_not_allowed'],
    ['CURRENCY_NOT_ALLOWED', 'currency_not_allowed'], ['CARD_INACTIVE', 'card_inactive'],
    ['NEW_REASON', 'other'], ['', 'other'], [null, 'other'], [undefined, 'other'],
  ])('maps failure reason %s', (input, output) => {
    expect(mapFailureReason(input)).toBe(output);
  });
});

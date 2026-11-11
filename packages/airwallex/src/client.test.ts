import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AirwallexApiError, AirwallexClient, AirwallexResponseError, AirwallexSafetyError,
  assertSafeCardPath, cardholderInputSchema, createCardInputSchema, loadAirwallexConfig,
  mapFailureReason,
} from './index.js';
import type { CreateCardInput, SimulateAuthorizationInput } from './index.js';

const START = Date.parse('2030-01-01T00:00:00Z');
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
interface Call { method: string; path: string; query: URLSearchParams; init: RequestInit }
type Handler = (call: Call, count: number) => Response | Promise<Response>;
function harness(overrides: Record<string, Handler> = {}, baseUrl?: string) {
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
  }, { allowNonSandbox: true });
  const client = new AirwallexClient(config, { fetch, now: () => now });
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
    expect(login?.init).toEqual({ method: 'POST', redirect: 'error', headers: { 'x-client-id': 'test-client-id', 'x-api-key': 'test-api-key' } });
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
    expect(card.card_number).toBe('************0000');
    expect(h.calls.at(-1)?.path).toBe('/api/v1/issuing/cards/create');
    expect(h.calls.at(-1)?.method).toBe('POST');
    expect(body(h.calls.at(-1))).toEqual({
      request_id: 'request_test_01', cardholder_id: 'cardholder_test_01', created_by: 'Test User',
      form_factor: 'VIRTUAL', is_personalized: true, program: { purpose: 'COMMERCIAL' }, nick_name: 'test-purchase',
      authorization_controls: {
        allowed_transaction_count: 'MULTIPLE', allowed_currencies: ['USD'], allowed_merchant_categories: ['5734'],
        transaction_limits: { currency: 'USD', limits: [{ amount: '50.00', interval: 'PER_TRANSACTION' }] },
      },
    });
  });

  it('generates a request ID once and preserves it across a 401 retry', async () => {
    const h = harness({ 'POST /api/v1/issuing/cards/create': (_call, count) => count === 1 ? json({}, 401) : json(fixture('card-create')) });
    const input = { ...cardInput };
    delete input.request_id;
    await h.client.createCard(input);
    const creates = h.calls.filter(call => call.path === '/api/v1/issuing/cards/create');
    expect(body(creates[0])).toEqual(body(creates[1]));
    expect(body(creates[0])).toMatchObject({ request_id: expect.stringMatching(/^[a-f0-9-]{36}$/) });
    expect(input.request_id).toBeUndefined();
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
    expect(body(h.calls.at(-1))).toEqual(simulationInput);
  });

  it('blocks simulation outside sandbox even with an explicit config override', () => {
    const h = harness({}, 'https://example.com');
    expect(() => h.client.simulateAuthorization(simulationInput)).toThrow(AirwallexSafetyError);
    expect(h.calls).toHaveLength(0);
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

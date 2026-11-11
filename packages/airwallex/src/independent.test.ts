import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as publicApi from './index.js';
import {
  AIRWALLEX_SANDBOX_URL,
  AirwallexApiError,
  AirwallexClient,
  AirwallexConfigError,
  AirwallexResponseError,
  AirwallexSafetyError,
  assertSafeCardPath,
  isSandboxUrl,
  loadAirwallexConfig,
  mapFailureReason,
  parseWebhookEvent,
  verifyWebhookSignature,
} from './index.js';
import type { AirwallexConfig, CreateCardInput } from './index.js';

const CLIENT_ID = 'independent-client-id';
const API_KEY = 'independent-marker-not-a-real-key-7f3a';
const SANDBOX = 'https://api-demo.airwallex.com';
const START = Date.parse('2030-01-01T00:00:00Z');
const LOGIN_EXPIRY = '2030-01-01T00:30:00Z';

afterEach(() => {
  vi.unstubAllGlobals();
});

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8')) as unknown;
}

function fixture(name: string): unknown {
  return readJson(`../fixtures/independent/${name}.json`);
}

const webhookBody = readFileSync(new URL('../fixtures/independent/webhook-card-closed.json', import.meta.url), 'utf8');

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface RecordedCall {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  init: RequestInit;
}

type RouteHandler = (call: RecordedCall, attempt: number) => Response | Promise<Response>;

interface HarnessOptions {
  baseUrl?: string;
  allowNonSandbox?: boolean;
}

interface Harness {
  client: AirwallexClient;
  config: AirwallexConfig;
  calls: RecordedCall[];
  counts: Map<string, number>;
  setNow: (value: number) => void;
}

function makeHarness(routes: Record<string, RouteHandler> = {}, options: HarnessOptions = {}): Harness {
  let current = START;
  const calls: RecordedCall[] = [];
  const counts = new Map<string, number>();
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const call: RecordedCall = {
      method: init?.method ?? 'GET',
      url: url.href,
      path: url.pathname,
      query: url.searchParams,
      init: init ?? {},
    };
    calls.push(call);
    const key = `${call.method} ${call.path}`;
    const attempt = (counts.get(key) ?? 0) + 1;
    counts.set(key, attempt);
    const handler = routes[key];
    if (handler) return handler(call, attempt);
    if (key === 'POST /api/v1/authentication/login') {
      return json({ token: `independent-token-${String(attempt).padStart(2, '0')}`, expires_at: LOGIN_EXPIRY });
    }
    if (key === 'GET /api/v1/balances/current') return json(fixture('balances'));
    throw new Error(`Unexpected offline request: ${key}`);
  };
  const config = loadAirwallexConfig({
    AIRWALLEX_CLIENT_ID: CLIENT_ID,
    AIRWALLEX_API_KEY: API_KEY,
    ...(options.baseUrl === undefined ? {} : { AIRWALLEX_BASE_URL: options.baseUrl }),
  }, { allowNonSandbox: options.allowNonSandbox ?? true });
  const client = new AirwallexClient(config, { fetch: fetchImpl, now: () => current });
  return { client, config, calls, counts, setNow: (value: number) => { current = value; } };
}

function headerRecord(init: RequestInit): Record<string, string> {
  const headers = init.headers;
  if (headers === undefined) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers;
}

function bodyOf(call: RecordedCall | undefined): unknown {
  const raw = call?.init.body;
  if (typeof raw !== 'string') throw new Error('Expected a JSON request body');
  return JSON.parse(raw) as unknown;
}

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the action to throw');
}

function expectNoMarker(value: unknown, marker: string): void {
  expect(marker.length).toBeGreaterThan(8);
  expect(String(value)).not.toContain(marker);
  expect(value instanceof Error ? value.message : '').not.toContain(marker);
  expect(value instanceof Error ? value.stack ?? '' : '').not.toContain(marker);
  expect(JSON.stringify(value) ?? '').not.toContain(marker);
  expect(inspect(value, { showHidden: true, depth: null })).not.toContain(marker);
}

interface FakeCard {
  card_id: string;
  card_status: string;
  brand: string;
  card_number: string;
  masked_card_number: string;
}

function cardBody(status = 'ACTIVE'): FakeCard {
  return {
    card_id: 'card_test_01',
    card_status: status,
    brand: 'VISA',
    card_number: '************0000',
    masked_card_number: '************0000',
  };
}

const cardInput: CreateCardInput = {
  cardholder_id: 'cardholder_test_01',
  created_by: 'Independent Test',
  form_factor: 'VIRTUAL',
  is_personalized: true,
  program: { purpose: 'COMMERCIAL' },
  nick_name: 'independent-purchase',
  authorization_controls: {
    allowed_transaction_count: 'MULTIPLE',
    allowed_currencies: ['USD'],
    allowed_merchant_categories: ['5734'],
    transaction_limits: { currency: 'USD', limits: [{ amount: '50.00', interval: 'PER_TRANSACTION' }] },
  },
};

const simulationInput = {
  card_id: 'card_test_01',
  transaction_amount: '20.00',
  transaction_currency: 'USD',
  merchant_category_code: '5734',
  merchant_info: { name: 'Example Merchant', city: 'Example City' },
};

type LooseUpdate = (id: string, status: string, options?: { irreversible?: boolean }) => Promise<unknown>;

function looseUpdate(client: AirwallexClient): LooseUpdate {
  return client.updateCardStatus.bind(client) as unknown as LooseUpdate;
}

describe('independent: authentication and 401 recovery', () => {
  it('performs exactly one re-login and one retry, using the replacement token', async () => {
    const h = makeHarness({
      'GET /api/v1/balances/current': (_call, attempt) => attempt === 1
        ? json({ code: 'TOKEN_EXPIRED', message: 'Expired token' }, 401)
        : json(fixture('balances')),
    });
    const balances = await h.client.getBalances();
    expect(balances[0]?.available_amount).toBe('250.00');
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(2);
    expect(h.counts.get('GET /api/v1/balances/current')).toBe(2);
    expect(h.calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'POST /api/v1/authentication/login',
      'GET /api/v1/balances/current',
      'POST /api/v1/authentication/login',
      'GET /api/v1/balances/current',
    ]);
    const attempts = h.calls.filter(call => call.path === '/api/v1/balances/current');
    expect(attempts.map(call => headerRecord(call.init)['Authorization'])).toEqual([
      'Bearer independent-token-01',
      'Bearer independent-token-02',
    ]);
  });

  it('surfaces a second 401 as AirwallexApiError after exactly one retry', async () => {
    const h = makeHarness({
      'GET /api/v1/balances/current': () => json({ code: 'UNAUTHORIZED', message: 'Denied' }, 401),
    });
    const error = await h.client.getBalances().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AirwallexApiError);
    expect(error).toMatchObject({ status: 401, code: 'UNAUTHORIZED', message: 'Denied' });
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(2);
    expect(h.counts.get('GET /api/v1/balances/current')).toBe(2);
    expect(h.calls).toHaveLength(4);
  });

  it.each([403, 500] as const)('does not retry a %i failure', async status => {
    const h = makeHarness({
      'GET /api/v1/balances/current': () => json({ code: 'UPSTREAM_FAILED', message: 'Upstream failure' }, status),
    });
    await expect(h.client.getBalances()).rejects.toMatchObject({ status, code: 'UPSTREAM_FAILED' });
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(1);
    expect(h.counts.get('GET /api/v1/balances/current')).toBe(1);
    expect(h.calls).toHaveLength(2);
  });

  it('shares one re-login between concurrent 401 responses', async () => {
    const h = makeHarness({
      'GET /api/v1/balances/current': (_call, attempt) => attempt <= 2
        ? json({ code: 'TOKEN_EXPIRED', message: 'Expired' }, 401)
        : json(fixture('balances')),
    });
    const results = await Promise.all([h.client.getBalances(), h.client.getBalances()]);
    expect(results[0]).toEqual(results[1]);
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(2);
    expect(h.counts.get('GET /api/v1/balances/current')).toBe(4);
  });

  it('ignores a delayed 401 from a token that a newer session replaced', async () => {
    let release: (() => void) | undefined;
    let firstSent: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sent = new Promise<void>(resolve => { firstSent = resolve; });
    const h = makeHarness({
      'POST /api/v1/authentication/login': (_call, attempt) => json({
        token: `independent-token-0${attempt}`,
        expires_at: attempt === 1 ? LOGIN_EXPIRY : '2030-01-01T01:00:00Z',
      }),
      'GET /api/v1/balances/current': async (_call, attempt) => {
        if (attempt === 1) {
          firstSent?.();
          await gate;
          return json({ code: 'TOKEN_EXPIRED', message: 'Old token' }, 401);
        }
        return json(fixture('balances'));
      },
      'GET /api/v1/issuing/config': () => json({ primary_currency: 'USD' }),
    });
    const delayed = h.client.getBalances();
    await sent;
    h.setNow(START + 31 * 60_000);
    await h.client.getIssuingConfig();
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(2);
    release?.();
    await delayed;
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(2);
    expect(h.counts.get('GET /api/v1/balances/current')).toBe(2);
    const retry = h.calls.filter(call => call.path === '/api/v1/balances/current').at(-1);
    expect(headerRecord(retry?.init ?? {})['Authorization']).toBe('Bearer independent-token-02');
  });

  it('does not cache a failed login and recovers on the next call', async () => {
    const h = makeHarness({
      'POST /api/v1/authentication/login': (_call, attempt) => attempt === 1
        ? json({ code: 'LOGIN_DENIED', message: 'Login denied' }, 401)
        : json({ token: 'independent-token-02', expires_at: LOGIN_EXPIRY }),
      'GET /api/v1/balances/current': () => json(fixture('balances')),
    });
    await expect(h.client.getBalances()).rejects.toMatchObject({ status: 401, code: 'LOGIN_DENIED' });
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(1);
    expect(h.counts.get('GET /api/v1/balances/current')).toBeUndefined();
    expect(await h.client.getBalances()).toHaveLength(1);
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(2);
    expect(h.counts.get('GET /api/v1/balances/current')).toBe(1);
  });

  it('uses only the injected fetch and never the global stub', async () => {
    let globalCalls = 0;
    const globalStub: typeof globalThis.fetch = async () => {
      globalCalls += 1;
      throw new Error('Global fetch must not be used');
    };
    vi.stubGlobal('fetch', globalStub);
    const h = makeHarness();
    await h.client.getBalances();
    expect(globalCalls).toBe(0);
    expect(h.calls).toHaveLength(2);
  });

  it('leaves the offline global fetch stub in place', async () => {
    await expect(globalThis.fetch('https://api-demo.airwallex.com')).rejects.toThrow('Network access is disabled');
  });

  it('keeps credentials out of data requests and URLs while rejecting redirects', async () => {
    const h = makeHarness();
    await h.client.getBalances();
    const login = h.calls[0];
    expect(headerRecord(login?.init ?? {})).toEqual({ 'x-client-id': CLIENT_ID, 'x-api-key': API_KEY });
    const data = h.calls.slice(1);
    expect(data).toHaveLength(1);
    for (const call of data) {
      expect(Object.keys(headerRecord(call.init))).toEqual(['Authorization']);
      expect(call.url).not.toContain(API_KEY);
      expect(call.url).not.toContain(CLIENT_ID);
    }
    for (const call of h.calls) expect(call.init.redirect).toBe('error');
  });

  it('reuses an auto-generated request id on the 401 retry', async () => {
    const h = makeHarness({
      'POST /api/v1/issuing/cards/create': (_call, attempt) => attempt === 1 ? json({}, 401) : json(cardBody()),
    });
    await h.client.createCard(cardInput);
    const bodies = h.calls
      .filter(call => call.path === '/api/v1/issuing/cards/create')
      .map(call => bodyOf(call) as Record<string, unknown>);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.['request_id']).toBe(bodies[0]?.['request_id']);
    expect(String(bodies[0]?.['request_id'])).toMatch(/^[0-9a-f-]{36}$/);
    expect(cardInput).not.toHaveProperty('request_id');
  });
});

describe('independent: token lifetime', () => {
  it('reuses a token until the 60-second refresh boundary', async () => {
    const h = makeHarness();
    await h.client.getBalances();
    h.setNow(START + 29 * 60_000 - 1);
    await h.client.getBalances();
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(1);
    const tokens = h.calls
      .filter(call => call.path === '/api/v1/balances/current')
      .map(call => headerRecord(call.init)['Authorization']);
    expect(tokens).toEqual(['Bearer independent-token-01', 'Bearer independent-token-01']);
  });

  it('refreshes exactly at the 60-second boundary and never reuses the expired token', async () => {
    const h = makeHarness();
    await h.client.getBalances();
    h.setNow(START + 29 * 60_000);
    await h.client.getBalances();
    h.setNow(START + 30 * 60_000);
    await h.client.getBalances();
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(3);
    const tokens = h.calls
      .filter(call => call.path === '/api/v1/balances/current')
      .map(call => headerRecord(call.init)['Authorization']);
    expect(tokens).toEqual([
      'Bearer independent-token-01',
      'Bearer independent-token-02',
      'Bearer independent-token-03',
    ]);
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(tokens[1]).not.toBe(tokens[2]);
  });

  it('logs in again instead of sending a token after its expiry', async () => {
    const h = makeHarness();
    await h.client.getBalances();
    h.setNow(Date.parse('2030-01-01T02:00:00Z'));
    await h.client.getBalances();
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(2);
    const tokens = h.calls
      .filter(call => call.path === '/api/v1/balances/current')
      .map(call => headerRecord(call.init)['Authorization']);
    expect(tokens).toEqual(['Bearer independent-token-01', 'Bearer independent-token-02']);
  });

  it('accepts an RFC 3339 expiry with a numeric offset', async () => {
    const h = makeHarness({
      'POST /api/v1/authentication/login': () => json({
        token: 'independent-token-offset',
        expires_at: '2030-01-01T01:30:00+01:00',
      }),
    });
    await h.client.getBalances();
    h.setNow(START + 29 * 60_000 - 1);
    await h.client.getBalances();
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(1);
    const last = h.calls.filter(call => call.path === '/api/v1/balances/current').at(-1);
    expect(headerRecord(last?.init ?? {})['Authorization']).toBe('Bearer independent-token-offset');
  });

  it('shares one initial login across parallel requests', async () => {
    const h = makeHarness({
      'GET /api/v1/balances/current': () => json(fixture('balances')),
      'GET /api/v1/issuing/config': () => json({ primary_currency: 'USD' }),
      'GET /api/v1/issuing/cards/card_test_01': () => json(cardBody()),
      'GET /api/v1/issuing/transactions': () => json({ items: [] }),
    });
    await Promise.all([
      h.client.getBalances(),
      h.client.getIssuingConfig(),
      h.client.getCard('card_test_01'),
      h.client.listTransactions(),
    ]);
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(1);
  });
});

describe('independent: decline reason mapping', () => {
  const mappingCases: [string, string][] = [
    ['LIMIT_EXCEEDED', 'limit_exceeded'],
    ['MERCHANT_CATEGORY_NOT_ALLOWED', 'merchant_category_not_allowed'],
    ['CURRENCY_NOT_ALLOWED', 'currency_not_allowed'],
    ['CARD_INACTIVE', 'card_inactive'],
    ['RISK_DECLINED', 'other'],
    ['CARD_CLOSED', 'other'],
    ['UNKNOWN', 'other'],
    ['limit_exceeded', 'other'],
    [' LIMIT_EXCEEDED', 'other'],
    ['LIMIT_EXCEEDED ', 'other'],
    ['', 'other'],
  ];

  it.each(mappingCases)('maps %j to %s', (input, expected) => {
    expect(mapFailureReason(input)).toBe(expected);
  });

  it.each([null, undefined] as const)('maps %j to other', input => {
    expect(mapFailureReason(input)).toBe('other');
  });

  it('maps every decline reason in a synthetic transaction list', async () => {
    const h = makeHarness({
      'GET /api/v1/issuing/transactions': () => json(fixture('transactions-declines')),
    });
    const transactions = await h.client.listTransactions({ card_id: 'card_test_01' });
    expect(transactions.items.map(item => mapFailureReason(item.failure_reason))).toEqual([
      'limit_exceeded',
      'merchant_category_not_allowed',
      'currency_not_allowed',
      'card_inactive',
      'other',
    ]);
  });

  it.each([
    ['LIMIT_EXCEEDED', 'limit_exceeded'],
    ['MERCHANT_CATEGORY_NOT_ALLOWED', 'merchant_category_not_allowed'],
    ['CURRENCY_NOT_ALLOWED', 'currency_not_allowed'],
    ['CARD_INACTIVE', 'card_inactive'],
    ['RISK_DECLINED', 'other'],
  ])('maps a simulated %s decline to %s', async (reason, expected) => {
    const h = makeHarness({
      'POST /api/v1/simulation/issuing/create': () => json({
        process_result: 'DECLINED',
        failure_reason: reason,
      }, 201),
    });
    const result = await h.client.simulateAuthorization(simulationInput);
    expect(result.process_result).toBe('DECLINED');
    expect(mapFailureReason(result.failure_reason)).toBe(expected);
  });
});

describe('independent: configuration and secret containment', () => {
  it('names a missing client id without exposing the API key', () => {
    const error = thrownBy(() => loadAirwallexConfig({ AIRWALLEX_API_KEY: API_KEY }));
    expect(error).toBeInstanceOf(AirwallexConfigError);
    expect(error).toMatchObject({
      variable: 'AIRWALLEX_CLIENT_ID',
      message: 'Missing required variable: AIRWALLEX_CLIENT_ID',
    });
    expectNoMarker(error, API_KEY);
  });

  it('names a missing API key without exposing the client id or unrelated values', () => {
    const error = thrownBy(() => loadAirwallexConfig({
      AIRWALLEX_CLIENT_ID: CLIENT_ID,
      AIRWALLEX_API_SECRET: API_KEY,
    }));
    expect(error).toBeInstanceOf(AirwallexConfigError);
    expect(error).toMatchObject({
      variable: 'AIRWALLEX_API_KEY',
      message: 'Missing required variable: AIRWALLEX_API_KEY',
    });
    expectNoMarker(error, CLIENT_ID);
    expectNoMarker(error, API_KEY);
  });

  it('reports the first missing credential when both are absent', () => {
    const error = thrownBy(() => loadAirwallexConfig({
      AIRWALLEX_CLIENT_ID: '   ',
      AIRWALLEX_API_KEY: API_KEY,
    }));
    expect(error).toMatchObject({ variable: 'AIRWALLEX_CLIENT_ID' });
    expectNoMarker(error, API_KEY);
  });

  it.each(['', '   ', '\t\n'])('treats an empty API key (%j) as missing without echoing it', value => {
    const error = thrownBy(() => loadAirwallexConfig({
      AIRWALLEX_CLIENT_ID: CLIENT_ID,
      AIRWALLEX_API_KEY: value,
    }));
    expect(error).toMatchObject({ variable: 'AIRWALLEX_API_KEY' });
    expectNoMarker(error, CLIENT_ID);
  });

  it('writes nothing to the console for any rejected configuration', () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const)
      .map(level => vi.spyOn(console, level).mockImplementation(() => {}));
    const invalidEnvs = [
      { AIRWALLEX_API_KEY: API_KEY },
      { AIRWALLEX_CLIENT_ID: CLIENT_ID },
      { AIRWALLEX_CLIENT_ID: CLIENT_ID, AIRWALLEX_API_KEY: API_KEY, AIRWALLEX_BASE_URL: 'https://api.airwallex.com' },
      { AIRWALLEX_CLIENT_ID: CLIENT_ID, AIRWALLEX_API_KEY: API_KEY, AIRWALLEX_BASE_URL: `https://u:${API_KEY}@api-demo.airwallex.com` },
    ];
    for (const env of invalidEnvs) {
      const error = thrownBy(() => loadAirwallexConfig(env));
      expect(error).toBeInstanceOf(AirwallexConfigError);
      expectNoMarker(error, API_KEY);
    }
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it('keeps credentials out of the console during a failing client request', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const)
      .map(level => vi.spyOn(console, level).mockImplementation(() => {}));
    const h = makeHarness({
      'GET /api/v1/balances/current': () => json({ code: 'BAD', message: `bad ${API_KEY}` }, 400),
    });
    await expect(h.client.getBalances()).rejects.toBeInstanceOf(AirwallexApiError);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it('hides the key from every ordinary serialization of a valid config', () => {
    const config = loadAirwallexConfig({ AIRWALLEX_CLIENT_ID: CLIENT_ID, AIRWALLEX_API_KEY: API_KEY });
    expectNoMarker(config, API_KEY);
    expect(String(config)).not.toContain(API_KEY);
    expect(JSON.stringify(config)).not.toContain(API_KEY);
    expect(JSON.stringify({ config })).not.toContain(API_KEY);
    expect(inspect(config, { showHidden: true, depth: null })).not.toContain(API_KEY);
    expect(Object.getOwnPropertyNames(config)).toEqual(['clientId', 'baseUrl']);
    expect(Object.entries(config)).toEqual([['clientId', CLIENT_ID], ['baseUrl', SANDBOX]]);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('rejects a config object that loadAirwallexConfig did not create', () => {
    const forged: AirwallexConfig = { clientId: CLIENT_ID, baseUrl: SANDBOX };
    const error = thrownBy(() => new AirwallexClient(forged, {
      fetch: async () => { throw new Error('Fetch must not run for a forged config'); },
    }));
    expect(error).toBeInstanceOf(AirwallexConfigError);
    expect(error).toMatchObject({ variable: 'AIRWALLEX_API_KEY' });
    expectNoMarker(error, CLIENT_ID);
  });

  it('rejects the production issuer origin without echoing credentials', () => {
    const error = thrownBy(() => loadAirwallexConfig({
      AIRWALLEX_CLIENT_ID: CLIENT_ID,
      AIRWALLEX_API_KEY: API_KEY,
      AIRWALLEX_BASE_URL: 'https://api.airwallex.com',
    }));
    expect(error).toBeInstanceOf(AirwallexConfigError);
    expect(error).toMatchObject({
      variable: 'AIRWALLEX_BASE_URL',
      message: 'AIRWALLEX_BASE_URL must use the sandbox host',
    });
    expectNoMarker(error, API_KEY);
    expectNoMarker(error, CLIENT_ID);
    expect(String(error)).not.toContain('api.airwallex.com');
  });

  it('does not echo userinfo from a rejected base URL', () => {
    const url = `https://independent-user:${API_KEY}@api-demo.airwallex.com`;
    const error = thrownBy(() => loadAirwallexConfig({
      AIRWALLEX_CLIENT_ID: CLIENT_ID,
      AIRWALLEX_API_KEY: API_KEY,
      AIRWALLEX_BASE_URL: url,
    }));
    expect(error).toBeInstanceOf(AirwallexConfigError);
    expectNoMarker(error, API_KEY);
    expect(String(error)).not.toContain('independent-user');
  });

  it('requires allowNonSandbox to be exactly true', () => {
    const env = {
      AIRWALLEX_CLIENT_ID: CLIENT_ID,
      AIRWALLEX_API_KEY: API_KEY,
      AIRWALLEX_BASE_URL: 'https://example.com',
    };
    const error = thrownBy(() => loadAirwallexConfig(env, { allowNonSandbox: 1 as unknown as boolean }));
    expect(error).toBeInstanceOf(AirwallexConfigError);
    expect(loadAirwallexConfig(env, { allowNonSandbox: true }).baseUrl).toBe('https://example.com');
  });
});

describe('independent: origin and simulation guard', () => {
  it.each([
    'https://api.airwallex.com',
    'https://api.airwallex.com/',
    'https://API.AIRWALLEX.COM',
    'https://api-demo.airwallex.com.evil.example',
    'https://api-demo.airwallex.com@evil.example',
    'https://\u0430pi-demo.airwallex.com',
  ])('refuses non-sandbox origin %s', url => {
    const error = thrownBy(() => loadAirwallexConfig({
      AIRWALLEX_CLIENT_ID: CLIENT_ID,
      AIRWALLEX_API_KEY: API_KEY,
      AIRWALLEX_BASE_URL: url,
    }));
    expect(error).toBeInstanceOf(AirwallexConfigError);
    expect(error).toMatchObject({ variable: 'AIRWALLEX_BASE_URL' });
    expect(String(error)).not.toContain(url);
    expectNoMarker(error, API_KEY);
  });

  it.each([
    ['https://api-demo.airwallex.com', 'https://api-demo.airwallex.com'],
    ['https://api-demo.airwallex.com/', 'https://api-demo.airwallex.com'],
    ['https://API-DEMO.AIRWALLEX.COM', 'https://api-demo.airwallex.com'],
    ['https://api-demo.airwallex.com:443', 'https://api-demo.airwallex.com'],
  ])('accepts the sandbox origin spelling %s', (input, expected) => {
    const config = loadAirwallexConfig({
      AIRWALLEX_CLIENT_ID: CLIENT_ID,
      AIRWALLEX_API_KEY: API_KEY,
      AIRWALLEX_BASE_URL: input,
    });
    expect(config.baseUrl).toBe(expected);
  });

  it('treats only the exact sandbox origin string as sandbox', () => {
    expect(isSandboxUrl(AIRWALLEX_SANDBOX_URL)).toBe(true);
    expect(AIRWALLEX_SANDBOX_URL).toBe(SANDBOX);
    for (const value of [
      'http://api-demo.airwallex.com',
      'https://api-demo.airwallex.com.',
      'https://api-demo.airwallex.com/',
      'https://api-demo.airwallex.com:8443',
      'https://api-demo.airwallex.com.evil.example',
      'https://api.airwallex.com',
      '',
    ]) {
      expect(isSandboxUrl(value)).toBe(false);
    }
  });

  it('refuses simulation on a non-sandbox origin before any network call', () => {
    const h = makeHarness({}, { baseUrl: 'https://api.airwallex.com' });
    const error = thrownBy(() => h.client.simulateAuthorization(simulationInput));
    expect(error).toBeInstanceOf(AirwallexSafetyError);
    expect(h.calls).toHaveLength(0);
  });

  it('checks the origin before validating simulation input', () => {
    const h = makeHarness({}, { baseUrl: 'https://api.airwallex.com' });
    const error = thrownBy(() => h.client.simulateAuthorization({
      card_id: '',
      transaction_amount: 'not-an-amount',
      transaction_currency: 'USD',
      merchant_category_code: '',
    }));
    expect(error).toBeInstanceOf(AirwallexSafetyError);
    expect(h.calls).toHaveLength(0);
  });

  it('uses an explicitly overridden origin for ordinary issuing calls', async () => {
    const h = makeHarness({
      'GET /api/v1/balances/current': () => json(fixture('balances')),
    }, { baseUrl: 'https://example.com' });
    await h.client.getBalances();
    expect(h.calls.every(call => call.url.startsWith('https://example.com/'))).toBe(true);
  });

  it('refuses sandbox URLs that carry credentials, paths, queries or fragments', () => {
    for (const url of [
      'https://independent-user:independent-password@api-demo.airwallex.com',
      'https://api-demo.airwallex.com/extra',
      'https://api-demo.airwallex.com?query=1',
      'https://api-demo.airwallex.com#fragment',
      'http://api-demo.airwallex.com',
    ]) {
      const error = thrownBy(() => loadAirwallexConfig({
        AIRWALLEX_CLIENT_ID: CLIENT_ID,
        AIRWALLEX_API_KEY: API_KEY,
        AIRWALLEX_BASE_URL: url,
      }));
      expect(error).toBeInstanceOf(AirwallexConfigError);
      expect(String(error)).not.toContain(url);
    }
  });
});

const WEBHOOK_NOW = Date.parse('2030-01-01T00:00:00Z');
const WEBHOOK_SECRET = 'test-webhook-signing-material-01';

function signWebhook(timestamp: string, body: string | Uint8Array = webhookBody, secret = WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(timestamp).update(body).digest('hex');
}

function verifyWebhook(overrides: Partial<Parameters<typeof verifyWebhookSignature>[0]> = {}): boolean {
  return verifyWebhookSignature({
    rawBody: webhookBody,
    timestamp: String(WEBHOOK_NOW),
    signature: signWebhook(String(WEBHOOK_NOW)),
    secret: WEBHOOK_SECRET,
    nowMs: WEBHOOK_NOW,
    ...overrides,
  });
}

describe('independent: webhook verification', () => {
  it('accepts a correctly signed raw body', () => {
    expect(verifyWebhook()).toBe(true);
    expect(verifyWebhook({ signature: signWebhook(String(WEBHOOK_NOW)).toUpperCase() })).toBe(true);
  });

  it('rejects a tampered body even with the original signature', () => {
    const signature = signWebhook(String(WEBHOOK_NOW));
    const tampered = webhookBody.replace('CLOSED', 'ACTIVE');
    expect(tampered).not.toBe(webhookBody);
    expect(verifyWebhook({ rawBody: tampered, signature })).toBe(false);
    expect(verifyWebhook({ rawBody: `${webhookBody} `, signature })).toBe(false);
    expect(verifyWebhook({ rawBody: JSON.stringify(JSON.parse(webhookBody)), signature })).toBe(false);
  });

  it('rejects a tampered timestamp signed with the original value', () => {
    const signature = signWebhook(String(WEBHOOK_NOW));
    expect(verifyWebhook({ timestamp: String(WEBHOOK_NOW + 1_000), signature })).toBe(false);
  });

  it('rejects a signature computed with a different secret', () => {
    expect(verifyWebhook({
      signature: signWebhook(String(WEBHOOK_NOW), webhookBody, `${WEBHOOK_SECRET}-wrong`),
    })).toBe(false);
  });

  it.each([
    ['63 hex characters', 'a'.repeat(63)],
    ['65 hex characters', 'a'.repeat(65)],
    ['64 zeroes', '0'.repeat(64)],
    ['non-hex characters', 'z'.repeat(64)],
    ['one non-hex character', `${'a'.repeat(63)}g`],
    ['empty', ''],
    ['base64 text', Buffer.from('independent webhook signature').toString('base64')],
    ['NUL bytes', '\0'.repeat(64)],
  ])('rejects a %s signature without throwing', (_label, signature) => {
    expect(() => verifyWebhook({ signature })).not.toThrow();
    expect(verifyWebhook({ signature })).toBe(false);
  });

  it.each([-300_001, -900_000, 300_001, 900_000])('rejects a freshly signed timestamp %i ms away', offset => {
    const timestamp = String(WEBHOOK_NOW + offset);
    const signature = signWebhook(timestamp);
    expect(() => verifyWebhook({ timestamp, signature })).not.toThrow();
    expect(verifyWebhook({ timestamp, signature })).toBe(false);
  });

  it.each([-300_000, 300_000])('accepts a correctly signed timestamp at the %i ms boundary', offset => {
    const timestamp = String(WEBHOOK_NOW + offset);
    expect(verifyWebhook({ timestamp, signature: signWebhook(timestamp) })).toBe(true);
  });

  it.each([
    'NaN',
    'Infinity',
    '-1',
    '1.5',
    '',
    '2030-01-01',
    '1e12',
    '0x10',
    ' 1700000000000',
    '1700000000000 ',
    '+1700000000000',
    '00000000000000000000',
  ])('returns false for malformed timestamp %j without throwing', timestamp => {
    const signature = signWebhook(timestamp);
    expect(() => verifyWebhook({ timestamp, signature })).not.toThrow();
    expect(verifyWebhook({ timestamp, signature })).toBe(false);
  });

  it('returns false rather than throwing for invalid clock settings', () => {
    const cases: Partial<Parameters<typeof verifyWebhookSignature>[0]>[] = [
      { nowMs: Number.NaN },
      { nowMs: Number.POSITIVE_INFINITY },
      { toleranceMs: -1 },
      { toleranceMs: Number.POSITIVE_INFINITY },
    ];
    for (const overrides of cases) {
      expect(() => verifyWebhook(overrides)).not.toThrow();
      expect(verifyWebhook(overrides)).toBe(false);
    }
  });

  it('accepts raw bytes and detects a single modified byte', () => {
    const bytes = new Uint8Array(Buffer.from(webhookBody, 'utf8'));
    const signature = createHmac('sha256', WEBHOOK_SECRET)
      .update(String(WEBHOOK_NOW))
      .update(bytes)
      .digest('hex');
    expect(verifyWebhook({ rawBody: bytes, signature })).toBe(true);
    const modified = new Uint8Array(bytes);
    modified[0] = (modified[0] ?? 0) ^ 1;
    expect(verifyWebhook({ rawBody: modified, signature })).toBe(false);
  });

  it('binds signatures to UTF-8 bytes rather than normalized text', () => {
    const composed = '{"id":"event_independent_02","name":"issuing.card.closed","data":{"note":"caf\u00e9"},"created_at":"2030-01-01T00:00:00Z"}';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);
    const signature = signWebhook(String(WEBHOOK_NOW), composed);
    expect(verifyWebhook({ rawBody: composed, signature })).toBe(true);
    expect(verifyWebhook({ rawBody: decomposed, signature })).toBe(false);
  });

  it('accepts a second-based timestamp but keeps its spelling in the HMAC', () => {
    const seconds = String(Math.floor(WEBHOOK_NOW / 1000));
    expect(seconds).toHaveLength(10);
    const signature = signWebhook(seconds);
    expect(verifyWebhook({ timestamp: seconds, signature })).toBe(true);
    expect(verifyWebhook({ timestamp: String(WEBHOOK_NOW), signature })).toBe(false);
  });

  it('verifies bytes without parsing JSON', () => {
    const invalid = 'not json';
    const timestamp = String(WEBHOOK_NOW);
    const signature = signWebhook(timestamp, invalid);
    expect(verifyWebhook({ rawBody: invalid, timestamp, signature })).toBe(true);
    expect(() => parseWebhookEvent(invalid)).toThrow();
  });

  it('parses a verified fixture into a typed event', () => {
    expect(verifyWebhook()).toBe(true);
    const event = parseWebhookEvent(webhookBody);
    expect(event.name).toBe('issuing.card.closed');
    expect(event.account_id).toBe('account_test_01');
    expect(event.data['card_id']).toBe('card_test_01');
    expect(event.data['card_status']).toBe('CLOSED');
  });
});

describe('independent: card details containment', () => {
  it.each([
    '/api/v1/issuing/cards/card_test_01/details',
    '/api/v1/issuing/cards/card_test_01/DETAILS',
    '/api/v1/issuing/cards/card_test_01/Details',
    '/api/v1/issuing/cards/card_test_01/details/',
    '/api/v1/issuing/cards/details',
    '/api/v1/issuing/cards/card_test_01/%64etails',
    '/api/v1/issuing/cards/card_test_01/%2Fdetails',
    '/api/v1/issuing/cards/card_test_01%2Fdetails',
    '/api/v1/issuing/cards/card_test_01%5Cdetails',
    '/api/v1/issuing/cards/card_test_01\\details',
    '/api/v1/issuing/cards/card_test_01/%252Fdetails',
    '/api/v1/issuing/cards/card_test_01/..%2Fdetails',
    '/api/v1/issuing/cards/card_test_01/details?page=1',
  ])('blocks details path %s', path => {
    expect(() => assertSafeCardPath(path)).toThrow(AirwallexSafetyError);
  });

  it.each(['%', '%zz', '%E0%A4%A', '/api/v1/issuing/cards/card_test_01/%'])(
    'rejects undecodable path %j',
    path => {
      expect(() => assertSafeCardPath(path)).toThrow(AirwallexSafetyError);
    },
  );

  it.each([
    '/api/v1/issuing/cards/card_test_01',
    '/api/v1/issuing/cards/card_test_01/limits',
    '/api/v1/issuing/cards/card_test_01/update',
    '/api/v1/issuing/cards/create',
    '/api/v1/issuing/cardholders/cardholder_test_01',
    '/api/v1/issuing/transactions',
    '/api/v1/balances/current',
    '/api/v1/issuing/config',
    '/api/v1/simulation/issuing/create',
  ])('allows ordinary path %s', path => {
    expect(() => assertSafeCardPath(path)).not.toThrow();
  });

  const hostileId = 'card_test_01/details';
  const hostileCalls: { name: string; call: (client: AirwallexClient) => unknown }[] = [
    { name: 'getCard', call: client => client.getCard(hostileId) },
    { name: 'getCardLimits', call: client => client.getCardLimits(hostileId) },
    { name: 'updateCardStatus ACTIVE', call: client => client.updateCardStatus(hostileId, 'ACTIVE') },
    {
      name: 'updateCardStatus CLOSED',
      call: client => client.updateCardStatus(hostileId, 'CLOSED', { irreversible: true }),
    },
    { name: 'freezeCard', call: client => client.freezeCard(hostileId) },
    { name: 'unfreezeCard', call: client => client.unfreezeCard(hostileId) },
    {
      name: 'updateCardControls',
      call: client => client.updateCardControls(hostileId, cardInput.authorization_controls),
    },
  ];

  it.each(hostileCalls)('blocks hostile ids through $name before login', ({ call }) => {
    const h = makeHarness();
    expect(() => call(h.client)).toThrow(AirwallexSafetyError);
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    '',
    ' ',
    '..',
    '../config',
    'card test',
    'card/test',
    'card%2Ftest',
    'card.test',
  ])('rejects invalid card id %j', id => {
    const h = makeHarness();
    expect(() => h.client.getCard(id)).toThrow(AirwallexSafetyError);
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    '../cards/card_test_01/details',
    'card_test_01/details',
    '..%2Fdetails',
    '',
    'cardholder test',
  ])('rejects invalid cardholder id %j', id => {
    const h = makeHarness();
    expect(() => h.client.getCardholder(id)).toThrow(AirwallexSafetyError);
    expect(h.calls).toHaveLength(0);
  });

  it('exposes no card-details or PAN/CVV helper in the public API', () => {
    const suspicious = Object.keys(publicApi).filter(name => /card.?detail|pan\b|cvv|sensitive/i.test(name));
    expect(suspicious).toEqual([]);
    const prototype = Object.getOwnPropertyNames(AirwallexClient.prototype);
    expect(prototype.filter(name => /detail|pan\b|cvv|sensitive/i.test(name))).toEqual([]);
    const moduleExports = Object.keys(publicApi).sort();
    expect(moduleExports).toEqual([
      'AIRWALLEX_SANDBOX_URL',
      'AirwallexApiError',
      'AirwallexClient',
      'AirwallexConfigError',
      'AirwallexResponseError',
      'AirwallexSafetyError',
      'ISSUING_EVENT_NAMES',
      'amountSchema',
      'assertSafeCardPath',
      'authorizationControlsSchema',
      'balanceSchema',
      'balancesSchema',
      'cardLimitsSchema',
      'cardSchema',
      'cardStatusSchema',
      'cardholderInputSchema',
      'cardholderSchema',
      'createCardInputSchema',
      'isSandboxUrl',
      'issuingConfigSchema',
      'loadAirwallexConfig',
      'loginSchema',
      'mapFailureReason',
      'merchantInfoSchema',
      'parseWebhookEvent',
      'simulationInputSchema',
      'simulationSchema',
      'transactionLimitSchema',
      'transactionSchema',
      'transactionsSchema',
      'verifyWebhookSignature',
      'webhookEventSchema',
    ]);
    expect(moduleExports).not.toContain('configApiKey');
  });

  it('does not treat a caller-supplied card id as a URL', () => {
    const h = makeHarness();
    for (const id of ['https://evil.example/x', '//evil.example/x', 'evil.example/x', '..']) {
      expect(() => h.client.getCard(id)).toThrow(AirwallexSafetyError);
      expect(() => h.client.getCardLimits(id)).toThrow(AirwallexSafetyError);
    }
    expect(h.calls).toHaveLength(0);
  });

  it('never records a details path during ordinary operation', async () => {
    const h = makeHarness({
      'GET /api/v1/balances/current': () => json(fixture('balances')),
      'GET /api/v1/issuing/config': () => json({ primary_currency: 'USD' }),
      'GET /api/v1/issuing/cards/card_test_01': () => json(cardBody()),
      'GET /api/v1/issuing/cards/card_test_01/limits': () => json({
        currency: 'USD',
        limits: [{ amount: '50.00', interval: 'PER_TRANSACTION', remaining: 50 }],
      }),
      'POST /api/v1/issuing/cards/card_test_01/update': call => {
        const update = bodyOf(call) as { card_status: string };
        return json(cardBody(update.card_status));
      },
      'GET /api/v1/issuing/transactions': () => json({ items: [] }),
    });
    await h.client.getBalances();
    await h.client.getIssuingConfig();
    await h.client.getCard('card_test_01');
    await h.client.getCardLimits('card_test_01');
    await h.client.freezeCard('card_test_01');
    await h.client.listTransactions({ card_id: 'card_test_01' });
    expect(h.calls).not.toHaveLength(0);
    for (const call of h.calls) {
      expect(call.path.toLowerCase()).not.toContain('/details');
      expect(call.url.toLowerCase()).not.toContain('/details');
    }
  });

  it('keeps data identifiers in the query string and out of the path', async () => {
    const h = makeHarness({
      'GET /api/v1/issuing/transactions': () => json({ items: [] }),
    });
    await h.client.listTransactions({
      card_id: 'card_test_01/details&page_num=99',
      from: '2030-01-01T00:00:00Z',
      to: '2030-01-02T00:00:00Z',
      page: 3,
    });
    const call = h.calls.at(-1);
    expect(call?.path).toBe('/api/v1/issuing/transactions');
    expect(call?.query.get('card_id')).toBe('card_test_01/details&page_num=99');
    expect(call?.query.get('from_created_at')).toBe('2030-01-01T00:00:00Z');
    expect(call?.query.get('to_created_at')).toBe('2030-01-02T00:00:00Z');
    expect(call?.query.getAll('page_num')).toEqual(['3']);
    expect(call?.url.toLowerCase()).not.toContain('/details?');
  });
});

describe('independent: irreversible close consent', () => {
  const consentCases: { label: string; options: unknown }[] = [
    { label: 'omitted options', options: undefined },
    { label: 'an empty options object', options: {} },
    { label: 'irreversible false', options: { irreversible: false } },
    { label: 'a truthy non-boolean', options: { irreversible: 1 } },
    { label: 'a string flag', options: { irreversible: 'true' } },
  ];

  it.each(consentCases)('refuses CLOSED with $label', ({ options }) => {
    const h = makeHarness();
    const update = looseUpdate(h.client);
    const error = thrownBy(() => update('card_test_01', 'CLOSED', options as { irreversible?: boolean }));
    expect(error).toBeInstanceOf(AirwallexSafetyError);
    expect(String(error)).toContain('irreversible');
    expect(h.calls).toHaveLength(0);
  });

  it('sends CLOSED only with the explicit irreversible flag', async () => {
    const h = makeHarness({
      'POST /api/v1/issuing/cards/card_test_01/update': call => {
        const update = bodyOf(call) as { card_status: string };
        return json(cardBody(update.card_status));
      },
    });
    const card = await h.client.updateCardStatus('card_test_01', 'CLOSED', { irreversible: true });
    expect(card.card_status).toBe('CLOSED');
    expect(h.calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'POST /api/v1/authentication/login',
      'POST /api/v1/issuing/cards/card_test_01/update',
    ]);
    expect(bodyOf(h.calls.at(-1))).toEqual({ card_status: 'CLOSED' });
  });

  it('keeps ACTIVE and INACTIVE available without consent and never sends CLOSED', async () => {
    const h = makeHarness({
      'POST /api/v1/issuing/cards/card_test_01/update': call => {
        const update = bodyOf(call) as { card_status: string };
        return json(cardBody(update.card_status));
      },
    });
    expect((await h.client.freezeCard('card_test_01')).card_status).toBe('INACTIVE');
    expect((await h.client.unfreezeCard('card_test_01')).card_status).toBe('ACTIVE');
    expect((await h.client.updateCardStatus('card_test_01', 'ACTIVE')).card_status).toBe('ACTIVE');
    const bodies = h.calls.filter(call => call.path.endsWith('/update')).map(call => bodyOf(call));
    expect(bodies).toEqual([
      { card_status: 'INACTIVE' },
      { card_status: 'ACTIVE' },
      { card_status: 'ACTIVE' },
    ]);
    expect(JSON.stringify(bodies)).not.toContain('CLOSED');
  });

  it.each(['closed', 'FROZEN', '', 'ACTIVE '])('refuses invalid card status %j without a request', status => {
    const h = makeHarness();
    const update = looseUpdate(h.client);
    expect(() => update('card_test_01', status)).toThrow();
    expect(h.calls).toHaveLength(0);
  });

  it('cannot smuggle CLOSED through authorization control updates', async () => {
    const h = makeHarness({
      'POST /api/v1/issuing/cards/card_test_01/update': () => json(cardBody()),
    });
    const controls = { ...cardInput.authorization_controls, card_status: 'CLOSED' };
    await h.client.updateCardControls(
      'card_test_01',
      controls as typeof cardInput.authorization_controls,
    );
    const body = bodyOf(h.calls.at(-1)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['authorization_controls']);
    expect(body).not.toHaveProperty('card_status');
    expect(JSON.stringify(body)).not.toContain('CLOSED');
  });

  it('cannot smuggle card_status into card creation', async () => {
    const h = makeHarness({
      'POST /api/v1/issuing/cards/create': () => json(cardBody()),
    });
    await h.client.createCard({ ...cardInput, card_status: 'CLOSED' } as CreateCardInput);
    const body = bodyOf(h.calls.at(-1)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('card_status');
    expect(JSON.stringify(body)).not.toContain('CLOSED');
  });
});

describe('independent: typed API error surface', () => {
  it('surfaces only status, code and a redacted message', async () => {
    const echoed = {
      code: `CODE_${API_KEY}`,
      message: `caller=${CLIENT_ID} key=${API_KEY} token=independent-token-01 headers=Bearer independent-token-01`,
      request_id: 'request_test_01',
      headers: { 'x-api-key': API_KEY, Authorization: 'Bearer independent-token-01' },
      request: {
        url: `${SANDBOX}/api/v1/balances/current`,
        headers: { Authorization: 'Bearer independent-token-01' },
      },
    };
    const h = makeHarness({
      'GET /api/v1/balances/current': () => json(echoed, 400),
    });
    const error = await h.client.getBalances().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AirwallexApiError);
    const apiError = error as AirwallexApiError;
    expect(apiError.status).toBe(400);
    expect(apiError.code).toBe('CODE_[redacted]');
    expect(apiError.message).toBe(
      'caller=[redacted] key=[redacted] token=[redacted] headers=Bearer [redacted]',
    );
    expect(Object.keys(apiError).sort()).toEqual(['code', 'name', 'status']);
    for (const key of ['headers', 'request', 'response', 'body', 'config', 'init', 'cause']) {
      expect(apiError).not.toHaveProperty(key);
    }
    expectNoMarker(apiError, API_KEY);
    expectNoMarker(apiError, CLIENT_ID);
    expect(apiError.stack ?? '').not.toContain('independent-token-01');
    expect(JSON.stringify(apiError)).not.toContain('x-api-key');
  });

  it('redacts credentials echoed by a rejected login', async () => {
    const h = makeHarness({
      'POST /api/v1/authentication/login': () => json({
        code: 'LOGIN_DENIED',
        message: `${CLIENT_ID}:${API_KEY}`,
      }, 401),
    });
    const error = await h.client.getBalances().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AirwallexApiError);
    expect(error).toMatchObject({ status: 401, code: 'LOGIN_DENIED', message: '[redacted]:[redacted]' });
    expect(h.calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'POST /api/v1/authentication/login',
    ]);
    expectNoMarker(error, API_KEY);
    expectNoMarker(error, CLIENT_ID);
  });

  it('redacts the session token when an API error echoes it', async () => {
    const h = makeHarness({
      'GET /api/v1/issuing/config': () => json({
        code: 'TOKEN_REJECTED',
        message: 'token independent-token-01',
      }, 403),
    });
    const error = await h.client.getIssuingConfig().catch((reason: unknown) => reason);
    expect(error).toMatchObject({ status: 403, code: 'TOKEN_REJECTED', message: 'token [redacted]' });
    expect(JSON.stringify(error)).not.toContain('independent-token-01');
  });

  it('does not surface non-JSON error bodies', async () => {
    const h = makeHarness({
      'GET /api/v1/balances/current': () => new Response(
        `<html><body>${API_KEY}</body></html>`,
        { status: 500, headers: { 'content-type': 'text/html' } },
      ),
    });
    const error = await h.client.getBalances().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AirwallexApiError);
    expect(error).toMatchObject({
      status: 500,
      code: 'UNKNOWN',
      message: 'Airwallex API request failed',
    });
    expectNoMarker(error, API_KEY);
  });

  it('normalizes non-string error fields', async () => {
    const h = makeHarness({
      'GET /api/v1/balances/current': () => json({
        code: 42,
        message: { text: 'not a string' },
      }, 422),
    });
    const error = await h.client.getBalances().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AirwallexApiError);
    expect(error).toMatchObject({
      status: 422,
      code: 'UNKNOWN',
      message: 'Airwallex API request failed',
    });
  });

  it('sanitizes transport failures from data calls without retrying', async () => {
    const h = makeHarness({
      'GET /api/v1/balances/current': () => {
        throw new Error(`connect failed with ${API_KEY}`);
      },
    });
    const error = await h.client.getBalances().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AirwallexApiError);
    expect(error).toMatchObject({
      status: 0,
      code: 'NETWORK_ERROR',
      message: 'Airwallex request failed',
    });
    expect(h.counts.get('POST /api/v1/authentication/login')).toBe(1);
    expect(h.counts.get('GET /api/v1/balances/current')).toBe(1);
    expectNoMarker(error, API_KEY);
  });

  it('rejects a malformed success body without echoing its contents', async () => {
    const h = makeHarness({
      'GET /api/v1/balances/current': () => json({
        cards: [{ pan: '1234567890123456', cvv: '737' }],
        note: API_KEY,
      }),
    });
    const error = await h.client.getBalances().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AirwallexResponseError);
    expect(String(error)).toBe('AirwallexResponseError: Invalid Airwallex response');
    expectNoMarker(error, API_KEY);
    expect(String(error)).not.toContain('1234567890123456');
  });
});

describe('independent: response hardening', () => {
  it('strips PAN, CVV and nested sensitive fields from card responses', async () => {
    const h = makeHarness({
      'GET /api/v1/issuing/cards/card_test_01': () => json({
        card_id: 'card_test_01',
        cardholder_id: 'cardholder_test_01',
        card_status: 'ACTIVE',
        brand: 'VISA',
        card_number: '************0000',
        masked_card_number: '************0000',
        cvv: '000',
        pan: '4000000000000000',
        card_details: { card_number: '4000000000000000', cvv: '000' },
        billing_address: { line1: '1 Example Road' },
      }),
    });
    const card = await h.client.getCard('card_test_01');
    const serialized = JSON.stringify(card);
    expect(card.card_number).toBe('************0000');
    expect(card.masked_card_number).toBe('************0000');
    expect(serialized).not.toContain('4000000000000000');
    expect(serialized).not.toContain('cvv');
    expect(serialized).not.toContain('"pan"');
    expect(serialized).not.toContain('card_details');
    expect(serialized).not.toContain('billing_address');
    expect(Object.keys(card).sort()).toEqual([
      'brand',
      'card_id',
      'card_number',
      'card_status',
      'cardholder_id',
      'masked_card_number',
    ]);
  });

  it('rejects an unmasked card number without echoing it', async () => {
    const h = makeHarness({
      'GET /api/v1/issuing/cards/card_test_01': () => json({
        card_id: 'card_test_01',
        card_status: 'ACTIVE',
        card_number: '4000000000000000',
      }),
    });
    const error = await h.client.getCard('card_test_01').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AirwallexResponseError);
    expectNoMarker(error, '4000000000000000');
  });

  it('surfaces an unknown decline reason unchanged and maps it to other', async () => {
    const h = makeHarness({
      'POST /api/v1/simulation/issuing/create': () => json({
        process_result: 'DECLINED',
        failure_reason: 'RISK_DECLINED',
      }, 201),
    });
    const result = await h.client.simulateAuthorization(simulationInput);
    expect(result.failure_reason).toBe('RISK_DECLINED');
    expect(mapFailureReason(result.failure_reason)).toBe('other');
  });
});

describe('independent: known defects', () => {
  // BUG: #redact only knows the current session token, so an API error that echoes the
  // token from before the 401 re-login leaves that superseded bearer token in
  // error.message. The client holds one session slot and overwrites it on re-login,
  // so any token handed to fetch is unredactable once replaced.
  it.fails('redacts a superseded token echoed after an automatic re-login', async () => {
    const h = makeHarness({
      'GET /api/v1/balances/current': (_call, attempt) => attempt === 1
        ? json({ code: 'TOKEN_EXPIRED', message: 'Expired' }, 401)
        : json({ code: 'REJECTED', message: 'old=independent-token-01 new=independent-token-02' }, 400),
    });
    const error = await h.client.getBalances().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AirwallexApiError);
    expect(String((error as Error).message)).not.toContain('independent-token-01');
    expectNoMarker(error, 'independent-token-01');
  });

  // BUG: assertSafeCardPath decodes at most five times, so a card id carrying a
  // sixth-or-deeper percent-encoded "/details" (e.g. "%25252525252Fdetails") passes the
  // guard. Whether that reaches a real details endpoint depends on server-side decoding,
  // but the defense-in-depth promise in client.ts is not kept.
  it.fails('blocks a details path nested beyond five encoding layers', () => {
    let encoded = '/details';
    for (let depth = 0; depth < 6; depth += 1) encoded = encodeURIComponent(encoded);
    expect(() => assertSafeCardPath(`/api/v1/issuing/cards/card_test_01${encoded}`)).toThrow(
      AirwallexSafetyError,
    );
  });

  // BUG: verifyWebhookSignature accepts an empty or whitespace-only secret, so an
  // HMAC computed with a blank key verifies as genuine. A misconfigured deployment
  // silently accepts forged webhooks rather than failing closed.
  it.fails('rejects an empty webhook secret', () => {
    const timestamp = String(WEBHOOK_NOW);
    const signature = createHmac('sha256', '').update(timestamp).update(webhookBody).digest('hex');
    expect(verifyWebhook({ signature, secret: '' })).toBe(false);
  });
});

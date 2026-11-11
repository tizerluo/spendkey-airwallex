import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AirwallexClient, loadAirwallexConfig } from '@sk/airwallex';
import { InMemoryLedgerStore, verifyChain, verifyJsonl } from '@sk/ledger';
import type { CardAuditEvent, LedgerStore } from '@sk/ledger';
import { termsHash } from '@sk/policy';
import type { ApprovalRequest } from '@sk/policy';
import { createFakeAirwallex } from './demo/fake-airwallex.js';
import { runDemo } from './demo/run.js';
import { cleanupDemoCards } from './demo/safety.js';
import { createConsoleServer } from './server/http.js';
import { ApprovalService } from './server/service.js';
import { JsonApprovalStore, MemoryApprovalStore } from './server/store.js';
import type { ApprovalStore } from './server/store.js';
import { TransactionLoop } from './server/transactions.js';

type Fetch = typeof globalThis.fetch;

const INSTANT = '2026-11-11T10:00:00.000Z';
const REQUEST: ApprovalRequest = {
  approvalRequestId: 'independent_request_01',
  offerId: 'independent_offer_monthly',
  vendor: 'Synthetic DesignCo',
  product: 'Synthetic Team plan',
  plan: 'monthly',
  rail: 'card',
  currency: 'USD',
  amountMinor: 6000,
  interval: 'MONTHLY',
  allowedTransactionCount: 'MULTIPLE',
  merchantCategoryCode: '7372',
  commitmentMonths: 0,
  priceStatus: 'price_unverified',
  createdAt: INSTANT,
  expiresAt: '2026-11-11T10:15:00.000Z',
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`test_expected_object_${label}`);
  return value as Record<string, unknown>;
}

function seedDecision(ledger: LedgerStore, request: ApprovalRequest = REQUEST): void {
  ledger.append({
    kind: 'offers_snapshot',
    intent: 'synthetic design tool',
    offers: [{
      offerId: request.offerId, vendor: request.vendor, product: request.product, plan: request.plan, rail: request.rail,
      price: { amount: '60.00', currency: request.currency, unit: 'per_month' },
      priceStatus: request.priceStatus, availability: 'available',
    }],
  }, request.createdAt);
  ledger.append({
    kind: 'comparison',
    candidates: [{
      offerId: request.offerId, rail: request.rail, upfrontMinor: request.amountMinor, perChargeMinor: request.amountMinor,
      horizonLowMinor: request.amountMinor, horizonHighMinor: request.amountMinor, notes: [],
      terms: {
        vendor: request.vendor, product: request.product, plan: request.plan, currency: request.currency,
        amountMinor: request.amountMinor, interval: request.interval,
        allowedTransactionCount: request.allowedTransactionCount,
        ...(request.merchantCategoryCode === undefined ? {} : { merchantCategoryCode: request.merchantCategoryCode }),
        commitmentMonths: request.commitmentMonths, priceStatus: request.priceStatus,
      },
    }],
    excluded: [],
  }, request.createdAt);
  ledger.append({ kind: 'decision', action: 'ask', chosenOfferId: request.offerId, reasons: [], ruleResults: [] }, request.createdAt);
}

function wrapFetch(
  base: Fetch,
  intercept: (url: URL, init: RequestInit | undefined, next: () => Promise<Response>) => Promise<Response>,
): Fetch {
  return (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return intercept(url, init, () => base(input, init));
  };
}

async function mutateJsonResponse(
  response: Response,
  change: (body: unknown) => unknown,
): Promise<Response> {
  const body: unknown = JSON.parse(await response.text());
  return new Response(JSON.stringify(change(body)), {
    status: response.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function providerError(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ code, message, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface HarnessOptions {
  fetch?: Fetch;
  ledger?: LedgerStore;
  store?: ApprovalStore;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  demoMode?: boolean;
}

function makeHarness(options: HarnessOptions = {}) {
  const now = options.now ?? (() => new Date(INSTANT));
  const fake = createFakeAirwallex({ now });
  const client = new AirwallexClient(
    loadAirwallexConfig({ AIRWALLEX_CLIENT_ID: 'test-client-id', AIRWALLEX_API_KEY: 'test-api-key' }),
    { fetch: options.fetch ?? fake.fetch },
  );
  const ledger = options.ledger ?? new InMemoryLedgerStore();
  const store = options.store ?? new MemoryApprovalStore();
  const sleep = options.sleep ?? vi.fn(async () => {});
  let nonce = '';
  let token = '';
  const service = new ApprovalService({
    client, ledger, store, now, sleep,
    cardholderId: 'cardholder_test_01',
    demoMode: options.demoMode ?? false,
    printNonce: line => { nonce = line.slice(line.lastIndexOf(': ') + 2); },
    printOperatorToken: line => { token = line.slice(line.lastIndexOf(': ') + 2); },
  });
  return {
    fake, client, ledger, store, service, sleep,
    get nonce(): string { return nonce; },
    get token(): string { return token; },
  };
}

type Harness = ReturnType<typeof makeHarness>;

async function submit(h: Harness, request: ApprovalRequest = REQUEST): Promise<void> {
  await h.service.submit(request);
}

async function grant(h: Harness, request: ApprovalRequest = REQUEST) {
  const record = h.service.get(request.approvalRequestId);
  return h.service.grant(request.approvalRequestId, {
    nonce: h.nonce,
    csrf: record.csrf,
    presentedTermsHash: termsHash(request),
  });
}

function events(h: Harness): CardAuditEvent[] {
  return h.ledger.read().map(row => row.event);
}

async function withServer(
  service: ApprovalService,
  task: (send: (method: 'GET' | 'POST', path: string, body?: unknown, token?: string) => Promise<{ status: number; body: unknown; text: string }>) => Promise<void>,
): Promise<void> {
  const server = createConsoleServer(service);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test_listen_failed');
  const send = (method: 'GET' | 'POST', path: string, body?: unknown, token?: string) => new Promise<{ status: number; body: unknown; text: string }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({
      hostname: '127.0.0.1',
      port: address.port,
      path,
      method,
      headers: {
        ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
        ...(token === undefined ? {} : { 'X-Operator-Token': token }),
      },
    }, response => {
      let text = '';
      response.on('data', chunk => { text += String(chunk); });
      response.on('end', () => {
        let parsed: unknown;
        try { parsed = text === '' ? undefined : JSON.parse(text) as unknown; } catch { parsed = text; }
        resolve({ status: response.statusCode ?? 0, body: parsed, text });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
  try {
    await task(send);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

afterEach(() => { vi.restoreAllMocks(); });

describe('independent M4 decision binding at the HTTP boundary', () => {
  const changed: { label: string; request: ApprovalRequest; expected: string }[] = [
    { label: 'amount', request: { ...REQUEST, amountMinor: 999_900 }, expected: 'terms_not_from_decision' },
    { label: 'currency', request: { ...REQUEST, currency: 'EUR' }, expected: 'terms_not_from_decision' },
    { label: 'merchant category', request: { ...REQUEST, merchantCategoryCode: '5812' }, expected: 'terms_not_from_decision' },
    { label: 'interval', request: { ...REQUEST, interval: 'ALL_TIME' }, expected: 'terms_not_from_decision' },
    { label: 'offer id', request: { ...REQUEST, offerId: 'independent_offer_other' }, expected: 'decision_not_found' },
    { label: 'price status', request: { ...REQUEST, priceStatus: 'verified' }, expected: 'terms_not_from_decision' },
    { label: 'transaction count', request: { ...REQUEST, allowedTransactionCount: 'SINGLE' }, expected: 'terms_not_from_decision' },
    { label: 'commitment months', request: { ...REQUEST, commitmentMonths: 12 }, expected: 'terms_not_from_decision' },
    { label: 'vendor', request: { ...REQUEST, vendor: 'Synthetic Other Vendor' }, expected: 'terms_not_from_decision' },
  ];

  it.each(changed)('refuses a POST with an altered $label and persists nothing', async ({ request, expected }) => {
    const h = makeHarness();
    seedDecision(h.ledger);
    await withServer(h.service, async send => {
      expect(await send('POST', '/approvals', request)).toMatchObject({ status: 409, body: { error: expected } });
    });
    expect(h.store.list()).toEqual([]);
    expect(h.fake.createCalls).toBe(0);
    expect(events(h).some(event => event.kind === 'approval_requested')).toBe(false);
  });

  it('refuses a request with the decision merchant category removed', async () => {
    const h = makeHarness();
    seedDecision(h.ledger);
    const withoutMcc: ApprovalRequest = { ...REQUEST };
    delete withoutMcc.merchantCategoryCode;
    await withServer(h.service, async send => {
      expect(await send('POST', '/approvals', withoutMcc)).toMatchObject({ status: 409, body: { error: 'terms_not_from_decision' } });
    });
    expect(h.store.list()).toEqual([]);
  });

  it('accepts the genuine request over HTTP and records the approval request', async () => {
    const h = makeHarness();
    seedDecision(h.ledger);
    await withServer(h.service, async send => {
      expect(await send('POST', '/approvals', REQUEST)).toMatchObject({ status: 201, body: { id: REQUEST.approvalRequestId } });
    });
    expect(h.service.get(REQUEST.approvalRequestId)).toMatchObject({ status: 'requested' });
    expect(events(h)).toContainEqual(expect.objectContaining({
      kind: 'approval_requested',
      approvalRequestId: REQUEST.approvalRequestId,
      amountMinor: REQUEST.amountMinor,
      currency: REQUEST.currency,
    }));
    expect(h.fake.createCalls).toBe(0);
  });

  it('refuses a forged decision for a different offer even when the terms otherwise match', async () => {
    const h = makeHarness();
    const other: ApprovalRequest = { ...REQUEST, approvalRequestId: 'independent_request_02', offerId: 'independent_offer_other' };
    seedDecision(h.ledger, other);
    await expect(h.service.submit(REQUEST)).rejects.toMatchObject({ code: 'decision_not_found' });
    expect(h.store.list()).toEqual([]);
  });

  it('accepts the genuine request after refusing a forgery on the same service', async () => {
    const h = makeHarness();
    seedDecision(h.ledger);
    await withServer(h.service, async send => {
      expect(await send('POST', '/approvals', { ...REQUEST, amountMinor: 999_900 })).toMatchObject({
        status: 409,
        body: { error: 'terms_not_from_decision' },
      });
      expect(await send('POST', '/approvals', REQUEST)).toMatchObject({ status: 201, body: { id: REQUEST.approvalRequestId } });
    });
    expect(h.store.list()).toHaveLength(1);
    expect(events(h).filter(event => event.kind === 'approval_requested')).toHaveLength(1);
  });
});

describe('independent M4 controls readback and system freeze', () => {
  it.each(['limit', 'merchant category'] as const)('writes matches:false, freezes by system, and fails the approval for a %s change', async change => {
    const fake = createFakeAirwallex({ now: () => new Date(INSTANT) });
    const fetch = wrapFetch(fake.fetch, async (url, init, next) => {
      const response = await next();
      if (url.pathname === '/api/v1/issuing/cards/card_test_1' && (init?.method ?? 'GET') === 'GET') {
        return mutateJsonResponse(response, body => {
          const card = asRecord(body, 'card');
          const controls = asRecord(card['authorization_controls'], 'controls');
          if (change === 'limit') {
            const limits = asRecord(controls['transaction_limits'], 'transaction_limits');
            const list = limits['limits'];
            if (!Array.isArray(list) || list.length === 0) throw new Error('test_expected_limits');
            asRecord(list[0], 'first_limit')['amount'] = 999;
          } else {
            controls['allowed_merchant_categories'] = ['5812'];
          }
          return card;
        });
      }
      return response;
    });
    const h = makeHarness({ fetch });
    seedDecision(h.ledger);
    await submit(h);
    await expect(grant(h)).rejects.toMatchObject({ code: 'controls_mismatch' });

    const all = events(h);
    expect(all).toContainEqual(expect.objectContaining({ kind: 'controls_readback', matches: false }));
    expect(all).toContainEqual({
      kind: 'card_frozen',
      cardId: 'card_test_1',
      by: 'system',
      reason: 'auto-freeze: controls mismatch',
    });
    expect(all.some(event => event.kind === 'card_issued')).toBe(false);
    expect(h.service.get(REQUEST.approvalRequestId)).toMatchObject({ status: 'failed', card: { cardId: 'card_test_1', status: 'INACTIVE' } });
    expect(fake.cards.get('card_test_1')?.card_status).toBe('INACTIVE');
    expect(verifyChain(h.ledger.read()).ok).toBe(true);
  });

  it('accepts a numeric-string limit amount without a false controls freeze', async () => {
    const fake = createFakeAirwallex({ now: () => new Date(INSTANT) });
    const fetch = wrapFetch(fake.fetch, async (url, init, next) => {
      const response = await next();
      if (url.pathname === '/api/v1/issuing/cards/card_test_1' && (init?.method ?? 'GET') === 'GET') {
        return mutateJsonResponse(response, body => {
          const card = asRecord(body, 'card');
          const controls = asRecord(card['authorization_controls'], 'controls');
          const limits = asRecord(controls['transaction_limits'], 'transaction_limits');
          const list = limits['limits'];
          if (!Array.isArray(list) || list.length === 0) throw new Error('test_expected_limits');
          asRecord(list[0], 'first_limit')['amount'] = '60.00';
          return card;
        });
      }
      return response;
    });
    const h = makeHarness({ fetch });
    seedDecision(h.ledger);
    await submit(h);
    await grant(h);
    expect(events(h)).toContainEqual(expect.objectContaining({ kind: 'controls_readback', matches: true }));
    expect(events(h).some(event => event.kind === 'card_frozen')).toBe(false);
    expect(h.service.get(REQUEST.approvalRequestId).status).toBe('issued');
  });

  it('stores the expected readback terms alongside the mismatching actual terms', async () => {
    const fake = createFakeAirwallex({ now: () => new Date(INSTANT) });
    const fetch = wrapFetch(fake.fetch, async (url, init, next) => {
      const response = await next();
      if (url.pathname === '/api/v1/issuing/cards/card_test_1' && (init?.method ?? 'GET') === 'GET') {
        return mutateJsonResponse(response, body => {
          const card = asRecord(body, 'card');
          const controls = asRecord(card['authorization_controls'], 'controls');
          controls['allowed_merchant_categories'] = ['5812'];
          return card;
        });
      }
      return response;
    });
    const h = makeHarness({ fetch });
    seedDecision(h.ledger);
    await submit(h);
    await expect(grant(h)).rejects.toMatchObject({ code: 'controls_mismatch' });
    const readback = events(h).find(event => event.kind === 'controls_readback');
    expect(readback).toMatchObject({
      expected: { allowed_merchant_categories: ['7372'] },
      actual: { allowed_merchant_categories: ['5812'] },
    });
  });
});

describe('independent M4 provider diagnostics', () => {
  const failures = [
    {
      step: 'issuance',
      endpoint: '/api/v1/issuing/cards/create',
      match: (url: URL, method: string) => method === 'POST' && url.pathname === '/api/v1/issuing/cards/create',
      action: async (h: Harness) => { seedDecision(h.ledger); await submit(h); await grant(h); },
    },
    {
      step: 'simulate',
      endpoint: '/api/v1/simulation/issuing/create',
      match: (url: URL, method: string) => method === 'POST' && url.pathname === '/api/v1/simulation/issuing/create',
      action: async (h: Harness) => {
        seedDecision(h.ledger); await submit(h); await grant(h);
        return new TransactionLoop(h.service).simulate('card_test_1', { amount: '1.00', currency: 'USD', mcc: '7372' });
      },
    },
    {
      step: 'freeze',
      endpoint: '/api/v1/issuing/cards/card_test_1/update',
      match: (url: URL, method: string) => method === 'POST' && url.pathname === '/api/v1/issuing/cards/card_test_1/update',
      action: async (h: Harness) => {
        seedDecision(h.ledger); await submit(h); await grant(h);
        return new TransactionLoop(h.service).freeze('card_test_1', 'human', 'independent operator freeze');
      },
    },
    {
      step: 'reconcile',
      endpoint: '/api/v1/issuing/transactions',
      match: (url: URL, method: string) => method === 'GET' && url.pathname === '/api/v1/issuing/transactions',
      action: async (h: Harness) => {
        seedDecision(h.ledger); await submit(h); await grant(h);
        return new TransactionLoop(h.service).reconcile('card_test_1');
      },
    },
  ];

  it.each(failures)('records only status, code and message for a $step API error', async ({ step, endpoint, match, action }) => {
    const fake = createFakeAirwallex({ now: () => new Date(INSTANT) });
    const fetch = wrapFetch(fake.fetch, async (url, init, next) => {
      if (match(url, (init?.method ?? 'GET').toUpperCase())) {
        return providerError(422, 'TEST_PROVIDER_REJECTED', 'synthetic provider failure', {
          card_number: '****0001',
          api_key: 'test-api-key',
          authorization: 'Bearer synthetic-session',
        });
      }
      return next();
    });
    const h = makeHarness({ fetch });
    await expect(action(h)).rejects.toMatchObject({
      code: 'airwallex_api_error',
      provider: { status: 422, code: 'TEST_PROVIDER_REJECTED', message: 'synthetic provider failure', step },
    });
    const raw = events(h).filter(event => event.kind === 'raw_response' && event.endpoint === endpoint);
    expect(raw).toHaveLength(1);
    const rawEvent = raw[0];
    if (rawEvent === undefined || rawEvent.kind !== 'raw_response') throw new Error('test_expected_raw_response');
    expect(rawEvent).toMatchObject({ status: 422, body: { code: 'TEST_PROVIDER_REJECTED', message: 'synthetic provider failure' } });
    const body = asRecord(rawEvent.body, 'raw_body');
    expect(Object.keys(body).sort()).toEqual(['code', 'message']);
    const serialized = JSON.stringify(rawEvent);
    expect(serialized).not.toContain('card_number');
    expect(serialized).not.toContain('api_key');
    expect(serialized).not.toContain('test-api-key');
    expect(serialized).not.toContain('synthetic-session');
    expect(serialized).not.toMatch(/\d{13,}/);
    expect(verifyChain(h.ledger.read()).ok).toBe(true);
  });

  it('redacts secret-shaped bearer text inside a provider message', async () => {
    const fake = createFakeAirwallex({ now: () => new Date(INSTANT) });
    const token = 'abcdefghijklmnop';
    const fetch = wrapFetch(fake.fetch, async (url, init, next) => {
      if (url.pathname === '/api/v1/issuing/cards/create' && (init?.method ?? 'GET') === 'POST') {
        return providerError(403, 'TEST_DENIED', `synthetic Bearer ${token} denied`);
      }
      return next();
    });
    const h = makeHarness({ fetch });
    seedDecision(h.ledger);
    await submit(h);
    await expect(grant(h)).rejects.toMatchObject({ provider: { status: 403, code: 'TEST_DENIED' } });
    const raw = events(h).find(event => event.kind === 'raw_response');
    expect(JSON.stringify(raw)).not.toContain(token);
    expect(JSON.stringify(raw)).toContain('[REDACTED]');
  });

  it('surfaces issuance provider status and code over HTTP through the approve route', async () => {
    const fake = createFakeAirwallex({ now: () => new Date(INSTANT) });
    const fetch = wrapFetch(fake.fetch, async (url, init, next) => {
      if (url.pathname === '/api/v1/issuing/cards/create' && (init?.method ?? 'GET') === 'POST') {
        return providerError(422, 'TEST_PROVIDER_REJECTED', 'synthetic provider failure');
      }
      return next();
    });
    const h = makeHarness({ fetch });
    seedDecision(h.ledger);
    await submit(h);
    const csrf = h.service.get(REQUEST.approvalRequestId).csrf;
    await withServer(h.service, async send => {
      expect(await send('POST', `/approvals/${REQUEST.approvalRequestId}/approve`, {
        csrf, nonce: h.nonce, presentedTermsHash: termsHash(REQUEST),
      })).toMatchObject({
        status: 502,
        body: { error: 'airwallex_api_error', provider: { status: 422, code: 'TEST_PROVIDER_REJECTED', step: 'issuance' } },
      });
    });
    expect(h.service.get(REQUEST.approvalRequestId)).toMatchObject({ status: 'failed', attempted: true });
    expect(events(h)).toContainEqual(expect.objectContaining({
      kind: 'raw_response', endpoint: '/api/v1/issuing/cards/create', status: 422,
      body: { code: 'TEST_PROVIDER_REJECTED', message: 'synthetic provider failure' },
    }));
  });

  it('preserves transport status 0 in provider diagnostics', async () => {
    const fake = createFakeAirwallex({ now: () => new Date(INSTANT) });
    const fetch = wrapFetch(fake.fetch, async (url, init, next) => {
      if (url.pathname === '/api/v1/issuing/cards/create' && (init?.method ?? 'GET') === 'POST') {
        throw new Error('synthetic transport failure');
      }
      return next();
    });
    const h = makeHarness({ fetch });
    seedDecision(h.ledger);
    await submit(h);
    await expect(grant(h)).rejects.toMatchObject({
      code: 'airwallex_api_error',
      provider: { status: 0, code: 'NETWORK_ERROR', step: 'issuance' },
    });
    const raw = events(h).find(event => event.kind === 'raw_response');
    expect(raw).toMatchObject({ status: 0, body: { code: 'NETWORK_ERROR', message: 'Airwallex request failed' } });
  });

  it('surfaces provider status and code over HTTP for simulate', async () => {
    const fake = createFakeAirwallex({ now: () => new Date(INSTANT) });
    const fetch = wrapFetch(fake.fetch, async (url, init, next) => {
      if (url.pathname === '/api/v1/simulation/issuing/create' && (init?.method ?? 'GET') === 'POST') {
        return providerError(422, 'TEST_PROVIDER_REJECTED', 'synthetic provider failure');
      }
      return next();
    });
    const h = makeHarness({ fetch });
    seedDecision(h.ledger);
    await submit(h);
    await grant(h);
    const csrf = h.service.get(REQUEST.approvalRequestId).csrf;
    await withServer(h.service, async send => {
      expect(await send('POST', '/cards/card_test_1/simulate', { csrf, amount: '1.00', currency: 'USD', mcc: '7372' }, h.token)).toMatchObject({
        status: 502,
        body: { error: 'airwallex_api_error', provider: { status: 422, code: 'TEST_PROVIDER_REJECTED', step: 'simulate' } },
      });
    });
    expect(events(h)).toContainEqual(expect.objectContaining({
      kind: 'raw_response', endpoint: '/api/v1/simulation/issuing/create', status: 422,
      body: { code: 'TEST_PROVIDER_REJECTED', message: 'synthetic provider failure' },
    }));
  });
});

describe('independent M4 activation polling', () => {
  it('uses the 0.5/1/2/4 second back-off and stops as soon as the card is ACTIVE', async () => {
    const fake = createFakeAirwallex({ now: () => new Date(INSTANT) });
    let reads = 0;
    const fetch = wrapFetch(fake.fetch, async (url, init, next) => {
      const response = await next();
      if (url.pathname === '/api/v1/issuing/cards/card_test_1' && (init?.method ?? 'GET') === 'GET') {
        reads += 1;
        return mutateJsonResponse(response, body => ({
          ...asRecord(body, 'card'),
          card_status: reads < 5 ? 'PENDING' : 'ACTIVE',
        }));
      }
      return response;
    });
    const sleep = vi.fn(async () => {});
    const h = makeHarness({ fetch, sleep });
    seedDecision(h.ledger);
    await submit(h);
    await grant(h);
    expect(sleep.mock.calls).toEqual([[500], [1000], [2000], [4000]]);
    expect(reads).toBe(5);
    expect(fake.createCalls).toBe(1);
    expect(h.service.get(REQUEST.approvalRequestId).status).toBe('issued');
  });

  it('does not sleep when the first read is already ACTIVE', async () => {
    const sleep = vi.fn(async () => {});
    const h = makeHarness({ sleep });
    seedDecision(h.ledger);
    await submit(h);
    await grant(h);
    expect(sleep).not.toHaveBeenCalled();
    expect(events(h)).toContainEqual(expect.objectContaining({ kind: 'card_issued', cardId: 'card_test_1' }));
  });

  it('bounds polling at five reads and four sleeps, then fails without issuing twice', async () => {
    const fake = createFakeAirwallex({ now: () => new Date(INSTANT) });
    const fetch = wrapFetch(fake.fetch, async (url, init, next) => {
      const response = await next();
      if (url.pathname === '/api/v1/issuing/cards/card_test_1' && (init?.method ?? 'GET') === 'GET') {
        return mutateJsonResponse(response, body => ({ ...asRecord(body, 'card'), card_status: 'PENDING' }));
      }
      return response;
    });
    const sleep = vi.fn(async () => {});
    const h = makeHarness({ fetch, sleep });
    seedDecision(h.ledger);
    await submit(h);
    await expect(grant(h)).rejects.toMatchObject({ code: 'card_not_active' });
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[500], [1000], [2000], [4000]]);
    expect(h.service.get(REQUEST.approvalRequestId)).toMatchObject({ status: 'failed', attempted: true });
    expect(fake.createCalls).toBe(1);
    expect(events(h).some(event => event.kind === 'card_issued')).toBe(false);
    await expect(h.service.recover(REQUEST.approvalRequestId)).rejects.toMatchObject({ code: 'card_not_active' });
    expect(fake.createCalls).toBe(1);
  });
});

describe('independent M4 operator abandon route', () => {
  async function failedWithoutCard() {
    const fake = createFakeAirwallex({ now: () => new Date(INSTANT) });
    const fetch = wrapFetch(fake.fetch, async (url, init, next) => {
      if (url.pathname === '/api/v1/issuing/cards/create' && (init?.method ?? 'GET') === 'POST') {
        return providerError(500, 'TEST_CREATE_FAILED', 'synthetic create failure');
      }
      return next();
    });
    const h = makeHarness({ fetch });
    seedDecision(h.ledger);
    await submit(h);
    await expect(grant(h)).rejects.toMatchObject({ code: 'airwallex_api_error' });
    expect(h.service.get(REQUEST.approvalRequestId)).toMatchObject({ status: 'failed', attempted: true });
    expect(h.service.get(REQUEST.approvalRequestId).card).toBeUndefined();
    return h;
  }

  async function failedWithCard() {
    const fake = createFakeAirwallex({ now: () => new Date(INSTANT) });
    const fetch = wrapFetch(fake.fetch, async (url, init, next) => {
      if (url.pathname === '/api/v1/issuing/cards/card_test_1' && (init?.method ?? 'GET') === 'GET') {
        return providerError(500, 'TEST_READ_FAILED', 'synthetic read failure');
      }
      return next();
    });
    const h = makeHarness({ fetch });
    seedDecision(h.ledger);
    await submit(h);
    await expect(grant(h)).rejects.toMatchObject({ code: 'airwallex_api_error' });
    expect(h.service.get(REQUEST.approvalRequestId)).toMatchObject({ status: 'failed', attempted: true, card: { cardId: 'card_test_1' } });
    return h;
  }

  it('requires the operator token and CSRF before abandoning', async () => {
    const h = await failedWithoutCard();
    const csrf = h.service.get(REQUEST.approvalRequestId).csrf;
    const path = `/approvals/${REQUEST.approvalRequestId}/abandon`;
    await withServer(h.service, async send => {
      expect(await send('POST', path, { csrf })).toMatchObject({ status: 403, body: { error: 'operator_token_required' } });
      expect(await send('POST', path, { csrf }, 'wrong-synthetic-token')).toMatchObject({ status: 403, body: { error: 'operator_token_required' } });
      expect(await send('POST', path, {}, h.token)).toMatchObject({ status: 403, body: { error: 'csrf_required' } });
      expect(await send('POST', path, { csrf }, h.token)).toMatchObject({ status: 200, body: { ok: true } });
    });
    expect(h.service.get(REQUEST.approvalRequestId).status).toBe('rejected');
    expect(events(h).at(-1)).toMatchObject({ kind: 'approval_rejected', code: 'operator_abandoned' });
    await expect(h.service.recover(REQUEST.approvalRequestId)).rejects.toMatchObject({ code: 'approval_rejected' });
  });

  it('refuses to abandon a failed record that already has a card', async () => {
    const h = await failedWithCard();
    const csrf = h.service.get(REQUEST.approvalRequestId).csrf;
    await withServer(h.service, async send => {
      expect(await send('POST', `/approvals/${REQUEST.approvalRequestId}/abandon`, { csrf }, h.token)).toMatchObject({
        status: 409,
        body: { error: 'abandon_not_allowed' },
      });
    });
    expect(h.service.get(REQUEST.approvalRequestId).status).toBe('failed');
    expect(events(h).some(event => event.kind === 'approval_rejected')).toBe(false);
  });

  it('refuses to abandon when the recovery lookup finds an existing card', async () => {
    const h = await failedWithoutCard();
    const input = h.service.get(REQUEST.approvalRequestId).input;
    if (input === undefined) throw new Error('test_expected_issuance_input');
    let lookups = 0;
    const fake = createFakeAirwallex({ now: () => new Date(INSTANT) });
    const fetch = wrapFetch(fake.fetch, async (url, init, next) => {
      if (url.pathname === '/api/v1/issuing/cards' && (init?.method ?? 'GET') === 'GET') {
        lookups += 1;
        return new Response(JSON.stringify({
          items: [{ card_id: 'card_test_lookup', card_status: 'ACTIVE', request_id: input.request_id }],
          has_more: false,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return next();
    });
    const client = new AirwallexClient(
      loadAirwallexConfig({ AIRWALLEX_CLIENT_ID: 'test-client-id', AIRWALLEX_API_KEY: 'test-api-key' }),
      { fetch },
    );
    const service = new ApprovalService({ ...h.service.options, client });
    const csrf = service.get(REQUEST.approvalRequestId).csrf;
    await withServer(service, async send => {
      expect(await send('POST', `/approvals/${REQUEST.approvalRequestId}/abandon`, { csrf }, h.token)).toMatchObject({
        status: 409,
        body: { error: 'card_exists_recover_required' },
      });
    });
    expect(lookups).toBe(1);
    expect(service.get(REQUEST.approvalRequestId)).toMatchObject({ status: 'failed', card: { cardId: 'card_test_lookup' } });
    expect(events(h).some(event => event.kind === 'approval_rejected')).toBe(false);
    await withServer(service, async send => {
      expect(await send('POST', `/approvals/${REQUEST.approvalRequestId}/abandon`, { csrf }, h.token)).toMatchObject({
        status: 409,
        body: { error: 'abandon_not_allowed' },
      });
    });
    expect(lookups).toBe(1);
  });
});

describe('independent M4 freeze confirmation', () => {
  it('reports freeze_not_confirmed and records no success when response and readback are ACTIVE', async () => {
    const fake = createFakeAirwallex({ now: () => new Date(INSTANT) });
    let freezeCalls = 0;
    let readbackCalls = 0;
    const fetch = wrapFetch(fake.fetch, async (url, init, next) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.pathname === '/api/v1/issuing/cards/card_test_1/update' && method === 'POST') {
        freezeCalls += 1;
        return new Response(JSON.stringify({ card_id: 'card_test_1', card_status: 'ACTIVE' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname === '/api/v1/issuing/cards/card_test_1' && method === 'GET') {
        readbackCalls += 1;
      }
      return next();
    });
    const h = makeHarness({ fetch });
    seedDecision(h.ledger);
    await submit(h);
    await grant(h);
    freezeCalls = 0;
    readbackCalls = 0;
    await expect(new TransactionLoop(h.service).freeze('card_test_1', 'human', 'independent freeze test')).rejects.toMatchObject({ code: 'freeze_not_confirmed' });
    expect(freezeCalls).toBe(1);
    expect(readbackCalls).toBe(1);
    expect(events(h).some(event => event.kind === 'card_frozen')).toBe(false);
    expect(h.service.get(REQUEST.approvalRequestId).card?.status).toBe('ACTIVE');
    expect(fake.cards.get('card_test_1')?.card_status).toBe('ACTIVE');
    expect(verifyChain(h.ledger.read()).ok).toBe(true);
  });

  it('records card_frozen only when the readback confirms INACTIVE', async () => {
    const fake = createFakeAirwallex({ now: () => new Date(INSTANT) });
    let freezeRequested = false;
    const fetch = wrapFetch(fake.fetch, async (url, init, next) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.pathname === '/api/v1/issuing/cards/card_test_1/update' && method === 'POST') {
        freezeRequested = true;
        return new Response(JSON.stringify({ card_id: 'card_test_1', card_status: 'ACTIVE' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (freezeRequested && url.pathname === '/api/v1/issuing/cards/card_test_1' && method === 'GET') {
        fake.cards.get('card_test_1')!.card_status = 'INACTIVE';
      }
      return next();
    });
    const h = makeHarness({ fetch });
    seedDecision(h.ledger);
    await submit(h);
    await grant(h);
    await new TransactionLoop(h.service).freeze('card_test_1', 'human', 'independent freeze test');
    expect(events(h).filter(event => event.kind === 'card_frozen')).toMatchObject([
      { cardId: 'card_test_1', by: 'human', reason: 'independent freeze test' },
    ]);
  });
});

describe('independent M4 offline demo honesty', () => {
  it('writes run_started first, keeps sandbox wording out of the transcript, and attributes the demo freeze to a human', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spendkey-independent-demo-'));
    try {
      const result = await runDemo({ now: () => new Date(INSTANT), outputDir: dir });
      const file = readFileSync(join(dir, 'ledger.jsonl'), 'utf8');
      const firstLine = file.split('\n')[0];
      if (firstLine === undefined) throw new Error('test_expected_demo_ledger');
      expect(JSON.parse(firstLine)).toMatchObject({ seq: 0, event: { kind: 'run_started', mode: 'offline_emulator' } });
      expect(verifyJsonl(file).ok).toBe(true);
      expect(file.toLowerCase()).not.toContain('sandbox');
      const rows = result.ledger.read();
      expect(rows[0]?.event).toMatchObject({
        kind: 'run_started',
        mode: 'offline_emulator',
        policyNotes: [expect.stringContaining('reserve floor'), expect.any(String)],
      });
      expect(rows.filter(row => row.event.kind === 'run_started')).toHaveLength(1);
      expect(JSON.stringify(rows).toLowerCase()).not.toContain('sandbox');
      expect(result.transcript.some(line => line.includes('emulated (offline)'))).toBe(true);
      expect(result.transcript.some(line => /sandbox simulation/i.test(line))).toBe(false);
      for (const line of result.transcript.filter(item => /sandbox/i.test(item))) {
        expect(line).toMatch(/no Airwallex calls/i);
      }
      const frozen = rows.filter(row => row.event.kind === 'card_frozen');
      expect(frozen).toHaveLength(1);
      expect(frozen[0]?.event).toMatchObject({ kind: 'card_frozen', by: 'human', reason: expect.stringMatching(/^demo-operator:/) });
      expect(rows.some(row => {
        if (row.event.kind !== 'card_frozen') return false;
        return row.event.by === 'agent' || row.event.by === 'system';
      })).toBe(false);
      expect(result.transcript.some(line => /OPERATOR TOKEN/i.test(line))).toBe(false);
      expect(result.transcript.some(line => /APPROVAL NONCE/i.test(line))).toBe(false);
      expect(result.verification.ok).toBe(true);
      expect(result.fake.createCalls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not print the operator token when a demo-mode service is constructed', () => {
    const printOperatorToken = vi.fn();
    const fake = createFakeAirwallex({ now: () => new Date(INSTANT) });
    const client = new AirwallexClient(
      loadAirwallexConfig({ AIRWALLEX_CLIENT_ID: 'test-client-id', AIRWALLEX_API_KEY: 'test-api-key' }),
      { fetch: fake.fetch },
    );
    new ApprovalService({
      client, ledger: new InMemoryLedgerStore(), store: new MemoryApprovalStore(),
      now: () => new Date(INSTANT), cardholderId: 'cardholder_test_01', demoMode: true, printOperatorToken,
    });
    expect(printOperatorToken).not.toHaveBeenCalled();
  });
});

describe('independent M4 audit page run-mode labels', () => {
  function auditHarness(runMode: boolean, extra: CardAuditEvent[] = []) {
    const fake = createFakeAirwallex({ now: () => new Date(INSTANT) });
    const client = new AirwallexClient(
      loadAirwallexConfig({ AIRWALLEX_CLIENT_ID: 'test-client-id', AIRWALLEX_API_KEY: 'test-api-key' }),
      { fetch: fake.fetch },
    );
    const ledger = new InMemoryLedgerStore();
    if (runMode) {
      ledger.append({ kind: 'run_started', mode: 'offline_emulator', policyNotes: ['reserve floor = max(0, USD available - 500.00) = 500.00 USD must remain after upfront charges'] }, INSTANT);
    }
    ledger.append({
      kind: 'authorization', source: 'simulated', cardId: 'card_test_1', amount: '10.00', currency: 'USD',
      merchantCategoryCode: '7372', processResult: 'APPROVED', mapped: 'approved',
    }, '2026-11-11T10:00:01.000Z');
    ledger.append({
      kind: 'authorization', source: 'observed', cardId: 'card_test_1', amount: '61.00', currency: 'USD',
      merchantCategoryCode: '7372', processResult: 'DECLINED', failureReason: 'LIMIT_EXCEEDED',
      mapped: 'limit_exceeded', transactionId: 'transaction_test_02',
    }, '2026-11-11T10:00:02.000Z');
    for (const event of extra) ledger.append(event, '2026-11-11T10:00:03.000Z');
    const service = new ApprovalService({
      client, ledger, store: new MemoryApprovalStore(), now: () => new Date(INSTANT),
      cardholderId: 'cardholder_test_01', demoMode: true,
    });
    return service;
  }

  it('labels an offline run emulated (offline) and never sandbox simulation', async () => {
    await withServer(auditHarness(true), async send => {
      const page = await send('GET', '/audit');
      expect(page.status).toBe(200);
      expect(page.text).toContain('Offline emulator (no Airwallex calls)');
      expect(page.text).toContain('emulated (offline)');
      expect(page.text).not.toContain('sandbox simulation');
      expect(page.text.toLowerCase()).not.toContain('sandbox');
    });
  });

  it('shows mode unknown when run_started is missing and never guesses sandbox', async () => {
    await withServer(auditHarness(false), async send => {
      const page = await send('GET', '/audit');
      expect(page.status).toBe(200);
      expect(page.text).toContain('mode unknown');
      expect(page.text).not.toContain('emulated (offline)');
      expect(page.text).not.toContain('sandbox simulation');
      expect(page.text.toLowerCase()).not.toContain('sandbox');
    });
  });

  it('shows a controls mismatch and a system auto-freeze in an offline run', async () => {
    const extra: CardAuditEvent[] = [
      { kind: 'controls_readback', cardId: 'card_test_1', matches: false,
        expected: { allowed_merchant_categories: ['7372'] }, actual: { allowed_merchant_categories: ['5812'] } },
      { kind: 'card_frozen', cardId: 'card_test_1', by: 'system', reason: 'auto-freeze: controls mismatch' },
    ];
    await withServer(auditHarness(true, extra), async send => {
      const page = await send('GET', '/audit');
      expect(page.status).toBe(200);
      expect(page.text).toContain('controls read back: MISMATCH');
      expect(page.text).toContain('Frozen by system (auto): auto-freeze: controls mismatch');
      expect(page.text.toLowerCase()).not.toContain('sandbox');
    });
  });
});

describe('independent M4 stale locks and demo cleanup', () => {
  it('distinguishes a live owner lock from a stale lock without deleting it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spendkey-independent-lock-'));
    const path = join(dir, 'approvals.json');
    try {
      const live = new JsonApprovalStore(path);
      expect(() => new JsonApprovalStore(path)).toThrow(/approval_store_locked: owner process is alive/);
      live.close();
      writeFileSync(`${path}.lock`, JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now() - 120_000 }));
      let message = '';
      try { new JsonApprovalStore(path); } catch (error) { message = error instanceof Error ? error.message : String(error); }
      expect(message).toMatch(/^approval_store_stale_lock:/);
      expect(message).toMatch(/age \d+s/);
      expect(message).toContain('remove approvals.json.lock');
      expect(message).toContain('demo:sandbox cleanup');
      expect(readFileSync(`${path}.lock`, 'utf8')).toContain('2147483647');
      unlinkSync(`${path}.lock`);
      const reopened = new JsonApprovalStore(path);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('freezes every non-INACTIVE card in a persisted approvals.json and skips INACTIVE cards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spendkey-independent-cleanup-'));
    const path = join(dir, 'approvals.json');
    try {
      const ledger = new InMemoryLedgerStore();
      const store = new JsonApprovalStore(path);
      const h = makeHarness({ store, ledger });
      seedDecision(h.ledger);
      await submit(h);
      await grant(h);
      expect(h.service.get(REQUEST.approvalRequestId)).toMatchObject({ status: 'issued', card: { cardId: 'card_test_1' } });
      store.close();

      const persisted = JSON.parse(readFileSync(path, 'utf8')) as unknown[];
      const base = asRecord(persisted[0], 'base_record');
      const pending = structuredClone(base);
      asRecord(pending['request'], 'pending_request')['approvalRequestId'] = 'independent_request_pending';
      pending['card'] = { cardId: 'card_test_pending', status: 'PENDING' };
      pending['attempted'] = true;
      const inactive = structuredClone(base);
      asRecord(inactive['request'], 'inactive_request')['approvalRequestId'] = 'independent_request_inactive';
      inactive['card'] = { cardId: 'card_test_inactive', status: 'INACTIVE' };
      inactive['attempted'] = true;
      const lookup = structuredClone(base);
      asRecord(lookup['request'], 'lookup_request')['approvalRequestId'] = 'independent_request_lookup';
      delete lookup['card'];
      lookup['attempted'] = true;
      lookup['status'] = 'failed';
      asRecord(lookup['input'], 'lookup_input')['request_id'] = 'spk_lookup_request';
      writeFileSync(path, JSON.stringify([base, pending, inactive, lookup]));
      h.fake.cards.set('card_test_pending', { card_id: 'card_test_pending', card_status: 'PENDING' });
      h.fake.cards.set('card_test_inactive', { card_id: 'card_test_inactive', card_status: 'INACTIVE' });
      h.fake.cards.set('card_test_lookup', { card_id: 'card_test_lookup', card_status: 'ACTIVE', request_id: 'spk_lookup_request' });

      const reopened = new JsonApprovalStore(path);
      try {
        const service = new ApprovalService({
          client: h.client, ledger, store: reopened, now: () => new Date(INSTANT),
          cardholderId: 'cardholder_test_01', demoMode: true,
        });
        const log = vi.fn();
        await cleanupDemoCards(service, log);
        expect(h.fake.cards.get('card_test_1')?.card_status).toBe('INACTIVE');
        expect(h.fake.cards.get('card_test_pending')?.card_status).toBe('INACTIVE');
        expect(h.fake.cards.get('card_test_inactive')?.card_status).toBe('INACTIVE');
        expect(h.fake.cards.get('card_test_lookup')?.card_status).toBe('INACTIVE');
        expect(reopened.list().find(record => record.request.approvalRequestId === 'independent_request_lookup')?.card)
          .toMatchObject({ cardId: 'card_test_lookup', status: 'INACTIVE' });
        expect(events(h).filter(event => event.kind === 'card_frozen')).toMatchObject([
          { cardId: 'card_test_1', by: 'human', reason: 'demo-operator: cleanup' },
          { cardId: 'card_test_pending', by: 'human', reason: 'demo-operator: cleanup' },
          { cardId: 'card_test_lookup', by: 'human', reason: 'demo-operator: cleanup' },
        ]);
        const lines = log.mock.calls.map(call => String(call[0]));
        expect(lines.filter(line => line === 'Demo operator froze the card: INACTIVE.')).toHaveLength(3);
        expect(lines.filter(line => line === 'Demo card already INACTIVE.')).toHaveLength(1);
        expect(verifyChain(ledger.read()).ok).toBe(true);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

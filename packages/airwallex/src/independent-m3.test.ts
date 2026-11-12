import { describe, expect, it } from 'vitest';
import {
  AirwallexClient,
  AirwallexSafetyError,
  cardNicknameFromRequestId,
  loadAirwallexConfig,
} from './index.js';
import type { CreateCardInput } from './index.js';

const SANDBOX = 'https://api-demo.airwallex.com';
const START = Date.parse('2026-11-11T10:00:00.000Z');
const LOGIN = { token: 'test-session', expires_at: '2099-01-01T00:00:00.000Z' };

interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeClient(handler: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== SANDBOX) throw new Error('test_origin_mismatch');
    const call: RecordedCall = { method: init?.method ?? 'GET', path: url.pathname, query: url.searchParams };
    if (init?.body !== undefined) call.body = JSON.parse(String(init.body)) as unknown;
    calls.push(call);
    if (call.path === '/api/v1/authentication/login') return json(LOGIN);
    return handler(call);
  };
  const client = new AirwallexClient(
    loadAirwallexConfig({ AIRWALLEX_CLIENT_ID: 'test-client-id', AIRWALLEX_API_KEY: 'test-api-key' }),
    { fetch: fetchImpl, now: () => START },
  );
  const listCalls = () => calls.filter(call => call.path === '/api/v1/issuing/cards');
  return { client, calls, listCalls };
}

function createInput(overrides: Partial<CreateCardInput> = {}): CreateCardInput {
  return {
    request_id: `spk_${'a'.repeat(40)}`,
    cardholder_id: 'cardholder_test_01',
    created_by: 'console-operator',
    form_factor: 'VIRTUAL',
    is_personalized: true,
    program: { purpose: 'COMMERCIAL' },
    nick_name: 'spk independent test',
    authorization_controls: {
      allowed_transaction_count: 'MULTIPLE',
      allowed_currencies: ['USD'],
      allowed_merchant_categories: ['7372'],
      transaction_limits: { currency: 'USD', limits: [{ amount: '60.00', interval: 'MONTHLY' }] },
    },
    ...overrides,
  };
}

function controls(): Record<string, unknown> {
  return {
    allowed_transaction_count: 'MULTIPLE',
    allowed_currencies: ['USD'],
    allowed_merchant_categories: ['7372'],
    transaction_limits: { currency: 'USD', limits: [{ amount: '60.00', interval: 'MONTHLY' }] },
  };
}

describe('independent tolerant card creation', () => {
  it('keeps a created card id from an unfamiliar 2xx body and redacts credentials', async () => {
    const { client } = makeClient(() => json({
      card_id: 'card_test_odd_01',
      status: { state: 'ACTIVE' },
      token: 'test-secret-token',
      api_key: 'test-key-echo',
      cvv: 'test-cvv-value',
      card_number: '4111 1111 1111 1111',
      masked_card_number: '****0001',
    }));
    const result = await client.createCard(createInput());
    expect(result).toMatchObject({ ok: true, unconfirmed: true, card: { card_id: 'card_test_odd_01' } });
    expect(result.card?.card_status).toBeUndefined();
    const serialized = JSON.stringify(result);
    for (const secret of ['4111 1111 1111 1111', '4111111111111111', 'test-secret-token', 'test-key-echo', 'test-cvv-value']) {
      expect(serialized).not.toContain(secret);
    }
    expect(result.raw).toMatchObject({ card_id: 'card_test_odd_01', masked_card_number: '****0001' });
    expect(result.raw).not.toHaveProperty('token');
    expect(result.raw).not.toHaveProperty('api_key');
    expect(result.raw).not.toHaveProperty('cvv');
    expect(result.raw).not.toHaveProperty('card_number');
  });

  it('turns non-JSON and empty 2xx bodies into redacted diagnostics instead of errors', async () => {
    const nonJson = new Response('token=alpha-secret&pan=4111111111111111', { status: 200 });
    const nonJsonResult = await makeClient(() => nonJson).client.createCard(createInput());
    expect(nonJsonResult).toMatchObject({ ok: true, unconfirmed: true, raw: { nonJson: true } });
    const diagnostic = nonJsonResult.raw as { nonJson: true; length: number; head: string };
    expect(diagnostic.length).toBeGreaterThan(0);
    expect(diagnostic.head).not.toContain('alpha-secret');
    expect(diagnostic.head).not.toMatch(/4111?/);
    expect(nonJsonResult.card).toBeUndefined();

    const emptyResult = await makeClient(() => new Response('', { status: 200 })).client.createCard(createInput());
    expect(emptyResult).toEqual({ ok: true, unconfirmed: true, raw: { nonJson: true, length: 0, head: '' } });
  });

  it('keeps success when reading the 2xx body stream fails', async () => {
    const broken = { ok: true, status: 200, text: async () => { throw new Error('test_stream_failure'); } } as unknown as Response;
    const result = await makeClient(() => broken).client.createCard(createInput());
    expect(result).toEqual({ ok: true, unconfirmed: true, raw: { bodyReadFailed: true } });
  });

  it('never accepts a full PAN as a masked card number', async () => {
    const bodies = [
      { card_id: 'card_test_pan_01', card_status: 'ACTIVE', card_number: '4111111111111111' },
      { card_id: 'card_test_pan_02', card_status: 'ACTIVE', masked_card_number: '4111 1111 1111 1111' },
      { card_id: 'card_test_pan_03', card_status: 'ACTIVE', card_number: '****1111111111111' },
      { card_id: 'card_test_pan_04', card_status: 'ACTIVE', masked_card_number: '4111-1111-1111-1111' },
    ];
    for (const body of bodies) {
      const result = await makeClient(() => json(body)).client.createCard(createInput());
      expect(result.card?.card_id).toBe(body.card_id);
      expect(result.card?.card_number).toBeUndefined();
      expect(result.card?.masked_card_number).toBeUndefined();
      expect(result.card?.panLikeValueDropped).toBe(true);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('4111111111111111');
      expect(serialized).not.toContain('4111 1111 1111 1111');
      expect(serialized).not.toContain('4111-1111-1111-1111');
      expect(serialized).not.toContain('****1111111111111');
    }
  });

  it('retains a legitimate masked number and a strict success', async () => {
    const cardId = 'card_test_mask_01';
    const result = await makeClient(() => json({
      card_id: cardId,
      card_status: 'ACTIVE',
      card_number: '**** **** **** 0001',
      masked_card_number: '****0001',
      authorization_controls: controls(),
    })).client.createCard(createInput());
    expect(result).toMatchObject({
      ok: true,
      unconfirmed: false,
      card: { card_id: cardId, card_status: 'ACTIVE', card_number: '**** **** **** 0001', masked_card_number: '****0001' },
    });
  });
});

describe('independent recovery pagination', () => {
  it('stops when the server ignores page_num and repeats the first card id', async () => {
    const page = {
      items: [
        { card_id: 'card_page_a', request_id: 'spk_target', card_status: 'ACTIVE' },
        { card_id: 'card_page_b', card_status: 'ACTIVE' },
      ],
      has_more: true,
    };
    const { client, listCalls } = makeClient(() => json(page));
    const found = await client.findCardByRequestId('spk_target');
    expect(found).toMatchObject({ card_id: 'card_page_a', request_id: 'spk_target' });
    expect(listCalls()).toHaveLength(2);
  });

  it('matches a nickname only when the row has no explicit request id', async () => {
    const nickname = cardNicknameFromRequestId('spk_target');
    const { client, listCalls } = makeClient(() => json({
      items: [{ card_id: 'card_nickname', nick_name: nickname, card_status: 'ACTIVE' }],
    }));
    expect(await client.findCardByRequestId('spk_target')).toMatchObject({ card_id: 'card_nickname' });
    expect(listCalls()).toHaveLength(1);

    const conflicting = await makeClient(() => json({
      items: [{ card_id: 'card_conflict', request_id: 'spk_other', nick_name: nickname, card_status: 'ACTIVE' }],
    })).client.findCardByRequestId('spk_target');
    expect(conflicting).toBeUndefined();
  });

  it('stops on an empty page even when has_more stays true', async () => {
    const { client, listCalls } = makeClient(() => json({ items: [], has_more: true }));
    expect(await client.findCardByRequestId('spk_missing')).toBeUndefined();
    expect(listCalls()).toHaveLength(1);
  });

  it('accepts data and results page arrays', async () => {
    const data = await makeClient(() => json({
      data: [{ card_id: 'card_data_01', request_id: 'spk_data', card_status: 'ACTIVE' }], has_more: false,
    })).client.findCardByRequestId('spk_data');
    expect(data).toMatchObject({ card_id: 'card_data_01' });

    const results = await makeClient(() => json({
      results: [{ card_id: 'card_results_01', request_id: 'spk_results', card_status: 'ACTIVE' }], has_more: false,
    })).client.findCardByRequestId('spk_results');
    expect(results).toMatchObject({ card_id: 'card_results_01' });
  });

  it('does not use a truncated nickname for long request ids but still accepts an explicit id', async () => {
    const longId = 'r'.repeat(60);
    expect(`spk ${longId}`.length).toBeGreaterThan(50);
    const nickOnly = await makeClient(() => json({
      items: [{ card_id: 'card_long_nick', nick_name: cardNicknameFromRequestId(longId), card_status: 'ACTIVE' }],
    })).client.findCardByRequestId(longId);
    expect(nickOnly).toBeUndefined();

    const explicit = await makeClient(() => json({
      items: [{ card_id: 'card_long_explicit', request_id: longId, card_status: 'ACTIVE' }],
    })).client.findCardByRequestId(longId);
    expect(explicit).toMatchObject({ card_id: 'card_long_explicit', request_id: longId });
  });

  it('adds the injected clock as the upper creation bound only when createdAfter is supplied', async () => {
    const first = makeClient(() => json({ items: [], has_more: false }));
    await first.client.findCardByRequestId('spk_missing', { cardholderId: 'cardholder_test_01', createdAfter: '2026-11-01T00:00:00.000Z' });
    const query = first.listCalls()[0]!.query;
    expect(query.get('cardholder_id')).toBe('cardholder_test_01');
    expect(query.get('from_created_at')).toBe('2026-11-01T00:00:00.000Z');
    expect(query.get('to_created_at')).toBe(new Date(START).toISOString());
    expect(query.get('page_size')).toBe('100');

    const second = makeClient(() => json({ items: [], has_more: false }));
    await second.client.findCardByRequestId('spk_missing');
    expect(second.listCalls()[0]!.query.get('to_created_at')).toBeNull();
    expect(second.listCalls()[0]!.query.get('from_created_at')).toBeNull();
  });

  it('returns a seen match with listTruncated at the page cap while listCards throws', async () => {
    const pageFor = (page: number) => json({
      items: [{ card_id: `card_cap_${page}`, card_status: 'ACTIVE', ...(page === 0 ? { request_id: 'spk_cap_target' } : {}) }],
      has_more: true,
    });
    const { client, listCalls } = makeClient(call => pageFor(Number(call.query.get('page_num') ?? '0')));
    const found = await client.findCardByRequestId('spk_cap_target');
    expect(found).toMatchObject({ card_id: 'card_cap_0', listTruncated: true });
    expect(listCalls()).toHaveLength(200);
    await expect(client.listCards()).rejects.toBeInstanceOf(AirwallexSafetyError);
    expect(listCalls()).toHaveLength(400);
  });
});

describe('independent signed transaction amounts', () => {
  it('uses the inverse provider sign regardless of transaction type', async () => {
    const rows = [
      { transaction_id: 'transaction_refund', transaction_type: 'REFUND', transaction_amount: '3.00', transaction_currency: 'USD' },
      { transaction_id: 'transaction_refund_lower', transaction_type: 'refund', transaction_amount: '3.00', transaction_currency: 'USD' },
      { transaction_id: 'transaction_reversal', transaction_type: 'REVERSAL', transaction_amount: 3, transaction_currency: 'USD' },
      { transaction_id: 'transaction_clearing', transaction_type: 'CLEARING_REVERSAL', transaction_amount: '1.25', transaction_currency: 'USD' },
      { transaction_id: 'transaction_purchase', transaction_type: 'PURCHASE', transaction_amount: '3.00', transaction_currency: 'USD' },
      { transaction_id: 'transaction_negative_refund', transaction_type: 'REFUND', transaction_amount: '-3.00', transaction_currency: 'USD' },
      { transaction_id: 'transaction_zero_refund', transaction_type: 'REFUND', transaction_amount: '0', transaction_currency: 'USD' },
    ];
    const { client } = makeClient(() => json({ items: rows, has_more: false }));
    const result = await client.listTransactions();
    const byId = new Map(result.items.map(item => [item.transaction_id, item]));
    expect(byId.get('transaction_refund')).toMatchObject({ transaction_amount: '3.00', signedAmount: '-3.00' });
    expect(byId.get('transaction_refund_lower')).toMatchObject({ transaction_amount: '3.00', signedAmount: '-3.00' });
    expect(byId.get('transaction_reversal')).toMatchObject({ transaction_amount: 3, signedAmount: -3 });
    expect(byId.get('transaction_clearing')).toMatchObject({ transaction_amount: '1.25', signedAmount: '-1.25' });
    expect(byId.get('transaction_purchase')).toMatchObject({ transaction_amount: '3.00', signedAmount: '-3.00' });
    expect(byId.get('transaction_negative_refund')).toMatchObject({ transaction_amount: '-3.00', signedAmount: '3.00' });
    expect(byId.get('transaction_zero_refund')).toMatchObject({ transaction_amount: '0', signedAmount: '0' });
  });
});

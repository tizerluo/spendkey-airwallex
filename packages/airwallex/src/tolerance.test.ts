import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AirwallexSafetyError } from './errors.js';
import {
  AirwallexClient, CARD_NICKNAME_MAX_LENGTH, cardNicknameFromRequestId, cardSchema, createCardInputSchema, loadAirwallexConfig,
} from './index.js';

const input = createCardInputSchema.parse({
  ...JSON.parse(readFileSync(new URL('../fixtures/card-create.json', import.meta.url), 'utf8')),
  request_id: 'request_test_01',
});
const baseCard = { card_id: 'card_test_01', card_status: 'ACTIVE' };
const baseTransaction = { transaction_id: 'transaction_test_01', card_id: 'card_test_01',
  transaction_type: 'REFUND', status: 'SUCCEEDED', transaction_amount: '-12.34', transaction_currency: 'USD' };
const merchant = { name: 'Test Merchant', category_code: '7372', city: 'Example City', country: 'US' };
function harness(respond: (url: URL) => Response) {
  const calls: URL[] = [];
  const client = new AirwallexClient(loadAirwallexConfig({
    AIRWALLEX_CLIENT_ID: 'test-client-id', AIRWALLEX_API_KEY: 'test-api-key',
  }), { now: () => Date.parse('2030-01-02T00:00:00Z'), fetch: async url => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/v1/authentication/login') {
      return json({ token: 'test-token', expires_at: '2030-01-03T00:00:00Z' });
    }
    calls.push(parsed);
    return respond(parsed);
  } });
  return { client, calls };
}
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }

describe('tolerant card responses', () => {
  it.each(['************2959', '424242******1234', '4242 **** **** 1234', 'xxxx-xxxx-xxxx-0000', '●●●● 0000'])('keeps masked formats %s', async mask => {
    const { client } = harness(() => json({ ...baseCard, card_number: mask, masked_card_number: mask }));
    const result = await client.createCard(input);
    expect(result).toMatchObject({ ok: true, unconfirmed: false, card: { ...baseCard, card_number: mask, masked_card_number: mask } });
    expect(result.raw).toEqual({ ...baseCard, masked_card_number: mask });
  });

  it.each([13, 16, 19])('drops a synthetic %i-digit PAN-like value without losing the card', async length => {
    const { client } = harness(() => json({ ...baseCard, card_number: '0'.repeat(length), masked_card_number: '0'.repeat(length) }));
    const result = await client.createCard(input);
    expect(result.card).toEqual({ ...baseCard, panLikeValueDropped: true });
    expect(JSON.stringify(result)).not.toContain('0'.repeat(length));
    expect(await client.getCard('card_test_01')).toEqual({ ...baseCard, panLikeValueDropped: true });
  });

  it.each([
    { card_id: 'card_test_01' },
    { ...baseCard, authorization_controls: { new_format: true }, brand: 12 },
    { ...baseCard, card_status: null, card_number: 'unknown-format' },
  ])('retains the created ID when strict validation fails: %#', async body => {
    const { client, calls } = harness(() => json(body, 202));
    const result = await client.createCard(input);
    expect(result).toMatchObject({ ok: true, unconfirmed: true, card: { card_id: 'card_test_01' } });
    expect(result.card).not.toHaveProperty('authorization_controls');
    expect(result.card).not.toHaveProperty('brand');
    expect(calls).toHaveLength(1);
  });

  it.each([{}, null, [], 'unknown response', { result: { card_id: 'card_test_01' } }])('returns an unconfirmed result for an unfamiliar body: %#', async body => {
    const { client } = harness(() => json(body));
    expect(await client.createCard(input)).toEqual({ ok: true, unconfirmed: true, raw: body });
  });

  it.each([200, 201, 202, 204, 299])('never rejects a non-JSON/empty 2xx body: %s', async status => {
    const { client } = harness(() => new Response(status === 204 ? null : 'unknown response', { status }));
    expect(await client.createCard(input)).toEqual({ ok: true, unconfirmed: true, raw: status === 204 ? '' : 'unknown response' });
  });

  it('keeps 2xx success when reading the response stream fails', async () => {
    const { client } = harness(() => new Response(new ReadableStream({ start(controller) { controller.error(new Error('test stream failure')); } })));
    expect(await client.createCard(input)).toEqual({ ok: true, unconfirmed: true, raw: { bodyReadFailed: true } });
  });

  it('recursively redacts sensitive keys, credential echoes, numeric PANs and digit runs in diagnostics', async () => {
    const body = { card_id: 'card_test_01', cvv: 'test-cvv', nested: {
      PAN: 'test-pan', card_number: 'test-number', card_number_masked: '****0000',
      masked_card_number: '123456******0000', cvc: 'test-cvc', access_token: 'test-token', secret: 'test-secret', apiKey: 'test-api-key',
      password: 'test-password', auth: 'test-auth', credential: 'test-credential', security_code: '000',
      expiry: '2030-01', pin: '0000', invoice: 'not a secret',
      authorization_controls: { allowed_currencies: ['USD'] },
      note: `test-api-key test-client-id test-token ${'0'.repeat(16)}`, number: Number('1'.repeat(13)),
      count: Number('1'.repeat(13)),
      array: [{ session_token: 'test-token', other: 'safe' }],
    } };
    const { client } = harness(() => json(body));
    const result = await client.createCard(input);
    expect(result.raw).toEqual({ card_id: 'card_test_01', nested: {
      card_number_masked: '****0000', masked_card_number: '123456******0000',
      invoice: 'not a secret', authorization_controls: { allowed_currencies: ['USD'] },
      note: '[redacted] [redacted] [redacted] [redacted]', count: '[redacted]', array: [{ other: 'safe' }],
    } });
    expect(result.unconfirmed).toBe(true);
  });

  it('redacts spaced and dashed PANs on createCard raw and getCard', async () => {
    const spaced = '0000 0000 0000 0000';
    const dashed = '0000-0000-0000-0000';
    const body = { ...baseCard, card_number: spaced, masked_card_number: dashed, note: `ref ${spaced}`, reference: dashed };
    const { client } = harness(() => json(body));
    const created = await client.createCard(input);
    expect(created.card).toEqual({ ...baseCard, panLikeValueDropped: true });
    expect(created.raw).toEqual({ ...baseCard, masked_card_number: '[redacted]', note: 'ref [redacted]', reference: '[redacted]' });
    expect(JSON.stringify(created)).not.toContain('0000');
    expect(await client.getCard('card_test_01')).toEqual({ ...baseCard, panLikeValueDropped: true });
    expect(JSON.stringify(await client.getCard('card_test_01'))).not.toContain('0000');
  });

  it('rejects a spaced PAN that only looks masked because it still has more than 12 digits', () => {
    expect(cardSchema.safeParse({ ...baseCard, masked_card_number: `${'0'.repeat(12)}*` }).success).toBe(true);
    expect(cardSchema.safeParse({ ...baseCard, masked_card_number: '0000 0000 0000 0000 x' }).success).toBe(false);
    const dropped = cardSchema.safeParse({ ...baseCard, card_number: '0000 0000 0000 0000' });
    expect(dropped.success).toBe(true);
    if (dropped.success) expect(dropped.data).toEqual({ ...baseCard, panLikeValueDropped: true });
  });

  it('bounds diagnostic nesting without rejecting a successfully created card', async () => {
    const { client } = harness(() => new Response('{"card_id":"card_test_01","future":' + '['.repeat(2000) + 'null' + ']'.repeat(2000) + '}'));
    const result = await client.createCard(input);
    expect(result).toMatchObject({ ok: true, unconfirmed: true, card: { card_id: 'card_test_01' } });
    expect(JSON.stringify(result.raw)).toContain('[redacted]');
  });

  it('still rejects non-2xx responses without retrying issuance', async () => {
    const { client, calls } = harness(() => json({ code: 'TEST_DECLINED', message: 'Synthetic failure' }, 400));
    await expect(client.createCard(input)).rejects.toMatchObject({ status: 400, code: 'TEST_DECLINED' });
    expect(calls).toHaveLength(1);
  });
});

describe('card recovery', () => {
  it('walks zero-based pages and preserves filters while retaining malformed cards', async () => {
    const { client, calls } = harness(url => Number(url.searchParams.get('page_num')) === 0
      ? json({ has_more: true, items: [{ ...baseCard, card_number: '424242******0000' }, { other: 'test-token', cvv: 'test-cvv' }] })
      : json({ has_more: false, items: [{ card_id: 'card_test_02', nick_name: 'test-nickname' }] }));
    const result = await client.listCards({ cardholderId: 'cardholder_test_01', createdAfter: '2030-01-01T00:00:00Z',
      createdBefore: '2030-01-02T00:00:00Z', updatedAfter: '2030-01-01T00:00:00Z', updatedBefore: '2030-01-02T00:00:00Z',
      status: 'ACTIVE', nickName: 'test-nickname', pageSize: 10 });
    expect(result.items.map(card => card.card_id)).toEqual(['card_test_01', 'card_test_02']);
    expect(result.unparsed).toEqual([{ other: '[redacted]' }]);
    expect(calls.map(url => url.searchParams.get('page_num'))).toEqual(['0', '1']);
    for (const call of calls) expect(Object.fromEntries(call.searchParams)).toMatchObject({
      cardholder_id: 'cardholder_test_01', from_created_at: '2030-01-01T00:00:00Z', to_created_at: '2030-01-02T00:00:00Z',
      from_updated_at: '2030-01-01T00:00:00Z', to_updated_at: '2030-01-02T00:00:00Z',
      card_status: 'ACTIVE', nick_name: 'test-nickname', page_size: '10',
    });
  });

  it.each([0, 9, 201, 1.5, NaN])('rejects invalid page size %s before fetch', async pageSize => {
    const { client, calls } = harness(() => json({}));
    await expect(client.listCards({ pageSize })).rejects.toThrow('Invalid card page size');
    expect(calls).toEqual([]);
  });

  it('prefers an explicit request_id on later pages over a nickname match', async () => {
    const { client, calls } = harness(url => url.searchParams.get('page_num') === '0'
      ? json({ has_more: true, items: [{ ...baseCard, nick_name: cardNicknameFromRequestId('request_test_01') }] })
      : json({ has_more: false, items: [{ card_id: 'card_test_02', request_id: 'request_test_01' }] }));
    expect(await client.findCardByRequestId('request_test_01', { cardholderId: 'cardholder_test_01', createdAfter: '2030-01-01T00:00:00Z' })).toMatchObject({ card_id: 'card_test_02' });
    expect(calls[0]?.searchParams.get('to_created_at')).toBe('2030-01-02T00:00:00.000Z');
    expect(calls.every(call => !call.searchParams.has('request_id') && !call.searchParams.has('nick_name'))).toBe(true);
  });

  it('falls back to an exact nickname only when request_id is absent', async () => {
    const { client } = harness(() => json({ has_more: false, items: [
      { ...baseCard, request_id: 'request_test_other', nick_name: cardNicknameFromRequestId('request_test_01') },
      { card_id: 'card_test_02', nick_name: cardNicknameFromRequestId('request_test_01') },
    ] }));
    expect(await client.findCardByRequestId('request_test_01')).toMatchObject({ card_id: 'card_test_02' });
    expect(await client.findCardByRequestId('request_test_missing')).toBeUndefined();
  });

  it('bounds nicknames and retains the entire generated approval request ID', () => {
    expect(cardNicknameFromRequestId('request_test_01')).toBe('spk request_test_01');
    expect(cardNicknameFromRequestId('r'.repeat(80))).toHaveLength(50);
  });

  it('reads data and results envelopes and stops when has_more is omitted on a short page', async () => {
    const { client, calls } = harness(url => url.searchParams.get('page_num') === '0'
      ? json({ data: Array.from({ length: 10 }, (_, index) => ({ card_id: `card_test_${String(index).padStart(2, '0')}`, card_status: 'ACTIVE' })) })
      : json({ results: [{ card_id: 'card_test_10', card_status: 'ACTIVE' }] }));
    const result = await client.listCards({ pageSize: 10 });
    expect(result.items.map(card => card.card_id)).toEqual([
      ...Array.from({ length: 10 }, (_, index) => `card_test_${String(index).padStart(2, '0')}`),
      'card_test_10',
    ]);
    expect(calls.map(url => url.searchParams.get('page_num'))).toEqual(['0', '1']);
  });

  it('stops on an empty page even when has_more stays true', async () => {
    const { client, calls } = harness(url => url.searchParams.get('page_num') === '0'
      ? json({ has_more: true, items: [baseCard] })
      : json({ has_more: true, items: [] }));
    expect((await client.listCards()).items.map(card => card.card_id)).toEqual(['card_test_01']);
    expect(calls.map(url => url.searchParams.get('page_num'))).toEqual(['0', '1']);
  });

  it('throws AirwallexSafetyError after 200 pages that still claim more results', async () => {
    const { client, calls } = harness(() => json({ has_more: true, items: [baseCard] }));
    const error = await client.listCards().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AirwallexSafetyError);
    expect((error as Error).message).toBe('Card list page cap exceeded');
    expect(calls).toHaveLength(200);
  });

  it('does not match a truncated nickname when two long request ids would collide', async () => {
    const shared = 'r'.repeat(46);
    const idA = `${shared}aaaa`;
    const idB = `${shared}bbbb`;
    expect(`spk ${idA}`.length).toBeGreaterThan(CARD_NICKNAME_MAX_LENGTH);
    expect(cardNicknameFromRequestId(idA)).toBe(cardNicknameFromRequestId(idB));
    const { client } = harness(() => json({ has_more: false, items: [
      { card_id: 'card_test_01', request_id: idB, nick_name: cardNicknameFromRequestId(idB) },
      { card_id: 'card_test_02', nick_name: cardNicknameFromRequestId(idA) },
    ] }));
    expect(await client.findCardByRequestId(idA)).toBeUndefined();
    expect(await client.findCardByRequestId(idB)).toMatchObject({ card_id: 'card_test_01' });
  });
});

describe('reconciliation response tolerance', () => {
  it.each(['-12.34', -12.34])('keeps signed refund amount %s, merchant, lifecycle and redacted unknowns', async amount => {
    const { client } = harness(() => json({ items: [{ ...baseTransaction, transaction_amount: amount, billing_amount: amount,
      merchant, card_transaction_id: 'card_transaction_test_01', card_transaction_lifecycle_id: 'lifecycle_test_01',
      future: { value: 'safe', token: 'test-token', note: 'test-api-key' },
    }] }));
    const result = await client.listTransactions();
    expect(result.unparsed).toEqual([]);
    expect(result.items[0]).toMatchObject({ transaction_amount: amount, billing_amount: amount, signedAmount: amount, merchant,
      transaction_type: 'REFUND', status: 'SUCCEEDED', card_transaction_id: 'card_transaction_test_01',
      card_transaction_lifecycle_id: 'lifecycle_test_01', extra: { future: { value: 'safe', note: '[redacted]' } },
    });
  });

  it.each([
    ['REFUND', '12.34', '-12.34'],
    ['REVERSAL', 12.34, -12.34],
    ['REFUND', '-1.00', '-1.00'],
    ['REVERSAL', 0, 0],
    ['AUTHORIZATION', '12.34', '12.34'],
    ['refund', '12.34', '12.34'],
  ] as const)('derives signedAmount for %s amount %s without rewriting transaction_amount', async (type, amount, signed) => {
    const { client } = harness(() => json({ items: [{ ...baseTransaction, transaction_type: type, transaction_amount: amount }] }));
    const item = (await client.listTransactions()).items[0];
    expect(item?.transaction_amount).toBe(amount);
    expect(item?.signedAmount).toBe(signed);
  });

  it('redacts spaced and dashed PANs in simulation extra and transaction extra', async () => {
    const spaced = '0000 0000 0000 0000';
    const dashed = '0000-0000-0000-0000';
    const masked = `${spaced} x`;
    const { client } = harness(url => url.pathname.endsWith('/simulation/issuing/create')
      ? json({ process_result: 'APPROVED', note: spaced, reference: dashed, masked_card_number: masked })
      : json({ items: [{ ...baseTransaction, note: spaced, reference: dashed, masked_card_number: masked }] }));
    const simulation = await client.simulateAuthorization({ card_id: 'card_test_01', transaction_amount: '1.00',
      transaction_currency: 'USD', merchant_category_code: '7372' });
    expect(simulation.extra).toEqual({ note: '[redacted]', reference: '[redacted]', masked_card_number: '[redacted] x' });
    expect(JSON.stringify(simulation)).not.toContain('0000');
    const transaction = (await client.listTransactions()).items[0];
    expect(transaction?.extra).toEqual({ note: '[redacted]', reference: '[redacted]', masked_card_number: '[redacted] x' });
    expect(JSON.stringify(transaction)).not.toContain('0000');
  });

  it('keeps valid merchant fields when another field changes shape and retains nested unknowns', async () => {
    const { client } = harness(() => json({ items: [{ ...baseTransaction,
      merchant: { name: 'Test Merchant', city: { future: true }, new_field: 'test-token', secret: 'test-secret' },
    }] }));
    const result = await client.listTransactions();
    expect(result.unparsed).toEqual([]);
    expect(result.items[0]?.merchant).toMatchObject({ name: 'Test Merchant',
      extra: { city: { future: true }, new_field: '[redacted]' },
    });
  });

  it('returns malformed rows as redacted unparsed data alongside valid rows', async () => {
    const { client } = harness(() => json({ has_more: false, items: [baseTransaction, { ...baseTransaction,
      transaction_amount: 'future-format', cvv: 'test-cvv', note: `test-token ${'0'.repeat(16)}`,
    }, null, { card_id: 'card_test_02', secret: 'test-secret' }] }));
    const result = await client.listTransactions();
    expect(result.items).toHaveLength(1);
    expect(result.unparsed).toEqual([{ ...baseTransaction, transaction_amount: 'future-format', note: '[redacted] [redacted]' },
      null, { card_id: 'card_test_02' }]);
  });

  it('keeps simulation IDs, complete merchant fields and future result codes', async () => {
    const { client } = harness(() => json({ process_result: 'FUTURE_RESULT', merchant, merchant_info: merchant,
      card_transaction_id: 'card_transaction_test_01', card_transaction_lifecycle_id: 'lifecycle_test_01',
      future: { secret: 'test-secret', note: 'test-token' },
    }));
    const result = await client.simulateAuthorization({ card_id: 'card_test_01', transaction_amount: '1.00',
      transaction_currency: 'USD', merchant_category_code: '7372' });
    expect(result).toMatchObject({ process_result: 'FUTURE_RESULT', merchant, merchant_info: merchant,
      card_transaction_id: 'card_transaction_test_01', card_transaction_lifecycle_id: 'lifecycle_test_01',
      extra: { future: { note: '[redacted]' } },
    });
  });

  it('tolerates missing and malformed optional simulation fields', async () => {
    const { client } = harness(() => json({ card_transaction_id: 'card_transaction_test_01', process_result: null, merchant: 12 }));
    expect(await client.simulateAuthorization({ card_id: 'card_test_01', transaction_amount: 1,
      transaction_currency: 'USD', merchant_category_code: '7372' })).toMatchObject({ card_transaction_id: 'card_transaction_test_01', extra: { process_result: null, merchant: 12 } });
  });
});

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && !entry.name.includes('.test.') && !entry.name.includes('.spec.')) files.push(path);
  }
  return files;
}

it('contains no production-origin escape hatch in repository package source', () => {
  const packagesDir = fileURLToPath(new URL('../../../packages/', import.meta.url));
  const hits: string[] = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const srcDir = join(packagesDir, entry.name, 'src');
    if (!existsSync(srcDir)) continue;
    for (const file of sourceFiles(srcDir)) {
      if (readFileSync(file, 'utf8').includes('allowNonSandbox')) hits.push(file);
    }
  }
  expect(hits).toEqual([]);
});

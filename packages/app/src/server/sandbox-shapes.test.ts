import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadAirwallexConfig, transactionSchema, type AuthorizationControls } from '@sk/airwallex';
import { InMemoryLedgerStore, verifyChain } from '@sk/ledger';
import { termsHash, type ApprovalRequest } from '@sk/policy';
import { createFakeAirwallex } from '../demo/fake-airwallex.js';
import { createAppAirwallexClient } from './airwallex-client.js';
import { recordDecision } from './decision-fixture.test-support.js';
import { ApprovalService, controlsMatch } from './service.js';
import { MemoryApprovalStore } from './store.js';
import { monthWindow, spentInWindowMinor, TransactionLoop } from './transactions.js';

const at = '2030-01-01T00:00:00.000Z';
const now = () => new Date(at);
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../../airwallex/fixtures/${name}.json`, import.meta.url), 'utf8'));
}
function readback() {
  return (fixture('card-get') as { authorization_controls: AuthorizationControls & Record<string, unknown> }).authorization_controls;
}
async function setup(transform?: (body: Record<string, unknown>, path: string) => void) {
  const fake = createFakeAirwallex({ now });
  const client = createAppAirwallexClient(loadAirwallexConfig({ AIRWALLEX_CLIENT_ID: 'test-client-id', AIRWALLEX_API_KEY: 'test-api-key' }), async (target, init) => {
    const response = await fake.fetch(target, init);
    const path = new URL(String(target)).pathname;
    if (init?.method !== 'GET' || !transform) return response;
    const body = await response.json() as Record<string, unknown>;
    transform(body, path);
    return new Response(JSON.stringify(body), { status: response.status });
  });
  const ledger = new InMemoryLedgerStore();
  let nonce = '';
  const service = new ApprovalService({ client, ledger, store: new MemoryApprovalStore(), now,
    cardholderId: 'cardholder_test_01', printNonce: line => { nonce = line.split(': ')[1]!; }, printOperatorToken: () => {} });
  const request: ApprovalRequest = { approvalRequestId: 'request_test_live_shapes', offerId: 'offer_test_monthly', vendor: 'Synthetic vendor',
    product: 'Synthetic plan', plan: 'monthly', rail: 'card', currency: 'USD', amountMinor: 6000, interval: 'MONTHLY',
    allowedTransactionCount: 'MULTIPLE', merchantCategoryCode: '7372', commitmentMonths: 0, priceStatus: 'price_unverified',
    createdAt: at, expiresAt: '2030-01-01T00:15:00.000Z' };
  recordDecision(ledger, request); await service.submit(request);
  const grant = () => service.grant(request.approvalRequestId, { nonce, csrf: service.get(request.approvalRequestId).csrf, presentedTermsHash: termsHash(request) });
  return { fake, client, ledger, service, grant, loop: new TransactionLoop(service) };
}

describe('sandbox-confirmed synthetic controls', () => {
  it.each(['match', 'missing_limit', 'amount', 'extra_mcc', 'extra_currency', 'limit_currency', 'count'] as const)(
    'compares live readback and records redacted provider additions (%s)', async change => {
      const actual = readback();
      if (change === 'missing_limit') actual.transaction_limits.limits.shift();
      if (change === 'amount') actual.transaction_limits.limits[0]!.amount = 61;
      if (change === 'extra_mcc') actual.allowed_merchant_categories.push('5812');
      if (change === 'extra_currency') actual.allowed_currencies.push('EUR');
      if (change === 'limit_currency') actual.transaction_limits.currency = 'EUR';
      if (change === 'count') actual.allowed_transaction_count = 'SINGLE';
      actual['api_key'] = 'test-redacted-key';
      const f = await setup((body, path) => {
        if (path === '/api/v1/issuing/cards/card_test_1') body['authorization_controls'] = actual;
      });
      if (change === 'match') await expect(f.grant()).resolves.toMatchObject({ status: 'issued', card: { status: 'ACTIVE', maskedNumber: '************0000' } });
      else await expect(f.grant()).rejects.toMatchObject({ code: 'controls_mismatch' });
      const evidence = f.ledger.read().find(({ event }) => event.kind === 'controls_readback')?.event;
      expect(evidence).toMatchObject({ matches: change === 'match', actual: {
        transaction_limits: actual.transaction_limits,
        allowed_merchant_brands: { categories: [], ids: [], subcategories: [] },
        allowed_merchant_countries: [], blocked_transaction_usages: [],
      } });
      expect(JSON.stringify(evidence)).not.toContain('test-redacted-key');
      expect(f.fake.cards.get('card_test_1')?.card_status).toBe(change === 'match' ? 'ACTIVE' : 'INACTIVE');
      expect(verifyChain(f.ledger.read()).ok).toBe(true);
    },
  );

  it('requires every sent limit, including interval and amount, while accepting further conjunctive limits', () => {
    const actual = readback();
    const expected = structuredClone(actual);
    actual.transaction_limits.limits.push({ amount: 500, interval: 'DAILY' });
    expect(controlsMatch(expected, actual)).toBe(true);
    actual.transaction_limits.limits[1]!.interval = 'ALL_TIME';
    expect(controlsMatch(expected, actual)).toBe(false);
  });
});

describe('sandbox-confirmed synthetic transaction accounting', () => {
  it('joins nested card IDs and totals pending, settled and positive credits while excluding failed spend', async () => {
    const items = (fixture('transactions') as { items: Record<string, unknown>[] }).items;
    const credits = (fixture('transactions-credit') as { items: Record<string, unknown>[] }).items;
    const settled = { ...items[0], transaction_id: 'transaction_test_settled', transaction_amount: -5, billing_amount: -5,
      status: 'SUCCEEDED', card_transaction_data: { card_transaction_id: 'card_transaction_test_settled' } };
    const rows = [...items, ...credits, settled].map(row => ({ ...row, card_id: 'card_test_1' }));
    const f = await setup((body, path) => {
      if (path === '/api/v1/issuing/transactions') { body['items'] = rows; body['has_more'] = false; }
    });
    await f.grant();
    await f.loop.simulate('card_test_1', { amount: '10.00', currency: 'USD', mcc: '7372' });
    expect(await f.loop.reconcile('card_test_1')).toMatchObject({ settledMinor: 200, pendingMinor: 1000, failedCount: 4 });
    expect(spentInWindowMinor(f.ledger, 'USD', monthWindow(now()))).toBe(1200);
    const parsed = await f.client.listTransactions({ card_id: 'card_test_1' });
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.items[0]).toMatchObject({ transaction_id: 'transaction_test_01', transaction_amount: -10, signedAmount: 10,
      card_transaction_data: { card_transaction_id: 'card_transaction_test_01' },
      merchant: { extra: { identifier: '000000', additional_merchant_info: { merchant_category: 'Synthetic services' } } } });
    const auths = f.ledger.read().flatMap(({ event }) => event.kind === 'authorization' ? [event] : []);
    expect(auths.filter(event => event.transactionId === 'card_transaction_test_01')).toMatchObject([
      { source: 'simulated', mapped: 'approved', amount: '10.00' },
      { source: 'observed', mapped: 'approved', amount: '10', processResult: 'PENDING' },
    ]);
    expect(auths.find(event => event.transactionId === 'card_transaction_test_credit')).toMatchObject({ amount: '-3' });
    await f.loop.reconcile('card_test_1');
    expect(spentInWindowMinor(f.ledger, 'USD', monthWindow(now()))).toBe(1200);
    expect(f.ledger.read().filter(({ event }) => event.kind === 'authorization')).toHaveLength(auths.length);
    expect(verifyChain(f.ledger.read()).ok).toBe(true);
  });

  it.each([
    { card_transaction_data: { card_transaction_id: 'nested_test' }, card_transaction_id: 'top_test', expected: 'nested_test' },
    { card_transaction_id: 'top_test', expected: 'top_test' },
    { expected: 'transaction_test_fallback' },
  ])('uses ID precedence and retains the listing ID for legacy responses: $expected', async ({ expected, ...ids }) => {
    const f = await setup(); await f.grant();
    const transaction = transactionSchema.parse({ transaction_id: 'transaction_test_fallback', ...ids,
      card_id: 'card_test_1', transaction_amount: -10, transaction_currency: 'USD', status: 'PENDING' });
    f.loop.observe(transaction); f.loop.observe(transaction);
    expect(f.ledger.read().filter(({ event }) => event.kind === 'authorization').map(({ event }) => event))
      .toMatchObject([{ source: 'observed', transactionId: expected, amount: '10' }]);
  });
});

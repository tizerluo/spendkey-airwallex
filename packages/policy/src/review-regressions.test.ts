import { describe, expect, expectTypeOf, it } from 'vitest';
import { compareOffers, toCandidate } from '@sk/compare';
import type { Candidate as CompareCandidate } from '@sk/compare';
import { candidateSchema, decidePurchase } from './index.js';
import type { Candidate as PolicyCandidate } from './index.js';
import { candidate, context } from './test-fixtures.js';

const usageOffer = {
  id: 'offer_test_usage', vendor: 'Test Vendor', product: 'Test Usage Product',
  sourceId: 'curated', rail: 'card', plan: 'usage',
  price: { amount: '0.001', currency: 'USD', unit: 'per_call' },
  category: 'test-api', cancellation: 'Cancel anytime', capturedAt: '2030-01-01T00:00:00Z',
  commitmentMonths: 0, priceStatus: 'price_unverified', availability: 'available',
} satisfies Parameters<typeof toCandidate>[0];

describe('M2 compare and policy contract', () => {
  it('rejects an x402 snapshot relabelled as a card candidate', () => {
    const disguised = candidate({ sourceId: 'x402-snapshot', rail: 'card' });
    expect(() => candidateSchema.parse(disguised)).toThrow('rail_not_card');
    expect(candidateSchema.parse({ ...disguised, rail: 'x402' }).rail).toBe('x402');
  });

  it('keeps the public Candidate types identical', () => {
    expectTypeOf<CompareCandidate>().toEqualTypeOf<PolicyCandidate>();
  });

  it.each(['per_call', 'per_1k_units'] as const)('refuses %s usage without the matching usage profile', unit => {
    const unknown = toCandidate({ ...usageOffer, price: { ...usageOffer.price, unit } }, { horizonMonths: 12 });
    expect(candidateSchema.parse(unknown)).toEqual(unknown);
    const decision = decidePurchase([unknown], context());
    expect(decision.action).toBe('refuse');
    expect(decision).not.toHaveProperty('chosen');
    expect(decision.reasons).toContain('zero_charge_unknown_cost');
  });

  it('chooses a priced candidate over an unknown usage offer throughout compare and policy', () => {
    const pricedOffer = { ...usageOffer, id: 'offer_test_priced', plan: 'monthly',
      price: { amount: '50.00', currency: 'USD', unit: 'per_month' },
    } satisfies Parameters<typeof toCandidate>[0];
    const { candidates } = compareOffers([usageOffer, pricedOffer], { horizonMonths: 12 });
    expect(candidates.map(candidate => candidate.offerId)).toEqual([pricedOffer.id, usageOffer.id]);
    // Policy also refuses unknown usage when it arrives first, without relying on compare's order.
    const decision = decidePurchase([...candidates].reverse(), context());
    expect(decision).toMatchObject({ action: 'ask', chosen: { offerId: pricedOffer.id } });
    expect(decision.ranked.find(entry => entry.candidate.offerId === usageOffer.id)).toMatchObject({
      passed: false, results: expect.arrayContaining([expect.objectContaining({ code: 'zero_charge_unknown_cost', pass: false })]),
    });
  });

  it('refuses ambiguous balances through a rule result instead of throwing', () => {
    const decision = decidePurchase([candidate()], context({ balances: [
      { currency: 'USD', available_amount: '1000.00' },
      { currency: 'USD', available_amount: '1000.00' },
    ] }));
    expect(decision.action).toBe('refuse');
    expect(decision).not.toHaveProperty('chosen');
    expect(decision.reasons).toEqual(['reserve_ambiguous_balance']);
  });

  it('ranks only budget-currency candidates and explains foreign exclusions in input order', () => {
    const eur = candidate({ offerId: 'offer_test_eur', currency: 'EUR', upfrontMinor: 0, perChargeMinor: 2,
      horizonCost: { lowMinor: 2, highMinor: 2 } });
    const gbp = candidate({ offerId: 'offer_test_gbp', currency: 'GBP', upfrontMinor: 0, perChargeMinor: 1,
      horizonCost: { lowMinor: 1, highMinor: 1 } });
    const usd = candidate();
    const ctx = context({ balances: [
      { currency: 'USD', available_amount: '1000.00' }, { currency: 'EUR', available_amount: '1000.00' },
      { currency: 'GBP', available_amount: '1000.00' },
    ], reserveFloorMinor: { USD: 50000, EUR: 0, GBP: 0 } });
    const decision = decidePurchase([eur, usd, gbp], ctx);
    expect(decision).toMatchObject({ action: 'ask', chosen: usd });
    expect(decision.ranked.map(entry => entry.candidate.offerId)).toEqual([usd.offerId, eur.offerId, gbp.offerId]);
    for (const entry of decision.ranked.slice(1)) {
      expect(entry).toMatchObject({ passed: false, results: [{ pass: false, code: 'currency_not_budgeted' }] });
    }
    expect(decision.reasons).toContain('currency_not_budgeted');
    const refused = decidePurchase([eur, gbp], ctx);
    expect(refused).toMatchObject({ action: 'refuse', reasons: ['currency_not_budgeted'] });
    expect(refused).not.toHaveProperty('chosen');
  });
});

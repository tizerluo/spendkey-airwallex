import { describe, expect, it } from 'vitest';
import { decidePurchase } from './index.js';
import { candidate, context } from './test-fixtures.js';

describe('card purchase decision', () => {
  it('can only ask for human approval when rules pass', () => {
    const input = candidate();
    const decision = decidePurchase([input], context());
    expect(decision).toMatchObject({ action: 'ask', chosen: input, reasons: ['human_approval_required'] });
    expect(decision.ranked[0]?.results).toHaveLength(4);
    expect(decision.ranked[0]?.passed).toBe(true);
  });
  it('refuses with every distinct failing code when nothing passes', () => {
    const decision = decidePurchase([candidate({ upfrontMinor: 60000, perChargeMinor: 100001, commitmentMonths: 13, availability: 'region_unavailable' })], context());
    expect(decision.action).toBe('refuse');
    expect(decision).not.toHaveProperty('chosen');
    expect(decision.reasons).toEqual(['reserve_breach', 'budget_exceeded', 'commitment_too_long', 'region_unavailable']);
    expect(decidePurchase([], context())).toEqual({ action: 'refuse', ranked: [], reasons: [] });
  });
  it('ranks passing candidates by high horizon cost, then upfront; ignores a cheaper failed offer', () => {
    const expensive = candidate({ offerId: 'expensive', horizonCost: { lowMinor: 1, highMinor: 8000 } });
    const cheap = candidate({ offerId: 'cheap', horizonCost: { lowMinor: 7000, highMinor: 7000 } });
    const winner = candidate({ ...cheap, offerId: 'winner', upfrontMinor: 4000 });
    const failed = candidate({ offerId: 'failed', availability: 'region_unavailable', horizonCost: { lowMinor: 0, highMinor: 0 } });
    const inputs = [expensive, cheap, failed, winner];
    const decision = decidePurchase(inputs, context());
    expect(decision.chosen?.offerId).toBe('winner');
    expect(decision.ranked.map(entry => entry.candidate.offerId)).toEqual(['winner', 'cheap', 'expensive', 'failed']);
    expect(inputs.map(input => input.offerId)).toEqual(['expensive', 'cheap', 'failed', 'winner']);
  });
  it('official demo: annual is cheaper overall but breaches reserves; monthly passes', () => {
    const annual = candidate({ offerId: 'offer_test_annual', plan: 'annual', commitmentMonths: 12,
      upfrontMinor: 48000, perChargeMinor: 48000,
      horizonCost: { lowMinor: 48000, highMinor: 48000 }, monthlyRunRateMinor: { lowMinor: 4000, highMinor: 4000 } });
    const monthly = candidate();
    const decision = decidePurchase([annual, monthly], context());
    expect(annual.horizonCost.highMinor).toBeLessThan(monthly.horizonCost.highMinor);
    expect(decision).toMatchObject({ action: 'ask', chosen: monthly });
    const annualResult = decision.ranked.find(entry => entry.candidate.offerId === annual.offerId);
    expect(annualResult?.results.filter(result => !result.pass).map(result => result.code)).toEqual(['reserve_breach']);
    expect(decidePurchase([annual], context()).action).toBe('refuse');
  });
  it('allows unverified prices and absent MCC with explicit reasons', () => {
    const input = candidate({ priceStatus: 'price_unverified', sourceId: 'x402-snapshot', notes: ['price_unverified: no savings claim'] });
    delete input.merchantCategoryCode;
    expect(decidePurchase([input], context())).toMatchObject({ action: 'ask', chosen: input,
      reasons: ['human_approval_required', 'price_unverified', 'mcc_required_at_approval'] });
  });
});

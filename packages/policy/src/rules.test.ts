import { describe, expect, it } from 'vitest';
import { commitmentCap, evaluateRules, region, reserveFloor, windowBudget } from './index.js';
import { candidate, context } from './test-fixtures.js';

describe('reserve_floor', () => {
  it('passes at the exact floor, with decimal string and number balances', () => {
    for (const available_amount of ['650.00', 650]) {
      expect(reserveFloor(candidate(), context({ balances: [{ currency: 'USD', available_amount }] })))
        .toMatchObject({ rule: 'reserve_floor', pass: true, code: 'reserve_ok' });
    }
  });
  it('fails one cent below the floor', () => {
    expect(reserveFloor(candidate(), context({ balances: [{ currency: 'USD', available_amount: '649.99' }] })))
      .toMatchObject({ pass: false, code: 'reserve_breach' });
  });
  it('fails for missing currency even when another balance is large', () => {
    expect(reserveFloor(candidate({ currency: 'EUR' }), context()))
      .toMatchObject({ pass: false, code: 'reserve_unknown_currency' });
    expect(reserveFloor(candidate(), context({ reserveFloorMinor: {} }))).toMatchObject({ code: 'reserve_unknown_currency' });
  });
  it('includes today and the last horizon day, excludes other currencies and later obligations', () => {
    const ctx = context({ balances: [{ currency: 'USD', available_amount: '650' }], knownObligations: [
      { currency: 'USD', amountMinor: 4_000, dueInDays: 0 },
      { currency: 'USD', amountMinor: 6_000, dueInDays: 30 },
      { currency: 'USD', amountMinor: 99_000, dueInDays: 31 },
      { currency: 'EUR', amountMinor: 99_000, dueInDays: 1 },
    ] });
    expect(reserveFloor(candidate(), ctx).code).toBe('reserve_ok');
    expect(reserveFloor(candidate({ upfrontMinor: 5001 }), ctx).code).toBe('reserve_breach');
  });
  it('treats overdue obligations as due now, including with a zero-day horizon', () => {
    const ctx = context({ balances: [{ currency: 'USD', available_amount: '650' }], reserveHorizonDays: 0,
      knownObligations: [{ currency: 'USD', amountMinor: 10_001, dueInDays: -1 }] });
    expect(reserveFloor(candidate(), ctx)).toMatchObject({ pass: false, code: 'reserve_breach' });
    expect(reserveFloor(candidate(), { ...ctx, knownObligations: [] }).pass).toBe(true);
  });
  it.each([NaN, Infinity, 'NaN', '1.005', '90071992547409.92'])('rejects invalid balance %s', available_amount => {
    expect(() => reserveFloor(candidate(), context({ balances: [{ currency: 'USD', available_amount }] }))).toThrow();
  });
  it('fails closed for duplicate balances, even without a reserve floor', () => {
    const balances = [
      { currency: 'USD', available_amount: '1000' }, { currency: 'USD', available_amount: '1000' },
    ];
    expect(reserveFloor(candidate(), context({ balances }))).toMatchObject({
      rule: 'reserve_floor', pass: false, code: 'reserve_ambiguous_balance',
    });
    expect(reserveFloor(candidate(), context({ balances, reserveFloorMinor: {} })).code).toBe('reserve_ambiguous_balance');
  });
  it('rejects unsafe obligation totals', () => {
    expect(() => reserveFloor(candidate(), context({ knownObligations: [
      { currency: 'USD', amountMinor: Number.MAX_SAFE_INTEGER, dueInDays: 1 },
      { currency: 'USD', amountMinor: 1, dueInDays: 1 },
    ] }))).toThrow('invalid_minor_amount');
  });
});

describe('window_budget', () => {
  it('passes at the exact budget using the largest charge rather than upfront', () => {
    expect(windowBudget(candidate({ upfrontMinor: 0, perChargeMinor: 5000 }), context({ spentInWindowMinor: 5000, windowBudgetMinor: 10000 })))
      .toMatchObject({ rule: 'window_budget', pass: true, code: 'budget_ok' });
  });
  it('fails over budget, including already excessive spending', () => {
    expect(windowBudget(candidate(), context({ spentInWindowMinor: 95001 }))).toMatchObject({ pass: false, code: 'budget_exceeded' });
    expect(windowBudget(candidate({ perChargeMinor: 1 }), context({ spentInWindowMinor: 100001 }))).toMatchObject({ code: 'budget_exceeded' });
  });
  it('fails closed for zero charges, without relying on a usage note', () => {
    expect(windowBudget(candidate({ plan: 'usage', perChargeMinor: 0, notes: [] }), context()))
      .toMatchObject({ rule: 'window_budget', pass: false, code: 'zero_charge_unknown_cost' });
  });
  it('fails a currency mismatch without converting money', () => {
    expect(windowBudget(candidate({ currency: 'EUR' }), context())).toMatchObject({ pass: false, code: 'budget_currency_mismatch' });
  });
  it('handles safe-integer boundaries without summing beyond them', () => {
    expect(windowBudget(candidate({ perChargeMinor: 1 }), context({ spentInWindowMinor: Number.MAX_SAFE_INTEGER, windowBudgetMinor: Number.MAX_SAFE_INTEGER })).code).toBe('budget_exceeded');
  });
});

describe('commitment_cap and region', () => {
  it('passes at the maximum commitment and fails above it', () => {
    expect(commitmentCap(candidate({ commitmentMonths: 12 }), context())).toMatchObject({ rule: 'commitment_cap', pass: true, code: 'commitment_ok' });
    expect(commitmentCap(candidate({ commitmentMonths: 13 }), context())).toMatchObject({ pass: false, code: 'commitment_too_long' });
  });
  it('uses resolved availability for billing/card countries', () => {
    expect(region(candidate(), context({ billingCountry: 'GB', cardCountry: 'US' }))).toMatchObject({ rule: 'region', pass: true, code: 'region_ok' });
    expect(region(candidate({ availability: 'region_unavailable' }), context())).toMatchObject({ pass: false, code: 'region_unavailable' });
  });
  it('returns all four failures without short-circuiting or mutating inputs', () => {
    const input = candidate({ currency: 'EUR', commitmentMonths: 13, availability: 'region_unavailable' });
    const ctx = context();
    const before = structuredClone({ input, ctx });
    expect(evaluateRules(input, ctx).map(result => result.code)).toEqual([
      'reserve_unknown_currency', 'budget_currency_mismatch', 'commitment_too_long', 'region_unavailable',
    ]);
    expect({ input, ctx }).toEqual(before);
  });
  it('rejects invalid candidate amounts instead of asking for approval', () => {
    expect(() => evaluateRules(candidate({ perChargeMinor: NaN }), context())).toThrow();
  });
});

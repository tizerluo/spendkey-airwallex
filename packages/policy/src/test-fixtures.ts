import type { Candidate, PolicyContext } from './index.js';

// Shared synthetic test data, intentionally not an offer-source dependency.
export function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    offerId: 'offer_test_monthly', vendor: 'Test Vendor', product: 'Test Product', sourceId: 'curated',
    plan: 'monthly', currency: 'USD', merchantCategoryCode: '5734', commitmentMonths: 1,
    priceStatus: 'verified', availability: 'available', upfrontMinor: 5_000, perChargeMinor: 5_000,
    horizonCost: { lowMinor: 60_000, highMinor: 60_000 },
    monthlyRunRateMinor: { lowMinor: 5_000, highMinor: 5_000 }, notes: [], ...overrides,
  };
}
export function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    balances: [{ currency: 'USD', available_amount: '1000.00' }],
    knownObligations: [{ currency: 'USD', amountMinor: 10_000, dueInDays: 15 }],
    reserveHorizonDays: 30, reserveFloorMinor: { USD: 50_000 },
    budgetCurrency: 'USD', spentInWindowMinor: 0, windowBudgetMinor: 100_000,
    maxCommitmentMonths: 12, billingCountry: 'US', cardCountry: 'US', ...overrides,
  };
}

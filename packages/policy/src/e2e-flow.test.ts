import { cardRequestIdFromApproval, createCardInputSchema } from '@sk/airwallex';
import type { Candidate as CompareCandidate } from '@sk/compare';
import type { Offer } from '@sk/offers';
import { describe, expect, it } from 'vitest';
import {
  ApprovalError,
  approvalToCardInput,
  approve,
  createApprovalRequest,
  decimalToMinor,
  decidePurchase,
  minorToDecimal,
  termsHash,
  type Approval,
  type CardInputOptions,
  type PolicyContext,
} from './index.js';

type CompareUsage = {
  horizonMonths: number;
  seats?: number;
  callsPerMonth?: { low: number; high: number };
  unitsPerMonth?: { low: number; high: number };
};

interface CompareModule {
  compareOffers(
    offers: readonly Offer[],
    usage: CompareUsage,
  ): {
    candidates: CompareCandidate[];
    excluded: { offerId: string; reason: string }[];
  };
}

interface OffersModule {
  createCuratedSource(data?: readonly Offer[]): {
    listOffers(query: {
      intent: string;
      billingCountry?: string;
      cardCountry?: string;
    }): Promise<Offer[]>;
  };
  createX402SnapshotSource(): {
    listOffers(query: { intent: string }): Promise<Offer[]>;
  };
}

// Resolve the workspace sources directly so this offline flow test also runs
// before sibling packages are built; the type-only imports still check contracts.
async function loadSources(): Promise<{ compare: CompareModule; offers: OffersModule }> {
  const [compare, offers] = await Promise.all([
    import(new URL('../../compare/src/index.ts', import.meta.url).href) as Promise<CompareModule>,
    import(new URL('../../offers/src/index.ts', import.meta.url).href) as Promise<OffersModule>,
  ]);
  return { compare, offers };
}

const TIMES = {
  approvalRequestId: 'approval_request_e2e_01',
  createdAt: '2030-01-01T00:00:00Z',
  expiresAt: '2030-01-01T01:00:00Z',
} as const;
const HUMAN = { kind: 'human', id: 'human_e2e_01' } as const;
const CARD_OPTIONS: CardInputOptions = {
  cardholderId: 'cardholder_test_01',
  createdBy: 'human_e2e_01',
};
const DESIGN_USAGE: CompareUsage = { horizonMonths: 12, seats: 5 };

function flowContext(availableAmount: string): PolicyContext {
  return {
    balances: [{ currency: 'USD', available_amount: availableAmount }],
    knownObligations: [{ currency: 'USD', amountMinor: 10_000, dueInDays: 30 }],
    reserveHorizonDays: 30,
    reserveFloorMinor: { USD: 50_000 },
    budgetCurrency: 'USD',
    spentInWindowMinor: 0,
    windowBudgetMinor: 100_000,
    maxCommitmentMonths: 12,
    billingCountry: 'US',
    cardCountry: 'US',
  };
}

function byPlan(
  candidates: readonly CompareCandidate[],
  plan: CompareCandidate['plan'],
): CompareCandidate {
  const found = candidates.find((candidate) => candidate.plan === plan);
  if (!found) throw new Error(`missing ${plan} candidate`);
  return found;
}

function expectApprovalCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ApprovalError);
    expect(error).toMatchObject({ code });
    return;
  }
  expect.fail(`Expected ApprovalError ${code}`);
}

describe('offline e2e: curated DesignCo monthly versus annual', () => {
  it('asks for the monthly plan and maps the approved terms to an Airwallex card', async () => {
    const { compare, offers: offerSource } = await loadSources();
    const offers = await offerSource
      .createCuratedSource()
      .listOffers({ intent: 'designco', billingCountry: 'US', cardCountry: 'US' });
    expect(offers.map((offer) => offer.plan).sort()).toEqual(['annual', 'monthly']);

    const compared = compare.compareOffers(offers, DESIGN_USAGE);
    expect(compared.excluded).toEqual([]);
    const annual = byPlan(compared.candidates, 'annual');
    const monthly = byPlan(compared.candidates, 'monthly');
    expect(annual).toMatchObject({
      offerId: 'curated-designco-team-annual',
      currency: 'USD',
      merchantCategoryCode: '7372',
      commitmentMonths: 12,
      priceStatus: 'price_unverified',
      upfrontMinor: 60000,
      perChargeMinor: 60000,
      horizonCost: { lowMinor: 60000, highMinor: 60000 },
    });
    expect(monthly).toMatchObject({
      offerId: 'curated-designco-team-monthly',
      currency: 'USD',
      merchantCategoryCode: '7372',
      commitmentMonths: 0,
      priceStatus: 'price_unverified',
      upfrontMinor: 6000,
      perChargeMinor: 6000,
      horizonCost: { lowMinor: 72000, highMinor: 72000 },
    });
    expect(annual.horizonCost.highMinor).toBeLessThan(monthly.horizonCost.highMinor);

    const decision = decidePurchase(
      compared.candidates,
      flowContext('660.00'),
    );
    expect(decision.action).toBe('ask');
    expect(decision.chosen?.offerId).toBe('curated-designco-team-monthly');
    expect(decision.reasons).toEqual(['human_approval_required', 'price_unverified']);

    const annualEntry = decision.ranked.find(
      (entry) => entry.candidate.offerId === annual.offerId,
    );
    expect(annualEntry?.passed).toBe(false);
    expect(
      annualEntry?.results.filter((result) => !result.pass).map((result) => result.code),
    ).toEqual(['reserve_breach']);
    const monthlyEntry = decision.ranked.find(
      (entry) => entry.candidate.offerId === monthly.offerId,
    );
    expect(monthlyEntry?.passed).toBe(true);
    expect(monthlyEntry?.results.every((result) => result.pass)).toBe(true);

    const chosen = decision.chosen;
    if (!chosen) throw new Error('expected a chosen monthly candidate');
    const request = createApprovalRequest(chosen, TIMES);
    expect(request).toEqual({
      ...TIMES,
      offerId: 'curated-designco-team-monthly',
      vendor: 'DesignCo',
      product: 'Team plan',
      plan: 'monthly',
      rail: 'card',
      currency: 'USD',
      amountMinor: 6000,
      interval: 'MONTHLY',
      allowedTransactionCount: 'MULTIPLE',
      merchantCategoryCode: '7372',
      commitmentMonths: 0,
      priceStatus: 'price_unverified',
    });

    const presentedTermsHash = termsHash(request);
    const approval = approve(request, {
      approver: HUMAN,
      presentedTermsHash,
      now: '2030-01-01T00:30:00Z',
    });
    expect(approval.termsHash).toBe(presentedTermsHash);
    expect(approval.approvedBy).toEqual(HUMAN);
    expect(approval.request).toEqual(request);

    const body = approvalToCardInput(approval, CARD_OPTIONS);
    expect(body).toEqual({
      request_id: cardRequestIdFromApproval(approval.approvalId),
      cardholder_id: 'cardholder_test_01',
      created_by: 'human_e2e_01',
      form_factor: 'VIRTUAL',
      is_personalized: true,
      program: { purpose: 'COMMERCIAL' },
      nick_name: 'Team plan',
      authorization_controls: {
        allowed_transaction_count: 'MULTIPLE',
        allowed_currencies: ['USD'],
        allowed_merchant_categories: ['7372'],
        transaction_limits: {
          currency: 'USD',
          limits: [{ amount: 60, interval: 'MONTHLY' }],
        },
      },
    });

    expect(body.request_id).toMatch(/^spk_[0-9a-f]{40}$/);
    expect(body.request_id.length).toBeLessThanOrEqual(50);
    expect(approvalToCardInput(approval, CARD_OPTIONS).request_id).toBe(body.request_id);
    expect(body.authorization_controls.allowed_currencies).toEqual([
      body.authorization_controls.transaction_limits.currency,
    ]);
    expect(body.authorization_controls.allowed_merchant_categories).toEqual(['7372']);
    expect(body.authorization_controls.allowed_transaction_count).toBe('MULTIPLE');
    const limit = body.authorization_controls.transaction_limits.limits[0];
    expect(limit?.amount).toBe(Number(minorToDecimal(approval.request.amountMinor)));
    expect(decimalToMinor(limit?.amount ?? 0)).toBe(approval.request.amountMinor);
    expect(createCardInputSchema.parse(body)).toEqual(body);

    await expect(fetch('https://example.com/offline-check')).rejects.toThrow(
      'Network access is disabled',
    );
  });

  it('fails both plans one cent below the reserve floor and refuses', async () => {
    const { compare, offers: offerSource } = await loadSources();
    const offers = await offerSource
      .createCuratedSource()
      .listOffers({ intent: 'designco', billingCountry: 'US', cardCountry: 'US' });
    const compared = compare.compareOffers(offers, DESIGN_USAGE);

    const decision = decidePurchase(
      compared.candidates,
      flowContext('659.99'),
    );
    expect(decision.action).toBe('refuse');
    expect(decision).not.toHaveProperty('chosen');
    expect(decision.reasons).toEqual(['reserve_breach']);
    for (const entry of decision.ranked) {
      expect(entry.passed).toBe(false);
      expect(
        entry.results.filter((result) => !result.pass).map((result) => result.code),
      ).toEqual(['reserve_breach']);
    }
  });

  it('rejects the annual terms hash and any raised limit for the monthly approval', async () => {
    const { compare, offers: offerSource } = await loadSources();
    const offers = await offerSource
      .createCuratedSource()
      .listOffers({ intent: 'designco', billingCountry: 'US', cardCountry: 'US' });
    const compared = compare.compareOffers(offers, DESIGN_USAGE);
    const decision = decidePurchase(
      compared.candidates,
      flowContext('660.00'),
    );
    const chosen = decision.chosen;
    if (!chosen) throw new Error('expected a chosen monthly candidate');

    const annualRequest = createApprovalRequest(
      byPlan(compared.candidates, 'annual'),
      TIMES,
    );
    const monthlyRequest = createApprovalRequest(chosen, TIMES);
    expect(termsHash(annualRequest)).not.toBe(termsHash(monthlyRequest));
    expectApprovalCode(
      () =>
        approve(monthlyRequest, {
          approver: HUMAN,
          presentedTermsHash: termsHash(annualRequest),
          now: '2030-01-01T00:30:00Z',
        }),
      'terms_mismatch',
    );

    const approval = approve(monthlyRequest, {
      approver: HUMAN,
      presentedTermsHash: termsHash(monthlyRequest),
      now: '2030-01-01T00:30:00Z',
    });
    const raised: Approval = {
      ...approval,
      request: { ...approval.request, amountMinor: 6001 },
    };
    expectApprovalCode(
      () => approvalToCardInput(raised, CARD_OPTIONS),
      'terms_mismatch',
    );

    const optionsWithAmount = { ...CARD_OPTIONS, amountMinor: 999_999 };
    const body = approvalToCardInput(approval, optionsWithAmount);
    expect(body.authorization_controls.transaction_limits.limits[0]?.amount).toBe(60);
  });

  it('refuses an x402 offer without MCC at the card rail boundary', async () => {
    const { compare, offers: offerSource } = await loadSources();
    const offers = await offerSource
      .createX402SnapshotSource()
      .listOffers({ intent: 'weather' });
    expect(offers).toHaveLength(1);

    const compared = compare.compareOffers(offers, {
      horizonMonths: 12,
      callsPerMonth: { low: 1000, high: 2000 },
    });
    expect(compared.excluded).toEqual([]);
    const [usage] = compared.candidates;
    if (!usage) throw new Error('missing weather candidate');
    expect(usage).toMatchObject({
      plan: 'usage',
      sourceId: 'x402-snapshot',
      rail: 'x402',
      currency: 'USD',
      priceStatus: 'price_unverified',
      upfrontMinor: 0,
      perChargeMinor: 200,
      horizonCost: { lowMinor: 1200, highMinor: 2400 },
      monthlyRunRateMinor: { lowMinor: 100, highMinor: 200 },
    });
    expect(usage.merchantCategoryCode).toBeUndefined();

    const decision = decidePurchase([usage], flowContext('660.00'));
    expect(decision).toMatchObject({ action: 'refuse', reasons: ['rail_not_card'] });
    expect(decision).not.toHaveProperty('chosen');
    expect(decision.ranked).toMatchObject([
      { candidate: usage, passed: false, results: [{ pass: false, code: 'rail_not_card' }] },
    ]);
    expectApprovalCode(() => createApprovalRequest(usage, TIMES), 'rail_not_card');
  });

  it('requires explicit human MCC entry for a curated card offer without MCC', async () => {
    const { compare, offers: offerSource } = await loadSources();
    const synthetic: Offer = {
      id: 'curated_test_usage_no_mcc', sourceId: 'curated', rail: 'card',
      vendor: 'Test Usage Vendor', product: 'Test Usage API', plan: 'usage', category: 'test-api',
      price: { amount: '0.001', currency: 'USD', unit: 'per_call' },
      commitmentMonths: 0, cancellation: 'Pay per call', priceStatus: 'price_unverified',
      availability: 'available', capturedAt: '2030-01-01T00:00:00Z',
    };
    const offers = await offerSource.createCuratedSource([synthetic]).listOffers({ intent: 'test usage' });
    const { candidates } = compare.compareOffers(offers, {
      horizonMonths: 12, callsPerMonth: { low: 1000, high: 2000 },
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ sourceId: 'curated', rail: 'card', perChargeMinor: 200 });
    const decision = decidePurchase(candidates, flowContext('660.00'));
    expect(decision.action).toBe('ask');
    expect(decision.reasons).toEqual([
      'human_approval_required',
      'price_unverified',
      'mcc_required_at_approval',
    ]);
    const chosen = decision.chosen;
    if (!chosen) throw new Error('missing chosen usage candidate');

    const request = createApprovalRequest(chosen, TIMES);
    expect(request.merchantCategoryCode).toBeUndefined();
    expectApprovalCode(
      () =>
        approve(request, {
          approver: HUMAN,
          presentedTermsHash: termsHash(request),
          now: '2030-01-01T00:30:00Z',
        }),
      'mcc_required',
    );

    const approval = approve(request, {
      approver: HUMAN,
      presentedTermsHash: termsHash(request),
      merchantCategoryCode: '5817',
      now: '2030-01-01T00:30:00Z',
    });
    const body = approvalToCardInput(approval, CARD_OPTIONS);
    expect(body.authorization_controls).toEqual({
      allowed_transaction_count: 'MULTIPLE',
      allowed_currencies: ['USD'],
      allowed_merchant_categories: ['5817'],
      transaction_limits: {
        currency: 'USD',
        limits: [{ amount: 2, interval: 'MONTHLY' }],
      },
    });
    expect(body.authorization_controls.allowed_currencies).toEqual([
      body.authorization_controls.transaction_limits.currency,
    ]);
    expect(body.request_id).toBe(cardRequestIdFromApproval(approval.approvalId));
    expect(body.request_id.length).toBeLessThanOrEqual(50);
  });
});

import { createHash } from 'node:crypto';
import { cardRequestIdFromApproval, createCardInputSchema } from '@sk/airwallex';
import { describe, expect, it } from 'vitest';
import {
  ApprovalError,
  addMinor,
  approvalToCardInput,
  approve,
  assertControlsCurrency,
  assertMinorAmount,
  commitmentCap,
  createApprovalRequest,
  decimalToMinor,
  decidePurchase,
  evaluateRules,
  minorToDecimal,
  region,
  reserveFloor,
  termsHash,
  windowBudget,
  type Approval,
  type ApprovalRequest,
  type ApproveOptions,
  type Candidate,
  type CardInputOptions,
  type RuleResult,
} from './index.js';
import { candidate, context } from './test-fixtures.js';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const TIMES = {
  approvalRequestId: 'approval_request_independent_01',
  createdAt: '2030-01-01T00:00:00Z',
  expiresAt: '2030-01-01T01:00:00Z',
} as const;
const HUMAN: ApproveOptions['approver'] = { kind: 'human', id: 'human_independent_01' };
const CARD_OPTIONS: CardInputOptions = {
  cardholderId: 'cardholder_test_01',
  createdBy: 'human_independent_01',
  nickName: 'independent-purchase',
};

type BindingChange = {
  label: string;
  change: (request: ApprovalRequest) => ApprovalRequest;
};

const BINDING_CHANGES: BindingChange[] = [
  { label: 'offerId', change: (request) => ({ ...request, offerId: 'offer_test_other' }) },
  { label: 'vendor', change: (request) => ({ ...request, vendor: 'Other Test Vendor' }) },
  { label: 'plan', change: (request) => ({ ...request, plan: 'annual' }) },
  { label: 'currency', change: (request) => ({ ...request, currency: 'EUR' }) },
  {
    label: 'amountMinor',
    change: (request) => ({ ...request, amountMinor: request.amountMinor + 1 }),
  },
  { label: 'interval', change: (request) => ({ ...request, interval: 'PER_TRANSACTION' }) },
  {
    label: 'allowedTransactionCount',
    change: (request) => ({ ...request, allowedTransactionCount: 'SINGLE' }),
  },
  {
    label: 'merchantCategoryCode',
    change: (request) => ({ ...request, merchantCategoryCode: '5817' }),
  },
  {
    label: 'commitmentMonths',
    change: (request) => ({ ...request, commitmentMonths: request.commitmentMonths + 1 }),
  },
  {
    label: 'expiresAt',
    change: (request) => ({ ...request, expiresAt: '2030-01-01T02:00:00Z' }),
  },
];

function requestFor(input: Candidate = candidate()): ApprovalRequest {
  return createApprovalRequest(input, TIMES);
}

function approveWith(input: ApprovalRequest, overrides: Partial<ApproveOptions> = {}): Approval {
  return approve(input, {
    approver: HUMAN,
    presentedTermsHash: termsHash(input),
    now: '2030-01-01T00:30:00Z',
    ...overrides,
  });
}

function approved(overrides: Partial<Candidate> = {}): Approval {
  return approveWith(requestFor(candidate(overrides)));
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

function codes(results: readonly RuleResult[]): string[] {
  return results.map((result) => result.code);
}

describe('independent: strict money boundaries', () => {
  it('parses exact cents and the maximum safe amount', () => {
    expect(decimalToMinor('0')).toBe(0);
    expect(decimalToMinor('000.07')).toBe(7);
    expect(decimalToMinor('12.3')).toBe(1230);
    expect(decimalToMinor(0.07)).toBe(7);
    expect(decimalToMinor(7)).toBe(700);
    expect(decimalToMinor('90071992547409.91')).toBe(MAX_SAFE);
  });

  it.each(['1.234', '0.001', '10.000', '90071992547409.911'])(
    'refuses more than two decimals: %s',
    (value) => {
      expect(() => decimalToMinor(value)).toThrow(RangeError);
    },
  );

  it.each([
    '90071992547409.92',
    '9007199254740991',
    '99999999999999999',
    -1,
    '-1',
    '1e2',
    ' 1',
    '1 ',
    '',
  ])('refuses negative, unsafe or non-decimal input: %j', (value) => {
    expect(() => decimalToMinor(value)).toThrow(RangeError);
  });

  it('renders and adds exact cents without floating point', () => {
    expect(minorToDecimal(1)).toBe('0.01');
    expect(minorToDecimal(10)).toBe('0.10');
    expect(minorToDecimal(1010)).toBe('10.10');
    expect(minorToDecimal(MAX_SAFE)).toBe('90071992547409.91');
    expect(addMinor(0, 1)).toBe(1);
    expect(addMinor(5000, 5000)).toBe(10000);
    expect(() => addMinor(MAX_SAFE, 1)).toThrow(RangeError);
  });

  it('refuses unsafe or fractional minor amounts', () => {
    expect(assertMinorAmount(0)).toBe(0);
    expect(assertMinorAmount(MAX_SAFE)).toBe(MAX_SAFE);
    for (const value of [-1, 1.5, Number.NaN, MAX_SAFE + 1]) {
      expect(() => assertMinorAmount(value)).toThrow(RangeError);
    }
  });
});

describe('independent: reserve_floor boundaries', () => {
  it('passes exactly at the floor and fails one minor unit below it', () => {
    const exact = context({
      balances: [{ currency: 'USD', available_amount: '600.00' }],
      knownObligations: [],
      reserveFloorMinor: { USD: 55000 },
    });
    expect(reserveFloor(candidate({ upfrontMinor: 5000 }), exact)).toMatchObject({
      rule: 'reserve_floor',
      pass: true,
      code: 'reserve_ok',
    });

    const below = context({
      balances: [{ currency: 'USD', available_amount: '599.99' }],
      knownObligations: [],
      reserveFloorMinor: { USD: 55000 },
    });
    expect(reserveFloor(candidate({ upfrontMinor: 5000 }), below)).toMatchObject({
      pass: false,
      code: 'reserve_breach',
    });
  });

  it('includes obligations at both horizon edges in the exact floor boundary', () => {
    const exact = context({
      balances: [{ currency: 'USD', available_amount: '650.00' }],
      knownObligations: [
        { currency: 'USD', amountMinor: 5000, dueInDays: 0 },
        { currency: 'USD', amountMinor: 5000, dueInDays: 30 },
      ],
      reserveHorizonDays: 30,
      reserveFloorMinor: { USD: 50000 },
    });
    expect(reserveFloor(candidate({ upfrontMinor: 5000 }), exact).code).toBe('reserve_ok');

    const over = context({
      ...exact,
      knownObligations: [
        { currency: 'USD', amountMinor: 5000, dueInDays: 0 },
        { currency: 'USD', amountMinor: 5001, dueInDays: 30 },
      ],
    });
    expect(reserveFloor(candidate({ upfrontMinor: 5000 }), over).code).toBe(
      'reserve_breach',
    );
  });

  it('counts overdue obligations while ignoring future and foreign obligations', () => {
    const ctx = context({
      balances: [{ currency: 'USD', available_amount: '600.00' }],
      knownObligations: [
        { currency: 'USD', amountMinor: 50000, dueInDays: 31 },
        { currency: 'USD', amountMinor: 50000, dueInDays: -1 },
        { currency: 'EUR', amountMinor: 50000, dueInDays: 1 },
      ],
      reserveFloorMinor: { USD: 55000 },
    });
    expect(reserveFloor(candidate({ upfrontMinor: 5000 }), ctx)).toMatchObject({
      pass: false, code: 'reserve_breach',
    });
    expect(reserveFloor(candidate({ upfrontMinor: 5000 }), {
      ...ctx, knownObligations: ctx.knownObligations.filter(obligation => obligation.dueInDays !== -1),
    }).code).toBe('reserve_ok');
  });

  it('passes at a zero floor only when available covers the upfront amount', () => {
    const exact = context({
      balances: [{ currency: 'USD', available_amount: '50.00' }],
      knownObligations: [],
      reserveFloorMinor: { USD: 0 },
    });
    expect(reserveFloor(candidate({ upfrontMinor: 5000 }), exact).code).toBe('reserve_ok');

    const below = context({
      balances: [{ currency: 'USD', available_amount: '49.99' }],
      knownObligations: [],
      reserveFloorMinor: { USD: 0 },
    });
    expect(reserveFloor(candidate({ upfrontMinor: 5000 }), below).code).toBe(
      'reserve_breach',
    );
  });

  it('fails closed for a missing balance or floor and rejects ambiguous balances', () => {
    expect(reserveFloor(candidate({ currency: 'EUR' }), context()).code).toBe(
      'reserve_unknown_currency',
    );
    expect(reserveFloor(candidate(), context({ reserveFloorMinor: {} })).code).toBe(
      'reserve_unknown_currency',
    );
    expect(
      reserveFloor(
        candidate(),
        context({
          balances: [
            { currency: 'USD', available_amount: '100.00' },
            { currency: 'USD', available_amount: '100.00' },
          ],
        }),
      ),
    ).toMatchObject({ pass: false, code: 'reserve_ambiguous_balance' });
  });

  it('rejects more than two decimal places in a balance instead of rounding it', () => {
    for (const available_amount of ['100.001', '-1', 'NaN']) {
      expect(() =>
        reserveFloor(
          candidate(),
          context({ balances: [{ currency: 'USD', available_amount }] }),
        ),
      ).toThrow();
    }
  });

  it('rejects invalid obligation days and amounts', () => {
    expect(() =>
      reserveFloor(
        candidate(),
        context({ knownObligations: [{ currency: 'USD', amountMinor: 1, dueInDays: 1.5 }] }),
      ),
    ).toThrow('invalid_obligation_due_days');
    expect(() =>
      reserveFloor(
        candidate(),
        context({ knownObligations: [{ currency: 'USD', amountMinor: -1, dueInDays: 1 }] }),
      ),
    ).toThrow(RangeError);
  });
});

describe('independent: window_budget boundaries', () => {
  it.each([
    { spent: 0, charge: 10000, pass: true },
    { spent: 9999, charge: 1, pass: true },
    { spent: 10000, charge: 0, pass: false },
    { spent: 10000, charge: 1, pass: false },
    { spent: 9999, charge: 2, pass: false },
    { spent: 10001, charge: 0, pass: false },
  ])('spent $spent + charge $charge against budget 10000 passes=$pass', ({ spent, charge, pass }) => {
    const result = windowBudget(
      candidate({ perChargeMinor: charge, upfrontMinor: 999_999 }),
      context({ spentInWindowMinor: spent, windowBudgetMinor: 10000 }),
    );
    expect(result.pass).toBe(pass);
    expect(result.code).toBe(charge === 0 ? 'zero_charge_unknown_cost' : pass ? 'budget_ok' : 'budget_exceeded');
  });

  it('ignores the upfront cost and uses only the per-charge amount', () => {
    const passes = windowBudget(
      candidate({ upfrontMinor: MAX_SAFE, perChargeMinor: 1 }),
      context({ spentInWindowMinor: 0, windowBudgetMinor: 1 }),
    );
    expect(passes.code).toBe('budget_ok');

    const fails = windowBudget(
      candidate({ upfrontMinor: 0, perChargeMinor: 10001 }),
      context({ spentInWindowMinor: 0, windowBudgetMinor: 10000 }),
    );
    expect(fails.code).toBe('budget_exceeded');
  });

  it('fails a currency mismatch without converting the amount', () => {
    expect(windowBudget(candidate({ currency: 'EUR' }), context())).toMatchObject({
      pass: false,
      code: 'budget_currency_mismatch',
    });
    expect(windowBudget(candidate(), context({ budgetCurrency: 'usd' }))).toMatchObject({
      pass: false,
      code: 'budget_currency_mismatch',
    });
  });

  it('rejects negative or non-integer spending values', () => {
    expect(() =>
      windowBudget(candidate(), context({ spentInWindowMinor: -1 })),
    ).toThrow(RangeError);
    expect(() =>
      windowBudget(candidate(), context({ windowBudgetMinor: 1.5 })),
    ).toThrow(RangeError);
  });
});

describe('independent: commitment_cap boundaries', () => {
  it.each([
    { commitment: 0, max: 0, pass: true },
    { commitment: 1, max: 0, pass: false },
    { commitment: 12, max: 12, pass: true },
    { commitment: 13, max: 12, pass: false },
  ])('commitment $commitment against maximum $max passes=$pass', ({ commitment, max, pass }) => {
    expect(
      commitmentCap(
        candidate({ commitmentMonths: commitment }),
        context({ maxCommitmentMonths: max }),
      ),
    ).toMatchObject({ pass, code: pass ? 'commitment_ok' : 'commitment_too_long' });
  });

  it('rejects invalid month values instead of treating them as unlimited', () => {
    for (const value of [-1, 1.5, Number.NaN]) {
      expect(() =>
        commitmentCap(candidate({ commitmentMonths: value }), context()),
      ).toThrow(RangeError);
      expect(() =>
        commitmentCap(candidate(), context({ maxCommitmentMonths: value })),
      ).toThrow(RangeError);
    }
  });
});

describe('independent: region rule uses resolved availability only', () => {
  it('passes an available candidate even when the context countries differ', () => {
    expect(
      region(candidate(), context({ billingCountry: 'ZZ', cardCountry: 'ZZ' })),
    ).toMatchObject({ rule: 'region', pass: true, code: 'region_ok' });
  });

  it('fails an unavailable candidate even when the context countries match', () => {
    expect(
      region(
        candidate({ availability: 'region_unavailable' }),
        context({ billingCountry: 'US', cardCountry: 'US' }),
      ),
    ).toMatchObject({ pass: false, code: 'region_unavailable' });
  });
});

describe('independent: evaluateRules', () => {
  it('returns the four rules in contract order and passes exactly at every boundary', () => {
    const ctx = context({
      balances: [{ currency: 'USD', available_amount: '650.00' }],
      knownObligations: [{ currency: 'USD', amountMinor: 10000, dueInDays: 15 }],
      reserveHorizonDays: 30,
      reserveFloorMinor: { USD: 50000 },
      spentInWindowMinor: 95000,
      windowBudgetMinor: 100000,
      maxCommitmentMonths: 12,
    });
    const results = evaluateRules(
      candidate({ upfrontMinor: 5000, perChargeMinor: 5000, commitmentMonths: 12 }),
      ctx,
    );
    expect(results.map((result) => result.rule)).toEqual([
      'reserve_floor',
      'window_budget',
      'commitment_cap',
      'region',
    ]);
    expect(codes(results)).toEqual([
      'reserve_ok',
      'budget_ok',
      'commitment_ok',
      'region_ok',
    ]);
    expect(results.every((result) => result.pass)).toBe(true);
  });

  it('reports every failure code without short-circuiting', () => {
    const ctx = context({
      balances: [{ currency: 'USD', available_amount: '10.00' }],
      knownObligations: [],
      reserveFloorMinor: { USD: 50000 },
      spentInWindowMinor: 100000,
      windowBudgetMinor: 100000,
      maxCommitmentMonths: 1,
    });
    const results = evaluateRules(
      candidate({
        upfrontMinor: 5000,
        perChargeMinor: 1,
        commitmentMonths: 2,
        availability: 'region_unavailable',
      }),
      ctx,
    );
    expect(codes(results)).toEqual([
      'reserve_breach',
      'budget_exceeded',
      'commitment_too_long',
      'region_unavailable',
    ]);
  });

  it('rejects an invalid candidate instead of asking for approval', () => {
    expect(() => evaluateRules(candidate({ perChargeMinor: -1 }), context())).toThrow();
    expect(() =>
      evaluateRules(candidate({ horizonCost: { lowMinor: 2, highMinor: 1 } }), context()),
    ).toThrow();
  });

  it('does not mutate the candidate or context', () => {
    const input = candidate();
    const ctx = context();
    const before = structuredClone({ input, ctx });
    evaluateRules(input, ctx);
    expect({ input, ctx }).toEqual(before);
  });
});

describe('independent: decidePurchase ranking and refusal', () => {
  it('asks for the cheapest passing candidate and never for a cheaper failing one', () => {
    const failing = candidate({
      offerId: 'offer_failing_cheap',
      upfrontMinor: 60000,
      horizonCost: { lowMinor: 100, highMinor: 100 },
    });
    const expensive = candidate({
      offerId: 'offer_passing_expensive',
      upfrontMinor: 5000,
      horizonCost: { lowMinor: 9000, highMinor: 9000 },
    });
    const winner = candidate({
      offerId: 'offer_passing_cheap',
      upfrontMinor: 4000,
      horizonCost: { lowMinor: 7000, highMinor: 7000 },
    });

    const decision = decidePurchase([failing, expensive, winner], context());
    expect(decision.action).toBe('ask');
    expect(decision.chosen?.offerId).toBe('offer_passing_cheap');
    expect(decision.ranked.map((entry) => entry.candidate.offerId)).toEqual([
      'offer_passing_cheap',
      'offer_passing_expensive',
      'offer_failing_cheap',
    ]);
  });

  it('chooses the lowest upfront when horizon costs tie', () => {
    const expensive = candidate({
      offerId: 'offer_upfront_high',
      upfrontMinor: 5000,
      horizonCost: { lowMinor: 8000, highMinor: 8000 },
    });
    const cheap = candidate({
      offerId: 'offer_upfront_low',
      upfrontMinor: 4000,
      horizonCost: { lowMinor: 8000, highMinor: 8000 },
    });

    expect(decidePurchase([expensive, cheap], context()).chosen?.offerId).toBe(
      'offer_upfront_low',
    );
  });

  it('refuses with unique failure codes when no candidate passes', () => {
    const first = candidate({
      offerId: 'offer_a',
      availability: 'region_unavailable',
      upfrontMinor: 60000,
    });
    const second = candidate({
      offerId: 'offer_b',
      availability: 'region_unavailable',
      upfrontMinor: 60000,
    });

    const decision = decidePurchase([first, second], context());
    expect(decision).toMatchObject({
      action: 'refuse',
      reasons: ['reserve_breach', 'region_unavailable'],
    });
    expect(decision).not.toHaveProperty('chosen');
  });

  it('never chooses a region_unavailable candidate even when it is the cheapest', () => {
    const unavailable = candidate({
      offerId: 'offer_unavailable_cheap',
      availability: 'region_unavailable',
      upfrontMinor: 0,
      perChargeMinor: 0,
      horizonCost: { lowMinor: 0, highMinor: 0 },
    });
    const available = candidate({
      offerId: 'offer_available',
      upfrontMinor: 5000,
      horizonCost: { lowMinor: 9000, highMinor: 9000 },
    });

    const decision = decidePurchase([unavailable, available], context());
    expect(decision.action).toBe('ask');
    expect(decision.chosen?.offerId).toBe('offer_available');
  });

  it('refuses a currency mismatch in the budget even when reserves are sufficient', () => {
    const decision = decidePurchase(
      [candidate({ currency: 'EUR' })],
      context({
        balances: [{ currency: 'EUR', available_amount: '1000.00' }],
        knownObligations: [{ currency: 'EUR', amountMinor: 10000, dueInDays: 15 }],
        reserveFloorMinor: { EUR: 50000 },
      }),
    );
    expect(decision.action).toBe('refuse');
    expect(decision.reasons).toEqual(['currency_not_budgeted']);
    expect(decision).not.toHaveProperty('chosen');
    expect(decision.ranked[0]).toMatchObject({ passed: false, results: [{ code: 'currency_not_budgeted', pass: false }] });
  });

  it('refuses zero-charge card usage even with price and MCC warnings', () => {
    const usage = candidate({
      plan: 'usage',
      priceStatus: 'price_unverified',
      upfrontMinor: 0,
      perChargeMinor: 0,
    });
    delete usage.merchantCategoryCode;

    const decision = decidePurchase([usage], context());
    expect(decision).toMatchObject({ action: 'refuse', reasons: ['zero_charge_unknown_cost'] });
    expect(decision).not.toHaveProperty('chosen');
  });

  it('does not rank an unknown usage range as a free purchase', () => {
    const unknown = candidate({
      offerId: 'offer_usage_unknown',
      plan: 'usage',
      priceStatus: 'price_unverified',
      upfrontMinor: 0,
      perChargeMinor: 0,
      horizonCost: { lowMinor: 0, highMinor: 0 },
      monthlyRunRateMinor: { lowMinor: 0, highMinor: 0 },
      notes: ['usage unknown: callsPerMonth not provided; cost range shown as 0.00'],
    });
    delete unknown.merchantCategoryCode;
    const known = candidate({
      offerId: 'offer_known_cost',
      upfrontMinor: 5000,
      horizonCost: { lowMinor: 9000, highMinor: 9000 },
    });

    const decision = decidePurchase([unknown, known], context());
    expect(decision.chosen?.offerId).toBe('offer_known_cost');
    expect(decision.ranked.find(entry => entry.candidate === unknown)).toMatchObject({
      passed: false, results: expect.arrayContaining([expect.objectContaining({ code: 'zero_charge_unknown_cost', pass: false })]),
    });
  });
});

describe('independent: approval request amount and lifetime', () => {
  it('binds the per-charge amount, not the horizon or upfront cost', () => {
    for (const plan of ['monthly', 'annual', 'usage', 'one_time'] as const) {
      const request = createApprovalRequest(
        candidate({
          plan,
          upfrontMinor: 999_999,
          perChargeMinor: 1234,
          horizonCost: { lowMinor: 1, highMinor: 5_000_000 },
        }),
        TIMES,
      );
      expect(request.amountMinor).toBe(1234);
      expect(request.interval).toBe(plan === 'monthly' || plan === 'usage' ? 'MONTHLY' : 'PER_TRANSACTION');
    }
  });

  it('maps plans to the documented transaction count', () => {
    const counts = (['monthly', 'annual', 'usage', 'one_time'] as const).map(
      (plan) => createApprovalRequest(candidate({ plan }), TIMES).allowedTransactionCount,
    );
    expect(counts).toEqual(['MULTIPLE', 'SINGLE', 'MULTIPLE', 'SINGLE']);
  });

  it.each([
    ['equal timestamps', { ...TIMES, expiresAt: TIMES.createdAt }],
    ['an expiry before creation', { ...TIMES, expiresAt: '2029-12-31T23:59:59Z' }],
    ['a timestamp without an offset', { ...TIMES, createdAt: '2030-01-01T00:00:00' }],
  ])('rejects %s', (_label, times) => {
    expect(() => createApprovalRequest(candidate(), times)).toThrow();
  });

  it('rejects invalid candidate money and MCC', () => {
    expect(() => createApprovalRequest(candidate({ perChargeMinor: 1.5 }), TIMES)).toThrow();
    expect(() => createApprovalRequest(candidate({ perChargeMinor: -1 }), TIMES)).toThrow();
    expect(() =>
      createApprovalRequest(candidate({ merchantCategoryCode: '573' }), TIMES),
    ).toThrow();
  });
});

describe('independent: terms hashing binds exactly the approved fields', () => {
  it.each(BINDING_CHANGES)('invalidates a human approval when $label is tampered', ({ change }) => {
    const request = requestFor();
    const presented = termsHash(request);
    const tampered = change(request);

    expect(termsHash(tampered)).not.toBe(presented);
    expectApprovalCode(
      () =>
        approve(tampered, {
          approver: HUMAN,
          presentedTermsHash: presented,
          now: '2030-01-01T00:30:00Z',
        }),
      'terms_mismatch',
    );
  });

  it('does not bind labels or request metadata', () => {
    const request = requestFor();
    const presented = termsHash(request);
    const relabelled: ApprovalRequest = {
      ...request,
      approvalRequestId: 'approval_request_independent_other',
      product: 'Different Label',
      priceStatus: 'price_unverified',
      createdAt: '2029-12-31T23:00:00Z',
    };

    expect(termsHash(relabelled)).toBe(presented);
    expect(
      approve(relabelled, {
        approver: HUMAN,
        presentedTermsHash: presented,
        now: '2030-01-01T00:30:00Z',
      }).termsHash,
    ).toBe(presented);
  });

  it('binds the absence of an MCC separately from any present MCC', () => {
    const withMcc = requestFor();
    const withoutMcc = requestFor();
    delete withoutMcc.merchantCategoryCode;

    expect(termsHash(withoutMcc)).not.toBe(termsHash(withMcc));
    expect(termsHash({ ...withoutMcc })).toBe(termsHash(withoutMcc));
  });
});

describe('independent: human approval gates', () => {
  it('rejects agent self-approval before checking the presented terms', () => {
    expectApprovalCode(
      () =>
        approve(requestFor(), {
          approver: { kind: 'agent', id: 'agent_test_01' },
          presentedTermsHash: 'not-a-hash',
          now: '2030-01-01T00:30:00Z',
        }),
      'self_approval_forbidden',
    );
  });

  it('accepts a human exactly before expiry and rejects at and after it', () => {
    const request = requestFor();
    expect(approveWith(request, { now: '2030-01-01T00:59:59.999Z' }).approvedBy).toEqual(
      HUMAN,
    );
    for (const now of ['2030-01-01T01:00:00.000Z', '2030-01-01T01:00:00.001Z']) {
      expectApprovalCode(() => approveWith(request, { now }), 'approval_expired');
    }
  });

  it('compares an offset expiry as the same instant', () => {
    const request = createApprovalRequest(candidate(), {
      ...TIMES,
      expiresAt: '2030-01-01T02:00:00+01:00',
    });
    expect(approveWith(request, { now: '2030-01-01T00:59:59.999Z' }).approvedBy.kind).toBe(
      'human',
    );
    expectApprovalCode(
      () => approveWith(request, { now: '2030-01-01T01:00:00Z' }),
      'approval_expired',
    );
  });

  it('rejects a pre-creation clock with RangeError and an invalid clock with a parse error', () => {
    const request = requestFor();
    expect(() =>
      approve(request, {
        approver: HUMAN,
        presentedTermsHash: termsHash(request),
        now: '2029-12-31T23:59:59Z',
      }),
    ).toThrow('approval_before_creation');
    expect(() =>
      approve(request, {
        approver: HUMAN,
        presentedTermsHash: termsHash(request),
        now: 'not-a-date',
      }),
    ).toThrow();
  });

  it('requires a non-empty human ID', () => {
    const request = requestFor();
    expect(() =>
      approve(request, {
        approver: { kind: 'human', id: '' },
        presentedTermsHash: termsHash(request),
        now: '2030-01-01T00:30:00Z',
      }),
    ).toThrow();
  });

  it('fills an absent MCC only on explicit human approval', () => {
    const withoutMcc = requestFor();
    delete withoutMcc.merchantCategoryCode;
    const presented = termsHash(withoutMcc);

    expectApprovalCode(
      () =>
        approve(withoutMcc, {
          approver: HUMAN,
          presentedTermsHash: presented,
          now: '2030-01-01T00:30:00Z',
        }),
      'mcc_required',
    );
    for (const merchantCategoryCode of ['', '123', '12345', 'abcd', ' 5734']) {
      expectApprovalCode(
        () =>
          approve(withoutMcc, {
            approver: HUMAN,
            presentedTermsHash: presented,
            merchantCategoryCode,
            now: '2030-01-01T00:30:00Z',
          }),
        'mcc_required',
      );
    }

    const filled = approve(withoutMcc, {
      approver: HUMAN,
      presentedTermsHash: presented,
      merchantCategoryCode: '5817',
      now: '2030-01-01T00:30:00Z',
    });
    expect(filled.request.merchantCategoryCode).toBe('5817');
    expect(filled.termsHash).toBe(termsHash(filled.request));
    expect(filled.termsHash).not.toBe(presented);
    expect(withoutMcc).not.toHaveProperty('merchantCategoryCode');
  });

  it('refuses to replace an MCC already bound by the request', () => {
    const request = requestFor();
    expect(
      approve(request, {
        approver: HUMAN,
        presentedTermsHash: termsHash(request),
        merchantCategoryCode: '5734',
        now: '2030-01-01T00:30:00Z',
      }).request.merchantCategoryCode,
    ).toBe('5734');
    expectApprovalCode(
      () =>
        approve(request, {
          approver: HUMAN,
          presentedTermsHash: termsHash(request),
          merchantCategoryCode: '5817',
          now: '2030-01-01T00:30:00Z',
        }),
      'terms_mismatch',
    );
  });
});

describe('independent: approval-to-card controls', () => {
  it('derives a deterministic, bounded request_id from the approval id only', () => {
    const first = approved();
    const expected = `spk_${createHash('sha256')
      .update(first.approvalId)
      .digest('hex')
      .slice(0, 40)}`;
    const body = approvalToCardInput(first, CARD_OPTIONS);

    expect(body.request_id).toBe(expected);
    expect(body.request_id).toBe(cardRequestIdFromApproval(first.approvalId));
    expect(body.request_id).toMatch(/^spk_[0-9a-f]{40}$/);
    expect(body.request_id.length).toBeLessThanOrEqual(50);
    expect(approvalToCardInput(first, CARD_OPTIONS).request_id).toBe(body.request_id);
    expect(cardRequestIdFromApproval('x'.repeat(1000))).toHaveLength(44);

    const relabelled: Approval = {
      ...first,
      request: { ...first.request, approvalRequestId: 'another_request_id' },
    };
    expect(approvalToCardInput(relabelled, CARD_OPTIONS).request_id).toBe(body.request_id);

    const otherApproval: Approval = { ...first, approvalId: 'approval_test_other' };
    expect(approvalToCardInput(otherApproval, CARD_OPTIONS).request_id).not.toBe(
      body.request_id,
    );
  });

  it.each([
    { plan: 'monthly', count: 'MULTIPLE', amount: 1234 },
    { plan: 'usage', count: 'MULTIPLE', amount: 1 },
    { plan: 'annual', count: 'SINGLE', amount: 60000 },
    { plan: 'one_time', count: 'SINGLE', amount: 99 },
  ] as const)('maps $plan to an exact $count card body', ({ plan, count, amount }) => {
    const approval = approved({ plan, perChargeMinor: amount });
    const body = approvalToCardInput(approval, CARD_OPTIONS);
    const controls = body.authorization_controls;

    expect(controls).toEqual({
      allowed_transaction_count: count,
      allowed_currencies: ['USD'],
      allowed_merchant_categories: ['5734'],
      transaction_limits: {
        currency: 'USD',
        limits: [
          {
            amount: Number(minorToDecimal(amount)),
            interval: plan === 'monthly' || plan === 'usage' ? 'MONTHLY' : 'PER_TRANSACTION',
          },
        ],
      },
    });
    expect(controls.allowed_currencies).toEqual([controls.transaction_limits.currency]);
    expect(controls.allowed_merchant_categories).toEqual(['5734']);
    expect(controls.transaction_limits.limits[0]?.amount).toBe(
      Number(minorToDecimal(amount)),
    );
    expect(createCardInputSchema.parse(body)).toEqual(body);
  });

  it('uses only the approved amount for the card limit', () => {
    const input = candidate({ perChargeMinor: 5000 });
    const request = createApprovalRequest(input, TIMES);
    input.perChargeMinor = 999_999;
    const approval = approve(request, {
      approver: HUMAN,
      presentedTermsHash: termsHash(request),
      now: '2030-01-01T00:30:00Z',
    });

    const optionsWithAmount = { ...CARD_OPTIONS, amountMinor: 999_999 };
    const body = approvalToCardInput(approval, optionsWithAmount);
    expect(body.authorization_controls.transaction_limits.limits[0]?.amount).toBe(50);

    const tampered: Approval = {
      ...approval,
      request: { ...approval.request, amountMinor: 5001 },
    };
    expectApprovalCode(
      () => approvalToCardInput(tampered, CARD_OPTIONS),
      'terms_mismatch',
    );
  });

  it.each(BINDING_CHANGES)('rejects a card body after $label is tampered', ({ change }) => {
    const approval = approved();
    const tampered: Approval = { ...approval, request: change(approval.request) };
    expectApprovalCode(
      () => approvalToCardInput(tampered, CARD_OPTIONS),
      'terms_mismatch',
    );
  });

  it('refuses an agent-authored approval even with matching terms', () => {
    const approval = approved();
    const forged = {
      ...approval,
      approvedBy: { kind: 'agent', id: 'agent_test_01' },
    } as unknown as Approval;
    expectApprovalCode(
      () => approvalToCardInput(forged, CARD_OPTIONS),
      'self_approval_forbidden',
    );
  });

  it('refuses a terms-matching approval with no MCC', () => {
    const request = createApprovalRequest(candidate(), TIMES);
    delete request.merchantCategoryCode;
    const forged: Approval = {
      approvalId: 'approval_test_no_mcc',
      request,
      termsHash: termsHash(request),
      approvedBy: { kind: 'human', id: 'human_independent_01' },
      approvedAt: '2030-01-01T00:30:00Z',
    };
    expectApprovalCode(
      () => approvalToCardInput(forged, CARD_OPTIONS),
      'mcc_required',
    );
  });

  it('requires a non-empty approval id', () => {
    const approval = approved();
    approval.approvalId = '';
    expect(() => approvalToCardInput(approval, CARD_OPTIONS)).toThrow(
      'approval_id_required',
    );
  });

  it('rejects a zero or unrepresentable limit and accepts one cent', () => {
    expect(() => approved({ perChargeMinor: 0 })).toThrow();
    const zero = approved();
    zero.request.amountMinor = 0;
    expect(() => approvalToCardInput(zero, CARD_OPTIONS)).toThrow();

    const maximum = approved({ perChargeMinor: MAX_SAFE });
    expect(() => approvalToCardInput(maximum, CARD_OPTIONS)).toThrow(
      'unrepresentable_card_amount',
    );

    const one = approved({ perChargeMinor: 1 });
    expect(
      approvalToCardInput(one, CARD_OPTIONS).authorization_controls.transaction_limits
        .limits[0]?.amount,
    ).toBe(0.01);
  });

  it('keeps the limit currency explicitly allowed', () => {
    const body = approvalToCardInput(approved({ currency: 'EUR' }), CARD_OPTIONS);
    expect(body.authorization_controls.allowed_currencies).toEqual(['EUR']);
    expect(body.authorization_controls.transaction_limits.currency).toBe('EUR');
    expect(() => assertControlsCurrency(body.authorization_controls)).not.toThrow();
    expect(() =>
      assertControlsCurrency({
        ...body.authorization_controls,
        allowed_currencies: ['USD'],
      }),
    ).toThrow('controls_currency_mismatch');
    expect(() =>
      assertControlsCurrency({
        ...body.authorization_controls,
        allowed_currencies: [],
      }),
    ).toThrow('controls_currency_mismatch');
  });

  it('does not mutate the approval, options, candidate or request', () => {
    const input = candidate();
    const request = createApprovalRequest(input, TIMES);
    const approval = approve(request, {
      approver: HUMAN,
      presentedTermsHash: termsHash(request),
      now: '2030-01-01T00:30:00Z',
    });
    const options = { ...CARD_OPTIONS };
    const before = structuredClone({ input, request, approval, options });

    approvalToCardInput(approval, options);
    expect({ input, request, approval, options }).toEqual(before);
  });

  it('uses the product as the default nick name and accepts an override', () => {
    const approval = approved();
    expect(approvalToCardInput(approval, CARD_OPTIONS).nick_name).toBe('independent-purchase');
    const withoutNickName: CardInputOptions = { ...CARD_OPTIONS };
    delete withoutNickName.nickName;
    expect(approvalToCardInput(approval, withoutNickName).nick_name).toBe('Test Product');
  });
});

describe('independent: x402 candidate without MCC', () => {
  function x402Candidate(): Candidate {
    const usage = candidate({
      offerId: 'x402:https://api.weather.example.com/weather/current',
      sourceId: 'x402-snapshot',
      rail: 'x402',
      plan: 'usage',
      priceStatus: 'price_unverified',
      upfrontMinor: 0,
      perChargeMinor: 200,
      horizonCost: { lowMinor: 1200, highMinor: 2400 },
      monthlyRunRateMinor: { lowMinor: 100, highMinor: 200 },
      notes: ['usage-based: units differ; range only'],
    });
    delete usage.merchantCategoryCode;
    return usage;
  }

  it('refuses the x402 rail even when its cost is known', () => {
    const usage = x402Candidate();
    expect(decidePurchase([usage], context())).toMatchObject({
      action: 'refuse',
      reasons: ['rail_not_card'],
      ranked: [{ candidate: usage, passed: false, results: [{ code: 'rail_not_card', pass: false }] }],
    });
  });

  it('refuses an x402 approval request before human MCC entry', () => {
    expectApprovalCode(
      () => createApprovalRequest(x402Candidate(), TIMES),
      'rail_not_card',
    );
  });

  it('refuses an x402 card input even with human approval, matching terms and MCC', () => {
    const approval = approved({ merchantCategoryCode: '5817' });
    approval.request.rail = 'x402';
    approval.termsHash = termsHash(approval.request);
    expectApprovalCode(() => approvalToCardInput(approval, CARD_OPTIONS), 'rail_not_card');
  });
});

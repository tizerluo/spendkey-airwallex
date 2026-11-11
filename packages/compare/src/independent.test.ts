import { createCuratedSource, createX402SnapshotSource, type Offer } from '@sk/offers';
import { describe, expect, it } from 'vitest';
import {
  CandidateSchema,
  UsageProfileSchema,
  compareOffers,
  divideSafeCeil,
  microsToMinorCeil,
  minorToDecimal,
  multiplySafeIntegers,
  parseDecimalToMicros,
  parseDecimalToMinor,
  toCandidate,
  type Candidate,
  type UsageProfile,
} from './index.js';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function baseOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: 'offer_independent_monthly',
    sourceId: 'curated',
    vendor: 'Independent Test Vendor',
    product: 'Independent Test Product',
    plan: 'monthly',
    category: 'test-tools',
    merchantCategoryCode: '5734',
    price: { amount: '60.00', currency: 'USD', unit: 'per_month' },
    seats: 5,
    commitmentMonths: 0,
    cancellation: 'Cancel anytime',
    priceStatus: 'price_unverified',
    availability: 'available',
    capturedAt: '2030-01-01T00:00:00Z',
    ...overrides,
  };
}

function offerOf(offers: readonly Offer[], plan: Offer['plan']): Offer {
  const found = offers.find((offer) => offer.plan === plan);
  if (!found) throw new Error(`missing ${plan} offer`);
  return found;
}

describe('independent: minor money refuses rounding and unsafe values', () => {
  it('parses one and two decimal places exactly at the safe boundary', () => {
    expect(parseDecimalToMinor('0')).toBe(0);
    expect(parseDecimalToMinor('0.0')).toBe(0);
    expect(parseDecimalToMinor('0.01')).toBe(1);
    expect(parseDecimalToMinor('12.5')).toBe(1250);
    expect(parseDecimalToMinor('12.50')).toBe(1250);
    expect(parseDecimalToMinor('90071992547409.91')).toBe(MAX_SAFE);
  });

  it.each(['1.234', '0.001', '10.000', '0.0001', '90071992547409.911'])(
    'refuses a minor amount with more than two decimals: %s',
    (amount) => {
      expect(() => parseDecimalToMinor(amount)).toThrow(/invalid minor amount/);
    },
  );

  it.each(['90071992547409.92', '9007199254740991', '99999999999999999'])(
    'refuses a minor amount outside the safe integer range: %s',
    (amount) => {
      expect(() => parseDecimalToMinor(amount)).toThrow(/safe integer/);
    },
  );

  it('accepts at most six micro decimals and refuses unsafe micro results', () => {
    expect(parseDecimalToMicros('0.000001')).toBe(1);
    expect(parseDecimalToMicros('9007199254.740991')).toBe(MAX_SAFE);
    for (const amount of ['0.0000001', '9007199254.740992', '1.2345678']) {
      expect(() => parseDecimalToMicros(amount)).toThrow();
    }
  });

  it('always rounds division up, never down', () => {
    expect(divideSafeCeil(1, 12)).toBe(1);
    expect(divideSafeCeil(11, 12)).toBe(1);
    expect(divideSafeCeil(12, 12)).toBe(1);
    expect(divideSafeCeil(13, 12)).toBe(2);
    expect(divideSafeCeil(23, 12)).toBe(2);
    expect(divideSafeCeil(24, 12)).toBe(2);
    expect(divideSafeCeil(25, 12)).toBe(3);
    expect(divideSafeCeil(10000, 10000)).toBe(1);
    expect(divideSafeCeil(10001, 10000)).toBe(2);
  });

  it('rounds micros up to the next minor unit at both edges', () => {
    expect(microsToMinorCeil(0)).toBe(0);
    expect(microsToMinorCeil(1)).toBe(1);
    expect(microsToMinorCeil(9999)).toBe(1);
    expect(microsToMinorCeil(10000)).toBe(1);
    expect(microsToMinorCeil(10001)).toBe(2);
  });

  it('refuses unsafe integer arithmetic instead of silently losing precision', () => {
    expect(multiplySafeIntegers(MAX_SAFE, 1)).toBe(MAX_SAFE);
    expect(() => multiplySafeIntegers(MAX_SAFE, 2)).toThrow(/safe integer range/);
    expect(() => divideSafeCeil(-1, 2)).toThrow(/non-negative safe integer/);
    expect(() => divideSafeCeil(1, 0)).toThrow(/positive safe integer/);
    expect(() => microsToMinorCeil(1.5)).toThrow(/non-negative safe integer/);
    expect(() => minorToDecimal(MAX_SAFE + 1)).toThrow(/non-negative safe integer/);
  });

  it('round-trips every safe minor value it renders', () => {
    for (const amount of [0, 1, 7, 99, 100, 12345, MAX_SAFE]) {
      expect(parseDecimalToMinor(minorToDecimal(amount))).toBe(amount);
    }
  });
});

describe('independent: usage profile ranges', () => {
  it('accepts equal bounds, including a zero range', () => {
    expect(
      UsageProfileSchema.safeParse({ horizonMonths: 12, callsPerMonth: { low: 5, high: 5 } })
        .success,
    ).toBe(true);
    expect(
      UsageProfileSchema.safeParse({ horizonMonths: 12, unitsPerMonth: { low: 0, high: 0 } })
        .success,
    ).toBe(true);
  });

  it.each([
    { horizonMonths: 12, callsPerMonth: { low: 6, high: 5 } },
    { horizonMonths: 12, unitsPerMonth: { low: 2, high: 1 } },
    { horizonMonths: 0 },
    { horizonMonths: 12, seats: 0 },
    { horizonMonths: 12, callsPerMonth: { low: -1, high: 2 } },
    { horizonMonths: 12, callsPerMonth: { low: 1.5, high: 2 } },
    { horizonMonths: 12, callsPerMonth: { low: 1, high: 2 }, extra: true },
  ])('rejects an invalid or inverted profile: %j', (profile) => {
    expect(UsageProfileSchema.safeParse(profile).success).toBe(false);
  });

  it('refuses an inverted range instead of normalising it', async () => {
    const [weather] = await createX402SnapshotSource().listOffers({ intent: 'weather' });
    if (!weather) throw new Error('missing weather offer');
    const usage: UsageProfile = { horizonMonths: 12, callsPerMonth: { low: 2, high: 1 } };
    expect(() => toCandidate(weather, usage)).toThrow();
    expect(() => compareOffers([weather], usage)).toThrow();
  });

  it('uses the low bound for the floor and the high bound for the per-charge ceiling', async () => {
    const [weather] = await createX402SnapshotSource().listOffers({ intent: 'weather' });
    if (!weather) throw new Error('missing weather offer');

    const result = toCandidate(weather, {
      horizonMonths: 6,
      callsPerMonth: { low: 1, high: 10_000 },
    });
    expect(result.monthlyRunRateMinor).toEqual({ lowMinor: 1, highMinor: 1000 });
    expect(result.horizonCost).toEqual({ lowMinor: 6, highMinor: 6000 });
    expect(result.perChargeMinor).toBe(1000);
    expect(result.upfrontMinor).toBe(0);
  });

  it('rounds a sub-cent usage floor up to one minor unit', async () => {
    const offers = await createCuratedSource().listOffers({
      intent: 'openai',
      billingCountry: 'US',
      cardCountry: 'US',
    });
    const openai = offerOf(offers, 'usage');
    const result = toCandidate(openai, {
      horizonMonths: 12,
      unitsPerMonth: { low: 1, high: 2000 },
    });

    expect(result.monthlyRunRateMinor).toEqual({ lowMinor: 1, highMinor: 30 });
    expect(result.horizonCost).toEqual({ lowMinor: 12, highMinor: 360 });
  });

  it('refuses a per-call price below one micro unit instead of rounding it to free', async () => {
    const [weather] = await createX402SnapshotSource().listOffers({ intent: 'weather' });
    if (!weather) throw new Error('missing weather offer');

    const subMicro: Offer = { ...weather, price: { ...weather.price, amount: '0.0000001' } };
    expect(() =>
      toCandidate(subMicro, { horizonMonths: 12, callsPerMonth: { low: 1, high: 1 } }),
    ).toThrow(/invalid micro amount/);
  });

  it('keeps an unknown usage range at zero with an explicit note', async () => {
    const [weather] = await createX402SnapshotSource().listOffers({ intent: 'weather' });
    if (!weather) throw new Error('missing weather offer');

    const result = toCandidate(weather, { horizonMonths: 12 });
    expect(result.horizonCost).toEqual({ lowMinor: 0, highMinor: 0 });
    expect(result.perChargeMinor).toBe(0);
    expect(result.notes.some((note) => note.includes('usage unknown'))).toBe(true);
  });
});

describe('independent: plan and price-unit contract', () => {
  it.each([
    ['monthly', 'per_year'],
    ['annual', 'per_month'],
    ['usage', 'per_month'],
    ['one_time', 'per_year'],
  ] as const)('refuses a %s plan priced %s', (plan, unit) => {
    const offer = baseOffer({ plan, price: { amount: '60.00', currency: 'USD', unit } });
    expect(() => toCandidate(offer, { horizonMonths: 12 })).toThrow(/price unit/);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'refuses a non-positive or non-integer horizon: %s',
    (horizonMonths) => {
      expect(() => toCandidate(baseOffer(), { horizonMonths })).toThrow();
    },
  );

  it('rounds an annual horizon up to whole years and its monthly run rate up', () => {
    const annual = baseOffer({
      plan: 'annual',
      price: { amount: '100.01', currency: 'USD', unit: 'per_year' },
      commitmentMonths: 12,
    });

    const thirteen = toCandidate(annual, { horizonMonths: 13 });
    expect(thirteen.horizonCost).toEqual({ lowMinor: 20002, highMinor: 20002 });
    expect(thirteen.monthlyRunRateMinor).toEqual({ lowMinor: 834, highMinor: 834 });

    const one = toCandidate(annual, { horizonMonths: 1 });
    expect(one.horizonCost).toEqual({ lowMinor: 10001, highMinor: 10001 });
    expect(one.monthlyRunRateMinor).toEqual({ lowMinor: 834, highMinor: 834 });
  });

  it('spreads a one-time price across the horizon and rounds the run rate up', () => {
    const oneTime = baseOffer({
      plan: 'one_time',
      price: { amount: '100.00', currency: 'USD', unit: 'one_time' },
      commitmentMonths: 0,
    });

    const three = toCandidate(oneTime, { horizonMonths: 3 });
    expect(three.upfrontMinor).toBe(10000);
    expect(three.perChargeMinor).toBe(10000);
    expect(three.horizonCost).toEqual({ lowMinor: 10000, highMinor: 10000 });
    expect(three.monthlyRunRateMinor).toEqual({ lowMinor: 3334, highMinor: 3334 });
  });

  it('never multiplies a plan price by requested seats', () => {
    const over = toCandidate(baseOffer(), { horizonMonths: 12, seats: 50 });
    expect(over.upfrontMinor).toBe(6000);
    expect(over.notes.some((note) => note.includes('seats exceed plan'))).toBe(true);

    const noSeats = baseOffer();
    delete noSeats.seats;
    const under = toCandidate(noSeats, { horizonMonths: 12, seats: 3 });
    expect(under.upfrontMinor).toBe(6000);
    expect(under.notes.some((note) => note.includes('seats not specified'))).toBe(true);
  });

  it('does not add a seat note when the requested seats fit exactly', () => {
    const exact = toCandidate(baseOffer(), { horizonMonths: 12, seats: 5 });
    expect(exact.notes.some((note) => note.includes('seats exceed plan'))).toBe(false);
    expect(exact.notes.some((note) => note.includes('seats not specified'))).toBe(false);
  });
});

describe('independent: currencies and region exclusions', () => {
  it('never invents an exchange rate between currencies', () => {
    const usd = baseOffer({
      id: 'offer_usd',
      price: { amount: '60.00', currency: 'USD', unit: 'per_month' },
    });
    const eur = baseOffer({
      id: 'offer_eur',
      price: { amount: '60.00', currency: 'EUR', unit: 'per_month' },
    });

    const result = compareOffers([usd, eur], { horizonMonths: 12 });
    expect(result.candidates.map((candidate) => candidate.currency).sort()).toEqual([
      'EUR',
      'USD',
    ]);
    for (const candidate of result.candidates) {
      expect(candidate.horizonCost).toEqual({ lowMinor: 72000, highMinor: 72000 });
      expect(candidate.notes.some((note) => note.includes('mixed currencies'))).toBe(true);
    }
  });

  it('sorts mixed currencies by raw minor units without converting them', () => {
    const usd = baseOffer({
      id: 'offer_usd',
      price: { amount: '100.00', currency: 'USD', unit: 'per_month' },
    });
    const eur = baseOffer({
      id: 'offer_eur',
      price: { amount: '10.00', currency: 'EUR', unit: 'per_month' },
    });

    const result = compareOffers([usd, eur], { horizonMonths: 12 });
    expect(result.candidates.map((candidate) => candidate.offerId)).toEqual([
      'offer_eur',
      'offer_usd',
    ]);
    expect(result.candidates.map((candidate) => candidate.horizonCost.highMinor)).toEqual([
      12000,
      120000,
    ]);
  });

  it('moves region_unavailable offers to excluded and never treats them as candidates', async () => {
    const restricted = await createCuratedSource().listOffers({
      intent: 'openai api',
      billingCountry: 'HK',
      cardCountry: 'HK',
    });
    expect(restricted).toHaveLength(1);
    const [restrictedOffer] = restricted;
    if (!restrictedOffer) throw new Error('missing restricted offer');

    const result = compareOffers(restricted, { horizonMonths: 12 });
    expect(result.candidates).toEqual([]);
    expect(result.excluded).toEqual([
      { offerId: 'curated-openai-api', reason: 'region_unavailable' },
    ]);
    expect(() => toCandidate(restrictedOffer, { horizonMonths: 12 })).toThrow(
      /region_unavailable/,
    );
  });

  it('excludes an unavailable offer even when it would be the cheapest', () => {
    const cheapestUnavailable = baseOffer({
      id: 'offer_cheap_unavailable',
      availability: 'region_unavailable',
      price: { amount: '0.01', currency: 'USD', unit: 'per_month' },
    });
    const available = baseOffer({
      id: 'offer_available',
      price: { amount: '60.00', currency: 'USD', unit: 'per_month' },
    });

    const result = compareOffers([cheapestUnavailable, available], { horizonMonths: 12 });
    expect(result.candidates.map((candidate) => candidate.offerId)).toEqual([
      'offer_available',
    ]);
    expect(result.excluded).toEqual([
      { offerId: 'offer_cheap_unavailable', reason: 'region_unavailable' },
    ]);
  });
});

describe('independent: candidate schema boundaries', () => {
  it('rejects inverted ranges, unsafe money, extra keys and unavailable candidates', () => {
    const valid = toCandidate(baseOffer(), { horizonMonths: 12 });
    expect(CandidateSchema.safeParse(valid).success).toBe(true);

    expect(
      CandidateSchema.safeParse({ ...valid, horizonCost: { lowMinor: 100, highMinor: 99 } })
        .success,
    ).toBe(false);
    expect(
      CandidateSchema.safeParse({
        ...valid,
        monthlyRunRateMinor: { lowMinor: 100, highMinor: 99 },
      }).success,
    ).toBe(false);
    expect(CandidateSchema.safeParse({ ...valid, upfrontMinor: -1 }).success).toBe(false);
    expect(CandidateSchema.safeParse({ ...valid, upfrontMinor: 1.5 }).success).toBe(false);
    expect(CandidateSchema.safeParse({ ...valid, perChargeMinor: MAX_SAFE + 1 }).success).toBe(
      false,
    );
    expect(CandidateSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(
      CandidateSchema.safeParse({ ...valid, availability: 'region_unavailable' }).success,
    ).toBe(false);
  });

  it('accepts safe integer boundaries and a missing MCC', () => {
    const valid = toCandidate(baseOffer(), { horizonMonths: 12 });
    const boundary: Candidate = {
      ...valid,
      upfrontMinor: MAX_SAFE,
      perChargeMinor: MAX_SAFE,
      horizonCost: { lowMinor: MAX_SAFE, highMinor: MAX_SAFE },
      monthlyRunRateMinor: { lowMinor: MAX_SAFE, highMinor: MAX_SAFE },
    };
    expect(CandidateSchema.safeParse(boundary).success).toBe(true);

    const noMcc = toCandidate(baseOffer(), { horizonMonths: 12 });
    delete noMcc.merchantCategoryCode;
    expect(CandidateSchema.safeParse(noMcc).success).toBe(true);
  });

  it('refuses a currency that is not three uppercase letters', () => {
    const invalid: Offer = {
      ...baseOffer(),
      price: { amount: '60.00', currency: 'usd', unit: 'per_month' },
    };
    expect(() => toCandidate(invalid, { horizonMonths: 12 })).toThrow();
  });

  it('refuses an invalid MCC instead of passing it through', () => {
    const invalid: Offer = { ...baseOffer(), merchantCategoryCode: '73a4' };
    expect(() => toCandidate(invalid, { horizonMonths: 12 })).toThrow();
  });

  it('refuses a horizon whose cost would overflow the safe integer range', () => {
    const expensive = baseOffer({
      price: { amount: '90071992547409.91', currency: 'USD', unit: 'per_month' },
    });
    expect(() => toCandidate(expensive, { horizonMonths: 2 })).toThrow(
      /safe integer range/,
    );
  });

  it('keeps the candidate price independent of the requested horizon for a monthly plan', () => {
    const short = toCandidate(baseOffer(), { horizonMonths: 1 });
    const long = toCandidate(baseOffer(), { horizonMonths: 24 });
    expect(short.upfrontMinor).toBe(6000);
    expect(short.perChargeMinor).toBe(6000);
    expect(short.monthlyRunRateMinor).toEqual({ lowMinor: 6000, highMinor: 6000 });
    expect(long.horizonCost).toEqual({ lowMinor: 144000, highMinor: 144000 });
    expect(long.monthlyRunRateMinor).toEqual({ lowMinor: 6000, highMinor: 6000 });
  });

  it('returns an empty comparison for no offers', () => {
    expect(compareOffers([], { horizonMonths: 12 })).toEqual({
      candidates: [],
      excluded: [],
    });
  });
});

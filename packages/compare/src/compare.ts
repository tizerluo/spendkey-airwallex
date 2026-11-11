import type { Offer } from '@sk/offers';
import {
  CandidateSchema,
  UsageProfileSchema,
  type Candidate,
  type UsageProfile,
} from './candidate.js';
import {
  divideSafeCeil,
  microsToMinorCeil,
  multiplySafeIntegers,
  parseDecimalToMicros,
  parseDecimalToMinor,
} from './money.js';

const PRICE_UNVERIFIED_NOTE = 'price_unverified: amount shown, no savings claim';
const USAGE_NOTE = 'usage-based: units differ; range only';
const MIXED_CURRENCY_NOTE = 'mixed currencies: no FX conversion; compare within a currency only';

type CostShape = Pick<
  Candidate,
  'upfrontMinor' | 'perChargeMinor' | 'horizonCost' | 'monthlyRunRateMinor'
>;

export type ExclusionReason = 'region_unavailable';

export interface ExcludedOffer {
  offerId: string;
  reason: ExclusionReason;
}

export interface CompareResult {
  candidates: Candidate[];
  excluded: ExcludedOffer[];
}

const UNIT_BY_PLAN = {
  monthly: ['per_month'],
  annual: ['per_year'],
  usage: ['per_call', 'per_1k_units'],
  one_time: ['one_time'],
} as const satisfies Record<Offer['plan'], readonly Offer['price']['unit'][]>;

function assertUnitMatchesPlan(offer: Offer): void {
  const allowed: readonly Offer['price']['unit'][] = UNIT_BY_PLAN[offer.plan];
  if (!allowed.includes(offer.price.unit)) {
    throw new Error(
      `offer ${offer.id} has plan "${offer.plan}" but price unit "${offer.price.unit}"`,
    );
  }
}

function seatNotes(offer: Offer, usage: UsageProfile, notes: string[]): void {
  if (offer.seats === undefined) {
    if (usage.seats !== undefined && usage.seats > 1) {
      notes.push(
        `seats not specified by offer: price treated as the total plan price for ${usage.seats} seats`,
      );
    }
    return;
  }
  if (usage.seats !== undefined && usage.seats > offer.seats) {
    notes.push(
      `seats exceed plan: requested ${usage.seats} seats, plan covers ${offer.seats}; price kept as the total plan price`,
    );
  }
}

function monthlyCost(amount: string, horizonMonths: number): CostShape {
  const price = parseDecimalToMinor(amount);
  const horizon = multiplySafeIntegers(price, horizonMonths, 'horizon cost');
  return {
    upfrontMinor: price,
    perChargeMinor: price,
    horizonCost: { lowMinor: horizon, highMinor: horizon },
    monthlyRunRateMinor: { lowMinor: price, highMinor: price },
  };
}

function annualCost(amount: string, horizonMonths: number): CostShape {
  const price = parseDecimalToMinor(amount);
  const years = divideSafeCeil(horizonMonths, 12, 'horizon months');
  const horizon = multiplySafeIntegers(price, years, 'horizon cost');
  const monthly = divideSafeCeil(price, 12, 'monthly run rate');
  return {
    upfrontMinor: price,
    perChargeMinor: price,
    horizonCost: { lowMinor: horizon, highMinor: horizon },
    monthlyRunRateMinor: { lowMinor: monthly, highMinor: monthly },
  };
}

function oneTimeCost(amount: string, horizonMonths: number): CostShape {
  const price = parseDecimalToMinor(amount);
  const monthly = divideSafeCeil(price, horizonMonths, 'monthly run rate');
  return {
    upfrontMinor: price,
    perChargeMinor: price,
    horizonCost: { lowMinor: price, highMinor: price },
    monthlyRunRateMinor: { lowMinor: monthly, highMinor: monthly },
  };
}

function usageMonthlyMinor(count: number, unitPriceMicros: number, divisor: number): number {
  const micros = multiplySafeIntegers(count, unitPriceMicros, 'usage cost');
  const monthlyMicros = divisor === 1 ? micros : divideSafeCeil(micros, divisor, 'usage cost');
  return microsToMinorCeil(monthlyMicros);
}

function usageCost(offer: Offer, usage: UsageProfile, notes: string[]): CostShape {
  const unitPriceMicros = parseDecimalToMicros(offer.price.amount);
  const perCall = offer.price.unit === 'per_call';
  const profile = perCall ? usage.callsPerMonth : usage.unitsPerMonth;
  const profileName = perCall ? 'callsPerMonth' : 'unitsPerMonth';

  let lowMinor = 0;
  let highMinor = 0;

  if (profile === undefined) {
    notes.push('usage_unknown', `usage unknown: ${profileName} not provided; zero range is a placeholder, not a price`);
  } else {
    const divisor = perCall ? 1 : 1_000;
    lowMinor = usageMonthlyMinor(profile.low, unitPriceMicros, divisor);
    highMinor = usageMonthlyMinor(profile.high, unitPriceMicros, divisor);
    notes.push(USAGE_NOTE);
  }

  return {
    upfrontMinor: 0,
    perChargeMinor: highMinor,
    horizonCost: {
      lowMinor: multiplySafeIntegers(lowMinor, usage.horizonMonths, 'horizon cost'),
      highMinor: multiplySafeIntegers(highMinor, usage.horizonMonths, 'horizon cost'),
    },
    monthlyRunRateMinor: { lowMinor, highMinor },
  };
}

function costsFor(offer: Offer, usage: UsageProfile, notes: string[]): CostShape {
  switch (offer.plan) {
    case 'monthly':
      return monthlyCost(offer.price.amount, usage.horizonMonths);
    case 'annual':
      return annualCost(offer.price.amount, usage.horizonMonths);
    case 'usage':
      return usageCost(offer, usage, notes);
    case 'one_time':
      return oneTimeCost(offer.price.amount, usage.horizonMonths);
  }
}

function buildCandidate(offer: Offer, usage: UsageProfile): Candidate {
  if (offer.availability === 'region_unavailable') {
    throw new Error(`offer ${offer.id} is region_unavailable and cannot be a candidate`);
  }
  assertUnitMatchesPlan(offer);

  const notes: string[] = [];
  if (offer.priceStatus === 'price_unverified') notes.push(PRICE_UNVERIFIED_NOTE);
  seatNotes(offer, usage, notes);
  const costs = costsFor(offer, usage, notes);

  const base = {
    offerId: offer.id,
    vendor: offer.vendor,
    product: offer.product,
    sourceId: offer.sourceId,
    rail: offer.rail,
    plan: offer.plan,
    currency: offer.price.currency,
    ...(offer.merchantCategoryCode === undefined
      ? {}
      : { merchantCategoryCode: offer.merchantCategoryCode }),
    commitmentMonths: offer.commitmentMonths,
    priceStatus: offer.priceStatus,
    availability: offer.availability,
    ...costs,
    notes,
  };

  return CandidateSchema.parse(base);
}

/**
 * Normalise one offer into a comparable candidate.
 *
 * The offer price is always treated as the **total plan price** for the seats
 * the offer states. Seats are never multiplied: a plan priced for 5 seats is
 * compared at its plan price even when `usage.seats` asks for more; that case
 * only adds a "seats exceed plan" note. If the offer does not state seats, its
 * price is still treated as the total plan price.
 */
export function toCandidate(offer: Offer, usage: UsageProfile): Candidate {
  return buildCandidate(offer, UsageProfileSchema.parse(usage));
}

/**
 * Turn offers into candidates and move region-restricted offers into
 * `excluded`, where the caller can explain them. Costs are never converted
 * between currencies; a mixed-currency result carries an explanatory note.
 */
export function compareOffers(
  offers: readonly Offer[],
  usage: UsageProfile,
): CompareResult {
  const profile = UsageProfileSchema.parse(usage);
  const candidates: Candidate[] = [];
  const excluded: ExcludedOffer[] = [];

  for (const offer of offers) {
    if (offer.availability === 'region_unavailable') {
      excluded.push({ offerId: offer.id, reason: 'region_unavailable' });
      continue;
    }
    candidates.push(buildCandidate(offer, profile));
  }

  const currencies = new Set(candidates.map((candidate) => candidate.currency));
  const comparable =
    currencies.size > 1
      ? candidates.map((candidate) => ({
          ...candidate,
          notes: [...candidate.notes, MIXED_CURRENCY_NOTE],
        }))
      : candidates;

  comparable.sort(
    (left, right) =>
      Number(left.notes.includes('usage_unknown')) - Number(right.notes.includes('usage_unknown')) ||
      left.horizonCost.highMinor - right.horizonCost.highMinor ||
      left.upfrontMinor - right.upfrontMinor,
  );

  return { candidates: comparable, excluded };
}

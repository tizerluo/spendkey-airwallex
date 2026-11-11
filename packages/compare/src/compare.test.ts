import { createCuratedSource, createX402SnapshotSource, type Offer } from '@sk/offers';
import { describe, expect, it } from 'vitest';
import type { Candidate, UsageProfile } from './candidate.js';
import { compareOffers, toCandidate } from './compare.js';

const PRICE_UNVERIFIED_NOTE = 'price_unverified: amount shown, no savings claim';

async function designOffers(): Promise<Offer[]> {
  return createCuratedSource().listOffers({ intent: 'designco' });
}

function candidateFor(candidates: readonly Candidate[], plan: Candidate['plan']): Candidate {
  const candidate = candidates.find((item) => item.plan === plan);
  if (!candidate) throw new Error(`missing ${plan} candidate`);
  return candidate;
}

function offerFor(offers: readonly Offer[], plan: Offer['plan']): Offer {
  const offer = offers.find((item) => item.plan === plan);
  if (!offer) throw new Error(`missing ${plan} offer`);
  return offer;
}

describe('toCandidate: subscription plans', () => {
  const usage: UsageProfile = { horizonMonths: 12, seats: 5 };

  it('compares the curated DesignCo 5-seat monthly and annual offers over 12 months', async () => {
    const offers = await designOffers();
    const result = compareOffers(offers, usage);

    expect(result.excluded).toEqual([]);
    expect(result.candidates).toHaveLength(2);

    const monthly = candidateFor(result.candidates, 'monthly');
    expect(monthly).toMatchObject({
      offerId: 'curated-designco-team-monthly',
      currency: 'USD',
      commitmentMonths: 0,
      priceStatus: 'price_unverified',
      availability: 'available',
      upfrontMinor: 6000,
      perChargeMinor: 6000,
      horizonCost: { lowMinor: 72000, highMinor: 72000 },
      monthlyRunRateMinor: { lowMinor: 6000, highMinor: 6000 },
    });
    expect(monthly.merchantCategoryCode).toBe('7372');

    const annual = candidateFor(result.candidates, 'annual');
    expect(annual).toMatchObject({
      offerId: 'curated-designco-team-annual',
      currency: 'USD',
      commitmentMonths: 12,
      upfrontMinor: 60000,
      perChargeMinor: 60000,
      horizonCost: { lowMinor: 60000, highMinor: 60000 },
      monthlyRunRateMinor: { lowMinor: 5000, highMinor: 5000 },
    });
  });

  it('sorts by horizon high cost, then upfront cost', async () => {
    const result = compareOffers(await designOffers(), usage);
    expect(result.candidates.map((candidate) => candidate.plan)).toEqual([
      'annual',
      'monthly',
    ]);
    expect(result.candidates.map((candidate) => candidate.horizonCost.highMinor)).toEqual([
      60000,
      72000,
    ]);
  });

  it('rounds annual horizons up to whole years: 18 months costs two years', async () => {
    const result = compareOffers(await designOffers(), {
      horizonMonths: 18,
      seats: 5,
    });

    const annual = candidateFor(result.candidates, 'annual');
    expect(annual.horizonCost).toEqual({ lowMinor: 120000, highMinor: 120000 });
    expect(annual.monthlyRunRateMinor).toEqual({ lowMinor: 5000, highMinor: 5000 });

    const monthly = candidateFor(result.candidates, 'monthly');
    expect(monthly.horizonCost).toEqual({ lowMinor: 108000, highMinor: 108000 });

    // Monthly is cheaper over 18 months, so it now sorts first.
    expect(result.candidates.map((candidate) => candidate.plan)).toEqual([
      'monthly',
      'annual',
    ]);
  });

  it('adds a price_unverified note instead of claiming savings', async () => {
    const offers = await designOffers();
    const annual = toCandidate(offerFor(offers, 'annual'), usage);
    expect(annual.notes).toContain(PRICE_UNVERIFIED_NOTE);
  });

  it('keeps the total plan price when requested seats exceed the plan', async () => {
    const offers = await designOffers();
    const result = compareOffers(offers, { horizonMonths: 12, seats: 6 });
    const monthly = candidateFor(result.candidates, 'monthly');

    expect(monthly.horizonCost).toEqual({ lowMinor: 72000, highMinor: 72000 });
    expect(monthly.notes.some((note) => note.includes('seats exceed plan'))).toBe(true);
  });

  it('does not add a seat warning when the request fits the plan', async () => {
    const offers = await designOffers();
    const monthly = toCandidate(offerFor(offers, 'monthly'), {
      horizonMonths: 12,
      seats: 5,
    });
    expect(monthly.notes.some((note) => note.includes('seats exceed plan'))).toBe(false);
  });
});

describe('toCandidate: usage plans', () => {
  it('turns an x402 per-call snapshot into a cost range', async () => {
    const offers = await createX402SnapshotSource().listOffers({ intent: 'weather' });
    expect(offers).toHaveLength(1);

    const candidate = toCandidate(offers[0] as Offer, {
      horizonMonths: 12,
      callsPerMonth: { low: 1000, high: 5000 },
    });

    expect(candidate).toMatchObject({
      sourceId: 'x402-snapshot',
      plan: 'usage',
      currency: 'USD',
      commitmentMonths: 0,
      priceStatus: 'price_unverified',
      upfrontMinor: 0,
      perChargeMinor: 500,
      horizonCost: { lowMinor: 1200, highMinor: 6000 },
      monthlyRunRateMinor: { lowMinor: 100, highMinor: 500 },
    });
    expect(candidate.merchantCategoryCode).toBeUndefined();
    expect(candidate.notes).toContain('usage-based: units differ; range only');
  });

  it('honours the low bound of the calls range', async () => {
    const [offer] = await createX402SnapshotSource().listOffers({ intent: 'weather' });
    if (!offer) throw new Error('missing weather snapshot offer');

    const candidate = toCandidate(offer, {
      horizonMonths: 6,
      callsPerMonth: { low: 1000, high: 1000 },
    });
    expect(candidate.horizonCost).toEqual({ lowMinor: 600, highMinor: 600 });
    expect(candidate.perChargeMinor).toBe(100);
  });

  it('reports usage unknown with a zero range when callsPerMonth is missing', async () => {
    const [offer] = await createX402SnapshotSource().listOffers({ intent: 'weather' });
    if (!offer) throw new Error('missing weather snapshot offer');

    const candidate = toCandidate(offer, { horizonMonths: 12 });
    expect(candidate.horizonCost).toEqual({ lowMinor: 0, highMinor: 0 });
    expect(candidate.perChargeMinor).toBe(0);
    expect(candidate.notes).toContain('usage_unknown');
    expect(candidate.notes.some((note) => note.includes('usage unknown'))).toBe(true);
  });

  it('sorts unknown usage after priced candidates regardless of input order', async () => {
    const [unknown] = await createX402SnapshotSource().listOffers({ intent: 'weather' });
    if (!unknown) throw new Error('missing weather snapshot offer');
    const priced = offerFor(await designOffers(), 'monthly');
    for (const offers of [[unknown, priced], [priced, unknown]]) {
      const result = compareOffers(offers, { horizonMonths: 12 });
      expect(result.candidates.map(candidate => candidate.offerId)).toEqual([priced.id, unknown.id]);
      expect(result.candidates[1]?.notes).toContain('usage_unknown');
    }
  });

  it('converts per_1k_units prices using unitsPerMonth', async () => {
    const offers = await createCuratedSource().listOffers({
      intent: 'openai',
      billingCountry: 'US',
      cardCountry: 'US',
    });
    const openai = offerFor(offers, 'usage');

    const candidate = toCandidate(openai, {
      horizonMonths: 12,
      unitsPerMonth: { low: 10000, high: 20000 },
    });

    expect(candidate.monthlyRunRateMinor).toEqual({ lowMinor: 150, highMinor: 300 });
    expect(candidate.horizonCost).toEqual({ lowMinor: 1800, highMinor: 3600 });
    expect(candidate.perChargeMinor).toBe(300);
  });
});

describe('toCandidate: one-time plans', () => {
  it('charges the full price once and spreads the run rate over the horizon', async () => {
    const annual = offerFor(await designOffers(), 'annual');
    const oneTime: Offer = {
      ...annual,
      id: 'curated-designco-team-one-time',
      plan: 'one_time',
      price: { amount: '600.00', currency: 'USD', unit: 'one_time' },
      commitmentMonths: 0,
    };

    const candidate = toCandidate(oneTime, { horizonMonths: 12 });
    expect(candidate).toMatchObject({
      plan: 'one_time',
      upfrontMinor: 60000,
      perChargeMinor: 60000,
      horizonCost: { lowMinor: 60000, highMinor: 60000 },
      monthlyRunRateMinor: { lowMinor: 5000, highMinor: 5000 },
    });
  });
});

describe('compareOffers: exclusions and currencies', () => {
  const usage: UsageProfile = { horizonMonths: 12 };

  it('moves the region-restricted OpenAI offer into excluded', async () => {
    const offers = await createCuratedSource().listOffers({
      intent: 'openai api',
      billingCountry: 'HK',
      cardCountry: 'HK',
    });
    expect(offers).toHaveLength(1);
    expect(offers[0]?.availability).toBe('region_unavailable');

    const result = compareOffers(offers, usage);
    expect(result.candidates).toEqual([]);
    expect(result.excluded).toEqual([
      { offerId: 'curated-openai-api', reason: 'region_unavailable' },
    ]);
  });

  it('refuses to turn a region_unavailable offer into a candidate directly', async () => {
    const [offer] = await createCuratedSource().listOffers({
      intent: 'openai api',
      billingCountry: 'HK',
      cardCountry: 'HK',
    });
    if (!offer) throw new Error('missing OpenAI offer');

    expect(() => toCandidate(offer, usage)).toThrow(/region_unavailable/);
  });

  it('keeps OpenAI as a candidate when the region is allowed', async () => {
    const offers = await createCuratedSource().listOffers({
      intent: 'openai api',
      billingCountry: 'US',
      cardCountry: 'US',
    });
    const result = compareOffers(offers, usage);
    expect(result.excluded).toEqual([]);
    expect(result.candidates.map((candidate) => candidate.offerId)).toEqual([
      'curated-openai-api',
    ]);
  });

  it('does not convert currencies and notes a mixed-currency result', async () => {
    const annual = offerFor(await designOffers(), 'annual');
    const eur: Offer = {
      ...annual,
      id: 'curated-designco-team-annual-eur',
      price: { ...annual.price, currency: 'EUR' },
    };

    const result = compareOffers([annual, eur], usage);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.currency).sort()).toEqual([
      'EUR',
      'USD',
    ]);
    expect(
      result.candidates.every((candidate) =>
        candidate.notes.some((note) => note.includes('mixed currencies')),
      ),
    ).toBe(true);
  });

  it('does not add the mixed-currency note for a single currency', async () => {
    const result = compareOffers(await designOffers(), usage);
    expect(
      result.candidates.every(
        (candidate) => !candidate.notes.some((note) => note.includes('mixed currencies')),
      ),
    ).toBe(true);
  });
});

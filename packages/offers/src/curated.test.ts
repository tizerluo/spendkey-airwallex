import { describe, expect, it } from 'vitest';
import { createCuratedSource } from './curated.js';
import { readFixture } from './fixtures.js';
import { OfferListSchema } from './offer.js';

const source = createCuratedSource();

describe('curated source', () => {
  it('filters by category, case-insensitively', async () => {
    const offers = await source.listOffers({ intent: 'designco', category: 'DESIGN-TOOLS' });
    expect(offers.map((offer) => offer.plan).sort()).toEqual(['annual', 'monthly']);
    expect(offers.every((offer) => offer.seats === 5)).toBe(true);
  });

  it('matches intent keywords against vendor, product, and category', async () => {
    const goat = await source.listOffers({ intent: 'goat' });
    expect(goat.map((offer) => offer.vendor)).toEqual(['GOAT']);

    const opencode = await source.listOffers({ intent: 'OPENCODE subscription' });
    expect(opencode.map((offer) => offer.vendor)).toEqual(['OpenCode']);

    const design = await source.listOffers({ intent: 'design tool' });
    expect(design).toHaveLength(2);
  });

  it('returns no offers when category and intent disagree', async () => {
    const offers = await source.listOffers({ intent: 'weather', category: 'design-tools' });
    expect(offers).toEqual([]);
  });

  it('forces GOAT to price_unverified even when the fixture claims verified', async () => {
    const raw = readFixture('curated-offers.json', OfferListSchema);
    const rawGoat = raw.find((offer) => offer.vendor === 'GOAT');
    expect(rawGoat?.priceStatus).toBe('verified');
    if (!rawGoat) throw new Error('GOAT fixture is missing');

    const goat = await source.listOffers({ intent: 'goat' });
    expect(goat).toHaveLength(1);
    expect(goat[0]?.priceStatus).toBe('price_unverified');

    const injected = createCuratedSource([
      { ...rawGoat, priceStatus: 'verified' },
    ]);
    const injectedGoat = await injected.listOffers({ intent: 'goat' });
    expect(injectedGoat[0]?.priceStatus).toBe('price_unverified');
  });

  it('marks the OpenAI offer region_unavailable when HK is excluded', async () => {
    const offers = await source.listOffers({
      intent: 'openai api',
      billingCountry: 'HK',
      cardCountry: 'HK',
    });
    expect(offers).toHaveLength(1);
    expect(offers[0]?.availability).toBe('region_unavailable');

    const allowed = await source.listOffers({
      intent: 'openai api',
      billingCountry: 'US',
      cardCountry: 'US',
    });
    expect(allowed[0]?.availability).toBe('available');
  });

  it.each(['goat', 'GoAt', 'Goatee'])('matches only the exact vendor name case-insensitively: %s', async vendor => {
    const rawGoat = readFixture('curated-offers.json', OfferListSchema).find(offer => offer.vendor === 'GOAT');
    if (!rawGoat) throw new Error('GOAT fixture is missing');
    // Keep "goat" in the ID and product to prove these do not trigger the rule.
    const injected = createCuratedSource([{ ...rawGoat, vendor, product: 'GOAT comparison', priceStatus: 'verified' }]);
    const offers = await injected.listOffers({ intent: '' });
    expect(offers).toHaveLength(1);
    expect(offers[0]?.priceStatus).toBe(vendor === 'Goatee' ? 'verified' : 'price_unverified');
  });

  it('applies the region rule when only the card country is excluded', async () => {
    const offers = await source.listOffers({ intent: 'openai', cardCountry: 'HK' });
    expect(offers[0]?.availability).toBe('region_unavailable');
  });

  it('keeps every curated candidate price_unverified', async () => {
    const offers = await source.listOffers({ intent: '' });
    expect(offers).toHaveLength(6);
    expect(offers.every((offer) => offer.priceStatus === 'price_unverified')).toBe(true);
  });
});

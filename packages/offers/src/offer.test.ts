import { describe, expect, it } from 'vitest';
import { readFixture } from './fixtures.js';
import { OfferListSchema, OfferSchema } from './offer.js';
import { defaultSnapshot, X402SnapshotSchema } from './x402-snapshot.js';

describe('offer fixtures', () => {
  it('validates every curated offer against OfferSchema', () => {
    const offers = readFixture('curated-offers.json', OfferListSchema);
    expect(offers).toHaveLength(6);
    for (const offer of offers) {
      expect(OfferSchema.safeParse(offer).success).toBe(true);
    }
    expect(new Set(offers.map((offer) => offer.id)).size).toBe(offers.length);
  });

  it('validates every x402 snapshot entry', () => {
    const entries = readFixture('x402-snapshot.json', X402SnapshotSchema);
    expect(entries.length).toBeGreaterThanOrEqual(5);
    expect(entries.length).toBeLessThanOrEqual(8);
    for (const entry of entries) {
      expect(entry.network).toBe('celo');
      expect(entry.resource.startsWith('https://')).toBe(true);
    }
    expect(defaultSnapshot).toEqual(entries);
  });

  it('rejects malformed amounts, currencies, and unknown fields', () => {
    const [sample] = readFixture('curated-offers.json', OfferListSchema);
    expect(sample).toBeDefined();
    if (!sample) return;

    expect(OfferSchema.safeParse({
      ...sample,
      price: { ...sample.price, amount: '1e3' },
    }).success).toBe(false);
    expect(OfferSchema.safeParse({
      ...sample,
      price: { ...sample.price, currency: 'usd' },
    }).success).toBe(false);
    expect(OfferSchema.safeParse({ ...sample, unexpected: true }).success).toBe(false);
  });
});

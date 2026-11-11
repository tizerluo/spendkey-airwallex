import { describe, expect, it } from 'vitest';
import { createX402SnapshotSource, defaultSnapshot } from './x402-snapshot.js';

const source = createX402SnapshotSource();

describe('x402 snapshot source', () => {
  it('maps every snapshot entry to a usage offer without network access', async () => {
    const offers = await source.listOffers({ intent: '' });
    expect(offers).toHaveLength(defaultSnapshot.length);
    expect(offers.length).toBeGreaterThanOrEqual(5);
    expect(offers.length).toBeLessThanOrEqual(8);

    for (const offer of offers) {
      expect(offer.sourceId).toBe('x402-snapshot');
      expect(offer.plan).toBe('usage');
      expect(offer.price.unit).toBe('per_call');
      expect(offer.price.currency).toBe('USD');
      expect(offer.priceStatus).toBe('price_unverified');
      expect(offer.commitmentMonths).toBe(0);
      expect(offer.notes?.toLowerCase()).toContain('usdc');
      expect(offer.sourceUrl?.startsWith('https://')).toBe(true);
    }
  });

  it('preserves USDC amounts and captured timestamps', async () => {
    const offers = await source.listOffers({ intent: 'weather' });
    expect(offers).toHaveLength(1);
    expect(offers[0]?.price.amount).toBe('0.001');
    expect(offers[0]?.sourceUrl).toBe('https://api.weather.example.com/weather/current');
    expect(offers[0]?.capturedAt).toBe('2026-10-25T12:00:00.000Z');
  });

  it('filters by category and intent keyword', async () => {
    const ocr = await source.listOffers({ intent: '', category: 'ocr' });
    expect(ocr).toHaveLength(1);
    expect(ocr[0]?.product).toContain('OCR');

    const translate = await source.listOffers({ intent: 'translate text' });
    expect(translate).toHaveLength(1);
    expect(translate[0]?.vendor).toBe('api.translate.example.com');
  });

  it('treats the snapshot as read-only data', async () => {
    const before = structuredClone(defaultSnapshot);
    await source.listOffers({ intent: '' });
    expect(defaultSnapshot).toEqual(before);
  });
});

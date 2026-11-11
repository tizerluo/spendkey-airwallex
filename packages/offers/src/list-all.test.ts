import { describe, expect, it } from 'vitest';
import { curatedOffers, createCuratedSource } from './curated.js';
import { listAllOffers } from './list-all.js';
import type { OfferSource } from './source.js';
import { createX402SnapshotSource, defaultSnapshot } from './x402-snapshot.js';

describe('listAllOffers', () => {
  it('merges sources and de-duplicates by offer id', async () => {
    const x402 = createX402SnapshotSource();
    const duplicate: OfferSource = {
      id: 'x402-snapshot',
      listOffers: (query) => x402.listOffers(query),
    };

    const result = await listAllOffers(
      [createCuratedSource(), x402, duplicate],
      { intent: '' },
    );

    expect(result.errors).toEqual([]);
    expect(result.offers).toHaveLength(curatedOffers.length + defaultSnapshot.length);
    const ids = result.offers.map((offer) => offer.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps working when one source fails', async () => {
    const failing: OfferSource = {
      id: 'curated',
      async listOffers() {
        throw new Error('fixture is offline');
      },
    };

    const result = await listAllOffers(
      [failing, createX402SnapshotSource()],
      { intent: '' },
    );

    expect(result.offers).toHaveLength(defaultSnapshot.length);
    expect(result.errors).toEqual([
      { sourceId: 'curated', message: 'fixture is offline' },
    ]);
  });

  it('collects non-Error rejections without throwing', async () => {
    const failing: OfferSource = {
      id: 'curated',
      listOffers: async () => Promise.reject('not an error'),
    };

    const result = await listAllOffers([failing], { intent: '' });
    expect(result.offers).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain('non-Error');
  });

  it('applies the query across sources', async () => {
    const result = await listAllOffers(
      [createCuratedSource(), createX402SnapshotSource()],
      { intent: 'designco', category: 'design-tools' },
    );

    expect(result.errors).toEqual([]);
    expect(result.offers.map((offer) => offer.plan).sort()).toEqual(['annual', 'monthly']);
  });
});

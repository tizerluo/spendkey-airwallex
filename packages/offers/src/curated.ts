import { readFixture } from './fixtures.js';
import { OfferListSchema, OfferSchema, type Offer } from './offer.js';
import { filterOffers, type OfferQuery, type OfferSource } from './source.js';

function isGoatOffer(offer: Offer): boolean {
  return offer.vendor.toLowerCase() === 'goat';
}

/**
 * GOAT is never treated as verified, even if a fixture or caller claims it is.
 * This rule belongs to the source so it cannot be bypassed by injected data.
 */
export function applyCuratedSourceRules(offer: Offer): Offer {
  if (!isGoatOffer(offer) || offer.priceStatus === 'price_unverified') return offer;
  return { ...offer, priceStatus: 'price_unverified' };
}

export const curatedOffers: readonly Offer[] = readFixture('curated-offers.json', OfferListSchema)
  .map(applyCuratedSourceRules);

export function createCuratedSource(data: readonly Offer[] = curatedOffers): OfferSource {
  return {
    id: 'curated',
    async listOffers(query: OfferQuery): Promise<Offer[]> {
      const normalized = data.map((offer) => applyCuratedSourceRules(OfferSchema.parse(offer)));
      return filterOffers(normalized, query);
    },
  };
}

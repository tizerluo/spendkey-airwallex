import type { Offer } from './offer.js';
import type { OfferQuery, OfferSource } from './source.js';

export interface OfferSourceError {
  sourceId: string;
  message: string;
}

export interface ListAllOffersResult {
  offers: Offer[];
  errors: OfferSourceError[];
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message;
  return 'Source failed with a non-Error rejection';
}

/**
 * Merge candidate offers from every source. A failing source contributes an
 * entry to errors instead of failing the whole search, and duplicate ids keep
 * the first offer seen (source order is preserved).
 */
export async function listAllOffers(
  sources: readonly OfferSource[],
  query: OfferQuery,
): Promise<ListAllOffersResult> {
  const settled = await Promise.allSettled(
    sources.map(async (source) => ({
      sourceId: source.id,
      offers: await source.listOffers(query),
    })),
  );

  const offers: Offer[] = [];
  const errors: OfferSourceError[] = [];
  const seen = new Set<string>();

  settled.forEach((result, index) => {
    if (result.status === 'rejected') {
      errors.push({
        sourceId: sources[index]?.id ?? `unknown-source-${index}`,
        message: errorMessage(result.reason),
      });
      return;
    }
    for (const offer of result.value.offers) {
      if (seen.has(offer.id)) continue;
      seen.add(offer.id);
      offers.push(offer);
    }
  });

  return { offers, errors };
}

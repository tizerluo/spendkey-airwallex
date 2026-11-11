import type { Offer, OfferSourceId } from './offer.js';

export interface OfferQuery {
  intent: string;
  category?: string;
  billingCountry?: string;
  cardCountry?: string;
}

export interface OfferSource {
  id: OfferSourceId;
  listOffers(query: OfferQuery): Promise<Offer[]>;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'buy', 'by', 'for', 'from', 'get',
  'i', 'in', 'into', 'is', 'it', 'me', 'my', 'need', 'of', 'on', 'or', 'our',
  'please', 'purchase', 'the', 'to', 'want', 'we', 'with',
]);

function intentTokens(intent: string): string[] {
  return (intent.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

/** Simple keyword match: every meaningful intent token appears in vendor, product, or category. */
export function matchesIntent(offer: Offer, intent: string): boolean {
  const tokens = intentTokens(intent);
  if (tokens.length === 0) return true;
  const haystack = `${offer.vendor} ${offer.product} ${offer.category}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function excludesCountry(
  countries: readonly string[] | undefined,
  country: string | undefined,
): boolean {
  if (country === undefined || countries === undefined) return false;
  return !countries.some((candidate) => candidate.toUpperCase() === country);
}

/**
 * Region restrictions are negative examples, not hidden results: an offer that
 * excludes the query region is kept and flagged as region_unavailable.
 */
export function withRegionAvailability(offer: Offer, query: OfferQuery): Offer {
  const billingCountry = query.billingCountry?.toUpperCase();
  const cardCountry = query.cardCountry?.toUpperCase();
  const excluded =
    excludesCountry(offer.regions?.billingCountries, billingCountry) ||
    excludesCountry(offer.regions?.cardCountries, cardCountry);
  if (!excluded) return offer;
  return { ...offer, availability: 'region_unavailable' };
}

export function filterOffers(offers: readonly Offer[], query: OfferQuery): Offer[] {
  const category = query.category?.trim().toLowerCase();
  return offers
    .filter((offer) => !category || offer.category.toLowerCase() === category)
    .filter((offer) => matchesIntent(offer, query.intent))
    .map((offer) => withRegionAvailability(offer, query));
}

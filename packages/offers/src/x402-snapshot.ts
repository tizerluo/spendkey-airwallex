import { z } from 'zod';
import { readFixture } from './fixtures.js';
import { DecimalAmountSchema, OfferSchema, type Offer } from './offer.js';
import { filterOffers, type OfferQuery, type OfferSource } from './source.js';

/** One captured x402 listing. This is a read-only snapshot, never a live lookup. */
export const X402SnapshotEntrySchema = z.object({
  resource: z.string().url().regex(/^https:\/\//i),
  description: z.string().min(1),
  priceUsdc: DecimalAmountSchema,
  network: z.literal('celo'),
  capturedAt: z.string().datetime({ offset: true }),
}).strict();

export const X402SnapshotSchema = z.array(X402SnapshotEntrySchema);

export type X402SnapshotEntry = z.infer<typeof X402SnapshotEntrySchema>;

export const defaultSnapshot: readonly X402SnapshotEntry[] = readFixture(
  'x402-snapshot.json',
  X402SnapshotSchema,
);

function categoryFromResource(resource: string): string {
  const [segment] = new URL(resource).pathname.split('/').filter(Boolean);
  return segment?.toLowerCase() ?? 'api';
}

function vendorFromResource(resource: string): string {
  return new URL(resource).hostname;
}

function toOffer(entry: X402SnapshotEntry): Offer {
  return OfferSchema.parse({
    id: `x402:${entry.resource}`,
    sourceId: 'x402-snapshot',
    vendor: vendorFromResource(entry.resource),
    product: entry.description,
    plan: 'usage',
    category: categoryFromResource(entry.resource),
    price: {
      amount: entry.priceUsdc,
      currency: 'USD',
      unit: 'per_call',
    },
    commitmentMonths: 0,
    cancellation: 'Pay per call; no subscription commitment',
    priceStatus: 'price_unverified',
    availability: 'available',
    sourceUrl: entry.resource,
    capturedAt: entry.capturedAt,
    notes: `Synthetic x402 snapshot listing. Price is quoted in USDC per call on ${entry.network}; the USD amount is a placeholder, not a live quote.`,
  });
}

export function createX402SnapshotSource(
  snapshot: readonly X402SnapshotEntry[] = defaultSnapshot,
): OfferSource {
  return {
    id: 'x402-snapshot',
    async listOffers(query: OfferQuery): Promise<Offer[]> {
      const offers = snapshot.map((entry) => toOffer(X402SnapshotEntrySchema.parse(entry)));
      return filterOffers(offers, query);
    },
  };
}

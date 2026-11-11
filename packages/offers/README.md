# @sk/offers

Offline candidate-offer sources for the Spendkey intent-bound purchase agent
(Airwallex hackathon).

An **offer** is one purchasable option for a purchase intent: vendor, product,
plan, native price/unit, commitment, cancellation terms, region restrictions,
and a price-confidence status. Units are deliberately **not normalised or
converted** (`per_month`, `per_year`, `per_call`, `per_1k_units`, `one_time`);
comparison is a later milestone.

## Sources

### `createCuratedSource(data?)`

Reads `fixtures/curated-offers.json` and returns hand-curated candidates:
X API credits, OpenCode Go, GOAT Pro, OpenAI API, and DesignCo Team with both
monthly and annual plans (5 seats). It filters by category and by a simple
case-insensitive keyword match of the intent against vendor/product/category.

Two source-level rules matter:

- **GOAT is always forced to `priceStatus: "price_unverified"`**, even if the
  fixture or injected data claims otherwise.
- **Region restrictions are kept as negative examples.** If a query supplies
  `billingCountry`/`cardCountry` and an offer's `regions` list excludes it, the
  offer is returned with `availability: "region_unavailable"` rather than being
  dropped. The OpenAI fixture excludes `HK` for both billing and card country.

### `createX402SnapshotSource(snapshot?)`

Reads `fixtures/x402-snapshot.json`: 5-8 captured pay-per-call API listings on
Celo. Each entry becomes an offer with `plan: "usage"`, `unit: "per_call"`,
`currency: "USD"`, `sourceId: "x402-snapshot"`, and
`priceStatus: "price_unverified"`. The prices are USDC per call and are noted as
such; the USD amount is a placeholder. This source is strictly read-only: it
never fetches a resource and never makes a payment.

## Merging

`listAllOffers(sources, query)` merges results from multiple sources,
de-duplicates by offer `id` (first occurrence wins), and never throws when a
source fails. Failures are reported in `errors: [{ sourceId, message }]` while
offers from healthy sources are still returned.

```ts
import { createCuratedSource, createX402SnapshotSource, listAllOffers } from '@sk/offers';

const { offers, errors } = await listAllOffers(
  [createCuratedSource(), createX402SnapshotSource()],
  { intent: 'design tool', billingCountry: 'US', cardCountry: 'US' },
);
```

## Fixture prices

**All prices in the fixtures are synthetic examples** unless a record is
explicitly marked `priceStatus: "verified"`. The GOAT fixture intentionally
claims `verified` only to exercise the source-level override; no curated or
x402 output is actually verified. All URLs use `example.com`, all values are
fictional, and tests run fully offline (global `fetch` is a throwing stub).

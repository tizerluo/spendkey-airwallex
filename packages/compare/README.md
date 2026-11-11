# @sk/compare

Turns `@sk/offers` offers into comparable **candidates** for the Spendkey
intent-bound purchase agent. All money math is local, deterministic, and
integer-based; this package performs no network calls and never converts
currencies.

## Money model

- Money is integer **minor units** (`MinorAmount = number`, for example cents).
  Values must be non-negative safe integers.
- Decimal strings are parsed with strict helpers. `parseDecimalToMinor("12.5")`
  returns `1250`; more than two decimals, signs, exponents, thousands separators,
  and unsafe results throw.
- Per-call/usage prices keep `unitPriceMicros` precision (millionths of the
  currency unit) so a `$0.001` call price is not rounded to `$0.00`.
- Micros are converted to minor units by rounding **up**, so a tiny charge is
  never hidden.

```ts
import { minorToDecimal, parseDecimalToMinor, parseDecimalToMicros } from '@sk/compare';

parseDecimalToMinor('12.50');   // 1250
parseDecimalToMicros('0.001');  // 1000
minorToDecimal(1250);           // '12.50'
```

## Candidates

```ts
import { compareOffers } from '@sk/compare';
import { createCuratedSource, createX402SnapshotSource } from '@sk/offers';

const offers = [
  ...(await createCuratedSource().listOffers({ intent: 'design tool' })),
  ...(await createX402SnapshotSource().listOffers({ intent: 'weather' })),
];

const { candidates, excluded } = compareOffers(offers, {
  horizonMonths: 12,
  seats: 5,
  callsPerMonth: { low: 1000, high: 5000 },
});
```

Each candidate carries:

| Field | Meaning |
| --- | --- |
| `upfrontMinor` | Cash leaving at purchase time |
| `perChargeMinor` | Largest single expected card charge |
| `horizonCost` | Total cost over `horizonMonths`, as a range |
| `monthlyRunRateMinor` | Monthly cost, as a range |
| `notes` | Human-readable explanations (unverified price, usage range, seats, mixed currencies) |

Candidates are sorted by `horizonCost.highMinor` ascending, then
`upfrontMinor`.

## Plan rules

| Offer plan | Upfront | Per charge | Horizon | Monthly run rate |
| --- | --- | --- | --- | --- |
| `monthly` (`per_month`) | 1 month | 1 month | price × months | price |
| `annual` (`per_year`) | full year | full year | price × ceil(months / 12) | ceil(price / 12) |
| `usage` (`per_call`) | 0 | high monthly bill | monthly range × months | calls × unit price |
| `usage` (`per_1k_units`) | 0 | high monthly bill | monthly range × months | units / 1000 × unit price |
| `one_time` | price | price | price | ceil(price / months) |

Usage costs use `callsPerMonth` or `unitsPerMonth`. When the relevant profile is
missing, the candidate keeps a `0.00` range and adds a `usage unknown` note
instead of inventing demand.

### Seats

The offer price is always treated as the **total plan price** for the seats the
offer states. Seats are never multiplied. If `usage.seats` exceeds
`offer.seats`, the price stays unchanged and the candidate gets a
`seats exceed plan` note. If the offer does not state seats, its price is still
treated as the total plan price.

## Exclusions and confidence

- Offers with `availability: "region_unavailable"` are never candidates. They
  appear in `excluded` as `{ offerId, reason: 'region_unavailable' }` so the
  agent can explain the restriction.
- `price_unverified` candidates get
  `price_unverified: amount shown, no savings claim`.
- Mixed currencies are not converted. Every candidate gets a `mixed currencies`
  note and the caller must compare within a currency.

## Schemas

`CandidateSchema` and `UsageProfileSchema` validate values at runtime. Prices in
offers are synthetic fixtures; nothing in this package is a live quote.

Run `pnpm --filter @sk/compare test`, `build`, `typecheck` or `lint` from the
repository root. All tests are offline: global `fetch` is a throwing stub.

# @sk/policy

Offline policy and human approval for Spendkey card purchases. The agent can
return only `ask` or `refuse`; issuance requires a separate human approval.
There are no network calls in this package and no dependency on `@sk/compare`.

`Candidate`, `MinorAmount`, and `UsageProfile` copy the shared M2 structural
contract. All cost fields are nonnegative safe integer **minor units (cents)**.
Normalization belongs upstream: retain per-call prices as integer
`unitPriceMicros` there, and pass normalized cost ranges into policy. Never
round a sub-cent unit price into cents before calculating usage costs.

`decimalToMinor` accepts an Airwallex decimal string or number, splits the
whole and fractional digits, pads to two places, and rejects excess precision,
NaN, infinity, negative values and unsafe results. It does not use floating
point multiplication or rounding. `minorToDecimal` returns a two-place string.
This cents contract assumes two decimal places for every supported currency;
there is no FX conversion or currency-exponent lookup.

## Rules and context

`evaluateRules(candidate, ctx)` always returns all four results for valid input,
in order: `reserve_floor`, `window_budget`, `commitment_cap`, `region`.
The individual pure functions are `reserveFloor`, `windowBudget`,
`commitmentCap`, and `region`. Each result has `rule`, `pass`, `code`, `detail`.
Invalid numeric inputs throw rather than permitting a purchase.

`PolicyContext` uses:

- `balances`: Airwallex `getBalances()` records, or their `currency` and
  `available_amount` fields. Duplicate records for the candidate currency are
  rejected to avoid silently selecting or summing ambiguous balances.
- `knownObligations`: `{ currency, amountMinor, dueInDays }[]`. `dueInDays` is
  a whole-day offset relative to the balance snapshot. Include days **0 through
  reserveHorizonDays**, inclusive; exclude past obligations and other currencies.
- `reserveFloorMinor`: floors keyed by currency. Missing balance or floor fails
  with `reserve_unknown_currency`; a shortfall gives `reserve_breach`.
- `budgetCurrency`, `spentInWindowMinor`, `windowBudgetMinor`: one window in
  one currency. Compare the largest expected single charge, not upfront cash.
  Mismatch gives `budget_currency_mismatch`; excess gives `budget_exceeded`.
- `maxCommitmentMonths`: inclusive maximum; excess gives `commitment_too_long`.
- `billingCountry`, `cardCountry`: the only countries relevant to availability.
  Candidate availability must already be resolved upstream against these two
  countries. Candidate has no region allowlists to re-evaluate here. There is
  no IP, nationality or citizenship check. Unavailability gives `region_unavailable`.

Success codes are `reserve_ok`, `budget_ok`, `commitment_ok`, and `region_ok`.
Callers must keep the balance/obligation snapshot and spending window current.
The package does not reserve funds or serialize concurrent purchase attempts.

`decidePurchase(candidates, ctx)` puts passing candidates first, then sorts by
`horizonCost.highMinor`, breaking ties with `upfrontMinor` (stable input order
for remaining ties). It asks for the cheapest passing candidate, or refuses
with every distinct failure code. Empty input refuses with empty reasons.
Unverified prices remain eligible, with `price_unverified` in reasons. Missing
MCC remains eligible, with `mcc_required_at_approval` in reasons.

The demo is deliberate: with 1000.00 USD available, 100.00 in obligations, and
a 500.00 reserve floor, a 480.00 annual purchase fails reserves even though it
costs less over twelve months than a 50.00 monthly plan. Monthly passes because
only its first 50.00 leaves the account at purchase time.

## Human approval and card controls

```ts
import {
  decidePurchase, createApprovalRequest, termsHash, approve, approvalToCardInput,
} from '@sk/policy';

const decision = decidePurchase(candidates, ctx);
if (decision.action === 'ask' && decision.chosen) {
  const request = createApprovalRequest(decision.chosen, {
    approvalRequestId: 'approval_request_test_01',
    createdAt: '2030-01-01T00:00:00Z',
    expiresAt: '2030-01-01T01:00:00Z',
  });
  // Present the request and hash to an authenticated human in the application.
  const presentedTermsHash = termsHash(request);
  const approval = approve(request, {
    approver: { kind: 'human', id: 'human_test_01' },
    presentedTermsHash,
    merchantCategoryCode: '5734', // Required if absent; cannot override a bound MCC.
    now: '2030-01-01T00:30:00Z',
  });
  const cardInput = approvalToCardInput(approval, {
    cardholderId: 'cardholder_test_01', createdBy: 'human_test_01',
    nickName: 'test-purchase',
  });
  // The application can pass cardInput to its injected Airwallex client.
}
```

The default interval is **PER_TRANSACTION for every plan**, including monthly.
It caps each charge at `perChargeMinor`; it does not promise a monthly aggregate
cap. Annual/one-time plans use `SINGLE`; monthly/usage plans use `MULTIPLE`.
Explicitly edited `MONTHLY` or `ALL_TIME` intervals must be presented and approved
with their changed hash before mapping.

`termsHash` reuses `@sr/core` audit canonical JSON and SHA-256. Its lowercase hex
digest binds exactly `offerId`, `vendor`, `plan`, `currency`, `amountMinor`,
`interval`, `allowedTransactionCount`, `merchantCategoryCode`,
`commitmentMonths`, and `expiresAt`. Undefined MCC is omitted canonically. Key
order is irrelevant. Product/display metadata, IDs, creation time and price
status are outside this specified hash contract.

`approve` requires a human, matching presented hash and an unexpired request
(expiration is exclusive). `ApprovalError.code` is `self_approval_forbidden`,
`terms_mismatch`, `approval_expired`, or `mcc_required`. A human must explicitly
supply a four-digit MCC if absent; approval records the hash of those completed
terms, which differs from the original MCC-free hash. The original request is
not mutated. Malformed requests or times throw validation errors; a timestamp
before creation is rejected. Human identity must be authenticated by the
application; the structural `kind: 'human'` field is not an authentication system.

The mapper verifies the recorded terms hash and MCC, emits a virtual personalized
commercial card, mirrors the approved currency in both currency controls, and
asserts the limit currency is allowed (`assertControlsCurrency`). It always
sets `request_id = cardRequestIdFromApproval(approval.approvalId)`; persist and
reuse the approval ID when retrying issuance. There is no random request-ID
fallback. Limits are JSON numbers compatible with Airwallex's schema; zero
limits and amounts that lose cents when serialized as numbers are rejected.
No broad or empty MCC controls are produced. `nickName` defaults to product.

## Development

From the repository root:

```sh
pnpm --filter @sk/policy build
pnpm --filter @sk/policy test
pnpm --filter @sk/policy typecheck
pnpm --filter @sk/policy lint
```

Vitest uses the repository's offline setup, which makes global fetch throw.
Tests cover all rule codes, reserve-versus-price selection, binding terms,
human approval, required MCCs, exact controls, safe money and deterministic
issuance IDs. No Airwallex or paid API requests are made.

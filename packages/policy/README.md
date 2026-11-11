# @sk/policy

Offline policy and human approval for Spendkey card purchases. The agent can
return only `ask` or `refuse`; issuance requires a separate human approval.
There are no network calls in this package and no runtime dependency on
`@sk/compare`; a development dependency checks the shared Candidate contract.

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
  refused with `reserve_ambiguous_balance` to avoid silently selecting or
  summing ambiguous balances. This returns a failing RuleResult, not an error.
- `knownObligations`: `{ currency, amountMinor, dueInDays }[]`. `dueInDays` is
  a whole-day offset relative to the balance snapshot. Overdue obligations
  (negative days) count as due now. Include every obligation due on or before
  `reserveHorizonDays`, inclusive; exclude later dates and other currencies.
- `reserveFloorMinor`: floors keyed by currency. Missing balance or floor fails
  with `reserve_unknown_currency`; a shortfall gives `reserve_breach`.
- `budgetCurrency`, `spentInWindowMinor`, `windowBudgetMinor`: one window in
  one currency. Compare the largest expected single charge, not upfront cash.
  Mismatch gives `budget_currency_mismatch`; excess gives `budget_exceeded`.
  A zero charge fails with `zero_charge_unknown_cost`, including usage offers
  whose missing usage profile produced a zero-cost placeholder.
- `maxCommitmentMonths`: inclusive maximum; excess gives `commitment_too_long`.
- `billingCountry`, `cardCountry`: the only countries relevant to availability.
  Candidate availability must already be resolved upstream against these two
  countries. Candidate has no region allowlists to re-evaluate here. There is
  no IP, nationality or citizenship check. Unavailability gives `region_unavailable`.

Success codes are `reserve_ok`, `budget_ok`, `commitment_ok`, and `region_ok`.
Callers must keep the balance/obligation snapshot and spending window current.
The package does not reserve funds or serialize concurrent purchase attempts.

`decidePurchase(candidates, ctx)` ranks only `rail: 'card'` candidates in
`budgetCurrency`. Other card currencies are ineligible and appear after the ranking in input order,
with the failing reason `currency_not_budgeted`; no FX comparison takes place.
This reason also appears in the decision reasons when such candidates exist.
Within the budget currency, it puts passing candidates first, then sorts by
`horizonCost.highMinor`, breaking ties with `upfrontMinor` (stable input order
for remaining ties). It asks for the cheapest passing candidate, or refuses
with every distinct failure code. Empty input refuses with empty reasons.
Unverified prices remain eligible, with `price_unverified` in reasons. Missing
MCC remains eligible, with `mcc_required_at_approval` in reasons.
Non-card candidates appear after all card rows in input order, with a failing
`rail` result and code `rail_not_card`. They remain visible for comparison and
can never be chosen; the decision reasons also report their rail exclusion.

The demo is deliberate: with 1000.00 USD available, 100.00 in obligations, and
a 500.00 reserve floor, a 480.00 annual purchase fails reserves even though it
costs less over twelve months than a 50.00 monthly plan. Monthly passes because
only its first 50.00 leaves the account at purchase time.

## Human approval and card controls

Trust boundary: `approve()` and `approvalToCardInput()` must run only in the
human-facing approval service, never in the agent process. That service must
authenticate the human and obtain their explicit approval of the presented
terms. It owns card issuance. The agent submits an ApprovalRequest across this
boundary; it cannot supply a trusted Approval or human identity. `kind: 'human'`
and `termsHash` are structural checks, not proof of authentication or origin:
code in the same process could forge both. This MVP relies on service isolation
and authenticated approval handling, with no HMAC on Approval objects.

The walkthrough below spans the agent and human-facing approval service;
the comment marks where execution moves to that service.

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
  const presentedTermsHash = termsHash(request);
  // Human-facing approval service only, after receiving request + hash and
  // authenticating the human who explicitly approves the displayed terms:
  const approval = approve(request, {
    approver: { kind: 'human', id: 'human_test_01' },
    presentedTermsHash,
    merchantCategoryCode: '5734', // Required if absent; cannot override a bound MCC.
    now: '2030-01-01T00:30:00Z',
  });
  const cardInput = approvalToCardInput(approval, {
    cardholderId: 'cardholder_test_01', createdBy: 'human_test_01',
  });
  // The application can pass cardInput to its injected Airwallex client.
}
```

Monthly/usage plans use **MONTHLY + MULTIPLE**, capping the aggregate charged
in each card monthly interval at the approved `perChargeMinor` (the monthly
price or high usage estimate). Annual/one-time plans use **PER_TRANSACTION +
SINGLE**: only one charge is allowed, bounded by the approved amount.
Any edited interval must be presented and approved with its changed hash.
Monthly card intervals do not coordinate several cards or arbitrary application
budget windows; callers must still keep window spending current.

`termsHash` reuses `@sr/core` audit canonical JSON and SHA-256. Its lowercase hex
digest binds exactly `offerId`, `vendor`, `plan`, `rail`, `currency`, `amountMinor`,
`interval`, `allowedTransactionCount`, `merchantCategoryCode`,
`commitmentMonths`, and `expiresAt`. Undefined MCC is omitted canonically. Key
order is irrelevant. Product/display metadata, IDs, creation time and price
status are outside this specified hash contract.

`approve` requires a human, matching presented hash and an unexpired request
(expiration is exclusive). `ApprovalError.code` is `self_approval_forbidden`,
`terms_mismatch`, `approval_expired`, `mcc_required`, or `rail_not_card`. Both
`createApprovalRequest`, `approve`, and `approvalToCardInput` reject non-card rails, even
when an MCC is present. Approval requests require the rail and bind it in the
terms hash. A human must explicitly
supply a four-digit MCC if absent; approval records the hash of those completed
terms, which differs from the original MCC-free hash. The original request is
not mutated. `createApprovalRequest` rejects zero `amountMinor` at validation,
before a human is asked to approve. Malformed requests or times throw validation errors; a timestamp
before creation is rejected. Human identity must be authenticated by the
application; the structural `kind: 'human'` field is not an authentication system.

The mapper verifies the recorded terms hash and MCC, emits a virtual personalized
commercial card, mirrors the approved currency in both currency controls, and
asserts the limit currency is allowed (`assertControlsCurrency`). It always
sets `request_id = cardRequestIdFromApproval(approval.approvalId)`; persist and
reuse the approval ID when retrying issuance. There is no random request-ID
fallback. Limits are JSON numbers compatible with Airwallex's schema; zero
limits and amounts that lose cents when serialized as numbers are rejected.
No broad or empty MCC controls are produced. Card nicknames use
`cardNicknameFromRequestId(request_id)` for recovery (`spk ${request_id}`, locally
bounded to 50 characters); the deprecated `nickName` option is ignored. Candidate
schemas in policy and compare reject `x402-snapshot` sources labelled as `card`.

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

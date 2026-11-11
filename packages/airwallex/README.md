# @sk/airwallex

Typed sandbox client for the Spendkey purchase agent. Responses are validated with
Zod; response amounts remain decimal strings or numbers exactly as received. No API calls
are made during tests. Full recorded-response validation is pending M1-G1.

```ts
import { AirwallexClient, loadAirwallexConfig } from '@sk/airwallex';

const client = new AirwallexClient(loadAirwallexConfig(), { fetch });
const balances = await client.getBalances();
await client.freezeCard('card_test_01');
```

Supply `AIRWALLEX_CLIENT_ID` and `AIRWALLEX_API_KEY` at runtime. The optional
`AIRWALLEX_BASE_URL` defaults to `https://api-demo.airwallex.com`. Configuration
hides the API key from string/JSON serialization. Only this sandbox origin is
accepted; there is no production-origin override.
Fetch redirects are rejected to keep credentials at their configured origin.

Tokens are cached and refreshed 60 seconds before expiry. Concurrent requests
share a login. An authenticated 401 triggers one re-login and one retry; other
errors are not retried. Callers must pass a stable `request_id` to `createCard`,
using `cardRequestIdFromApproval(approvalId)` to derive it deterministically
from the approval ID. The field is required by both the TypeScript type and
runtime schema; it is preserved across the 401 retry and separate calls.
Card limit and simulation inputs accept decimal strings or numbers, validated
as positive, finite amounts with at most two decimal places and sent as JSON numbers.
`listTransactions({ from, to, page })` sends `from_created_at`, `to_created_at`,
and `page_num`. Responses retain API names such as `card_id`, `cardholder_id`,
`transaction_id`, and `transaction_type`.

Field names not detailed in the smoke summary were checked against the official
[cards](https://www.airwallex.com/docs/api/issuing/cards),
[cardholders](https://www.airwallex.com/docs/api/issuing/cardholders),
[config](https://www.airwallex.com/docs/api/issuing/config), and
[transactions](https://www.airwallex.com/docs/api/issuing/transactions/list)
references. Card reads expose the purchase agent's subset; transaction and simulation
responses preserve unknown fields in redacted `extra` data.

`freezeCard` sets INACTIVE and `unfreezeCard` sets ACTIVE. Closing requires
`updateCardStatus(id, 'CLOSED', { irreversible: true })`. Card-details access is
guarded; no PAN/CVV endpoint is exposed. BIN-visible and spaced masks are
accepted. PAN-like digit runs are dropped from card-number fields and flagged
with `panLikeValueDropped: true`, without losing the card.

Verify webhooks with `verifyWebhookSignature` against the original raw body, then
call `parseWebhookEvent`. Verification returns a boolean, accepts millisecond or
clearly second epoch timestamps, and defaults to a five-minute window in either
direction. `ISSUING_EVENT_NAMES` lists card and transaction subscriptions of
interest. `VERIFIED_ISSUING_EVENT_NAMES` separately exports the confirmed names;
all seven current subscriptions are confirmed. The parser accepts other names
so consumers can safely ignore them.
API errors expose only status, code and a sanitized API message. Validation and
transport errors omit response bodies and request data. Successful creation
returns redacted response evidence as described below.

Confirmed against the official [Issuing webhook reference](https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events/issuing):
`issuing.card.active`, `issuing.card.inactive`, `issuing.card.closed`,
`issuing.card.modified`, `issuing.card.low_remaining_transaction_limit`,
`issuing.transaction.succeeded`, and `issuing.transaction.failed`.

Run `pnpm --filter @sk/airwallex test`, `build`, `typecheck` or `lint` from the root.

## Tolerant creation and recovery (M3-T1)

`createCard` returns a `CreateCardResult`, discriminated by `unconfirmed`:

- `{ ok: true, unconfirmed: false, card, raw }`: the normal response schema matched.
- `{ ok: true, unconfirmed: true, card?, raw }`: an unfamiliar successful response.
  Best-effort parsing retains a nonempty `card_id` and independently valid fields,
  even without a recognized status or controls. Do not infer activation or control
  enforcement from this result. Confirm with a subsequent card read.

Every HTTP 2xx is retained as success, including empty/non-JSON bodies and failed
body streams (`raw: { bodyReadFailed: true }`). A non-JSON 2xx is unconfirmed and
stored only as `{ nonJson: true, length, head }`, where `length` is the original
body length and `head` is the first 200 characters after redaction. Key/value
assignments whose names contain `pan`, `card_number`, `cvv`, `cvc`, `token`,
`secret`, `key`, `password`, `auth`, `security`, or `verification` are scrubbed
before that cut. No response-schema failure retries issuance or throws after a
2xx. Transport failures and non-2xx still throw.
Persist the result's `raw` with the approval/request ID before continuing; the
client returns evidence and does not write logs or storage itself. Raw diagnostics
recursively drop keys matching
`/pan|card_number(?!_masked)|cvv|cvc|token|secret|key|password|auth|credential|security|verification|expir/i`
(case-insensitive), the whole key `pin`, and a `number` key whose value is digit-like.
`masked_card_number` and `authorization_controls` are kept, also case-insensitively.
A string with 13 or more digits and no mask character is replaced entirely.
Digit runs of 13 or more are replaced, including numeric values, as are 13–19
digit runs separated by up to two non-letters or the mask letters `x`/`X`
(so `.`, `/`, `_`, and repeated spaces cannot hide a PAN under a kept key).
A string value that starts with `{` or `[` is parsed and walked, so credentials
embedded as JSON text are dropped by key. Current and previous authentication
tokens and runtime credentials are scrubbed. Consequently raw `card_number` is
omitted even when masked; the parsed card may safely keep a mask of at most 12
digits. A PAN-like value that fails that mask rule is dropped and flagged with
`panLikeValueDropped`, including values that contain a mask character but still
have 13 or more digits.

`listCards({ cardholderId?, createdAfter?, createdBefore?, updatedAfter?,
updatedBefore?, status?, nickName?, pageSize? })` collects all pages into
`{ items, unparsed }`. Individual unknown card formats retain redacted diagnostics.
`findCardByRequestId(requestId, { cardholderId?, createdAfter? })` scans those pages,
prefers a matching `request_id` when returned, and otherwise matches the exact
`cardNicknameFromRequestId(requestId)` only on rows without a request ID.
Several explicit `request_id` matches return the first. If `spk ${requestId}` is
longer than 50 characters, that nickname would be truncated, so recovery does not
use it and returns only an explicit `request_id` match. An explicit conflicting
ID never matches by nickname. No match returns `undefined`.
The approval mapper sets that same nickname (`spk ${requestId}`), ignoring the
legacy `nickName` option, so recovery works even if the API omits `request_id`.

Public documentation checked read-only on 2026-11-11:
[Issuing: List all Cards](https://www.airwallex.com/docs/api/issuing/cards/list)
confirms `GET /api/v1/issuing/cards`, zero-based `page_num`, `page_size` 10–200
(default 100), `cardholder_id`, exact-match `nick_name`, and inclusive
`from_created_at`, `to_created_at`, `from_updated_at`, `to_updated_at`, plus
`card_status`. Responses normally have `items` and `has_more`. Recovery also
accepts a `data` or `results` array when `items` is absent. A missing `has_more`
stops once a page is empty or shorter than `pageSize`. An empty page stops even
when `has_more` is true. A page whose first `card_id` repeats the previous page's
first `card_id` stops immediately, so a server that ignores `page_num` does not
run out the cap. More than 200 distinct pages throws `AirwallexSafetyError` from
`listCards`. `findCardByRequestId` does not throw on that cap: it returns a match
already seen and sets `listTruncated: true` on that card. The flag is not an API
field. A truncated scan with no match still returns `undefined`.
There is no documented
`request_id` query parameter or list-response field; if returned, we retain it.
The list endpoint applies a default window unless **both** creation bounds are
set (`from_created_at` and `to_created_at`). Recovery therefore sends
`to_created_at` only when the caller passes `createdAfter`, using the injected
clock as the upper bound. Without `createdAfter`, recovery uses the API's default
window and does not invent `createdBefore`. Use explicit creation bounds with
`listCards` for older archived cards.

The [Create a Card reference](https://www.airwallex.com/docs/api/issuing/cards/create)
describes `nick_name` as a string but publishes no maximum length. We could not
confirm a documented maximum. The helper uses a conservative **local** 50-character
bound; approval-derived request IDs yield 48-character nicknames with the whole
ID intact. This length bound is not a claim about the sandbox contract. Mask
shape, returned request-ID availability, nickname length acceptance, and transaction
ID joins still require owner-run live confirmation; no API was called for this task.

`listTransactions` parses each row independently. Valid rows retain merchant
`name`, `category_code`, `city`, `country`, transaction type/status, transaction and
billing amounts with their original sign and decimal representation, both card
transaction IDs, and redacted `extra` fields. Invalid rows go to `unparsed` with
redaction; other rows and page metadata remain available. A usable row requires
`transaction_id`, a signed decimal `transaction_amount`, and `transaction_currency`;
other modeled fields may be absent. No assumption joins `transaction_id` to
`card_transaction_id` until the live response confirms it. `transaction_amount`
keeps the API value and its original sign. `signedAmount` is derived from
`transaction_type`, compared case-insensitively: `REFUND`, `REVERSAL`, and any
type ending in `_REVERSAL` (for example `CLEARING_REVERSAL`) with a positive API
amount become negative. Every other row copies `transaction_amount`. Simulations
keep both card transaction IDs and full merchant fields, tolerate future result
strings and missing/invalid optional fields, and retain unknown fields in redacted
`extra`. A missing `process_result` is unknown, not approved; an error-shaped 200
parses with `process_result` left unset.

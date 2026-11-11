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
hides the API key from string/JSON serialization. Non-sandbox HTTPS origins
require `loadAirwallexConfig(process.env, { allowNonSandbox: true })`; simulation
always requires the sandbox origin. The purchase agent must use the default.
Fetch redirects are rejected to keep credentials at their configured origin.

Tokens are cached and refreshed 60 seconds before expiry. Concurrent requests
share a login. An authenticated 401 triggers one re-login and one retry; other
errors are not retried. Callers must pass a stable `request_id` to `createCard`,
using `cardRequestIdFromApproval(approvalId)` to derive it deterministically
from the approval ID. The random fallback generates an ID once per call and
retains it on the 401 retry, but cannot prevent duplicates across separate calls.
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
references. Schemas expose the purchase agent's subset and strip other fields.

`freezeCard` sets INACTIVE and `unfreezeCard` sets ACTIVE. Closing requires
`updateCardStatus(id, 'CLOSED', { irreversible: true })`. Card-details access is
guarded; no PAN/CVV endpoint is exposed. Returned card numbers must be masked.

Verify webhooks with `verifyWebhookSignature` against the original raw body, then
call `parseWebhookEvent`. Verification returns a boolean, accepts millisecond or
clearly second epoch timestamps, and defaults to a five-minute window in either
direction. `ISSUING_EVENT_NAMES` lists card and transaction subscriptions of
interest. `VERIFIED_ISSUING_EVENT_NAMES` separately exports the confirmed names;
all seven current subscriptions are confirmed. The parser accepts other names
so consumers can safely ignore them.
API errors expose only status, code and a sanitized API message. Validation and
transport errors omit response bodies and request data.

Confirmed against the official [Issuing webhook reference](https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events/issuing):
`issuing.card.active`, `issuing.card.inactive`, `issuing.card.closed`,
`issuing.card.modified`, `issuing.card.low_remaining_transaction_limit`,
`issuing.transaction.succeeded`, and `issuing.transaction.failed`.

Run `pnpm --filter @sk/airwallex test`, `build`, `typecheck` or `lint` from the root.

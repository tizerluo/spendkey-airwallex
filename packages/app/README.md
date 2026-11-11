# @sk/app

Server-rendered console views for Spendkey for Cards. A person approves the
exact purchase terms, then a virtual card is issued against that approval.
The package includes HTML views, the loopback approval server under `src/server`,
and an offline demo under `src/demo`. The server sends `CONSOLE_CSP`, verifies
CSRF and expiry, and refuses approvals on a non-card rail.

There is no framework and no external stylesheet, font, image, or script.
Each render function returns a complete HTML document. The terms hash is
selectable text. There is no copy button and no inline script, so the page
matches `CONSOLE_CSP` with `default-src 'none'`.

Every interpolated string passes through `escapeHtml` before it is placed in
text or attributes. Callers must pass masked card numbers only. Do not pass a
PAN, CVV, API key, token, or the approval nonce. `nonceHint` is rendered as
text, so it must stay a hint such as "nonce printed in operator terminal".
If the hint string itself contains the nonce, that secret will show up on the
page. The nonce input never has a `value`.

## Operator operations

Startup prints `OPERATOR TOKEN: ...` once. The service retains only its SHA-256
digest and compares digests in constant time. Supply the token in
`X-Operator-Token` or paste it into the console's empty `operatorToken` password
field. Simulate, freeze, reconcile, and `POST /approvals/:id/recover` also require
the approval's CSRF field. Tokens are never returned in responses or persisted
in the approval store or ledger. The audit page prints `card_frozen.by` as
recorded. `system` is shown as “system (auto)”. A human freeze is `by: "human"`
(demo runs use a reason starting `demo-operator:`). The agent package cannot
freeze a card.

Simulate and reconcile require approval status `issued`. Freeze is available
for any known card, including an unconfirmed issuance. Recovery requires a
previous issuance attempt and looks up the original request id; it never
creates another card. Repeated recovery failures share one
`card_issue_unconfirmed` event per approval.

New requests expire within one hour and at most 20 requests may remain
`requested`. Startup expires stale requests and prints fresh nonces for the
remaining open requests. The CLI reuses an open DesignCo request. Both CLI and
demo reconcile issued cards before the agent evaluates its spending budget;
polling errors stop that decision.

Every HTTP response uses `Cache-Control: no-store`, including redirects and
errors. Only `/webhooks/airwallex` bypasses the loopback Host check, and that
endpoint still verifies the signature over raw bytes. Webhook receipts record
`processResult: "success"` after processing; errors record `"error"` and remain
eligible for provider retries.

## Views

```ts
import {
  CONSOLE_CSP,
  buildApprovalPageModel,
  buildAuditPageModel,
  buildIndexPageModel,
  formatMinor,
  renderApprovalPage,
  renderAuditPage,
  renderIndexPage,
} from '@sk/app';

const approval = buildApprovalPageModel({
  approvalId,
  request, // ApprovalRequest from @sk/policy createApprovalRequest
  status,
  nonceHint,
  csrf,
  card,
  events: ledger.read(),
});
const approvalHtml = renderApprovalPage(approval.model, { csrfToken: approval.csrfToken });
const auditHtml = renderAuditPage(buildAuditPageModel(ledger.read(), verifyChain(ledger.read())));
const indexHtml = renderIndexPage(buildIndexPageModel(records));
response.setHeader('Content-Security-Policy', CONSOLE_CSP);
formatMinor(5000, 'USD'); // "50.00"
```

Send `CONSOLE_CSP` unchanged:

```
default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'
```

`default-src 'none'` blocks scripts. `style-src 'unsafe-inline'` is required
because the document carries one inline `<style>` block. Do not add a script,
an inline event handler, or a `javascript:` URL.

### `renderApprovalPage(model, { csrfToken })`

Shows the chosen amount, currency, rail, interval, merchant category, single or
multiple charges, and commitment. The presented terms hash is shown in a
monospace block. The sentence under it says what the hash binds; there is no
tooltip. Reason codes render as chips:

- `price_unverified` → “Price not verified — no savings claim”
- `human_approval_required` → “Human approval required”
- `mcc_required_at_approval` → “Merchant category is required at approval”

`needsMcc` adds a required `merchantCategoryCode` field. The nonce field is
empty; only `nonceHint` is shown.

`demoMode` shows: “Demo: auto-approval by demo-operator is labelled in the
audit log”.

Comparison rows with `rail: "x402"` are labelled “not payable by card (x402)”.
The Result cell for those rows is “Not payable by card”, including when
`passed` is true. Excluded `region_unavailable` rows explain that the offer is
outside the billing or card region.

The chosen terms list the rail. When that rail is not `card`, the page does
not render the approve form.

Forms, both `method="post"`, each wrapping its controls in a `<fieldset>`:

- `/approvals/:id/approve` with `nonce`, `presentedTermsHash`, `csrf`, and
  `merchantCategoryCode` only when `needsMcc` is true. The submit button reads
  “Approve exactly these terms”. Omitted when the chosen rail is not `card`.
- `/approvals/:id/reject` with `csrf`. The submit button reads “Reject”.

The whole fieldset is disabled unless `status` is `requested`. The server
still has to enforce that.

### `renderAuditPage(model)`

Badge text is “Chain valid” or “Chain BROKEN”. A `verifyError` is shown only
when the chain is broken. Labels come from the latest `run_started.mode`
(highest `seq`):

- `offline_emulator` → “Offline emulator (no Airwallex calls)”. Every
  authorization row says “emulated (offline)”. The page does not use the word
  sandbox.
- `sandbox` or `console_sandbox` → “Airwallex sandbox”. `source: "simulated"`
  is “sandbox simulation”; `source: "observed"` is “sandbox event (observed)”.
- No `run_started`, or a latest event whose `mode` is not one of those three →
  “mode unknown”. Authorization rows also say “mode unknown”.

An authorization row with no source says “source missing”. A
`card_issue_unconfirmed` row uses a warning style and the word “Unconfirmed”.
A `controls_readback` row says “controls read back: match” or
“controls read back: MISMATCH”. A mismatch uses the warning style. Expected and
actual control objects are not printed. Policy notes on that same
`run_started` are listed when present. A card table shows id, status, limit,
and currency.

### `renderIndexPage({ approvals })`

Lists approval id, status, vendor, amount, and currency. Each id links to
`/approvals/:id`. The shared header links to `/` and `/audit`. Each page states
the run mode. The footer repeats that label and says card numbers on these
pages are masked.

## Money

`formatMinor(minor, currency)` formats an integer minor amount.
`formatSignedDecimal(amount, currency)` formats a signed decimal string such
as `-12.50` or `+3`. `formatMinorRange` prints `low-high`, or one number when
the ends match. Both formatting and ledger validation use `currencyExponent`
exported by `@sk/ledger`, including all zero- and three-decimal currencies.
Other three-letter codes use 2. Negatives
get an ASCII minus. Zero has no sign. The helpers concatenate decimal digits
and never use binary floating point. Extra non-zero fraction digits throw
instead of rounding.

## Builders

`buildApprovalPageModel` accepts the server approval record: `approvalId`,
the `ApprovalRequest` from `createApprovalRequest`, `status`, `nonceHint`,
`csrf`, an optional `card`, and optional ledger `events`. It formats amounts,
fills comparison rows, reasons, intent, and the demo flag from those events,
and sets `presentedTermsHash` with `termsHash`. It also sets `runMode` from the latest `run_started` in `events`. It returns `{ model, csrfToken }`.
The model does not contain the csrf token or the nonce.

`buildAuditPageModel(events, verifyResult)` maps each ledger record to a row.
`hashShort` is the first 12 hex characters after an optional `0x` prefix.
Per-kind summaries live in that one function. `verifyResult` is the ledger
`ChainVerification`. When `ok` is true, `verifyError` is omitted.
`run_started` and `controls_readback` are read with view-local types, so a
ledger that does not have those kinds yet still builds. A missing kind is
skipped. `runMode` is set only when the latest `run_started` has a known mode.

`buildIndexPageModel(records, events?)` accepts records with `request` and
`status`, formats their amounts, and preserves their order. Pass the ledger as
the second argument so the index can show the same run mode. Omit it and the
page says “mode unknown”. Audit builders catch money formatting errors and
show `<raw amount> <currency> (unformatted)` so odd or tampered rows remain
visible.

`chosen.rail` is required in the view model and is filled from the policy request.
The server sets `demoMode` before approval when running the demo; ledger-only
builders infer it from a recorded demo auto-approval. Navigation marks the
current section with `aria-current="page"`.

`priceStatus`, `interval`, and `allowedTransactionCount` on the chosen terms
use the same unions as `@sk/policy` `ApprovalRequest` and the ledger
`approval_requested` event.

## Development

From the repository root:

```sh
pnpm --filter @sk/app test
pnpm --filter @sk/app typecheck
pnpm --filter @sk/app lint
```

Vitest uses the repository offline setup, which replaces global `fetch` with a
throwing stub. These tests never call it. Fixture values are synthetic
(`approval_request_test_01`, `card_test_01`, `****0000`).

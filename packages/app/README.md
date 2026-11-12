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

## Offline console video

From the repository root, run `pnpm console:offline`. No credentials are
needed or read. The client uses only `createFakeAirwallex().fetch`; it cannot
call Airwallex or the network. Open <http://127.0.0.1:8787> using `127.0.0.1`,
not `localhost`. To change the port, use `CONSOLE_PORT=8788 pnpm console:offline`.
The header says “Offline emulator (no Airwallex calls)”.

Each start creates a unique gitignored `console-data-offline/run-*/` directory;
previous runs are preserved, never resumed. The terminal prints the exact
`ledger.jsonl` path, a fresh `APPROVAL NONCE`, and a fresh `OPERATOR TOKEN`.
Card and transaction state lives in the emulator process, so restarting means
a new request and new card. The offline console uses human approval and does
not auto-approve.

For the fallback video:

1. Follow the DesignCo request link. Show annual `reserve_breach` and monthly
   USD 60.00 awaiting approval. Paste the terminal nonce into the approval form
   and select “Approve exactly these terms”. Issuance is emulated.
2. In “Simulate authorization — emulated (offline)”, paste the operator token.
   Submit amount `10.00`, currency `USD`, MCC `7372`: `approved`. Return to the
   approval page and submit `61.00` / `USD` / `7372`: `limit_exceeded`. Repeat
   with `1.00` / `USD` / `5812`: `merchant_category_not_allowed`. Each JSON
   response includes `label: "emulated (offline)"`.
3. Return to the approval page, paste the operator token and freeze the card.
   Return and simulate `1.00` / `USD` / `7372`: `card_inactive` (the ledger's
   provider-shaped failure reason is `CARD_INACTIVE`). Return and reconcile
   with the operator token: pending `1000` minor units, settled `0`, and three failures.
4. Open `/audit`. Show “Chain valid”, the policy notes, and “emulated (offline)”
   authorization labels. This demonstrates our local emulator, not Airwallex
   enforcement.
5. Keep the server running. Copy the printed ledger path into the command below
   in place of `console-data-offline/run-XXXXXX/ledger.jsonl`. It changes only
   the first line's first policy note, leaving valid JSON and the hashes intact:

   ```bash
   python3 - console-data-offline/run-XXXXXX/ledger.jsonl <<'PY'
   import json, pathlib, sys
   path = pathlib.Path(sys.argv[1])
   lines = path.read_text().splitlines()
   first = json.loads(lines[0])
   first["event"]["policyNotes"][0] += " (edited)"
   lines[0] = json.dumps(first, separators=(",", ":"))
   path.write_text("\n".join(lines) + "\n")
   PY
   ```

6. Refresh `/audit`: it shows “Chain BROKEN” and `hash_mismatch`. The read-only
   audit route diagnoses the on-disk file; normal ledger reads and writes still
   reject a broken chain. In both consoles, `/audit.jsonl` builds and verifies
   the full export before sending headers. If the ledger cannot be verified
   (including a broken chain or malformed file), it returns HTTP 409 with
   `{"error":"ledger_unverified"}` instead of exporting unverified events.
   The server remains available: `/audit` shows diagnostics, while `/` returns
   HTTP 400 `{"error":"request_failed"}` for a broken chain.
   Restart `pnpm console:offline` for a fresh recording.
   Publish the original head hash outside the file when demonstrating anchored
   verification; recomputing all hashes can otherwise hide an edit.

The demo script, live console seed, and offline console share the same synthetic
reserve policy: `floor = max(0, USD available - 500.00)`, plus a USD 100.00
obligation within 30 days. `run_started.policyNotes` records that rule. At USD
1,000, USD 1,200 or USD 1,000,000 available, annual is refused for
`reserve_breach` and monthly asks for human approval.

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

New requests must start at the exact decision instant, expire within fifteen
minutes of it, and reference a decision no more than fifteen minutes old.
Evidence is selected by ledger sequence. Each decision sequence can have only
one approval record, across every status; identical request-ID retries remain
idempotent. Legacy records without a sequence conservatively reserve their
offer throughout their original request window. At most 20 requests may remain
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
const indexHtml = renderIndexPage(buildIndexPageModel(records, ledger.read()));
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

## Operator APIs (M4)

`POST /approvals/:id/abandon` requires `X-Operator-Token` and the approval's `csrf`. It accepts only `failed` records with `attempted: true` and no card ID. A lookup by the original request ID must find no card; a found card is retained for `/recover`. Abandonment records `approval_rejected` with code `operator_abandoned`. After abandoning, run `pnpm demo:sandbox cleanup` and audit/verify the ledger before another demo: an eventually consistent provider may expose the attempted card later. Cleanup looks up attempted request IDs even on rejected records; repeat cleanup/audit if a card remains uncertain. Restart the console to seed a fresh policy decision/request. Provider failures return `{ error, provider: { status, code, message, step } }` and redacted ledger evidence.

`pnpm demo:sandbox --preflight` checks balances, issuing configuration and the existing cardholder without card mutations or local store writes. `pnpm demo:sandbox cleanup` confirms each stored demo card and freezes every non-INACTIVE card. A stale approval-store lock fails with its age; after confirming the owner stopped, first remove `demo-output/sandbox/approvals.json.lock`, then run `pnpm demo:sandbox cleanup` and audit/verify before another demo. Cleanup needs to acquire that lock and cannot run until it is removed. Preflight and cleanup were run against the sandbox on 2026-11-12 (Beijing); cleanup found the demo card already INACTIVE, so freezing an ACTIVE card through cleanup has not been exercised live.

Controls readback compares only the keys sent in the card request, recursively.
Decimal amount strings and numbers compare numerically, allowlists compare as
exact sets, and object key order is irrelevant. Extra provider keys (including nested
`remaining` values, validity dates, defaults and nulls) do not change the match
decision. Transaction limits are conjunctive: every sent interval/amount must
be present in the same currency, while additional provider limits are accepted
and recorded because they only restrict further. Extra MCCs or currencies still
fail closed and auto-freeze the card. Every sent key must still be present;
a missing MCC list or a changed limit fails closed, auto-freezes the card, and records
`controls_mismatch`. The app's injected transport adapter keeps the raw controls
object separately from validated card metadata so provider extras are preserved
and missing sent controls can be recorded as mismatches. `controls_readback`
retains the full redacted provider object in `actual`, including extras; there
is no separate `extra` field. Offline regression fixtures follow the response
shapes confirmed by the orchestrator on 2026-11-12 (Beijing).

On SIGINT or SIGTERM the demo waits for in-flight issuance, then cleans up and
exits non-zero. A second signal exits immediately if issuance or cleanup hangs;
run cleanup and audit/verify afterwards to resolve any uncertain card.

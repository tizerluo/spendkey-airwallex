# @sk/ledger

Card audit events for Spendkey for Cards, separate from the frozen `@sr/schema`
audit records. Dependencies: `@sr/core` and Zod 3.25.76. All operations are offline.

```ts
import { openJsonlLedger, verifyChain, signedDecimalToMinor } from '@sk/ledger';

const ledger = openJsonlLedger('./cards.jsonl');
const record = ledger.append({
  kind: 'webhook_received',
  eventId: 'event_test_01',
  name: 'issuing.card.updated',
  deduped: false,
});
console.log(record.seq, verifyChain(ledger.read()).ok);
ledger.close();

signedDecimalToMinor('-2.50', 'USD'); // -250 cents, for refunds/reversals
```

`openInMemoryLedger()` and `new InMemoryLedgerStore(initialEvents?)` implement
the same synchronous `LedgerStore` interface:

- `read(): LedgerEvent[]` returns a detached snapshot.
- `append(event, at?)` returns a detached hashed record. The default timestamp
  is the current ISO server time; tests may supply an ISO timestamp.
- `close()` prevents further reads and appends.

`appendEvent(events, event, at?)` validates an existing chain and returns its
next record without mutating the supplied array. Stores use it internally.
`CardAuditEventSchema` and `LedgerEventSchema` provide runtime validation.

The discriminated event union includes exactly these kinds:
`offers_snapshot`, `comparison`, `decision`, `approval_requested`,
`approval_granted`, `approval_rejected`, `card_issued`,
`card_issue_unconfirmed`, `authorization`, `card_frozen`, `reconciliation`,
`webhook_received`, `raw_response`. Objects reject unknown fields except within
the explicitly unknown `controls` and `body` payloads. Those payloads must be
present and contain JSON data. Optional fields may be omitted.

`approval_requested` retains `presentedTermsHash`; `approval_granted` retains
both that hash and the final `termsHash`, the human approver and
`demoAutoApproved`. `card_issue_unconfirmed` preserves issuance identifiers
when the response cannot be confirmed. `authorization.source` distinguishes
`simulated` from `observed`. Reconciliation totals allow negative minor units.
The ledger records `webhook_received.deduped`; webhook deduplication itself
belongs to the receiver.

Each envelope has `{ seq, at, prevHash, hash, event }`. Sequences start at zero.
The first `prevHash` is `ZERO_HASH` from `@sr/core`. Hashes are
`'0x' + sha256Hex(canonicalize({ seq, at, prevHash, event }))`, using the core
canonicalizer. `verifyChain(events)` returns `{ ok: true }` or
`{ ok: false, brokenAt, error }`; `brokenAt` is the zero-based index of the
first invalid record. It checks schema, redaction, sequence, predecessor,
timestamp order and digest. A record whose instant is earlier than the previous
record fails with `non_monotonic_timestamp`. Equal instants are allowed,
including the same moment written with a different offset. It accepts an empty
chain.

The file store verifies on open and rereads/verifies before each append. It
opens with `O_APPEND`, writes one compact JSON object and a newline, and calls
`fsync` before reporting success. Existing bytes are never rewritten. New
ledger and lock files have mode `0600`. Blank lines, invalid records, incomplete
final lines and broken chains are rejected. A write or fsync failure throws
`ledger_write_unconfirmed` and closes that handle. Inspect/reopen the ledger to
determine whether the event was written before retrying.

For multiple processes, all access must use this store and the same absolute
file path on a local filesystem. An exclusive sibling `<file>.lock` serializes
each operation. The lock records its owner's PID. Acquisition retries every 5ms
for up to 200ms, then throws `ledger_lock_unavailable`. A dead owner or a lock
older than 30 seconds permits stale-lock recovery. Operations must complete
within that lease. Ledger and lock paths must be on a trusted local filesystem;
external replacement or truncation is outside this coordination protocol.
Cleanup attempts both close and unlink. If the operation failed, that error is
preserved. If the operation succeeded and cleanup failed, the result is still
returned so a committed append is not retried as a failure. A leftover lock is
recovered when its owner is dead or the lock is older than 30 seconds. History
is never repaired or truncated.

A chain detects modified lines, reordering, duplicates and deletion before a
retained successor. Deleting a complete suffix leaves a valid shorter chain;
detecting that requires retaining the previous head hash/count independently.
Likewise, an attacker who can rewrite the whole file can recompute its hashes.
This is an integrity chain, not a signature or external checkpoint service.

`redactValue(value)` deep clones JSON, drops sensitive keys, and replaces
high-confidence secret shapes with `"[REDACTED]"`. It retains the key
`masked_card_number`, but still checks that value for an unmasked PAN. Sensitive
keys (and only keys) include CVV/CVC, PAN, card number, security code, card
security or card expiry, a bare `number` key, tokens, secrets, passwords,
authorization, cookies, API keys and private keys. Free-text values are not
matched against those words, so merchant names, decline reasons, notes, intent
and rule codes stay intact. Values are flagged only for high-confidence shapes:
a standalone 13–19 digit PAN that passes Luhn (spaces or dashes allowed), JWTs,
`sk-` / `sk_live_` / `sk_test_` keys, `AKIA`, `gh*_` and `xox*` tokens,
`Bearer <token>`, `Basic <base64>` and PEM private keys. Hex hashes, UUIDs,
ISO timestamps, epoch-ms values and `spk_` request IDs are accepted. A
`spk_` plus 40 hex characters is 44 characters, within the 50-character
request-id limit. Unlabelled credentials cannot all be recognized.

`append` runs `redactValue` on the whole event, then `assertRedacted` with the
same rules, then validates the schema. The record hash covers the stored
sanitized event. Ordinary wording is stored verbatim. A high-confidence value
becomes `"[REDACTED]"` and the event is still stored. A sensitive key is removed.
Unknown properties that remain after that still fail the strict schema and are
not written. If a response cannot be confirmed, append `card_issue_unconfirmed`
with a fixed reason such as `response_shape_unconfirmed` and the safe reference
to the stored raw response:

```ts
import { redactValue } from '@sk/ledger';

ledger.append({
  kind: 'raw_response', ref: 'response_test_01', endpoint: '/test/cards/create',
  status: 200, body: redactValue(responseBody),
});
ledger.append({
  kind: 'card_issue_unconfirmed', approvalId: 'approval_test_01',
  requestId: 'spk_test_01', reason: 'response_shape_unconfirmed',
  rawResponseRef: 'response_test_01',
});
```

Only synthetic masked card details belong in examples; runtime credentials stay
outside this package. Invalid JSON values and cycles are rejected with safe
errors by both the sanitizer and guard.

`signedDecimalToMinor(value, currency)` parses optional minus signs into safe
integer minor units using the currency exponent. Zero decimals: BIF, CLP, DJF,
GNF, ISK, JPY, KMF, KRW, PYG, RWF, UGX, UYI, VND, VUV, XAF, XOF, XPF. Three
decimals: KWD, BHD, OMR, JOD, TND, IQD, LYD. Other uppercase three-letter codes
use two decimals. Leading zeroes are accepted; exponents, whitespace, plus signs,
excess precision and unsafe integers are rejected. Negative zero is normalized.
Authorization amounts and nested offer prices are validated against their
currency using the same conversion. Prefer decimal strings from responses.

Build and verify a file from the repository root:

```sh
pnpm --filter @sk/ledger build
node packages/ledger/dist/cli.js verify ./cards.jsonl
# Optional external anchors retained from a previous successful verification:
node packages/ledger/dist/cli.js verify ./cards.jsonl --expect-head <hash> --expect-seq <seq>
pnpm --filter @sk/ledger test
```

`verifyJsonl(text, { expectHead?, expectSeq? })` returns diagnostics and the final
`head: { seq, hash }` on success. An empty file has `{ seq: -1, hash: ZERO_HASH }`.
The CLI prints the same head and accepts `--expect-head <hash>` (`--head` alias)
and `--expect-seq <seq>` to detect a removed suffix. Incomplete tails return
`{ ok: false, error: 'incomplete_final_line', brokenAt }`, where `brokenAt` is the
zero-based partial line index; strict store open/append continues to reject them.
Other parse and integrity failures also report a safe error and record index.

The CLI is read-only, prints JSON and exits `0` for a valid file, `1` for
integrity, parsing, usage or I/O failures. It does not create missing files or
print input data or paths on error. Tests cover all event kinds, every envelope
field and nested payload leaf, deletion/reordering, reopening, competing
handles, append/fsync behavior, partial-write failures, redaction, signed money
and the built CLI, with the repository's global offline fetch stub enabled.

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

signedDecimalToMinor('-2.50'); // -250 cents, for refunds/reversals
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
first invalid record. It checks schema, redaction, sequence, predecessor and
digest. It accepts an empty chain.

The file store verifies on open and rereads/verifies before each append. It
opens with `O_APPEND`, writes one compact JSON object and a newline, and calls
`fsync` before reporting success. Existing bytes are never rewritten. New
ledger and lock files have mode `0600`. Blank lines, invalid records, incomplete
final lines and broken chains are rejected. A write or fsync failure throws
`ledger_write_unconfirmed` and closes that handle. Inspect/reopen the ledger to
determine whether the event was written before retrying.

For multiple processes, all access must use this store and the same absolute
file path on a local filesystem. An exclusive sibling `<file>.lock` serializes
each operation; contention throws `ledger_lock_unavailable` immediately, so
the caller can retry later. After a process crash, stop all writers and verify
the file before an operator removes a stale lock. The store never removes a
preexisting lock, repairs a partial record, or truncates history. Treat the
ledger directory and path as trusted; external replacement or truncation is
outside this coordination protocol.

A chain detects modified lines, reordering, duplicates and deletion before a
retained successor. Deleting a complete suffix leaves a valid shorter chain;
detecting that requires retaining the previous head hash/count independently.
Likewise, an attacker who can rewrite the whole file can recompute its hashes.
This is an integrity chain, not a signature or external checkpoint service.

Before validation or writing, the redaction guard checks nested keys and values
for PAN-like runs of 13 or more digits (including space/hyphen separated runs),
CVV indicators, bearer credentials, API key/secret/token indicators and common
secret shapes. It rejects instead of silently removing data, with a generic
error that contains no input. Only masked card numbers belong in events; never
pass full card details or credentials to the ledger. Unknown raw payloads must
already be redacted by the caller. Detection is conservative and can reject
innocent text or identifiers with these shapes; it cannot recognize every
unlabelled credential. Runtime credentials stay outside this package.

`signedDecimalToMinor(string | number)` parses optional minus signs and up to
two decimal places into safe integer cents. It accepts leading zeroes, rejects
exponents, whitespace, plus signs, rounding and unsafe integers, and normalizes
negative zero. Prefer decimal strings from transaction responses. Like the
existing policy money helper, it assumes two decimal places; other currency
scales require an explicit conversion at the integration boundary.

Build and verify a file from the repository root:

```sh
pnpm --filter @sk/ledger build
node packages/ledger/dist/cli.js verify ./cards.jsonl
pnpm --filter @sk/ledger test
```

The CLI is read-only, prints JSON and exits `0` for a valid file, `1` for
integrity, parsing, usage or I/O failures. It does not create missing files or
print input data or paths on error. Tests cover all event kinds, every envelope
field and nested payload leaf, deletion/reordering, reopening, competing
handles, append/fsync behavior, partial-write failures, redaction, signed money
and the built CLI, with the repository's global offline fetch stub enabled.

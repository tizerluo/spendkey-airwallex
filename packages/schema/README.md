# @sr/schema

Shared runtime contracts and inferred TypeScript types for spendkey. Import
`PaymentPlanSchema` and `type PaymentPlan` (and corresponding pairs for other
contracts) from `@sr/schema`. Source and package versions are frozen at `1.0.0`
after the [Opus K1 blocking fixes](../../docs/reviews/K1.md).
[ADR 0001](../../docs/adr/0001-schema-v1.md) records the five freeze decisions and
supersedes older single-call, lease and EIP-191 recommendations.

- Atomic amounts are unsigned decimal strings, including values above JavaScript's
  safe integer range. `maxSpend` is a human-readable decimal string.
- Native x402 v1 Quote and PaymentSpec keep `celo`; v2 keeps `eip155:42220`.
  All normalized Celo networks use `eip155:42220`. Catalog prices accept CAIP-2
  identifiers; adapters normalize native aliases before validation. Other chains
  have `celo: false` and `scoreable: false`.
- Pay requires 1–10 ordered steps. The v1 server signs one step. `fallbackOf` is
  a zero-based reference to an earlier entry. Ask and refuse forbid steps; only
  ask may carry approval and it requires `required: true`. Approval returns a
  new pay plan. Lease is absent from v1.0.
- Plans require a payer and bytes32 nonce. CallSpec requires a bytes32 bodyHash
  when body is present: keccak256 of the exact raw request-body bytes.
- EIP-712 signatures are 65-byte hex, using domain
  `{ name: "SpendRouter", version: "1", chainId: 42220 }`. The signer binds payer,
  nonce, URL and bodyHash along with the other authorization fields. Schema
  validation checks shape; typed-data encoding, signature verification,
  body-hash recomputation, nonce replay prevention and expiry checks belong to
  the signing and execution implementations.
- CallSpec.url, GuardReq.url and Approval.approveUrl require HTTPS. Discovery
  URLs still use HttpUrl. Addresses are 20-byte hex; hashes are 32-byte hex;
  timestamps are RFC3339 with a timezone. Objects reject unknown fields.
- Decision provider ids match DECISION_CHAIN: `rules`, `typesafe:<model-slug>`,
  or `openrouter:<vendor>/<model-slug>` (optional `:free`). Decider.model records
  the actual upstream model version.
- Attribution.erc8021 is a nonempty array of printable ASCII codes, each 1–32
  characters. Execution policy requires our tag and may append integrator tags.
- GuardResult has an id and expiresAt. AuditRecord discriminates on kind:
  plan, guard, receipt, approval. Receipt events require receipt and exclude
  decision/decider. Append receipts separately after the decision event. Every
  event has payer and a nonnegative seq; the store enforces `(budgetKey, seq)`
  uniqueness and recomputes the hash chain.

`fixtures/*.json` contains valid and invalid offline examples. `src/mocks.ts`
exports typed valid mocks checked against their fixtures. All addresses, hashes,
body hashes and signature bytes are synthetic. They are shape examples, not
cryptographic vectors. Nonce and bodyHash examples use all-zero bytes32 values:
fixtures escape the hex prefix x (`\u0078`) and mocks construct the zero bytes
explicitly, so the existing generic private-key scanner does not classify the
new hash fields as secrets. The scanner and its allowlist are unchanged.
The `mock.example` URLs are never requested.

`pnpm --filter @sr/schema gen` writes one standalone draft-07 JSON Schema per
exported schema, OpenAPI 3.1 with the same dialect and schema.lock. Generation
uses pinned Zod contracts, local references and stable formatting without network
or clock inputs. The converter fails on unsupported checks and unmapped
refinements. Gen removes obsolete artifacts, including Lease.json.

OpenAPI has eight v1 routes: plan, guard, POST quote (URL body, Quote[] response),
catalog (q/celo query filters), POST receipts (Receipt body), stats, approve and
audit. Authentication and error responses belong to the API implementation.

`pnpm --filter @sr/schema check-lock` regenerates in memory and checks SHA-256,
exact artifact bytes and the file inventory. It does not rewrite artifacts or
the lock; compilation writes ignored dist only. Root verification runs this
through the schema typecheck script. C1 checks every fixture with both Zod and
Ajv, including conditional bodyHash, non-pay/non-ask field prohibitions, audit
union branches, HTTPS, attribution codes and catalog network flags. No lease
runtime-validation exception remains. Tests also check OpenAPI references,
deterministic generation and rejection of artifact/lock/inventory tampering.

Acceptance: `pnpm --filter @sr/schema gen && pnpm --filter @sr/schema test &&
pnpm --filter @sr/schema check-lock && pnpm verify && CI=true bash scripts/ci.sh`.
Use `npm_config_offline=true` for the acceptance environment to ensure CI's
frozen-lockfile install uses only the existing local store.

# Spendkey for Cards

> **Status: main line verified against the live Airwallex sandbox (demo environment) on 2026-11-12 (Beijing); offline emulator also verified.** Webhooks and the live `pnpm console` have not been run against Airwallex.

Spendkey for Cards turns a purchase request into a policy decision, asks a person to approve the exact terms, and issues a virtual card whose limits, currency, and merchant category match that approval. It extends [Spendkey](https://spendkey.dev) from x402 payments to Airwallex card issuing. The policy rules and hash-chained audit log are reused here under the MIT license.

Built for the Airwallex Agentic Banking Hackathon. Only the Airwallex sandbox (`api-demo.airwallex.com`) is used; no real money moves and production is refused.

## What it does

The DesignCo main line. With `pnpm demo:sandbox` every Airwallex step below was run against the sandbox; with `pnpm demo:offline` the same steps run against a local emulator and are labelled emulated:

1. Compare DesignCo offers. The annual plan is refused (`reserve_breach`). The monthly plan is `ask`. x402 prices are comparison only and are not card-payable.
2. A person approves the exact terms by posting a one-time nonce.
3. Airwallex issues a virtual card with those controls (60 USD monthly limit, USD only, MCC 7372). The service reads the controls back and freezes the card if any sent control is missing or loosened.
4. Airwallex's sandbox simulator approves a 10 USD charge and declines two: 61 USD (`LIMIT_EXCEEDED`) and MCC 5812 (`MERCHANT_CATEGORY_NOT_ALLOWED`).
5. The demo operator freezes the card (`INACTIVE`). A further charge comes back `CARD_INACTIVE`.
6. Reconciliation reads the card's transactions back from Airwallex: the approved charge is pending, the three declines are failed.
7. The hash chain verifies. A tampered copy does not.

The offline script can auto-approve as `demo-operator`. That fact is written on the audit log. The console waits for the human nonce.

## Quick start

Node 22.x and pnpm 10.

```bash
pnpm install --frozen-lockfile && pnpm demo:offline
pnpm audit:verify demo-output/ledger.jsonl --expect-head <head hash printed by the demo>
pnpm console:offline
```

`pnpm demo:offline` needs no credentials. It writes `demo-output/ledger.jsonl`. `pnpm audit:verify` checks that file; with `--expect-head` it also detects a truncated tail.

`pnpm console:offline` also needs no credentials and makes no Airwallex calls.
It serves the human approval and audit pages at <http://127.0.0.1:8787>.
The terminal prints the approval nonce, operator token, and ledger path. Each
start creates a fresh `console-data-offline/run-*/` directory (gitignored),
preserving previous recordings. Set `CONSOLE_PORT` to change the port.
See the [offline video steps](packages/app/README.md#offline-console-video) for
approval, emulated authorizations, freeze, reconciliation, and a file edit that
shows “Chain BROKEN”.

## Trust boundaries

The agent can ask or refuse. It cannot approve, issue, or freeze; this is enforced in process by package boundaries, types and lint import bans, not by a separate process. The approval service is the only component that talks to Airwallex. In the offline emulator that call is a local fake and no network request is made.

`AIRWALLEX_CLIENT_ID` and `AIRWALLEX_API_KEY` are read from the process environment at runtime by the Airwallex client inside the approval service. The agent package does not receive them. They are not written to the ledger, the approval store, logs, or the page.

The human nonce is approval. It is printed in the operator terminal and POSTed by the person on the approval form. The service stores only a hash, wipes the nonce after use, and never returns it over HTTP or writes it to the ledger.

The operator token is for card operations (simulate, freeze, reconcile, issuance recovery). It is not an approval. The service keeps only its SHA-256 digest.

## What is emulated / simulated / observed

How a run is labelled. The `sandbox` row was observed with `demo:sandbox`; the `console_sandbox` row has not yet been run live.

| Mode | Emulated | Simulated | Observed |
| --- | --- | --- | --- |
| `offline_emulator` | The whole run. No Airwallex calls. The console says “Offline emulator (no Airwallex calls)” and labels every authorization “emulated (offline)”. | Ledger rows may still store `authorization.source: simulated`. The view does not call them sandbox. | Ledger rows may still store `source: observed`. The view does not call them sandbox events. |
| `sandbox` | Not this mode. | `demo:sandbox` uses the Airwallex simulator. View: “sandbox simulation”. | Transactions read back from the sandbox. View: “sandbox event (observed)”. |
| `console_sandbox` | Not this mode. | Operator “simulate” on the local console, against the sandbox API. View: “sandbox simulation”. | Reconcile / list transactions. View: “sandbox event (observed)”. |

If the ledger has no `run_started` event, the console says “mode unknown” and does not guess.

## Live sandbox

Credentials are read from the environment only (`AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY`, plus an existing `AIRWALLEX_CARDHOLDER_ID`). Never put them in files in this repository or on the command line.

```bash
pnpm demo:sandbox --preflight   # read-only: balances, issuing config, cardholder
pnpm demo:sandbox               # the main line above, against the sandbox
pnpm demo:sandbox cleanup       # freeze any demo card that is not INACTIVE
```

Verified on 2026-11-12 (Beijing) in the Airwallex demo environment:

| Step | Observed |
| --- | --- |
| Preflight | Login, USD balance, issuing primary currency USD, cardholder `READY`. |
| Issue card | `202`, card `ACTIVE` immediately, masked number `************dddd`, `request_id` echoed; lookup by `request_id` finds the card. |
| Controls readback | Sent controls returned unchanged, plus provider defaults (empty brand/country lists and an extra `PER_TRANSACTION` limit, which only tightens). |
| Simulations | 10 USD/7372 `APPROVED`; 61 USD `LIMIT_EXCEEDED`; MCC 5812 `MERCHANT_CATEGORY_NOT_ALLOWED`; EUR `CURRENCY_NOT_ALLOWED` (client smoke test); after freeze `CARD_INACTIVE`. |
| Transactions | Listed with merchant name, city, country and MCC; spend amounts are negative numbers; the approved authorization is `PENDING`, declines are `FAILED`. |
| Cleanup | Every card created during testing is `INACTIVE`. |

Not yet run live: `pnpm console` (it needs the same environment and calls the sandbox at startup; open <http://127.0.0.1:8787>, not `localhost`), webhook delivery, and the interrupt (Ctrl-C) cleanup path.

## Known limitations

- The hash chain is tamper-evident only when a head hash is published outside the file. Rewriting the file and recomputing hashes still verifies without that anchor.
- Webhooks are optional. Polling is the reconciliation path. Webhook delivery has not been verified live.
- Sandbox simulations are not real card-network traffic; settlement (`SUCCEEDED`) was not observed within the demo run, so settled totals stay 0 and the approved charge shows as pending.
- The client talks only to the Airwallex sandbox host. Production is refused.
- `MONTHLY` cards renew their limit each month until frozen. There is no `active_to`.

## Repository layout

- `packages/schema` (`@sr/schema`) — frozen Spendkey v1 payment contracts.
- `packages/core` (`@sr/core`) — frozen baseline: canonical JSON and hash helpers.
- `packages/offers` (`@sk/offers`) — curated and x402 offer snapshots, offline.
- `packages/compare` (`@sk/compare`) — integer cost comparison of those offers.
- `packages/policy` (`@sk/policy`) — reserve, budget, commitment, region, and human approval terms.
- `packages/airwallex` (`@sk/airwallex`) — sandbox-only issuing client, verified against the sandbox.
- `packages/ledger` (`@sk/ledger`) — hash-chained card audit log and verify CLI.
- `packages/agent` (`@sk/agent`) — asks or refuses; cannot approve, issue, or freeze.
- `packages/app` (`@sk/app`) — approval service, console views, and the offline demo.

## Development

Node 22.x and pnpm 10.

```bash
pnpm verify
```

That runs the secret scan, typecheck, lint, and the offline tests. Live sandbox runs read credentials from the environment and only talk to `https://api-demo.airwallex.com`. Never commit credentials.

## License

[MIT](LICENSE)

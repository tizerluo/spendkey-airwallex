# Spendkey for Cards

> **Status: offline emulator verified; live Airwallex sandbox not yet verified**

Spendkey for Cards turns a purchase request into a policy decision, asks a person to approve the exact terms, and issues a virtual card whose limits, currency, and merchant category match that approval. It extends [Spendkey](https://spendkey.dev) from x402 payments to Airwallex card issuing. The policy rules and hash-chained audit log are reused here under the MIT license.

Built for the Airwallex Agentic Banking Hackathon. Nothing in this repository has called the live Airwallex sandbox. Every Airwallex response seen so far came from synthetic fixtures or the offline emulator.

## What it does

The verified path is the offline DesignCo demo. Card issuance, declines and freeze below are produced by the local Airwallex emulator, not by Airwallex:

1. Compare DesignCo offers. The annual plan is refused (`reserve_breach`). The monthly plan is `ask`. x402 prices are comparison only and are not card-payable.
2. A person approves the exact terms by posting a one-time nonce.
3. (Emulated) A virtual card is issued with those controls (monthly limit, USD, merchant category).
4. (Emulated) The emulator approves one in-policy charge and declines two: over the limit, and a disallowed merchant category.
5. (Emulated) The demo operator freezes the card. A further charge comes back `CARD_INACTIVE`.
6. Reconciliation records the settled amount and the failed charges.
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

How a run is labelled. The sandbox columns are the planned live meaning. They have not been observed against Airwallex.

| Mode | Emulated | Simulated | Observed |
| --- | --- | --- | --- |
| `offline_emulator` | The whole run. No Airwallex calls. The console says “Offline emulator (no Airwallex calls)” and labels every authorization “emulated (offline)”. | Ledger rows may still store `authorization.source: simulated`. The view does not call them sandbox. | Ledger rows may still store `source: observed`. The view does not call them sandbox events. |
| `sandbox` | Not this mode. | `demo:sandbox` uses the Airwallex simulator. View: “sandbox simulation”. | Transactions read back from the sandbox. View: “sandbox event (observed)”. |
| `console_sandbox` | Not this mode. | Operator “simulate” on the local console, against the sandbox API. View: “sandbox simulation”. | Reconcile / list transactions. View: “sandbox event (observed)”. |

If the ledger has no `run_started` event, the console says “mode unknown” and does not guess.

## Live sandbox

Not yet run. Planned commands, once credentials are present only in the environment:

```bash
pnpm demo:sandbox --preflight
pnpm demo:sandbox
pnpm demo:sandbox cleanup
pnpm console
```

`pnpm console` requires `AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY` and `AIRWALLEX_CARDHOLDER_ID` in the environment and calls the Airwallex sandbox at startup. Open it at <http://127.0.0.1:8787> (not `localhost`; the host check rejects it). State stays in the gitignored `console-data/` directory; the operator terminal prints the approval nonce and the operator token once.

Do not treat a green offline demo as evidence that Airwallex accepted a card, enforced controls, or returned a transaction.

## Known limitations

- The hash chain is tamper-evident only when a head hash is published outside the file. Rewriting the file and recomputing hashes still verifies without that anchor.
- Webhooks are optional. Polling is the reconciliation path. Webhook delivery has not been verified live.
- The client talks only to the Airwallex sandbox host. Production is refused. The live sandbox itself has not been run.
- `MONTHLY` cards renew their limit each month until frozen. There is no `active_to`.

## Repository layout

- `packages/schema` (`@sr/schema`) — frozen Spendkey v1 payment contracts.
- `packages/core` (`@sr/core`) — frozen baseline: canonical JSON and hash helpers.
- `packages/offers` (`@sk/offers`) — curated and x402 offer snapshots, offline.
- `packages/compare` (`@sk/compare`) — integer cost comparison of those offers.
- `packages/policy` (`@sk/policy`) — reserve, budget, commitment, region, and human approval terms.
- `packages/airwallex` (`@sk/airwallex`) — sandbox-only issuing client. Not yet called live.
- `packages/ledger` (`@sk/ledger`) — hash-chained card audit log and verify CLI.
- `packages/agent` (`@sk/agent`) — asks or refuses; cannot approve, issue, or freeze.
- `packages/app` (`@sk/app`) — approval service, console views, and the offline demo.

## Development

Node 22.x and pnpm 10.

```bash
pnpm verify
```

That runs the secret scan, typecheck, lint, and the offline tests. Live sandbox runs, when they happen, read credentials from the environment and only talk to `https://api-demo.airwallex.com`. Never commit credentials.

## License

[MIT](LICENSE)

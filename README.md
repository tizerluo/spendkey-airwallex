# Spendkey for Cards

Spendkey for Cards is an intent-bound SaaS procurement agent: it turns a purchase request into a cash-aware, policy-checked decision (pay / refuse / ask), gets a human to approve the exact terms, and then issues an Airwallex virtual card whose limits, currency and merchant-category controls enforce that approval.

It extends [Spendkey](https://spendkey.dev), an "ask before you pay" decision layer for AI agents, from x402 payments to Airwallex card issuing. The Spendkey policy rules and hash-chained audit log are reused here and published under the MIT license.

Built for the Airwallex **Agentic Banking Hackathon**.

## Planned flow (MVP, Airwallex sandbox only)

1. **Compare offers** – for a purchase request (e.g. "monthly X post search"), compare payment paths such as an official prepaid plan vs. x402 pay-per-call. Unverified prices are labelled `price_unverified`.
2. **Hard rules** – cash reserve floor (reads the Airwallex sandbox balance), window budget, commitment-term cap, region rule.
3. **Human approval** – the human approves exact terms (amount, currency, merchant, terms hash). On the card rail the agent can at most *ask*; it can never approve itself.
4. **Card control** – an Airwallex virtual card is issued with limits, currency and merchant-category controls mirroring the approval. Over-limit or wrong-merchant charges are declined by the card.
5. **Monitor** – transactions and renewals trigger re-evaluation; the card can be frozen.
6. **Audit** – every step (offer snapshot, decision, approval, card change, transaction) is written to a tamper-evident hash chain.

Out of scope: real charges, storing card numbers, auto-filling checkouts, logging in to vendor accounts.

## Status

The M3 approval service, agent, transaction loop, and offline demo are implemented. The console reuses the approval, audit, and index views. All verification is offline; live Airwallex sandbox behavior remains unverified.

The card path uses `@sk/offers` → `@sk/compare` → `@sk/policy` → `@sk/agent`, with `@sk/app` owning approval and issuing. `@sk/ledger` connects the steps with a hash chain. The existing `@sr/core` and `@sr/schema` baseline is unchanged.

## Run the demo and console

Use Node 22 and pnpm 10:

```bash
pnpm install
pnpm demo:offline
```

The offline demo injects a synthetic Airwallex fetch, requires no credentials, and writes `demo-output/ledger.jsonl`. It shows the DesignCo annual reserve refusal, monthly demo approval, card controls, declines, freeze, reconciliation, chain verification, and tamper detection. Auto-approval is explicitly labelled `demo-operator` / `demoAutoApproved`.

For the local sandbox console, set `AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY`, and an existing `AIRWALLEX_CARDHOLDER_ID` in the runtime environment, then run `pnpm console`. Open <http://127.0.0.1:8787>; approve the seeded DesignCo request using the nonce printed in the operator terminal. State lives in the gitignored `console-data/` directory. The nonce is never sent over HTTP or written to the ledger. Optional `AIRWALLEX_WEBHOOK_SECRET` enables the signed webhook endpoint; polling is the primary reconciliation path.

`pnpm demo:sandbox` runs the same demo against the real Airwallex sandbox with those runtime variables. It refuses missing credentials, needs sufficient USD sandbox funds, and freezes the demo card before finishing. It has **not** been run as part of this task. Sandbox state is durable in `demo-output/sandbox/`. Both demo commands build first.

Offer snapshots keep sub-cent unit prices (e.g. x402 at `0.001` USD); card transaction amounts use each currency's minor-unit exponent.

The console's card mutation routes are operator-only: they require the `X-Operator-Token` printed once in the operator terminal at startup (or the console form field) **and** the approval page's CSRF value: `POST /cards/:id/simulate` (`amount`, `currency`, `mcc`, `csrf`), `POST /cards/:id/freeze` (`csrf`), and `POST /reconcile` (`cardId`, `csrf`, optional `from`/`to`). Audit exports are available at `/audit` and `/audit.jsonl`.

## Development

Requirements: Node 22, pnpm 10.

```bash
pnpm install
pnpm verify   # secret scan + typecheck + lint + all tests (offline)
```

Live sandbox runs read `AIRWALLEX_CLIENT_ID` and `AIRWALLEX_API_KEY` from the environment and only talk to `https://api-demo.airwallex.com`. Never commit credentials.

## License

[MIT](LICENSE)

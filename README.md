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

Milestone M1 (foundation) — offline only, no live Airwallex calls yet.

| Package | What it is |
|---|---|
| `packages/schema` | Shared zod schemas (decision, audit record, approval) from the Spendkey baseline. |
| `packages/core` | Spendkey decision layer: hard rules, budget windows, decision-provider chain with rules-only fallback, hash-chained audit log. |
| `packages/airwallex` | Typed Airwallex sandbox client: auth with token refresh, balances, cardholders, virtual cards with authorization controls, freeze, limits, transactions, sandbox authorization simulation, webhook signature verification. Card PAN/CVV endpoints are blocked by design. |
| `packages/offers` | Offer sources for a purchase intent: a curated list and a read-only x402 snapshot. Fixture prices are synthetic unless marked verified. |

Next: decision on offers (M2), card-control loop and approval/audit pages (M3), end-to-end sandbox demo (M4).

## Development

Requirements: Node 22, pnpm 10.

```bash
pnpm install
pnpm verify   # secret scan + typecheck + lint + all tests (offline)
```

Live sandbox runs (later milestones) read `AIRWALLEX_CLIENT_ID` and `AIRWALLEX_API_KEY` from the environment and only talk to `https://api-demo.airwallex.com`. Never commit credentials.

## License

[MIT](LICENSE)

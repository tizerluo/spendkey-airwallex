Synthetic fixtures for `../src/independent.test.ts` (independent tester, M1-T5).

Every identifier, amount, merchant and timestamp here is invented. No credentials,
PAN, CVV or personal data are stored. `transactions-declines.json` exists to exercise
`mapFailureReason` across the four known reasons plus an unknown one;
`webhook-card-closed.json` is used byte-for-byte as a webhook signing input.

Transaction response shapes were confirmed against the sandbox by the orchestrator
on 2026-11-12 (Beijing); all contents remain synthetic. Declined transactions
use negative provider amounts, nested card transaction IDs and merchant extras.

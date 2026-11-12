These fixtures contain synthetic examples whose response shapes were confirmed
against the Airwallex sandbox on **2026-11-12 (Beijing)** by the orchestrator.
This implementation task made no API calls. All IDs, values, names and masked
suffixes are synthetic; no credentials, PAN or CVV are stored here.

`card-create.json` models the ACTIVE response returned with HTTP 202.
`card-get.json` models readback with provider defaults and the additional
PER_TRANSACTION 10000 limit alongside our MONTHLY 60 limit. Extra conjunctive
limits restrict further; currencies and merchant categories must remain exact sets.
Simulation fixtures model HTTP 201 responses; listed transactions use distinct
`transaction_id` and nested `card_transaction_data.card_transaction_id` IDs.
Approved authorizations initially appear as PENDING; declined rows are FAILED.
Merchant extras and numeric negative spend amounts follow the live response shape.
`transactions-credit.json` extends coverage to a synthetic positive credit:
spend is the inverse of the provider amount, independently of transaction type.
Additional parser tests cover decimal strings as well as JSON numbers.

All JSON files here are hand-written, synthetic recorded-style responses. They
contain no real requests, credentials, account data or captured provider output.
The `synthetic` marker is fixture metadata, not a provider contract field.

The Noul `answers.<question>.{type,noul}` shape follows the locally saved System
One and TypeSafe SDK documentation in spend-router-plan/research/raw. TypeSafe
uses the same answer shape as OpenRouter; OpenRouter additionally reports id,
provider and usage.cost. These fixtures exercise the adapter contract offline;
they are not evidence of live model availability or behavior.

`fastino-pay.json` follows the supplied Fastino System One contract, including
answer confidence, token usage and no `usage.cost`. It contains synthetic data
and omits fixture metadata so its fields match the documented response shape.

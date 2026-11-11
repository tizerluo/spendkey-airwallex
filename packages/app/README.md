# @sk/app

Server-rendered console views for Spendkey for Cards. A person approves the
exact purchase terms, then a virtual card is issued against that approval.
This package currently contains **only the HTML views**. The HTTP server will
be added later under `src/server`; it is intentionally not here.

There is no framework, no external stylesheet, font, image, or script source.
Each render function returns a complete HTML document. A short inline script
on the approval page copies the terms hash when `navigator.clipboard` exists.
The approve and reject actions are ordinary forms and work with that script
absent.

Every interpolated string passes through `escapeHtml` before it is placed in
text or attributes. Callers must pass masked card numbers only. Do not pass a
PAN, CVV, API key, token, or the approval nonce. `nonceHint` is a hint such as
"nonce printed in operator terminal".

## Views

```ts
import { renderApprovalPage, renderAuditPage, renderIndexPage } from '@sk/app';

const approvalHtml = renderApprovalPage(approvalModel, { csrfToken });
const auditHtml = renderAuditPage(auditModel);
const indexHtml = renderIndexPage({ approvals });
```

### `renderApprovalPage(model, { csrfToken })`

Shows the chosen amount, currency, interval, merchant category, single or
multiple charges, and commitment. The presented terms hash is shown in a
monospace block, with visible text and a native tooltip for what the hash
binds. Reason codes render as chips:

- `price_unverified` → “Price not verified — no savings claim”
- `human_approval_required` → “Human approval required”
- `mcc_required_at_approval` → “Merchant category is required at approval”

`needsMcc` adds a required `merchantCategoryCode` field. The nonce field is
empty; only `nonceHint` is shown.

`demoMode` shows: “Demo: auto-approval by demo-operator is labelled in the
audit log”.

Comparison rows with `rail: "x402"` are labelled “not payable by card (x402)”.
Excluded `region_unavailable` rows explain that the offer is outside the
billing or card region.

Forms, both `method="post"`:

- `/approvals/:id/approve` with `nonce`, `presentedTermsHash`, `csrf`, and
  `merchantCategoryCode` only when `needsMcc` is true. The submit button reads
  “Approve exactly these terms”.
- `/approvals/:id/reject` with `csrf`. The submit button reads “Reject”.

Buttons are disabled unless `status` is `requested`. The server still has to
enforce that.

### `renderAuditPage(model)`

Badge text is “Chain valid” or “Chain BROKEN”. The event table marks
`source: "simulated"` as “sandbox simulation” and `source: "observed"` as
“sandbox event (observed)”. A card table shows id, status, limit, and currency.

### `renderIndexPage({ approvals })`

Lists approval id, status, vendor, amount, and currency. Each id links to
`/approvals/:id`. The shared header links to `/` and `/audit`.

## Development

From the repository root:

```sh
pnpm --filter @sk/app test
pnpm --filter @sk/app typecheck
pnpm --filter @sk/app lint
```

Vitest uses the repository offline setup, which replaces global `fetch` with a
throwing stub. These tests never call it. Fixture values are synthetic
(`approval_request_test_01`, `card_test_01`, `****0000`).

## 工作记录

### 我们实现了哪些功能？

`@sk/app` 的审批页、审计页和审批列表。三个函数返回完整 HTML：条款、原因芯片、比较表、x402 与地区排除说明、批准/拒绝表单、哈希链徽章、模拟/观测标签、卡片摘要。所有插值经 `escapeHtml`。复制哈希的脚本默认不显示，表单不依赖它。

### 我们遇到了哪些错误？

全仓库 `typecheck`、`lint`、`test` 和 `scripts/check-secrets.sh` 都通过了。写测试时有一处断言和页面文案对不上：`mcc_required_at_approval` 会被渲染成 “Merchant category is required at approval”，HTML 里不再保留原始代码。`pnpm install` 还打印了仓库里原有的提示，esbuild 的安装脚本被忽略。安装本身成功，锁文件只增加了 `packages/app` 这一条空依赖。

### 我们是如何解决这些错误的？

断言改为检查芯片上的那句文案，并确认 `needsMcc` 为 false 时输出里没有 `merchantCategoryCode`。esbuild 的提示不是这次引入的，没有改构建脚本白名单。

# Ledger 进度

## M3-T0-FIX2 自由文本不再被词表误杀

### 我们实现了哪些功能？

- 追加事件时先对整条事件做 `redactValue`，再跑 `assertRedacted`。哈希按脱敏后的事件计算。
- 自由文本只检查高置信度形态：Luhn PAN（含空格和连字符）、JWT、`sk-` / `sk_live_` / `sk_test_`、`AKIA`、`gh*_`、`xox*`、`Bearer <token>`、`Basic <base64>`、PEM 私钥。命中后存成 `[REDACTED]`，事件仍然写入。
- 敏感键名仍然删除：`cvv`、`cvc`、`pan`、卡号、`security_code`、`card_security`、与 card 同时出现的 expiry、单独的 `number`、`token`、`secret`、`password`、`api_key`、`authorization`、`cookie`。`masked_card_number` 保留键名。
- `Authorization declined`、`Secret Garden Cafe`、`PAN AM CAFE`、`Cookie jar`、`Authorization limit token exceeded` 会原样落盘。
- `verifyChain` 拒绝比上一条更早的时间点，相等时刻允许。
- 锁清理失败时，如果操作本身已经成功，返回结果，避免调用方重试已提交的追加。

### 我们遇到了哪些错误？

- 第二轮评审：词表把商户名、失败原因和冻结原因里的普通英文整段拒绝，审计记录会丢。
- 旧测试要求这些普通词，以及带 `hidden` 的未知字段，在追加时抛 `ledger_redaction_required`。
- 旧测试要求锁清理失败时抛 `ledger_lock_cleanup_failed`，即使读取已经成功。

### 我们是如何解决这些错误的？

- 删掉自由文本词表，守卫和脱敏共用同一套高置信度规则；键名检查只用于键。
- 未知且非敏感的字段在脱敏后仍过不了严格 schema，追加抛 `invalid_card_audit_event`，不落盘。
- 锁清理失败改为吞掉清理错误并返回原结果；操作本身的错误仍然抛出。
- 包内测试 257 项通过。仓库根 `pnpm test` 共 1822 项通过，`typecheck`、`lint` 和 `scripts/check-secrets.sh` 也通过。

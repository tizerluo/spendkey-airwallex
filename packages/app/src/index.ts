// 控制台视图的公开入口。HTTP 服务稍后由其他任务加到 src/server，本包现在不包含它。

export { CONSOLE_CSP, escapeHtml } from './views/html.js';
export { renderApprovalPage } from './views/approval-page.js';
export { renderAuditPage } from './views/audit-page.js';
export { renderIndexPage } from './views/index-page.js';
export { currencyExponent, formatMinor, formatMinorRange, formatSignedDecimal } from './views/money.js';
export { buildApprovalPageModel, buildAuditPageModel, buildIndexPageModel, hashShort } from './views/builders.js';
export type { ApprovalRecordInput, BuiltApprovalPage, IndexRecordInput, LedgerRecord } from './views/builders.js';
export type {
  AllowedTransactionCount,
  ApprovalCardSummary,
  ApprovalChosenTerms,
  ApprovalComparisonRow,
  ApprovalExclusion,
  ApprovalPageModel,
  ApprovalRenderOptions,
  ApprovalStatus,
  AuditCardSummary,
  AuditEventRow,
  AuditPageModel,
  ChargeInterval,
  ConsoleRunMode,
  IndexApprovalRow,
  IndexPageModel,
  PaymentRail,
  PriceStatus,
} from './views/models.js';
export * from './server/index.js';

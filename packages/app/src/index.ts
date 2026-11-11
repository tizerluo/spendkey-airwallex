// Public entry for the console views, server and demo of @sk/app.

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

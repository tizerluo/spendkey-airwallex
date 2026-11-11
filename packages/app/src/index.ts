// 控制台视图的公开入口。HTTP 服务稍后由其他任务加到 src/server，本包现在不包含它。

export { escapeHtml } from './views/html.js';
export { renderApprovalPage } from './views/approval-page.js';
export { renderAuditPage } from './views/audit-page.js';
export { renderIndexPage } from './views/index-page.js';
export type {
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
  IndexApprovalRow,
  IndexPageModel,
  PriceStatus,
} from './views/models.js';

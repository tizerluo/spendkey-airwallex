// 审批页、审计页、列表页的视图模型。渲染函数只读这些字段，不访问账本或网络。

/** 审批请求在控制台里的生命周期。 */
export type ApprovalStatus =
  | 'requested'
  | 'approved'
  | 'issuing'
  | 'issued'
  | 'failed'
  | 'rejected'
  | 'expired';

/**
 * 报价价格是否经过核对。与 @sk/policy ApprovalRequest 和账本 offers_snapshot 一致。
 * 未核对的价格不能当成已节省的金额。
 */
export type PriceStatus = 'verified' | 'price_unverified';

/** 与 ApprovalRequest.interval、账本 approval_requested.interval 相同。 */
export type ChargeInterval = 'PER_TRANSACTION' | 'MONTHLY' | 'ALL_TIME';

/** 与 ApprovalRequest.allowedTransactionCount、账本 approval_requested 相同。 */
export type AllowedTransactionCount = 'SINGLE' | 'MULTIPLE';

/** 与 ApprovalRequest.rail 相同。不是 card 的条款不能在页面上批准。 */
export type PaymentRail = 'card' | 'x402';

/**
 * 当前准备让人批准的那一条条款。
 * amount 已是展示用字符串，由 buildApprovalPageModel 用金额工具格式化。
 */
export interface ApprovalChosenTerms {
  offerId: string;
  vendor: string;
  product: string;
  plan: string;
  amount: string;
  currency: string;
  interval: ChargeInterval;
  allowedTransactionCount: AllowedTransactionCount;
  merchantCategoryCode?: string;
  commitmentMonths: number;
  priceStatus: PriceStatus;
  rail: PaymentRail;
}

/** 比较表的一行。rail 为 x402 时必须标明不能用卡支付。 */
export interface ApprovalComparisonRow {
  offerId: string;
  vendor: string;
  plan: string;
  rail: string;
  upfront: string;
  perCharge: string;
  horizon: string;
  notes: string[];
  passed: boolean;
  failedCodes: string[];
}

/** 比较之前就被排除的报价，例如地区不可用。 */
export interface ApprovalExclusion {
  offerId: string;
  reason: string;
}

/** 已发行卡片的可展示字段。调用方只能传入掩码卡号。 */
export interface ApprovalCardSummary {
  cardId?: string;
  maskedNumber?: string;
  status?: string;
}

/**
 * 审批页模型。
 * nonceHint 只是操作说明，例如终端里打印了 nonce；真正的 nonce 不进这个模型。
 */
export interface ApprovalPageModel {
  approvalRequestId: string;
  status: ApprovalStatus;
  intent: string;
  chosen: ApprovalChosenTerms;
  presentedTermsHash: string;
  reasons: string[];
  comparison: ApprovalComparisonRow[];
  excluded: ApprovalExclusion[];
  expiresAt: string;
  needsMcc: boolean;
  nonceHint: string;
  demoMode: boolean;
  card?: ApprovalCardSummary;
}

/** renderApprovalPage 的第二个参数。csrfToken 写入隐藏域 csrf。 */
export interface ApprovalRenderOptions {
  csrfToken: string;
}

/** 审计表里一条账本事件的展示行。 */
export interface AuditEventRow {
  seq: number;
  at: string;
  kind: string;
  summary: string;
  source?: 'simulated' | 'observed';
  hashShort: string;
}

/** 审计页上的卡片摘要。limit 已是展示用字符串。 */
export interface AuditCardSummary {
  cardId: string;
  status: string;
  limit: string;
  currency: string;
}

/** 审计页模型。chainValid 为 false 时徽章必须写 Chain BROKEN。 */
export interface AuditPageModel {
  chainValid: boolean;
  verifyError?: string;
  events: AuditEventRow[];
  cards: AuditCardSummary[];
}

/** 首页列表中的一条审批。 */
export interface IndexApprovalRow {
  id: string;
  status: string;
  vendor: string;
  amount: string;
  currency: string;
}

/** 首页模型。 */
export interface IndexPageModel {
  approvals: IndexApprovalRow[];
}

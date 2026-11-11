// View models for approval, audit, and index pages; renderers never access the ledger or network.

/** Approval lifecycle in the console. */
export type ApprovalStatus =
  | 'requested'
  | 'approved'
  | 'issuing'
  | 'issued'
  | 'failed'
  | 'rejected'
  | 'expired';

/** Price verification status shared with policy requests and offer snapshots.
 * Unverified prices cannot support savings claims. */
export type PriceStatus = 'verified' | 'price_unverified';

/** Same interval codes as policy requests and approval_requested events. */
export type ChargeInterval = 'PER_TRANSACTION' | 'MONTHLY' | 'ALL_TIME';

/** Same transaction-count codes as policy requests and approval_requested events. */
export type AllowedTransactionCount = 'SINGLE' | 'MULTIPLE';

/** Same rail as policy requests; only card terms can be approved here. */
export type PaymentRail = 'card' | 'x402';

/** Latest run_started mode. Offline pages never say sandbox.
 * Omit when unavailable so the page says mode unknown. */
export type ConsoleRunMode = 'offline_emulator' | 'sandbox' | 'console_sandbox';

/** Terms currently presented for human approval.
 * The builder formats amount for display. */
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

/** Comparison row; x402 must be marked as not payable by card. */
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

/** Offer excluded before comparison, for example because of region availability. */
export interface ApprovalExclusion {
  offerId: string;
  reason: string;
}

/** Displayable card fields; callers must supply masked numbers only. */
export interface ApprovalCardSummary {
  cardId?: string;
  maskedNumber?: string;
  status?: string;
}

/** Approval page model. nonceHint contains instructions only; never the actual nonce. */
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
  /** Latest run_started mode; omit when unavailable. */
  runMode?: ConsoleRunMode;
  card?: ApprovalCardSummary;
}

/** Render options; csrfToken populates the hidden csrf field. */
export interface ApprovalRenderOptions {
  csrfToken: string;
}

/** Display row for one ledger event. */
export interface AuditEventRow {
  seq: number;
  at: string;
  kind: string;
  summary: string;
  source?: 'simulated' | 'observed';
  hashShort: string;
  /** Apply warning styling to the full summary, including control mismatches. */
  warning?: boolean;
}

/** Audit card summary with an already formatted limit. */
export interface AuditCardSummary {
  cardId: string;
  status: string;
  limit: string;
  currency: string;
}

/** Audit model; a false chainValid must display Chain BROKEN. */
export interface AuditPageModel {
  chainValid: boolean;
  verifyError?: string;
  events: AuditEventRow[];
  cards: AuditCardSummary[];
  /** Latest run_started mode; omit when unavailable to display mode unknown. */
  runMode?: ConsoleRunMode;
  /** Policy notes from the same run_started; omit if absent. */
  policyNotes?: readonly string[];
}

/** One approval in the index list. */
export interface IndexApprovalRow {
  id: string;
  status: string;
  vendor: string;
  amount: string;
  currency: string;
}

/** Index page model. */
export interface IndexPageModel {
  approvals: IndexApprovalRow[];
  /** Latest run_started when the caller supplies ledger events. */
  runMode?: ConsoleRunMode;
}

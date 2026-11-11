// 把账本记录和审批请求收成视图模型。摘要和短哈希只在这里定义。

import type { CardAuditEvent, ChainVerification, LedgerEvent } from '@sk/ledger';
import { termsHash, type ApprovalRequest } from '@sk/policy';
import { formatMinor, formatMinorRange, formatSignedDecimal } from './money.js';
import type {
  ApprovalCardSummary,
  ApprovalComparisonRow,
  ApprovalPageModel,
  ApprovalStatus,
  AuditCardSummary,
  AuditEventRow,
  AuditPageModel,
} from './models.js';

/** @sk/ledger 的账本信封。服务器直接把读出的记录传进来。 */
export type LedgerRecord = LedgerEvent;

/** 服务器保存的一条审批。比较表从 events 里的账本记录拼出来。 */
export interface ApprovalRecordInput {
  approvalId: string;
  request: ApprovalRequest;
  status: ApprovalStatus;
  nonceHint: string;
  csrf: string;
  card?: ApprovalCardSummary;
  events?: readonly LedgerRecord[];
}

/** 渲染审批页所需的模型和 CSRF。nonce 不在这里。 */
export interface BuiltApprovalPage {
  model: ApprovalPageModel;
  csrfToken: string;
}

/** 哈希去掉 0x 前缀后的前 12 个十六进制字符。 */
export function hashShort(hash: string): string {
  const body = /^0x/i.test(hash) ? hash.slice(2) : hash;
  return body.slice(0, 12);
}

/** 由账本记录和链校验结果生成审计页模型。链完整时忽略 verifyError。 */
export function buildAuditPageModel(
  events: readonly LedgerRecord[],
  verifyResult: ChainVerification,
): AuditPageModel {
  const index = indexLedger(events);
  const model: AuditPageModel = {
    chainValid: verifyResult.ok,
    events: events.map((record) => toAuditRow(record, index)),
    cards: cardsFrom(events, index),
  };
  if (!verifyResult.ok && verifyResult.error !== undefined && verifyResult.error !== '') {
    model.verifyError = verifyResult.error;
  }
  return model;
}

/** 由服务器上的审批记录生成审批页模型，金额在这里格式化。 */
export function buildApprovalPageModel(input: ApprovalRecordInput): BuiltApprovalPage {
  const events = input.events ?? [];
  const request = input.request;
  const directory = offerDirectory(events);
  const comparisonEvent = latestComparison(events, request.offerId);
  const decision = latestDecision(events, request.offerId);
  const snapshot = latestSnapshot(events, request.offerId);
  const chosen: ApprovalPageModel['chosen'] = {
    offerId: request.offerId,
    vendor: request.vendor,
    product: request.product,
    plan: request.plan,
    amount: formatMinor(request.amountMinor, request.currency),
    currency: request.currency,
    interval: request.interval,
    allowedTransactionCount: request.allowedTransactionCount,
    commitmentMonths: request.commitmentMonths,
    priceStatus: request.priceStatus,
    rail: request.rail,
  };
  if (request.merchantCategoryCode !== undefined) {
    chosen.merchantCategoryCode = request.merchantCategoryCode;
  }
  const card = input.card ?? cardFromLedger(events, input.approvalId, request.approvalRequestId);
  const model: ApprovalPageModel = {
    approvalRequestId: request.approvalRequestId,
    status: input.status,
    intent: snapshot?.intent ?? request.product,
    chosen,
    presentedTermsHash: presentedHash(request),
    reasons: decision === undefined ? [] : [...decision.reasons],
    comparison: comparisonRows(comparisonEvent, decision, directory, request.currency),
    excluded: comparisonEvent === undefined ? [] : comparisonEvent.excluded.map((item) => ({
      offerId: item.offerId,
      reason: item.reason,
    })),
    expiresAt: request.expiresAt,
    needsMcc: request.merchantCategoryCode === undefined,
    nonceHint: input.nonceHint,
    demoMode: events.some((record) => {
      const event = record.event;
      return event.kind === 'approval_granted'
        && event.approvalRequestId === request.approvalRequestId
        && event.demoAutoApproved;
    }),
  };
  if (card !== undefined) model.card = card;
  return { model, csrfToken: input.csrf };
}

interface RequestMoney {
  minor: number;
  currency: string;
}

interface LedgerIndex {
  requestMoney: Map<string, RequestMoney>;
  approvalToRequest: Map<string, string>;
  cardCurrency: Map<string, string>;
}

/** 先扫一遍金额和币种，后面的授权、对账和卡片表都用这份索引。 */
function indexLedger(events: readonly LedgerRecord[]): LedgerIndex {
  const requestMoney = new Map<string, RequestMoney>();
  const approvalToRequest = new Map<string, string>();
  const cardCurrency = new Map<string, string>();
  for (const record of events) {
    const event = record.event;
    if (event.kind === 'approval_requested') {
      requestMoney.set(event.approvalRequestId, { minor: event.amountMinor, currency: event.currency });
    } else if (event.kind === 'approval_granted') {
      approvalToRequest.set(event.approvalId, event.approvalRequestId);
    } else if (event.kind === 'card_issued' && event.cardId !== undefined) {
      const requestId = approvalToRequest.get(event.approvalId);
      const money = requestId === undefined ? undefined : requestMoney.get(requestId);
      if (money !== undefined) cardCurrency.set(event.cardId, money.currency);
    }
  }
  return { requestMoney, approvalToRequest, cardCurrency };
}

/** 每种账本事件的摘要。调用方不要再各自写一套。 */
function summarize(event: CardAuditEvent, index: LedgerIndex): string {
  switch (event.kind) {
    case 'offers_snapshot':
      return `Offers for "${event.intent}": ${event.offers.length}`;
    case 'comparison':
      return `Compared ${event.candidates.length}, excluded ${event.excluded.length}`;
    case 'decision':
      return event.chosenOfferId === undefined
        ? `Decision ${event.action}`
        : `Decision ${event.action}, chosen ${event.chosenOfferId}`;
    case 'approval_requested':
      return `Requested ${formatMinor(event.amountMinor, event.currency)} ${event.currency} for ${event.offerId}`;
    case 'approval_granted':
      return event.demoAutoApproved
        ? `Granted ${event.approvalId} (demo auto-approval)`
        : `Granted ${event.approvalId}`;
    case 'approval_rejected':
      return `Rejected ${event.approvalRequestId}: ${event.code}`;
    case 'card_issued':
      return event.cardStatus === undefined
        ? `Issued ${event.cardId ?? 'unknown card'}`
        : `Issued ${event.cardId ?? 'unknown card'} ${event.cardStatus}`;
    case 'card_issue_unconfirmed':
      return `Card issue unconfirmed: ${event.reason}`;
    case 'authorization': {
      const merchant = event.merchantName === undefined || event.merchantName === ''
        ? 'unknown merchant'
        : event.merchantName;
      const amount = formatSignedDecimal(event.amount, event.currency);
      return `${amount} ${event.currency} at ${merchant} (${event.mapped})`;
    }
    case 'card_frozen':
      return `Frozen by ${event.by}: ${event.reason}`;
    case 'reconciliation': {
      const currency = index.cardCurrency.get(event.cardId);
      return `Settled ${minorText(event.settledMinor, currency)}, pending ${minorText(event.pendingMinor, currency)}, ${event.failedCount} failed`;
    }
    case 'webhook_received':
      return event.deduped ? `Webhook ${event.name} (duplicate)` : `Webhook ${event.name}`;
    case 'raw_response':
      return `Response ${event.status} ${event.endpoint}`;
    default: {
      const unexpected: never = event;
      throw new Error(`unknown_event_kind:${String(unexpected)}`);
    }
  }
}

/** 知道币种就按币种格式化；不知道时保留最小单位，避免猜错小数位。 */
function minorText(minor: number, currency: string | undefined): string {
  if (currency === undefined) return `${minor} minor`;
  return `${formatMinor(minor, currency)} ${currency}`;
}

function toAuditRow(record: LedgerRecord, index: LedgerIndex): AuditEventRow {
  const row: AuditEventRow = {
    seq: record.seq,
    at: record.at,
    kind: record.event.kind,
    summary: summarize(record.event, index),
    hashShort: hashShort(record.hash),
  };
  if (record.event.kind === 'authorization') row.source = record.event.source;
  return row;
}

function cardsFrom(events: readonly LedgerRecord[], index: LedgerIndex): AuditCardSummary[] {
  const cards: AuditCardSummary[] = [];
  const seen = new Set<string>();
  for (const record of events) {
    const event = record.event;
    if (event.kind !== 'card_issued' || event.cardId === undefined || seen.has(event.cardId)) continue;
    seen.add(event.cardId);
    const requestId = index.approvalToRequest.get(event.approvalId);
    const money = requestId === undefined ? undefined : index.requestMoney.get(requestId);
    cards.push({
      cardId: event.cardId,
      status: event.cardStatus ?? 'unknown',
      limit: money === undefined ? '\u2014' : formatMinor(money.minor, money.currency),
      currency: money === undefined ? '\u2014' : money.currency,
    });
  }
  return cards;
}

type SnapshotEvent = Extract<CardAuditEvent, { kind: 'offers_snapshot' }>;
type ComparisonEvent = Extract<CardAuditEvent, { kind: 'comparison' }>;
type DecisionEvent = Extract<CardAuditEvent, { kind: 'decision' }>;

function latestSnapshot(events: readonly LedgerRecord[], offerId: string): SnapshotEvent | undefined {
  let found: SnapshotEvent | undefined;
  for (const record of events) {
    const event = record.event;
    if (event.kind === 'offers_snapshot' && event.offers.some((offer) => offer.offerId === offerId)) {
      found = event;
    }
  }
  return found;
}

function latestComparison(events: readonly LedgerRecord[], offerId: string): ComparisonEvent | undefined {
  let found: ComparisonEvent | undefined;
  for (const record of events) {
    const event = record.event;
    if (event.kind !== 'comparison') continue;
    const mentioned = event.candidates.some((candidate) => candidate.offerId === offerId)
      || event.excluded.some((item) => item.offerId === offerId);
    if (mentioned) found = event;
  }
  return found;
}

function latestDecision(events: readonly LedgerRecord[], offerId: string): DecisionEvent | undefined {
  let found: DecisionEvent | undefined;
  for (const record of events) {
    const event = record.event;
    if (event.kind !== 'decision') continue;
    const mentioned = event.chosenOfferId === offerId
      || event.ruleResults.some((result) => result.offerId === offerId);
    if (mentioned) found = event;
  }
  return found;
}

function offerDirectory(events: readonly LedgerRecord[]): Map<string, SnapshotEvent['offers'][number]> {
  const directory = new Map<string, SnapshotEvent['offers'][number]>();
  for (const record of events) {
    if (record.event.kind !== 'offers_snapshot') continue;
    for (const offer of record.event.offers) directory.set(offer.offerId, offer);
  }
  return directory;
}

function comparisonRows(
  comparison: ComparisonEvent | undefined,
  decision: DecisionEvent | undefined,
  directory: Map<string, SnapshotEvent['offers'][number]>,
  fallbackCurrency: string,
): ApprovalComparisonRow[] {
  if (comparison === undefined) return [];
  return comparison.candidates.map((candidate) => {
    const offer = directory.get(candidate.offerId);
    const currency = offer?.price.currency ?? fallbackCurrency;
    const results = decision?.ruleResults.filter((result) => result.offerId === candidate.offerId) ?? [];
    const failedCodes = results.filter((result) => !result.pass).map((result) => result.code);
    return {
      offerId: candidate.offerId,
      vendor: offer?.vendor ?? '\u2014',
      plan: offer?.plan ?? '\u2014',
      rail: candidate.rail,
      upfront: formatMinor(candidate.upfrontMinor, currency),
      perCharge: formatMinor(candidate.perChargeMinor, currency),
      horizon: formatMinorRange(candidate.horizonLowMinor, candidate.horizonHighMinor, currency),
      notes: [...candidate.notes],
      passed: results.length > 0 && failedCodes.length === 0,
      failedCodes,
    };
  });
}

function cardFromLedger(
  events: readonly LedgerRecord[],
  approvalId: string,
  requestId: string,
): ApprovalCardSummary | undefined {
  let resolved = approvalId;
  if (resolved === '') {
    for (const record of events) {
      const event = record.event;
      if (event.kind === 'approval_granted' && event.approvalRequestId === requestId) {
        resolved = event.approvalId;
      }
    }
  }
  let found: ApprovalCardSummary | undefined;
  for (const record of events) {
    const event = record.event;
    if (event.kind !== 'card_issued' || event.approvalId !== resolved) continue;
    const card: ApprovalCardSummary = {};
    if (event.cardId !== undefined) card.cardId = event.cardId;
    if (event.maskedNumber !== undefined) card.maskedNumber = event.maskedNumber;
    if (event.cardStatus !== undefined) card.status = event.cardStatus;
    if (card.cardId !== undefined || card.maskedNumber !== undefined || card.status !== undefined) {
      found = card;
    }
  }
  return found;
}

/** 条款哈希必须和 @sk/policy 的 termsHash 一致。校验失败时不把请求内容写进错误。 */
function presentedHash(request: ApprovalRequest): string {
  try {
    return termsHash(request);
  } catch {
    throw new Error('invalid_approval_request');
  }
}

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { approve, approvalRequestSchema, approvalToCardInput, termsHash, type ApprovalRequest } from '@sk/policy';
import { cardRequestIdFromApproval, type AirwallexClient, type Card } from '@sk/airwallex';
import { redactValue, type LedgerStore } from '@sk/ledger';
import { canonicalize } from '@sr/core';
import type { ApprovalRecord, ApprovalStore } from './store.js';

export class ServiceError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
export function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function equalSecret(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(digest(a), 'hex'), Buffer.from(digest(b), 'hex'));
}
export interface ServiceOptions {
  store: ApprovalStore; ledger: LedgerStore; client: AirwallexClient;
  cardholderId: string; now?: () => Date; printNonce?: (line: string) => void;
  printOperatorToken?: (line: string) => void;
  demoMode?: boolean;
}
export class ApprovalService {
  readonly now: () => Date;
  readonly #inflight = new Map<string, Promise<ApprovalRecord>>();
  readonly #operatorTokenHash: Buffer;
  constructor(readonly options: ServiceOptions) {
    this.now = options.now ?? (() => new Date());
    const token = randomBytes(32).toString('hex');
    this.#operatorTokenHash = Buffer.from(digest(token), 'hex');
    (options.printOperatorToken ?? console.log)(`OPERATOR TOKEN: ${token}`);
    // Restart invalidates old terminal nonces and makes pending requests reviewable again.
    for (const saved of options.store.list()) {
      const record = this.get(saved.request.approvalRequestId);
      if (record.status !== 'requested') continue;
      const nonce = randomBytes(24).toString('hex');
      record.nonceHash = digest(nonce); options.store.save(record);
      (options.printNonce ?? console.log)(`APPROVAL NONCE ${record.request.approvalRequestId}: ${nonce}`);
    }
  }
  authenticateOperator(token: string): { kind: 'human' } {
    const matches = timingSafeEqual(Buffer.from(digest(token), 'hex'), this.#operatorTokenHash);
    if (!token || !matches) throw new ServiceError('operator_token_required', 403);
    return { kind: 'human' };
  }
  get(id: string): ApprovalRecord {
    const record = this.options.store.get(id);
    if (!record) throw new ServiceError('approval_not_found', 404);
    if (['requested', 'approved'].includes(record.status) && this.now().getTime() >= Date.parse(record.request.expiresAt)) {
      record.status = 'expired'; this.options.store.save(record);
    }
    return record;
  }
  async submit(input: ApprovalRequest): Promise<{ id: string }> {
    const parsed = approvalRequestSchema.safeParse(input);
    if (!parsed.success || parsed.data.rail !== 'card' || !/^[a-zA-Z0-9_-]{1,128}$/.test(parsed.data.approvalRequestId)) {
      throw new ServiceError('invalid_approval_request');
    }
    const request = parsed.data as ApprovalRequest;
    if (Date.parse(request.createdAt) > this.now().getTime() || Date.parse(request.expiresAt) <= this.now().getTime()) {
      throw new ServiceError('approval_expired');
    }
    if (Date.parse(request.expiresAt) - this.now().getTime() > 60 * 60_000) throw new ServiceError('approval_lifetime_exceeded');
    const existing = this.options.store.get(request.approvalRequestId);
    if (existing) {
      if (termsHash(existing.request) !== termsHash(request) || canonicalize(existing.request) !== canonicalize(request)) {
        throw new ServiceError('request_id_conflict', 409);
      }
      return { id: request.approvalRequestId };
    }
    const open = this.options.store.list().filter(record => this.get(record.request.approvalRequestId).status === 'requested');
    if (open.length >= 20) throw new ServiceError('too_many_open_requests', 429);
    const nonce = randomBytes(24).toString('hex');
    const record: ApprovalRecord = { request, status: 'requested', nonceHash: digest(nonce), csrf: randomBytes(24).toString('hex') };
    this.options.store.save(record);
    this.options.ledger.append({ kind: 'approval_requested', approvalRequestId: request.approvalRequestId,
      offerId: request.offerId, presentedTermsHash: termsHash(request), amountMinor: request.amountMinor,
      currency: request.currency, interval: request.interval, allowedTransactionCount: request.allowedTransactionCount,
      ...(request.merchantCategoryCode === undefined ? {} : { merchantCategoryCode: request.merchantCategoryCode }),
      expiresAt: request.expiresAt,
    }, this.now().toISOString());
    (this.options.printNonce ?? console.log)(`APPROVAL NONCE ${request.approvalRequestId}: ${nonce}`);
    return { id: request.approvalRequestId };
  }
  checkCsrf(record: ApprovalRecord, csrf: string): void {
    if (!csrf || !equalSecret(csrf, record.csrf)) throw new ServiceError('csrf_required', 403);
  }
  async grant(id: string, fields: { nonce: string; csrf: string; presentedTermsHash: string; merchantCategoryCode?: string }): Promise<ApprovalRecord> {
    const record = this.get(id);
    this.checkCsrf(record, fields.csrf);
    if (record.status !== 'requested') throw new ServiceError(`approval_${record.status}`, 409);
    if (!fields.nonce || !equalSecret(digest(fields.nonce), record.nonceHash)) throw new ServiceError('nonce_required', 403);
    if (fields.presentedTermsHash !== termsHash(record.request)) throw new ServiceError('terms_mismatch', 409);
    let approval;
    try { approval = approve(record.request, {
      approver: { kind: 'human', id: this.options.demoMode ? 'demo-operator' : 'console-operator' },
      presentedTermsHash: fields.presentedTermsHash, now: this.now().toISOString(),
      ...(fields.merchantCategoryCode === undefined ? {} : { merchantCategoryCode: fields.merchantCategoryCode }),
    }); } catch { throw new ServiceError('approval_terms_invalid'); }
    record.approval = approval;
    record.input = approvalToCardInput(approval, { cardholderId: this.options.cardholderId, createdBy: approval.approvedBy.id });
    record.status = 'approved'; record.nonceHash = '';
    // Durable identity and deterministic input exist BEFORE the first external effect.
    this.options.store.save(record);
    this.#recordGrant(record);
    return this.issue(id);
  }
  #recordGrant(record: ApprovalRecord): void {
    const approval = record.approval!;
    if (this.options.ledger.read().some(({ event }) => event.kind === 'approval_granted' && event.approvalId === approval.approvalId)) return;
    this.options.ledger.append({ kind: 'approval_granted', approvalRequestId: record.request.approvalRequestId,
      approvalId: approval.approvalId, termsHash: approval.termsHash, presentedTermsHash: termsHash(record.request),
      approver: approval.approvedBy, merchantCategoryCode: approval.request.merchantCategoryCode!, approvedAt: approval.approvedAt,
      demoAutoApproved: approval.approvedBy.id === 'demo-operator',
    }, this.now().toISOString());
  }
  reject(id: string, csrf: string): void {
    const record = this.get(id); this.checkCsrf(record, csrf);
    if (record.status !== 'requested') throw new ServiceError(`approval_${record.status}`, 409);
    record.status = 'rejected'; record.nonceHash = ''; this.options.store.save(record);
    this.options.ledger.append({ kind: 'approval_rejected', approvalRequestId: id, code: 'human_rejected' }, this.now().toISOString());
  }
  /** Internal operator recovery: an attempted issuance is ONLY looked up, never created anew. */
  recover(id: string): Promise<ApprovalRecord> {
    const record = this.get(id);
    if (!record.attempted) throw new ServiceError('recovery_not_attempted', 409);
    return this.issue(id);
  }
  issue(id: string): Promise<ApprovalRecord> {
    const pending = this.#inflight.get(id);
    if (pending) return pending;
    const operation = this.#issue(id).finally(() => this.#inflight.delete(id));
    this.#inflight.set(id, operation);
    return operation;
  }
  async #issue(id: string): Promise<ApprovalRecord> {
    const record = this.get(id);
    if (record.status === 'issued') return record;
    if (!record.approval || !record.input || !['approved', 'issuing', 'failed'].includes(record.status)) {
      throw new ServiceError(`approval_${record.status}`, 409);
    }
    const { approval, input } = record;
    if (input.request_id !== cardRequestIdFromApproval(approval.approvalId)) throw new ServiceError('request_id_conflict', 409);
    // Expiry gates every new issuance. Already attempted cards still need recovery, even after expiry.
    if (!record.attempted && this.now().getTime() >= Date.parse(record.request.expiresAt)) {
      record.status = 'expired'; this.options.store.save(record); throw new ServiceError('approval_expired', 409);
    }
    this.#recordGrant(record);
    let card: Card | undefined = record.card?.cardId === undefined ? undefined : { card_id: record.card.cardId };
    try {
      if (record.attempted) {
        card = await this.options.client.findCardByRequestId(input.request_id, { cardholderId: input.cardholder_id }) ?? card;
      } else {
        record.status = 'issuing'; record.attempted = true; this.options.store.save(record);
        const result = await this.options.client.createCard(input);
        card = result.card;
        // Persist even a partial ID immediately, including when later diagnostics/polling fail.
        if (card) { record.card = { cardId: card.card_id }; this.options.store.save(record); }
        if (result.unconfirmed) {
          const ref = randomUUID();
          this.options.ledger.append({ kind: 'card_issue_unconfirmed', approvalId: approval.approvalId,
            requestId: input.request_id, reason: 'response_shape_unconfirmed', rawResponseRef: ref }, this.now().toISOString());
          this.options.ledger.append({ kind: 'raw_response', ref, endpoint: '/api/v1/issuing/cards/create',
            status: 200, body: redactValue(result.raw) }, this.now().toISOString());
          const recovered = await this.options.client.findCardByRequestId(input.request_id, { cardholderId: input.cardholder_id });
          card = recovered ?? card;
        }
      }
      if (!card) throw new ServiceError('card_issue_unconfirmed', 409);
      record.card = { cardId: card.card_id }; this.options.store.save(record);
      // Bounded polling, no duplicate create on a slow activation or response failure.
      for (let attempt = 0; attempt < 3; attempt++) {
        card = await this.options.client.getCard(card.card_id);
        if (card.card_status === 'ACTIVE') break;
      }
      if (card.card_status !== 'ACTIVE') throw new ServiceError('card_not_active', 409);
      record.card = { cardId: card.card_id, status: card.card_status,
        ...(card.card_number === undefined ? {} : { maskedNumber: card.card_number }) };
      record.status = 'issued'; this.options.store.save(record);
      if (!this.options.ledger.read().some(({ event }) => event.kind === 'card_issued' && event.approvalId === approval.approvalId)) {
        this.options.ledger.append({ kind: 'card_issued', approvalId: approval.approvalId, requestId: input.request_id,
          cardId: card.card_id, cardStatus: card.card_status, controls: input.authorization_controls,
          ...(record.card.maskedNumber === undefined ? {} : { maskedNumber: record.card.maskedNumber }),
        }, this.now().toISOString());
      }
      return record;
    } catch {
      record.status = 'failed'; this.options.store.save(record);
      if (!this.options.ledger.read().some(({ event }) => event.kind === 'card_issue_unconfirmed' && event.approvalId === approval.approvalId)) {
        this.options.ledger.append({ kind: 'card_issue_unconfirmed',
          approvalId: approval.approvalId, requestId: input.request_id, reason: 'issuance_or_activation_unconfirmed',
        }, this.now().toISOString());
      }
      throw new ServiceError('card_issue_unconfirmed', 409);
    }
  }
}

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { approve, approvalRequestSchema, approvalToCardInput, termsHash, type ApprovalRequest } from '@sk/policy';
import { AirwallexApiError, cardRequestIdFromApproval, type AirwallexClient, type Card } from '@sk/airwallex';
import { redactValue, type LedgerStore } from '@sk/ledger';
import { canonicalize } from '@sr/core';
import { TransactionLoop } from './transactions.js';
import type { ApprovalRecord, ApprovalStore } from './store.js';
import { cardControlsReadback } from './airwallex-client.js';

export class ServiceError extends Error {
  constructor(readonly code: string, readonly status = 400, readonly provider?: { status: number; code: string; message: string; step: string }) { super(code); }
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
  sleep?: (ms: number) => Promise<void>;
}
export class ApprovalService {
  readonly now: () => Date;
  readonly #inflight = new Map<string, Promise<ApprovalRecord>>();
  readonly #operatorTokenHash: Buffer;
  constructor(readonly options: ServiceOptions) {
    this.now = options.now ?? (() => new Date());
    const token = randomBytes(32).toString('hex');
    this.#operatorTokenHash = Buffer.from(digest(token), 'hex');
    if (!options.demoMode) (options.printOperatorToken ?? console.log)(`OPERATOR TOKEN: ${token}`);
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
    const existing = this.options.store.get(request.approvalRequestId);
    if (existing) {
      if (termsHash(existing.request) !== termsHash(request) || canonicalize(existing.request) !== canonicalize(request)) {
        throw new ServiceError('request_id_conflict', 409);
      }
      return { id: request.approvalRequestId };
    }
    const decisionSeq = this.#bindDecision(request);
    if (this.options.store.list().some(record => record.decisionSeq === decisionSeq
      // Legacy stores lack a sequence; conservatively reserve matching decisions in their original window.
      || (record.decisionSeq === undefined && record.request.offerId === request.offerId
        && Date.parse(record.request.createdAt) <= Date.parse(request.createdAt)
        && Date.parse(request.createdAt) < Date.parse(record.request.expiresAt)))) {
      throw new ServiceError('decision_already_requested', 409);
    }
    const open = this.options.store.list().filter(record => this.get(record.request.approvalRequestId).status === 'requested');
    if (open.length >= 20) throw new ServiceError('too_many_open_requests', 429);
    const nonce = randomBytes(24).toString('hex');
    const record: ApprovalRecord = { request, decisionSeq, status: 'requested', nonceHash: digest(nonce), csrf: randomBytes(24).toString('hex') };
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
  #bindDecision(request: ApprovalRequest): number {
    const events = this.options.ledger.read();
    const decisionIndex = events.map((row, index) => ({ ...row, index })).reverse().find(({ event, at }) => event.kind === 'decision'
      && event.action === 'ask' && event.chosenOfferId === request.offerId
      && Date.parse(at) === Date.parse(request.createdAt)
      && Date.parse(request.expiresAt) - Date.parse(request.createdAt) <= 15 * 60_000
      && this.now().getTime() - Date.parse(at) <= 15 * 60_000)?.index ?? -1;
    if (decisionIndex < 0) throw new ServiceError('decision_not_found', 409);
    // Ledger sequence defines evidence order; timestamps only bind lifetime and freshness.
    const prior = events.slice(0, decisionIndex).reverse();
    const comparison = prior.find(({ event }) => event.kind === 'comparison');
    const snapshot = prior.find(({ event }) => event.kind === 'offers_snapshot');
    const candidate = comparison?.event.kind === 'comparison'
      ? comparison.event.candidates.find(row => row.offerId === request.offerId) : undefined;
    const offer = snapshot?.event.kind === 'offers_snapshot'
      ? snapshot.event.offers.find(row => row.offerId === request.offerId) : undefined;
    if (!candidate?.terms || !offer || candidate.rail !== 'card' || offer.rail !== 'card'
      || candidate.perChargeMinor !== request.amountMinor || offer.priceStatus !== request.priceStatus
      || Object.entries(candidate.terms).some(([key, value]) => request[key as keyof ApprovalRequest] !== value)
      || candidate.terms.merchantCategoryCode !== request.merchantCategoryCode) {
      throw new ServiceError('terms_not_from_decision', 409);
    }
    return events[decisionIndex]!.seq;
  }
  /** Record redacted provider metadata at the failing operation boundary. */
  providerFailure(error: unknown, endpoint: string, step: string): never {
    if (!(error instanceof AirwallexApiError)) throw error;
    const body = redactValue({ code: error.code, message: error.message }) as { code: string; message: string };
    this.options.ledger.append({ kind: 'raw_response', ref: randomUUID(), endpoint,
      status: error.status, body }, this.now().toISOString());
    throw new ServiceError('airwallex_api_error', 502, { status: error.status, ...body, step });
  }
  async abandon(id: string): Promise<void> {
    if (this.#inflight.has(id)) throw new ServiceError('issuance_in_progress', 409);
    const record = this.get(id);
    if (record.status !== 'failed' || !record.attempted || record.card?.cardId || !record.input) {
      throw new ServiceError('abandon_not_allowed', 409);
    }
    let found;
    try { found = await this.options.client.findCardByRequestId(record.input.request_id, { cardholderId: record.input.cardholder_id }); }
    catch (error) { this.providerFailure(error, '/api/v1/issuing/cards', 'abandon lookup'); }
    if (found) {
      record.card = { cardId: found.card_id }; this.options.store.save(record);
      throw new ServiceError('card_exists_recover_required', 409);
    }
    record.status = 'rejected'; record.nonceHash = ''; this.options.store.save(record);
    this.options.ledger.append({ kind: 'approval_rejected', approvalRequestId: id, code: 'operator_abandoned' }, this.now().toISOString());
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
  async waitForIssuance(): Promise<void> { await Promise.allSettled([...this.#inflight.values()]); }
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
    let endpoint = '/api/v1/issuing/cards';
    let step = 'recovery lookup';
    try {
      if (record.attempted) {
        card = await this.options.client.findCardByRequestId(input.request_id, { cardholderId: input.cardholder_id }) ?? card;
      } else {
        record.status = 'issuing'; record.attempted = true; this.options.store.save(record);
        endpoint = '/api/v1/issuing/cards/create'; step = 'issuance';
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
          endpoint = '/api/v1/issuing/cards'; step = 'recovery lookup';
          const recovered = await this.options.client.findCardByRequestId(input.request_id, { cardholderId: input.cardholder_id });
          card = recovered ?? card;
        }
      }
      if (!card) throw new ServiceError('card_issue_unconfirmed', 409);
      record.card = { cardId: card.card_id }; this.options.store.save(record);
      endpoint = `/api/v1/issuing/cards/${card.card_id}`; step = 'activation';
      // Initial read followed by bounded back-off; recovery never creates a second card.
      const sleep = this.options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
      card = await this.options.client.getCard(card.card_id);
      for (const delay of [500, 1000, 2000, 4000]) {
        if (card.card_status === 'ACTIVE') break;
        await sleep(delay);
        card = await this.options.client.getCard(card.card_id);
      }
      if (card.card_status !== 'ACTIVE') throw new ServiceError('card_not_active', 409);
      step = 'controls readback';
      const actual = cardControlsReadback(this.options.client, card);
      const matches = controlsMatch(input.authorization_controls, actual);
      this.options.ledger.append({ kind: 'controls_readback', cardId: card.card_id, matches,
        expected: input.authorization_controls, actual: redactValue(actual) as Record<string, unknown> }, this.now().toISOString());
      if (!matches) {
        await new TransactionLoop(this).freeze(card.card_id, 'system', 'auto-freeze: controls mismatch');
        throw new ServiceError('controls_mismatch', 409);
      }
      record.card = { cardId: card.card_id, status: card.card_status,
        ...(card.card_number === undefined ? {} : { maskedNumber: card.card_number }) };
      if (!this.options.ledger.read().some(({ event }) => event.kind === 'card_issued' && event.approvalId === approval.approvalId)) {
        this.options.ledger.append({ kind: 'card_issued', approvalId: approval.approvalId, requestId: input.request_id,
          cardId: card.card_id, cardStatus: card.card_status, controls: input.authorization_controls,
          ...(record.card.maskedNumber === undefined ? {} : { maskedNumber: record.card.maskedNumber }),
        }, this.now().toISOString());
      }
      record.status = 'issued'; this.options.store.save(record);
      return record;
    } catch (error) {
      // A system freeze can have persisted newer card state during this attempt.
      const persisted = this.options.store.get(id);
      if (persisted?.card) record.card = persisted.card;
      record.status = 'failed'; this.options.store.save(record);
      if (!this.options.ledger.read().some(({ event }) => event.kind === 'card_issue_unconfirmed' && event.approvalId === approval.approvalId)) {
        this.options.ledger.append({ kind: 'card_issue_unconfirmed',
          approvalId: approval.approvalId, requestId: input.request_id, reason: error instanceof ServiceError && error.code === 'controls_mismatch'
            ? 'controls_mismatch' : 'issuance_or_activation_unconfirmed',
        }, this.now().toISOString());
      }
      if (error instanceof ServiceError) throw error;
      if (error instanceof AirwallexApiError) this.providerFailure(error, endpoint, step);
      throw new ServiceError('card_issue_unconfirmed', 409);
    }
  }
}

/** Normalize decimal amounts and unordered API arrays without discarding unexpected controls. */
export function normalizeControls(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map(item => normalizeControls(item, key)).sort((a, b) => canonicalize(a).localeCompare(canonicalize(b)));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([name, item]) => [name, normalizeControls(item, name)]));
  if (key === 'amount' && (typeof value === 'number' || (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)))
    && Number.isFinite(Number(value))) return Number(value);
  return value;
}

/** Compare sent keys recursively. Limits are conjunctive; provider additions only restrict. */
export function controlsMatch(expected: unknown, actual: unknown, key = '', parent = ''): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    // Compare members projected onto sent keys; only transaction limits allow additions.
    const containsSent = expected.every(item => actual.some(other => controlsMatch(item, other, key)));
    if (parent === 'transaction_limits' && key === 'limits') return containsSent;
    return containsSent && actual.every(item => expected.some(other => controlsMatch(other, item, key)));
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
    const record = actual as Record<string, unknown>;
    return Object.entries(expected).every(([name, value]) => Object.hasOwn(record, name)
      && controlsMatch(value, record[name], name, key));
  }
  return normalizeControls(expected, key) === normalizeControls(actual, key);
}

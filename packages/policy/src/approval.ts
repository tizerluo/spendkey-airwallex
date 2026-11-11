import { randomUUID } from 'node:crypto';
import { canonicalize, sha256Hex } from '@sr/core';
import { z } from 'zod';
import { candidateSchema, currencySchema, mccSchema, minorAmountSchema } from './types.js';
import type { Candidate } from './types.js';
import type { MinorAmount } from './money.js';

export interface ApprovalRequest {
  approvalRequestId: string;
  offerId: string;
  vendor: string;
  product: string;
  plan: Candidate['plan'];
  currency: string;
  amountMinor: MinorAmount;
  interval: 'PER_TRANSACTION' | 'MONTHLY' | 'ALL_TIME';
  allowedTransactionCount: 'SINGLE' | 'MULTIPLE';
  merchantCategoryCode?: string;
  commitmentMonths: number;
  priceStatus: Candidate['priceStatus'];
  createdAt: string;
  expiresAt: string;
}
export interface Approver { kind: 'human' | 'agent'; id: string }
export interface Approval {
  approvalId: string;
  request: ApprovalRequest;
  termsHash: string;
  approvedBy: { kind: 'human'; id: string };
  approvedAt: string;
}
export type ApprovalErrorCode = 'self_approval_forbidden' | 'terms_mismatch' | 'approval_expired' | 'mcc_required';
export class ApprovalError extends Error {
  constructor(readonly code: ApprovalErrorCode) {
    super(code);
    this.name = 'ApprovalError';
  }
}

export const approvalRequestSchema = z.object({
  approvalRequestId: z.string().min(1), offerId: z.string().min(1), vendor: z.string().min(1), product: z.string().min(1),
  plan: z.enum(['monthly', 'annual', 'usage', 'one_time']), currency: currencySchema,
  amountMinor: minorAmountSchema.positive(), interval: z.enum(['PER_TRANSACTION', 'MONTHLY', 'ALL_TIME']),
  allowedTransactionCount: z.enum(['SINGLE', 'MULTIPLE']), merchantCategoryCode: mccSchema.optional(),
  commitmentMonths: z.number().int().nonnegative().safe(), priceStatus: z.enum(['verified', 'price_unverified']),
  createdAt: z.string().datetime({ offset: true }), expiresAt: z.string().datetime({ offset: true }),
}).refine(value => Date.parse(value.expiresAt) > Date.parse(value.createdAt), 'invalid_approval_lifetime');

export interface ApprovalRequestOptions {
  approvalRequestId: string;
  createdAt: string;
  expiresAt: string;
}

export function createApprovalRequest(candidate: Candidate, options: ApprovalRequestOptions): ApprovalRequest {
  candidateSchema.parse(candidate);
  const request: ApprovalRequest = {
    ...options, offerId: candidate.offerId, vendor: candidate.vendor, product: candidate.product,
    plan: candidate.plan, currency: candidate.currency, amountMinor: candidate.perChargeMinor,
    // Recurring plans cap the monthly aggregate at the approved monthly bill.
    interval: candidate.plan === 'monthly' || candidate.plan === 'usage' ? 'MONTHLY' : 'PER_TRANSACTION',
    allowedTransactionCount: candidate.plan === 'annual' || candidate.plan === 'one_time' ? 'SINGLE' : 'MULTIPLE',
    ...(candidate.merchantCategoryCode === undefined ? {} : { merchantCategoryCode: candidate.merchantCategoryCode }),
    commitmentMonths: candidate.commitmentMonths, priceStatus: candidate.priceStatus,
  };
  approvalRequestSchema.parse(request);
  return request;
}

/** Exactly these binding fields, using the same canonical JSON as the core audit chain. */
export function termsHash(request: ApprovalRequest): string {
  approvalRequestSchema.parse(request);
  return sha256Hex(canonicalize({
    offerId: request.offerId, vendor: request.vendor, plan: request.plan, currency: request.currency,
    amountMinor: request.amountMinor, interval: request.interval, allowedTransactionCount: request.allowedTransactionCount,
    merchantCategoryCode: request.merchantCategoryCode, commitmentMonths: request.commitmentMonths,
    expiresAt: request.expiresAt,
  }));
}

export interface ApproveOptions {
  approver: Approver;
  presentedTermsHash: string;
  merchantCategoryCode?: string;
  now: string;
}

export function approve(request: ApprovalRequest, options: ApproveOptions): Approval {
  if (options.approver.kind !== 'human') throw new ApprovalError('self_approval_forbidden');
  z.string().min(1).parse(options.approver.id);
  approvalRequestSchema.parse(request);
  if (options.presentedTermsHash !== termsHash(request)) throw new ApprovalError('terms_mismatch');
  const now = Date.parse(z.string().datetime({ offset: true }).parse(options.now));
  if (now >= Date.parse(request.expiresAt)) throw new ApprovalError('approval_expired');
  if (now < Date.parse(request.createdAt)) throw new RangeError('approval_before_creation');
  const mcc = request.merchantCategoryCode ?? options.merchantCategoryCode;
  if (mcc === undefined || !mccSchema.safeParse(mcc).success) throw new ApprovalError('mcc_required');
  if (request.merchantCategoryCode !== undefined && options.merchantCategoryCode !== undefined
    && options.merchantCategoryCode !== request.merchantCategoryCode) throw new ApprovalError('terms_mismatch');
  // Filling an absent MCC is part of the explicit human approval; record the final terms hash.
  const filledRequest = { ...request, merchantCategoryCode: mcc };
  return {
    approvalId: randomUUID(), request: filledRequest, termsHash: termsHash(filledRequest),
    approvedBy: { kind: 'human', id: options.approver.id }, approvedAt: options.now,
  };
}

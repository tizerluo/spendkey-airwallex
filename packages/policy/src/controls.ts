import { cardRequestIdFromApproval, createCardInputSchema } from '@sk/airwallex';
import type { AuthorizationControls, CreateCardInput } from '@sk/airwallex';
import { ApprovalError, termsHash } from './approval.js';
import type { Approval } from './approval.js';
import { decimalToMinor, minorToDecimal } from './money.js';
import { mccSchema } from './types.js';

/** Fail before issuance if a limit's currency is not explicitly permitted. */
export function assertControlsCurrency(controls: AuthorizationControls): void {
  if (!controls.allowed_currencies.includes(controls.transaction_limits.currency)) {
    throw new RangeError('controls_currency_mismatch');
  }
}

export interface CardInputOptions { cardholderId: string; createdBy: string; nickName?: string }

export function approvalToCardInput(approval: Approval, options: CardInputOptions): CreateCardInput {
  const request = approval.request;
  if (request.rail !== 'card') throw new ApprovalError('rail_not_card');
  if (!mccSchema.safeParse(request.merchantCategoryCode).success) throw new ApprovalError('mcc_required');
  if (approval.approvedBy.kind !== 'human') throw new ApprovalError('self_approval_forbidden');
  if (approval.termsHash !== termsHash(request)) throw new ApprovalError('terms_mismatch');
  if (!approval.approvalId) throw new RangeError('approval_id_required');
  const amount = Number(minorToDecimal(request.amountMinor));
  // Airwallex serializes JSON numbers. Reject any amount that would change cents on that boundary.
  if (request.amountMinor === 0 || decimalToMinor(amount) !== request.amountMinor) {
    throw new RangeError('unrepresentable_card_amount');
  }
  const authorizationControls: AuthorizationControls = {
    allowed_transaction_count: request.allowedTransactionCount,
    allowed_currencies: [request.currency], allowed_merchant_categories: [request.merchantCategoryCode!],
    transaction_limits: { currency: request.currency, limits: [{ amount, interval: request.interval }] },
  };
  assertControlsCurrency(authorizationControls);
  const input: CreateCardInput = {
    request_id: cardRequestIdFromApproval(approval.approvalId), cardholder_id: options.cardholderId,
    created_by: options.createdBy, form_factor: 'VIRTUAL', is_personalized: true,
    program: { purpose: 'COMMERCIAL' }, nick_name: options.nickName ?? request.product,
    authorization_controls: authorizationControls,
  };
  createCardInputSchema.parse(input);
  return input;
}

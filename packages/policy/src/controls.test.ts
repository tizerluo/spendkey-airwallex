import { describe, expect, it } from 'vitest';
import { cardRequestIdFromApproval, createCardInputSchema } from '@sk/airwallex';
import { approvalToCardInput, approve, assertControlsCurrency, createApprovalRequest, termsHash } from './index.js';
import type { Candidate } from './index.js';
import { candidate } from './test-fixtures.js';

function approval(overrides: Partial<Candidate> = {}) {
  const request = createApprovalRequest(candidate(overrides), { approvalRequestId: 'approval_request_test_01',
    createdAt: '2030-01-01T00:00:00Z', expiresAt: '2030-01-01T01:00:00Z' });
  return approve(request, { approver: { kind: 'human', id: 'human_test_01' }, presentedTermsHash: termsHash(request), now: '2030-01-01T00:30:00Z' });
}
const cardOptions = { cardholderId: 'cardholder_test_01', createdBy: 'human_test_01', nickName: 'test-purchase' };

describe('approval to Airwallex controls', () => {
  it('maps the exact create-card body, including approval-derived request ID', () => {
    const input = approval({ perChargeMinor: 1234 });
    input.approvalId = 'approval_test_01';
    const before = structuredClone(input);
    const body = approvalToCardInput(input, cardOptions);
    expect(body).toEqual({
      request_id: cardRequestIdFromApproval('approval_test_01'), cardholder_id: 'cardholder_test_01',
      created_by: 'human_test_01', form_factor: 'VIRTUAL', is_personalized: true,
      program: { purpose: 'COMMERCIAL' }, nick_name: 'test-purchase',
      authorization_controls: {
        allowed_transaction_count: 'MULTIPLE', allowed_currencies: ['USD'], allowed_merchant_categories: ['5734'],
        transaction_limits: { currency: 'USD', limits: [{ amount: 12.34, interval: 'MONTHLY' }] },
      },
    });
    expect(createCardInputSchema.parse(body)).toEqual(body);
    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
    expect(input).toEqual(before);
    expect(approvalToCardInput(input, cardOptions)).toEqual(body);
  });
  it.each(['annual', 'one_time'] as const)('maps %s to a SINGLE charge in the approved currency', plan => {
    const input = approval({ plan, currency: 'EUR' });
    const body = approvalToCardInput(input, { cardholderId: 'cardholder_test_01', createdBy: 'human_test_01' });
    expect(body.nick_name).toBe('Test Product');
    expect(body.authorization_controls).toMatchObject({ allowed_transaction_count: 'SINGLE',
      allowed_currencies: ['EUR'], transaction_limits: { currency: 'EUR', limits: [{ amount: 50, interval: 'PER_TRANSACTION' }] } });
  });
  it.each(['monthly', 'usage'] as const)('caps the monthly aggregate for %s plans', plan => {
    const body = approvalToCardInput(approval({ plan, perChargeMinor: 1234 }), cardOptions);
    expect(body.authorization_controls).toMatchObject({ allowed_transaction_count: 'MULTIPLE',
      transaction_limits: { currency: 'USD', limits: [{ amount: 12.34, interval: 'MONTHLY' }] } });
  });
  it('maps a human-supplied MCC and preserves explicitly approved interval', () => {
    const request = approval().request;
    delete request.merchantCategoryCode;
    request.interval = 'ALL_TIME';
    const approved = approve(request, { approver: { kind: 'human', id: 'human_test_01' },
      presentedTermsHash: termsHash(request), merchantCategoryCode: '5817', now: '2030-01-01T00:30:00Z' });
    expect(approvalToCardInput(approved, cardOptions).authorization_controls).toMatchObject({
      allowed_merchant_categories: ['5817'], transaction_limits: { limits: [{ interval: 'ALL_TIME' }] },
    });
  });
  it('refuses absent MCC instead of sending unrestricted categories', () => {
    const input = approval();
    delete input.request.merchantCategoryCode;
    expect(() => approvalToCardInput(input, cardOptions)).toThrow('mcc_required');
  });
  it('refuses terms tampering', () => {
    const input = approval();
    input.request.currency = 'EUR';
    expect(() => approvalToCardInput(input, cardOptions)).toThrow('terms_mismatch');
  });
  it('asserts that the limit currency is allowed', () => {
    const controls = approvalToCardInput(approval(), cardOptions).authorization_controls;
    expect(() => assertControlsCurrency(controls)).not.toThrow();
    controls.transaction_limits.currency = 'EUR';
    expect(() => assertControlsCurrency(controls)).toThrow('controls_currency_mismatch');
    controls.allowed_currencies = [];
    expect(() => assertControlsCurrency(controls)).toThrow('controls_currency_mismatch');
  });
  it('derives deterministic bounded request IDs from approval IDs, never request IDs', () => {
    const first = approval();
    const second = { ...first, approvalId: 'approval_test_other' };
    const id = approvalToCardInput(first, cardOptions).request_id;
    expect(id).toBe(cardRequestIdFromApproval(first.approvalId));
    expect(id).toMatch(/^spk_[0-9a-f]{40}$/);
    expect(id.length).toBeLessThanOrEqual(50);
    expect(approvalToCardInput(first, cardOptions).request_id).toBe(id);
    expect(approvalToCardInput(second, cardOptions).request_id).not.toBe(id);
  });
  it('refuses a card limit that loses cents as a JSON number', () => {
    expect(() => approvalToCardInput(approval({ perChargeMinor: Number.MAX_SAFE_INTEGER }), cardOptions)).toThrow('unrepresentable_card_amount');
  });
  it('rejects zero-valued approved terms even when supplied directly', () => {
    const input = approval();
    input.request.amountMinor = 0;
    expect(() => approvalToCardInput(input, cardOptions)).toThrow();
  });
});

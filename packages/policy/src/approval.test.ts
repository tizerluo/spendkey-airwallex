import { describe, expect, it } from 'vitest';
import { canonicalize, sha256Hex } from '@sr/core';
import { ApprovalError, approve, createApprovalRequest, termsHash } from './index.js';
import type { ApprovalRequest, ApproveOptions } from './index.js';
import { candidate } from './test-fixtures.js';

const times = { approvalRequestId: 'approval_request_test_01', createdAt: '2030-01-01T00:00:00Z', expiresAt: '2030-01-01T01:00:00Z' };
function request(): ApprovalRequest { return createApprovalRequest(candidate(), times); }
function options(input: ApprovalRequest, overrides: Partial<ApproveOptions> = {}): ApproveOptions {
  return { approver: { kind: 'human', id: 'human_test_01' }, presentedTermsHash: termsHash(input), now: '2030-01-01T00:30:00Z', ...overrides };
}
function expectCode(action: () => unknown, code: string) {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(ApprovalError);
    expect(error).toMatchObject({ code });
    return;
  }
  expect.fail(`Expected ApprovalError ${code}`);
}

describe('approval requests', () => {
  it.each([
    ['monthly', 'MULTIPLE', 'MONTHLY'], ['usage', 'MULTIPLE', 'MONTHLY'],
    ['annual', 'SINGLE', 'PER_TRANSACTION'], ['one_time', 'SINGLE', 'PER_TRANSACTION'],
  ] as const)('maps %s to %s charges with %s limits', (plan, allowedTransactionCount, interval) => {
    const result = createApprovalRequest(candidate({ plan, upfrontMinor: 0, perChargeMinor: 1234 }), times);
    expect(result).toEqual({
      ...times, offerId: 'offer_test_monthly', vendor: 'Test Vendor', product: 'Test Product', plan,
      rail: 'card', currency: 'USD', amountMinor: 1234, interval, allowedTransactionCount,
      merchantCategoryCode: '5734', commitmentMonths: 1, priceStatus: 'verified',
    });
  });
  it('rejects invalid time windows and candidate money', () => {
    expect(() => createApprovalRequest(candidate(), { ...times, expiresAt: times.createdAt })).toThrow();
    expect(() => createApprovalRequest(candidate({ perChargeMinor: 1.5 }), times)).toThrow();
  });
  it('rejects a zero charge before presenting an approval request', () => {
    expect(() => createApprovalRequest(candidate({ plan: 'usage', upfrontMinor: 0, perChargeMinor: 0 }), times)).toThrow();
  });
});

describe('termsHash', () => {
  it('is lowercase SHA-256 over exactly the binding fields using core canonicalization', () => {
    const input = request();
    const binding = {
      offerId: input.offerId, vendor: input.vendor, plan: input.plan, rail: input.rail, currency: input.currency,
      amountMinor: input.amountMinor, interval: input.interval, allowedTransactionCount: input.allowedTransactionCount,
      merchantCategoryCode: input.merchantCategoryCode, commitmentMonths: input.commitmentMonths, expiresAt: input.expiresAt,
    };
    expect(termsHash(input)).toMatch(/^[0-9a-f]{64}$/);
    expect(termsHash(input)).toBe(sha256Hex(canonicalize(binding)));
    const reordered = Object.fromEntries(Object.entries(input).reverse()) as unknown as ApprovalRequest;
    expect(termsHash(reordered)).toBe(termsHash(input));
    expect(termsHash({ ...input, approvalRequestId: 'another_test_request', product: 'Display Label',
      priceStatus: 'price_unverified', createdAt: '2029-12-31T23:00:00Z' })).toBe(termsHash(input));
  });
  it.each([
    { offerId: 'offer_test_other' }, { vendor: 'Other Test Vendor' }, { plan: 'annual' }, { currency: 'EUR' }, { rail: 'x402' },
    { amountMinor: 5001 }, { interval: 'PER_TRANSACTION' }, { interval: 'ALL_TIME' }, { allowedTransactionCount: 'SINGLE' },
    { merchantCategoryCode: '5817' }, { commitmentMonths: 12 }, { expiresAt: '2030-01-01T02:00:00Z' },
  ] satisfies Partial<ApprovalRequest>[])('changes when a binding field changes: %j', change => {
    const input = request();
    expect(termsHash({ ...input, ...change })).not.toBe(termsHash(input));
  });
  it('binds absence and addition of the MCC', () => {
    const input = request();
    const withoutMcc = { ...input };
    delete withoutMcc.merchantCategoryCode;
    expect(termsHash(withoutMcc)).not.toBe(termsHash(input));
  });
});

describe('human approval', () => {
  it('records a human, timestamp, independent request copy and unique approval ID', () => {
    const input = request();
    const opts = options(input);
    const approval = approve(input, opts);
    expect(approval).toMatchObject({ request: input, termsHash: termsHash(input), approvedBy: opts.approver, approvedAt: opts.now });
    expect(approval.approvalId).toMatch(/^[a-f0-9-]{36}$/);
    expect(approve(input, opts).approvalId).not.toBe(approval.approvalId);
    input.amountMinor = 9999;
    opts.approver.id = 'human_test_other';
    expect(approval.request.amountMinor).toBe(5000);
    expect(approval.approvedBy.id).toBe('human_test_01');
  });
  it('forbids agent self-approval even with matching terms', () => {
    const input = request();
    expectCode(() => approve(input, options(input, { approver: { kind: 'agent', id: 'agent_test_01' } })), 'self_approval_forbidden');
  });
  it('rejects stale presented terms', () => {
    const input = request();
    const opts = options(input);
    input.amountMinor += 1;
    expectCode(() => approve(input, opts), 'terms_mismatch');
  });
  it.each(['2030-01-01T01:00:00Z', '2030-01-01T01:00:01Z'])('rejects at and after expiration: %s', now => {
    const input = request();
    expectCode(() => approve(input, options(input, { now })), 'approval_expired');
  });
  it('accepts just before expiration, rejects invalid or pre-creation clocks', () => {
    const input = request();
    expect(approve(input, options(input, { now: '2030-01-01T00:59:59.999Z' })).approvedBy.kind).toBe('human');
    expect(() => approve(input, options(input, { now: 'invalid' }))).toThrow();
    expect(() => approve(input, options(input, { now: '2029-12-31T23:59:59Z' }))).toThrow('approval_before_creation');
  });
  it('requires a valid four-digit MCC when absent and records the final hash when supplied', () => {
    const input = request();
    delete input.merchantCategoryCode;
    expectCode(() => approve(input, options(input)), 'mcc_required');
    for (const merchantCategoryCode of ['', '123', '12345', 'abcd', ' 5734']) {
      expectCode(() => approve(input, options(input, { merchantCategoryCode })), 'mcc_required');
    }
    const opts = options(input, { merchantCategoryCode: '5734' });
    const approval = approve(input, opts);
    expect(approval.request.merchantCategoryCode).toBe('5734');
    expect(approval.termsHash).toBe(termsHash(approval.request));
    expect(approval.termsHash).not.toBe(opts.presentedTermsHash);
    expect(input).not.toHaveProperty('merchantCategoryCode');
  });
  it('does not allow replacing a bound MCC', () => {
    const input = request();
    expectCode(() => approve(input, options(input, { merchantCategoryCode: '5817' })), 'terms_mismatch');
    expect(approve(input, options(input, { merchantCategoryCode: '5734' })).request.merchantCategoryCode).toBe('5734');
  });
});

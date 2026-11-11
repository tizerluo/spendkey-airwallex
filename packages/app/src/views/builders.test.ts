// 页面模型构建测试。账本记录是普通对象，不打开文件，也不访问网络。

import type { CardAuditEvent } from '@sk/ledger';
import { termsHash, type ApprovalRequest } from '@sk/policy';
import { describe, expect, it } from 'vitest';
import { renderApprovalPage, renderAuditPage } from '../index.js';
import { buildApprovalPageModel, buildAuditPageModel, buildIndexPageModel, hashShort } from './builders.js';
import type { LedgerRecord } from './builders.js';

const AT = '2030-01-01T00:00:00.000Z';
const LATER = '2030-01-01T01:00:00.000Z';
const CSRF = 'csrf-marker-01';
const NONCE = 'nonce-secret-test-01';

it('builds index rows using currency exponents and preserves record order', () => {
  expect(buildIndexPageModel([
    { request: request({ currency: 'JPY', amountMinor: 1250 }), status: 'requested' },
    { request: request({ currency: 'KWD', amountMinor: 1250 }), status: 'issued' },
    { request: request({ currency: 'ZZZ', amountMinor: 1250 }), status: 'expired' },
  ]).approvals.map(({ amount, currency, status }) => ({ amount, currency, status }))).toEqual([
    { amount: '1250', currency: 'JPY', status: 'requested' },
    { amount: '1.250', currency: 'KWD', status: 'issued' },
    { amount: '12.50', currency: 'ZZZ', status: 'expired' },
  ]);
  expect(buildIndexPageModel([])).toEqual({ approvals: [] });
});

it('keeps odd audit amounts visible even when the chain is broken', () => {
  const events = purchaseEvents();
  events.push(
    envelope(6, { kind: 'authorization', source: 'observed', cardId: 'card_test_01', amount: '-12.50', currency: 'JPY', mapped: 'approved' }),
    envelope(7, { kind: 'authorization', source: 'observed', cardId: 'card_test_01', amount: '-12.50', currency: 'ZZZ', mapped: 'approved' }),
    envelope(8, { kind: 'authorization', source: 'observed', cardId: 'card_test_01', amount: '-12.50', currency: 'UNKNOWN', mapped: 'approved' }),
    envelope(9, { kind: 'reconciliation', cardId: 'card_test_01', window: { from: AT, to: LATER },
      settledMinor: 1.5, pendingMinor: Number.MAX_SAFE_INTEGER + 1, failedCount: 0, transactionIds: [] }),
  );
  const approval = events.find(({ event }) => event.kind === 'approval_requested')!.event;
  if (approval.kind !== 'approval_requested') throw new Error('missing_test_approval');
  approval.amountMinor = 1.5;
  expect(() => buildAuditPageModel(events, { ok: false, error: 'hash_mismatch' })).not.toThrow();
  const page = buildAuditPageModel(events, { ok: false, error: 'hash_mismatch' });
  const html = renderAuditPage(page);
  expect(html).toContain('-12.50 JPY (unformatted)');
  expect(html).toContain('-12.50 ZZZ at');
  expect(html).toContain('-12.50 UNKNOWN (unformatted)');
  expect(html).toContain('Requested 1.5 USD (unformatted)');
  expect(html).toContain('Settled 1.5 USD (unformatted), pending 9007199254740992 USD (unformatted)');
  expect(page.cards[0]?.limit).toBe('1.5 USD (unformatted)');
  expect(html).toContain('Chain BROKEN');
});

function request(overrides: Partial<ApprovalRequest> = {}, withMcc = true): ApprovalRequest {
  const approval: ApprovalRequest = {
    approvalRequestId: 'approval_request_test_01',
    offerId: 'offer_test_01',
    vendor: 'Example Vendor',
    product: 'Example Product',
    plan: 'monthly',
    rail: 'card',
    currency: 'USD',
    amountMinor: 5000,
    interval: 'MONTHLY',
    allowedTransactionCount: 'MULTIPLE',
    commitmentMonths: 12,
    priceStatus: 'price_unverified',
    createdAt: AT,
    expiresAt: LATER,
    ...overrides,
  };
  if (withMcc && approval.merchantCategoryCode === undefined) approval.merchantCategoryCode = '7372';
  return approval;
}

function envelope(seq: number, event: CardAuditEvent): LedgerRecord {
  const head = seq.toString(16).padStart(12, 'c');
  return {
    seq,
    at: AT,
    prevHash: `0x${'11'.repeat(32)}`,
    hash: `0x${head}${'ab'.repeat(26)}`,
    event,
  };
}

function purchaseEvents(): LedgerRecord[] {
  const events: CardAuditEvent[] = [
    {
      kind: 'offers_snapshot',
      intent: 'monthly search tool',
      offers: [
        {
          offerId: 'offer_test_01',
          vendor: 'Example Vendor',
          product: 'Example Product',
          plan: 'monthly',
          rail: 'card',
          price: { amount: '50.00', currency: 'USD', unit: 'per_month' },
          priceStatus: 'price_unverified',
          availability: 'available',
        },
        {
          offerId: 'offer_x402_01',
          vendor: 'Example API',
          product: 'Usage API',
          plan: 'usage',
          rail: 'x402',
          price: { amount: '0.01', currency: 'USD', unit: 'per_call' },
          priceStatus: 'verified',
          availability: 'available',
        },
      ],
    },
    {
      kind: 'comparison',
      candidates: [
        {
          offerId: 'offer_test_01',
          rail: 'card',
          upfrontMinor: 5000,
          perChargeMinor: 5000,
          horizonLowMinor: 5000,
          horizonHighMinor: 60000,
          notes: ['fits the monthly budget'],
        },
        {
          offerId: 'offer_x402_01',
          rail: 'x402',
          upfrontMinor: 0,
          perChargeMinor: 1,
          horizonLowMinor: 12,
          horizonHighMinor: 120,
          notes: ['usage range'],
        },
      ],
      excluded: [{ offerId: 'offer_region_01', reason: 'region_unavailable' }],
    },
    {
      kind: 'decision',
      action: 'ask',
      chosenOfferId: 'offer_test_01',
      reasons: ['human_approval_required', 'price_unverified'],
      ruleResults: [
        { offerId: 'offer_test_01', rule: 'human', pass: true, code: 'human_approval_required' },
        { offerId: 'offer_x402_01', rule: 'rail', pass: false, code: 'rail_not_card' },
      ],
    },
    {
      kind: 'approval_requested',
      approvalRequestId: 'approval_request_test_01',
      offerId: 'offer_test_01',
      presentedTermsHash: 'a'.repeat(64),
      amountMinor: 5000,
      currency: 'USD',
      interval: 'MONTHLY',
      allowedTransactionCount: 'MULTIPLE',
      merchantCategoryCode: '7372',
      expiresAt: LATER,
    },
    {
      kind: 'approval_granted',
      approvalRequestId: 'approval_request_test_01',
      approvalId: 'approval_test_01',
      termsHash: 'b'.repeat(64),
      presentedTermsHash: 'a'.repeat(64),
      approver: { kind: 'human', id: 'demo-operator' },
      merchantCategoryCode: '7372',
      approvedAt: AT,
      demoAutoApproved: true,
    },
    {
      kind: 'card_issued',
      approvalId: 'approval_test_01',
      requestId: 'spk_test_request_01',
      cardId: 'card_test_01',
      cardStatus: 'ACTIVE',
      maskedNumber: '****0000',
      controls: { currency: 'USD' },
    },
  ];
  return events.map((event, seq) => envelope(seq, event));
}

describe('hashShort', () => {
  it('取 0x 后面的前 12 个十六进制字符', () => {
    expect(hashShort(`0x${'ab'.repeat(6)}${'0'.repeat(52)}`)).toBe('abababababab');
    expect(hashShort(`0X${'cd'.repeat(32)}`)).toBe('cdcdcdcdcdcd');
    expect(hashShort('abcdefabcdef99')).toBe('abcdefabcdef');
  });
});

describe('buildApprovalPageModel', () => {
  it('用审批请求和账本记录生成页面模型，金额按币种格式化', () => {
    const approval = request();
    const built = buildApprovalPageModel({
      approvalId: 'approval_test_01',
      request: approval,
      status: 'requested',
      nonceHint: 'nonce printed in operator terminal',
      csrf: CSRF,
      events: purchaseEvents(),
    });

    expect(built.csrfToken).toBe(CSRF);
    expect(JSON.stringify(built.model)).not.toContain(CSRF);
    expect(JSON.stringify(built.model)).not.toContain(NONCE);
    expect(built.model.presentedTermsHash).toBe(termsHash(approval));
    expect(built.model.intent).toBe('monthly search tool');
    expect(built.model.demoMode).toBe(true);
    expect(built.model.needsMcc).toBe(false);
    expect(built.model.chosen.amount).toBe('50.00');
    expect(built.model.chosen.rail).toBe('card');
    expect(built.model.chosen.merchantCategoryCode).toBe('7372');
    expect(built.model.reasons).toEqual(['human_approval_required', 'price_unverified']);
    expect(built.model.card).toEqual({ cardId: 'card_test_01', maskedNumber: '****0000', status: 'ACTIVE' });
    expect(built.model.comparison).toEqual([
      {
        offerId: 'offer_test_01',
        vendor: 'Example Vendor',
        plan: 'monthly',
        rail: 'card',
        upfront: '50.00',
        perCharge: '50.00',
        horizon: '50.00-600.00',
        notes: ['fits the monthly budget'],
        passed: true,
        failedCodes: [],
      },
      {
        offerId: 'offer_x402_01',
        vendor: 'Example API',
        plan: 'usage',
        rail: 'x402',
        upfront: '0.00',
        perCharge: '0.01',
        horizon: '0.12-1.20',
        notes: ['usage range'],
        passed: false,
        failedCodes: ['rail_not_card'],
      },
    ]);
    expect(built.model.excluded).toEqual([{ offerId: 'offer_region_01', reason: 'region_unavailable' }]);

    const html = renderApprovalPage(built.model, { csrfToken: built.csrfToken });
    expect(html).toContain('Not payable by card');
    expect(html).toContain('value="csrf-marker-01"');
    expect(html).not.toContain(NONCE);
    expect(html.includes('<script')).toBe(false);
  });

  it('日元和科威特第纳尔不用两位小数，缺商户类别时需要填写', () => {
    const yen = buildApprovalPageModel({
      approvalId: 'approval_test_jpy',
      request: request({
        approvalRequestId: 'approval_request_jpy',
        currency: 'JPY',
        amountMinor: 1500,
      }, false),
      status: 'requested',
      nonceHint: 'nonce printed in operator terminal',
      csrf: CSRF,
    });
    expect(yen.model.chosen.amount).toBe('1500');
    expect(yen.model.needsMcc).toBe(true);
    expect(yen.model.comparison).toEqual([]);
    expect(yen.model.demoMode).toBe(false);
    expect(yen.model.card).toBeUndefined();

    const dinar = buildApprovalPageModel({
      approvalId: 'approval_test_kwd',
      request: request({ currency: 'KWD', amountMinor: 1234 }),
      status: 'approved',
      nonceHint: 'nonce printed in operator terminal',
      csrf: CSRF,
      card: { cardId: 'card_test_kwd', maskedNumber: '****0000', status: 'ACTIVE' },
      events: purchaseEvents(),
    });
    expect(dinar.model.chosen.amount).toBe('1.234');
    expect(dinar.model.card).toEqual({ cardId: 'card_test_kwd', maskedNumber: '****0000', status: 'ACTIVE' });
  });

  it('无效审批请求抛出固定错误，不带出请求内容', () => {
    const approval = request({ offerId: '' });
    expect(() => buildApprovalPageModel({
      approvalId: 'approval_test_01',
      request: approval,
      status: 'requested',
      nonceHint: 'nonce printed in operator terminal',
      csrf: CSRF,
    })).toThrow('invalid_approval_request');
  });
});

describe('buildAuditPageModel', () => {
  it('为每种事件生成摘要和短哈希，并把卡片限额格式化', () => {
    const events = [
      ...purchaseEvents(),
      envelope(6, {
        kind: 'authorization',
        source: 'simulated',
        cardId: 'card_test_01',
        amount: '-2.50',
        currency: 'USD',
        merchantName: 'Test Merchant',
        mapped: 'approved',
      }),
      envelope(7, {
        kind: 'reconciliation',
        cardId: 'card_test_01',
        window: { from: AT, to: LATER },
        settledMinor: -250,
        pendingMinor: 2500,
        failedCount: 1,
        transactionIds: ['transaction_test_01'],
      }),
      envelope(8, {
        kind: 'card_issue_unconfirmed',
        approvalId: 'approval_test_02',
        requestId: 'spk_test_request_02',
        reason: 'response_shape_unconfirmed',
      }),
      envelope(9, {
        kind: 'approval_rejected',
        approvalRequestId: 'approval_request_test_02',
        code: 'human_rejected',
      }),
      envelope(10, {
        kind: 'card_frozen',
        cardId: 'card_test_01',
        by: 'agent',
        reason: 'demo_complete',
      }),
      envelope(11, {
        kind: 'webhook_received',
        eventId: 'event_test_01',
        name: 'issuing.card.updated',
        deduped: false,
      }),
      envelope(12, {
        kind: 'raw_response',
        ref: 'response_test_01',
        endpoint: '/api/v1/issuing/cards/create',
        status: 200,
        body: { ok: true },
      }),
    ];

    const page = buildAuditPageModel(events, { ok: true, error: 'hash_mismatch' });
    expect(page.chainValid).toBe(true);
    expect(page.verifyError).toBeUndefined();
    expect(page.events.map((row) => [row.kind, row.summary, row.hashShort, row.source])).toEqual([
      ['offers_snapshot', 'Offers for "monthly search tool": 2', hashShort(events[0]!.hash), undefined],
      ['comparison', 'Compared 2, excluded 1', hashShort(events[1]!.hash), undefined],
      ['decision', 'Decision ask, chosen offer_test_01', hashShort(events[2]!.hash), undefined],
      ['approval_requested', 'Requested 50.00 USD for offer_test_01', hashShort(events[3]!.hash), undefined],
      ['approval_granted', 'Granted approval_test_01 (demo auto-approval)', hashShort(events[4]!.hash), undefined],
      ['card_issued', 'Issued card_test_01 ACTIVE', hashShort(events[5]!.hash), undefined],
      ['authorization', '-2.50 USD at Test Merchant (approved)', hashShort(events[6]!.hash), 'simulated'],
      ['reconciliation', 'Settled -2.50 USD, pending 25.00 USD, 1 failed', hashShort(events[7]!.hash), undefined],
      ['card_issue_unconfirmed', 'Card issue unconfirmed: response_shape_unconfirmed', hashShort(events[8]!.hash), undefined],
      ['approval_rejected', 'Rejected approval_request_test_02: human_rejected', hashShort(events[9]!.hash), undefined],
      ['card_frozen', 'Frozen by agent: demo_complete', hashShort(events[10]!.hash), undefined],
      ['webhook_received', 'Webhook issuing.card.updated', hashShort(events[11]!.hash), undefined],
      ['raw_response', 'Response 200 /api/v1/issuing/cards/create', hashShort(events[12]!.hash), undefined],
    ]);
    expect(page.cards).toEqual([{ cardId: 'card_test_01', status: 'ACTIVE', limit: '50.00', currency: 'USD' }]);
    expect(page.events[0]?.hashShort).toBe('ccccccccccc0');

    const html = renderAuditPage(page);
    expect(html).toContain('class="unconfirmed"');
    expect(html).toContain('sandbox simulation');
    expect(html).not.toContain('hash_mismatch');
    expect(html).not.toContain('role="alert"');

    const broken = buildAuditPageModel(events, { ok: false, brokenAt: 2, error: 'hash_mismatch' });
    expect(broken.chainValid).toBe(false);
    expect(broken.verifyError).toBe('hash_mismatch');
    expect(renderAuditPage(broken)).toContain('Chain BROKEN');
  });

  it('对账找不到币种时保留最小单位，拒绝的决策没有 chosen', () => {
    const events = [
      envelope(0, { kind: 'decision', action: 'refuse', reasons: ['reserve_breach'], ruleResults: [] }),
      envelope(1, {
        kind: 'reconciliation',
        cardId: 'card_test_missing',
        window: { from: AT, to: LATER },
        settledMinor: 0,
        pendingMinor: 0,
        failedCount: 0,
        transactionIds: [],
      }),
      envelope(2, {
        kind: 'webhook_received',
        eventId: 'event_test_02',
        name: 'issuing.transaction.succeeded',
        deduped: true,
      }),
    ];
    const page = buildAuditPageModel(events, { ok: false });
    expect(page.verifyError).toBeUndefined();
    expect(page.events.map((row) => row.summary)).toEqual([
      'Decision refuse',
      'Settled 0 minor, pending 0 minor, 0 failed',
      'Webhook issuing.transaction.succeeded (duplicate)',
    ]);
    expect(page.cards).toEqual([]);
  });
});

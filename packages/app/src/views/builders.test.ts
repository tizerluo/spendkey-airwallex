// Offline model tests use plain ledger records without files or network access.

import type { CardAuditEvent } from '@sk/ledger';
import { termsHash, type ApprovalRequest } from '@sk/policy';
import { describe, expect, it } from 'vitest';
import { renderApprovalPage, renderAuditPage, renderIndexPage } from '../index.js';
import { buildApprovalPageModel, buildAuditPageModel, buildIndexPageModel, hashShort } from './builders.js';
import type { LedgerRecord } from './builders.js';
import type { ViewAuditEvent } from './run-mode.js';

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

function envelope(seq: number, event: ViewAuditEvent): LedgerRecord {
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
    expect(html).toContain('<p id="run-mode">mode unknown</p>');
    expect(html).toContain('<td>mode unknown</td>');
    expect(html.toLowerCase()).not.toContain('sandbox');
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

  it('按最近一条 run_started 标注模式，离线页不出现 sandbox', () => {
    const note = 'reserve floor 2,000.00 USD must remain after upfront charges';
    const events = [
      envelope(1, {
        kind: 'run_started',
        mode: 'offline_emulator',
        policyNotes: [note, 'shown <as text>'],
      }),
      envelope(2, {
        kind: 'authorization',
        source: 'simulated',
        cardId: 'card_test_01',
        amount: '10.00',
        currency: 'USD',
        mapped: 'approved',
      }),
      envelope(3, {
        kind: 'authorization',
        source: 'observed',
        cardId: 'card_test_01',
        amount: '61.00',
        currency: 'USD',
        mapped: 'limit_exceeded',
      }),
      envelope(5, {
        kind: 'controls_readback',
        cardId: 'card_test_01',
        matches: true,
        expected: { limits: [{ amount: 60 }] },
        actual: { marker: 'do-not-render-actual-marker' },
      }),
      envelope(6, {
        kind: 'controls_readback',
        cardId: 'card_test_01',
        matches: false,
        expected: { limits: [{ amount: 60 }] },
        actual: { marker: 'do-not-render-mismatch-marker' },
      }),
      envelope(7, {
        kind: 'card_frozen',
        cardId: 'card_test_01',
        by: 'system',
        reason: 'scheduled stop',
      }),
      envelope(8, {
        kind: 'card_frozen',
        cardId: 'card_test_01',
        by: 'human',
        reason: 'demo-operator: stop',
      }),
    ];
    const page = buildAuditPageModel(events, { ok: true });
    expect(page.runMode).toBe('offline_emulator');
    expect(page.policyNotes).toEqual([note, 'shown <as text>']);
    expect(page.events.map((row) => [row.kind, row.summary, row.warning])).toEqual([
      ['run_started', 'Run started: Offline emulator (no Airwallex calls)', undefined],
      ['authorization', '10.00 USD at unknown merchant (approved)', undefined],
      ['authorization', '61.00 USD at unknown merchant (limit_exceeded)', undefined],
      ['controls_readback', 'controls read back: match', undefined],
      ['controls_readback', 'controls read back: MISMATCH', true],
      ['card_frozen', 'Frozen by system (auto): scheduled stop', undefined],
      ['card_frozen', 'Frozen by human: demo-operator: stop', undefined],
    ]);
    const html = renderAuditPage(page);
    expect(html).toContain('<p id="run-mode">Offline emulator (no Airwallex calls)</p>');
    expect(html).toContain('shown &lt;as text&gt;');
    expect(html).not.toContain('shown <as text>');
    expect(html).not.toContain('do-not-render-actual-marker');
    expect(html).not.toContain('do-not-render-mismatch-marker');
    expect(html.match(/<td>emulated \(offline\)<\/td>/g)).toHaveLength(2);
    expect(html).toContain('<strong class="warning">controls read back: MISMATCH</strong>');
    expect(html).toContain('class="mismatch"');
    expect(html).toContain('controls read back: match');
    expect(rowAround(html, 'controls read back: match')).not.toContain('class="warning"');
    expect(html.toLowerCase()).not.toContain('sandbox');

    const index = buildIndexPageModel(
      [{ request: request(), status: 'requested' }],
      events,
    );
    expect(index.runMode).toBe('offline_emulator');
    const indexHtml = renderIndexPage(index);
    expect(indexHtml).toContain('<p id="run-mode">Offline emulator (no Airwallex calls)</p>');
    expect(indexHtml.toLowerCase()).not.toContain('sandbox');

    const approval = buildApprovalPageModel({
      approvalId: 'approval_test_01',
      request: request(),
      status: 'issued',
      nonceHint: 'nonce printed in operator terminal',
      csrf: CSRF,
      events,
    });
    expect(approval.model.runMode).toBe('offline_emulator');
    const approvalHtml = renderApprovalPage(approval.model, { csrfToken: approval.csrfToken });
    expect(approvalHtml).toContain('<p id="run-mode">Offline emulator (no Airwallex calls)</p>');
    expect(approvalHtml.toLowerCase()).not.toContain('sandbox');

    const laterSeqFirst = buildAuditPageModel([
      envelope(8, { kind: 'run_started', mode: 'offline_emulator', policyNotes: ['kept'] }),
      envelope(2, { kind: 'run_started', mode: 'sandbox', policyNotes: ['stale note'] }),
    ], { ok: true });
    expect(laterSeqFirst.runMode).toBe('offline_emulator');
    expect(laterSeqFirst.policyNotes).toEqual(['kept']);
    const tied = buildAuditPageModel([
      envelope(3, { kind: 'run_started', mode: 'sandbox', policyNotes: ['first'] }),
      envelope(3, { kind: 'run_started', mode: 'offline_emulator', policyNotes: ['second'] }),
    ], { ok: true });
    expect(tied.runMode).toBe('offline_emulator');
    expect(tied.policyNotes).toEqual(['second']);
  });

  it('sandbox 与 console_sandbox 使用沙箱标签，坏掉的最新 mode 变成 mode unknown', () => {
    const simulated = envelope(1, {
      kind: 'authorization',
      source: 'simulated',
      cardId: 'card_test_01',
      amount: '10.00',
      currency: 'USD',
      mapped: 'approved',
    });
    const observed = envelope(2, {
      kind: 'authorization',
      source: 'observed',
      cardId: 'card_test_01',
      amount: '1.00',
      currency: 'USD',
      merchantName: 'Synthetic DesignCo',
      mapped: 'merchant_category_not_allowed',
    });
    const sandbox = buildAuditPageModel([
      envelope(0, { kind: 'run_started', mode: 'sandbox', policyNotes: [] }),
      simulated,
      observed,
    ], { ok: true });
    expect(sandbox.runMode).toBe('sandbox');
    expect(sandbox.policyNotes).toBeUndefined();
    const sandboxHtml = renderAuditPage(sandbox);
    expect(sandboxHtml).toContain('<p id="run-mode">Airwallex sandbox</p>');
    expect(sandboxHtml).toContain('<td>sandbox simulation</td>');
    expect(sandboxHtml).toContain('<td>sandbox event (observed)</td>');

    const consoleSandbox = buildAuditPageModel([
      envelope(0, { kind: 'run_started', mode: 'console_sandbox', policyNotes: ['operator console'] }),
      simulated,
    ], { ok: true });
    expect(consoleSandbox.runMode).toBe('console_sandbox');
    expect(renderAuditPage(consoleSandbox)).toContain('<td>sandbox simulation</td>');
    expect(renderAuditPage(consoleSandbox)).toContain('operator console');

    const brokenMode = buildAuditPageModel([
      envelope(0, { kind: 'run_started', mode: 'offline_emulator', policyNotes: ['older'] }),
      envelope(3, { kind: 'run_started', mode: 'not-a-mode', policyNotes: [] } as unknown as ViewAuditEvent),
      simulated,
    ], { ok: true });
    expect(brokenMode.runMode).toBeUndefined();
    const brokenHtml = renderAuditPage(brokenMode);
    expect(brokenHtml).toContain('<p id="run-mode">mode unknown</p>');
    expect(brokenHtml).toContain('<td>mode unknown</td>');
    expect(brokenHtml).toContain('Run started: mode unknown');
    expect(brokenHtml.toLowerCase()).not.toContain('sandbox');

    const partial = buildAuditPageModel([
      envelope(0, { kind: 'controls_readback', cardId: 'card_test_01' } as unknown as ViewAuditEvent),
    ], { ok: true });
    expect(partial.events[0]?.summary).toBe('controls read back: MISMATCH');
    expect(partial.events[0]?.warning).toBe(true);
    expect(partial.runMode).toBeUndefined();
  });
});

/** Find the row containing text to check that only mismatches receive warning styling. */
function rowAround(html: string, needle: string): string {
  const at = html.indexOf(needle);
  const start = html.lastIndexOf('<tr', at);
  const end = html.indexOf('</tr>', at);
  return html.slice(start, end);
}

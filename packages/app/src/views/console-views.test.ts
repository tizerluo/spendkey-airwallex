// Offline view tests inspect HTML strings without network access.

import { describe, expect, it } from 'vitest';
import {
  CONSOLE_CSP,
  escapeHtml,
  renderApprovalPage,
  renderAuditPage,
  renderIndexPage,
} from '../index.js';
import type { ApprovalPageModel, AuditPageModel } from '../index.js';

const PAYLOAD = '<script>alert("x")</script>';
const ESCAPED = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;';
const NONCE_SECRET = 'nonce-secret-test-01';
const CSRF = 'csrf-test';

function sampleApproval(): ApprovalPageModel {
  return {
    approvalRequestId: 'approval_request_test_01',
    status: 'requested',
    intent: 'monthly search tool',
    chosen: {
      offerId: 'offer_test_01',
      vendor: 'Example Vendor',
      product: 'Example Product',
      plan: 'monthly',
      amount: '50.00',
      currency: 'USD',
      interval: 'MONTHLY',
      allowedTransactionCount: 'MULTIPLE',
      commitmentMonths: 12,
      priceStatus: 'price_unverified',
      rail: 'card',
    },
    presentedTermsHash: 'terms-hash-test-01',
    reasons: ['human_approval_required', 'price_unverified', 'mcc_required_at_approval'],
    comparison: [
      {
        offerId: 'offer_test_01',
        vendor: 'Example Vendor',
        plan: 'monthly',
        rail: 'card',
        upfront: '50.00',
        perCharge: '50.00',
        horizon: '600.00',
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
    ],
    excluded: [{ offerId: 'offer_region_01', reason: 'region_unavailable' }],
    expiresAt: '2030-01-01T01:00:00.000Z',
    needsMcc: true,
    nonceHint: 'nonce printed in operator terminal',
    demoMode: true,
  };
}

function sampleAudit(): AuditPageModel {
  return {
    chainValid: true,
    events: [
      {
        seq: 1,
        at: '2030-01-01T00:00:00.000Z',
        kind: 'offers_snapshot',
        summary: 'two offers',
        hashShort: 'aaaa1111',
      },
      {
        seq: 2,
        at: '2030-01-01T00:01:00.000Z',
        kind: 'authorization',
        summary: 'simulator charge',
        source: 'simulated',
        hashShort: 'bbbb2222',
      },
      {
        seq: 3,
        at: '2030-01-01T00:02:00.000Z',
        kind: 'authorization',
        summary: 'merchant example',
        source: 'observed',
        hashShort: 'cccc3333',
      },
    ],
    cards: [{ cardId: 'card_test_01', status: 'ACTIVE', limit: '50.00', currency: 'USD' }],
    runMode: 'sandbox',
  };
}

/** All pages must exclude scripts, inline handlers, and javascript: URLs. */
function expectNoActiveContent(html: string): void {
  expect(html.includes('<script')).toBe(false);
  expect(html).not.toMatch(/ on\w+=/);
  expect(html.toLowerCase().includes('javascript:')).toBe(false);
}

function formSlice(html: string, action: string): string {
  const marker = `action="${action}"`;
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const formStart = html.lastIndexOf('<form', start);
  const formEnd = html.indexOf('</form>', start);
  expect(formStart).toBeGreaterThanOrEqual(0);
  expect(formEnd).toBeGreaterThan(start);
  return html.slice(formStart, formEnd);
}

describe('escapeHtml', () => {
  it('escapes characters that break HTML in text and attributes, and does not double-escape', () => {
    expect(escapeHtml(PAYLOAD)).toBe(ESCAPED);
    expect(escapeHtml('a&b')).toBe('a&amp;b');
    expect(escapeHtml(`'`)).toBe('&#39;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml('<')).toBe('&lt;');
  });
});

describe('renderApprovalPage', () => {
  it('escapes intent, vendor, notes, and card display fields', () => {
    const model = sampleApproval();
    const [first, second] = model.comparison;
    if (first === undefined || second === undefined) throw new Error('missing comparison fixture');
    model.intent = PAYLOAD;
    model.chosen.vendor = PAYLOAD;
    model.comparison = [{ ...first, vendor: PAYLOAD, notes: [PAYLOAD], failedCodes: [PAYLOAD] }, second];
    model.card = { cardId: 'card_test_01', maskedNumber: PAYLOAD, status: 'ACTIVE' };

    const html = renderApprovalPage(model, { csrfToken: CSRF });

    expect(html).toContain(ESCAPED);
    expect(html).not.toContain(PAYLOAD);
    expect(html).not.toContain('alert("x")');
    expect(html).not.toContain('Copy hash');
    expect(html).not.toContain('data-copy-hash');
    expectNoActiveContent(html);
  });

  it('quotes and angle brackets in attribute values are escaped too', () => {
    const model = sampleApproval();
    model.presentedTermsHash = `abc&<>"'`;
    const html = renderApprovalPage(model, { csrfToken: `tok&"<` });
    const escapedHash = 'abc&amp;&lt;&gt;&quot;&#39;';
    expect(html.split(escapedHash).length - 1).toBeGreaterThanOrEqual(2);
    expect(html).toContain('value="tok&amp;&quot;&lt;"');
    expect(html).not.toContain(`value="abc&<>"'"`);
  });

  it('needsMcc controls whether the merchant category input appears', () => {
    const shown = sampleApproval();
    shown.reasons = ['human_approval_required'];
    const shownHtml = renderApprovalPage(shown, { csrfToken: CSRF });
    expect(shownHtml).toContain('name="merchantCategoryCode"');
    expect(shownHtml).toContain('<label for="merchant-category-code">Merchant category code</label>');
    expect(shownHtml).toContain('<input id="merchant-category-code" name="merchantCategoryCode" type="text" required inputmode="numeric" pattern="[0-9]{4}" minlength="4" maxlength="4" autocomplete="off" aria-describedby="mcc-hint">');

    const hidden = sampleApproval();
    hidden.needsMcc = false;
    hidden.chosen = { ...hidden.chosen, merchantCategoryCode: '0000' };
    const hiddenHtml = renderApprovalPage(hidden, { csrfToken: CSRF });
    expect(hiddenHtml).not.toContain('merchantCategoryCode');
    expect(hiddenHtml).toContain('0000');
    expect(hiddenHtml).toContain('Merchant category is required at approval');
  });

  it('escapes an existing merchant category without prefilling the input', () => {
    const model = sampleApproval();
    model.chosen = { ...model.chosen, merchantCategoryCode: '12"<4' };
    const html = renderApprovalPage(model, { csrfToken: CSRF });
    expect(html).toContain('12&quot;&lt;4');
    expect(html).not.toMatch(/name="merchantCategoryCode"[^>]*\bvalue=/);
    expect(html).not.toContain('12"<4');
  });

  it('shows only the nonce hint and never writes the nonce into the page', () => {
    const html = renderApprovalPage(sampleApproval(), { csrfToken: CSRF });
    expect(html).toContain('nonce printed in operator terminal');
    expect(html).toContain('<label for="approval-nonce">Approval nonce</label>');
    expect(html).toContain('<input id="approval-nonce" name="nonce" type="text" required autocomplete="off" spellcheck="false" aria-describedby="nonce-hint">');
    expect(html).not.toContain(NONCE_SECRET);
    expect(html).not.toMatch(/name="nonce"[^>]*\bvalue=/);
  });

  it('x402 rows say card payment is unavailable; region-unavailable offers get an exclusion note', () => {
    const html = renderApprovalPage(sampleApproval(), { csrfToken: CSRF });
    expect(html).toContain('not payable by card (x402)');
    expect(html).toContain('class="x402"');
    expect(html).toContain('Not payable by card');
    expect(html).toContain('region_unavailable');
    expect(html).toContain('Unavailable in the billing or card region, so this offer was excluded from comparison.');
    expect(html).toContain('offer_region_01');
  });

  it('key copy, terms, and both POST forms are present', () => {
    const model = sampleApproval();
    model.card = { cardId: 'card_test_01', maskedNumber: '****0000', status: 'ACTIVE' };
    const html = renderApprovalPage(model, { csrfToken: CSRF });

    for (const text of [
      'Approve exact terms',
      'Intent: monthly search tool',
      'Example Vendor',
      'Example Product',
      '50.00',
      'USD',
      'Monthly (MONTHLY)',
      'Multiple charges (MULTIPLE)',
      '12 months',
      'price_unverified',
      'Price not verified \u2014 no savings claim',
      'Human approval required',
      'Merchant category is required at approval',
      'what this binds',
      'terms-hash-test-01',
      'Approve exactly these terms',
      'Reject',
      'Demo: auto-approval by demo-operator is labelled in the audit log',
      'fits the monthly budget',
      'Passed',
      'Not payable by card',
      '<dt>Rail</dt><dd>card</dd>',
      'card_test_01',
      '****0000',
      'Required at approval',
      '<th scope="col">Per charge</th>',
      '<th scope="col">Horizon</th>',
      '<caption>Offer comparison</caption>',
      '<caption>Excluded offers</caption>',
    ]) {
      expect(html).toContain(text);
    }

    expect(html).toContain('<button type="submit" class="approve" aria-describedby="request-status">Approve exactly these terms</button>');
    expect(html).toContain('<button type="submit" class="reject" aria-describedby="request-status">Reject</button>');
    expect(html).toContain('<fieldset>');
    expect(html).not.toContain('<fieldset disabled>');
    expect(html).not.toContain('title=');
    expect(html).toContain('Card numbers on these pages are masked.');
    expectNoActiveContent(html);

    const approve = formSlice(html, '/approvals/approval_request_test_01/approve');
    expect(approve).toContain('method="post"');
    expect(approve).toContain('name="nonce"');
    expect(approve).toContain('name="merchantCategoryCode"');
    expect(approve).toContain('name="presentedTermsHash"');
    expect(approve).toContain('name="csrf"');
    expect(approve).toContain('value="terms-hash-test-01"');
    expect(approve).toContain('value="csrf-test"');

    const reject = formSlice(html, '/approvals/approval_request_test_01/reject');
    expect(reject).toContain('method="post"');
    expect(reject).toContain('name="csrf"');
    expect(reject).toContain('value="csrf-test"');
    expect(reject).not.toContain('name="nonce"');
    expect(reject).not.toContain('name="presentedTermsHash"');
    expect(reject).not.toContain('name="merchantCategoryCode"');
  });

  it('no demo banner when demo mode is off', () => {
    const model = sampleApproval();
    model.demoMode = false;
    expect(renderApprovalPage(model, { csrfToken: CSRF })).not.toContain(
      'Demo: auto-approval by demo-operator is labelled in the audit log',
    );
  });

  it('a non-requested status disables the whole fieldset', () => {
    const model = sampleApproval();
    model.status = 'expired';
    const html = renderApprovalPage(model, { csrfToken: CSRF });
    expect(html).toContain('Expired (expired)');
    expect(html.match(/<fieldset disabled>/g)).toHaveLength(2);
    expect(html).not.toMatch(/<fieldset>/);
    const approve = formSlice(html, '/approvals/approval_request_test_01/approve');
    expect(approve).toContain('<fieldset disabled>');
    expect(approve).toContain('name="nonce"');
    expect(approve).toContain('name="merchantCategoryCode"');
    expectNoActiveContent(html);
  });

  it('even when rules pass, an x402 row result column is Not payable by card', () => {
    const model = sampleApproval();
    const row = model.comparison[1];
    if (row === undefined) throw new Error('missing x402 row');
    model.comparison[1] = { ...row, passed: true, failedCodes: [] };
    const html = renderApprovalPage(model, { csrfToken: CSRF });
    const start = html.indexOf('offer_x402_01');
    const rowHtml = html.slice(start, html.indexOf('</tr>', start));
    expect(rowHtml).toContain('Not payable by card');
    expect(rowHtml).not.toContain('Passed');
    expectNoActiveContent(html);
  });

  it('no approval form is rendered when the chosen rail is not card', () => {
    const model = sampleApproval();
    model.chosen = { ...model.chosen, rail: 'x402' };
    const html = renderApprovalPage(model, { csrfToken: CSRF });
    expect(html).toContain('<dt>Rail</dt><dd>x402 (not payable by card)</dd>');
    expect(html).toContain('This rail is not payable by card, so the page has no approval form.');
    expect(html).not.toContain('/approve');
    expect(html).not.toContain('name="nonce"');
    expect(html).toContain('action="/approvals/approval_request_test_01/reject"');
    expectNoActiveContent(html);
  });

  it('the result column names the failure code when the card rail fails', () => {
    const model = sampleApproval();
    const row = model.comparison[0];
    if (row === undefined) throw new Error('missing card row');
    model.comparison = [{ ...row, passed: false, failedCodes: ['reserve_breach'] }];
    const html = renderApprovalPage(model, { csrfToken: CSRF });
    expect(html).toContain('Failed: reserve_breach');
  });

  it('approval ids are segment-encoded in paths while page text stays escaped', () => {
    const model = sampleApproval();
    model.approvalRequestId = 'req <1>';
    const html = renderApprovalPage(model, { csrfToken: CSRF });
    expect(html).toContain('action="/approvals/req%20%3C1%3E/approve"');
    expect(html).toContain('action="/approvals/req%20%3C1%3E/reject"');
    expect(html).toContain('req &lt;1&gt;');
    expect(html).not.toContain('req <1>');
  });
});

describe('renderAuditPage', () => {
  it('shows the badge when the chain is broken and escapes the summary and verify error', () => {
    const model = sampleAudit();
    model.chainValid = false;
    model.verifyError = PAYLOAD;
    const broken = model.events[1];
    if (broken === undefined) throw new Error('missing audit fixture');
    model.events[1] = { ...broken, summary: PAYLOAD };

    const html = renderAuditPage(model);
    expect(html).toContain('Chain BROKEN');
    expect(html).not.toContain('Chain valid');
    expect(html).toContain(ESCAPED);
    expect(html).not.toContain(PAYLOAD);
    expect(html.includes('<script')).toBe(false);
    expect(html).toContain('role="alert"');
    expectNoActiveContent(html);
  });

  it('ignores verifyError when the chain is valid', () => {
    const model = sampleAudit();
    model.verifyError = PAYLOAD;
    const html = renderAuditPage(model);
    expect(html).toContain('Chain valid');
    expect(html).not.toContain(ESCAPED);
    expect(html).not.toContain(PAYLOAD);
    expect(html).not.toContain('role="alert"');
  });

  it('an authorization without a source shows source missing; unconfirmed issuance uses warning styling', () => {
    const model = sampleAudit();
    const simulated = model.events[1];
    if (simulated === undefined) throw new Error('missing authorization');
    model.events[1] = {
      seq: simulated.seq,
      at: simulated.at,
      kind: simulated.kind,
      summary: simulated.summary,
      hashShort: simulated.hashShort,
    };
    model.events.push({
      seq: 4,
      at: '2030-01-01T00:03:00.000Z',
      kind: 'card_issue_unconfirmed',
      summary: 'Card issue unconfirmed: response_shape_unconfirmed',
      hashShort: 'dddd4444',
    });
    const html = renderAuditPage(model);
    expect(html).toContain('<td>source missing</td>');
    expect(html).toContain('<td>\u2014</td>');
    expect(html).toContain('sandbox event (observed)');
    expect(html).toContain('class="unconfirmed"');
    expect(html).toContain('<strong class="warning">Unconfirmed</strong>');
    expect(html).toContain('response_shape_unconfirmed');
    expectNoActiveContent(html);
  });

  it('shows Chain valid when the chain is complete and distinguishes simulated from observed', () => {
    const html = renderAuditPage(sampleAudit());
    expect(html).toContain('Chain valid');
    expect(html).not.toContain('Chain BROKEN');
    expect(html).toContain('sandbox simulation');
    expect(html).toContain('sandbox event (observed)');
    expect(html).toContain('<td>sandbox simulation</td>');
    expect(html).toContain('<td>sandbox event (observed)</td>');
    expect(html).toContain('card_test_01');
    expect(html).toContain('ACTIVE');
    expect(html).toContain('50.00');
    expect(html).toContain('USD');
    expect(html).toContain('bbbb2222');
    expect(html).toContain('<th scope="col">Source</th>');
    expect(html).toContain('<caption>Ledger events</caption>');
    expect(html).toContain('<caption>Cards</caption>');
    expect(html).not.toContain('role="alert"');
    expectNoActiveContent(html);
  });

  it('offline mode labels authorizations emulated and the page contains no sandbox', () => {
    const model = sampleAudit();
    model.runMode = 'offline_emulator';
    model.events.push({
      seq: 4,
      at: '2030-01-01T00:03:00.000Z',
      kind: 'controls_readback',
      summary: 'controls read back: MISMATCH',
      hashShort: 'dddd4444',
      warning: true,
    });
    model.events.push({
      seq: 5,
      at: '2030-01-01T00:04:00.000Z',
      kind: 'card_frozen',
      summary: 'Frozen by system (auto): scheduled stop',
      hashShort: 'eeee5555',
    });
    const html = renderAuditPage(model);
    expect(html).toContain('<p id="run-mode">Offline emulator (no Airwallex calls)</p>');
    expect(html.match(/<td>emulated \(offline\)<\/td>/g)).toHaveLength(2);
    expect(html).toContain('class="mismatch"');
    expect(html).toContain('<strong class="warning">controls read back: MISMATCH</strong>');
    expect(html).toContain('Frozen by system (auto): scheduled stop');
    expect(html.toLowerCase()).not.toContain('sandbox');
    expectNoActiveContent(html);
  });

  it('authorization columns say mode unknown when there is no runMode', () => {
    const model = sampleAudit();
    delete model.runMode;
    const html = renderAuditPage(model);
    expect(html).toContain('<p id="run-mode">mode unknown</p>');
    expect(html).toContain('<td>mode unknown</td>');
    expect(html).not.toContain('sandbox simulation');
    expect(html).not.toContain('sandbox event (observed)');
    expect(html.toLowerCase()).not.toContain('sandbox');
  });

  it('shows empty states when there are no events or cards', () => {
    const model = sampleAudit();
    model.events = [];
    model.cards = [];
    const html = renderAuditPage(model);
    expect(html).toContain('No ledger events.');
    expect(html).toContain('No cards.');
    expect(html).toContain('Chain valid');
  });
});

describe('referrer policy', () => {
  it('renders a same-origin referrer meta tag on every document', () => {
    const pages = [
      renderIndexPage({ approvals: [] }),
      renderApprovalPage(sampleApproval(), { csrfToken: CSRF }),
      renderAuditPage(sampleAudit()),
    ];
    for (const html of pages) {
      expect(html).toContain('<meta name="referrer" content="same-origin">');
      expect(html).not.toContain('no-referrer');
    }
  });
});

describe('CONSOLE_CSP', () => {
  it('exports a policy that allows inline styles and no scripts', () => {
    expect(CONSOLE_CSP).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(CONSOLE_CSP).not.toContain('unsafe-eval');
    expect(CONSOLE_CSP).not.toMatch(/script-src[^;]*unsafe-inline/);
  });
});

describe('renderIndexPage', () => {
  it('escapes the vendor and links to approval pages in order', () => {
    const html = renderIndexPage({
      approvals: [
        { id: 'approval_request_test_01', status: 'requested', vendor: PAYLOAD, amount: '50.00', currency: 'USD' },
        { id: 'a/b', status: 'expired', vendor: 'Other Vendor', amount: '1.00', currency: 'EUR' },
      ],
    });
    expect(html).toContain(ESCAPED);
    expect(html).not.toContain(PAYLOAD);
    expectNoActiveContent(html);
    expect(html).toContain('href="/approvals/approval_request_test_01"');
    expect(html).toContain('href="/approvals/a%2Fb"');
    expect(html).toContain('>a/b</a>');
    expect(html).toContain('50.00');
    expect(html).toContain('USD');
    expect(html).toContain('requested');
    expect(html).toContain('<th scope="col">Vendor</th>');
    expect(html).toContain('<caption>Approval requests</caption>');
    expect(html.indexOf('approval_request_test_01')).toBeLessThan(html.indexOf('>a/b</a>'));
  });

  it('escapes hashShort, status, id, reason, and cardId', () => {
    const approval = sampleApproval();
    approval.reasons = [PAYLOAD];
    approval.excluded = [{ offerId: 'offer_region_01', reason: PAYLOAD }];
    approval.card = { cardId: PAYLOAD, maskedNumber: '****0000', status: PAYLOAD };
    const approvalHtml = renderApprovalPage(approval, { csrfToken: CSRF });
    expect(approvalHtml).toContain(ESCAPED);
    expect(approvalHtml).not.toContain(PAYLOAD);

    const audit = sampleAudit();
    const first = audit.events[0];
    if (first === undefined) throw new Error('missing audit row');
    audit.events[0] = { ...first, hashShort: PAYLOAD };
    audit.cards = [{ cardId: PAYLOAD, status: PAYLOAD, limit: '1.00', currency: 'USD' }];
    const auditHtml = renderAuditPage(audit);
    expect(auditHtml).toContain(ESCAPED);
    expect(auditHtml).not.toContain(PAYLOAD);

    const indexHtml = renderIndexPage({
      approvals: [{ id: PAYLOAD, status: PAYLOAD, vendor: 'Example Vendor', amount: '1.00', currency: 'USD' }],
    });
    expect(indexHtml).toContain(ESCAPED);
    expect(indexHtml).not.toContain(PAYLOAD);
    expect(indexHtml).toContain('href="/approvals/%3Cscript%3Ealert(%22x%22)%3C%2Fscript%3E"');
    expectNoActiveContent(indexHtml);
  });

  it('shows an empty state when there are no approval requests', () => {
    const html = renderIndexPage({ approvals: [] });
    expect(html).toContain('No approval requests.');
    expect(html).toContain('<h1>Approvals</h1>');
    expect(html).toContain('<p id="run-mode">mode unknown</p>');
    expect(html.toLowerCase()).not.toContain('sandbox');
    expect(html).not.toContain('<table');
  });

  it('the list and approval pages use the supplied mode and omit sandbox when offline', () => {
    const indexHtml = renderIndexPage({
      runMode: 'offline_emulator',
      approvals: [{ id: 'approval_request_test_01', status: 'requested', vendor: 'Example Vendor', amount: '50.00', currency: 'USD' }],
    });
    expect(indexHtml).toContain('<p id="run-mode">Offline emulator (no Airwallex calls)</p>');
    expect(indexHtml.toLowerCase()).not.toContain('sandbox');

    const consoleHtml = renderIndexPage({
      runMode: 'console_sandbox',
      approvals: [],
    });
    expect(consoleHtml).toContain('<p id="run-mode">Airwallex sandbox</p>');

    const approval = sampleApproval();
    approval.runMode = 'offline_emulator';
    const approvalHtml = renderApprovalPage(approval, { csrfToken: CSRF });
    expect(approvalHtml).toContain('<p id="run-mode">Offline emulator (no Airwallex calls)</p>');
    expect(approvalHtml.toLowerCase()).not.toContain('sandbox');
    expectNoActiveContent(approvalHtml);
  });
});

it('marks the active console navigation and keeps images blocked by default', () => {
  const index = renderIndexPage({ approvals: [] });
  const approval = renderApprovalPage(sampleApproval(), { csrfToken: CSRF });
  const audit = renderAuditPage(sampleAudit());
  for (const html of [index, approval]) {
    expect(html).toContain('<a href="/" aria-current="page">Approvals</a>');
    expect(html).not.toContain('<a href="/audit" aria-current="page">');
  }
  expect(audit).toContain('<a href="/audit" aria-current="page">Audit</a>');
  expect(audit).not.toContain('<a href="/" aria-current="page">');
  expect(CONSOLE_CSP).not.toContain('img-src');
});

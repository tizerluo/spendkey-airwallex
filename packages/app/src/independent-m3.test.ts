import { createHash, createHmac } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AirwallexClient, loadAirwallexConfig } from '@sk/airwallex';
import type { CreateCardInput } from '@sk/airwallex';
import { InMemoryLedgerStore, verifyChain } from '@sk/ledger';
import type { CardAuditEvent, LedgerEvent } from '@sk/ledger';
import { termsHash, type ApprovalRequest } from '@sk/policy';
import {
  ApprovalService,
  CONSOLE_CSP,
  MemoryApprovalStore,
  buildApprovalPageModel,
  createConsoleServer,
  renderApprovalPage,
} from './index.js';
import { runDemo } from './demo/run.js';

const instant = '2026-11-11T10:00:00.000Z';
const SANDBOX = 'https://api-demo.airwallex.com';

interface FakeAuthorizationControls {
  allowed_transaction_count: string;
  allowed_currencies: string[];
  allowed_merchant_categories: string[];
  transaction_limits: { currency: string; limits: { amount: unknown; interval: string }[] };
}
interface FakeCard {
  card_id: string;
  card_status: string;
  card_number: string;
  request_id: string;
  nick_name: string;
  authorization_controls: FakeAuthorizationControls;
}

function createTransport() {
  const cards = new Map<string, FakeCard>();
  const transactions: Record<string, unknown>[] = [];
  let createCalls = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== SANDBOX) throw new Error('test_origin_mismatch');
    const path = url.pathname;
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>;
    if (path === '/api/v1/authentication/login') return json({ token: 'test-session', expires_at: '2099-01-01T00:00:00.000Z' });
    if (path === '/api/v1/issuing/cards/create') {
      createCalls += 1;
      const input = body as unknown as CreateCardInput;
      const existing = [...cards.values()].find(card => card.request_id === input.request_id);
      if (existing) return json(existing);
      const card: FakeCard = {
        card_id: `card_test_${cards.size + 1}`, card_status: 'ACTIVE', card_number: '****0001',
        request_id: input.request_id, nick_name: input.nick_name,
        authorization_controls: body['authorization_controls'] as FakeAuthorizationControls,
      };
      cards.set(card.card_id, card);
      return json(card);
    }
    if (path === '/api/v1/issuing/cards') return json({ items: [...cards.values()], has_more: false });
    const cardRoute = /^\/api\/v1\/issuing\/cards\/([a-zA-Z0-9_-]+)(\/update)?$/.exec(path);
    if (cardRoute) {
      const card = cards.get(cardRoute[1]!);
      if (!card) return json({ code: 'NOT_FOUND' }, 404);
      if (cardRoute[2]) card.card_status = String(body['card_status']);
      return json(card);
    }
    if (path === '/api/v1/simulation/issuing/create') {
      const card = cards.get(String(body['card_id']));
      if (!card) return json({ code: 'NOT_FOUND' }, 404);
      const controls = card.authorization_controls;
      const amount = String(body['transaction_amount']);
      const currency = String(body['transaction_currency']);
      const mcc = String(body['merchant_category_code']);
      const minor = (value: unknown) => Math.round(Number(value) * 100);
      let failure: string | undefined;
      if (card.card_status !== 'ACTIVE') failure = 'CARD_INACTIVE';
      else if (!controls.allowed_currencies.includes(currency)) failure = 'CURRENCY_NOT_ALLOWED';
      else if (!controls.allowed_merchant_categories.includes(mcc)) failure = 'MERCHANT_CATEGORY_NOT_ALLOWED';
      else {
        const approved = transactions.filter(transaction => transaction['card_id'] === card.card_id
          && transaction['status'] !== 'FAILED');
        if (controls.allowed_transaction_count === 'SINGLE' && approved.length > 0) failure = 'LIMIT_EXCEEDED';
        const limit = controls.transaction_limits.limits[0]!;
        const used = approved.reduce((sum, transaction) => sum + minor(transaction['transaction_amount']), 0);
        const total = minor(amount) + (limit.interval === 'PER_TRANSACTION' ? 0 : used);
        if (total > minor(limit.amount)) failure = 'LIMIT_EXCEEDED';
      }
      const transactionId = `transaction_test_${transactions.length + 1}`;
      transactions.push({
        transaction_id: transactionId, card_id: card.card_id, transaction_amount: amount, signedAmount: amount,
        transaction_currency: currency, transaction_date: instant, status: failure ? 'FAILED' : 'SUCCEEDED',
        ...(failure === undefined ? {} : { failure_reason: failure }),
        merchant: { name: 'Synthetic Shop', category_code: mcc, extra: {} }, extra: {},
      });
      return json({ process_result: failure ? 'DECLINED' : 'APPROVED', failure_reason: failure ?? null,
        card_transaction_id: transactionId });
    }
    if (path === '/api/v1/issuing/transactions') {
      const cardId = url.searchParams.get('card_id');
      return json({ items: transactions.filter(transaction => cardId === null || transaction['card_id'] === cardId),
        has_more: false });
    }
    throw new Error(`test_route_not_implemented:${path}`);
  };
  return { fetch, cards, transactions, get createCalls() { return createCalls; } };
}

function approvalRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalRequestId: 'request_test_01', offerId: 'offer_test_monthly', vendor: 'DesignCo', product: 'Team plan',
    plan: 'monthly', rail: 'card', currency: 'USD', amountMinor: 6000, interval: 'MONTHLY',
    allowedTransactionCount: 'MULTIPLE', merchantCategoryCode: '7372', commitmentMonths: 0,
    priceStatus: 'price_unverified', createdAt: instant, expiresAt: '2026-11-11T10:15:00.000Z',
    ...overrides,
  };
}

async function fixture() {
  const transport = createTransport();
  let time = new Date(instant);
  const now = () => time;
  const client = new AirwallexClient(
    loadAirwallexConfig({ AIRWALLEX_CLIENT_ID: 'test-client-id', AIRWALLEX_API_KEY: 'test-api-key' }),
    { fetch: transport.fetch, now: () => time.getTime() },
  );
  const ledger = new InMemoryLedgerStore();
  const store = new MemoryApprovalStore();
  const nonceLines: string[] = [];
  const operatorLines: string[] = [];
  const service = new ApprovalService({ client, ledger, store, now, cardholderId: 'cardholder_test_01',
    printNonce: line => nonceLines.push(line), printOperatorToken: line => operatorLines.push(line) });
  const operatorToken = operatorLines[0]!.split(': ')[1]!;
  const request = approvalRequest();
  await service.submit(request);
  const nonce = nonceLines[0]!.split(': ')[1]!;
  const csrf = service.get(request.approvalRequestId).csrf;
  const fields = { nonce, csrf, presentedTermsHash: termsHash(request) };
  return {
    transport, client, ledger, store, service, request, nonce, csrf, fields, operatorToken,
    setTime(value: string) { time = new Date(value); },
    grant: () => service.grant(request.approvalRequestId, fields),
  };
}

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  vi.restoreAllMocks();
});

type Send = (path: string, body?: unknown, headers?: Record<string, string>, raw?: string) =>
  Promise<{ status: number; text: string; headers: IncomingHttpHeaders }>;

async function start(service: ApprovalService, webhookSecret?: string): Promise<Send> {
  const server = createConsoleServer(service, webhookSecret ? { webhookSecret } : {});
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test_listen_failed');
  return async (path, body, headers = {}, raw) => {
    const data = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const requestHeaders = {
        ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) }),
        ...headers,
      };
      const request = httpRequest({ hostname: '127.0.0.1', port: address.port, path,
        method: data === undefined ? 'GET' : 'POST', headers: requestHeaders }, response => {
        const parts: Buffer[] = [];
        response.on('data', (chunk: Buffer) => parts.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode!, text: Buffer.concat(parts).toString(),
          headers: response.headers }));
      });
      request.on('error', reject);
      request.end(data);
    });
  };
}

describe('independent approval boundary', () => {
  it('refuses an x402 offer at the service and HTTP boundary and renders no approve form', async () => {
    const f = await fixture();
    await expect(f.service.submit({ ...f.request, approvalRequestId: 'request_x402_service', rail: 'x402' }))
      .rejects.toMatchObject({ code: 'invalid_approval_request', status: 400 });
    const send = await start(f.service);
    const response = await send('/approvals', { ...f.request, approvalRequestId: 'request_x402_http', rail: 'x402' });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.text)).toEqual({ error: 'invalid_approval_request' });

    const built = buildApprovalPageModel({ approvalId: '', request: { ...f.request, rail: 'x402' },
      status: 'requested', nonceHint: 'nonce printed in operator terminal', csrf: f.csrf });
    const html = renderApprovalPage(built.model, { csrfToken: built.csrfToken });
    expect(html).not.toContain(`/approvals/${f.request.approvalRequestId}/approve`);
    expect(html).toContain('x402 (not payable by card)');
    expect(html).toContain('This rail is not payable by card, so the page has no approval form.');
  });

  it('refuses an expired approval before any card creation', async () => {
    const f = await fixture();
    f.setTime(f.request.expiresAt);
    await expect(f.grant()).rejects.toMatchObject({ code: 'approval_expired', status: 409 });
    expect(f.transport.createCalls).toBe(0);
    expect(f.service.get(f.request.approvalRequestId).status).toBe('expired');
    const send = await start(f.service);
    const response = await send(`/approvals/${f.request.approvalRequestId}/approve`, f.fields);
    expect(response.status).toBe(409);
    expect(f.transport.createCalls).toBe(0);
  });

  it('refuses a reused approval and creates the card exactly once', async () => {
    const f = await fixture();
    const create = vi.spyOn(f.client, 'createCard');
    await f.grant();
    await expect(f.grant()).rejects.toMatchObject({ code: 'approval_issued', status: 409 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(f.transport.createCalls).toBe(1);
    expect(f.ledger.read().filter(record => record.event.kind === 'card_issued')).toHaveLength(1);
    expect(verifyChain(f.ledger.read()).ok).toBe(true);
  });

  it.each(['', 'wrong-test-nonce'])('refuses a missing or wrong nonce (%s)', async nonce => {
    const f = await fixture();
    const send = await start(f.service);
    const response = await send(`/approvals/${f.request.approvalRequestId}/approve`, { ...f.fields, nonce });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.text)).toEqual({ error: 'nonce_required' });
    expect(f.transport.createCalls).toBe(0);
    expect(f.service.get(f.request.approvalRequestId).status).toBe('requested');
  });

  it('never exposes the nonce or its digest in any response, header or ledger line', async () => {
    const f = await fixture();
    const nonceHash = f.store.get(f.request.approvalRequestId)!.nonceHash;
    expect(nonceHash).toMatch(/^[0-9a-f]{64}$/);
    const send = await start(f.service);
    const responses = [
      await send('/'),
      await send(`/approvals/${f.request.approvalRequestId}`),
      await send('/audit'),
      await send('/audit.jsonl'),
      await send(`/approvals/${f.request.approvalRequestId}/approve`, { ...f.fields, nonce: 'wrong-test-nonce' }),
    ];
    expect((await send(`/approvals/${f.request.approvalRequestId}/approve`, f.fields)).status).toBe(303);
    responses.push(
      await send('/'),
      await send(`/approvals/${f.request.approvalRequestId}`),
      await send('/audit'),
      await send('/audit.jsonl'),
    );
    const transcript = responses.map(response => JSON.stringify(response)).join('\n');
    expect(transcript).not.toContain(f.nonce);
    expect(transcript).not.toContain(nonceHash);
    const ledgerLines = f.ledger.read().map(record => JSON.stringify(record)).join('\n');
    expect(ledgerLines).not.toContain(f.nonce);
    expect(ledgerLines).not.toContain(nonceHash);
  });

  it('requires CSRF for approve, reject and every operator route', async () => {
    const f = await fixture();
    const send = await start(f.service);
    for (const action of ['approve', 'reject']) {
      const response = await send(`/approvals/${f.request.approvalRequestId}/${action}`,
        { nonce: f.nonce, presentedTermsHash: f.fields.presentedTermsHash });
      expect(response.status).toBe(403);
      expect(JSON.parse(response.text)).toEqual({ error: 'csrf_required' });
    }
    await f.grant();
    for (const path of ['/cards/card_test_1/simulate', '/cards/card_test_1/freeze', '/reconcile']) {
      const response = await send(path, { cardId: 'card_test_1', amount: '1.00', currency: 'USD', mcc: '7372' },
        { 'X-Operator-Token': f.operatorToken });
      expect(response.status).toBe(403);
      expect(JSON.parse(response.text)).toEqual({ error: 'csrf_required' });
    }
  });

  it('refuses a mismatched presented terms hash without consuming the approval', async () => {
    const f = await fixture();
    const send = await start(f.service);
    const mismatch = await send(`/approvals/${f.request.approvalRequestId}/approve`,
      { ...f.fields, presentedTermsHash: '0'.repeat(64) });
    expect(mismatch.status).toBe(409);
    expect(JSON.parse(mismatch.text)).toEqual({ error: 'terms_mismatch' });
    expect(f.transport.createCalls).toBe(0);
    expect(f.service.get(f.request.approvalRequestId).status).toBe('requested');
    expect((await send(`/approvals/${f.request.approvalRequestId}/approve`, f.fields)).status).toBe(303);
    expect((await send(`/approvals/${f.request.approvalRequestId}/approve`, f.fields)).status).toBe(409);
    expect(f.transport.createCalls).toBe(1);
  });
});

describe('independent authorization mapping', () => {
  async function issued() {
    const f = await fixture();
    await f.grant();
    const send = await start(f.service);
    const headers = { 'X-Operator-Token': f.operatorToken };
    const simulate = (amount: string, mcc = '7372') =>
      send('/cards/card_test_1/simulate', { csrf: f.csrf, amount, currency: 'USD', mcc }, headers);
    return { f, send, headers, simulate };
  }

  function lastAuthorization(events: readonly LedgerEvent[]): CardAuditEvent | undefined {
    return events.map(record => record.event).filter(event => event.kind === 'authorization').at(-1);
  }

  it('records an over-limit simulation as LIMIT_EXCEEDED', async () => {
    const { f, simulate } = await issued();
    expect(JSON.parse((await simulate('40.00')).text)).toEqual({ mapped: 'approved' });
    expect(JSON.parse((await simulate('25.00')).text)).toEqual({ mapped: 'limit_exceeded' });
    expect(lastAuthorization(f.ledger.read())).toMatchObject({
      kind: 'authorization', source: 'simulated', cardId: 'card_test_1', amount: '25.00', currency: 'USD',
      merchantCategoryCode: '7372', processResult: 'DECLINED', failureReason: 'LIMIT_EXCEEDED', mapped: 'limit_exceeded',
    });
    expect(verifyChain(f.ledger.read()).ok).toBe(true);
  });

  it('records a wrong MCC as MERCHANT_CATEGORY_NOT_ALLOWED', async () => {
    const { f, simulate } = await issued();
    expect(JSON.parse((await simulate('1.00', '5812')).text)).toEqual({ mapped: 'merchant_category_not_allowed' });
    expect(lastAuthorization(f.ledger.read())).toMatchObject({
      kind: 'authorization', mapped: 'merchant_category_not_allowed', failureReason: 'MERCHANT_CATEGORY_NOT_ALLOWED',
      merchantCategoryCode: '5812',
    });
  });

  it('records a frozen card as CARD_INACTIVE and shows INACTIVE on the audit page', async () => {
    const { f, send, headers, simulate } = await issued();
    const freeze = await send('/cards/card_test_1/freeze', { csrf: f.csrf }, headers);
    expect(freeze.status).toBe(200);
    expect(JSON.parse((await simulate('1.00')).text)).toEqual({ mapped: 'card_inactive' });
    expect(f.ledger.read().find(record => record.event.kind === 'card_frozen')?.event).toMatchObject({
      kind: 'card_frozen', cardId: 'card_test_1', by: 'human', reason: 'console freeze',
    });
    expect(f.store.get(f.request.approvalRequestId)?.card?.status).toBe('INACTIVE');
    expect(lastAuthorization(f.ledger.read())).toMatchObject({ mapped: 'card_inactive', failureReason: 'CARD_INACTIVE' });
    expect((await send('/audit')).text).toContain('INACTIVE');
  });
});

describe('independent webhooks and console headers', () => {
  it('records a duplicate webhook once and refuses a bad signature', async () => {
    const f = await fixture();
    await f.grant();
    const secret = 'test-webhook-key';
    const send = await start(f.service, secret);
    const timestamp = String(Date.parse(instant));
    const raw = JSON.stringify({ id: 'event_test_01', name: 'issuing.transaction.succeeded', created_at: instant,
      data: { transaction_id: 'transaction_test_webhook', card_id: 'card_test_1', transaction_amount: '10.00',
        transaction_currency: 'USD', status: 'SUCCEEDED' } });
    const headers = { 'x-timestamp': timestamp,
      'x-signature': createHmac('sha256', secret).update(timestamp).update(raw).digest('hex') };
    expect((await send('/webhooks/airwallex', {}, headers, raw)).status).toBe(200);
    expect((await send('/webhooks/airwallex', {}, headers, raw)).status).toBe(200);
    const receipts = f.ledger.read().map(record => record.event)
      .filter((event): event is Extract<CardAuditEvent, { kind: 'webhook_received' }> =>
        event.kind === 'webhook_received');
    expect(receipts.map(receipt => receipt.deduped)).toEqual([false, true]);
    expect(f.ledger.read().filter(record => record.event.kind === 'authorization'
      && record.event.source === 'observed')).toHaveLength(1);
    const before = f.ledger.read().length;
    expect((await send('/webhooks/airwallex', {}, { ...headers, 'x-signature': 'bad' }, raw)).status).toBe(401);
    expect(f.ledger.read()).toHaveLength(before);
    expect(verifyChain(f.ledger.read()).ok).toBe(true);
  });

  it('sets the CSP on HTML responses and never exposes the operator token', async () => {
    const f = await fixture();
    await f.grant();
    const send = await start(f.service);
    const pages = [await send('/'), await send(`/approvals/${f.request.approvalRequestId}`), await send('/audit')];
    for (const page of pages) {
      expect(page.status).toBe(200);
      expect(page.headers['content-security-policy']).toBe(CONSOLE_CSP);
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.headers['x-content-type-options']).toBe('nosniff');
    }
    const jsonLines = await send('/audit.jsonl');
    expect(jsonLines.headers['content-security-policy']).toBeUndefined();

    const headers = { 'X-Operator-Token': f.operatorToken };
    const simulate = await send('/cards/card_test_1/simulate',
      { csrf: f.csrf, amount: '1.00', currency: 'USD', mcc: '7372' }, headers);
    const freeze = await send('/cards/card_test_1/freeze', { csrf: f.csrf }, headers);
    const reconcile = await send('/reconcile', { cardId: 'card_test_1', csrf: f.csrf }, headers);
    expect([simulate.status, freeze.status, reconcile.status]).toEqual([200, 200, 200]);

    const digest = createHash('sha256').update(f.operatorToken).digest('hex');
    const transcript = JSON.stringify([...pages, jsonLines, simulate, freeze, reconcile])
      + JSON.stringify(f.ledger.read()) + JSON.stringify(f.store.list());
    expect(transcript).not.toContain(f.operatorToken);
    expect(transcript).not.toContain(digest);
  });

  it('requires the operator token on simulate, freeze, reconcile and recover even with a scraped CSRF', async () => {
    const f = await fixture();
    await f.grant();
    const send = await start(f.service);
    const page = await send(`/approvals/${f.request.approvalRequestId}`);
    const scraped = /name="csrf" value="([^"]+)"/.exec(page.text)?.[1];
    expect(scraped).toBe(f.csrf);
    const before = f.ledger.read().length;
    const simulate = vi.spyOn(f.client, 'simulateAuthorization');
    const freeze = vi.spyOn(f.client, 'freezeCard');
    const list = vi.spyOn(f.client, 'listTransactions');
    const lookup = vi.spyOn(f.client, 'findCardByRequestId');
    const routes = ['/cards/card_test_1/simulate', '/cards/card_test_1/freeze', '/reconcile',
      `/approvals/${f.request.approvalRequestId}/recover`];
    for (const path of routes) {
      const response = await send(path, { csrf: scraped, cardId: 'card_test_1', amount: '1.00',
        currency: 'USD', mcc: '7372' });
      expect(response.status).toBe(403);
      expect(JSON.parse(response.text)).toEqual({ error: 'operator_token_required' });
    }
    const wrong = await send('/cards/card_test_1/freeze', { csrf: scraped },
      { 'X-Operator-Token': 'wrong-test-operator-token' });
    expect(wrong.status).toBe(403);
    expect(JSON.parse(wrong.text)).toEqual({ error: 'operator_token_required' });
    for (const spy of [simulate, freeze, list, lookup]) expect(spy).not.toHaveBeenCalled();
    expect(f.ledger.read()).toHaveLength(before);
  });
});

describe('independent offline demo', () => {
  it('produces a verifiable ledger and detects a tampered copy', async () => {
    const result = await runDemo({ outputDir: false, now: () => new Date(instant), log: () => {} });
    expect(result.verification).toEqual({ ok: true });
    expect(verifyChain(result.ledger.read()).ok).toBe(true);
    expect(result.tamperVerification.ok).toBe(false);
    const tampered = structuredClone(result.ledger.read());
    tampered[0]!.at = '2000-01-01T00:00:00.000Z';
    expect(verifyChain(tampered).ok).toBe(false);
    const lines = result.ledger.read().map(record => JSON.stringify(record)).join('\n');
    expect(lines).not.toMatch(/4111111111111111|4111 1111 1111 1111/);
    expect(lines).not.toContain('test-api-key');
    expect(lines).not.toContain('test-session');
    expect(result.transcript).toContain('Ledger verify: OK.');
    expect(result.transcript).toContain('Tampered copy verify: FAIL (expected).');
  });
});

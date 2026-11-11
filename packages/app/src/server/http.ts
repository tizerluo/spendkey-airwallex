import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { parseWebhookEvent, transactionSchema, verifyWebhookSignature } from '@sk/airwallex';
import { verifyChain } from '@sk/ledger';
import { buildApprovalPageModel, buildAuditPageModel } from '../views/builders.js';
import { CONSOLE_CSP } from '../views/html.js';
import { renderApprovalPage } from '../views/approval-page.js';
import { renderAuditPage } from '../views/audit-page.js';
import { renderIndexPage } from '../views/index-page.js';
import { formatMinor } from '../views/money.js';
import { ApprovalService, ServiceError } from './service.js';
import { TransactionLoop } from './transactions.js';

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length;
    if (size > 64 * 1024) throw new ServiceError('body_too_large', 413);
    parts.push(bytes);
  }
  return Buffer.concat(parts);
}
function fields(body: Buffer, contentType: string): Record<string, unknown> {
  if (contentType.startsWith('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(body.toString('utf8')));
  if (!contentType.startsWith('application/json')) throw new ServiceError('content_type_required', 415);
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new ServiceError('invalid_body'); }
}
function stringField(input: Record<string, unknown>, name: string): string { return typeof input[name] === 'string' ? input[name] : ''; }
function respond(response: ServerResponse, status: number, body: string, html = false): void {
  response.writeHead(status, { 'Content-Type': html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
    ...(html ? { 'Content-Security-Policy': CONSOLE_CSP } : {}),
  });
  response.end(body);
}
export function createConsoleServer(service: ApprovalService, options: { webhookSecret?: string } = {}) {
  const loop = new TransactionLoop(service);
  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1:8787');
      const path = url.pathname;
      const method = request.method;
      const { store, ledger } = service.options;
      // Reject browser cross-origin writes, including DNS rebinding to this loopback server.
      if (request.headers.host && !/^127\.0\.0\.1:\d+$/.test(request.headers.host)) throw new ServiceError('invalid_host', 403);
      if (method === 'POST' && request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) {
        throw new ServiceError('invalid_origin', 403);
      }
      if (method === 'GET' && path === '/') {
        respond(response, 200, renderIndexPage({ approvals: store.list().map(item => {
          const record = service.get(item.request.approvalRequestId);
          return { id: record.request.approvalRequestId, status: record.status, vendor: record.request.vendor,
            amount: formatMinor(record.request.amountMinor, record.request.currency), currency: record.request.currency };
        }) }), true); return;
      }
      const approvalRoute = /^\/approvals\/([a-zA-Z0-9_-]+)(?:\/(approve|reject))?$/.exec(path);
      if (method === 'GET' && approvalRoute && !approvalRoute[2]) {
        const record = service.get(approvalRoute[1]!);
        const built = buildApprovalPageModel({ approvalId: record.approval?.approvalId ?? '', request: record.request,
          status: record.status, nonceHint: 'nonce printed in operator terminal', csrf: record.csrf,
          events: ledger.read(), ...(record.card === undefined ? {} : { card: record.card }) });
        if (service.options.demoMode) built.model.demoMode = true;
        respond(response, 200, renderApprovalPage(built.model, { csrfToken: built.csrfToken }), true); return;
      }
      if (method === 'GET' && path === '/audit') {
        const events = ledger.read();
        const model = buildAuditPageModel(events, verifyChain(events));
        for (const card of model.cards) {
          const current = store.list().find(record => record.card?.cardId === card.cardId)?.card?.status;
          if (current !== undefined) card.status = current;
        }
        respond(response, 200, renderAuditPage(model), true); return;
      }
      if (method === 'GET' && path === '/audit.jsonl') {
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
        response.end(ledger.read().map(event => JSON.stringify(event) + '\n').join('')); return;
      }
      if (method !== 'POST') throw new ServiceError('not_found', 404);
      if (path === '/webhooks/airwallex') {
        if (!options.webhookSecret) throw new ServiceError('not_found', 404);
        const rawBody = await readBody(request);
        if (!verifyWebhookSignature({ rawBody, timestamp: String(request.headers['x-timestamp'] ?? ''),
          signature: String(request.headers['x-signature'] ?? ''), secret: options.webhookSecret, nowMs: service.now().getTime() })) {
          throw new ServiceError('invalid_signature', 401);
        }
        let event;
        try { event = parseWebhookEvent(rawBody); } catch { throw new ServiceError('invalid_webhook'); }
        const deduped = ledger.read().some(({ event: existing }) => existing.kind === 'webhook_received' && existing.eventId === event.id);
        ledger.append({ kind: 'webhook_received', eventId: event.id, name: event.name, deduped }, service.now().toISOString());
        if (!deduped && event.name.startsWith('issuing.transaction.')) {
          const parsed = transactionSchema.safeParse(event.data);
          if (parsed.success && store.list().some(record => record.card?.cardId === parsed.data.card_id)) loop.observe(parsed.data);
        }
        respond(response, 200, '{"ok":true}'); return;
      }
      const input = fields(await readBody(request), request.headers['content-type'] ?? '');
      if (path === '/approvals') {
        const submitted = await service.submit(input as unknown as Parameters<ApprovalService['submit']>[0]);
        respond(response, 201, JSON.stringify(submitted)); return;
      }
      if (approvalRoute?.[2]) {
        const id = approvalRoute[1]!;
        if (approvalRoute[2] === 'reject') service.reject(id, stringField(input, 'csrf'));
        else await service.grant(id, { csrf: stringField(input, 'csrf'), nonce: stringField(input, 'nonce'),
          presentedTermsHash: stringField(input, 'presentedTermsHash'),
          ...(typeof input['merchantCategoryCode'] === 'string' ? { merchantCategoryCode: input['merchantCategoryCode'] } : {}),
        });
        // POST/redirect/GET makes browser refresh safe.
        response.writeHead(303, { Location: `/approvals/${id}`, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        response.end(); return;
      }
      const cardRoute = /^\/cards\/([a-zA-Z0-9_-]+)\/(simulate|freeze)$/.exec(path);
      if (cardRoute || path === '/reconcile') {
        const cardId = cardRoute?.[1] ?? stringField(input, 'cardId');
        const owner = store.list().find(record => record.card?.cardId === cardId);
        if (!owner) throw new ServiceError('card_not_found', 404);
        service.checkCsrf(owner, stringField(input, 'csrf'));
        if (cardRoute?.[2] === 'simulate') {
          const result = await loop.simulate(cardId, { amount: stringField(input, 'amount'), currency: stringField(input, 'currency'), mcc: stringField(input, 'mcc') });
          respond(response, 200, JSON.stringify(result));
        } else if (cardRoute?.[2] === 'freeze') {
          await loop.freeze(cardId, 'human', 'console freeze'); respond(response, 200, '{"ok":true}');
        } else {
          if ((input['from'] === undefined) !== (input['to'] === undefined)) throw new ServiceError('invalid_window');
          const window = typeof input['from'] === 'string' && typeof input['to'] === 'string' ? { from: input['from'], to: input['to'] } : undefined;
          respond(response, 200, JSON.stringify(await loop.reconcile(cardId, window)));
        }
        return;
      }
      throw new ServiceError('not_found', 404);
    })().catch((error: unknown) => {
      // Never expose request fields, response bodies, nonce, or provider exceptions.
      respond(response, error instanceof ServiceError ? error.status : 400,
        JSON.stringify({ error: error instanceof ServiceError ? error.code : 'request_failed' }));
    });
  });
}

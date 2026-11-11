import { request as httpRequest, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAirwallexConfig } from '@sk/airwallex';
import { InMemoryLedgerStore, verifyJsonl } from '@sk/ledger';
import { termsHash } from '@sk/policy';
import { createFakeAirwallex } from '../demo/fake-airwallex.js';
import { DEMO_POLICY_NOTES, demoReserveFloorMinor } from '../demo/policy.js';
import { runDemo } from '../demo/run.js';
import { createAppAirwallexClient } from './airwallex-client.js';
import { startOfflineConsole } from './offline.js';
import { recordConsoleRun, seedDesignCoRequest } from './seed.js';
import { ApprovalService, controlsMatch } from './service.js';
import { MemoryApprovalStore } from './store.js';

const now = () => new Date('2026-11-11T10:00:00.000Z');
const config = () => loadAirwallexConfig({ AIRWALLEX_CLIENT_ID: 'test-client-id', AIRWALLEX_API_KEY: 'test-api-key' });
afterEach(() => vi.restoreAllMocks());

function send(url: string, path: string, input?: Record<string, string>, token?: string) {
  return new Promise<{ status: number; text: string }>((accept, reject) => {
    const body = input === undefined ? undefined : new URLSearchParams(input).toString();
    const request = httpRequest(new URL(path, url), { method: body === undefined ? 'GET' : 'POST', headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
      ...(token === undefined ? {} : { 'X-Operator-Token': token }),
    } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { text += chunk; });
      response.on('end', () => accept({ status: response.statusCode!, text }));
    });
    request.on('error', reject); request.end(body);
  });
}
async function close(server: Server) {
  await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
}
function hidden(html: string, name: string): string {
  const value = new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1];
  if (!value) throw new Error('test_missing_form_field');
  return value;
}

describe('offline console video fallback', () => {
  it('runs human nonce approval, emulated charges, freeze, reconcile, and file tamper diagnostics over HTTP', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch'); // repository setup throws if this is ever called
    const root = mkdtempSync(join(tmpdir(), 'spendkey-offline-http-'));
    const lines: string[] = [];
    const app = await startOfflineConsole({ port: 0, dataRoot: root, now, log: line => lines.push(line) });
    try {
      expect(app.server.address()).toMatchObject({ address: '127.0.0.1' });
      const nonce = lines.find(line => line.startsWith('APPROVAL NONCE '))!.split(': ')[1]!;
      const token = lines.find(line => line.startsWith('OPERATOR TOKEN: '))!.split(': ')[1]!;
      const index = await send(app.url, '/');
      expect(index.status).toBe(200);
      expect(index.text).toContain('Offline emulator (no Airwallex calls)');
      const path = /href="(\/approvals\/[^"]+)"/.exec(index.text)![1]!;
      const page = await send(app.url, path);
      expect(page.text).toContain('Approve exactly these terms');
      expect(page.text).not.toContain('Demo: auto-approval');
      expect(page.text).not.toContain(nonce); expect(page.text).not.toContain(token);
      const fields = { csrf: hidden(page.text, 'csrf'), presentedTermsHash: hidden(page.text, 'presentedTermsHash'), nonce };
      expect((await send(app.url, `${path}/approve`, { ...fields, nonce: 'wrong-test-nonce' })).status).toBe(403);
      expect((await send(app.url, `${path}/approve`, fields)).status).toBe(303);
      expect((await send(app.url, `${path}/approve`, fields)).status).toBe(409);
      const issued = await send(app.url, path);
      expect(issued.text).toContain('Simulate authorization — emulated (offline)');
      const cardPath = /action="(\/cards\/[^"]+)\/simulate"/.exec(issued.text)![1]!;
      const operator = { csrf: fields.csrf, amount: '10.00', currency: 'USD', mcc: '7372' };
      expect((await send(app.url, `${cardPath}/simulate`, operator)).status).toBe(403);
      expect((await send(app.url, `${cardPath}/simulate`, { ...operator, csrf: 'wrong-test-csrf' }, token)).status).toBe(403);
      for (const [amount, mcc, mapped] of [
        ['10.00', '7372', 'approved'], ['61.00', '7372', 'limit_exceeded'], ['1.00', '5812', 'merchant_category_not_allowed'],
      ]) {
        const result = await send(app.url, `${cardPath}/simulate`, { ...operator, amount: amount!, mcc: mcc! }, token);
        expect(result.status).toBe(200);
        expect(JSON.parse(result.text)).toEqual({ mapped, label: 'emulated (offline)' });
      }
      expect((await send(app.url, `${cardPath}/freeze`, { csrf: fields.csrf }, token)).status).toBe(200);
      const inactive = await send(app.url, `${cardPath}/simulate`, { ...operator, amount: '1.00' }, token);
      expect(JSON.parse(inactive.text)).toEqual({ mapped: 'card_inactive', label: 'emulated (offline)' });
      const reconciliation = await send(app.url, '/reconcile', { csrf: fields.csrf, cardId: cardPath.split('/')[2]! }, token);
      expect(reconciliation.status).toBe(200);
      expect(JSON.parse(reconciliation.text)).toMatchObject({ settledMinor: 1000, failedCount: 3 });
      const audit = await send(app.url, '/audit');
      expect(audit.status).toBe(200); expect(audit.text).toContain('Chain valid');
      expect(audit.text).toContain('emulated (offline)'); expect(audit.text.toLowerCase()).not.toContain('sandbox');
      expect(audit.text).toContain('card_inactive');
      const jsonl = readFileSync(app.ledgerPath, 'utf8');
      expect(verifyJsonl(jsonl).ok).toBe(true);
      expect(jsonl).not.toContain(nonce); expect(jsonl).not.toContain(token);
      expect(app.service.options.ledger.read()[0]?.event).toEqual({ kind: 'run_started', mode: 'offline_emulator', policyNotes: DEMO_POLICY_NOTES });
      expect(app.service.options.ledger.read().find(row => row.event.kind === 'authorization' && row.event.mapped === 'card_inactive')?.event)
        .toMatchObject({ failureReason: 'CARD_INACTIVE' });
      expect(app.service.options.ledger.read().find(row => row.event.kind === 'approval_granted')?.event)
        .toMatchObject({ demoAutoApproved: false, approver: { id: 'console-operator' } });
      const rows = jsonl.trimEnd().split('\n');
      const first = JSON.parse(rows[0]!) as { event: { policyNotes: string[] } };
      first.event.policyNotes[0] += ' (edited)'; rows[0] = JSON.stringify(first);
      writeFileSync(app.ledgerPath, rows.join('\n') + '\n');
      const broken = await send(app.url, '/audit');
      expect(broken.status).toBe(200); expect(broken.text).toContain('Chain BROKEN');
      expect(broken.text).toContain('hash_mismatch');
      // A broken file is diagnostic only; the normal store must still refuse writes.
      expect((await send(app.url, `${cardPath}/simulate`, operator, token)).status).not.toBe(200);
      expect(globalFetch).not.toHaveBeenCalled();
    } finally { await close(app.server); rmSync(root, { recursive: true, force: true }); }
  });

  it('creates a unique state directory on every start and preserves the earlier recording', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spendkey-offline-fresh-'));
    try {
      const first = await startOfflineConsole({ port: 0, dataRoot: root, now, log: () => {} });
      const original = readFileSync(first.ledgerPath, 'utf8');
      await close(first.server);
      const second = await startOfflineConsole({ port: 0, dataRoot: root, now, log: () => {} });
      try {
        expect(second.dataDir).not.toBe(first.dataDir);
        expect(readFileSync(first.ledgerPath, 'utf8')).toBe(original);
        expect(second.service.options.store.list()).toHaveLength(1);
        expect(second.service.options.store.list()[0]?.status).toBe('requested');
      } finally { await close(second.server); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('shared demo reserve policy', () => {
  it.each(['1000.00', '1200.00', '1000000.00'])('refuses annual for reserve_breach and asks monthly at USD %s in both seeds and demos', async available_amount => {
    const fake = createFakeAirwallex({ now });
    const client = createAppAirwallexClient(config(), async (target, init) => {
      if (new URL(String(target)).pathname === '/api/v1/balances/current') return new Response(JSON.stringify([{
        currency: 'USD', available_amount, pending_amount: '0.00', reserved_amount: '0.00', total_amount: available_amount,
        prepayment_amount: '0.00', account_type: 'WALLET',
      }]));
      return fake.fetch(target, init);
    });
    expect(demoReserveFloorMinor([{ currency: 'USD', available_amount }])).toBe(Number(available_amount) * 100 - 50_000);
    const ledger = new InMemoryLedgerStore();
    const service = new ApprovalService({ client, ledger, store: new MemoryApprovalStore(), now,
      cardholderId: 'cardholder_test_01', printNonce: () => {}, printOperatorToken: () => {} });
    recordConsoleRun(ledger, now()); await seedDesignCoRequest(service);
    const demo = await runDemo({ client, now, outputDir: false });
    for (const records of [ledger.read(), demo.ledger.read()]) {
      expect(records[0]?.event).toMatchObject({ kind: 'run_started', policyNotes: DEMO_POLICY_NOTES });
      expect(records.find(row => row.event.kind === 'decision')?.event).toMatchObject({
        action: 'ask', chosenOfferId: 'curated-designco-team-monthly', ruleResults: expect.arrayContaining([
          expect.objectContaining({ offerId: 'curated-designco-team-annual', code: 'reserve_breach', pass: false }),
        ]),
      });
    }
    expect(service.options.store.list()[0]?.request).toMatchObject({ plan: 'monthly', amountMinor: 6000 });
  });
  it('clamps the floor at zero for missing or small USD balances', () => {
    expect(demoReserveFloorMinor([])).toBe(0);
    expect(demoReserveFloorMinor([{ currency: 'USD', available_amount: 100 }])).toBe(0);
  });
});

describe('controls readback projection', () => {
  it('compares arrays as sets, decimal amounts and recursively sent keys independent of object order', () => {
    expect(controlsMatch({ currencies: ['USD', 'EUR', 'USD'], limits: [{ interval: 'MONTHLY', amount: 60 }] },
      { extra: null, limits: [{ amount: '60.00', remaining: 50, interval: 'MONTHLY' }], currencies: ['EUR', 'USD'] })).toBe(true);
    expect(controlsMatch({ currencies: ['USD'] }, { currencies: ['USD', 'EUR'] })).toBe(false);
    expect(controlsMatch({ amount: 0 }, { other: null })).toBe(false);
    expect(controlsMatch({ amount: 60 }, { amount: '61.00' })).toBe(false);
  });

  it.each(['extras', 'missing_mcc', 'different_limit'] as const)('records provider evidence through the injected transport (%s)', async change => {
    const fake = createFakeAirwallex({ now });
    const client = createAppAirwallexClient(config(), async (target, init) => {
      const response = await fake.fetch(target, init);
      if (init?.method !== 'GET' || !/\/issuing\/cards\/card_test_1$/.test(new URL(String(target)).pathname)) return response;
      const card = await response.json() as Record<string, unknown>;
      const controls = card['authorization_controls'] as Record<string, unknown>;
      const limits = controls['transaction_limits'] as { limits: { amount: string | number; remaining?: number }[] };
      if (change === 'extras') {
        controls['active_from'] = null; controls['active_to'] = '2099-01-01'; controls['provider_default'] = null;
        controls['api_key'] = 'test-redacted-key'; limits.limits[0]!.remaining = 60;
        limits.limits[0]!.amount = '60.00';
      } else if (change === 'missing_mcc') delete controls['allowed_merchant_categories'];
      else limits.limits[0]!.amount = '61.00';
      return new Response(JSON.stringify(card));
    });
    let nonce = '';
    const ledger = new InMemoryLedgerStore();
    const service = new ApprovalService({ client, ledger, store: new MemoryApprovalStore(), now,
      cardholderId: 'cardholder_test_01', printNonce: line => { nonce = line.split(': ')[1]!; }, printOperatorToken: () => {} });
    await seedDesignCoRequest(service);
    const record = service.options.store.list()[0]!;
    const issue = service.grant(record.request.approvalRequestId, { nonce, csrf: record.csrf, presentedTermsHash: termsHash(record.request) });
    if (change === 'extras') await expect(issue).resolves.toMatchObject({ status: 'issued' });
    else await expect(issue).rejects.toMatchObject({ code: 'controls_mismatch' });
    const readback = ledger.read().find(row => row.event.kind === 'controls_readback')?.event;
    expect(readback).toMatchObject({ matches: change === 'extras' });
    if (change === 'extras') {
      expect(readback).toMatchObject({ actual: { active_from: null, active_to: '2099-01-01', provider_default: null,
        transaction_limits: { limits: [{ amount: '60.00', remaining: 60 }] } } });
      expect(JSON.stringify(readback)).not.toContain('test-redacted-key');
    } else {
      expect(service.options.store.list()[0]?.card?.status).toBe('INACTIVE');
      expect(ledger.read().some(row => row.event.kind === 'card_issued')).toBe(false);
    }
  });
});

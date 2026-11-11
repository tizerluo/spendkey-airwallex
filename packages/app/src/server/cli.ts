import { mkdirSync } from 'node:fs';
import { AirwallexClient, loadAirwallexConfig } from '@sk/airwallex';
import { openJsonlLedger } from '@sk/ledger';
import { runAgent } from '@sk/agent';
import { createCuratedSource } from '@sk/offers';
import { ApprovalService } from './service.js';
import { JsonApprovalStore } from './store.js';
import { createConsoleServer } from './http.js';
import { monthWindow, spentInWindowMinor } from './transactions.js';

let cleanup = () => { /* startup has not opened resources */ };
try {
  const config = loadAirwallexConfig(process.env);
  const cardholderId = process.env['AIRWALLEX_CARDHOLDER_ID'];
  if (!cardholderId) throw new Error('configuration_required');
  mkdirSync('./console-data', { recursive: true, mode: 0o700 });
  const store = new JsonApprovalStore('./console-data/approvals.json');
  cleanup = () => store.close();
  const ledger = openJsonlLedger('./console-data/ledger.jsonl');
  cleanup = () => { ledger.close(); store.close(); };
  const client = new AirwallexClient(config, { fetch: globalThis.fetch });
  const service = new ApprovalService({ store, ledger, client, cardholderId });
  const secret = process.env['AIRWALLEX_WEBHOOK_SECRET'];
  const server = createConsoleServer(service, secret ? { webhookSecret: secret } : {});
  server.once('close', () => cleanup());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(8787, '127.0.0.1', resolve);
  });
  console.log('Spendkey console: http://127.0.0.1:8787');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { server.close(); });
  // Recover durable approvals before accepting a new main line. Attempted creates are lookup-only.
  for (const record of store.list()) {
    if (['approved', 'issuing', 'failed'].includes(record.status)) {
      try { await service.issue(record.request.approvalRequestId); }
      catch { console.error('Prior issuance still unconfirmed; preserved for operator recovery.'); }
    }
  }
  // Seed a reviewable DesignCo request. Agent gets read-only balance access.
  try {
    await runAgent({ intent: 'design tool', usage: { horizonMonths: 12 }, sources: [createCuratedSource()], ledger,
      approvalService: service, ctx: {
        balanceProvider: () => client.getBalances(), spentInWindowMinor: () => spentInWindowMinor(ledger, 'USD', monthWindow(service.now())),
        knownObligations: [{ currency: 'USD', amountMinor: 10_000, dueInDays: 15 }], reserveHorizonDays: 30,
        reserveFloorMinor: { USD: 50_000 }, budgetCurrency: 'USD', windowBudgetMinor: 100_000,
        maxCommitmentMonths: 12, billingCountry: 'US', cardCountry: 'US',
      } });
  } catch { console.error('Agent request unavailable; console and existing approvals remain available.'); }
} catch {
  cleanup();
  console.error('Console startup failed. Set AIRWALLEX_CLIENT_ID, AIRWALLEX_API_KEY and AIRWALLEX_CARDHOLDER_ID; check local store locks.');
  process.exitCode = 1;
}

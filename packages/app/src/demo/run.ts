import { copyFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { type AirwallexClient, loadAirwallexConfig } from '@sk/airwallex';
import { runAgent, type AgentContext } from '@sk/agent';
import { createCuratedSource } from '@sk/offers';
import { InMemoryLedgerStore, parseJsonl, runLedgerCli, verifyChain, signedDecimalToMinor, redactValue, type JsonlVerification, type LedgerStore } from '@sk/ledger';
import { termsHash } from '@sk/policy';
import { ApprovalService } from '../server/service.js';
import { MemoryApprovalStore, type ApprovalStore } from '../server/store.js';
import { reconciledSpendInWindowMinor, TransactionLoop } from '../server/transactions.js';
import { installDemoSignalHandlers } from './safety.js';
import { createFakeAirwallex } from './fake-airwallex.js';
import { DEMO_POLICY_NOTES, demoReserveFloorMinor } from './policy.js';
import { cardControlsReadback, createAppAirwallexClient } from '../server/airwallex-client.js';

export function demoContext(service: ApprovalService): AgentContext {
  return {
    balanceProvider: () => service.options.client.getBalances(), spentInWindowMinor: () => reconciledSpendInWindowMinor(service, 'USD'), now: service.now,
    knownObligations: [{ currency: 'USD', amountMinor: 10_000, dueInDays: 15 }],
    reserveHorizonDays: 30, reserveFloorMinor: { USD: 50_000 }, budgetCurrency: 'USD',
    windowBudgetMinor: 100_000, maxCommitmentMonths: 12, billingCountry: 'US', cardCountry: 'US',
  };
}
export async function runDemo(options: {
  client?: AirwallexClient; cardholderId?: string; now?: () => Date; outputDir?: string | false;
  ledger?: LedgerStore; store?: ApprovalStore;
  log?: (line: string) => void; handleSignals?: boolean; signalClose?: () => void;
} = {}) {
  const now = options.now ?? (() => new Date());
  const fake = createFakeAirwallex({ now });
  const client = options.client ?? createAppAirwallexClient(loadAirwallexConfig({
    AIRWALLEX_CLIENT_ID: 'test-client-id', AIRWALLEX_API_KEY: 'test-api-key',
  }), fake.fetch);
  const ledger = options.ledger ?? new InMemoryLedgerStore(); const store = options.store ?? new MemoryApprovalStore();
  const transcript: string[] = [];
  const say = (line: string) => { transcript.push(line); options.log?.(line); };
  // The demo operator receives the same terminal-only nonce that a human would.
  let operatorNonce = '';
  const service = new ApprovalService({ client, ledger, store, now, demoMode: true,
    cardholderId: options.cardholderId ?? 'cardholder_test_01',
    printNonce(line) { operatorNonce = line.slice(line.lastIndexOf(': ') + 2); },
  });
  const loop = new TransactionLoop(service);
  const ctx = demoContext(service);
  const policyNotes = DEMO_POLICY_NOTES;
  ledger.append({ kind: 'run_started', mode: options.client ? 'sandbox' : 'offline_emulator', policyNotes }, now().toISOString());
  const uninstallSignals = options.handleSignals ? installDemoSignalHandlers(service, say, process, options.signalClose) : () => {};
  let frozen = false; let cardId: string | undefined; let requestId: string | undefined;
  try {
    say(options.client ? 'Airwallex sandbox demo; synthetic offers; demo-operator auto-approval' : 'Offline emulator (no Airwallex calls); emulated (offline); synthetic offers; demo-operator auto-approval');
    const balances = await client.getBalances().catch((error: unknown) =>
      service.providerFailure(error, '/api/v1/balances/current', 'balance check'));
    const usd = balances.find(balance => balance.currency === 'USD');
    if (!usd || signedDecimalToMinor(usd.available_amount, 'USD') < 16_000) throw new Error('demo_requires_usd_sandbox_funds');
    ctx.reserveFloorMinor = { USD: demoReserveFloorMinor(balances) };
    ctx.balanceProvider = async () => balances;
    const floor = ((ctx.reserveFloorMinor['USD'] ?? 0) / 100).toFixed(2);
    for (const note of policyNotes) say(`Demo policy: ${note}`);
    say(`Demo policy: reserve floor ${floor} USD must remain after upfront charges`);
    const result = await runAgent({ intent: 'design tool', usage: { horizonMonths: 12 },
      ctx, sources: [createCuratedSource()], ledger, approvalService: service });
    const annual = result.decision.ranked.find(entry => entry.candidate.plan === 'annual');
    if (!annual?.results.some(rule => rule.code === 'reserve_breach' && !rule.pass)) throw new Error('demo_expected_annual_reserve_refusal');
    say('DesignCo annual: refused — reserve_breach (cheaper over 12 months, too much upfront).');
    if (!result.request || result.decision.chosen?.plan !== 'monthly') throw new Error('demo_expected_monthly_ask');
    say('DesignCo monthly: ask for human approval.');
    requestId = result.request.approvalRequestId;
    const record = await service.grant(result.request.approvalRequestId, { nonce: operatorNonce,
      csrf: service.get(result.request.approvalRequestId).csrf, presentedTermsHash: termsHash(result.request) });
    cardId = record.card?.cardId;
    if (!cardId) throw new Error('demo_expected_card');
    const readback = await client.getCard(cardId).catch((error: unknown) =>
      service.providerFailure(error, `/api/v1/issuing/cards/${cardId}`, 'controls transcript readback'));
    say(`demo-operator approved (demoAutoApproved=true). Card ${readback.card_status}; controls read back: ${JSON.stringify(redactValue(cardControlsReadback(client, readback)))}`);
    const cases = [
      { amount: '10.00', currency: 'USD', mcc: '7372', expected: 'approved' },
      { amount: '61.00', currency: 'USD', mcc: '7372', expected: 'limit_exceeded' },
      { amount: '1.00', currency: 'USD', mcc: '5812', expected: 'merchant_category_not_allowed' },
    ];
    for (const input of cases) {
      const outcome = await loop.simulate(cardId, input);
      if (outcome.mapped !== input.expected) throw new Error('demo_unexpected_authorization');
      say(`${options.client ? 'sandbox simulation' : 'emulated (offline)'}: ${input.amount} ${input.currency}, MCC ${input.mcc} -> ${outcome.mapped}`);
    }
    await loop.freeze(cardId, 'human', 'demo-operator: demo complete; prevent further use'); frozen = true;
    say('Demo operator froze the card: INACTIVE.');
    const inactive = await loop.simulate(cardId, { amount: '1.00', currency: 'USD', mcc: '7372' });
    if (inactive.mapped !== 'card_inactive') throw new Error('demo_expected_inactive');
    say(`${options.client ? 'sandbox simulation' : 'emulated (offline)'} after freeze -> card_inactive`);
    const reconciled = await loop.reconcile(cardId);
    say(`Reconciled: settled ${reconciled.settledMinor} minor, pending ${reconciled.pendingMinor} minor, failed ${reconciled.failedCount}.`);
    const verification = verifyChain(ledger.read());
    if (!verification.ok) throw new Error('demo_chain_invalid');
    say('Ledger verify: OK.');
    const head = ledger.read().at(-1)!;
    say(`Ledger head: ${JSON.stringify({ seq: head.seq, hash: head.hash })}`);
    say('Tamper-evident given a published head hash.');
    const temp = mkdtempSync(resolve(tmpdir(), 'spendkey-audit-'));
    let tamperVerification: JsonlVerification;
    try {
      const originalPath = resolve(temp, 'ledger.jsonl');
      writeFileSync(originalPath, ledger.read().map(event => JSON.stringify(event) + '\n').join(''), { mode: 0o600 });
      const original = runLedgerCli(['verify', originalPath, '--expect-head', head.hash, '--expect-seq', String(head.seq)]);
      if (original.exitCode !== 0) throw new Error('demo_chain_invalid');
      const tamperedPath = resolve(temp, 'ledger.tampered.jsonl');
      copyFileSync(originalPath, tamperedPath);
      const tampered = parseJsonl(readFileSync(tamperedPath, 'utf8'));
      tampered[0]!.at = '2000-01-01T00:00:00.000Z';
      writeFileSync(tamperedPath, tampered.map(event => JSON.stringify(event) + '\n').join(''), { mode: 0o600 });
      const result = runLedgerCli(['verify', tamperedPath, '--expect-head', head.hash]);
      tamperVerification = JSON.parse(result.output) as JsonlVerification;
      if (result.exitCode !== 1 || tamperVerification.ok) throw new Error('demo_tampering_undetected');
    } finally { rmSync(temp, { recursive: true, force: true }); }
    say('Tampered copy verify: FAIL (expected).');
    return { ledger, store, transcript, verification, tamperVerification, fake };
  } finally {
    try {
      if (requestId) cardId ??= store.get(requestId)?.card?.cardId;
      if (cardId && !frozen) await loop.freeze(cardId, 'human', 'demo-operator: demo cleanup');
    } finally {
      uninstallSignals();
      // Preserve diagnostics, including cleanup, even when issuance or simulation fails.
      if (options.outputDir !== false) {
        const dir = resolve(options.outputDir ?? './demo-output'); mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(resolve(dir, 'ledger.jsonl'), ledger.read().map(event => JSON.stringify(event) + '\n').join(''), { mode: 0o600 });
        say('Wrote ledger.jsonl.');
      }
    }
  }
}

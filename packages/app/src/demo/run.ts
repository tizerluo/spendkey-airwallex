import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AirwallexClient, loadAirwallexConfig } from '@sk/airwallex';
import { runAgent, type AgentContext } from '@sk/agent';
import { createCuratedSource } from '@sk/offers';
import { InMemoryLedgerStore, verifyChain, signedDecimalToMinor, type LedgerStore } from '@sk/ledger';
import { termsHash } from '@sk/policy';
import { ApprovalService } from '../server/service.js';
import { MemoryApprovalStore, type ApprovalStore } from '../server/store.js';
import { monthWindow, spentInWindowMinor, TransactionLoop } from '../server/transactions.js';
import { createFakeAirwallex } from './fake-airwallex.js';

export function demoContext(client: AirwallexClient, ledger: LedgerStore, now: () => Date): AgentContext {
  return {
    balanceProvider: () => client.getBalances(), spentInWindowMinor: () => spentInWindowMinor(ledger, 'USD', monthWindow(now())), now,
    knownObligations: [{ currency: 'USD', amountMinor: 10_000, dueInDays: 15 }],
    reserveHorizonDays: 30, reserveFloorMinor: { USD: 50_000 }, budgetCurrency: 'USD',
    windowBudgetMinor: 100_000, maxCommitmentMonths: 12, billingCountry: 'US', cardCountry: 'US',
  };
}
export async function runDemo(options: {
  client?: AirwallexClient; cardholderId?: string; now?: () => Date; outputDir?: string | false;
  ledger?: LedgerStore; store?: ApprovalStore;
  log?: (line: string) => void;
} = {}) {
  const now = options.now ?? (() => new Date());
  const fake = createFakeAirwallex({ now });
  const client = options.client ?? new AirwallexClient(loadAirwallexConfig({
    AIRWALLEX_CLIENT_ID: 'test-client-id', AIRWALLEX_API_KEY: 'test-api-key',
  }), { fetch: fake.fetch });
  const ledger = options.ledger ?? new InMemoryLedgerStore(); const store = options.store ?? new MemoryApprovalStore();
  const transcript: string[] = [];
  const say = (line: string) => { transcript.push(line); options.log?.(line); };
  // The demo operator receives the same terminal-only nonce that a human would.
  let operatorNonce = '';
  const service = new ApprovalService({ client, ledger, store, now, demoMode: true,
    cardholderId: options.cardholderId ?? 'cardholder_test_01',
    printNonce(line) { operatorNonce = line.slice(line.lastIndexOf(': ') + 2); options.log?.(line); },
  });
  const loop = new TransactionLoop(service);
  say(options.client ? 'Airwallex sandbox demo; synthetic offers; demo-operator auto-approval' : 'OFFLINE sandbox simulation; synthetic offers and fake Airwallex; demo-operator auto-approval');
  const ctx = demoContext(client, ledger, now);
  if (options.client) {
    const balances = await client.getBalances();
    const usd = balances.find(balance => balance.currency === 'USD');
    if (!usd || signedDecimalToMinor(usd.available_amount, 'USD') < 16_000) throw new Error('demo_requires_usd_sandbox_funds');
    // Leave $400 of upfront room after the synthetic $100 obligation, whatever the sandbox balance.
    ctx.reserveFloorMinor = { USD: Math.max(0, signedDecimalToMinor(usd.available_amount, 'USD') - 50_000) };
    ctx.balanceProvider = async () => balances;
  }
  const result = await runAgent({ intent: 'design tool', usage: { horizonMonths: 12 },
    ctx, sources: [createCuratedSource()], ledger, approvalService: service });
  const annual = result.decision.ranked.find(entry => entry.candidate.plan === 'annual');
  if (!annual?.results.some(rule => rule.code === 'reserve_breach' && !rule.pass)) throw new Error('demo_expected_annual_reserve_refusal');
  say('DesignCo annual: refused — reserve_breach (cheaper over 12 months, too much upfront).');
  if (!result.request || result.decision.chosen?.plan !== 'monthly') throw new Error('demo_expected_monthly_ask');
  say('DesignCo monthly: ask for human approval.');
  let frozen = false; let cardId: string | undefined;
  try {
    const record = await service.grant(result.request.approvalRequestId, { nonce: operatorNonce,
      csrf: service.get(result.request.approvalRequestId).csrf, presentedTermsHash: termsHash(result.request) });
    cardId = record.card?.cardId;
    if (!cardId) throw new Error('demo_expected_card');
    say('demo-operator approved (demoAutoApproved=true). Card ACTIVE: MONTHLY limit, USD, MCC 7372.');
    const cases = [
      { amount: '10.00', currency: 'USD', mcc: '7372', expected: 'approved' },
      { amount: '61.00', currency: 'USD', mcc: '7372', expected: 'limit_exceeded' },
      { amount: '1.00', currency: 'USD', mcc: '5812', expected: 'merchant_category_not_allowed' },
    ];
    for (const input of cases) {
      const outcome = await loop.simulate(cardId, input);
      if (outcome.mapped !== input.expected) throw new Error('demo_unexpected_authorization');
      say(`sandbox simulation: ${input.amount} ${input.currency}, MCC ${input.mcc} -> ${outcome.mapped}`);
    }
    await loop.freeze(cardId, 'agent', 'demo complete; prevent further use'); frozen = true;
    say('Agent froze the card: INACTIVE.');
    const inactive = await loop.simulate(cardId, { amount: '1.00', currency: 'USD', mcc: '7372' });
    if (inactive.mapped !== 'card_inactive') throw new Error('demo_expected_inactive');
    say('sandbox simulation after freeze -> card_inactive');
    const reconciled = await loop.reconcile(cardId);
    say(`Reconciled: settled ${reconciled.settledMinor} minor, pending ${reconciled.pendingMinor} minor, failed ${reconciled.failedCount}.`);
    const verification = verifyChain(ledger.read());
    if (!verification.ok) throw new Error('demo_chain_invalid');
    say('Ledger verify: OK.');
    const tampered = ledger.read(); tampered[0]!.at = '2000-01-01T00:00:00.000Z';
    const tamperVerification = verifyChain(tampered);
    if (tamperVerification.ok) throw new Error('demo_tampering_undetected');
    say('Tampered copy verify: FAIL (expected).');
    return { ledger, store, transcript, verification, tamperVerification, fake };
  } finally {
    try {
      cardId ??= store.get(result.request.approvalRequestId)?.card?.cardId;
      if (cardId && !frozen) await loop.freeze(cardId, 'agent', 'demo cleanup');
    } finally {
      // Preserve diagnostics, including cleanup, even when issuance or simulation fails.
      if (options.outputDir !== false) {
        const dir = resolve(options.outputDir ?? './demo-output'); mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(resolve(dir, 'ledger.jsonl'), ledger.read().map(event => JSON.stringify(event) + '\n').join(''), { mode: 0o600 });
        say('Wrote ledger.jsonl.');
      }
    }
  }
}

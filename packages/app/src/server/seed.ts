import { runAgent } from '@sk/agent';
import { createCuratedSource } from '@sk/offers';
import type { ApprovalService } from './service.js';
import { reconciledSpendInWindowMinor } from './transactions.js';

export async function seedDesignCoRequest(service: ApprovalService): Promise<void> {
  const { store, ledger, client } = service.options;
  if (store.list().some(record => record.request.vendor === 'DesignCo'
    && service.get(record.request.approvalRequestId).status === 'requested')) return;
  await runAgent({ intent: 'design tool', usage: { horizonMonths: 12 }, sources: [createCuratedSource()], ledger,
    approvalService: service, ctx: {
      balanceProvider: () => client.getBalances(), spentInWindowMinor: () => reconciledSpendInWindowMinor(service, 'USD'),
      now: service.now, knownObligations: [{ currency: 'USD', amountMinor: 10_000, dueInDays: 15 }], reserveHorizonDays: 30,
      reserveFloorMinor: { USD: 50_000 }, budgetCurrency: 'USD', windowBudgetMinor: 100_000,
      maxCommitmentMonths: 12, billingCountry: 'US', cardCountry: 'US',
    } });
}

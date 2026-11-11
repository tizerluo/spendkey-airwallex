import type { ApprovalRequest } from '@sk/policy';
import type { LedgerStore } from '@sk/ledger';

/** Synthetic policy evidence for state-machine tests. Security tests alter it explicitly. */
export function recordDecision(ledger: LedgerStore, request: ApprovalRequest): void {
  ledger.append({ kind: 'offers_snapshot', intent: 'synthetic design tool', offers: [{
    offerId: request.offerId, vendor: request.vendor, product: request.product, plan: request.plan, rail: request.rail,
    price: { amount: '60.00', currency: request.currency, unit: 'per_month' }, priceStatus: request.priceStatus, availability: 'available',
  }] }, request.createdAt);
  ledger.append({ kind: 'comparison', excluded: [], candidates: [{
    offerId: request.offerId, rail: request.rail, upfrontMinor: request.amountMinor, perChargeMinor: request.amountMinor,
    horizonLowMinor: request.amountMinor, horizonHighMinor: request.amountMinor, notes: [],
    terms: { vendor: request.vendor, product: request.product, plan: request.plan, currency: request.currency,
      amountMinor: request.amountMinor, interval: request.interval, allowedTransactionCount: request.allowedTransactionCount,
      commitmentMonths: request.commitmentMonths, priceStatus: request.priceStatus,
      ...(request.merchantCategoryCode === undefined ? {} : { merchantCategoryCode: request.merchantCategoryCode }),
    },
  }] }, request.createdAt);
  ledger.append({ kind: 'decision', action: 'ask', chosenOfferId: request.offerId, reasons: [], ruleResults: [] }, request.createdAt);
}

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { mapFailureReason, type IssuingTransaction } from '@sk/airwallex';
import { redactValue, signedDecimalToMinor, type LedgerStore } from '@sk/ledger';
import type { ApprovalService } from './service.js';
import { ServiceError } from './service.js';

export function monthWindow(now: Date): { from: string; to: string } {
  return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(), to: now.toISOString() };
}
const transactionSnapshot = z.object({
  cardId: z.string(), window: z.object({ from: z.string(), to: z.string() }),
  transactions: z.array(z.object({ id: z.string(), amount: z.string(), currency: z.string(),
    status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED']), at: z.string().optional() })),
});
type Snapshot = z.infer<typeof transactionSnapshot>;

/** Latest state per transaction, across overlapping polls and status changes. */
export function spentInWindowMinor(ledger: LedgerStore, currency: string, window: { from: string; to: string }): number {
  const latest = new Map<string, Snapshot['transactions'][number] & { window: Snapshot['window'] }>();
  const pending = new Map<string, Snapshot>();
  // Commit only snapshots followed by their reconciliation event, in chain order.
  for (const { event } of ledger.read()) {
    if (event.kind === 'raw_response' && event.endpoint === 'reconcile/transactions') {
      const parsed = transactionSnapshot.safeParse(event.body);
      if (parsed.success) pending.set(parsed.data.cardId, parsed.data);
    } else if (event.kind === 'reconciliation') {
      const snapshot = pending.get(event.cardId);
      if (!snapshot || snapshot.window.from !== event.window.from || snapshot.window.to !== event.window.to) continue;
      for (const transaction of snapshot.transactions) {
        latest.set(`${event.cardId}:${transaction.id}`, { ...transaction, window: snapshot.window });
      }
      pending.delete(event.cardId);
    }
  }
  let total = 0;
  for (const transaction of latest.values()) {
    if (transaction.currency !== currency || transaction.status === 'FAILED') continue;
    if (transaction.at === undefined) {
      if (transaction.window.from < window.from || transaction.window.to > window.to) throw new ServiceError('transaction_date_unknown');
    } else if (transaction.at < window.from || transaction.at > window.to) continue;
    total += signedDecimalToMinor(transaction.amount, currency);
    if (!Number.isSafeInteger(total)) throw new ServiceError('spend_overflow');
  }
  return Math.max(0, total);
}

/** Refresh every issued card before the policy reads the shared spending window. */
export async function reconciledSpendInWindowMinor(service: ApprovalService, currency: string, window = monthWindow(service.now())): Promise<number> {
  const loop = new TransactionLoop(service);
  const cardIds = new Set(service.options.store.list().filter(record => record.status === 'issued').map(record => record.card?.cardId));
  for (const cardId of cardIds) if (cardId !== undefined) await loop.reconcile(cardId, window);
  return spentInWindowMinor(service.options.ledger, currency, window);
}
export class TransactionLoop {
  constructor(readonly service: ApprovalService) {}
  #ownedCard(id: string, issuedOnly = false): void {
    const record = this.service.options.store.list().find(record => record.card?.cardId === id);
    if (!record) throw new ServiceError('card_not_found', 404);
    if (issuedOnly && record.status !== 'issued') throw new ServiceError('card_not_issued', 409);
  }
  async simulate(cardId: string, input: { amount: string; currency: string; mcc: string }) {
    this.#ownedCard(cardId, true);
    if (!/^[A-Z]{3}$/.test(input.currency) || !/^\d{4}$/.test(input.mcc)) throw new ServiceError('invalid_simulation');
    try { if (signedDecimalToMinor(input.amount, input.currency) <= 0) throw new Error(); }
    catch { throw new ServiceError('invalid_simulation'); }
    const result = await this.service.options.client.simulateAuthorization({ card_id: cardId,
      transaction_amount: input.amount, transaction_currency: input.currency, merchant_category_code: input.mcc,
    });
    const event = { kind: 'authorization' as const, source: 'simulated' as const, cardId, amount: input.amount,
      currency: input.currency, merchantCategoryCode: input.mcc,
      ...(result.process_result === undefined ? {} : { processResult: result.process_result }),
      ...(result.failure_reason == null ? {} : { failureReason: result.failure_reason }),
      mapped: result.process_result === 'APPROVED' && !result.failure_reason ? 'approved' as const : mapFailureReason(result.failure_reason),
      ...(result.card_transaction_id === undefined ? {} : { transactionId: result.card_transaction_id }),
    };
    this.service.options.ledger.append(event, this.service.now().toISOString());
    return { mapped: event.mapped };
  }
  async freeze(cardId: string, by: 'agent' | 'human', reason: string): Promise<void> {
    this.#ownedCard(cardId);
    await this.service.options.client.freezeCard(cardId);
    for (const record of this.service.options.store.list()) {
      if (record.card?.cardId === cardId) { record.card.status = 'INACTIVE'; this.service.options.store.save(record); }
    }
    this.service.options.ledger.append({ kind: 'card_frozen', cardId, by, reason }, this.service.now().toISOString());
  }
  async reconcile(cardId: string, window = monthWindow(this.service.now())) {
    this.#ownedCard(cardId, true);
    if (!z.string().datetime().safeParse(window.from).success || !z.string().datetime().safeParse(window.to).success
      || window.from > window.to) throw new ServiceError('invalid_window');
    const { client, ledger } = this.service.options;
    const transactions = new Map<string, IssuingTransaction>();
    let finished = false;
    for (let page = 0; page < 100; page++) {
      const result = await client.listTransactions({ card_id: cardId, from: window.from, to: window.to, page });
      if (result.unparsed.length > 0) {
        ledger.append({ kind: 'raw_response', ref: randomUUID(), endpoint: 'reconcile/unparsed', status: 200,
          body: redactValue(result.unparsed) }, this.service.now().toISOString());
        throw new ServiceError('reconciliation_unparsed_transactions');
      }
      for (const transaction of result.items) {
        if (transaction.card_id !== undefined && transaction.card_id !== cardId) throw new ServiceError('transaction_card_mismatch');
        transactions.set(transaction.transaction_id, transaction);
      }
      if (!result.has_more) { finished = true; break; }
    }
    if (!finished) throw new ServiceError('transaction_pagination_limit');
    const snapshot: Snapshot = { cardId, window, transactions: [] };
    let settledMinor = 0; let pendingMinor = 0; let failedCount = 0;
    for (const transaction of transactions.values()) {
      const { status } = transaction;
      if (status !== 'PENDING' && status !== 'SUCCEEDED' && status !== 'FAILED') throw new ServiceError('transaction_status_unknown');
      const amount = String(transaction.signedAmount);
      const minor = signedDecimalToMinor(amount, transaction.transaction_currency);
      if (status === 'FAILED') failedCount++;
      else {
        // No FX aggregation: the card contract permits one currency only.
        const record = this.service.options.store.list().find(record => record.card?.cardId === cardId)!;
        if (transaction.transaction_currency !== record.request.currency) throw new ServiceError('reconciliation_currency_mismatch');
        if (status === 'PENDING') pendingMinor += minor;
        else settledMinor += minor;
      }
      const at = transaction.transaction_date;
      if (at !== undefined && !z.string().datetime({ offset: true }).safeParse(at).success) throw new ServiceError('transaction_date_invalid');
      snapshot.transactions.push({ id: transaction.transaction_id, amount, currency: transaction.transaction_currency, status,
        ...(at === undefined ? {} : { at: new Date(at).toISOString() }),
      });
      this.observe(transaction, cardId);
    }
    if (!Number.isSafeInteger(settledMinor) || !Number.isSafeInteger(pendingMinor)) throw new ServiceError('spend_overflow');
    ledger.append({ kind: 'raw_response', ref: randomUUID(), endpoint: 'reconcile/transactions', status: 200,
      body: redactValue(snapshot) }, this.service.now().toISOString());
    const event = { kind: 'reconciliation' as const, cardId, window, settledMinor, pendingMinor, failedCount,
      transactionIds: [...transactions.keys()] };
    ledger.append(event, this.service.now().toISOString());
    return event;
  }
  /** Webhooks are notifications; polling remains the authority for spend snapshots. */
  observe(transaction: IssuingTransaction, fallbackCardId?: string): void {
    const cardId = transaction.card_id ?? fallbackCardId;
    if (!cardId) return;
    this.#ownedCard(cardId);
    const { ledger } = this.service.options;
    if (ledger.read().some(({ event }) => event.kind === 'authorization' && event.source === 'observed'
      && event.cardId === cardId && event.transactionId === transaction.transaction_id && event.processResult === transaction.status)) return;
    const merchant = transaction.merchant ?? transaction.merchant_info;
    ledger.append({ kind: 'authorization', source: 'observed', cardId, amount: String(transaction.signedAmount),
      currency: transaction.transaction_currency, transactionId: transaction.transaction_id,
      ...(transaction.status === undefined ? {} : { processResult: transaction.status }),
      ...(transaction.failure_reason == null ? {} : { failureReason: transaction.failure_reason }),
      ...(merchant?.category_code === undefined || !/^\d{4}$/.test(merchant.category_code) ? {} : { merchantCategoryCode: merchant.category_code }),
      ...(merchant?.name === undefined ? {} : { merchantName: merchant.name }),
      mapped: ['PENDING', 'SUCCEEDED'].includes(transaction.status ?? '') && !transaction.failure_reason
        ? 'approved' : mapFailureReason(transaction.failure_reason),
    }, this.service.now().toISOString());
  }
}

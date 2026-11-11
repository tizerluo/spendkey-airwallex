import type { ApprovalService } from '../server/service.js';
import { describeDemoFailure } from './preflight.js';
import { TransactionLoop } from '../server/transactions.js';

/** Lookup uncertain attempts too; cleanup never issues a new card. */
export async function cleanupDemoCards(service: ApprovalService, log: (line: string) => void): Promise<void> {
  const loop = new TransactionLoop(service);
  let failed = false;
  for (const record of service.options.store.list()) {
    try {
      let cardId = record.card?.cardId;
      if (!cardId && record.attempted && record.input) {
        let found;
        try { found = await service.options.client.findCardByRequestId(record.input.request_id, { cardholderId: record.input.cardholder_id }); }
        catch (error) { service.providerFailure(error, '/api/v1/issuing/cards', 'cleanup lookup'); }
        if (found) {
          cardId = found.card_id; record.card = { cardId }; service.options.store.save(record);
        }
      }
      if (!cardId) continue;
      let card;
      try { card = await service.options.client.getCard(cardId); }
      catch (error) { service.providerFailure(error, `/api/v1/issuing/cards/${cardId}`, 'cleanup readback'); }
      if (card.card_status !== 'INACTIVE') {
        await loop.freeze(cardId, 'human', 'demo-operator: cleanup');
        log('Demo operator froze the card: INACTIVE.');
      } else {
        record.card = { ...record.card, cardId, status: 'INACTIVE' }; service.options.store.save(record);
        log('Demo card already INACTIVE.');
      }
    } catch (error) { failed = true; log(`Demo card cleanup failed; ${describeDemoFailure(error, 'cleanup')}; retry cleanup.`); }
  }
  if (failed) throw new Error('demo_cleanup_failed');
}

export interface SignalHost {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  exit(code: number): unknown;
}
export function installDemoSignalHandlers(service: ApprovalService, log: (line: string) => void,
  host: SignalHost = process, close: () => void = () => {}): () => void {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void service.waitForIssuance().then(() => cleanupDemoCards(service, log)).catch(() => {}).finally(() => { try { close(); } finally { host.exit(1); } });
  };
  host.on('SIGINT', stop); host.on('SIGTERM', stop);
  return () => { host.removeListener('SIGINT', stop); host.removeListener('SIGTERM', stop); };
}

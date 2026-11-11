import { describe, expect, it } from 'vitest';
import { CardAuditEventSchema, openInMemoryLedger, verifyChain, verifyJsonl } from './index.js';

const at = '2030-01-01T00:00:00.000Z';
const price = { amount: '0.000001', currency: 'USD', unit: 'per_call' as const };
const snapshot = { kind: 'offers_snapshot' as const, intent: 'synthetic api', offers: [{
  offerId: 'offer_test_micro', vendor: 'Synthetic Vendor', product: 'Synthetic API', plan: 'usage' as const, rail: 'x402' as const,
  price, priceStatus: 'price_unverified' as const, availability: 'available' as const,
}] };
const comparison = { kind: 'comparison' as const, candidates: [{
  offerId: 'offer_test_micro', rail: 'x402' as const, price,
  upfrontMinor: 0, perChargeMinor: 1, horizonLowMinor: 1, horizonHighMinor: 1, notes: [],
}], excluded: [] };

describe('native offer prices', () => {
  it('round trips micro prices without rounding through snapshots, comparisons, and JSONL verification', () => {
    const ledger = openInMemoryLedger();
    expect(ledger.append(snapshot, at).event).toEqual(snapshot);
    expect(ledger.append(comparison, at).event).toEqual(comparison);
    const records = ledger.read();
    expect(verifyChain(records)).toEqual({ ok: true });
    expect(verifyJsonl(records.map(record => JSON.stringify(record)).join('\n') + '\n').ok).toBe(true);
    // Older comparisons without a native price remain valid; the derived totals stay integer minor units.
    const { price: omitted, ...legacy } = comparison.candidates[0]!;
    expect(omitted).toEqual(price);
    expect(CardAuditEventSchema.safeParse({ ...comparison, candidates: [legacy] }).success).toBe(true);
    expect(CardAuditEventSchema.safeParse({ ...comparison, candidates: [{ ...legacy, perChargeMinor: 0.000001 }] }).success).toBe(false);
  });

  it.each(['0.0000001', '-0.000001', '1e-6', '0.0000010', '+1', ' 1', '01.0'])(
    'rejects invalid native prices in both event kinds: %s', amount => {
      const invalid = { ...price, amount };
      expect(CardAuditEventSchema.safeParse({ ...snapshot, offers: [{ ...snapshot.offers[0], price: invalid }] }).success).toBe(false);
      expect(CardAuditEventSchema.safeParse({ ...comparison, candidates: [{ ...comparison.candidates[0], price: invalid }] }).success).toBe(false);
    },
  );

  it('keeps authorization precision tied to the card currency exponent', () => {
    const authorization = { kind: 'authorization', source: 'observed', cardId: 'card_test_01', mapped: 'approved' };
    expect(CardAuditEventSchema.safeParse({ ...authorization, amount: '-0.000001', currency: 'USD' }).success).toBe(false);
    expect(CardAuditEventSchema.safeParse({ ...authorization, amount: '-12.50', currency: 'JPY' }).success).toBe(false);
    expect(CardAuditEventSchema.safeParse({ ...authorization, amount: '-1.234', currency: 'KWD' }).success).toBe(true);
  });
});

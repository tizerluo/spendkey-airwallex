import type { AuditRecord } from '@sr/schema';

/**
 * `Omit` that distributes over a union, so discriminated-union records keep
 * their `kind`-specific fields instead of collapsing to the shared keys.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A record as supplied by a caller: the log computes `prevHash` and `hash`. */
export type AuditRecordInput = DistributiveOmit<AuditRecord, 'hash' | 'prevHash'>;

/** A record that still needs its `hash`: everything except `hash`. */
export type HashableAuditRecord = DistributiveOmit<AuditRecord, 'hash'>;

/** Decision-bearing audit kinds (receipts carry a receipt and no decision). */
export type DecisionAuditRecord = Extract<AuditRecord, { kind: 'plan' | 'guard' | 'approval' }>;

/** Caller-supplied decision record; the log fills in the hash chain. */
export type DecisionAuditRecordInput = DistributiveOmit<DecisionAuditRecord, 'hash' | 'prevHash'>;

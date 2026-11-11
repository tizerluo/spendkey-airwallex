import { AuditRecordSchema, type AuditRecord, type Hash } from '@sr/schema';
import { GENESIS_PREV_HASH, auditRecordHash } from './canonical.js';
import { importJsonl, toJsonl, verifyChain } from './chain.js';
import { InMemoryAuditStore, copyAuditRecord, type AuditStore } from './store.js';
import type { AuditRecordInput, DecisionAuditRecordInput } from './types.js';

/**
 * Append-only audit log.
 *
 * Every {@link AuditLog.append} call links the new record to the log tail via
 * `prevHash` and computes `hash = sha256(canonical JSON without hash)`. Records
 * are validated against the frozen `@sr/schema` {@link AuditRecordSchema}
 * before they are stored, so the log only ever holds schema-valid records.
 */
export class AuditLog {
  readonly #store: AuditStore;

  constructor(store: AuditStore = new InMemoryAuditStore()) {
    this.#store = store;
    const existing = store.read();
    if (existing.length > 0) {
      const verification = verifyChain(existing);
      if (!verification.ok) {
        throw new Error(
          `audit log: existing store has a broken chain at index ${verification.firstBadIndex ?? 0}`,
        );
      }
    }
  }

  /** Records in append order (a defensive copy). */
  get records(): readonly AuditRecord[] {
    return this.#store.read();
  }

  /** Number of stored records. */
  get size(): number {
    return this.records.length;
  }

  /** Hash of the last record, or the genesis hash when the log is empty. */
  get lastHash(): Hash {
    const records = this.#store.read();
    const last = records[records.length - 1];
    return last === undefined ? GENESIS_PREV_HASH : last.hash;
  }

  /**
   * Append one record, chaining and hashing it. Throws on duplicate
   * `(budgetKey, seq)`. The returned record is an isolated copy: mutating it
   * (even nested fields) never rewrites stored history.
   */
  append(input: AuditRecordInput): AuditRecord {
    const prevHash = this.lastHash;
    const candidate = { ...input, prevHash };
    const hash = auditRecordHash(candidate);
    const record = AuditRecordSchema.parse({ ...candidate, hash });
    this.#store.append(record);
    return copyAuditRecord(record);
  }

  /**
   * Record a refused decision. `savedAmountAtomic` is the atomic amount the
   * refusal kept from being spent, and must be carried on the record.
   */
  appendRefusal(input: DecisionAuditRecordInput): AuditRecord {
    if (input.decision.action !== 'refuse') {
      throw new Error('appendRefusal requires a decision with action "refuse"');
    }
    return this.append(input);
  }

  /** Serialize the whole log as JSONL. */
  exportJsonl(): string {
    return toJsonl(this.records);
  }

  /**
   * Rebuild a log from JSONL, verifying the whole incoming chain (hash linkage
   * and `(budgetKey, seq)` uniqueness) before touching the destination.
   *
   * This is a rebuild operation, not a merge: the destination must be empty.
   * A nonempty destination is rejected up front — before any append — so a
   * rejected import leaves the existing store byte-for-byte unchanged and
   * chain-valid. (Validating only after appending could corrupt a populated
   * store when the combined chain turns out to be broken.)
   */
  static fromJsonl(text: string, store: AuditStore = new InMemoryAuditStore()): AuditLog {
    const records = importJsonl(text);
    const existing = store.read();
    if (existing.length > 0) {
      throw new Error(
        `audit log: import requires an empty destination store (found ${existing.length} record(s))`,
      );
    }
    for (const record of records) {
      store.append(record);
    }
    return new AuditLog(store);
  }
}

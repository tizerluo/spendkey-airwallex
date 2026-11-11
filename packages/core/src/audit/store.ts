import type { AuditRecord } from '@sr/schema';

/** Uniqueness key for the schema-level `(budgetKey, seq)` constraint. */
export function budgetSeqKey(record: Pick<AuditRecord, 'budgetKey' | 'seq'>): string {
  return `${record.budgetKey}#${record.seq}`;
}

/** Recursively freeze `value` and every nested object/array it holds. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * A defensive deep copy of a record that shares no mutable state with the
 * source. Used at store egress so callers can never rewrite stored history.
 */
export function copyAuditRecord(record: AuditRecord): AuditRecord {
  return structuredClone(record);
}

/**
 * Append-only storage behind {@link AuditLog}. Implementations must reject a
 * duplicate `(budgetKey, seq)` and must never rewrite a stored record. They
 * must also isolate records at ingress and egress: a snapshot handed out by
 * {@link AuditStore.read} and any object passed to {@link AuditStore.append}
 * must not alias (top-level or nested) any record the store retains, so caller
 * mutations can neither rewrite committed history nor desynchronize the
 * uniqueness index.
 */
export interface AuditStore {
  /** Snapshot of stored records in append order. Mutating it must not affect the store. */
  read(): readonly AuditRecord[];
  /** Durably append one fully-hashed record; throws on a duplicate `(budgetKey, seq)`. */
  append(record: AuditRecord): void;
}

/** Process-local {@link AuditStore} used by tests and the offline CLI. */
export class InMemoryAuditStore implements AuditStore {
  #records: AuditRecord[] = [];
  readonly #keys = new Set<string>();

  read(): readonly AuditRecord[] {
    // Deep copies: mutating a snapshot (top-level or nested) cannot touch the
    // stored records, and the array itself is a fresh copy.
    return this.#records.map((record) => copyAuditRecord(record));
  }

  append(record: AuditRecord): void {
    const key = budgetSeqKey(record);
    if (this.#keys.has(key)) {
      throw new Error(`audit store: duplicate (budgetKey, seq) ${key}`);
    }
    // Store an isolated, deep-frozen snapshot so later caller mutations of the
    // original object cannot rewrite history or desync the uniqueness index.
    const stored = deepFreeze(copyAuditRecord(record));
    this.#keys.add(key);
    this.#records.push(stored);
  }
}

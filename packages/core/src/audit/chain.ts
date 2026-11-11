import { AuditRecordSchema, type AuditRecord } from '@sr/schema';
import { GENESIS_PREV_HASH, auditRecordHash } from './canonical.js';
import { budgetSeqKey } from './store.js';

/** Result of walking an audit chain. `firstBadIndex` indexes the first bad record. */
export interface ChainVerification {
  readonly ok: boolean;
  readonly firstBadIndex?: number;
}

function hashEquals(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Verify an append-ordered audit chain: each record must be schema-valid, its
 * `prevHash` must equal the previous record's `hash` (genesis for the first
 * record), and its `hash` must match a fresh recomputation. Any tampering,
 * reordering, deletion or insertion is reported at its first offending index.
 * An empty chain and a single-record chain are valid.
 */
export function verifyChain(records: readonly AuditRecord[]): ChainVerification {
  let prevHash = GENESIS_PREV_HASH;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined) return { ok: false, firstBadIndex: index };
    const parsed = AuditRecordSchema.safeParse(record);
    if (!parsed.success) return { ok: false, firstBadIndex: index };
    if (!hashEquals(record.prevHash, prevHash)) return { ok: false, firstBadIndex: index };
    const expected = auditRecordHash(record);
    if (!hashEquals(record.hash, expected)) return { ok: false, firstBadIndex: index };
    prevHash = record.hash;
  }
  return { ok: true };
}

/** Enforce the `(budgetKey, seq)` uniqueness invariant across a record set. */
export function assertUniqueBudgetSeq(records: readonly AuditRecord[]): void {
  const seen = new Set<string>();
  for (const record of records) {
    const key = budgetSeqKey(record);
    if (seen.has(key)) throw new Error(`audit records: duplicate (budgetKey, seq) ${key}`);
    seen.add(key);
  }
}

/** Serialize records as JSONL (one compact JSON object per line, trailing newline). */
export function toJsonl(records: readonly AuditRecord[]): string {
  if (records.length === 0) return '';
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

/** Parse JSONL into schema-valid records. Blank lines are ignored; the chain is not checked. */
export function parseJsonl(text: string): AuditRecord[] {
  const records: AuditRecord[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`audit JSONL line ${index + 1}: invalid JSON`);
    }
    const result = AuditRecordSchema.safeParse(parsed);
    if (!result.success) throw new Error(`audit JSONL line ${index + 1}: record failed schema validation`);
    records.push(result.data);
  }
  return records;
}

/**
 * Import JSONL with the same integrity checks as the store: parse, verify the
 * hash chain and reject duplicate `(budgetKey, seq)` entries.
 */
export function importJsonl(text: string): AuditRecord[] {
  const records = parseJsonl(text);
  const verification = verifyChain(records);
  if (!verification.ok) {
    throw new Error(`audit JSONL: broken chain at index ${verification.firstBadIndex ?? 0}`);
  }
  assertUniqueBudgetSeq(records);
  return records;
}

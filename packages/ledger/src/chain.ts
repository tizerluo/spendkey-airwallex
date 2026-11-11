import { canonicalize, sha256Hex, ZERO_HASH } from '@sr/core';
import { CardAuditEventSchema, LedgerEventSchema } from './events.js';
import type { CardAuditEvent, LedgerEvent } from './events.js';
import { assertRedacted } from './redaction.js';

export interface ChainVerification { ok: boolean; brokenAt?: number; error?: string }

function hashRecord(record: Omit<LedgerEvent, 'hash'>): string {
  return `0x${sha256Hex(canonicalize(record))}`;
}

/** Zero-based sequence and brokenAt index. Does not mutate the input chain. */
export function verifyChain(events: readonly unknown[]): ChainVerification {
  let prevHash = ZERO_HASH;
  for (let index = 0; index < events.length; index += 1) {
    const input = events[index];
    const parsed = LedgerEventSchema.safeParse(input);
    if (!parsed.success) return { ok: false, brokenAt: index, error: 'invalid_ledger_event' };
    const record = parsed.data;
    try { assertRedacted(record.event); }
    catch { return { ok: false, brokenAt: index, error: 'unsafe_ledger_event' }; }
    if (record.seq !== index) return { ok: false, brokenAt: index, error: 'invalid_sequence' };
    if (record.prevHash !== prevHash) return { ok: false, brokenAt: index, error: 'previous_hash_mismatch' };
    const { hash, ...payload } = record;
    if (hash !== hashRecord(payload as Omit<LedgerEvent, 'hash'>)) {
      return { ok: false, brokenAt: index, error: 'hash_mismatch' };
    }
    prevHash = hash;
  }
  return { ok: true };
}

export function assertValidChain(events: readonly unknown[]): void {
  const result = verifyChain(events);
  if (!result.ok) throw new Error(`ledger_broken_at_${result.brokenAt ?? 0}: ${result.error ?? 'invalid_chain'}`);
}

/** Build a detached record after validating both history and the new event. */
export function appendEvent(events: readonly LedgerEvent[], event: CardAuditEvent, at = new Date().toISOString()): LedgerEvent {
  assertValidChain(events);
  // Check before parsing so an unknown secret-bearing property cannot be stripped.
  assertRedacted(event);
  if (!CardAuditEventSchema.safeParse(event).success) throw new Error('invalid_card_audit_event');
  const snapshot = JSON.parse(JSON.stringify(event)) as CardAuditEvent;
  if (!CardAuditEventSchema.safeParse(snapshot).success) throw new Error('invalid_card_audit_event');
  const payload = { seq: events.length, at, prevHash: events.at(-1)?.hash ?? ZERO_HASH, event: snapshot };
  const record = { ...payload, hash: hashRecord(payload) };
  if (!LedgerEventSchema.safeParse(record).success) throw new Error('invalid_ledger_event');
  return record;
}

/** Strict JSONL: no empty records or partial final line, even after a crash. */
export function parseJsonl(text: string): LedgerEvent[] {
  if (text === '') return [];
  if (!text.endsWith('\n')) throw new Error('ledger_incomplete_final_line');
  const records: unknown[] = [];
  for (const [index, line] of text.slice(0, -1).split('\n').entries()) {
    try { records.push(JSON.parse(line) as unknown); }
    catch { throw new Error(`ledger_invalid_json_at_${index}`); }
  }
  assertValidChain(records);
  return records as LedgerEvent[];
}

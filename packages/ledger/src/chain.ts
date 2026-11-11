import { canonicalize, sha256Hex, ZERO_HASH } from '@sr/core';
import { CardAuditEventSchema, LedgerEventSchema } from './events.js';
import type { CardAuditEvent, LedgerEvent } from './events.js';
import { assertRedacted, redactValue } from './redaction.js';

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
  // Sanitize only the tolerant payloads; preserve all other properties so the
  // final guard can catch unknown secret-bearing fields before schema parsing.
  event = event.kind === 'raw_response' ? { ...event, body: redactValue(event.body) }
    : event.kind === 'card_issued' ? { ...event, controls: redactValue(event.controls) } : event;
  assertRedacted(event);
  if (!CardAuditEventSchema.safeParse(event).success) throw new Error('invalid_card_audit_event');
  const snapshot = JSON.parse(JSON.stringify(event)) as CardAuditEvent;
  if (!CardAuditEventSchema.safeParse(snapshot).success) throw new Error('invalid_card_audit_event');
  const payload = { seq: events.length, at, prevHash: events.at(-1)?.hash ?? ZERO_HASH, event: snapshot };
  const record = { ...payload, hash: hashRecord(payload) };
  if (!LedgerEventSchema.safeParse(record).success) throw new Error('invalid_ledger_event');
  return record;
}

export interface JsonlVerification extends ChainVerification { head?: { seq: number; hash: string } }
export interface VerificationOptions { expectHead?: string; expectSeq?: number }

/** Read-only diagnostics, including the zero-based index of a partial tail. */
export function verifyJsonl(text: string, options: VerificationOptions = {}): JsonlVerification {
  const decoded = decodeJsonl(text);
  if (!decoded.ok) return decoded;
  const result = verifyChain(decoded.records);
  if (!result.ok) return result;
  const last = decoded.records.at(-1) as LedgerEvent | undefined;
  const head = { seq: last?.seq ?? -1, hash: last?.hash ?? ZERO_HASH };
  if (options.expectHead !== undefined && options.expectHead !== head.hash) {
    return { ok: false, error: 'head_mismatch', brokenAt: decoded.records.length, head };
  }
  if (options.expectSeq !== undefined && options.expectSeq !== head.seq) {
    return { ok: false, error: 'head_sequence_mismatch', brokenAt: decoded.records.length, head };
  }
  return { ok: true, head };
}

function decodeJsonl(text: string): { ok: true; records: unknown[] } | { ok: false; error: string; brokenAt: number } {
  if (text === '') return { ok: true, records: [] };
  if (!text.endsWith('\n')) return { ok: false, error: 'incomplete_final_line', brokenAt: text.split('\n').length - 1 };
  const records: unknown[] = [];
  for (const [index, line] of text.slice(0, -1).split('\n').entries()) {
    try { records.push(JSON.parse(line) as unknown); }
    catch { return { ok: false, error: 'invalid_json', brokenAt: index }; }
  }
  return { ok: true, records };
}

/** Strict JSONL: no empty records or partial final line, even after a crash. */
export function parseJsonl(text: string): LedgerEvent[] {
  const decoded = decodeJsonl(text);
  if (!decoded.ok) {
    if (decoded.error === 'incomplete_final_line') throw new Error('ledger_incomplete_final_line');
    throw new Error(`ledger_invalid_json_at_${decoded.brokenAt}`);
  }
  assertValidChain(decoded.records);
  return decoded.records as LedgerEvent[];
}

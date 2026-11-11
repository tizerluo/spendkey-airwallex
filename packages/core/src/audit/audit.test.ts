import { createHash } from 'node:crypto';
import { AuditRecordSchema, type AuditRecord, type Decider } from '@sr/schema';
import { describe, expect, it } from 'vitest';
import {
  AuditLog,
  GENESIS_PREV_HASH,
  InMemoryAuditStore,
  ZERO_HASH,
  auditRecordHash,
  canonicalize,
  importJsonl,
  parseJsonl,
  toJsonl,
  verifyChain,
} from './index.js';
import type { AuditRecordInput, DecisionAuditRecordInput } from './index.js';

const PAYER = '0x1111111111111111111111111111111111111111';
const PAYER_2 = '0x2222222222222222222222222222222222222222';
const TX = `0x${'a'.repeat(64)}`;
const STATE_HASH = `0x${'d'.repeat(64)}`;

function probs(): Record<string, number> {
  return { pay: 0.8, refuse: 0.1, ask: 0.1 };
}

function decider(): Decider {
  return { provider: 'rules', model: 'rules-v1', transport: 'rules', probs: probs(), fallback: true };
}

function planInput(id: string, seq: number, budgetKey = 'budget-1'): AuditRecordInput {
  return {
    id,
    planId: `plan-${id}`,
    budgetKey,
    seq,
    payer: PAYER,
    timestamp: '2026-10-12T12:00:00Z',
    stateHash: STATE_HASH,
    kind: 'plan',
    decision: { action: 'pay', reasons: ['budget-ok'], probs: probs() },
    decider: decider(),
    rules: ['budget-ok'],
    savedAmountAtomic: '0',
  };
}

function receiptInput(id: string, seq: number, budgetKey = 'budget-1'): AuditRecordInput {
  return {
    id,
    planId: `plan-${id}`,
    budgetKey,
    seq,
    payer: PAYER,
    timestamp: '2026-10-12T12:00:00Z',
    kind: 'receipt',
    receipt: { planId: `plan-${id}`, tx: TX, network: 'eip155:42220' },
  };
}

function refusalInput(id: string, seq: number, budgetKey = 'budget-1'): DecisionAuditRecordInput {
  return {
    id,
    planId: `plan-${id}`,
    budgetKey,
    seq,
    payer: PAYER,
    timestamp: '2026-10-12T12:00:00Z',
    kind: 'guard',
    decision: { action: 'refuse', reasons: ['over-budget'], probs: probs() },
    decider: decider(),
    rules: ['over-budget'],
    savedAmountAtomic: '5000',
  };
}

function cloneRecord(record: AuditRecord): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

describe('canonicalize', () => {
  it('sorts object keys recursively and drops undefined', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ a: [{ y: 1, x: 2 }] })).toBe('{"a":[{"x":2,"y":1}]}');
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('omits the requested top-level keys only', () => {
    expect(canonicalize({ a: 1, hash: 2, nested: { hash: 3 } }, ['hash'])).toBe(
      '{"a":1,"nested":{"hash":3}}',
    );
  });
});

describe('AuditLog hashing', () => {
  it('hashes sha256 over the canonical record without its hash field', () => {
    const record = new AuditLog().append(planInput('r0', 0));
    const expected = `0x${createHash('sha256').update(canonicalize(record, ['hash']), 'utf8').digest('hex')}`;
    expect(record.hash).toBe(expected);
    expect(auditRecordHash(record)).toBe(expected);
    expect(AuditRecordSchema.safeParse(record).success).toBe(true);
  });

  it('is insensitive to input key insertion order', () => {
    const ordered = new AuditLog().append(planInput('r0', 0));
    const reordered = new AuditLog().append({
      savedAmountAtomic: '0',
      rules: ['budget-ok'],
      decider: decider(),
      decision: { probs: probs(), reasons: ['budget-ok'], action: 'pay' },
      stateHash: STATE_HASH,
      kind: 'plan',
      timestamp: '2026-10-12T12:00:00Z',
      payer: PAYER,
      seq: 0,
      budgetKey: 'budget-1',
      planId: 'plan-r0',
      id: 'r0',
    });
    expect(reordered.hash).toBe(ordered.hash);
  });
});

describe('verifyChain', () => {
  it('accepts empty and single-record chains', () => {
    expect(verifyChain([])).toEqual({ ok: true });
    const one = new AuditLog().append(planInput('r0', 0));
    expect(verifyChain([one])).toEqual({ ok: true });
  });

  it('links each record to the previous hash and starts at genesis', () => {
    const log = new AuditLog();
    const r0 = log.append(planInput('r0', 0));
    const r1 = log.append(receiptInput('r1', 1));
    const r2 = log.append(planInput('r2', 2));
    expect(r0.prevHash).toBe(GENESIS_PREV_HASH);
    expect(r0.prevHash).toBe(ZERO_HASH);
    expect(r1.prevHash).toBe(r0.hash);
    expect(r2.prevHash).toBe(r1.hash);
    expect(log.size).toBe(3);
    expect(verifyChain(log.records)).toEqual({ ok: true });
  });

  it('detects tampering of any field', () => {
    const base = new AuditLog().append(planInput('r0', 0));
    const cases: Array<{ name: string; mutate: (record: Record<string, unknown>) => void }> = [
      { name: 'id', mutate: (r) => { r.id = 'other'; } },
      { name: 'planId', mutate: (r) => { r.planId = 'other'; } },
      { name: 'budgetKey', mutate: (r) => { r.budgetKey = 'other'; } },
      { name: 'seq', mutate: (r) => { r.seq = 9; } },
      { name: 'payer', mutate: (r) => { r.payer = PAYER_2; } },
      { name: 'timestamp', mutate: (r) => { r.timestamp = '2026-10-12T13:00:00Z'; } },
      { name: 'stateHash', mutate: (r) => { r.stateHash = `0x${'e'.repeat(64)}`; } },
      { name: 'decision', mutate: (r) => { (r.decision as Record<string, unknown>).action = 'refuse'; } },
      { name: 'decider', mutate: (r) => { (r.decider as Record<string, unknown>).model = 'tampered'; } },
      { name: 'rules', mutate: (r) => { r.rules = ['tampered']; } },
      { name: 'savedAmountAtomic', mutate: (r) => { r.savedAmountAtomic = '1'; } },
      { name: 'hash', mutate: (r) => { r.hash = `0x${'b'.repeat(64)}`; } },
      { name: 'prevHash', mutate: (r) => { r.prevHash = `0x${'c'.repeat(64)}`; } },
    ];
    for (const { name, mutate } of cases) {
      const copy = cloneRecord(base);
      mutate(copy);
      const result = verifyChain([copy as unknown as AuditRecord]);
      expect(result.ok, `expected ${name} to be detected`).toBe(false);
      expect(result.firstBadIndex, `expected ${name} at index 0`).toBe(0);
    }
  });

  it('detects reordering', () => {
    const log = new AuditLog();
    const r0 = log.append(planInput('r0', 0));
    const r1 = log.append(planInput('r1', 1));
    const r2 = log.append(planInput('r2', 2));
    const result = verifyChain([r0, r2, r1]);
    expect(result.ok).toBe(false);
    expect(result.firstBadIndex).toBe(1);
  });

  it('detects a removed middle record', () => {
    const log = new AuditLog();
    const r0 = log.append(planInput('r0', 0));
    log.append(planInput('r1', 1));
    const r2 = log.append(planInput('r2', 2));
    const result = verifyChain([r0, r2]);
    expect(result.ok).toBe(false);
    expect(result.firstBadIndex).toBe(1);
  });

  it('rejects schema-invalid records without throwing', () => {
    const invalid = { ...cloneRecord(new AuditLog().append(planInput('r0', 0))), seq: -1 };
    const result = verifyChain([invalid as unknown as AuditRecord]);
    expect(result.ok).toBe(false);
    expect(result.firstBadIndex).toBe(0);
  });
});

describe('AuditLog store invariants', () => {
  it('rejects duplicate (budgetKey, seq) but allows a new budget key', () => {
    const log = new AuditLog();
    log.append(planInput('r0', 0));
    expect(() => log.append(planInput('r1', 0))).toThrow(/duplicate \(budgetKey, seq\)/);
    expect(() => log.append(planInput('r2', 0, 'budget-2'))).not.toThrow();
    expect(log.size).toBe(2);
  });

  it('keeps stored records immutable from the outside', () => {
    const log = new AuditLog();
    const before = log.records as AuditRecord[];
    log.append(planInput('r0', 0));
    expect(before).toHaveLength(0);
    const snapshot = log.records as AuditRecord[];
    snapshot.length = 0;
    expect(log.records).toHaveLength(1);
  });

  it('refuses to open a log over a broken chain', () => {
    const good = new AuditLog().append(planInput('r0', 0));
    const broken = cloneRecord(good);
    broken.savedAmountAtomic = '9';
    const tamperedStore = new InMemoryAuditStore();
    tamperedStore.append(broken as unknown as AuditRecord);
    expect(() => new AuditLog(tamperedStore)).toThrow(/broken chain/);
  });

  it('records refused decisions with savedAmountAtomic', () => {
    const log = new AuditLog();
    const record = log.appendRefusal(refusalInput('r0', 0)) as Extract<AuditRecord, { kind: 'guard' }>;
    expect(record.kind).toBe('guard');
    expect(record.decision.action).toBe('refuse');
    expect(record.savedAmountAtomic).toBe('5000');
    expect(verifyChain(log.records).ok).toBe(true);
  });

  it('rejects appendRefusal for non-refuse decisions', () => {
    const payAsGuard: DecisionAuditRecordInput = {
      id: 'r0',
      planId: 'plan-r0',
      budgetKey: 'budget-1',
      seq: 0,
      payer: PAYER,
      timestamp: '2026-10-12T12:00:00Z',
      kind: 'guard',
      decision: { action: 'pay', reasons: ['budget-ok'], probs: probs() },
      decider: decider(),
      rules: ['budget-ok'],
      savedAmountAtomic: '0',
    };
    expect(() => new AuditLog().appendRefusal(payAsGuard)).toThrow(/refuse/);
  });
});

describe('AuditStore isolation', () => {
  it('isolates the AuditLog.append return value from stored history', () => {
    const log = new AuditLog();
    const returned = log.append(planInput('r0', 0)) as Extract<AuditRecord, { kind: 'plan' }>;
    returned.decision.reasons.push('edited-after-append');
    returned.decision.probs.pay = 0.2;
    returned.savedAmountAtomic = '12345';

    const stored = log.records[0] as Extract<AuditRecord, { kind: 'plan' }>;
    expect(stored.decision.reasons).toEqual(['budget-ok']);
    expect(stored.decision.probs.pay).toBe(0.8);
    expect(stored.savedAmountAtomic).toBe('0');
    expect(returned).not.toBe(stored);
    expect(verifyChain(log.records)).toEqual({ ok: true });
  });

  it('isolates log.records snapshots from stored history', () => {
    const log = new AuditLog();
    log.append(planInput('r0', 0));
    const snapshot = log.records as AuditRecord[];
    const first = snapshot[0] as Extract<AuditRecord, { kind: 'plan' }>;
    first.savedAmountAtomic = '12345';
    first.decision.reasons.push('tampered');
    first.decision.probs.pay = 0.2;
    snapshot.length = 0;

    const stored = log.records[0] as Extract<AuditRecord, { kind: 'plan' }>;
    expect(stored.savedAmountAtomic).toBe('0');
    expect(stored.decision.reasons).toEqual(['budget-ok']);
    expect(stored.decision.probs.pay).toBe(0.8);
    expect(log.records).toHaveLength(1);
    expect(verifyChain(log.records)).toEqual({ ok: true });
  });

  it('isolates records passed straight to the store', () => {
    const store = new InMemoryAuditStore();
    const record = new AuditLog().append(planInput('r0', 0)) as Extract<AuditRecord, { kind: 'plan' }>;
    store.append(record);
    record.decision.reasons.push('edited-in-place');
    record.decision.probs.pay = 0.2;
    record.savedAmountAtomic = '9';

    const stored = store.read()[0] as Extract<AuditRecord, { kind: 'plan' }>;
    expect(stored.decision.reasons).toEqual(['budget-ok']);
    expect(stored.decision.probs.pay).toBe(0.8);
    expect(stored.savedAmountAtomic).toBe('0');
    expect(verifyChain(store.read())).toEqual({ ok: true });
  });

  it('keeps the (budgetKey, seq) index in sync when an exposed snapshot is edited', () => {
    const log = new AuditLog();
    log.append(planInput('one', 0, 'original-key'));
    const exposed = log.records[0] as Extract<AuditRecord, { kind: 'plan' }> & { hash: string };
    exposed.budgetKey = 'changed-key';
    exposed.hash = auditRecordHash(exposed);

    expect(log.records[0]?.budgetKey).toBe('original-key');
    // A different key is a distinct slot, and the original slot is still taken.
    expect(() => log.append(planInput('two', 0, 'changed-key'))).not.toThrow();
    expect(() => log.append(planInput('three', 0, 'original-key'))).toThrow(
      /duplicate \(budgetKey, seq\)/,
    );
    expect(verifyChain(log.records)).toEqual({ ok: true });
  });
});

describe('JSONL export and import', () => {
  it('round-trips a chain', () => {
    const log = new AuditLog();
    log.append(planInput('r0', 0));
    log.append(receiptInput('r1', 1));
    log.append(planInput('r2', 2));
    const jsonl = log.exportJsonl();
    expect(jsonl.endsWith('\n')).toBe(true);
    expect(parseJsonl(jsonl)).toEqual(log.records);
    expect(importJsonl(jsonl)).toEqual(log.records);
    expect(AuditLog.fromJsonl(jsonl).records).toEqual(log.records);
  });

  it('serializes an empty log as empty text', () => {
    expect(new AuditLog().exportJsonl()).toBe('');
    expect(parseJsonl('')).toEqual([]);
    expect(parseJsonl('\n\n')).toEqual([]);
  });

  it('imports into an empty destination store', () => {
    const source = new AuditLog();
    source.append(planInput('r0', 0));
    source.append(receiptInput('r1', 1));
    const text = source.exportJsonl();

    const rebuilt = AuditLog.fromJsonl(text, new InMemoryAuditStore());
    expect(rebuilt.records).toEqual(source.records);
    expect(rebuilt.size).toBe(2);
  });

  it('rejects import into a nonempty destination without mutating it', () => {
    const store = new InMemoryAuditStore();
    const existing = new AuditLog(store);
    existing.append(planInput('existing', 0, 'existing-budget'));
    const before = existing.exportJsonl();

    const incoming = new AuditLog();
    incoming.append(planInput('imported', 0, 'imported-budget'));

    expect(() => AuditLog.fromJsonl(incoming.exportJsonl(), store)).toThrow(/empty destination/);
    expect(existing.exportJsonl()).toBe(before);
    expect(existing.size).toBe(1);
    expect(verifyChain(store.read())).toEqual({ ok: true });
  });

  it('detects a tampered JSONL line', () => {
    const log = new AuditLog();
    log.append(planInput('r0', 0));
    log.append(planInput('r1', 1));
    const lines = log.exportJsonl().trimEnd().split('\n');
    const second = JSON.parse(lines[1] ?? '{}') as Record<string, unknown>;
    second.savedAmountAtomic = '4321';
    lines[1] = JSON.stringify(second);
    const text = `${lines.join('\n')}\n`;
    const result = verifyChain(parseJsonl(text));
    expect(result.ok).toBe(false);
    expect(result.firstBadIndex).toBe(1);
    expect(() => importJsonl(text)).toThrow(/broken chain at index 1/);
    expect(() => AuditLog.fromJsonl(text)).toThrow(/broken chain at index 1/);
  });

  it('rejects malformed JSONL and schema-invalid lines', () => {
    expect(() => parseJsonl('{not json}\n')).toThrow(/invalid JSON/);
    expect(() => parseJsonl('{"kind":"plan"}\n')).toThrow(/schema validation/);
  });

  it('rejects duplicate (budgetKey, seq) on import', () => {
    // Two records with a valid chain but the same (budgetKey, seq).
    const first = new AuditLog().append(planInput('r0', 0));
    const candidate = { ...planInput('r1', 0), prevHash: first.hash };
    const second = AuditRecordSchema.parse({ ...candidate, hash: auditRecordHash(candidate) });
    const text = toJsonl([first, second]);
    expect(verifyChain([first, second]).ok).toBe(true);
    expect(() => importJsonl(text)).toThrow(/duplicate \(budgetKey, seq\)/);
  });
});

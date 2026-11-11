import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CardAuditEventSchema,
  InMemoryLedgerStore,
  runLedgerCli,
  verifyChain,
  verifyJsonl,
} from './index.js';

const NOTES = ['reserve floor 500.00 USD must remain after upfront charges'];

describe('independent M4 ledger run_started contract', () => {
  it.each(['offline_emulator', 'sandbox', 'console_sandbox'] as const)('accepts mode %s', mode => {
    expect(CardAuditEventSchema.safeParse({ kind: 'run_started', mode, policyNotes: NOTES }).success).toBe(true);
  });

  it.each([
    { kind: 'run_started', mode: 'offline', policyNotes: NOTES },
    { kind: 'run_started', mode: 'offline_emulator' },
    { kind: 'run_started', mode: 'offline_emulator', policyNotes: [1, 2] },
    { kind: 'run_started', mode: 'offline_emulator', policyNotes: NOTES, extra: true },
  ])('rejects an invalid run_started payload %j', event => {
    expect(CardAuditEventSchema.safeParse(event).success).toBe(false);
  });

  it('keeps run_started first in a newly written chain', () => {
    const ledger = new InMemoryLedgerStore();
    ledger.append({ kind: 'run_started', mode: 'offline_emulator', policyNotes: NOTES });
    ledger.append({ kind: 'authorization', source: 'simulated', cardId: 'card_test_1', amount: '10.00', currency: 'USD', mapped: 'approved' });
    const rows = ledger.read();
    expect(rows[0]).toMatchObject({ seq: 0, event: { kind: 'run_started', mode: 'offline_emulator', policyNotes: NOTES } });
    expect(rows[1]).toMatchObject({ seq: 1, event: { kind: 'authorization' } });
    expect(verifyChain(rows)).toEqual({ ok: true });
  });
});

describe('independent M4 ledger controls_readback contract', () => {
  it('accepts matching and mismatching readbacks', () => {
    expect(CardAuditEventSchema.safeParse({
      kind: 'controls_readback', cardId: 'card_test_1', matches: true,
      expected: { allowed_merchant_categories: ['7372'] }, actual: { allowed_merchant_categories: ['7372'] },
    }).success).toBe(true);
    expect(CardAuditEventSchema.safeParse({
      kind: 'controls_readback', cardId: 'card_test_1', matches: false,
      expected: { transaction_limits: { limits: [{ amount: 60 }] } },
      actual: { transaction_limits: { limits: [{ amount: 999 }] } },
    }).success).toBe(true);
  });

  it.each([
    { kind: 'controls_readback', cardId: 'card_test_1', matches: 'false', expected: {}, actual: {} },
    { kind: 'controls_readback', cardId: 'card_test_1', matches: false, actual: {} },
    { kind: 'controls_readback', cardId: 'card_test_1', matches: false, expected: {} },
    { kind: 'controls_readback', cardId: 'card_test_1', matches: false, expected: {}, actual: {}, extra: true },
  ])('rejects an invalid controls_readback payload %j', event => {
    expect(CardAuditEventSchema.safeParse(event).success).toBe(false);
  });

  it('redacts sensitive keys in the readback evidence before hashing', () => {
    const ledger = new InMemoryLedgerStore();
    ledger.append({
      kind: 'controls_readback', cardId: 'card_test_1', matches: false,
      expected: { token: 'synthetic-token', allowed: true },
      actual: { token: 'synthetic-token', allowed: false },
    });
    const stored = ledger.read()[0]?.event;
    if (stored === undefined || stored.kind !== 'controls_readback') throw new Error('test_expected_controls_readback');
    expect(stored.expected).toEqual({ allowed: true });
    expect(stored.actual).toEqual({ allowed: false });
    expect(JSON.stringify(ledger.read())).not.toContain('synthetic-token');
    expect(verifyChain(ledger.read())).toEqual({ ok: true });
  });

  it('detects a tampered run_started mode', () => {
    const ledger = new InMemoryLedgerStore();
    ledger.append({ kind: 'run_started', mode: 'offline_emulator', policyNotes: NOTES });
    ledger.append({ kind: 'controls_readback', cardId: 'card_test_1', matches: true, expected: {}, actual: {} });
    const tampered = structuredClone(ledger.read()) as unknown as { event: Record<string, unknown> }[];
    const first = tampered[0];
    if (first === undefined) throw new Error('test_expected_run_started');
    first.event['mode'] = 'sandbox';
    expect(verifyChain(tampered as unknown as readonly unknown[])).toEqual({ ok: false, brokenAt: 0, error: 'hash_mismatch' });
  });
});

describe('independent M4 ledger CLI on an offline demo file', () => {
  it('verifies an offline ledger, checks its head, and rejects a tampered copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spendkey-ledger-independent-'));
    const path = join(dir, 'ledger.jsonl');
    const tamperedPath = join(dir, 'ledger.tampered.jsonl');
    try {
      const ledger = new InMemoryLedgerStore();
      ledger.append({ kind: 'run_started', mode: 'offline_emulator', policyNotes: NOTES }, '2026-11-11T10:00:00.000Z');
      ledger.append({
        kind: 'controls_readback', cardId: 'card_test_1', matches: true,
        expected: { allowed_merchant_categories: ['7372'] }, actual: { allowed_merchant_categories: ['7372'] },
      }, '2026-11-11T10:00:01.000Z');
      const text = ledger.read().map(row => `${JSON.stringify(row)}\n`).join('');
      writeFileSync(path, text);
      const head = ledger.read().at(-1);
      if (head === undefined) throw new Error('test_expected_ledger_head');
      expect(verifyJsonl(text)).toMatchObject({ ok: true, head: { seq: head.seq, hash: head.hash } });
      const verified = runLedgerCli(['verify', path, '--expect-head', head.hash, '--expect-seq', String(head.seq)]);
      expect(verified.exitCode).toBe(0);
      expect(JSON.parse(verified.output)).toMatchObject({ ok: true, head: { seq: head.seq, hash: head.hash } });

      writeFileSync(tamperedPath, text.replace('"offline_emulator"', '"sandbox"'));
      const tampered = runLedgerCli(['verify', tamperedPath, '--expect-head', head.hash]);
      expect(tampered.exitCode).toBe(1);
      expect(JSON.parse(tampered.output)).toMatchObject({ ok: false });
      expect(readFileSync(path, 'utf8')).toBe(text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

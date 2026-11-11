import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CardAuditEventSchema, InMemoryLedgerStore, verifyChain } from './index.js';

const at = '2026-11-11T10:00:00.000Z';
describe('M4 additive audit contract', () => {
  it.each(['offline_emulator', 'sandbox', 'console_sandbox'] as const)('roundtrips %s run policy notes', mode => {
    const store = new InMemoryLedgerStore();
    store.append({ kind: 'run_started', mode, policyNotes: ['reserve floor 500.00 USD must remain after upfront charges'] }, at);
    expect(store.read()[0]?.event).toMatchObject({ kind: 'run_started', mode });
    expect(verifyChain(store.read()).ok).toBe(true);
  });
  it('validates modes, object readbacks, required fields, and system freeze attribution', () => {
    expect(CardAuditEventSchema.safeParse({ kind: 'run_started', mode: 'production', policyNotes: [] }).success).toBe(false);
    expect(CardAuditEventSchema.safeParse({ kind: 'run_started', mode: 'sandbox' }).success).toBe(false);
    for (const invalid of [undefined, null, [], 'controls']) {
      expect(CardAuditEventSchema.safeParse({ kind: 'controls_readback', cardId: 'card_test_01', matches: false, expected: {}, actual: invalid }).success).toBe(false);
    }
    expect(CardAuditEventSchema.parse({ kind: 'card_frozen', cardId: 'card_test_01', by: 'system', reason: 'auto-freeze: controls mismatch' })).toMatchObject({ by: 'system' });
  });
  it('redacts readback evidence and supports transport status zero', () => {
    const store = new InMemoryLedgerStore();
    store.append({ kind: 'controls_readback', cardId: 'card_test_01', matches: false,
      expected: { limit: 60 }, actual: { limit: 61, api_key: ['synthetic', 'disallowed', 'value'].join('-') } }, at);
    store.append({ kind: 'raw_response', ref: 'ref_test_01', endpoint: '/api/v1/issuing/cards/create', status: 0,
      body: { code: 'NETWORK_ERROR', message: 'Airwallex request failed' } }, at);
    expect(store.read()[0]?.event).toMatchObject({ actual: { limit: 61 } });
    expect(JSON.stringify(store.read())).not.toContain('synthetic-disallowed-value');
    expect(verifyChain(store.read()).ok).toBe(true);
  });
  it('audit:verify wrapper accepts an explicit path and defaults to demo-output/ledger.jsonl', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spendkey-m4-cli-'));
    try {
      mkdirSync(join(dir, 'demo-output'));
      const path = join(dir, 'demo-output/ledger.jsonl');
      const store = new InMemoryLedgerStore();
      store.append({ kind: 'run_started', mode: 'offline_emulator', policyNotes: [] }, at);
      writeFileSync(path, store.read().map(event => JSON.stringify(event) + '\n').join(''));
      const script = fileURLToPath(new URL('../../../scripts/audit-verify.js', import.meta.url));
      const before = readFileSync(path, 'utf8');
      for (const args of [[], [path]]) {
        const output = execFileSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8' });
        expect(JSON.parse(output)).toMatchObject({ ok: true, head: { seq: 0, hash: store.read()[0]!.hash } });
      }
      expect(readFileSync(path, 'utf8')).toBe(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

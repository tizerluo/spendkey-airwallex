import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AuditLog, runAuditCli } from './index.js';
import type { AuditRecordInput } from './index.js';

const dir = mkdtempSync(join(tmpdir(), 'sr-audit-cli-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PAYER = '0x1111111111111111111111111111111111111111';

function planInput(seq: number): AuditRecordInput {
  return {
    id: `r${seq}`,
    planId: `plan-${seq}`,
    budgetKey: 'budget-1',
    seq,
    payer: PAYER,
    timestamp: '2026-10-12T12:00:00Z',
    kind: 'plan',
    decision: { action: 'pay', reasons: ['budget-ok'], probs: { pay: 0.9, refuse: 0.05, ask: 0.05 } },
    decider: {
      provider: 'rules',
      model: 'rules-v1',
      transport: 'rules',
      probs: { pay: 0.9, refuse: 0.05, ask: 0.05 },
      fallback: true,
    },
    rules: ['budget-ok'],
    savedAmountAtomic: '0',
  };
}

function writeFixture(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text, 'utf8');
  return path;
}

describe('runAuditCli', () => {
  it('verifies a valid chain and exits 0', () => {
    const log = new AuditLog();
    log.append(planInput(0));
    log.append(planInput(1));
    const file = writeFixture('valid.jsonl', log.exportJsonl());
    const result = runAuditCli([file]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toEqual({ ok: true });
  });

  it('reports the first bad index and exits 1', () => {
    const log = new AuditLog();
    log.append(planInput(0));
    log.append(planInput(1));
    const lines = log.exportJsonl().trimEnd().split('\n');
    const second = JSON.parse(lines[1] ?? '{}') as Record<string, unknown>;
    second.savedAmountAtomic = '7';
    lines[1] = JSON.stringify(second);
    const file = writeFixture('tampered.jsonl', `${lines.join('\n')}\n`);
    const result = runAuditCli([file]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output)).toEqual({ ok: false, firstBadIndex: 1 });
  });

  it('exits 2 on a missing argument or unreadable file', () => {
    expect(runAuditCli([]).exitCode).toBe(2);
    const missing = runAuditCli([join(dir, 'does-not-exist.jsonl')]);
    expect(missing.exitCode).toBe(2);
    expect(JSON.parse(missing.output).ok).toBe(false);
  });

  it('exits 2 on malformed JSONL', () => {
    const file = writeFixture('bad.jsonl', '{not json}\n');
    const result = runAuditCli([file]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.output).error).toMatch(/invalid JSON/);
  });

  it('accepts an empty file as a valid empty chain', () => {
    const file = writeFixture('empty.jsonl', '');
    const result = runAuditCli([file]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toEqual({ ok: true });
  });
});

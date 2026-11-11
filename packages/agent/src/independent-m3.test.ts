import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryLedgerStore, verifyChain } from '@sk/ledger';
import { createCuratedSource } from '@sk/offers';
import * as agentPublic from './index.js';
import { runAgent, type AgentContext } from './index.js';

function context(): AgentContext {
  return {
    balanceProvider: vi.fn(async () => [{ currency: 'USD', available_amount: '1000.00' }]),
    spentInWindowMinor: vi.fn(() => 0),
    knownObligations: [{ currency: 'USD', amountMinor: 10_000, dueInDays: 15 }],
    reserveHorizonDays: 30, reserveFloorMinor: { USD: 50_000 }, budgetCurrency: 'USD',
    windowBudgetMinor: 100_000, maxCommitmentMonths: 12, billingCountry: 'US', cardCountry: 'US',
    now: () => new Date('2026-11-11T10:00:00.000Z'),
  };
}

describe('independent agent authority boundary', () => {
  it('exposes only the request-submitting surface', () => {
    const names = Object.keys(agentPublic).sort();
    expect(names).toEqual(['httpApprovalService', 'runAgent']);
    expect(names).not.toContain('approve');
    expect(names).not.toContain('approvalToCardInput');
  });

  it('has no source import or identifier for approve or approvalToCardInput', () => {
    const directory = fileURLToPath(new URL('.', import.meta.url));
    const files = readdirSync(directory, { recursive: true }).map(String)
      .filter(path => path.endsWith('.ts') && !path.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(directory, file), 'utf8');
      expect(source).not.toMatch(/\bapprove\b/);
      expect(source).not.toMatch(/\bapprovalToCardInput\b/);
      expect(source).not.toMatch(/(?:from\s*|import\s*\()\s*["'][^"']*(?:@sk\/app|@sk\/airwallex)/);
      expect(source).not.toMatch(/import\s*\*|\brequire\b|\bcreateRequire\b/);
      expect(source).not.toMatch(/import\s*\(/);
    }
    const manifest = JSON.parse(readFileSync(join(directory, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const dependencies = Object.keys(manifest.dependencies ?? {});
    expect(dependencies).not.toContain('@sk/app');
    expect(dependencies).not.toContain('@sk/airwallex');
  });

  it('returns only the approval request and never records a grant or card', async () => {
    const ledger = new InMemoryLedgerStore();
    const submit = vi.fn(async () => ({ id: 'submitted_test' }));
    const result = await runAgent({ intent: 'design tool', usage: { horizonMonths: 12 }, ctx: context(),
      sources: [createCuratedSource()], ledger, approvalService: { submit } });
    expect(Object.keys(result).sort()).toEqual(['approvalRequestId', 'decision', 'errors', 'request']);
    expect(result).not.toHaveProperty('approval');
    expect(result).not.toHaveProperty('card');
    expect(result).not.toHaveProperty('input');
    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith(result.request);
    expect(ledger.read().map(record => record.event.kind)).toEqual(['offers_snapshot', 'comparison', 'decision']);
    expect(verifyChain(ledger.read()).ok).toBe(true);
  });
});

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryLedgerStore, verifyChain } from '@sk/ledger';
import { createCuratedSource, createX402SnapshotSource } from '@sk/offers';
import { httpApprovalService, runAgent, type AgentContext } from './index.js';

function context(): AgentContext {
  return { balanceProvider: vi.fn(async () => [{ currency: 'USD', available_amount: '1000.00' }]),
    spentInWindowMinor: vi.fn(() => 0), knownObligations: [{ currency: 'USD', amountMinor: 10_000, dueInDays: 15 }],
    reserveHorizonDays: 30, reserveFloorMinor: { USD: 50_000 }, budgetCurrency: 'USD', windowBudgetMinor: 100_000,
    maxCommitmentMonths: 12, billingCountry: 'US', cardCountry: 'US', now: () => new Date('2026-11-11T10:00:00.000Z') };
}
describe('agent trust boundary', () => {
  it('production source never imports privileged policy functions or issuing/service code', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const paths = readdirSync(dir, { recursive: true }).map(String).filter(path => path.endsWith('.ts') && !path.endsWith('.test.ts'));
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const source = readFileSync(`${dir}/${path}`, 'utf8');
      const privileged = ['ap' + 'prove', 'approvalTo' + 'CardInput'];
      expect(source).not.toMatch(new RegExp(`\\b(${privileged.join('|')})\\b`));
      expect(source).not.toMatch(/(?:from\s*|import\s*\()["'][^"']*(?:airwallex|app\/|policy\/)/);
      expect(source).not.toMatch(/import\s*\*|import\s*\(/);
    }
    const lint = readFileSync(new URL('../../../eslint.config.js', import.meta.url), 'utf8');
    expect(lint).toContain('no-restricted-imports');
    expect(lint).toContain('packages/agent/**/*.ts');
  });
  it('asks monthly, records annual reserve failure, and submits only the request', async () => {
    const ledger = new InMemoryLedgerStore(); const submit = vi.fn(async () => ({ id: 'submitted_test' }));
    const ctx = context();
    const result = await runAgent({ intent: 'design tool', usage: { horizonMonths: 12 }, ctx,
      sources: [createCuratedSource()], ledger, approvalService: { submit } });
    expect(ctx.balanceProvider).toHaveBeenCalledOnce(); expect(ctx.spentInWindowMinor).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ approvalRequestId: 'submitted_test', decision: { action: 'ask', chosen: { plan: 'monthly' } } });
    expect(submit).toHaveBeenCalledWith(result.request);
    expect(ledger.read().map(({ event }) => event.kind)).toEqual(['offers_snapshot', 'comparison', 'decision']);
    const decision = ledger.read()[2]!.event;
    expect(decision.kind === 'decision' && decision.ruleResults.some(rule => rule.offerId.includes('annual') && rule.code === 'reserve_breach')).toBe(true);
    expect(verifyChain(ledger.read()).ok).toBe(true);
  });
  it('uses reconciled spend from the injected provider and never requests a refused offer', async () => {
    const ctx = context(); ctx.spentInWindowMinor = () => 100_000;
    const submit = vi.fn();
    const result = await runAgent({ intent: 'design tool', usage: { horizonMonths: 12 }, ctx,
      sources: [createCuratedSource()], ledger: new InMemoryLedgerStore(), approvalService: { submit } });
    expect(result.decision.action).toBe('refuse'); expect(submit).not.toHaveBeenCalled();
  });
  it('never submits an x402 candidate', async () => {
    const submit = vi.fn();
    const ledger = new InMemoryLedgerStore();
    const result = await runAgent({ intent: 'api', usage: { horizonMonths: 12, callsPerMonth: { low: 1000, high: 5000 } },
      ctx: context(), sources: [createX402SnapshotSource([{ resource: 'https://synthetic.example/api', description: 'Synthetic API', priceUsdc: '0.000001', network: 'celo', capturedAt: '2026-11-01T00:00:00.000Z' }])], ledger, approvalService: { submit } });
    expect(result.decision.action).toBe('refuse'); expect(submit).not.toHaveBeenCalled();
    expect(ledger.read()[0]?.event).toMatchObject({ kind: 'offers_snapshot', offers: [{ price: { amount: '0.000001' } }] });
    expect(ledger.read()[1]?.event).toMatchObject({ kind: 'comparison', candidates: [{
      price: { amount: '0.000001', unit: 'per_call' }, perChargeMinor: 1, horizonLowMinor: 12, horizonHighMinor: 12,
    }] });
    expect(verifyChain(ledger.read()).ok).toBe(true);
  });
  it('HTTP submission returns only the id through explicit transport', async () => {
    const transport = vi.fn(async () => new Response('{"id":"request_test"}', { status: 201 }));
    const result = await runAgent({ intent: 'design tool', usage: { horizonMonths: 12 }, ctx: context(),
      sources: [createCuratedSource()], ledger: new InMemoryLedgerStore(),
      approvalService: httpApprovalService('http://127.0.0.1:8787', transport) });
    expect(result.approvalRequestId).toBe('request_test');
    expect(transport).toHaveBeenCalledOnce();
  });
});

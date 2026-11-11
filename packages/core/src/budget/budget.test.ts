import { mockGuardReq } from '@sr/schema';
import { describe, expect, it } from 'vitest';
import { budgetWindow, evaluateBudget, InMemoryBudgetStore, parseAtomicAmount, type BudgetContext, type BudgetLimit, type BudgetScope } from '../index.js';

const context: BudgetContext = { payer: mockGuardReq.payer, asset: mockGuardReq.quote.asset, budgetKey: 'key-a', teamId: 'team-a' };
const scopes: BudgetScope[] = ['wallet', 'key', 'team'];
const limits: BudgetLimit[] = scopes.map((scope) => ({ scope, windowMs: 1000, limitAtomic: '10000' }));

describe('budget windows', () => {
  it.each([[0, 0, 1000], [999, 0, 1000], [1000, 1000, 2000], [1999, 1000, 2000], [2000, 2000, 3000]])('maps %s to [%s,%s)', (now, start, end) => {
    expect(budgetWindow(now, 1000)).toEqual({ startMs: start, endMs: end });
  });
  it.each([[-1, 1000], [0, 0], [0, -1], [0.5, 1], [0, 1.5], [NaN, 1], [0, Infinity], [Number.MAX_SAFE_INTEGER, 1000]])('rejects invalid window %s/%s', (now, window) => {
    expect(() => budgetWindow(now, window)).toThrow();
  });
});

describe('in-memory budgets', () => {
  it.each(scopes)('enforces the %s budget at equality and one unit over', (scope) => {
    const store = new InMemoryBudgetStore();
    const limit = [{ scope, windowMs: 1000, limitAtomic: '10000' }];
    expect(store.reserve(context, limit, '4999', 0).allow).toBe(true);
    expect(store.reserve(context, limit, '5001', 999).allow).toBe(true);
    expect(store.reserve(context, limit, '1', 999)).toEqual({ allow: false, reasons: [`budget_exceeded:${scope}`] });
    expect(store.snapshot(context, limit, 999)[0]?.spentAtomic).toBe('10000');
    expect(store.reserve(context, limit, '10000', 1000).allow).toBe(true);
  });

  it('checks every scope atomically and leaves all rows unchanged on rejection', () => {
    const store = new InMemoryBudgetStore();
    const constrained = limits.map((limit) => ({ ...limit, limitAtomic: limit.scope === 'team' ? '6000' : '10000' }));
    expect(store.reserve(context, constrained, '5000', 0).allow).toBe(true);
    const before = store.snapshot(context, constrained, 0);
    expect(store.reserve(context, constrained, '1001', 0).reasons).toEqual(['budget_exceeded:team']);
    expect(store.snapshot(context, constrained, 0)).toEqual(before);
    expect(store.reserve(context, constrained, '1000', 0).allow).toBe(true);
    expect(store.snapshot(context, constrained, 0).map((row) => row.spentAtomic)).toEqual(['6000', '6000', '6000']);
  });

  it.each(scopes)('shares %s usage only across the appropriate identity', (scope) => {
    const store = new InMemoryBudgetStore();
    const limit = [{ scope, windowMs: 1000, limitAtomic: '10000' }];
    store.reserve(context, limit, '10000', 0);
    const second = { ...context, payer: '0x' + '2'.repeat(40), budgetKey: 'key-b', teamId: 'team-b' };
    expect(store.reserve(second, limit, '10000', 0).allow).toBe(true);
    expect(store.reserve(context, limit, '1', 0).allow).toBe(false);
  });

  it('shares a team cap across different wallets and keys', () => {
    const store = new InMemoryBudgetStore();
    store.reserve(context, limits, '6000', 0);
    const other = { ...context, payer: '0x' + '2'.repeat(40), budgetKey: 'other' };
    expect(store.reserve(other, limits, '4001', 0).reasons).toEqual(['budget_exceeded:team']);
    expect(store.reserve(other, limits, '4000', 0).allow).toBe(true);
  });

  it('keeps different assets separate and canonicalizes wallet address case', () => {
    const store = new InMemoryBudgetStore();
    const first = { ...context, payer: '0x' + 'a'.repeat(40), asset: '0x' + 'b'.repeat(40) };
    store.reserve(first, limits, '10000', 0);
    expect(store.reserve({ ...first, payer: first.payer.toUpperCase().replace('0X', '0x'), asset: first.asset.toUpperCase().replace('0X', '0x') }, limits, '1', 0).allow).toBe(false);
    expect(store.reserve({ ...first, asset: context.asset }, limits, '10000', 0).allow).toBe(true);
  });

  it('enforces short and long windows together', () => {
    const store = new InMemoryBudgetStore();
    const multiple: BudgetLimit[] = [{ scope: 'wallet', windowMs: 1000, limitAtomic: '5000' }, { scope: 'wallet', windowMs: 5000, limitAtomic: '10000' }];
    store.reserve(context, multiple, '5000', 0);
    store.reserve(context, multiple, '5000', 1000);
    expect(store.reserve(context, multiple, '1', 2000).allow).toBe(false);
    expect(store.reserve(context, multiple, '5000', 5000).allow).toBe(true);
  });

  it.each(scopes)('counts zero-cost calls against %s maxCalls', (scope) => {
    const store = new InMemoryBudgetStore();
    const counted = [{ scope, windowMs: 1000, limitAtomic: '10000', maxCalls: 2 }];
    expect(store.reserve(context, counted, '0', 0).allow).toBe(true);
    expect(store.reserve(context, counted, '0', 0).allow).toBe(true);
    expect(store.reserve(context, counted, '0', 0).reasons).toEqual([`budget_calls_exceeded:${scope}`]);
    expect(store.reserve(context, counted, '0', 1000).allow).toBe(true);
  });

  it('checks without spending and returns isolated snapshots', () => {
    const store = new InMemoryBudgetStore();
    const rows = store.snapshot(context, limits, 0);
    for (let index = 0; index < 3; index++) expect(evaluateBudget('10000', rows).allow).toBe(true);
    rows[0]!.spentAtomic = '999999';
    rows[0]!.limitAtomic = '999999';
    expect(store.snapshot(context, limits, 0)[0]?.spentAtomic).toBe('0');
    expect(limits[0]?.limitAtomic).toBe('10000');
  });

  it('does not lose reservations from multiple scheduled callers', async () => {
    const store = new InMemoryBudgetStore();
    const results = await Promise.all(Array.from({ length: 20 }, () => Promise.resolve().then(() => store.reserve(context, limits, '1000', 0))));
    expect(results.filter((result) => result.allow)).toHaveLength(10);
    expect(store.snapshot(context, limits, 0).map((row) => row.spentAtomic)).toEqual(['10000', '10000', '10000']);
  });

  it('rejects backward time so an older window cannot be reused', () => {
    const store = new InMemoryBudgetStore();
    store.reserve(context, limits, '10000', 1000);
    expect(() => store.reserve(context, limits, '10000', 999)).toThrow('clock moved backwards');
    expect(() => store.snapshot(context, limits, 0)).toThrow('clock moved backwards');
  });

  it.each(['key', 'team'] as const)('does not skip a configured %s cap when identity is missing', (scope) => {
    const store = new InMemoryBudgetStore();
    expect(() => store.reserve({ payer: context.payer, asset: context.asset }, [{ scope, windowMs: 1000, limitAtomic: '1' }], '1', 0)).toThrow('Missing budget identity');
    expect(store.snapshot(context, limits, 0).every((row) => row.spentAtomic === '0')).toBe(true);
  });

  it('rejects duplicate windows and invalid limits before changing any rows', () => {
    const store = new InMemoryBudgetStore();
    expect(() => store.reserve(context, [limits[0]!, limits[0]!], '1', 0)).toThrow('Duplicate');
    expect(() => store.reserve(context, [...limits, { scope: 'wallet', windowMs: 2000, limitAtomic: '-1' }], '1', 0)).toThrow();
    expect(() => store.reserve(context, [{ ...limits[0]!, maxCalls: 0.5 }], '1', 0)).toThrow();
    expect(store.snapshot(context, limits, 0).every((row) => row.calls === 0)).toBe(true);
  });

  it('preserves large integer amounts', () => {
    const store = new InMemoryBudgetStore();
    const large = [{ scope: 'wallet' as const, windowMs: 1000, limitAtomic: '9007199254740993' }];
    store.reserve(context, large, '9007199254740992', 0);
    expect(store.reserve(context, large, '1', 0).allow).toBe(true);
    expect(store.reserve(context, large, '1', 0).allow).toBe(false);
    expect(store.snapshot(context, large, 0)[0]?.spentAtomic).toBe('9007199254740993');
  });

  it('avoids key delimiter collisions and isolates store instances', () => {
    const store = new InMemoryBudgetStore();
    const keyed = [{ scope: 'key' as const, windowMs: 1000, limitAtomic: '1' }];
    store.reserve({ ...context, budgetKey: 'key:team:1' }, keyed, '1', 0);
    expect(store.reserve({ ...context, budgetKey: 'key' }, keyed, '1', 0).allow).toBe(true);
    expect(new InMemoryBudgetStore().reserve(context, limits, '10000', 0).allow).toBe(true);
  });
  it('retains the global offline fetch guard', async () => {
    await expect(globalThis.fetch('https://budget.invalid')).rejects.toThrow('Network access is disabled');
  });
});

describe('atomic amounts', () => {
  it.each(['-1', '0.1', '1e3', '0x10', '', ' ', 'NaN'])('rejects malformed amount %s', (amount) => {
    expect(() => parseAtomicAmount(amount)).toThrow();
  });
});

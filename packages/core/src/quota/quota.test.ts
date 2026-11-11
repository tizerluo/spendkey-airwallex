import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryQuotaStorage,
  JEV_QUOTA_DEFAULTS,
  QuotaTracker,
  usdToMicroUsd,
  type QuotaState,
  type QuotaStorage,
} from '../index.js';

describe('quota thresholds', () => {
  it('starts with the $2.50 budget, $2 switch and $2.35 hard stop', async () => {
    expect(JEV_QUOTA_DEFAULTS).toEqual({
      budgetMicroUsd: 2_500_000, switchMicroUsd: 2_000_000, hardStopMicroUsd: 2_350_000,
    });
    expect(await new QuotaTracker().estimate(0)).toEqual({
      allow: true, switchToFallback: false, hardStopped: false,
    });
  });

  it('accumulates integer micro-USD and switches at exactly $2', async () => {
    const storage = new InMemoryQuotaStorage();
    const quota = new QuotaTracker(storage);
    await quota.record('1.999999');
    expect(await quota.estimate(0)).toEqual({ allow: true, switchToFallback: false, hardStopped: false });
    await quota.record('0.000001');
    expect(await storage.read()).toEqual({ usedMicroUsd: 2_000_000, hardStopped: false });
    expect(await quota.estimate(0)).toEqual({ allow: true, switchToFallback: true, hardStopped: false });
  });

  it('prefers fallback when the pending cost would reach the switch threshold', async () => {
    const storage = new InMemoryQuotaStorage();
    const quota = new QuotaTracker(storage);
    await quota.record(1.99);
    expect(await quota.estimate(0.01)).toEqual({ allow: true, switchToFallback: true, hardStopped: false });
    expect((await storage.read()).usedMicroUsd).toBe(1_990_000);
  });

  it.each(['2.35', '2.350001', '2.6'])('permanently stops after recording $%s', async (cost) => {
    const storage = new InMemoryQuotaStorage();
    const quota = new QuotaTracker(storage);
    await quota.record(cost);
    await quota.record(0);
    await quota.markProviderError(500);
    const restored = new QuotaTracker(storage, { budgetUsd: 10, switchUsd: 8, hardStopUsd: 9 });
    for (const tracker of [quota, restored]) {
      expect(await tracker.estimate(0)).toEqual({ allow: false, switchToFallback: true, hardStopped: true });
    }
  });

  it('latches a hard stop when accumulated actual usage reaches $2.35', async () => {
    const quota = new QuotaTracker();
    await quota.record('2.349999');
    expect(await quota.estimate(0)).toEqual({ allow: true, switchToFallback: true, hardStopped: false });
    await quota.record('0.000001');
    expect(await quota.estimate(0)).toEqual({ allow: false, switchToFallback: true, hardStopped: true });
  });

  it('blocks estimates at or beyond the hard stop without charging unspent money', async () => {
    const storage = new InMemoryQuotaStorage();
    const quota = new QuotaTracker(storage);
    await quota.record('2.34');
    expect((await quota.estimate('0.009999')).allow).toBe(true);
    for (const estimate of ['0.01', '0.010001', '10']) {
      expect(await quota.estimate(estimate)).toEqual({ allow: false, switchToFallback: true, hardStopped: false });
    }
    expect(await storage.read()).toEqual({ usedMicroUsd: 2_340_000, hardStopped: false });
    expect((await quota.estimate('0.000001')).allow).toBe(true);
  });

  it('counts tiny estimates conservatively at the last micro-USD boundary', async () => {
    const quota = new QuotaTracker();
    await quota.record('2.349999');
    expect((await quota.estimate('0.0000001')).allow).toBe(false);
  });

  it.each([402, 429])('persists permanent hard stops for HTTP %s', async (status) => {
    const storage = new InMemoryQuotaStorage();
    const quota = new QuotaTracker(storage);
    await quota.markProviderError(status);
    await quota.record('0.000084');
    await quota.markProviderError(status);
    expect(await storage.read()).toEqual({ usedMicroUsd: 84, hardStopped: true });
    expect(await new QuotaTracker(storage).estimate(0)).toEqual({
      allow: false, switchToFallback: true, hardStopped: true,
    });
  });

  it.each([400, 401, 404, 408, 500, 503])('does not quota-stop on HTTP %s', async (status) => {
    const quota = new QuotaTracker();
    await quota.markProviderError(status);
    expect((await quota.estimate(0)).hardStopped).toBe(false);
  });

  it('uses explicit custom thresholds without reading configuration or environment', async () => {
    const quota = new QuotaTracker(undefined, { budgetUsd: '1', switchUsd: '0.8', hardStopUsd: '0.94' });
    await quota.record('0.8');
    expect(await quota.estimate(0)).toEqual({ allow: true, switchToFallback: true, hardStopped: false });
    await quota.record('0.14');
    expect((await quota.estimate(0)).hardStopped).toBe(true);
  });

  it.each([
    { budgetUsd: 0 }, { hardStopUsd: 0 }, { switchUsd: 2.4 },
    { budgetUsd: 2.3 }, { budgetUsd: -1 }, { switchUsd: Number.NaN },
  ])('rejects invalid threshold options %j', (options) => {
    expect(() => new QuotaTracker(undefined, options)).toThrow(RangeError);
  });
});

describe('quota storage contract', () => {
  it('persists usage and hard stops through an independent storage adapter', async () => {
    let row = JSON.stringify({ usedMicroUsd: 0, hardStopped: false });
    const adapter = (): QuotaStorage => ({
      read: async () => JSON.parse(row) as QuotaState,
      update: async (change) => {
        const next = change(JSON.parse(row) as QuotaState);
        row = JSON.stringify(next);
        return { ...next };
      },
    });
    const first = new QuotaTracker(adapter());
    await first.record(2);
    const restarted = new QuotaTracker(adapter());
    expect(await restarted.estimate(0)).toEqual({ allow: true, switchToFallback: true, hardStopped: false });
    await restarted.markProviderError(429);
    expect((await new QuotaTracker(adapter()).estimate(0)).hardStopped).toBe(true);
  });

  it('atomically accumulates concurrent records across trackers without losing a stop', async () => {
    const storage = new InMemoryQuotaStorage();
    const trackers = [new QuotaTracker(storage), new QuotaTracker(storage)];
    await Promise.all([
      ...Array.from({ length: 100 }, (_, index) => trackers[index % 2]!.record('0.025')),
      trackers[0]!.markProviderError(402),
    ]);
    expect(await storage.read()).toEqual({ usedMicroUsd: 2_500_000, hardStopped: true });
  });

  it('normalizes restored usage at the limit into a persistent hard stop', async () => {
    const storage = new InMemoryQuotaStorage({ usedMicroUsd: 2_350_000, hardStopped: false });
    expect((await new QuotaTracker(storage).estimate(0)).hardStopped).toBe(true);
    expect((await storage.read()).hardStopped).toBe(true);
  });

  it('isolates instances with default stores', async () => {
    await new QuotaTracker().markProviderError(429);
    expect((await new QuotaTracker().estimate(0)).allow).toBe(true);
  });

  it('copies initial, read and update snapshots', async () => {
    const initial = { usedMicroUsd: 42, hardStopped: false };
    const storage = new InMemoryQuotaStorage(initial);
    initial.usedMicroUsd = 100;
    const snapshot = await storage.read();
    const updated = await storage.update((current) => ({ ...current, hardStopped: true }));
    Object.assign(snapshot, { usedMicroUsd: 0 });
    Object.assign(updated, { hardStopped: false });
    expect(await storage.read()).toEqual({ usedMicroUsd: 42, hardStopped: true });
  });

  it('rejects corrupt initial state and non-monotonic updates', async () => {
    expect(() => new InMemoryQuotaStorage({ usedMicroUsd: 0.5, hardStopped: false })).toThrow();
    const storage = new InMemoryQuotaStorage({ usedMicroUsd: 1, hardStopped: true });
    await expect(storage.update(() => ({ usedMicroUsd: 0, hardStopped: true }))).rejects.toThrow();
    await expect(storage.update(() => ({ usedMicroUsd: 1, hardStopped: false }))).rejects.toThrow();
    expect(await storage.read()).toEqual({ usedMicroUsd: 1, hardStopped: true });
  });

  it('propagates storage failures before allowing a call or acknowledging a charge', async () => {
    const storage: QuotaStorage = {
      read: vi.fn().mockRejectedValue(new Error('Storage unavailable')),
      update: vi.fn().mockRejectedValue(new Error('Storage unavailable')),
    };
    const quota = new QuotaTracker(storage);
    await expect(quota.estimate(0)).rejects.toThrow('Storage unavailable');
    await expect(quota.record(0.01)).rejects.toThrow('Storage unavailable');
    await expect(quota.markProviderError(402)).rejects.toThrow('Storage unavailable');
  });

  it('rejects corrupt state returned by an external adapter', async () => {
    const invalid = { usedMicroUsd: -1, hardStopped: false };
    const storage: QuotaStorage = {
      read: async () => invalid,
      update: async (change) => change(invalid),
    };
    await expect(new QuotaTracker(storage).estimate(0)).rejects.toThrow('Invalid persisted quota state');
  });

  it('rejects total overflow without changing the persisted ledger', async () => {
    const storage = new InMemoryQuotaStorage({ usedMicroUsd: Number.MAX_SAFE_INTEGER, hardStopped: true });
    await expect(new QuotaTracker(storage).record('0.000001')).rejects.toThrow('safe micro-USD range');
    expect((await storage.read()).usedMicroUsd).toBe(Number.MAX_SAFE_INTEGER);
    expect((await new QuotaTracker().estimate('9007199254.740991')).allow).toBe(false);
  });

  it('rejects invalid costs and statuses without changing usage or the stop', async () => {
    const storage = new InMemoryQuotaStorage();
    const quota = new QuotaTracker(storage);
    await expect(quota.record(-1)).rejects.toThrow();
    await expect(quota.estimate(Number.NaN)).rejects.toThrow();
    for (const status of [99, 600, 402.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(quota.markProviderError(status)).rejects.toThrow();
    }
    expect(await storage.read()).toEqual({ usedMicroUsd: 0, hardStopped: false });
  });
});

describe('quota money conversion', () => {
  it.each([
    [0, 0], ['2.50', 2_500_000], [0.000084, 84], [1e-7, 1],
    ['0.0000011', 2], ['0.0000000001', 1], ['0.0000000', 0],
    ['1e-6', 1], ['1e2', 100_000_000], ['0001.2', 1_200_000],
    ['9007199254.740991', Number.MAX_SAFE_INTEGER],
  ])('converts %s to %s integer micro-USD', (usd, expected) => {
    expect(usdToMicroUsd(usd)).toBe(expected);
  });

  it('accumulates repeated decimal costs without floating point drift', async () => {
    const storage = new InMemoryQuotaStorage();
    const quota = new QuotaTracker(storage);
    for (let index = 0; index < 20; index++) await quota.record(0.1);
    expect((await storage.read()).usedMicroUsd).toBe(2_000_000);
    expect((await quota.estimate(0)).switchToFallback).toBe(true);
  });

  it.each([
    -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
    '', ' ', '-0.1', 'NaN', 'Infinity', '0x10', '1.2.3', '1e99999',
    '1e-99999999999999999', '9007199254.740992',
  ])('rejects invalid or unsafe USD %s', (usd) => {
    expect(() => usdToMicroUsd(usd)).toThrow(RangeError);
  });

  it('retains the global offline fetch guard', async () => {
    await expect(globalThis.fetch('https://quota.invalid')).rejects.toThrow('Network access is disabled');
  });
});

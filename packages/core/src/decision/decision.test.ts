import { DeciderSchema, DecisionSchema, mockGuardReq, type Decision } from '@sr/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InMemoryQuotaStorage, ProviderChain, ProviderHttpError, QuotaTracker, RulesProvider,
  type DecisionFetch, type DecisionProvider, type DecisionRequest, type HardRulePolicy, type QuotaStorage,
} from '../index.js';

const req: DecisionRequest = structuredClone(mockGuardReq);
const policy: HardRulePolicy = { allowedTokens: [{ asset: req.quote.asset, decimals: 6 }] };
const pay: Decision = { action: 'pay', reasons: ['model_approved'], probs: { spend: 0.9 } };
const ids = [
  'typesafe:jev-1.13.0', 'openrouter:perplexity/pplx-decider-v1.2',
  'openrouter:microsoft/microsoft-decision-1', 'openrouter:inception/mercury-decide:free',
] as const;

function fake(id: string = ids[0], decide: DecisionProvider['decide'] = async () => structuredClone(pay)) {
  return { id, decide: vi.fn(decide) };
}

function hang(): Promise<Decision> { return new Promise(() => undefined); }
function timers() { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); }

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('decision rules provider', () => {
  it('uses B6 hard rules and synthesis for an eligible quote', async () => {
    const result = await new RulesProvider(policy).decide(req, { signal: new AbortController().signal });
    expect(result).toEqual({ action: 'pay', reasons: ['hard_rules_passed', 'spend_confident'], probs: { spend: 1 } });
    expect(DecisionSchema.parse(result)).toEqual(result);
  });

  it.each([
    [0.2, 'refuse'], [0.5, 'ask'], [0.8, 'pay'],
  ] as const)('synthesizes trusted spend=%s as %s', async (spend, action) => {
    const result = await new RulesProvider(policy).decide({ ...req, probs: { spend } }, { signal: new AbortController().signal });
    expect(result.action).toBe(action);
  });

  it.each([
    { policy: { ...policy, allowedTokens: [] }, reason: 'token_not_allowed' },
    { policy: { ...policy, allowedChains: [] }, reason: 'chain_not_allowed' },
    { policy: { ...policy, maxSpend: '0' }, reason: 'policy_max_spend_exceeded' },
    { policy: { ...policy, requireSelfProof: true }, reason: 'self_proof_required' },
    { policy: { ...policy, blacklistedPayTo: [req.quote.payTo] }, reason: 'recipient_blacklisted' },
  ])('preserves hard veto $reason despite spend=1', async ({ policy: rules, reason }) => {
    const result = await new RulesProvider(rules).decide({ ...req, probs: { spend: 1 } }, { signal: new AbortController().signal });
    expect(result.action).toBe('refuse');
    expect(result.reasons).toContain(reason);
  });

  it('has a deny-all default policy', () => {
    expect(new RulesProvider().evaluate(req).action).toBe('refuse');
  });

  it('honors an aborted caller before evaluating', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new RulesProvider(policy).decide(req, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not mutate request, probabilities or policy', async () => {
    const request = structuredClone({ ...req, probs: { spend: 0.8 } });
    const rules = structuredClone(policy);
    const before = structuredClone({ request, rules });
    await new RulesProvider(rules).decide(request, { signal: new AbortController().signal });
    expect({ request, rules }).toEqual(before);
  });
});

describe('decision provider chain', () => {
  it.each(ids)('uses canonical provider id %s and metadata', async (id) => {
    const first = fake(id);
    const fallback = fake('typesafe:other');
    const result = await new ProviderChain([first, fallback]).decide(req);
    expect(result.decider).toEqual({ provider: id, model: id.slice(id.indexOf(':') + 1), transport: 'systemone', probs: pay.probs, fallback: false });
    expect(DeciderSchema.parse(result.decider)).toEqual(result.decider);
    const { action, reasons, probs } = result;
    const decision = { action, reasons, probs };
    expect(DecisionSchema.parse(decision)).toEqual(pay);
    expect(fallback.decide).not.toHaveBeenCalled();
  });

  it('accepts explicit model and transport metadata', async () => {
    const provider = { ...fake(), model: 'jev-1.13.0', transport: 'chat-json' as const };
    expect((await new ProviderChain([provider]).decide(req)).decider).toMatchObject({ model: 'jev-1.13.0', transport: 'chat-json' });
  });

  it.each(['ask', 'refuse'] as const)('returns a valid %s decision without falling through', async (action) => {
    const fallback = fake(ids[1]);
    const result = await new ProviderChain([fake(ids[0], async () => ({ ...pay, action })), fallback]).decide(req);
    expect(result.action).toBe(action);
    expect(result.decider.fallback).toBe(false);
    expect(fallback.decide).not.toHaveBeenCalled();
  });

  const failures: { name: string; decide: DecisionProvider['decide'] }[] = [
    ...[402, 429, 500, 502, 503, 599].map((status) => ({ name: `HTTP ${status}`, decide: async () => { throw new ProviderHttpError(status); } })),
    { name: 'structural HTTP error', decide: async () => { throw { status: 429 }; } },
    { name: 'thrown error', decide: async () => { throw new Error('mock failure'); } },
    { name: 'synchronous throw', decide: () => { throw new Error('mock sync failure'); } },
    { name: 'non-Error throw', decide: async () => { throw 'mock failure'; } },
    ...[
      null, undefined, { ...pay, action: 'approve' }, { ...pay, probs: { spend: 1.1 } },
      { ...pay, probs: { spend: NaN } }, { ...pay, reasons: [''] }, { ...pay, reasons: 'why' },
      { ...pay, decider: { provider: 'rules' } }, { ...pay, probs: { risk: { high: -0.1 } } },
      { action: 'pay', reasons: [] },
    ].map((value, index) => ({ name: `invalid schema ${index}`, decide: async () => value as unknown as Decision })),
  ];

  it.each(failures)('falls through on $name', async ({ decide }) => {
    const first = fake(ids[0], decide);
    const next = fake(ids[1]);
    const result = await new ProviderChain([first, next, new RulesProvider(policy)]).decide(req);
    expect(result.decider).toMatchObject({ provider: ids[1], fallback: true });
    expect(next.decide).toHaveBeenCalledOnce();
  });

  it('follows every ring in order before configured rules', async () => {
    const order: string[] = [];
    const providers = ids.map((id) => fake(id, async () => { order.push(id); throw new Error('mock failure'); }));
    const result = await new ProviderChain([...providers, new RulesProvider(policy)]).decide(req);
    expect(order).toEqual(ids);
    expect(result.action).toBe('pay');
    expect(result.decider).toEqual({ provider: 'rules', model: 'rules', transport: 'rules', probs: { spend: 1 }, fallback: true });
  });

  it('appends deny-all local rules when none were configured', async () => {
    const result = await new ProviderChain([fake(ids[0], async () => { throw new Error(); })]).decide(req);
    expect(result.action).toBe('refuse');
    expect(result.decider).toMatchObject({ provider: 'rules', fallback: true });
  });

  it('handles an empty chain with local rules as its first provider', async () => {
    const result = await new ProviderChain([]).decide(req);
    expect(result.action).toBe('refuse');
    expect(result.decider).toMatchObject({ provider: 'rules', fallback: false });
  });

  it('uses a rules-only configured chain without timeout timers', async () => {
    timers();
    const result = await new ProviderChain([new RulesProvider(policy)]).decide(req);
    expect(result.decider.fallback).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves caller ordering for a pplx-first configuration', async () => {
    const jev = fake(ids[0]);
    const result = await new ProviderChain([fake(ids[1]), jev]).decide(req);
    expect(result.decider.provider).toBe(ids[1]);
    expect(result.decider.fallback).toBe(false);
    expect(jev.decide).not.toHaveBeenCalled();
  });

  it.each(['jev', 'typesafe/jev-1.13', 'openrouter:mercury', 'rules:local'])('rejects invalid provider id %s', (id) => {
    expect(() => new ProviderChain([fake(id)])).toThrow();
  });

  it('rejects duplicate providers', () => {
    expect(() => new ProviderChain([fake(), fake()])).toThrow('Duplicate');
  });

  it('requires local rules at the terminal position', () => {
    expect(() => new ProviderChain([new RulesProvider(policy), fake()])).toThrow('terminal');
    expect(() => new ProviderChain([fake('rules')])).toThrow('local RulesProvider');
  });

  it('validates optional provider metadata at construction', () => {
    expect(() => new ProviderChain([{ ...fake(), model: '' }])).toThrow();
    expect(() => new ProviderChain([{ ...fake(), transport: 'bogus' as 'systemone' }])).toThrow();
  });

  it.each([0, -1, NaN, Infinity, 2_147_483_648])('rejects invalid timeout %s', (ms) => {
    expect(() => new ProviderChain([], { perProviderTimeoutMs: ms })).toThrow(RangeError);
    expect(() => new ProviderChain([], { overallDeadlineMs: ms })).toThrow(RangeError);
  });

  it('copies the provider list so later array mutation cannot change ordering', async () => {
    const providers = [fake()];
    const chain = new ProviderChain(providers);
    providers.length = 0;
    expect((await chain.decide(req)).decider.provider).toBe(ids[0]);
  });
});

describe('decision deadlines and cancellation', () => {
  it('rejects a synchronous response that blocks timer delivery past its timeout', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const first = fake(ids[0], async () => { now = 101; return pay; });
    const result = await new ProviderChain([first, fake(ids[1])], { perProviderTimeoutMs: 100 }).decide(req);
    expect(result.decider.provider).toBe(ids[1]);
    expect(first.decide.mock.calls[0]![1].signal.aborted).toBe(true);
  });

  it('uses local rules when a synchronous provider overruns the overall deadline', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const first = fake(ids[0], async () => { now = 2501; return pay; });
    const next = fake(ids[1]);
    const result = await new ProviderChain([first, next, new RulesProvider(policy)]).decide(req);
    expect(result.decider.provider).toBe('rules');
    expect(next.decide).not.toHaveBeenCalled();
  });

  it('times out an uncooperative provider and aborts its signal', async () => {
    timers();
    const first = fake(ids[0], hang);
    const next = fake(ids[1]);
    const pending = new ProviderChain([first, next], { perProviderTimeoutMs: 100 }).decide(req);
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).decider).toMatchObject({ provider: ids[1], fallback: true });
    expect(first.decide.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the default 1500ms per-provider timeout', async () => {
    timers();
    const next = fake(ids[1]);
    const pending = new ProviderChain([fake(ids[0], hang), next]).decide(req);
    await vi.advanceTimersByTimeAsync(1499);
    expect(next.decide).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).decider.provider).toBe(ids[1]);
  });

  it('caps cumulative attempts at the default 2500ms deadline and finishes with rules', async () => {
    timers();
    const providers = ids.map((id) => fake(id, hang));
    const pending = new ProviderChain([...providers, new RulesProvider(policy)]).decide(req);
    await vi.advanceTimersByTimeAsync(2499);
    expect(providers[0]!.decide).toHaveBeenCalledOnce();
    expect(providers[1]!.decide).toHaveBeenCalledOnce();
    expect(providers[2]!.decide).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(performance.now()).toBe(2500);
    expect(result.decider).toMatchObject({ provider: 'rules', fallback: true });
    expect(result.action).toBe('pay');
    expect(providers[3]!.decide).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors an overall deadline shorter than a provider timeout', async () => {
    timers();
    const next = fake(ids[1]);
    const pending = new ProviderChain([fake(ids[0], hang), next], { perProviderTimeoutMs: 1000, overallDeadlineMs: 50 }).decide(req);
    await vi.advanceTimersByTimeAsync(50);
    expect((await pending).decider.provider).toBe('rules');
    expect(next.decide).not.toHaveBeenCalled();
  });

  it('ignores a late successful response from an expired attempt', async () => {
    timers();
    let resolveLate!: (decision: Decision) => void;
    const first = fake(ids[0], () => new Promise((resolve) => { resolveLate = resolve; }));
    const pending = new ProviderChain([first, fake(ids[1])], { perProviderTimeoutMs: 20 }).decide(req);
    await vi.advanceTimersByTimeAsync(20);
    const result = await pending;
    resolveLate({ ...pay, action: 'refuse' });
    await vi.advanceTimersByTimeAsync(0);
    expect(result.decider.provider).toBe(ids[1]);
    expect(result.action).toBe('pay');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles late rejection without an unhandled promise or switching the result', async () => {
    timers();
    let rejectLate!: (reason: unknown) => void;
    const first = fake(ids[0], () => new Promise((_resolve, reject) => { rejectLate = reject; }));
    const pending = new ProviderChain([first, fake(ids[1])], { perProviderTimeoutMs: 20 }).decide(req);
    await vi.advanceTimersByTimeAsync(20);
    expect((await pending).decider.provider).toBe(ids[1]);
    rejectLate(new ProviderHttpError(500));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears timers and detaches caller abort listeners on success', async () => {
    timers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await new ProviderChain([fake()]).decide(req, { signal: controller.signal });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an already aborted call without invoking providers or rules', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = fake();
    const rules = new RulesProvider(policy);
    const evaluate = vi.spyOn(rules, 'evaluate');
    await expect(new ProviderChain([provider, rules]).decide(req, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(provider.decide).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('propagates cancellation during a call instead of running another provider', async () => {
    timers();
    const controller = new AbortController();
    const first = fake(ids[0], hang);
    const next = fake(ids[1]);
    const rules = new RulesProvider(policy);
    const evaluate = vi.spyOn(rules, 'evaluate');
    const pending = new ProviderChain([first, next, rules]).decide(req, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow('caller cancelled');
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new Error('caller cancelled'));
    await rejected;
    expect(first.decide.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(next.decide).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('decision Jev quota', () => {
  it.each([1.999999, 2, 2.1, 2.35])('checks persisted usage=%s before invoking Jev', async (used) => {
    const quota = new QuotaTracker();
    await quota.record(used);
    const jev = fake();
    const next = fake(ids[1]);
    const result = await new ProviderChain([jev, next], { quota }).decide(req);
    expect(result.decider.provider).toBe(used < 2 ? ids[0] : ids[1]);
    expect(result.decider.fallback).toBe(used >= 2);
    expect(jev.decide).toHaveBeenCalledTimes(used < 2 ? 1 : 0);
  });

  it('uses projected cost to switch before a call crosses the soft threshold', async () => {
    const quota = new QuotaTracker();
    await quota.record(1.99);
    const jev = { ...fake(), estimateCostUsd: vi.fn(() => '0.01') };
    const result = await new ProviderChain([jev, fake(ids[1])], { quota }).decide(req);
    expect(result.decider.provider).toBe(ids[1]);
    expect(jev.estimateCostUsd).toHaveBeenCalledWith(req);
    expect(jev.decide).not.toHaveBeenCalled();
  });

  it('does not charge an estimate as actual usage', async () => {
    const storage = new InMemoryQuotaStorage();
    const quota = new QuotaTracker(storage);
    const jev = { ...fake(), estimateCostUsd: () => '0.01' };
    await new ProviderChain([jev], { quota }).decide(req);
    expect((await storage.read()).usedMicroUsd).toBe(0);
  });

  it.each([402, 429])('persists Jev HTTP %s as a hard stop on later calls', async (status) => {
    const quota = new QuotaTracker();
    const jev = fake(ids[0], async () => { throw new ProviderHttpError(status); });
    const chain = new ProviderChain([jev, fake(ids[1])], { quota });
    expect((await chain.decide(req)).decider.provider).toBe(ids[1]);
    expect((await quota.estimate(0)).hardStopped).toBe(true);
    expect((await chain.decide(req)).decider.provider).toBe(ids[1]);
    expect(jev.decide).toHaveBeenCalledOnce();
  });

  const lateQuotaErrors = ['typesafe:jev-1.13.0', 'openrouter:typesafe/jev-1.13.0'].flatMap((id) =>
    (['timeout', 'cancel'] as const).flatMap((mode) => [402, 429].map((status) => ({ id, mode, status }))));

  async function expiredJev(mode: 'timeout' | 'cancel', quota: QuotaTracker, id = ids[0] as string) {
    timers();
    let rejectLate!: (reason: unknown) => void;
    const jev = fake(id);
    // A second invocation would succeed, exposing a lost quota stop without another timeout.
    jev.decide.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectLate = reject; }));
    const next = fake(ids[1]);
    const chain = new ProviderChain([jev, next], { quota, perProviderTimeoutMs: 20 });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const reason = new Error('caller cancelled');
    const pending = chain.decide(req, { signal: controller.signal });
    const cancelled = mode === 'cancel' ? expect(pending).rejects.toBe(reason) : undefined;
    await vi.advanceTimersByTimeAsync(0);
    expect(jev.decide).toHaveBeenCalledOnce();
    if (mode === 'cancel') {
      controller.abort(reason);
      await cancelled;
      expect(next.decide).not.toHaveBeenCalled();
    } else {
      await vi.advanceTimersByTimeAsync(20);
      expect((await pending).decider).toMatchObject({ provider: ids[1], fallback: true });
    }
    expect(jev.decide.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    const unchanged = async () => {
      if (mode === 'cancel') await expect(pending).rejects.toBe(reason);
      else await expect(pending).resolves.toEqual({
        ...pay,
        decider: { provider: ids[1], model: ids[1].slice(ids[1].indexOf(':') + 1), transport: 'systemone', probs: pay.probs, fallback: true },
      });
      expect(vi.getTimerCount()).toBe(0);
    };
    return { chain, jev, rejectLate, unchanged };
  }

  it.each(lateQuotaErrors)('persists late $id HTTP $status after $mode without changing the outcome', async ({ id, mode, status }) => {
    const storage = new InMemoryQuotaStorage();
    const quota = new QuotaTracker(storage);
    const { chain, jev, rejectLate, unchanged } = await expiredJev(mode, quota, id);
    rejectLate(new ProviderHttpError(status));
    await vi.advanceTimersByTimeAsync(0);
    await unchanged();
    expect(await quota.estimate(0)).toEqual({ allow: false, switchToFallback: true, hardStopped: true });
    expect((await new QuotaTracker(storage).estimate(0)).hardStopped).toBe(true);
    expect((await chain.decide(req)).decider.provider).toBe(ids[1]);
    expect(jev.decide).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['timeout', 'cancel'] as const)('leaves Jev eligible after a late 5xx following %s', async (mode) => {
    const quota = new QuotaTracker();
    const { chain, jev, rejectLate, unchanged } = await expiredJev(mode, quota);
    rejectLate(new ProviderHttpError(503));
    await vi.advanceTimersByTimeAsync(0);
    await unchanged();
    expect(await quota.estimate(0)).toEqual({ allow: true, switchToFallback: false, hardStopped: false });
    expect((await chain.decide(req)).decider.provider).toBe(ids[0]);
    expect(jev.decide).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  function delayedQuotaStop() {
    const storage = new InMemoryQuotaStorage();
    const update = storage.update.bind(storage);
    const started = vi.fn();
    let finish!: () => void;
    let fail!: (reason: unknown) => void;
    const write = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    storage.update = async (change) => {
      if (change(await storage.read()).hardStopped) {
        started();
        await write;
      }
      return update(change);
    };
    return { storage, started, finish, fail };
  }

  const lateWrites = (['timeout', 'cancel'] as const).flatMap((mode) =>
    [402, 429].flatMap((status) => ['success', 'failure'].map((writeResult) => ({ mode, status, writeResult }))));

  it.each(lateWrites)('observes late HTTP $status storage $writeResult after $mode while preserving the outcome', async ({ mode, status, writeResult }) => {
    const { storage, started, finish, fail } = delayedQuotaStop();
    const quota = new QuotaTracker(storage);
    const { chain, jev, rejectLate, unchanged } = await expiredJev(mode, quota);
    rejectLate(new ProviderHttpError(status));
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveBeenCalledOnce();
    // A stalled write cannot add caller timers or change a settled outcome.
    await vi.advanceTimersByTimeAsync(3000);
    await unchanged();
    if (writeResult === 'success') finish();
    else fail(new Error('late quota storage failure'));
    await vi.advanceTimersByTimeAsync(0);
    await unchanged();
    expect((await storage.read()).hardStopped).toBe(writeResult === 'success');
    if (writeResult === 'success') {
      expect((await quota.estimate(0)).hardStopped).toBe(true);
      expect((await chain.decide(req)).decider.provider).toBe(ids[1]);
      expect(jev.decide).toHaveBeenCalledOnce();
    }
    // Vitest also fails on unhandled rejections, including delayed write failures.
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['timeout', 'cancel'] as const)('bounds an immediate quota-stop write through %s and observes its late failure', async (mode) => {
    timers();
    const { storage, started, fail } = delayedQuotaStop();
    const jev = fake(ids[0], async () => { throw new ProviderHttpError(429); });
    const next = fake(ids[1]);
    const controller = new AbortController();
    const reason = new Error('caller cancelled during quota write');
    const pending = new ProviderChain([jev, next], {
      quota: new QuotaTracker(storage), perProviderTimeoutMs: 20, overallDeadlineMs: 15,
    }).decide(req, { signal: controller.signal });
    const cancelled = mode === 'cancel' ? expect(pending).rejects.toBe(reason) : undefined;
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveBeenCalledOnce();
    if (mode === 'cancel') {
      controller.abort(reason);
      await cancelled;
    } else {
      await vi.advanceTimersByTimeAsync(15);
      expect((await pending).decider.provider).toBe('rules');
    }
    expect(next.decide).not.toHaveBeenCalled();
    expect(jev.decide.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    fail(new Error('quota storage failure after caller settled'));
    await vi.advanceTimersByTimeAsync(0);
    if (mode === 'cancel') await expect(pending).rejects.toBe(reason);
    else expect((await pending).decider.provider).toBe('rules');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not hard-stop quota for a Jev 5xx error', async () => {
    const quota = new QuotaTracker();
    await new ProviderChain([fake(ids[0], async () => { throw new ProviderHttpError(503); })], { quota }).decide(req);
    expect((await quota.estimate(0)).hardStopped).toBe(false);
  });

  it('does not apply Jev quota to other typesafe or openrouter models', async () => {
    const quota = new QuotaTracker();
    await quota.markProviderError(429);
    for (const id of ['typesafe:other', ids[1], ids[2], ids[3]]) {
      const provider = fake(id);
      expect((await new ProviderChain([provider], { quota }).decide(req)).decider.provider).toBe(id);
      expect(provider.decide).toHaveBeenCalledOnce();
    }
  });

  it('also recognizes Jev on the OpenRouter typesafe namespace', async () => {
    const quota = new QuotaTracker();
    await quota.markProviderError(429);
    const jev = fake('openrouter:typesafe/jev-1.13.0');
    expect((await new ProviderChain([jev], { quota }).decide(req)).decider.provider).toBe('rules');
    expect(jev.decide).not.toHaveBeenCalled();
  });

  it('skips Jev when quota storage rejects', async () => {
    const storage: QuotaStorage = { read: async () => { throw new Error(); }, update: async () => { throw new Error('mock storage failure'); } };
    const jev = fake();
    const result = await new ProviderChain([jev, fake(ids[1])], { quota: new QuotaTracker(storage) }).decide(req);
    expect(result.decider.provider).toBe(ids[1]);
    expect(jev.decide).not.toHaveBeenCalled();
  });

  it('bounds hanging quota storage and never invokes Jev after its late estimate', async () => {
    timers();
    const storage = new InMemoryQuotaStorage();
    let finish!: () => void;
    const originalUpdate = storage.update.bind(storage);
    storage.update = async (change) => { await new Promise<void>((resolve) => { finish = resolve; }); return originalUpdate(change); };
    const jev = fake();
    const pending = new ProviderChain([jev, fake(ids[1])], { quota: new QuotaTracker(storage), perProviderTimeoutMs: 30 }).decide(req);
    await vi.advanceTimersByTimeAsync(30);
    expect((await pending).decider.provider).toBe(ids[1]);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(jev.decide).not.toHaveBeenCalled();
  });

  it('falls through on invalid cost estimates without invoking Jev', async () => {
    const jev = { ...fake(), estimateCostUsd: () => -1 };
    expect((await new ProviderChain([jev, fake(ids[1])], { quota: new QuotaTracker() }).decide(req)).decider.provider).toBe(ids[1]);
    expect(jev.decide).not.toHaveBeenCalled();
  });
});

it('provides a fetch injection type without a real HTTP adapter', async () => {
  const injected: DecisionFetch = vi.fn(async () => ({ status: 200, json: async () => structuredClone(pay) }));
  const response = await injected('https://mock.invalid', { method: 'POST', headers: {}, body: '{}', signal: new AbortController().signal });
  expect(await response.json()).toEqual(pay);
  await expect(globalThis.fetch('https://decision.invalid')).rejects.toThrow('Network access is disabled');
});

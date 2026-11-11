import { readFileSync } from 'node:fs';
import { DecisionSchema, mockGuardReq } from '@sr/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSystemOneProvider, InMemoryQuotaStorage, ProviderChain, ProviderHttpError,
  ProviderResponseError, ProviderTimeoutError, ProviderTransportError, QuotaTracker,
  RulesProvider, SystemOneHttpAdapter, type DecisionFetch, type DecisionRequest, type SystemOneProviderConfig,
} from '../../index.js';

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
}
const request: DecisionRequest = structuredClone(mockGuardReq);
const id = 'typesafe:jev-1.13.0';
const nextId = 'openrouter:perplexity/pplx-decider-v1.2';
const options = () => ({ signal: new AbortController().signal });

function setup(overrides: Partial<SystemOneProviderConfig> = {}, raw: unknown = fixture('typesafe-pay'), status = 200) {
  const json = vi.fn(async () => structuredClone(raw));
  const fetch = vi.fn<DecisionFetch>(async () => ({ status, json }));
  const config: SystemOneProviderConfig = { id, baseUrl: 'https://typesafe.invalid', apiKey: 'fake', model: 'jev-1.13.0', fetch, ...overrides };
  return { provider: createSystemOneProvider(config), fetch, json, config };
}

function timers() { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('decision System One adapter requests and normalization', () => {
  it.each([
    ['https://typesafe.invalid', 'https://typesafe.invalid/v1/systemone', id, 'jev-1.13.0', 'typesafe-pay', 'pay'],
    ['https://router.invalid/api/', 'https://router.invalid/api/v1/systemone', nextId, 'perplexity/pplx-decider-v1.2', 'openrouter-ask', 'ask'],
  ])('posts injected System One requests to %s', async (baseUrl, endpoint, providerId, model, name, action) => {
    const { provider, fetch } = setup({ baseUrl, id: providerId, model }, fixture(name!));
    const result = await provider.decide(request, options());
    expect(provider).toBeInstanceOf(SystemOneHttpAdapter);
    expect(provider).toMatchObject({ id: providerId, model, transport: 'systemone' });
    expect(DecisionSchema.parse(result)).toEqual(result);
    expect(result.action).toBe(action);
    expect(Object.keys(result).sort()).toEqual(['action', 'probs', 'reasons']);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(endpoint);
    expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer fake', 'Content-Type': 'application/json' } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toMatchObject({
      model, state: { intent: request.intent, url: request.url, quote: request.quote, maxSpend: request.maxSpend },
      questions: { spend: { type: 'noul' }, risk: { type: 'noul' } },
    });
    expect(init.body).not.toContain('Bearer');
    expect(JSON.parse(init.body)).not.toHaveProperty('store');
  });

  it('opts Fastino out of storage and normalizes the documented response without a cost', async () => {
    const raw = fixture('fastino-pay');
    const { provider, fetch } = setup({ id: 'fastino:fastino/GLiDE', model: 'fastino/GLiDE',
      baseUrl: 'https://api.fastino.ai', store: false }, raw);
    expect(raw).toHaveProperty('token_usage');
    expect(raw.usage).not.toHaveProperty('cost');
    expect(provider.estimateCostUsd(request)).toBe(0);
    expect(await provider.decide(request, options())).toEqual({
      action: 'pay', reasons: ['spend_confident'], probs: { spend: 0.92, risk: 0.08 },
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.fastino.ai/v1/systemone');
    expect(init.headers.Authorization).toBe('Bearer fake');
    expect(JSON.parse(init.body)).toMatchObject({ model: 'fastino/GLiDE', store: false,
      questions: { spend: { type: 'noul' }, risk: { type: 'noul' } } });
    // An omitted option changes no bytes beyond the explicit storage field.
    const legacy = setup({ id: 'fastino:fastino/GLiDE', model: 'fastino/GLiDE' }, raw);
    await legacy.provider.decide(request, options());
    expect(init.body).toBe(`${legacy.fetch.mock.calls[0]![1].body.slice(0, -1)},"store":false}`);
  });

  it('projects request state without forwarding probabilities, payer or arbitrary extras', async () => {
    const req = { ...structuredClone(request), probs: { spend: 1 }, category: 'compute', requiresSelf: true, selfProofVerified: false, injected: 'extra' };
    const before = structuredClone(req);
    const { provider, fetch } = setup();
    await provider.decide(req, options());
    const body = JSON.parse(fetch.mock.calls[0]![1].body) as { state: Record<string, unknown> };
    expect(body.state).toMatchObject({ category: 'compute', requiresSelf: true, selfProofVerified: false });
    expect(body.state).not.toHaveProperty('probs');
    expect(body.state).not.toHaveProperty('payer');
    expect(body.state).not.toHaveProperty('injected');
    expect(req).toEqual(before);
  });

  it.each([[0, 'refuse'], [0.399999, 'refuse'], [0.4, 'ask'], [0.699999, 'ask'], [0.7, 'pay'], [1, 'pay']] as const)(
    'uses B6 spend threshold %s -> %s', async (spend, action) => {
      const raw = { answers: { spend: { type: 'noul', noul: spend }, risk: { type: 'noul', noul: 0 } } };
      expect((await setup({}, raw).provider.decide(request, options())).action).toBe(action);
    },
  );

  it('preserves the high-risk veto', async () => {
    const result = await setup({}, fixture('high-risk')).provider.decide(request, options());
    expect(result).toEqual({ action: 'refuse', reasons: ['risk_high'], probs: { spend: 0.99, risk: 0.8 } });
  });

  it('treats high-risk probability 0.5 as a veto', async () => {
    const raw = { answers: { spend: { type: 'noul', noul: 1 }, risk: { type: 'noul', noul: 0.5 } } };
    expect((await setup({}, raw).provider.decide(request, options())).action).toBe('refuse');
  });

  it('copies constructor inputs so later config mutation cannot change authentication or routing', async () => {
    const { provider, fetch, config } = setup();
    config.apiKey = 'changed'; config.model = 'changed'; config.baseUrl = 'https://changed.invalid';
    config.fetch = async () => { throw new Error('changed'); };
    await provider.decide(request, options());
    expect(fetch.mock.calls[0]![0]).toBe('https://typesafe.invalid/v1/systemone');
    expect(fetch.mock.calls[0]![1].headers.Authorization).toBe('Bearer fake');
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toHaveProperty('model', 'jev-1.13.0');
  });

  it('never uses global fetch', async () => {
    await setup().provider.decide(request, options());
    await expect(globalThis.fetch('https://decision.invalid')).rejects.toThrow('Network access is disabled');
  });
});

describe('decision System One failures', () => {
  it.each([301, 400, 401, 402, 403, 404, 408, 429, 500, 502, 503, 524, 529, 599])('throws typed HTTP %s without reading its body', async (status) => {
    const { provider, json } = setup({}, fixture('typesafe-pay'), status);
    await expect(provider.decide(request, options())).rejects.toBeInstanceOf(ProviderHttpError);
    await expect(provider.decide(request, options())).rejects.toMatchObject({ status });
    expect(json).not.toHaveBeenCalled();
  });

  const malformed: unknown[] = [
    fixture('malformed'), null, [], 'body', {}, { answers: null }, { answers: [] },
    { answers: { spend: { type: 'noul', noul: 1 } } },
    ...[undefined, null, '0.8', true, NaN, Infinity, -0.1, 1.1, { true: 0.8, false: 0.2 }].map((noul) =>
      ({ answers: { spend: { type: 'noul', noul }, risk: { type: 'noul', noul: 0.1 } } })),
    ...[undefined, null, '0.1', -0.1, 1.1].map((noul) =>
      ({ answers: { spend: { type: 'noul', noul: 0.9 }, risk: { type: 'noul', noul } } })),
    { answers: { spend: { type: 'boolean', noul: 0.9 }, risk: { type: 'noul', noul: 0.1 } } },
    { action: 'pay', reasons: [], probs: { spend: 1 } },
  ];
  it.each(malformed.map((raw, i) => ({ raw, i })))('rejects malformed response $i instead of manufacturing a decision', async ({ raw }) => {
    await expect(setup({}, raw).provider.decide(request, options())).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it('throws a sanitized typed error on JSON parsing failure', async () => {
    const { provider, json } = setup();
    json.mockRejectedValue(new Error('sensitive response content'));
    await expect(provider.decide(request, options())).rejects.toEqual(new ProviderResponseError());
  });

  it.each([0, 99, 600, 200.5, NaN])('rejects invalid HTTP status %s', async (status) => {
    await expect(setup({}, {}, status).provider.decide(request, options())).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it.each([new Error('sensitive transport content'), 'sensitive transport content'])('sanitizes transport errors', async (error) => {
    const fetch: DecisionFetch = async () => { throw error; };
    await expect(setup({ fetch }).provider.decide(request, options())).rejects.toEqual(new ProviderTransportError());
  });

  it.each(['TimeoutError', 'AbortError'])('maps transport %s to a typed timeout', async (name) => {
    const fetch: DecisionFetch = async () => { throw new DOMException('transport detail', name); };
    await expect(setup({ fetch }).provider.decide(request, options())).rejects.toBeInstanceOf(ProviderTimeoutError);
  });
});

describe('decision System One deadline and abort handling', () => {
  it.each(['fetch', 'json'])('bounds uncooperative %s and cleans timers/listeners', async (phase) => {
    timers();
    const fetch = vi.fn<DecisionFetch>(async () => phase === 'fetch'
      ? new Promise(() => undefined) : { status: 200, json: () => new Promise(() => undefined) });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = setup({ fetch, timeoutMs: 20 }).provider.decide(request, { signal: controller.signal });
    const rejected = expect(pending).rejects.toBeInstanceOf(ProviderTimeoutError);
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses a 1500ms default timeout', async () => {
    timers();
    const pending = setup({ fetch: () => new Promise(() => undefined) }).provider.decide(request, options());
    const rejected = expect(pending).rejects.toBeInstanceOf(ProviderTimeoutError);
    await vi.advanceTimersByTimeAsync(1499);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an already aborted request without calling fetch or its estimator', async () => {
    const estimator = vi.fn(() => 0);
    const { provider, fetch } = setup({ estimatedCostUsd: estimator });
    const controller = new AbortController(); controller.abort();
    await expect(provider.decide(request, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled(); expect(estimator).not.toHaveBeenCalled();
  });

  it('propagates the caller reason promptly while unresolved fetch accounting remains pending', async () => {
    timers();
    const quota = new QuotaTracker(); const record = vi.spyOn(quota, 'record');
    const fetch: DecisionFetch = () => new Promise(() => undefined);
    const controller = new AbortController(); const reason = new Error('caller cancelled');
    const next = setup({ id: nextId }).provider; const decide = vi.spyOn(next, 'decide');
    const pending = new ProviderChain([setup({ fetch, quota }).provider, next]).decide(request, { signal: controller.signal });
    const rejected = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(1); controller.abort(reason); await rejected;
    expect(decide).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['resolve', 'reject'])('discards late JSON decisions after timeout while accounting for %s', async (mode) => {
    timers();
    const quota = new QuotaTracker(); const record = vi.spyOn(quota, 'record');
    let resolve!: (raw: unknown) => void; let reject!: (error: unknown) => void;
    const fetch: DecisionFetch = async () => ({ status: 200, json: () => new Promise((yes, no) => { resolve = yes; reject = no; }) });
    const pending = setup({ fetch, quota, timeoutMs: 10 }).provider.decide(request, options());
    const rejected = expect(pending).rejects.toBeInstanceOf(ProviderTimeoutError);
    await vi.advanceTimersByTimeAsync(10); await rejected;
    if (mode === 'resolve') resolve(fixture('high-risk')); else reject(new Error('late'));
    await vi.advanceTimersByTimeAsync(0);
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(mode === 'resolve' ? 0.00004 : expect.any(Number));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a synchronous transport overrun while retaining consumed inference accounting', async () => {
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const quota = new QuotaTracker(); const record = vi.spyOn(quota, 'record'); const json = vi.fn(async () => fixture('typesafe-pay'));
    const fetch: DecisionFetch = async () => { now = 21; return { status: 200, json }; };
    await expect(setup({ fetch, quota, timeoutMs: 20 }).provider.decide(request, options())).rejects.toBeInstanceOf(ProviderTimeoutError);
    expect(json).toHaveBeenCalledOnce(); expect(record).toHaveBeenCalledOnce();
  });

  it('cleans up on successful calls and keeps concurrent calls independent', async () => {
    timers();
    const { provider } = setup();
    const controller = new AbortController(); const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const results = await Promise.all([provider.decide(request, { signal: controller.signal }), provider.decide(request, options())]);
    expect(results.map((r) => r.action)).toEqual(['pay', 'pay']);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function)); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('decision System One cost accounting and chain integration', () => {
  it.each([id, 'openrouter:typesafe/jev-1.13.0'])('estimates Jev input cost for %s using the design snapshot and payload size', async (providerId) => {
    const storage = new InMemoryQuotaStorage(); const quota = new QuotaTracker(storage);
    const { provider, fetch } = setup({ id: providerId, quota });
    const estimate = provider.estimateCostUsd(request);
    expect(estimate).toBeGreaterThan(0);
    expect(provider.estimateCostUsd({ ...request, intent: request.intent + '汉'.repeat(100) })).toBeGreaterThan(estimate);
    await provider.decide(request, options());
    const bytes = new TextEncoder().encode(fetch.mock.calls[0]![1].body).length + 64;
    expect(estimate).toBe(Math.ceil(bytes * 0.042) / 1_000_000);
    expect((await storage.read()).usedMicroUsd).toBe(Math.ceil(bytes * 0.042));
  });

  it('requires a configured estimate for models without a project pricing snapshot', () => {
    expect(setup({ id: nextId }).provider.estimateCostUsd(request)).toBe(0);
    expect(setup({ id: nextId, estimatedCostUsd: '0.003' }).provider.estimateCostUsd(request)).toBe(0.003);
  });

  it('exposes a configured rounded estimate without charging before the request', async () => {
    const storage = new InMemoryQuotaStorage(); const quota = new QuotaTracker(storage);
    const estimator = vi.fn(() => '0.0000001');
    const { provider } = setup({ quota, estimatedCostUsd: estimator });
    expect(provider.estimateCostUsd(request)).toBe(0.000001);
    expect(estimator).toHaveBeenCalledWith(request);
    expect((await storage.read()).usedMicroUsd).toBe(0);
    await provider.decide(request, options());
    expect((await storage.read()).usedMicroUsd).toBe(1);
  });

  it('records reported usage rather than double charging the estimate', async () => {
    const storage = new InMemoryQuotaStorage(); const quota = new QuotaTracker(storage);
    const { provider } = setup({ quota, estimatedCostUsd: '0.001' }, fixture('openrouter-ask'));
    await provider.decide(request, options());
    expect((await storage.read()).usedMicroUsd).toBe(30);
  });

  it('records explicit zero reported cost instead of the estimate', async () => {
    const raw = { ...fixture('typesafe-pay'), usage: { cost: 0 } };
    const storage = new InMemoryQuotaStorage(); const quota = new QuotaTracker(storage);
    await setup({ quota, estimatedCostUsd: '0.001' }, raw).provider.decide(request, options());
    expect((await storage.read()).usedMicroUsd).toBe(0);
  });

  it('charges known usage on a malformed model answer', async () => {
    const storage = new InMemoryQuotaStorage(); const quota = new QuotaTracker(storage);
    await expect(setup({ quota }, fixture('malformed')).provider.decide(request, options())).rejects.toBeInstanceOf(ProviderResponseError);
    expect((await storage.read()).usedMicroUsd).toBe(40);
  });

  it.each([-1, NaN, Infinity, null, 'no', true, '9007199254.740992'])('rejects invalid reported cost %s and conservatively records the estimate', async (reported) => {
    const storage = new InMemoryQuotaStorage(); const quota = new QuotaTracker(storage);
    const raw = { ...fixture('typesafe-pay'), usage: { cost: reported } };
    await expect(setup({ quota, estimatedCostUsd: '0.00002' }, raw).provider.decide(request, options())).rejects.toBeInstanceOf(ProviderResponseError);
    expect((await storage.read()).usedMicroUsd).toBe(20);
  });

  it('uses configured estimates to skip Jev before crossing the chain soft threshold', async () => {
    const quota = new QuotaTracker(); await quota.record('1.99');
    const { provider, fetch } = setup({ estimatedCostUsd: '0.01', quota });
    const next = setup({ id: nextId }).provider;
    expect((await new ProviderChain([provider, next], { quota }).decide(request)).decider.provider).toBe(nextId);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([402, 429])('preserves Jev HTTP %s for chain quota exhaustion', async (status) => {
    const quota = new QuotaTracker(); const { provider, fetch } = setup({ quota }, {}, status);
    const chain = new ProviderChain([provider, setup({ id: nextId }).provider], { quota });
    expect((await chain.decide(request)).decider).toMatchObject({ provider: nextId, fallback: true });
    expect((await quota.estimate(0)).hardStopped).toBe(true);
    await chain.decide(request); expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([429, 500, 'malformed', 'timeout'])('falls through adapter %s to local rules', async (failure) => {
    timers();
    const overrides = failure === 'timeout' ? { fetch: () => new Promise<never>(() => undefined), timeoutMs: 10 } : {};
    const { provider } = setup(overrides, failure === 'malformed' ? fixture('malformed') : {}, typeof failure === 'number' ? failure : 200);
    const rules = new RulesProvider({ allowedTokens: [{ asset: request.quote.asset, decimals: 6 }] });
    const pending = new ProviderChain([provider, rules]).decide(request);
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(10);
    expect((await pending).decider).toMatchObject({ provider: 'rules', fallback: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not fall through valid ask/refuse answers', async () => {
    for (const name of ['openrouter-ask', 'high-risk']) {
      const next = setup({ id: nextId }).provider; const decide = vi.spyOn(next, 'decide');
      const result = await new ProviderChain([setup({}, fixture(name)).provider, next]).decide(request);
      expect(result.decider).toMatchObject({ provider: id, model: 'jev-1.13.0', transport: 'systemone', fallback: false });
      expect(decide).not.toHaveBeenCalled();
    }
  });

  it('fails through if quota recording fails', async () => {
    const quota = new QuotaTracker(); vi.spyOn(quota, 'record').mockRejectedValue(new Error('storage unavailable'));
    const chain = new ProviderChain([setup({ quota }).provider, setup({ id: nextId }).provider]);
    expect((await chain.decide(request)).decider.provider).toBe(nextId);
  });
});

describe('decision System One accounting lifetime', () => {
  const modes = ['adapter-timeout', 'chain-timeout', 'cancel'] as const;
  it.each(modes.flatMap((mode) => ['fetch', 'body'].map((phase) => ({ mode, phase }))))(
    'settles known usage exactly once after $mode during $phase, without delivering the late decision', async ({ mode, phase }) => {
      timers();
      const storage = new InMemoryQuotaStorage(); const quota = new QuotaTracker(storage);
      const record = vi.spyOn(quota, 'record'); const onQuotaSettled = vi.fn();
      let finish!: () => void;
      const delayed = new Promise<void>((resolve) => { finish = resolve; });
      const raw = { ...fixture('high-risk'), usage: { cost: 0.4 } };
      const fetch: DecisionFetch = async () => {
        if (phase === 'fetch') await delayed;
        return { status: 200, json: async () => { if (phase === 'body') await delayed; return raw; } };
      };
      const { provider } = setup({ fetch, quota, onQuotaSettled, timeoutMs: mode === 'adapter-timeout' ? 10 : 100 });
      const chain = new ProviderChain([provider, setup({ id: nextId }).provider], {
        perProviderTimeoutMs: mode === 'chain-timeout' ? 10 : 100, overallDeadlineMs: 200,
      });
      const controller = new AbortController(); const reason = new Error('caller cancelled');
      const pending = chain.decide(request, { signal: controller.signal });
      const cancelled = mode === 'cancel' ? expect(pending).rejects.toBe(reason) : undefined;
      await vi.advanceTimersByTimeAsync(0);
      if (mode === 'cancel') { controller.abort(reason); await cancelled; }
      else await vi.advanceTimersByTimeAsync(10);
      const selected = mode === 'cancel' ? undefined : await pending;
      if (selected) expect(selected.decider.provider).toBe(nextId);
      expect(onQuotaSettled).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
      finish(); await vi.advanceTimersByTimeAsync(0);
      expect(record).toHaveBeenCalledExactlyOnceWith(0.4);
      expect(await storage.read()).toEqual({ usedMicroUsd: 400_000, hardStopped: false });
      expect(onQuotaSettled).toHaveBeenCalledExactlyOnceWith(true);
      if (mode === 'cancel') await expect(pending).rejects.toBe(reason);
      else await expect(pending).resolves.toEqual(selected);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['transport', 'json'] as const)('records a conservative estimate once for a dispatched %s failure', async (phase) => {
    const storage = new InMemoryQuotaStorage(); const quota = new QuotaTracker(storage);
    const record = vi.spyOn(quota, 'record'); const onQuotaSettled = vi.fn();
    const fail = async () => { throw new Error('private upstream detail'); };
    const fetch: DecisionFetch = phase === 'transport' ? fail : async () => ({ status: 200, json: fail });
    await expect(setup({ fetch, quota, onQuotaSettled, estimatedCostUsd: 0.001 }).provider.decide(request, options())).rejects.toEqual(
      phase === 'transport' ? new ProviderTransportError() : new ProviderResponseError());
    expect(record).toHaveBeenCalledExactlyOnceWith(0.001);
    expect(await storage.read()).toEqual({ usedMicroUsd: 1000, hardStopped: false });
    expect(onQuotaSettled).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(['success', 'failure'] as const)('reports accounting %s only after a delayed write settles', async (result) => {
    timers();
    const quota = new QuotaTracker(); let resolve!: () => void; let reject!: (error: Error) => void;
    const write = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const record = vi.spyOn(quota, 'record').mockReturnValue(write); const onQuotaSettled = vi.fn();
    const pending = setup({ quota, onQuotaSettled, timeoutMs: 10 }).provider.decide(request, options());
    const rejected = expect(pending).rejects.toBeInstanceOf(ProviderTimeoutError);
    await vi.advanceTimersByTimeAsync(10); await rejected;
    expect(record).toHaveBeenCalledOnce(); expect(onQuotaSettled).not.toHaveBeenCalled();
    if (result === 'success') resolve(); else reject(new Error('storage unavailable'));
    await vi.advanceTimersByTimeAsync(0);
    expect(record).toHaveBeenCalledOnce();
    expect(onQuotaSettled).toHaveBeenCalledExactlyOnceWith(result === 'success');
    await rejected; expect(vi.getTimerCount()).toBe(0);
  });

  it('settles an already cancelled undispatched attempt without charging', async () => {
    const quota = new QuotaTracker(); const record = vi.spyOn(quota, 'record'); const onQuotaSettled = vi.fn();
    const { provider, fetch } = setup({ quota, onQuotaSettled });
    const controller = new AbortController(); controller.abort();
    await expect(provider.decide(request, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    // The public abort and the underlying operation have independent settlement handlers.
    await Promise.resolve(); await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
    expect(onQuotaSettled).toHaveBeenCalledExactlyOnceWith(true);
  });
});

describe('decision System One late HTTP quota stops', () => {
  const jevIds = [id, 'openrouter:typesafe/jev-1.13.0'];
  const modes = ['adapter-timeout', 'chain-timeout', 'cancel'] as const;
  const cases = jevIds.flatMap((providerId) => modes.flatMap((mode) =>
    [402, 429].map((status) => ({ providerId, mode, status }))));

  async function expiredFetch(mode: typeof modes[number], quota: QuotaTracker, providerId = id) {
    timers();
    let respond!: (response: Awaited<ReturnType<DecisionFetch>>) => void;
    const fetch = vi.fn<DecisionFetch>().mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }))
      .mockImplementation(async () => ({ status: 200, json: async () => fixture('typesafe-pay') }));
    const { provider } = setup({ id: providerId, fetch, quota, timeoutMs: mode === 'adapter-timeout' ? 10 : 100 });
    const adapterDecide = vi.spyOn(provider, 'decide');
    const next = setup({ id: nextId }).provider;
    const nextDecide = vi.spyOn(next, 'decide');
    const chain = new ProviderChain([provider, next], {
      quota, perProviderTimeoutMs: mode === 'chain-timeout' ? 10 : 100, overallDeadlineMs: 200,
    });
    const controller = new AbortController();
    const removeCaller = vi.spyOn(controller.signal, 'removeEventListener');
    const reason = new Error('caller cancelled HTTP decision');
    const pending = chain.decide(request, { signal: controller.signal });
    const cancelled = mode === 'cancel' ? expect(pending).rejects.toBe(reason) : undefined;
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledOnce();
    const removeAdapter = vi.spyOn(adapterDecide.mock.calls[0]![1].signal, 'removeEventListener');
    if (mode === 'cancel') { controller.abort(reason); await cancelled; }
    else await vi.advanceTimersByTimeAsync(10);
    const selected = mode === 'cancel' ? undefined : await pending;
    if (selected) expect(selected.decider).toMatchObject({ provider: nextId, fallback: true });
    else expect(nextDecide).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(removeCaller).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(removeAdapter).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    const unchanged = async () => {
      if (mode === 'cancel') await expect(pending).rejects.toBe(reason);
      else await expect(pending).resolves.toEqual(selected);
      expect(vi.getTimerCount()).toBe(0);
    };
    return { chain, fetch, respond, unchanged };
  }

  it.each(cases)('persists $providerId HTTP $status after $mode and skips later Jev fetches', async ({ providerId, mode, status }) => {
    const storage = new InMemoryQuotaStorage(); const quota = new QuotaTracker(storage);
    const { chain, fetch, respond, unchanged } = await expiredFetch(mode, quota, providerId);
    const json = vi.fn(async () => fixture('typesafe-pay'));
    respond({ status, json });
    await vi.advanceTimersByTimeAsync(0);
    expect(await quota.estimate(0)).toEqual({ allow: false, switchToFallback: true, hardStopped: true });
    expect((await new QuotaTracker(storage).estimate(0)).hardStopped).toBe(true);
    expect(json).not.toHaveBeenCalled();
    await unchanged();
    expect((await chain.decide(request)).decider.provider).toBe(nextId);
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(jevIds.flatMap((providerId) => modes.map((mode) => ({ providerId, mode }))))(
    'keeps $providerId eligible after late HTTP 503 following $mode', async ({ providerId, mode }) => {
      const quota = new QuotaTracker();
      const { chain, fetch, respond, unchanged } = await expiredFetch(mode, quota, providerId);
      const json = vi.fn(async () => fixture('typesafe-pay'));
      respond({ status: 503, json }); await vi.advanceTimersByTimeAsync(0);
      expect(await quota.estimate(0)).toEqual({ allow: true, switchToFallback: false, hardStopped: false });
      expect(json).not.toHaveBeenCalled(); await unchanged();
      expect((await chain.decide(request)).decider.provider).toBe(providerId);
      expect(fetch).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(jevIds.flatMap((providerId) => [402, 429].map((status) => ({ providerId, status }))))(
    'persists immediate $providerId HTTP $status even without a chain', async ({ providerId, status }) => {
      const quota = new QuotaTracker(); const { provider, json } = setup({ id: providerId, quota }, {}, status);
      await expect(provider.decide(request, options())).rejects.toMatchObject({ status });
      expect((await quota.estimate(0)).hardStopped).toBe(true); expect(json).not.toHaveBeenCalled();
    },
  );

  it.each([402, 429])('does not stop Jev quota for another model HTTP %s', async (status) => {
    const quota = new QuotaTracker();
    await expect(setup({ id: nextId, quota }, {}, status).provider.decide(request, options())).rejects.toMatchObject({ status });
    expect((await quota.estimate(0)).hardStopped).toBe(false);
  });

  function delayedStorage() {
    const storage = new InMemoryQuotaStorage(); const update = storage.update.bind(storage);
    let finish!: () => void; let fail!: (error: unknown) => void;
    const write = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    const started = vi.fn();
    storage.update = async (change) => {
      if (change(await storage.read()).hardStopped) { started(); await write; }
      return update(change);
    };
    return { storage, started, finish, fail };
  }

  it.each(modes.flatMap((mode) => [402, 429].flatMap((status) =>
    ['success', 'failure'].map((writeResult) => ({ mode, status, writeResult })))))(
    'observes delayed HTTP $status storage $writeResult after $mode', async ({ mode, status, writeResult }) => {
      const { storage, started, finish, fail } = delayedStorage();
      const quota = new QuotaTracker(storage);
      const { chain, fetch, respond, unchanged } = await expiredFetch(mode, quota);
      respond({ status, json: async () => ({}) }); await vi.advanceTimersByTimeAsync(0);
      expect(started).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(3000); await unchanged();
      if (writeResult === 'success') finish(); else fail(new Error('late HTTP quota storage failure'));
      await vi.advanceTimersByTimeAsync(0); await unchanged();
      expect((await storage.read()).hardStopped).toBe(writeResult === 'success');
      if (writeResult === 'success') {
        expect((await chain.decide(request)).decider.provider).toBe(nextId); expect(fetch).toHaveBeenCalledOnce();
      }
      // Vitest fails if the adapter leaves a late storage rejection unhandled.
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['deadline', 'cancel'] as const)('bounds an immediate adapter quota write through %s', async (mode) => {
    timers();
    const { storage, started, fail } = delayedStorage(); const quota = new QuotaTracker(storage);
    const { provider, fetch } = setup({ quota, timeoutMs: 100 }, {}, 429);
    const next = setup({ id: nextId }).provider; const decide = vi.spyOn(next, 'decide');
    const controller = new AbortController(); const reason = new Error('cancel during HTTP quota write');
    const pending = new ProviderChain([provider, next], {
      quota, perProviderTimeoutMs: 20, overallDeadlineMs: 15,
    }).decide(request, { signal: controller.signal });
    const cancelled = mode === 'cancel' ? expect(pending).rejects.toBe(reason) : undefined;
    await vi.advanceTimersByTimeAsync(0); expect(started).toHaveBeenCalledOnce();
    if (mode === 'cancel') { controller.abort(reason); await cancelled; }
    else { await vi.advanceTimersByTimeAsync(15); expect((await pending).decider.provider).toBe('rules'); }
    expect(decide).not.toHaveBeenCalled(); expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    fail(new Error('HTTP quota write failed after settlement')); await vi.advanceTimersByTimeAsync(0);
    if (mode === 'cancel') await expect(pending).rejects.toBe(reason);
    else expect((await pending).decider.provider).toBe('rules');
    expect((await storage.read()).hardStopped).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('decision System One constructor validation', () => {
  it.each(['rules', 'jev', 'openrouter:jev', 'typesafe/jev'])('rejects provider id %s', (invalid) => {
    expect(() => setup({ id: invalid })).toThrow();
  });
  it.each(['http://fake.invalid', 'not-a-url', 'https://user:pass@fake.invalid', 'https://fake.invalid/?key=fake', 'https://fake.invalid/#fragment'])('rejects invalid API root %s', (baseUrl) => {
    expect(() => setup({ baseUrl })).toThrow(TypeError);
  });
  it.each(['', ' ', 'fake\r\nheader'])('rejects invalid header credentials', (apiKey) => {
    expect(() => setup({ apiKey })).toThrow(TypeError);
  });
  it.each([0, -1, NaN, Infinity, 2_147_483_648])('rejects timeout %s', (timeoutMs) => {
    expect(() => setup({ timeoutMs })).toThrow(RangeError);
  });
  it.each([-1, NaN, Infinity, 'bad'])('rejects invalid configured cost %s', (estimatedCostUsd) => {
    expect(() => setup({ estimatedCostUsd })).toThrow(ProviderResponseError);
  });
  it('rejects missing fetch and empty model', () => {
    expect(() => setup({ fetch: undefined as unknown as DecisionFetch })).toThrow(TypeError);
    expect(() => setup({ model: '' })).toThrow();
  });
});

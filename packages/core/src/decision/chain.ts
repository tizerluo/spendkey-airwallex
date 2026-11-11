import { DeciderSchema, DecisionProviderIdSchema, DecisionSchema, type Decision } from '@sr/schema';
import type { QuotaTracker } from '../quota/index.js';
import type { ChainDecision, DecisionProvider, DecisionRequest } from './provider.js';
import { RulesProvider } from './rules-provider.js';

export interface ProviderChainOptions {
  perProviderTimeoutMs?: number;
  /** Bounds external providers and quota storage. Local rules run when this time is exhausted. */
  overallDeadlineMs?: number;
  quota?: QuotaTracker;
}

export interface ProviderChainDecideOptions {
  signal?: AbortSignal;
}

function duration(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new RangeError('Decision timeouts must be positive finite timer durations');
  }
  return value;
}

function isJev(id: string): boolean {
  return /^(?:typesafe:|openrouter:typesafe\/)jev(?:[-.]|$)/i.test(id);
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

/** The timer is enforced even when an injected provider ignores its AbortSignal. */
function bounded<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const expiresAt = performance.now() + ms;
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
      complete();
    };
    const abort = () => {
      controller.abort(parent?.reason);
      finish(() => reject(parent?.reason));
    };
    const timeout = () => {
      const error = new DOMException('Decision provider timed out', 'TimeoutError');
      controller.abort(error);
      finish(() => reject(error));
    };
    const timer = setTimeout(timeout, ms);
    parent?.addEventListener('abort', abort, { once: true });
    if (parent?.aborted) abort();
    // Attach both handlers immediately: late rejections cannot become unhandled.
    Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return work(controller.signal);
    }).then(
      (value) => {
        // A synchronous provider can block timer delivery; check elapsed time as well.
        if (performance.now() >= expiresAt) timeout();
        else finish(() => resolve(value));
      },
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/** Ordered, offline-capable chain. Configure Fastino -> pplx -> ms-decision -> mercury -> RulesProvider.
 * Caller ordering is preserved (including a pplx-first override). A missing terminal RulesProvider
 * is replaced with a local deny-all instance. API callers must still apply hard vetoes to model
 * decisions before execution; this chain selects a decider and does not reserve spending.
 */
export class ProviderChain {
  private readonly providers: readonly DecisionProvider[];
  private readonly rules: RulesProvider;
  private readonly perProviderTimeoutMs: number;
  private readonly overallDeadlineMs: number;
  private readonly quota: QuotaTracker | undefined;

  constructor(providers: readonly DecisionProvider[], options: ProviderChainOptions = {}) {
    this.perProviderTimeoutMs = duration(options.perProviderTimeoutMs ?? 1500);
    this.overallDeadlineMs = duration(options.overallDeadlineMs ?? 2500);
    this.quota = options.quota;
    const ids = new Set<string>();
    providers.forEach((provider, index) => {
      DecisionProviderIdSchema.parse(provider.id);
      if (ids.has(provider.id)) throw new Error('Duplicate decision provider id');
      ids.add(provider.id);
      if (provider.id === 'rules' && (!(provider instanceof RulesProvider) || index !== providers.length - 1)) {
        throw new Error('The terminal rules provider must be a local RulesProvider');
      }
      DeciderSchema.parse({
        provider: provider.id, model: provider.model ?? (provider.id.split(':').slice(1).join(':') || 'rules'),
        transport: provider.transport ?? 'systemone', probs: {}, fallback: false,
      });
    });
    const terminal = providers.at(-1);
    this.rules = terminal instanceof RulesProvider ? terminal : new RulesProvider();
    this.providers = terminal === this.rules ? [...providers] : [...providers, this.rules];
  }

  private result(provider: DecisionProvider, raw: Decision, index: number): ChainDecision {
    const decision = DecisionSchema.parse(raw);
    const decider = DeciderSchema.parse({
      provider: provider.id, model: provider.model ?? (provider.id.split(':').slice(1).join(':') || 'rules'),
      transport: provider.transport ?? 'systemone', probs: decision.probs, fallback: index !== 0,
    });
    return { ...decision, decider };
  }

  async decide(request: DecisionRequest, options: ProviderChainDecideOptions = {}): Promise<ChainDecision> {
    const { signal } = options;
    signal?.throwIfAborted();
    const deadline = performance.now() + this.overallDeadlineMs;
    for (const [index, provider] of this.providers.entries()) {
      signal?.throwIfAborted();
      if (provider === this.rules) return this.result(provider, this.rules.evaluate(request), index);
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      try {
        const decision = await bounded(async (attemptSignal) => {
          if (isJev(provider.id) && this.quota) {
            const estimate = await this.quota.estimate(provider.estimateCostUsd?.(request) ?? 0);
            attemptSignal.throwIfAborted();
            if (!estimate.allow || estimate.switchToFallback || estimate.hardStopped) return undefined;
          }
          try {
            return await provider.decide(request, { signal: attemptSignal });
          } catch (error) {
            const status = httpStatus(error);
            if (isJev(provider.id) && this.quota && (status === 402 || status === 429)) {
              // Quota exhaustion outlives this attempt, including timeout/cancellation.
              // bounded still limits the caller and observes any late storage rejection.
              await this.quota.markProviderError(status);
            }
            throw error;
          }
        }, Math.min(this.perProviderTimeoutMs, remaining), signal);
        signal?.throwIfAborted();
        if (decision !== undefined) return this.result(provider, decision, index);
      } catch {
        signal?.throwIfAborted();
        // Invalid schema, provider failure, timeout, or unavailable quota storage falls through.
      }
    }
    signal?.throwIfAborted();
    return this.result(this.rules, this.rules.evaluate(request), this.providers.length - 1);
  }
}

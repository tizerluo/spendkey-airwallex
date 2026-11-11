import type { Decider, Decision, DecisionProviderId, Probs } from '@sr/schema';
import type { UsdAmount } from '../quota/index.js';
import type { HardRuleRequest } from '../rules/index.js';

/** Hard-rule context and optional trusted probabilities; never populate these from client assertions. */
export type DecisionRequest = HardRuleRequest & { probs?: Probs };

export interface DecisionProviderOptions {
  signal: AbortSignal;
}

/** Adapters normalize their response to the frozen Decision schema before returning it. */
export interface DecisionProvider {
  readonly id: DecisionProviderId;
  readonly model?: Decider['model'];
  readonly transport?: Decider['transport'];
  /** Used to check Jev quota before a call. Zero is the default for mocked providers. */
  estimateCostUsd?(request: DecisionRequest): UsdAmount;
  decide(request: DecisionRequest, options: DecisionProviderOptions): Promise<Decision>;
}

export type ChainDecision = Decision & { decider: Decider };

/** Injection boundary for future HTTP adapters. This module makes no HTTP requests. */
export interface DecisionFetchResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export type DecisionFetch = (
  url: string,
  init: { method: 'POST'; headers: Readonly<Record<string, string>>; body: string; signal: AbortSignal },
) => Promise<DecisionFetchResponse>;

/** Future adapters must throw on HTTP failures rather than returning an error body as a decision. */
export class ProviderHttpError extends Error {
  constructor(readonly status: number) {
    super(`Decision provider returned HTTP ${status}`);
    this.name = 'ProviderHttpError';
  }
}

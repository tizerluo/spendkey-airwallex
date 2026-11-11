import type { Decision } from '@sr/schema';
import { evaluateGuard, type HardRulePolicy } from '../rules/index.js';
import type { DecisionProvider, DecisionProviderOptions, DecisionRequest } from './provider.js';

/** Local terminal fallback. With no policy supplied it denies every token. */
export class RulesProvider implements DecisionProvider {
  readonly id = 'rules';
  readonly model = 'rules';
  readonly transport = 'rules';

  constructor(private readonly policy: HardRulePolicy = { allowedTokens: [] }) {}

  /** Synchronous evaluation lets the chain finish locally even after its provider deadline. */
  evaluate(request: DecisionRequest): Decision {
    // In rules-only mode an eligible quote has deterministic spend confidence.
    // Trusted probabilities, when supplied, still pass through B6 synthesis.
    const { action, reasons, probs } = evaluateGuard(request, this.policy, request.probs ?? { spend: 1 });
    return { action, reasons, probs };
  }

  async decide(request: DecisionRequest, { signal }: DecisionProviderOptions): Promise<Decision> {
    signal.throwIfAborted();
    return this.evaluate(request);
  }
}

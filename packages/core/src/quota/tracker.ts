import { usdToMicroUsd, type UsdAmount } from './money.js';
import { InMemoryQuotaStorage, validateQuotaState, type QuotaStorage } from './storage.js';

export const JEV_QUOTA_DEFAULTS = Object.freeze({
  budgetMicroUsd: 2_500_000,
  switchMicroUsd: 2_000_000,
  hardStopMicroUsd: 2_350_000,
});

/** Pass validated config values explicitly; this module never reads the environment. */
export interface QuotaTrackerOptions {
  readonly budgetUsd?: UsdAmount;
  readonly switchUsd?: UsdAmount;
  readonly hardStopUsd?: UsdAmount;
}

export interface QuotaEstimate {
  /** Jev may be used as a backup when true, even if fallback is preferred. */
  readonly allow: boolean;
  readonly switchToFallback: boolean;
  /** A persisted permanent stop, rather than a blocked unspent estimate. */
  readonly hardStopped: boolean;
}

/**
 * One-time Jev free-budget ledger. No network, resets, or paid-call escape hatch.
 * estimate is a check, not a reservation: callers must serialize Jev calls when
 * enforcing a shared budget, including the estimate -> call -> record interval.
 */
export class QuotaTracker {
  private readonly switchMicroUsd: number;
  private readonly hardStopMicroUsd: number;

  constructor(
    private readonly storage: QuotaStorage = new InMemoryQuotaStorage(),
    options: QuotaTrackerOptions = {},
  ) {
    const budget = options.budgetUsd === undefined
      ? JEV_QUOTA_DEFAULTS.budgetMicroUsd : usdToMicroUsd(options.budgetUsd);
    this.switchMicroUsd = options.switchUsd === undefined
      ? JEV_QUOTA_DEFAULTS.switchMicroUsd : usdToMicroUsd(options.switchUsd);
    this.hardStopMicroUsd = options.hardStopUsd === undefined
      ? JEV_QUOTA_DEFAULTS.hardStopMicroUsd : usdToMicroUsd(options.hardStopUsd);
    if (budget === 0 || this.hardStopMicroUsd === 0
      || this.switchMicroUsd > this.hardStopMicroUsd || this.hardStopMicroUsd > budget) {
      throw new RangeError('Quota thresholds must satisfy 0 <= switch <= hard stop <= budget, with a positive hard stop');
    }
  }

  async estimate(costUsd: UsdAmount): Promise<QuotaEstimate> {
    const cost = usdToMicroUsd(costUsd);
    // Normalize a restored ledger already at the limit, persisting its permanent stop.
    const state = await this.storage.update((current) => {
      validateQuotaState(current);
      return {
        usedMicroUsd: current.usedMicroUsd,
        hardStopped: current.hardStopped || current.usedMicroUsd >= this.hardStopMicroUsd,
      };
    });
    validateQuotaState(state);
    // Subtraction keeps even very large valid estimates within safe integer arithmetic.
    const allow = !state.hardStopped && cost < this.hardStopMicroUsd - state.usedMicroUsd;
    return {
      allow,
      switchToFallback: !allow || cost >= this.switchMicroUsd - state.usedMicroUsd,
      hardStopped: state.hardStopped,
    };
  }

  /** Record actual cost even after a stop (for delayed/in-flight responses). */
  async record(actualUsd: UsdAmount): Promise<void> {
    const actual = usdToMicroUsd(actualUsd);
    await this.storage.update((current) => {
      validateQuotaState(current);
      const usedMicroUsd = current.usedMicroUsd + actual;
      if (!Number.isSafeInteger(usedMicroUsd)) throw new RangeError('Quota total exceeds safe micro-USD range');
      return {
        usedMicroUsd,
        hardStopped: current.hardStopped || usedMicroUsd >= this.hardStopMicroUsd,
      };
    });
  }

  async markProviderError(status: number): Promise<void> {
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new RangeError('Provider error status must be an HTTP status code');
    }
    if (status !== 402 && status !== 429) return;
    await this.storage.update((current) => {
      validateQuotaState(current);
      return { usedMicroUsd: current.usedMicroUsd, hardStopped: true };
    });
  }
}

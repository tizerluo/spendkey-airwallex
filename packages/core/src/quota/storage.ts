/** One dedicated Jev free-budget ledger, with no automatic period reset. */
export interface QuotaState {
  readonly usedMicroUsd: number;
  readonly hardStopped: boolean;
}

/**
 * Implementations must persist update atomically across all callers sharing a ledger.
 * A future D1 adapter must use a transaction/CAS and may retry the pure callback.
 * Updates must never decrease usage or clear a hard stop; failures must reject.
 */
export interface QuotaStorage {
  read(): Promise<QuotaState>;
  update(change: (current: Readonly<QuotaState>) => QuotaState): Promise<QuotaState>;
}

export function validateQuotaState(state: QuotaState): void {
  if (!Number.isSafeInteger(state.usedMicroUsd) || state.usedMicroUsd < 0
    || typeof state.hardStopped !== 'boolean') {
    throw new RangeError('Invalid persisted quota state');
  }
}

/** Shared instances preserve state across trackers; state snapshots cannot mutate the ledger. */
export class InMemoryQuotaStorage implements QuotaStorage {
  private state: QuotaState;

  constructor(initial: QuotaState = { usedMicroUsd: 0, hardStopped: false }) {
    validateQuotaState(initial);
    this.state = { ...initial };
  }

  async read(): Promise<QuotaState> {
    return { ...this.state };
  }

  async update(change: (current: Readonly<QuotaState>) => QuotaState): Promise<QuotaState> {
    // The synchronous callback and commit run in one JS turn, without an intervening await.
    const next = change(Object.freeze({ ...this.state }));
    validateQuotaState(next);
    if (next.usedMicroUsd < this.state.usedMicroUsd || (this.state.hardStopped && !next.hardStopped)) {
      throw new RangeError('Quota updates must preserve spending and hard stops');
    }
    this.state = { ...next };
    return { ...this.state };
  }
}

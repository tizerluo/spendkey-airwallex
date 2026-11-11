import type { AtomicAmount, GuardReq } from '@sr/schema';

export type BudgetScope = 'wallet' | 'key' | 'team';

/** Limits are denominated in the quote asset, never summed across different tokens. */
export interface BudgetLimit {
  scope: BudgetScope;
  windowMs: number;
  limitAtomic: AtomicAmount;
  maxCalls?: number;
}

export interface BudgetContext {
  payer: GuardReq['payer'];
  asset: GuardReq['quote']['asset'];
  budgetKey?: string;
  teamId?: string;
}

export interface BudgetSnapshot extends BudgetLimit {
  id: string;
  asset: string;
  windowStartMs: number;
  windowEndMs: number;
  spentAtomic: AtomicAmount;
  calls: number;
}

export interface BudgetEvaluation {
  allow: boolean;
  reasons: string[];
}

export function parseAtomicAmount(amount: AtomicAmount): bigint {
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) {
    throw new RangeError('Amount must be a nonnegative atomic decimal string');
  }
  return BigInt(amount);
}

function integer(value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError('Invalid budget integer');
  }
}

/** Fixed, half-open windows aligned to Unix epoch; the caller supplies the clock. */
export function budgetWindow(nowMs: number, windowMs: number): { startMs: number; endMs: number } {
  integer(nowMs, 0);
  integer(windowMs, 1);
  const startMs = nowMs - (nowMs % windowMs);
  const endMs = startMs + windowMs;
  integer(endMs, 1);
  return { startMs, endMs };
}

/** Pure pre-call check. Equality with a spend cap is allowed; a new call consumes one count. */
export function evaluateBudget(amountAtomic: AtomicAmount, snapshots: readonly BudgetSnapshot[]): BudgetEvaluation {
  const amount = parseAtomicAmount(amountAtomic);
  const reasons: string[] = [];
  for (const snapshot of snapshots) {
    integer(snapshot.calls, 0);
    if (parseAtomicAmount(snapshot.spentAtomic) + amount > parseAtomicAmount(snapshot.limitAtomic)) {
      reasons.push(`budget_exceeded:${snapshot.scope}`);
    }
    if (snapshot.maxCalls !== undefined) {
      integer(snapshot.maxCalls, 0);
      if (snapshot.calls >= snapshot.maxCalls) reasons.push(`budget_calls_exceeded:${snapshot.scope}`);
    }
  }
  return { allow: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export interface BudgetStore {
  snapshot(context: BudgetContext, limits: readonly BudgetLimit[], nowMs: number): BudgetSnapshot[];
  reserve(context: BudgetContext, limits: readonly BudgetLimit[], amountAtomic: AtomicAmount, nowMs: number): BudgetEvaluation;
}

/** Synchronous reservations update every applicable window together, with no partial charge.
 * This process-local implementation is not durable. Checks alone do not reserve funds.
 * A reservation counts against the budget immediately; settlement/release belongs to the caller's durable ledger.
 */
export class InMemoryBudgetStore implements BudgetStore {
  private readonly rows = new Map<string, { spentAtomic: string; calls: number }>();
  private lastReservationMs = 0;

  snapshot(context: BudgetContext, limits: readonly BudgetLimit[], nowMs: number): BudgetSnapshot[] {
    integer(nowMs, 0);
    if (nowMs < this.lastReservationMs) throw new RangeError('Budget clock moved backwards');
    const address = /^0x[0-9a-fA-F]{40}$/;
    if (!address.test(context.payer) || !address.test(context.asset)) throw new RangeError('Invalid budget address');
    const seen = new Set<string>();
    return limits.map((limit) => {
      parseAtomicAmount(limit.limitAtomic);
      if (limit.maxCalls !== undefined) integer(limit.maxCalls, 0);
      const id = limit.scope === 'wallet' ? context.payer.toLowerCase()
        : limit.scope === 'key' ? context.budgetKey : limit.scope === 'team' ? context.teamId : undefined;
      if (!id?.trim()) throw new RangeError(`Missing budget identity for ${limit.scope}`);
      const window = budgetWindow(nowMs, limit.windowMs);
      const snapshot: BudgetSnapshot = {
        ...limit, id, asset: context.asset.toLowerCase(),
        windowStartMs: window.startMs, windowEndMs: window.endMs,
        spentAtomic: '0', calls: 0,
      };
      const key = this.key(snapshot);
      if (seen.has(key)) throw new RangeError('Duplicate budget window');
      seen.add(key);
      return { ...snapshot, ...this.rows.get(key) };
    });
  }

  reserve(context: BudgetContext, limits: readonly BudgetLimit[], amountAtomic: AtomicAmount, nowMs: number): BudgetEvaluation {
    const snapshots = this.snapshot(context, limits, nowMs);
    const result = evaluateBudget(amountAtomic, snapshots);
    if (!result.allow) return result;
    const updates = snapshots.map((snapshot) => {
      integer(snapshot.calls + 1, 1);
      return {
        key: this.key(snapshot),
        row: { spentAtomic: (parseAtomicAmount(snapshot.spentAtomic) + parseAtomicAmount(amountAtomic)).toString(), calls: snapshot.calls + 1 },
      };
    });
    for (const update of updates) this.rows.set(update.key, update.row);
    this.lastReservationMs = nowMs;
    return result;
  }

  private key(snapshot: BudgetSnapshot): string {
    // Tuple encoding prevents collisions between scope names, caller identifiers and windows.
    return JSON.stringify([snapshot.scope, snapshot.id, snapshot.asset, snapshot.windowMs, snapshot.windowStartMs]);
  }
}

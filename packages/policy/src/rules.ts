import { addMinor, assertMinorAmount, decimalToMinor } from './money.js';
import { candidateSchema } from './types.js';
import type { Candidate, PolicyContext } from './types.js';

export interface RuleResult {
  rule: 'reserve_floor' | 'window_budget' | 'commitment_cap' | 'region';
  pass: boolean;
  code: string;
  detail: string;
}

export function reserveFloor(candidate: Candidate, ctx: PolicyContext): RuleResult {
  assertMinorAmount(candidate.upfrontMinor);
  assertMinorAmount(ctx.reserveHorizonDays);
  const balances = ctx.balances.filter(balance => balance.currency === candidate.currency);
  const floor = ctx.reserveFloorMinor[candidate.currency];
  if (balances.length === 0 || floor === undefined) {
    return { rule: 'reserve_floor', pass: false, code: 'reserve_unknown_currency', detail: `Missing balance or reserve floor for ${candidate.currency}` };
  }
  if (balances.length !== 1) throw new RangeError('ambiguous_currency_balance');
  const available = decimalToMinor(balances[0]!.available_amount);
  assertMinorAmount(floor);
  let obligations = 0;
  for (const obligation of ctx.knownObligations) {
    if (!Number.isSafeInteger(obligation.dueInDays)) throw new RangeError('invalid_obligation_due_days');
    assertMinorAmount(obligation.amountMinor);
    if (obligation.currency === candidate.currency && obligation.dueInDays >= 0 && obligation.dueInDays <= ctx.reserveHorizonDays) {
      obligations = addMinor(obligations, obligation.amountMinor);
    }
  }
  // Compare nonnegative integers to avoid unsafe signed subtraction or overflowing a total.
  const afterUpfront = available - candidate.upfrontMinor;
  const pass = afterUpfront >= obligations && afterUpfront - obligations >= floor;
  return { rule: 'reserve_floor', pass, code: pass ? 'reserve_ok' : 'reserve_breach', detail: `Available ${available}, upfront ${candidate.upfrontMinor}, obligations ${obligations}, floor ${floor} minor ${candidate.currency}` };
}

export function windowBudget(candidate: Candidate, ctx: PolicyContext): RuleResult {
  if (candidate.currency !== ctx.budgetCurrency) {
    return { rule: 'window_budget', pass: false, code: 'budget_currency_mismatch', detail: `Candidate ${candidate.currency}, budget ${ctx.budgetCurrency}` };
  }
  assertMinorAmount(ctx.spentInWindowMinor);
  assertMinorAmount(ctx.windowBudgetMinor);
  assertMinorAmount(candidate.perChargeMinor);
  const pass = ctx.spentInWindowMinor <= ctx.windowBudgetMinor && candidate.perChargeMinor <= ctx.windowBudgetMinor - ctx.spentInWindowMinor;
  return { rule: 'window_budget', pass, code: pass ? 'budget_ok' : 'budget_exceeded', detail: `Spent ${ctx.spentInWindowMinor}, charge ${candidate.perChargeMinor}, budget ${ctx.windowBudgetMinor} minor ${candidate.currency}` };
}

export function commitmentCap(candidate: Candidate, ctx: PolicyContext): RuleResult {
  assertMinorAmount(candidate.commitmentMonths);
  assertMinorAmount(ctx.maxCommitmentMonths);
  const pass = candidate.commitmentMonths <= ctx.maxCommitmentMonths;
  return { rule: 'commitment_cap', pass, code: pass ? 'commitment_ok' : 'commitment_too_long', detail: `Commitment ${candidate.commitmentMonths}, maximum ${ctx.maxCommitmentMonths} months` };
}

/** Availability is resolved for billingCountry/cardCountry upstream; never use IP or citizenship. */
export function region(candidate: Candidate, ctx: PolicyContext): RuleResult {
  const pass = candidate.availability === 'available';
  return { rule: 'region', pass, code: pass ? 'region_ok' : 'region_unavailable', detail: `Billing country ${ctx.billingCountry}, card country ${ctx.cardCountry}: ${candidate.availability}` };
}

export function evaluateRules(candidate: Candidate, ctx: PolicyContext): RuleResult[] {
  candidateSchema.parse(candidate);
  return [reserveFloor(candidate, ctx), windowBudget(candidate, ctx), commitmentCap(candidate, ctx), region(candidate, ctx)];
}

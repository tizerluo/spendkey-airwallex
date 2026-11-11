import { evaluateRules } from './rules.js';
import type { RuleResult } from './rules.js';
import type { Candidate, PolicyContext } from './types.js';

export interface PurchaseDecision {
  action: 'ask' | 'refuse';
  chosen?: Candidate;
  ranked: { candidate: Candidate; results: RuleResult[]; passed: boolean }[];
  reasons: string[];
}

export function decidePurchase(candidates: readonly Candidate[], ctx: PolicyContext): PurchaseDecision {
  // Compare costs only within the budget currency. Keep the other candidates
  // in input order after the ranking so callers can explain their exclusion.
  const notBudgeted = candidates.filter(candidate => candidate.currency !== ctx.budgetCurrency).map(candidate => ({
    candidate,
    results: [{ rule: 'window_budget', pass: false, code: 'currency_not_budgeted',
      detail: `Candidate ${candidate.currency}, budget ${ctx.budgetCurrency}` } satisfies RuleResult],
    passed: false,
  }));
  const ranked = candidates.filter(candidate => candidate.currency === ctx.budgetCurrency).map(candidate => {
    const results = evaluateRules(candidate, ctx);
    return { candidate, results, passed: results.every(result => result.pass) };
  }).sort((a, b) => Number(b.passed) - Number(a.passed)
    || a.candidate.horizonCost.highMinor - b.candidate.horizonCost.highMinor
    || a.candidate.upfrontMinor - b.candidate.upfrontMinor);
  ranked.push(...notBudgeted);
  const chosen = ranked.find(entry => entry.passed)?.candidate;
  if (chosen === undefined) {
    return { action: 'refuse', ranked, reasons: [...new Set(ranked.flatMap(entry => entry.results.filter(result => !result.pass).map(result => result.code)))] };
  }
  const reasons = ['human_approval_required'];
  if (chosen.priceStatus === 'price_unverified') reasons.push('price_unverified');
  if (chosen.merchantCategoryCode === undefined) reasons.push('mcc_required_at_approval');
  if (notBudgeted.length > 0) reasons.push('currency_not_budgeted');
  return { action: 'ask', chosen, ranked, reasons };
}

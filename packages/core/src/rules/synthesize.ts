import { ProbsSchema, type Decision, type Probs } from '@sr/schema';

function distribution(values: Record<string, number>, labels: readonly string[]): boolean {
  return Object.keys(values).length === labels.length
    && labels.every((label) => values[label] !== undefined)
    && Math.abs(Object.values(values).reduce((sum, p) => sum + p, 0) - 1) <= 1e-6;
}

/** Spend gates payment. Route confidence does not change its threshold.
 * Named spend outcomes use true/false or pay/refuse/ask; true/pay and scalar spend
 * share the same positive-probability thresholds, regardless of competing outcomes.
 * Optional risk is P(high) as a scalar, or a low/mid/high distribution. High risk vetoes
 * payment (including ties); missing spend and malformed probability shapes fail closed.
 */
export function synthesize(probs: Probs): Decision {
  const parsed = ProbsSchema.safeParse(probs);
  if (!parsed.success) return { action: 'refuse', reasons: ['invalid_probabilities'], probs: {} };
  const safe = parsed.data;
  const spend = safe.spend;
  if (typeof spend === 'object' && !distribution(spend, ['true', 'false']) && !distribution(spend, ['pay', 'refuse', 'ask'])) {
    return { action: 'refuse', reasons: ['invalid_spend_probabilities'], probs: safe };
  }
  const p = typeof spend === 'number' ? spend : spend?.true ?? spend?.pay;
  if (p === undefined) return { action: 'refuse', reasons: ['spend_probability_required'], probs: safe };
  const risk = safe.risk;
  if (typeof risk === 'object' && !distribution(risk, ['low', 'mid', 'high'])) {
    return { action: 'refuse', reasons: ['invalid_risk_probabilities'], probs: safe };
  }
  const highRisk = typeof risk === 'number' ? risk >= 0.5
    : risk !== undefined && risk.high! >= Math.max(risk.low!, risk.mid!);
  if (highRisk) return { action: 'refuse', reasons: ['risk_high'], probs: safe };
  const action: Decision['action'] = p >= 0.7 ? 'pay' : p >= 0.4 ? 'ask' : 'refuse';
  return { action, reasons: [action === 'pay' ? 'spend_confident' : action === 'ask' ? 'spend_needs_approval' : 'spend_low_probability'], probs: safe };
}

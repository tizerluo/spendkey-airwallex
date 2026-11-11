import type { Decision, GuardReq, GuardResult, Probs } from '@sr/schema';
import { evaluateBudget, parseAtomicAmount, type BudgetSnapshot } from '../budget/index.js';
import { synthesize } from './synthesize.js';

/** v1's Celo alias is accepted internally; the public GuardReq schema stays unchanged. */
export type HardRuleRequest = Omit<GuardReq, 'quote'> & {
  quote: Omit<GuardReq['quote'], 'network'> & { network: string };
  /** Trusted catalog metadata, supplied by the server rather than the client. */
  category?: string;
  requiresSelf?: boolean;
  /** Trusted verifier result supplied by the server, never a client assertion. */
  selfProofVerified?: boolean;
};

export interface TokenRule {
  asset: GuardReq['quote']['asset'];
  decimals: number;
}

export interface HardRulePolicy {
  /** Defaults to Celo only. An explicit empty list denies every chain. */
  allowedChains?: readonly string[];
  allowedTokens: readonly TokenRule[];
  blacklistedPayTo?: readonly string[];
  blacklistedHosts?: readonly string[];
  forbiddenCategories?: readonly string[];
  requireSelfProof?: boolean;
  /** Human-readable token units, like GuardReq.maxSpend. No implicit USD conversion. */
  maxSpend?: GuardReq['maxSpend'];
  /** Current trusted snapshots for all applicable wallet/key/team windows. */
  budgets?: readonly BudgetSnapshot[];
}

export type GuardDecision = Decision & Pick<GuardResult, 'maxAmountAtomic'>;

/** Floors excess decimal precision so conversion never increases a spend cap. */
export function spendCapToAtomic(cap: GuardReq['maxSpend'], decimals: number): bigint {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) throw new RangeError('Invalid token decimals');
  if (typeof cap !== 'string' || !/^\d+(?:\.\d+)?$/.test(cap)) throw new RangeError('Invalid spend cap');
  const [whole, fraction = ''] = cap.split('.');
  return BigInt(`${whole}${fraction.slice(0, decimals).padEnd(decimals, '0')}`);
}

function normalizeChain(chain: string): string {
  return chain === 'celo' ? 'eip155:42220' : chain;
}

function normalizeHost(host: string): string {
  // Accept only a host, never a URL, credentials, port or escaped authority.
  if (!host || /[\s\\/?#@%]/u.test(host) || (host.includes(':') && !/^\[[0-9a-f:.]+\]$/i.test(host))) {
    throw new Error('Invalid hostname');
  }
  // WHATWG URL applies the same IDNA conversion as request URL parsing.
  const url = new URL(`https://${host}/`);
  const canonical = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!canonical || url.host !== url.hostname) throw new Error('Invalid hostname');
  if (!canonical.startsWith('[') && (canonical.length > 253 || canonical.split('.').some((label) =>
    label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))) {
    throw new Error('Invalid hostname');
  }
  return canonical;
}

function result(action: Decision['action'], reasons: string[], amount: string, probs: Probs): GuardDecision {
  return { action, reasons, probs, maxAmountAtomic: action === 'pay' ? amount : '0' };
}

/** Pure hard vetoes. Passing means eligible for synthesis, not a reservation or proof verification. */
export function evaluateHardRules(request: HardRuleRequest, policy: HardRulePolicy): GuardDecision {
  const reasons: string[] = [];
  const address = /^0x[0-9a-fA-F]{40}$/;
  let host: string;
  try {
    const url = new URL(request.url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid URL');
    host = normalizeHost(url.hostname);
    if (!address.test(request.payer) || !address.test(request.quote.asset) || !address.test(request.quote.payTo)
      || !request.intent?.trim() || !request.quote.network) throw new Error('Invalid guard request');
    parseAtomicAmount(request.quote.amountAtomic);
  } catch {
    return result('refuse', ['invalid_request'], '0', {});
  }
  const network = normalizeChain(request.quote.network);
  // This implementation handles Celo token budgets only, even if policy accidentally lists another chain.
  if (network !== 'eip155:42220' || !(policy.allowedChains ?? ['eip155:42220']).some((chain) => normalizeChain(chain) === network)) {
    reasons.push('chain_not_allowed');
  }
  const asset = request.quote.asset.toLowerCase();
  const tokens = policy.allowedTokens.filter((token) => token.asset.toLowerCase() === asset);
  if (tokens.length === 0) reasons.push('token_not_allowed');
  try {
    if (tokens.length > 1) throw new Error('Duplicate token configuration');
    // Validate maxSpend even when the token is denied.
    const decimals = tokens[0]?.decimals ?? 0;
    const amount = parseAtomicAmount(request.quote.amountAtomic);
    if (amount > spendCapToAtomic(request.maxSpend, decimals)) reasons.push('max_spend_exceeded');
    if (policy.maxSpend !== undefined && amount > spendCapToAtomic(policy.maxSpend, decimals)) reasons.push('policy_max_spend_exceeded');
  } catch {
    reasons.push('invalid_spend_cap');
  }
  if (policy.blacklistedPayTo?.some((payTo) => payTo.toLowerCase() === request.quote.payTo.toLowerCase())) {
    reasons.push('recipient_blacklisted');
  }
  try {
    // Normalize all entries first so an earlier match cannot hide invalid policy.
    const blacklist = policy.blacklistedHosts?.map(normalizeHost) ?? [];
    if (blacklist.some((entry) => host === entry || host.endsWith(`.${entry}`))) reasons.push('host_blacklisted');
  } catch {
    reasons.push('invalid_host_blacklist');
  }
  if (policy.forbiddenCategories?.length) {
    if (!request.category?.trim()) reasons.push('category_required');
    else if (policy.forbiddenCategories.some((category) => category.trim().toLowerCase() === request.category!.trim().toLowerCase())) {
      reasons.push('category_forbidden');
    }
  }
  if ((policy.requireSelfProof || request.requiresSelf) && request.selfProofVerified !== true) reasons.push('self_proof_required');
  try {
    for (const budget of policy.budgets ?? []) {
      if (budget.asset.toLowerCase() !== asset || (budget.scope === 'wallet' && budget.id.toLowerCase() !== request.payer.toLowerCase())) {
        throw new Error('Budget context mismatch');
      }
    }
    reasons.push(...evaluateBudget(request.quote.amountAtomic, policy.budgets ?? []).reasons);
  } catch {
    reasons.push('invalid_budget');
  }
  return result(reasons.length ? 'refuse' : 'pay', reasons.length ? reasons : ['hard_rules_passed'], request.quote.amountAtomic, {});
}

/** A model decision cannot override a hard veto. Approval and signed audit metadata are added by the API. */
export function evaluateGuard(request: HardRuleRequest, policy: HardRulePolicy, probs: Probs): GuardDecision {
  const hard = evaluateHardRules(request, policy);
  if (hard.action === 'refuse') return hard;
  const decision = synthesize(probs);
  return result(decision.action, [...hard.reasons, ...decision.reasons], request.quote.amountAtomic, decision.probs);
}

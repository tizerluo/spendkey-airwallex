import { randomUUID } from 'node:crypto';
import { listAllOffers, type OfferSource } from '@sk/offers';
import { compareOffers, type UsageProfile } from '@sk/compare';
import { createApprovalRequest, decidePurchase, type ApprovalRequest, type PolicyContext } from '@sk/policy';
import type { LedgerStore } from '@sk/ledger';

export interface AgentContext extends Omit<PolicyContext, 'balances' | 'spentInWindowMinor'> {
  balanceProvider: () => Promise<PolicyContext['balances']>;
  spentInWindowMinor: () => number | Promise<number>;
  now?: () => Date;
}
export interface ApprovalServiceClient {
  submit(request: ApprovalRequest): Promise<{ id: string }>;
}

/** The only output authority here is an approval request; balances are read-only. */
export async function runAgent({ intent, usage, ctx, sources, ledger, approvalService }: {
  intent: string; usage: UsageProfile; ctx: AgentContext; sources: readonly OfferSource[];
  ledger: LedgerStore; approvalService: ApprovalServiceClient;
}) {
  const now = ctx.now?.() ?? new Date();
  const { offers, errors } = await listAllOffers(sources, {
    intent, billingCountry: ctx.billingCountry, cardCountry: ctx.cardCountry,
  });
  ledger.append({ kind: 'offers_snapshot', intent, offers: offers.map(offer => ({
    offerId: offer.id, vendor: offer.vendor, product: offer.product, plan: offer.plan, rail: offer.rail,
    price: offer.price, priceStatus: offer.priceStatus, availability: offer.availability,
  })) }, now.toISOString());
  const comparison = compareOffers(offers, usage);
  const prices = new Map(offers.map(offer => [offer.id, offer.price]));
  ledger.append({ kind: 'comparison', candidates: comparison.candidates.map(candidate => ({
    offerId: candidate.offerId, rail: candidate.rail, price: prices.get(candidate.offerId)!, upfrontMinor: candidate.upfrontMinor,
    perChargeMinor: candidate.perChargeMinor, horizonLowMinor: candidate.horizonCost.lowMinor,
    horizonHighMinor: candidate.horizonCost.highMinor, notes: candidate.notes,
  })), excluded: comparison.excluded }, now.toISOString());
  const decision = decidePurchase(comparison.candidates, {
    ...ctx, balances: await ctx.balanceProvider(), spentInWindowMinor: await ctx.spentInWindowMinor(),
  });
  ledger.append({ kind: 'decision', action: decision.action,
    ...(decision.chosen === undefined ? {} : { chosenOfferId: decision.chosen.offerId }),
    reasons: decision.reasons, ruleResults: decision.ranked.flatMap(({ candidate, results }) =>
      results.map(({ rule, pass, code }) => ({ offerId: candidate.offerId, rule, pass, code }))),
  }, now.toISOString());
  if (decision.action !== 'ask' || decision.chosen === undefined) return { decision, errors };
  const request = createApprovalRequest(decision.chosen, {
    approvalRequestId: randomUUID(), createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
  });
  const submitted = await approvalService.submit(request);
  return { decision, errors, request, approvalRequestId: submitted.id };
}

/** Explicitly injected transport; never falls back to ambient network access. */
export function httpApprovalService(baseUrl: string, fetch: typeof globalThis.fetch): ApprovalServiceClient {
  return { async submit(request) {
    const response = await fetch(new URL('/approvals', baseUrl), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error('approval_submission_failed');
    const result: unknown = await response.json();
    if (typeof result !== 'object' || result === null || !('id' in result) || typeof result.id !== 'string') {
      throw new Error('invalid_approval_response');
    }
    return { id: result.id };
  } };
}

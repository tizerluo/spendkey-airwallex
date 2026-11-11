import { z } from 'zod';
import { signedDecimalToMinor } from './money.js';

const text = z.string().min(1);
const iso = z.string().datetime({ offset: true });
const minor = z.number().int().nonnegative().safe();
const currency = z.string().regex(/^[A-Z]{3}$/);
const mcc = z.string().regex(/^\d{4}$/);
const rail = z.enum(['card', 'x402']);
const requiredUnknown = z.unknown().refine(value => value !== undefined, 'required_json_value');
// Native offer unit prices can be millionths (x402/USDC-style), independently of card currency scale.
const offerPrice = z.object({
  amount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/), currency,
  unit: z.enum(['per_month', 'per_year', 'per_call', 'per_1k_units', 'one_time']),
}).strict();

/** The M3 card contract, independent of the frozen @sr/schema audit union. */
const CardAuditEventUnion = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('offers_snapshot'), intent: z.string(),
    offers: z.array(z.object({
      offerId: text, vendor: text, product: text,
      plan: z.enum(['monthly', 'annual', 'usage', 'one_time']), rail,
      price: offerPrice,
      priceStatus: z.enum(['verified', 'price_unverified']),
      availability: z.enum(['available', 'region_unavailable']),
    }).strict()),
  }).strict(),
  z.object({
    kind: z.literal('comparison'),
    candidates: z.array(z.object({
      offerId: text, rail, upfrontMinor: minor, perChargeMinor: minor,
      horizonLowMinor: minor, horizonHighMinor: minor, notes: z.array(z.string()),
      // Optional for older ledgers; preserves the native unit price alongside derived minor totals.
      price: offerPrice.optional(),
    }).strict()),
    excluded: z.array(z.object({ offerId: text, reason: z.string() }).strict()),
  }).strict(),
  z.object({
    kind: z.literal('decision'), action: z.enum(['ask', 'refuse']), chosenOfferId: text.optional(),
    reasons: z.array(z.string()),
    ruleResults: z.array(z.object({ offerId: text, rule: text, pass: z.boolean(), code: text }).strict()),
  }).strict(),
  z.object({
    kind: z.literal('approval_requested'), approvalRequestId: text, offerId: text,
    presentedTermsHash: text, amountMinor: minor, currency,
    interval: z.enum(['PER_TRANSACTION', 'MONTHLY', 'ALL_TIME']),
    allowedTransactionCount: z.enum(['SINGLE', 'MULTIPLE']),
    merchantCategoryCode: mcc.optional(), expiresAt: iso,
  }).strict(),
  z.object({
    kind: z.literal('approval_granted'), approvalRequestId: text, approvalId: text,
    termsHash: text, presentedTermsHash: text,
    approver: z.object({ kind: z.literal('human'), id: text }).strict(),
    merchantCategoryCode: mcc, approvedAt: iso, demoAutoApproved: z.boolean(),
  }).strict(),
  z.object({ kind: z.literal('approval_rejected'), approvalRequestId: text, code: text }).strict(),
  z.object({
    kind: z.literal('card_issued'), approvalId: text, requestId: text,
    cardId: text.optional(), cardStatus: text.optional(), maskedNumber: text.optional(),
    controls: requiredUnknown, rawResponseRef: text.optional(),
  }).strict(),
  z.object({
    kind: z.literal('card_issue_unconfirmed'), approvalId: text, requestId: text,
    reason: z.string(), rawResponseRef: text.optional(),
  }).strict(),
  z.object({
    kind: z.literal('authorization'), source: z.enum(['simulated', 'observed']),
    cardId: text, amount: z.string(), currency, merchantCategoryCode: mcc.optional(),
    merchantName: z.string().optional(), processResult: z.string().optional(), failureReason: z.string().optional(),
    mapped: z.enum(['approved', 'limit_exceeded', 'merchant_category_not_allowed', 'currency_not_allowed', 'card_inactive', 'other']),
    transactionId: text.optional(),
  }).strict(),
  z.object({ kind: z.literal('card_frozen'), cardId: text, by: z.enum(['agent', 'human']), reason: z.string() }).strict(),
  z.object({
    kind: z.literal('reconciliation'), cardId: text, window: z.object({ from: iso, to: iso }).strict(),
    settledMinor: z.number().int().safe(), pendingMinor: z.number().int().safe(),
    failedCount: minor, transactionIds: z.array(text),
  }).strict(),
  z.object({ kind: z.literal('webhook_received'), eventId: text, name: text, deduped: z.boolean(),
    processResult: z.enum(['success', 'error']).optional() }).strict(),
  z.object({ kind: z.literal('raw_response'), ref: text, endpoint: text, status: z.number().int().min(100).max(599), body: requiredUnknown }).strict(),
]);

// Card amounts retain the currency exponent; native offer prices use their own schema.
export const CardAuditEventSchema = CardAuditEventUnion.superRefine((event, context) => {
  if (event.kind !== 'authorization') return;
  try { signedDecimalToMinor(event.amount, event.currency); }
  catch { context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid_signed_decimal', path: ['amount'] }); }
});

// Zod 3 infers unknown properties as optional, even with the runtime required
// refinement. Keep the public contract's controls/body fields required.
type RequirePayload<T> = T extends { kind: 'card_issued' }
  ? Omit<T, 'controls'> & { controls: unknown }
  : T extends { kind: 'raw_response' } ? Omit<T, 'body'> & { body: unknown } : T;
export type CardAuditEvent = RequirePayload<z.infer<typeof CardAuditEventSchema>>;

export const LedgerEventSchema = z.object({
  seq: minor, at: iso, prevHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  hash: z.string().regex(/^0x[0-9a-f]{64}$/), event: CardAuditEventSchema,
}).strict();

export type LedgerEvent = Omit<z.infer<typeof LedgerEventSchema>, 'event'> & { event: CardAuditEvent };

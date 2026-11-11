import { z } from 'zod';
import { digitCount, hasMaskChar, isPanLike, redactBody } from './redact.js';

/** Amounts retain the API's decimal string or JSON number; no numeric coercion. */
export const amountSchema = z.union([z.string().regex(/^-?\d+(?:\.\d+)?$/), z.number().finite()]);
export type Amount = z.infer<typeof amountSchema>;
/** Outgoing amounts must be positive, finite and have at most two decimal places. */
export const requestAmountSchema = z.union([
  z.string().regex(/^\d+(?:\.\d{1,2})?$/),
  z.number().finite().positive().refine(value => Number(value.toFixed(2)) === value),
]).refine(value => Number.isFinite(Number(value)) && Number(value) > 0);
export const loginSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string().refine(value => Number.isFinite(Date.parse(value))),
});
export type LoginResponse = z.infer<typeof loginSchema>;

export const balanceSchema = z.object({
  currency: z.string(), available_amount: amountSchema, pending_amount: amountSchema,
  reserved_amount: amountSchema, total_amount: amountSchema, prepayment_amount: amountSchema,
  account_type: z.string(),
});
export const balancesSchema = z.array(balanceSchema);
export type Balance = z.infer<typeof balanceSchema>;
export const issuingConfigSchema = z.object({
  primary_currency: z.string(),
  enable_auto_conversion: z.boolean().optional(),
  spending_limit_settings: z.object({
    per_transaction_limits: z.array(z.object({ currency: z.string(), default: amountSchema, maximum: amountSchema })),
  }).optional(),
});
export type IssuingConfig = z.infer<typeof issuingConfigSchema>;

export const cardholderInputSchema = z.object({
  request_id: z.string().optional(),
  email: z.string().email(), type: z.literal('INDIVIDUAL'), mobile_number: z.string(),
  individual: z.object({
    name: z.object({ first_name: z.string(), last_name: z.string(), middle_name: z.string().optional() }),
    date_of_birth: z.string(), express_consent_obtained: z.enum(['yes', 'no']), nationality: z.string(),
    address: z.object({
      line1: z.string(), line2: z.string().optional(), city: z.string(), state: z.string(),
      postcode: z.string(), country: z.string(),
    }),
  }),
});
export type CreateCardholderInput = z.input<typeof cardholderInputSchema>;
export const cardholderSchema = z.object({
  cardholder_id: z.string(), status: z.string(),
  email: z.string().email().optional(), type: z.string().optional(),
  mobile_number: z.string().optional(),
  // Consent and nationality are create-only fields and may be omitted on reads.
  individual: cardholderInputSchema.shape.individual.omit({ express_consent_obtained: true, nationality: true }).partial().optional(),
});
export type Cardholder = z.infer<typeof cardholderSchema>;

export const transactionLimitSchema = z.object({ amount: amountSchema, interval: z.string().min(1) });
export const authorizationControlsSchema = z.object({
  allowed_transaction_count: z.enum(['SINGLE', 'MULTIPLE']),
  allowed_currencies: z.array(z.string()), allowed_merchant_categories: z.array(z.string()),
  transaction_limits: z.object({ currency: z.string(), limits: z.array(transactionLimitSchema).min(1) }),
});
export type AuthorizationControls = z.infer<typeof authorizationControlsSchema>;
export const authorizationControlsInputSchema = authorizationControlsSchema.extend({
  transaction_limits: authorizationControlsSchema.shape.transaction_limits.extend({
    limits: z.array(transactionLimitSchema.extend({ amount: requestAmountSchema })).min(1),
  }),
});
export const createCardInputSchema = z.object({
  request_id: z.string().min(1).max(50), cardholder_id: z.string().min(1),
  created_by: z.string().min(1), form_factor: z.literal('VIRTUAL'), is_personalized: z.boolean(),
  program: z.object({ purpose: z.string().min(1) }), nick_name: z.string(),
  authorization_controls: authorizationControlsInputSchema,
});
export type CreateCardInput = z.input<typeof createCardInputSchema>;
export const cardStatusSchema = z.enum(['ACTIVE', 'INACTIVE', 'CLOSED']);
export type CardStatus = z.infer<typeof cardStatusSchema>;
// 只接受掩码卡号。数字总数不超过 12（BIN 可见掩码通常是 10 位），连续 13 位同样拒绝。
const maskedNumberSchema = z.string().refine(value => hasMaskChar(value) && !/\d{13,}/.test(value) && digitCount(value) <= 12);

/** 掩码 schema 接受的值保留。其余只要像完整卡号（不论有没有掩码字符）就丢掉并打标。 */
function dropPanLike(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = { ...value } as Record<string, unknown>;
  for (const key of ['card_number', 'masked_card_number']) {
    const number = result[key];
    if (typeof number !== 'string' && typeof number !== 'number') continue;
    const text = String(number);
    if (maskedNumberSchema.safeParse(text).success) continue;
    if (!isPanLike(text)) continue;
    delete result[key];
    result['panLikeValueDropped'] = true;
  }
  return result;
}
const cardObjectSchema = z.object({
  card_id: z.string().min(1), card_status: z.string(), brand: z.string().optional(),
  request_id: z.string().optional(), created_at: z.string().optional(),
  panLikeValueDropped: z.literal(true).optional(),
  card_number: maskedNumberSchema.optional(), masked_card_number: maskedNumberSchema.optional(),
  cardholder_id: z.string().optional(), created_by: z.string().optional(),
  form_factor: z.string().optional(), is_personalized: z.boolean().optional(), nick_name: z.string().optional(),
  program: z.object({ purpose: z.string(), type: z.string().optional(), sub_type: z.string().optional() }).optional(),
  authorization_controls: authorizationControlsSchema.optional(),
  alert_settings: z.object({
    low_remaining_transaction_limit: z.object({ enabled: z.boolean(), percent: z.number() }),
  }).optional(),
});
export const cardSchema = z.preprocess(dropPanLike, cardObjectSchema);
// A created card ID remains usable even if status or controls have a new shape.
const lenientCardObjectSchema = cardObjectSchema.partial().extend({ card_id: z.string().min(1) });
export type Card = z.infer<typeof lenientCardObjectSchema>;
export function parseCardLenient(value: unknown): Card | undefined {
  const cleaned = dropPanLike(value);
  if (cleaned === null || typeof cleaned !== 'object' || Array.isArray(cleaned)) return undefined;
  const fields = Object.fromEntries(Object.entries(lenientCardObjectSchema.shape).flatMap(([key, schema]) => {
    const parsed = schema.safeParse((cleaned as Record<string, unknown>)[key]);
    return parsed.success && parsed.data !== undefined ? [[key, parsed.data]] : [];
  }));
  const parsed = lenientCardObjectSchema.safeParse(fields);
  return parsed.success ? parsed.data : undefined;
}
export type CreateCardResult =
  | { ok: true; unconfirmed: false; card: z.infer<typeof cardSchema>; raw: unknown }
  | { ok: true; unconfirmed: true; card?: Card; raw: unknown };

/** Local bound, not a documented API limit; generated approval nicknames use 48 characters. */
export const CARD_NICKNAME_MAX_LENGTH = 50;
export function cardNicknameFromRequestId(requestId: string): string {
  return `spk ${requestId}`.slice(0, CARD_NICKNAME_MAX_LENGTH);
}
export interface ListCardsInput {
  cardholderId?: string; createdAfter?: string; createdBefore?: string;
  updatedAfter?: string; updatedBefore?: string; status?: string; nickName?: string;
  pageSize?: number;
}
export interface CardsResponse { items: Card[]; unparsed: unknown[] }
/** items 优先，其次 data、results。has_more 可以缺省。 */
export const cardsPageSchema = z.object({
  items: z.array(z.unknown()).optional(),
  data: z.array(z.unknown()).optional(),
  results: z.array(z.unknown()).optional(),
  has_more: z.boolean().optional(),
}).transform((page): { items: unknown[]; has_more: boolean | undefined } => ({
  items: page.items ?? page.data ?? page.results ?? [],
  has_more: page.has_more,
}));
export const cardLimitsSchema = z.object({
  currency: z.string(), limits: z.array(transactionLimitSchema.extend({ remaining: amountSchema })),
});
export type CardLimits = z.infer<typeof cardLimitsSchema>;

export const merchantInfoSchema = z.object({
  name: z.string().optional(), city: z.string().optional(), country: z.string().optional(),
}).catchall(z.string());
export const simulationInputSchema = z.object({
  card_id: z.string(), transaction_amount: requestAmountSchema, transaction_currency: z.string(),
  merchant_category_code: z.string(), merchant_info: merchantInfoSchema.optional(),
});
export type SimulateAuthorizationInput = z.input<typeof simulationInputSchema>;
/** Unknown and unrecognized optional fields remain available as safe evidence. */
function withExtra<T extends z.ZodRawShape>(shape: T) {
  const schema = z.object(shape);
  return z.unknown().transform((value, context) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) context.addIssue(issue);
      return z.NEVER;
    }
    const extra = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key, item]) =>
      !Object.hasOwn(shape, key) || (parsed.data[key] === undefined && item !== undefined),
    ));
    return { ...parsed.data, extra: redactBody(extra) };
  });
}
const responseMerchantSchema = withExtra({
  name: z.string().optional().catch(undefined), category_code: z.string().optional().catch(undefined),
  city: z.string().optional().catch(undefined), country: z.string().optional().catch(undefined),
});

export const simulationSchema = z.preprocess(dropPanLike, withExtra({
  process_result: z.string().optional().catch(undefined), failure_reason: z.string().nullable().optional().catch(undefined),
  card_transaction_id: z.string().optional().catch(undefined), card_transaction_lifecycle_id: z.string().optional().catch(undefined),
  auth_code: z.string().optional().catch(undefined), masked_card_number: maskedNumberSchema.optional().catch(undefined),
  panLikeValueDropped: z.literal(true).optional(),
  merchant: responseMerchantSchema.optional().catch(undefined),
  merchant_info: responseMerchantSchema.optional().catch(undefined),
  network_transaction_id: z.string().optional().catch(undefined),
}));
export type SimulationResult = z.infer<typeof simulationSchema>;
/** REFUND、REVERSAL，以及任意 *_REVERSAL（忽略大小写）且 API 金额为正时取负。不改写 transaction_amount。 */
function signedAmountFor(type: string | undefined, amount: Amount): Amount {
  const normalized = type?.toUpperCase();
  const reversing = normalized === 'REFUND' || normalized === 'REVERSAL' || normalized?.endsWith('_REVERSAL') === true;
  if (!reversing) return amount;
  if (typeof amount === 'number') return amount > 0 ? -amount : amount;
  if (amount.startsWith('-') || Number(amount) <= 0) return amount;
  return `-${amount}`;
}
export const transactionSchema = z.preprocess(dropPanLike, withExtra({
  transaction_id: z.string().min(1), card_id: z.string().optional(),
  transaction_type: z.string().optional(), status: z.string().optional(),
  transaction_amount: amountSchema, transaction_currency: z.string(),
  billing_amount: amountSchema.optional(), billing_currency: z.string().optional(),
  card_transaction_id: z.string().optional(), card_transaction_lifecycle_id: z.string().optional(),
  merchant: responseMerchantSchema.optional(), merchant_info: responseMerchantSchema.optional(),
  failure_reason: z.string().nullable().optional(), transaction_date: z.string().optional(),
  masked_card_number: maskedNumberSchema.optional().catch(undefined), panLikeValueDropped: z.literal(true).optional(),
})).transform(transaction => ({
  ...transaction,
  signedAmount: signedAmountFor(transaction.transaction_type, transaction.transaction_amount),
}));
export type IssuingTransaction = z.infer<typeof transactionSchema>;
export const transactionsSchema = z.object({
  items: z.array(z.unknown()), has_more: z.boolean().optional(),
  page_num: z.number().int().optional(), page_size: z.number().int().optional(),
}).transform(({ items, ...page }) => {
  const parsedItems: IssuingTransaction[] = [];
  const unparsed: unknown[] = [];
  for (const item of items) {
    const parsed = transactionSchema.safeParse(item);
    if (parsed.success) parsedItems.push(parsed.data);
    else unparsed.push(redactBody(item));
  }
  return { ...page, items: parsedItems, unparsed };
});
export type TransactionsResponse = z.infer<typeof transactionsSchema>;
export interface ListTransactionsInput { card_id?: string; from?: string; to?: string; page?: number }

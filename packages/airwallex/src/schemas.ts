import { z } from 'zod';

/** Amounts retain the API's decimal string or JSON number; no numeric coercion. */
export const amountSchema = z.union([z.string().regex(/^-?\d+(?:\.\d+)?$/), z.number().finite()]);
export type Amount = z.infer<typeof amountSchema>;
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
export const createCardInputSchema = z.object({
  request_id: z.string().min(1).max(50).optional(), cardholder_id: z.string().min(1),
  created_by: z.string().min(1), form_factor: z.literal('VIRTUAL'), is_personalized: z.boolean(),
  program: z.object({ purpose: z.string().min(1) }), nick_name: z.string(),
  authorization_controls: authorizationControlsSchema,
});
export type CreateCardInput = z.input<typeof createCardInputSchema>;
export const cardStatusSchema = z.enum(['ACTIVE', 'INACTIVE', 'CLOSED']);
export type CardStatus = z.infer<typeof cardStatusSchema>;
// Only masked card numbers are accepted; unknown response fields (including CVV) are stripped.
const maskedNumberSchema = z.string().regex(/^[*xX•]+\d{4}$/);
export const cardSchema = z.object({
  card_id: z.string(), card_status: z.string(), brand: z.string().optional(),
  card_number: maskedNumberSchema.optional(), masked_card_number: maskedNumberSchema.optional(),
  cardholder_id: z.string().optional(), created_by: z.string().optional(),
  form_factor: z.string().optional(), is_personalized: z.boolean().optional(), nick_name: z.string().optional(),
  program: z.object({ purpose: z.string(), type: z.string().optional(), sub_type: z.string().optional() }).optional(),
  authorization_controls: authorizationControlsSchema.optional(),
  alert_settings: z.object({
    low_remaining_transaction_limit: z.object({ enabled: z.boolean(), percent: z.number() }),
  }).optional(),
});
export type Card = z.infer<typeof cardSchema>;
export const cardLimitsSchema = z.object({
  currency: z.string(), limits: z.array(transactionLimitSchema.extend({ remaining: amountSchema })),
});
export type CardLimits = z.infer<typeof cardLimitsSchema>;

export const merchantInfoSchema = z.object({
  name: z.string().optional(), city: z.string().optional(), country: z.string().optional(),
}).catchall(z.string());
export const simulationInputSchema = z.object({
  card_id: z.string(), transaction_amount: amountSchema, transaction_currency: z.string(),
  merchant_category_code: z.string(), merchant_info: merchantInfoSchema.optional(),
});
export type SimulateAuthorizationInput = z.input<typeof simulationInputSchema>;
export const simulationSchema = z.object({
  process_result: z.enum(['APPROVED', 'DECLINED']), failure_reason: z.string().nullable().optional(),
  card_transaction_id: z.string().optional(), card_transaction_lifecycle_id: z.string().optional(),
  auth_code: z.string().optional(), masked_card_number: maskedNumberSchema.optional(),
  merchant: z.object({ name: z.string().optional(), category_code: z.string().optional() }).optional(),
  network_transaction_id: z.string().optional(),
});
export type SimulationResult = z.infer<typeof simulationSchema>;
export const transactionSchema = z.object({
  transaction_id: z.string(), card_id: z.string(), transaction_type: z.string(), status: z.string(),
  transaction_amount: amountSchema, transaction_currency: z.string(),
  billing_amount: amountSchema.optional(), billing_currency: z.string().optional(),
  failure_reason: z.string().nullable().optional(), transaction_date: z.string().optional(),
  masked_card_number: maskedNumberSchema.optional(),
});
export type IssuingTransaction = z.infer<typeof transactionSchema>;
export const transactionsSchema = z.object({
  items: z.array(transactionSchema), has_more: z.boolean().optional(),
  page_num: z.number().int().optional(), page_size: z.number().int().optional(),
});
export type TransactionsResponse = z.infer<typeof transactionsSchema>;
export interface ListTransactionsInput { card_id?: string; from?: string; to?: string; page?: number }

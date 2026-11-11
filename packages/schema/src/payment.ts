import { z } from 'zod';
import {
  ActionSchema, AddressSchema, AtomicAmountSchema, HashSchema, HttpMethodSchema,
  HttpsUrlSchema, IdentifierSchema, NetworkSchema, SignatureSchema, SourceSchema,
  SpendAmountSchema, TimestampSchema,
} from './common.js';
import { DeciderSchema } from './decision.js';

export const CallSpecSchema = z.object({
  url: HttpsUrlSchema,
  method: HttpMethodSchema,
  body: z.unknown().optional(),
  /** keccak256 of the exact request-body bytes; checked by the executor. */
  bodyHash: HashSchema.optional(),
  source: SourceSchema,
  toolId: IdentifierSchema,
}).strict().superRefine((call, ctx) => {
  if (Object.hasOwn(call, 'body') && call.bodyHash === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bodyHash'], message: 'A request body requires its keccak256 hash' });
  }
});

export const PaymentSpecSchema = z.discriminatedUnion('x402Version', [
  z.object({
    x402Version: z.literal(1), network: z.literal('celo'), asset: AddressSchema,
    payTo: AddressSchema, maxAmountAtomic: AtomicAmountSchema, scoreable: z.boolean(),
  }).strict(),
  z.object({
    x402Version: z.literal(2), network: z.literal('eip155:42220'), asset: AddressSchema,
    payTo: AddressSchema, maxAmountAtomic: AtomicAmountSchema, scoreable: z.boolean(),
  }).strict(),
]);

export const PlanStepSchema = z.object({
  call: CallSpecSchema,
  pay: PaymentSpecSchema,
  fallbackOf: z.number().int().min(0).max(9).optional(),
}).strict();

export const ApprovalSchema = z.object({
  required: z.boolean(),
  approveUrl: HttpsUrlSchema,
}).strict();

export const AttributionSchema = z.object({ erc8021: z.array(z.string().min(1).max(32).regex(/^[\x20-\x7E]+$(?![\s\S])/)).min(1) }).strict();

export const PlanReqSchema = z.object({
  intent: IdentifierSchema,
  tool: IdentifierSchema.optional(),
  input: z.unknown().optional(),
  maxSpend: SpendAmountSchema,
  payer: AddressSchema,
  prefer: z.object({
    celoOnly: z.boolean().optional(), providers: z.array(IdentifierSchema).optional(),
  }).strict().optional(),
  budgetKey: IdentifierSchema.optional(),
}).strict();

export const PaymentPlanSchema = z.object({
  id: IdentifierSchema,
  payer: AddressSchema,
  nonce: HashSchema,
  action: ActionSchema,
  reasons: z.array(IdentifierSchema),
  decider: DeciderSchema,
  steps: z.array(PlanStepSchema).min(1).max(10).optional(),
  approval: ApprovalSchema.optional(),
  attribution: AttributionSchema,
  expiresAt: TimestampSchema,
  auditHash: HashSchema,
  prevHash: HashSchema,
  sig: SignatureSchema,
}).strict().superRefine((plan, ctx) => {
  if (plan.action === 'pay' && !plan.steps?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: 'Pay requires executable steps' });
  }
  if (plan.action === 'ask' && !plan.approval?.required) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['approval'], message: 'Ask requires approval' });
  }
  if (plan.action !== 'pay' && Object.hasOwn(plan, 'steps')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: 'Only pay plans may contain steps' });
  }
  if (plan.action !== 'ask' && Object.hasOwn(plan, 'approval')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['approval'], message: 'Only ask plans may contain approval' });
  }
  plan.steps?.forEach((step, index) => {
    if (step.fallbackOf !== undefined && step.fallbackOf >= index) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps', index, 'fallbackOf'], message: 'Fallback must reference an earlier step (zero-based)' });
    }
  });
});

export const GuardQuoteSchema = z.object({
  amountAtomic: AtomicAmountSchema,
  asset: AddressSchema,
  network: NetworkSchema,
  payTo: AddressSchema,
}).strict();

export const GuardReqSchema = z.object({
  url: HttpsUrlSchema,
  quote: GuardQuoteSchema,
  intent: IdentifierSchema,
  maxSpend: SpendAmountSchema,
  payer: AddressSchema,
}).strict();

export const GuardResultSchema = z.object({
  id: IdentifierSchema,
  expiresAt: TimestampSchema,
  action: ActionSchema,
  reasons: z.array(IdentifierSchema),
  maxAmountAtomic: AtomicAmountSchema,
  decider: DeciderSchema,
  auditHash: HashSchema,
  prevHash: HashSchema,
}).strict();

export const ReceiptSchema = z.object({
  planId: IdentifierSchema,
  tx: HashSchema,
  network: z.literal('eip155:42220'),
}).strict();

export type CallSpec = z.infer<typeof CallSpecSchema>;
export type PaymentSpec = z.infer<typeof PaymentSpecSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type Attribution = z.infer<typeof AttributionSchema>;
export type PlanReq = z.infer<typeof PlanReqSchema>;
export type PaymentPlan = z.infer<typeof PaymentPlanSchema>;
export type GuardQuote = z.infer<typeof GuardQuoteSchema>;
export type GuardReq = z.infer<typeof GuardReqSchema>;
export type GuardResult = z.infer<typeof GuardResultSchema>;
export type Receipt = z.infer<typeof ReceiptSchema>;

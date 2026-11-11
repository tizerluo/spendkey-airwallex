import { z } from 'zod';
import { AddressSchema, AtomicAmountSchema, HashSchema, IdentifierSchema, TimestampSchema } from './common.js';
import { DecisionSchema, DeciderSchema } from './decision.js';
import { ReceiptSchema } from './payment.js';

const eventFields = {
  id: IdentifierSchema,
  planId: IdentifierSchema,
  budgetKey: IdentifierSchema,
  /** The audit store enforces uniqueness of (budgetKey, seq). */
  seq: z.number().int().nonnegative(),
  payer: AddressSchema,
  timestamp: TimestampSchema,
  hash: HashSchema,
  prevHash: HashSchema,
  stateHash: HashSchema.optional(),
};
const decisionFields = {
  decision: DecisionSchema,
  decider: DeciderSchema,
  rules: z.array(IdentifierSchema),
  savedAmountAtomic: AtomicAmountSchema,
};

/** Append a separate receipt event; never mutate an already hashed decision event.
 * Hash recomputation and sequence uniqueness belong to the audit store.
 */
export const AuditRecordSchema = z.discriminatedUnion('kind', [
  z.object({ ...eventFields, kind: z.literal('plan'), ...decisionFields }).strict(),
  z.object({ ...eventFields, kind: z.literal('guard'), ...decisionFields }).strict(),
  z.object({ ...eventFields, kind: z.literal('receipt'), receipt: ReceiptSchema }).strict(),
  z.object({ ...eventFields, kind: z.literal('approval'), ...decisionFields }).strict(),
]);

export type AuditRecord = z.infer<typeof AuditRecordSchema>;

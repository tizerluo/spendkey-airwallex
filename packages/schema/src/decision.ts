import { z } from 'zod';
import { ActionSchema, DecisionProviderIdSchema, IdentifierSchema, ProbabilitySchema, ProbsSchema } from './common.js';

export const DeciderSchema = z.object({
  provider: DecisionProviderIdSchema,
  model: IdentifierSchema,
  transport: z.enum(['systemone', 'openai-decisions', 'chat-json', 'rules']),
  probs: ProbsSchema,
  confidence: ProbabilitySchema.optional(),
  fallback: z.boolean(),
}).strict();

export const DecisionSchema = z.object({
  action: ActionSchema,
  reasons: z.array(IdentifierSchema),
  probs: ProbsSchema,
}).strict();

export const DECISION_CHAIN_NOTE = 'Configured order. Providers without credentials on this deployment are skipped; rules always runs last.';
export const DecisionChainSchema = z.object({
  chain: z.array(DecisionProviderIdSchema).min(1).max(7),
  note: z.literal(DECISION_CHAIN_NOTE),
}).strict();

export type Decider = z.infer<typeof DeciderSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type DecisionChain = z.infer<typeof DecisionChainSchema>;

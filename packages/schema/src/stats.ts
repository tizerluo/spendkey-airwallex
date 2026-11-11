import { z } from 'zod';
import { AtomicAmountSchema, DecisionProviderIdSchema, ProbabilitySchema, TimestampSchema } from './common.js';

export const ProviderStatsSchema = z.object({
  provider: DecisionProviderIdSchema,
  calls: z.number().int().nonnegative(),
  latencyMs: z.number().finite().nonnegative(),
  fallbackRate: ProbabilitySchema,
}).strict();

export const StatsSchema = z.object({
  uniquePayers: z.number().int().nonnegative(),
  plans: z.number().int().nonnegative(),
  executionRate: ProbabilitySchema,
  refusalRate: ProbabilitySchema,
  savedAmountAtomic: AtomicAmountSchema,
  providers: z.array(ProviderStatsSchema),
  updatedAt: TimestampSchema,
}).strict();

export type ProviderStats = z.infer<typeof ProviderStatsSchema>;
export type Stats = z.infer<typeof StatsSchema>;

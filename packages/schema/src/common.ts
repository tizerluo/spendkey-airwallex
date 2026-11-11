import { z } from 'zod';

export const NetworkSchema = z.literal('eip155:42220');
/** Base-10 smallest-unit amount. Keep strings to preserve amounts above 2^53. */
export const AtomicAmountSchema = z.string().regex(/^[0-9]+$/);
/** Human-readable spend cap, distinct from an atomic amount. */
export const SpendAmountSchema = z.string().regex(/^[0-9]+(?:\.[0-9]+)?$/);
export const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const HashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const SignatureSchema = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
export const TimestampSchema = z.string().datetime({ offset: true });
export const IdentifierSchema = z.string().min(1);
export const HttpUrlSchema = z.string().url().regex(/^https?:\/\//i);
export const HttpsUrlSchema = z.string().url().regex(/^https:\/\//i);
export const DecisionProviderIdSchema = z.string().regex(/^(?:rules|typesafe:[A-Za-z0-9._-]+|openrouter:[a-z0-9-]+\/[A-Za-z0-9._-]+(?::free)?|fastino:[a-z0-9-]+\/[A-Za-z0-9._-]+)$/);
export const HttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
export const SourceSchema = z.enum(['buy', 'agent402', 'bazaar']);
export const ActionSchema = z.enum(['pay', 'refuse', 'ask']);
export const ProbabilitySchema = z.number().finite().min(0).max(1);
/** Providers may return scalar confidences or named outcome probabilities. */
export const ProbsSchema = z.record(z.union([ProbabilitySchema, z.record(ProbabilitySchema)]));

export type Network = z.infer<typeof NetworkSchema>;
export type AtomicAmount = z.infer<typeof AtomicAmountSchema>;
export type SpendAmount = z.infer<typeof SpendAmountSchema>;
export type Address = z.infer<typeof AddressSchema>;
export type Hash = z.infer<typeof HashSchema>;
export type Signature = z.infer<typeof SignatureSchema>;
export type Timestamp = z.infer<typeof TimestampSchema>;
export type Identifier = z.infer<typeof IdentifierSchema>;
export type HttpUrl = z.infer<typeof HttpUrlSchema>;
export type HttpsUrl = z.infer<typeof HttpsUrlSchema>;
export type DecisionProviderId = z.infer<typeof DecisionProviderIdSchema>;
export type HttpMethod = z.infer<typeof HttpMethodSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type Probability = z.infer<typeof ProbabilitySchema>;
export type Probs = z.infer<typeof ProbsSchema>;

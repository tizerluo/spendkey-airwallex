import { z } from 'zod';

/**
 * Integer minor units (for example cents). Always a non-negative safe integer;
 * this type is intentionally not `bigint` so candidate math stays JSON-friendly.
 */
export type MinorAmount = number;

export const MinorAmountSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, { message: 'must be a safe integer' });

const MoneyRangeSchema = z
  .object({
    lowMinor: MinorAmountSchema,
    highMinor: MinorAmountSchema,
  })
  .strict()
  .refine((range) => range.lowMinor <= range.highMinor, {
    message: 'lowMinor must not exceed highMinor',
  });

export const CandidateSchema = z
  .object({
    offerId: z.string().min(1),
    vendor: z.string().min(1),
    product: z.string().min(1),
    sourceId: z.enum(['curated', 'x402-snapshot']),
    plan: z.enum(['monthly', 'annual', 'usage', 'one_time']),
    currency: z.string().regex(/^[A-Z]{3}$/),
    merchantCategoryCode: z.string().regex(/^\d{4}$/).optional(),
    commitmentMonths: z.number().int().nonnegative(),
    priceStatus: z.enum(['verified', 'price_unverified']),
    availability: z.enum(['available', 'region_unavailable']),
    upfrontMinor: MinorAmountSchema,
    perChargeMinor: MinorAmountSchema,
    horizonCost: MoneyRangeSchema,
    monthlyRunRateMinor: MoneyRangeSchema,
    notes: z.array(z.string()),
  })
  .strict()
  .refine((candidate) => candidate.availability === 'available', {
    message: 'region_unavailable offers are not candidates',
  });

export type Candidate = z.infer<typeof CandidateSchema>;

const IntegerRangeSchema = z
  .object({
    low: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
  })
  .strict()
  .refine((range) => range.low <= range.high, {
    message: 'low must not exceed high',
  })
  .refine(
    (range) => Number.isSafeInteger(range.low) && Number.isSafeInteger(range.high),
    { message: 'range bounds must be safe integers' },
  );

export const UsageProfileSchema = z
  .object({
    horizonMonths: z.number().int().positive(),
    seats: z.number().int().positive().optional(),
    callsPerMonth: IntegerRangeSchema.optional(),
    unitsPerMonth: IntegerRangeSchema.optional(),
  })
  .strict();

export type UsageProfile = z.infer<typeof UsageProfileSchema>;

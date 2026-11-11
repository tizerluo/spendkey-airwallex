import { z } from 'zod';

/**
 * Integer minor units (for example cents). Always a non-negative safe integer;
 * this type is intentionally not `bigint` so candidate math stays JSON-friendly.
 */
export type MinorAmount = number;

export interface Candidate {
  offerId: string; vendor: string; product: string; sourceId: 'curated' | 'x402-snapshot';
  rail: 'card' | 'x402';
  plan: 'monthly' | 'annual' | 'usage' | 'one_time';
  currency: string;
  merchantCategoryCode?: string;
  commitmentMonths: number;
  priceStatus: 'verified' | 'price_unverified';
  availability: 'available' | 'region_unavailable';
  upfrontMinor: MinorAmount;
  perChargeMinor: MinorAmount;
  horizonCost: { lowMinor: MinorAmount; highMinor: MinorAmount };
  monthlyRunRateMinor: { lowMinor: MinorAmount; highMinor: MinorAmount };
  notes: string[];
}

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
    rail: z.enum(['card', 'x402']),
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
  })
  .refine(candidate => candidate.sourceId !== 'x402-snapshot' || candidate.rail === 'x402', { message: 'rail_not_card' })
  .transform((candidate): Candidate => {
    const { merchantCategoryCode, ...rest } = candidate;
    return { ...rest, ...(merchantCategoryCode === undefined ? {} : { merchantCategoryCode }) };
  });

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

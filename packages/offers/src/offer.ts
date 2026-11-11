import { z } from 'zod';

/** Decimal string; no exponent, no thousands separators, no sign. Units are never converted. */
export const DecimalAmountSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
export const CountryCodeSchema = z.string().regex(/^[A-Z]{2}$/);

export const OfferSourceIdSchema = z.enum(['curated', 'x402-snapshot']);
export const OfferPlanSchema = z.enum(['monthly', 'annual', 'usage', 'one_time']);
export const PriceUnitSchema = z.enum(['per_month', 'per_year', 'per_call', 'per_1k_units', 'one_time']);
export const PriceStatusSchema = z.enum(['verified', 'price_unverified']);
export const AvailabilitySchema = z.enum(['available', 'region_unavailable']);

export const OfferPriceSchema = z.object({
  amount: DecimalAmountSchema,
  currency: CurrencySchema,
  unit: PriceUnitSchema,
}).strict();

export const OfferRegionsSchema = z.object({
  billingCountries: z.array(CountryCodeSchema).min(1).optional(),
  cardCountries: z.array(CountryCodeSchema).min(1).optional(),
}).strict();

/**
 * A candidate offer for a purchase intent.
 *
 * Amounts keep their native unit (per month, per year, per call, ...). Comparing
 * or normalising units is a separate milestone; sources must not convert them.
 */
export const OfferSchema = z.object({
  id: z.string().min(1),
  sourceId: OfferSourceIdSchema,
  vendor: z.string().min(1),
  product: z.string().min(1),
  plan: OfferPlanSchema,
  category: z.string().min(1),
  merchantCategoryCode: z.string().regex(/^\d{4}$/).optional(),
  price: OfferPriceSchema,
  seats: z.number().int().positive().optional(),
  commitmentMonths: z.number().int().nonnegative(),
  cancellation: z.string().min(1),
  renewal: z.string().min(1).optional(),
  regions: OfferRegionsSchema.optional(),
  priceStatus: PriceStatusSchema,
  availability: AvailabilitySchema,
  sourceUrl: z.string().url().regex(/^https:\/\//i).optional(),
  capturedAt: z.string().datetime({ offset: true }),
  notes: z.string().min(1).optional(),
}).strict();

export type OfferSourceId = z.infer<typeof OfferSourceIdSchema>;
export type OfferPlan = z.infer<typeof OfferPlanSchema>;
export type PriceUnit = z.infer<typeof PriceUnitSchema>;
export type PriceStatus = z.infer<typeof PriceStatusSchema>;
export type OfferAvailability = z.infer<typeof AvailabilitySchema>;
export type OfferPrice = z.infer<typeof OfferPriceSchema>;
export type OfferRegions = z.infer<typeof OfferRegionsSchema>;
export type Offer = z.infer<typeof OfferSchema>;

export const OfferListSchema = z.array(OfferSchema);

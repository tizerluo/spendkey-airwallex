import { z } from 'zod';
import type { Balance } from '@sk/airwallex';
import type { MinorAmount } from './money.js';

// Shared M2 contract: structural, with no runtime dependency on @sk/compare.
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
export interface UsageProfile {
  horizonMonths: number; seats?: number;
  callsPerMonth?: { low: number; high: number };
  unitsPerMonth?: { low: number; high: number };
}

export const minorAmountSchema = z.number().int().nonnegative().safe();
export const currencySchema = z.string().regex(/^[A-Z]{3}$/);
export const mccSchema = z.string().regex(/^\d{4}$/);
const rangeSchema = z.object({ lowMinor: minorAmountSchema, highMinor: minorAmountSchema })
  .refine(value => value.lowMinor <= value.highMinor, 'invalid_cost_range');
export const candidateSchema = z.object({
  offerId: z.string().min(1), vendor: z.string().min(1), product: z.string().min(1),
  sourceId: z.enum(['curated', 'x402-snapshot']), plan: z.enum(['monthly', 'annual', 'usage', 'one_time']),
  rail: z.enum(['card', 'x402']),
  currency: currencySchema, merchantCategoryCode: mccSchema.optional(),
  commitmentMonths: z.number().int().nonnegative().safe(),
  priceStatus: z.enum(['verified', 'price_unverified']), availability: z.enum(['available', 'region_unavailable']),
  upfrontMinor: minorAmountSchema, perChargeMinor: minorAmountSchema,
  horizonCost: rangeSchema, monthlyRunRateMinor: rangeSchema, notes: z.array(z.string()),
}).refine(value => value.sourceId !== 'x402-snapshot' || value.rail === 'x402', 'rail_not_card');

export interface KnownObligation {
  currency: string;
  amountMinor: MinorAmount;
  /** Whole days from this balance snapshot; 0 is today, negative is overdue and due now. */
  dueInDays: number;
}
export interface PolicyContext {
  balances: readonly Pick<Balance, 'currency' | 'available_amount'>[];
  knownObligations: readonly KnownObligation[];
  reserveHorizonDays: number;
  reserveFloorMinor: Readonly<Record<string, MinorAmount>>;
  budgetCurrency: string;
  spentInWindowMinor: MinorAmount;
  windowBudgetMinor: MinorAmount;
  maxCommitmentMonths: number;
  billingCountry: string;
  cardCountry: string;
}

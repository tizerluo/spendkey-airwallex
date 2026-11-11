import { z } from 'zod';
import {
  AddressSchema, AtomicAmountSchema, HttpMethodSchema, HttpUrlSchema,
  IdentifierSchema, SourceSchema, TimestampSchema,
} from './common.js';

const quoteFields = {
  source: SourceSchema, id: IdentifierSchema, url: HttpUrlSchema,
  method: HttpMethodSchema, asset: AddressSchema, payTo: AddressSchema,
  scheme: z.literal('exact'), scoreable: z.boolean(),
  maxTimeoutSeconds: z.number().int().positive().optional(),
};

/** Preserve native x402 amount fields without numeric coercion. */
export const QuoteSchema = z.discriminatedUnion('x402Version', [
  z.object({
    ...quoteFields, x402Version: z.literal(1), network: z.literal('celo'),
    maxAmountRequired: AtomicAmountSchema,
  }).strict(),
  z.object({
    ...quoteFields, x402Version: z.literal(2), network: z.literal('eip155:42220'),
    amount: AtomicAmountSchema,
  }).strict(),
]);

/** Catalog prices also retain other networks for unscoreable discovery entries. */
export const CatalogPriceSchema = z.object({
  amountAtomic: AtomicAmountSchema, asset: AddressSchema, network: z.string().regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/),
}).strict();

export const CatalogItemSchema = z.object({
  source: SourceSchema,
  id: IdentifierSchema,
  url: HttpUrlSchema,
  method: HttpMethodSchema,
  name: IdentifierSchema.optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.unknown()).optional(),
  x402Version: z.union([z.literal(1), z.literal(2)]),
  celoAssets: z.array(IdentifierSchema),
  price: CatalogPriceSchema,
  payRail: z.enum(['x402', 'prepaid', 'card']),
  celo: z.boolean(),
  scoreable: z.boolean(),
  trust: z.object({
    erc8004: IdentifierSchema.optional(), payers30d: z.number().int().nonnegative().optional(),
  }).strict().optional(),
  requiresSelf: z.boolean(),
  async: z.boolean(),
  updatedAt: TimestampSchema.optional(),
}).strict().superRefine((item, ctx) => {
  const celoNetwork = item.price.network === 'eip155:42220';
  if (item.celo !== celoNetwork) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['celo'], message: 'Celo flag must match the price network' });
  }
  if (item.scoreable && !item.celo) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scoreable'], message: 'Other networks are not scoreable' });
  }
});

export type Quote = z.infer<typeof QuoteSchema>;
export type CatalogPrice = z.infer<typeof CatalogPriceSchema>;
export type CatalogItem = z.infer<typeof CatalogItemSchema>;

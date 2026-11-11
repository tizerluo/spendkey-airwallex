import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as contracts from './index.js';
import { fixtureManifest } from './fixture-manifest.js';

const directory = fileURLToPath(new URL('../fixtures/', import.meta.url));
const schemas: Record<string, z.ZodTypeAny> = {};
for (const [name, value] of Object.entries(contracts)) {
  if (value instanceof z.ZodType) schemas[name.replace(/Schema$/, '')] = value;
}

function readFixture(filename: string): unknown {
  return JSON.parse(readFileSync(`${directory}/${filename}`, 'utf8'));
}

it('exports the workspace package identity', () => {
  expect(contracts.PACKAGE_NAME).toBe('@sr/schema');
  expect(contracts.SCHEMA_VERSION).toBe('1.0.0');
});

it('accounts for every JSON fixture and every exported schema', () => {
  expect(readdirSync(directory).filter(name => name.endsWith('.json')).sort())
    .toEqual(Object.keys(fixtureManifest).sort());
  const covered = new Set(Object.entries(fixtureManifest)
    .filter(([name]) => name.endsWith('.valid.json')).map(([, schema]) => schema));
  expect([...covered].sort()).toEqual(Object.keys(schemas).sort());
});

describe('offline fixtures', () => {
  for (const [filename, contract] of Object.entries(fixtureManifest)) {
    it(`${filename} ${filename.endsWith('.valid.json') ? 'parses' : 'is rejected'} by ${contract}`, () => {
      const schema = schemas[contract];
      expect(schema).toBeDefined();
      const input = readFixture(filename);
      const result = schema!.safeParse(input);
      if (filename.endsWith('.valid.json')) {
        expect(result.success, JSON.stringify(result)).toBe(true);
        if (result.success) expect(result.data).toEqual(input);
      } else {
        expect(result.success).toBe(false);
      }
    });
  }
});

describe('typed mocks', () => {
  for (const [name, mock] of Object.entries(contracts.validMocks)) {
    it(`${name} matches its fixture`, () => {
      expect(mock).toEqual(readFixture(`${name}.valid.json`));
    });
  }
});

it('preserves large atomic amounts without numeric coercion', () => {
  const value = '9007199254740993123456789';
  expect(contracts.AtomicAmountSchema.parse(value)).toBe(value);

});

it('accepts ten steps and references the earlier primary step for a fallback', () => {
  const steps = Array.from({ length: 10 }, (_, index) => ({
    ...contracts.mockPlanStep, ...(index > 0 ? { fallbackOf: 0 } : {}),
  }));
  expect(contracts.PaymentPlanSchema.safeParse({ ...contracts.mockPaymentPlan, steps }).success).toBe(true);
  expect(contracts.PaymentPlanSchema.safeParse({
    ...contracts.mockPaymentPlan, steps: [{ ...contracts.mockPlanStep, fallbackOf: -1 }],
  }).success).toBe(false);
});

it('rejects unexpected authorization fields', () => {
  expect(contracts.PaymentPlanSchema.safeParse({
    ...contracts.mockPaymentPlan, approved: true,
  }).success).toBe(false);
  expect(contracts.GuardReqSchema.safeParse({
    ...contracts.mockGuardReq, bypassBudget: true,
  }).success).toBe(false);
});

it('narrows x402 quote types to the native version-specific amount', () => {
  for (const mock of [contracts.mockQuote, contracts.mockQuoteV2]) {
    const quote: contracts.Quote = contracts.QuoteSchema.parse(mock);
    if (quote.x402Version === 1) {
      expect(quote.network).toBe('celo');
      expect(quote.maxAmountRequired).toBe('5000');
    } else {
      expect(quote.network).toBe('eip155:42220');
      expect(quote.amount).toBe('5000');
    }
  }
});

it('rejects present undefined execution fields on non-executable plans', () => {
  expect(contracts.PaymentPlanSchema.safeParse({ ...contracts.mockPaymentPlanAsk, steps: undefined }).success).toBe(false);
  expect(contracts.PaymentPlanSchema.safeParse({ ...contracts.mockPaymentPlanRefuse, approval: undefined }).success).toBe(false);
  expect(contracts.CallSpecSchema.safeParse({ ...contracts.mockCallSpec, bodyHash: undefined }).success).toBe(false);
});

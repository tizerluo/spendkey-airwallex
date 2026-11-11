import { readFileSync } from 'node:fs';
import type { z } from 'zod';

/** Fixtures live at the package root so src/ and dist/ resolve them identically. */
export function readFixture<T>(name: string, schema: z.ZodType<T>): T {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  const raw = readFileSync(url, 'utf8');
  return schema.parse(JSON.parse(raw) as unknown);
}

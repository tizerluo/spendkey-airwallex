import { readFileSync } from 'node:fs';
import { LedgerEventSchema, redactValue, verifyJsonl, type LedgerEvent } from '@sk/ledger';

/** Read-only diagnostics: preserve hash failures while validating rows before rendering. */
export function readAuditFile(path: string) {
  const text = readFileSync(path, 'utf8');
  const verification = verifyJsonl(text);
  const events: LedgerEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const parsed = LedgerEventSchema.safeParse(redactValue(JSON.parse(line) as unknown));
      if (parsed.success) events.push(parsed.data);
    } catch { /* The verification reports malformed rows; they are never rendered. */ }
  }
  return { events, verification };
}

/** Safe diagnostics only: never retain authentication material or unmasked PANs. */
export function redactBody(value: unknown, redactString: (value: string) => string = value => value): unknown {
  function walk(item: unknown, depth: number): unknown {
    // Unexpected nesting must not overflow the stack after card creation succeeds.
    if (depth > 100) return '[redacted]';
    if (typeof item === 'string') return redactString(item).replace(/\d{13,}/g, '[redacted]');
    if (typeof item === 'number' && /\d{13,}/.test(String(item))) return '[redacted]';
    if (Array.isArray(item)) return item.map(child => walk(child, depth + 1));
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).filter(([key]) =>
        key === 'masked_card_number' || !/pan|card_number(?!_masked)|cvv|cvc|token|secret|key/i.test(key),
      ).map(([key, child]) => [redactString(key).replace(/\d{13,}/g, '[redacted]'), walk(child, depth + 1)]));
    }
    return item;
  }
  return walk(value, 0);
}

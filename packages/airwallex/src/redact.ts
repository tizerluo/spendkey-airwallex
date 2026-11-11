/** 13 or more consecutive digits, or 13–19 digits separated only by a single space/hyphen. */
const CONSECUTIVE_PAN = /\d{13,}/;
const SPACED_PAN = /\d(?:[ -]?\d){12,18}/;

/** Digit count after ignoring separators. */
export function digitCount(value: string): number {
  return value.replace(/\D/g, '').length;
}

/** Card-number shapes to drop when unmasked. digitCount covers scattered digits; the spacing regex covers spaces and hyphens. */
export function isPanLike(value: string): boolean {
  return digitCount(value) >= 13 || SPACED_PAN.test(value);
}

/** Uses the same mask characters as maskedNumberSchema. */
export function hasMaskChar(value: string): boolean {
  return /[*xX•●#]/.test(value);
}

/**
 * If 13 or more digits remain after removing mask characters, replace the whole segment with [redacted].
 * Mask characters are not an exemption; otherwise values like 4111 - 1111 - 1111 - 1111 x would slip through.
 * A valid mask has at most 10 digits and is unaffected.
 * Otherwise scrub consecutive long runs first (so 20 digits are not only partly cut), then 13–19 digits
 * separated by any non-letter delimiter, and finally long digit runs separated by the mask letters x/X
 * (x is a letter, so the previous regex will not cross it).
 */
export function redactSensitiveText(value: string): string {
  if (digitCount(value.replace(/[*xX•●#]+/g, '')) >= 13) return '[redacted]';
  return value
    .replace(/\d{13,}/g, '[redacted]')
    // Non-letter delimiters plus the mask letters x/X. x is not in [^\dA-Za-z], otherwise 4111x1111… would remain in raw.
    .replace(/\d(?:[^\dA-Za-z]{0,2}\d){12,18}/g, '[redacted]')
    .replace(/\d(?:(?:[^\dA-Za-z]|[xX]){0,2}\d){12,18}/g, '[redacted]');
}

/** For non-JSON bodies keep only the length and the first 200 redacted characters. length is the original length. */
export function nonJsonDiagnostic(text: string, length = text.length): { nonJson: true; length: number; head: string } {
  // Everything after a matched key is untrusted: Bearer/Basic schemes and quoted or space-containing values can follow the key.
  const scrubbed = redactSensitiveText(text.replace(
    /(pan|card_?number|cvv|cvc|token|secret|key|password|auth|security|verification)[^,&;\s]*\s*[:=][^\n]*/gi,
    '[redacted]',
  ));
  return { nonJson: true, length, head: scrubbed.slice(0, 200) };
}

function isDigitLike(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  return /^-?\d+(?:[ -]\d+)*(?:\.\d+)?$/.test(value);
}

function keepKey(key: string, value: unknown): boolean {
  // Display masks and spending controls are not credentials. Compare case-insensitively so MASKED_CARD_NUMBER is not dropped.
  const normalized = key.toLowerCase();
  if (normalized === 'masked_card_number' || normalized === 'authorization_controls') return true;
  if (/^pin$/i.test(normalized)) return false;
  if (/^number$/i.test(normalized) && isDigitLike(value)) return false;
  return !/pan|card_number(?!_masked)|cvv|cvc|token|secret|key|password|auth|credential|security|verification|expir/i.test(normalized);
}

/** Safe diagnostics only: never retain authentication material or unmasked PANs. */
export function redactBody(value: unknown, redactString: (value: string) => string = value => value): unknown {
  function walk(item: unknown, depth: number): unknown {
    // Unexpected nesting must not overflow the stack after card creation succeeds.
    if (depth > 100) return '[redacted]';
    if (typeof item === 'string') {
      const scrubbed = redactString(item);
      const trimmed = scrubbed.trimStart();
      // If a string contains another layer of JSON, parse it and apply the key rules; otherwise cvv/token would remain as text.
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          return walk(JSON.parse(trimmed) as unknown, depth + 1);
        } catch {
          // Not valid JSON; redact as plain text.
        }
      }
      return redactSensitiveText(scrubbed);
    }
    if (typeof item === 'number' && (CONSECUTIVE_PAN.test(String(item)) || digitCount(String(item)) >= 13)) return '[redacted]';
    if (Array.isArray(item)) return item.map(child => walk(child, depth + 1));
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).filter(([key, child]) => keepKey(key, child)).map(([key, child]) =>
        [redactSensitiveText(redactString(key)), walk(child, depth + 1)]));
    }
    return item;
  }
  return walk(value, 0);
}

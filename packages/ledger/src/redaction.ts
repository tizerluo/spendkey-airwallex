// Match key names only. Plain words like authorization, secret, token, cookie, pan in free text do not route here.
const sensitiveKey = /cvv|cvc|(?:^|_|-)pan(?:$|_|-)|card_?number|security_?code|card_?security|(?:card[\w-]*expir(?:y|ation)|expir(?:y|ation)[\w-]*card)|^number$|token|secret|api[-_]?key|password|passwd|authorization|cookie|private[-_]?key/i;

// Free text matches only high-confidence patterns, so vendor names, failure reasons, and rule descriptions are not dropped wholesale.
const highConfidencePatterns = [
  /\bsk-[a-z0-9_-]{16,}/i,
  /\bsk_(?:live|test)_[a-z0-9]{10,}/i,
  /\bAKIA[a-z0-9]{16}/i,
  /\bgh[pousr]_[a-z0-9]{20,}/i,
  /\bgithub_pat_[a-z0-9_]{20,}/i,
  /\bxox[a-z]-[a-z0-9-]{10,}/i,
  /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}/i,
  /\bbearer\s+[a-z0-9._~+/=-]{12,}/i,
  /\bbasic\s+[a-z0-9+/]{8,}={0,2}/i,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
];

function luhn(digits: string): boolean {
  let sum = 0;
  for (let index = digits.length - 1, double = false; index >= 0; index -= 1, double = !double) {
    let digit = Number(digits[index]);
    if (double) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Whether the value contains a high-confidence secret or a standalone Luhn-valid PAN (spaces and hyphens included). */
function flagged(text: string): boolean {
  if (highConfidencePatterns.some(pattern => pattern.test(text))) return true;
  // Hashes and 13-digit epoch milliseconds are excluded from PAN checks so approval hashes are not flagged.
  if (/^(0x)?[0-9a-f]{32,}$/i.test(text) || /^[12]\d{12}$/.test(text)) return false;
  for (const match of text.matchAll(/(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])/g)) {
    const digits = match[0].replace(/[ -]/g, '');
    if (luhn(digits)) return true;
  }
  return false;
}

function unsafeKey(key: string): boolean {
  return key !== 'masked_card_number' && sensitiveKey.test(key);
}

/** Redaction and the final guard share one traversal to keep the rules from drifting. */
function walk(value: unknown, sanitize: boolean): unknown {
  const ancestors = new Set<object>();
  function visit(item: unknown): unknown {
    if (typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item))) {
      if (flagged(String(item))) {
        if (sanitize) return '[REDACTED]';
        throw new Error('ledger_redaction_required');
      }
      return item;
    }
    if (item !== null && typeof item === 'object') {
      if (ancestors.has(item)) throw new Error('ledger_requires_json');
      const prototype: unknown = Object.getPrototypeOf(item);
      if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
        throw new Error('ledger_requires_json');
      }
      ancestors.add(item);
      const result = Array.isArray(item) ? item.map(visit) : Object.fromEntries(
        Object.entries(item).flatMap(([key, child]) => {
          // Sensitive key names are dropped outright; key names themselves are not matched against free text.
          if (unsafeKey(key)) {
            if (sanitize) return [];
            throw new Error('ledger_redaction_required');
          }
          return [[key, visit(child)]];
        }),
      );
      ancestors.delete(item);
      return result;
    }
    if (typeof item === 'number' ? !Number.isFinite(item)
      : item !== undefined && item !== null && typeof item !== 'boolean') {
      throw new Error('ledger_requires_json');
    }
    return item;
  }
  return visit(value);
}

/** Deep-copy JSON: drop sensitive keys and replace high-confidence secret patterns with "[REDACTED]".
 * Ordinary words in free text are preserved. masked_card_number keeps its key, but its value is still content-checked.
 * append calls this on the whole event first, then runs assertRedacted.
 */
export function redactValue(value: unknown): unknown { return walk(value, true); }

/** Final guard. Free text uses only high-confidence patterns; keys only check sensitive key names. Errors never echo keys or values. */
export function assertRedacted(value: unknown): void { walk(value, false); }

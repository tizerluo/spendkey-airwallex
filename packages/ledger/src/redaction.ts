const sensitiveKey = /cvv|cvc|(^|_|-)pan($|_|-)|card_?number|token|secret|api[-_]?key|password|passwd|authorization|cookie|private[-_]?key/i;
const secretText = /\bcvv\b|\bcvc\b|\bpan\b|\bbearer\b|\bsecret\b|\bpassword\b|\bpasswd\b|\bauthorization\b|\bcookie\b|api[\s_-]?key|(?:client|webhook|api)[\s_-]?secret|secret[\s_-]?key|(?:id|auth|access|refresh)[\s_-]?token|\btoken\b|private[\s_-]?key|basic\s+[a-z0-9+/=]{8,}/i;
const secretShape = /\bsk-[a-z0-9_-]{16,}|\bAKIA[a-z0-9]{16}|\bgh[pousr]_[a-z0-9]{20,}|\bgithub_pat_[a-z0-9_]{20,}|\beyJ[a-z0-9_-]*\.[a-z0-9_-]+\.[a-z0-9_-]+/i;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let index = digits.length - 1, double = false; index >= 0; index -= 1, double = !double) {
    let digit = Number(digits[index]);
    if (double) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}

function flagged(text: string): boolean {
  if (secretText.test(text) || secretShape.test(text)) return true;
  // Exempt hex hashes and contemporary 13-digit epoch-ms values from PAN checks.
  if (/^(0x)?[0-9a-f]{32,}$/i.test(text) || /^[12]\d{12}$/.test(text)) return false;
  for (const match of text.matchAll(/(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])/g)) {
    const digits = match[0].replace(/[ -]/g, '');
    if (luhn(digits)) return true;
  }
  return false;
}

function unsafeKey(key: string): boolean {
  return key !== 'masked_card_number' && (sensitiveKey.test(key) || flagged(key));
}

/** Shared JSON traversal keeps the sanitizer and the final guard in agreement. */
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
          if (unsafeKey(key)) {
            if (sanitize) return [];
            throw new Error('ledger_redaction_required');
          }
          // The contract uses authorization as an event discriminator.
          return [[key, key === 'kind' && child === 'authorization' ? child : visit(child)]];
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

/** Deep clone JSON data, dropping sensitive keys and masking flagged values.
 * Callers must use this for tolerant response handling, including response-derived
 * optional card fields. Append also sanitizes raw_response.body/card_issued.controls.
 * masked_card_number is retained, but its value still passes the content checks.
 */
export function redactValue(value: unknown): unknown { return walk(value, true); }

/** Reject sensitive content without ever echoing the offending key or value. */
export function assertRedacted(value: unknown): void { walk(value, false); }

/** 连续 13 位及以上，或中间只隔一个空格/横线的 13–19 位数字。 */
const CONSECUTIVE_PAN = /\d{13,}/;
const SPACED_PAN = /\d(?:[ -]?\d){12,18}/;

/** 忽略分隔符后的数字个数。 */
export function digitCount(value: string): number {
  return value.replace(/\D/g, '').length;
}

/** 无掩码时应当丢弃的卡号形态。digitCount 覆盖散落数字，间距正则覆盖空格和横线。 */
export function isPanLike(value: string): boolean {
  return digitCount(value) >= 13 || SPACED_PAN.test(value);
}

/** 与 maskedNumberSchema 使用同一组掩码字符。 */
export function hasMaskChar(value: string): boolean {
  return /[*xX•●#]/.test(value);
}

/** 先抹掉连续长串，再抹掉带空格或横线的卡号，避免 20 位以上只被截掉前 19 位。 */
export function redactSensitiveText(value: string): string {
  return value.replace(/\d{13,}/g, '[redacted]').replace(/\d(?:[ -]?\d){12,18}/g, '[redacted]');
}

function isDigitLike(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  return /^-?\d+(?:[ -]\d+)*(?:\.\d+)?$/.test(value);
}

function keepKey(key: string, value: unknown): boolean {
  // 展示用掩码和消费控制不是凭证；auth 子串不能把 authorization_controls 一起丢掉。
  if (key === 'masked_card_number' || key === 'authorization_controls') return true;
  if (/^pin$/i.test(key)) return false;
  if (/^number$/i.test(key) && isDigitLike(value)) return false;
  return !/pan|card_number(?!_masked)|cvv|cvc|token|secret|key|password|auth|credential|security_code|expir/i.test(key);
}

/** Safe diagnostics only: never retain authentication material or unmasked PANs. */
export function redactBody(value: unknown, redactString: (value: string) => string = value => value): unknown {
  function walk(item: unknown, depth: number): unknown {
    // Unexpected nesting must not overflow the stack after card creation succeeds.
    if (depth > 100) return '[redacted]';
    if (typeof item === 'string') return redactSensitiveText(redactString(item));
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

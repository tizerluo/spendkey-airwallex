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

/**
 * 抹掉掩码字符后仍有 13 位及以上数字时整段换成 [redacted]。
 * 掩码字符不构成豁免，否则 4111 - 1111 - 1111 - 1111 x 这类值会漏过。
 * 合法掩码至多 10 位数字，不受影响。
 * 否则先抹连续长串（避免 20 位只截前 19 位），再抹任意非字母分隔符隔开的 13–19 位，
 * 最后抹用掩码字母 x/X 隔开的长数字（x 是字母，上一则正则不会跨越它）。
 */
export function redactSensitiveText(value: string): string {
  if (digitCount(value.replace(/[*xX•●#]+/g, '')) >= 13) return '[redacted]';
  return value
    .replace(/\d{13,}/g, '[redacted]')
    // 非字母分隔符，外加掩码字母 x/X。x 不在 [^\dA-Za-z] 里，否则 4111x1111… 会留在 raw。
    .replace(/\d(?:[^\dA-Za-z]{0,2}\d){12,18}/g, '[redacted]')
    .replace(/\d(?:(?:[^\dA-Za-z]|[xX]){0,2}\d){12,18}/g, '[redacted]');
}

/** 非 JSON 正文只留长度和脱敏后的前 200 字。length 是原文长度。 */
export function nonJsonDiagnostic(text: string, length = text.length): { nonJson: true; length: number; head: string } {
  // 命中的键之后整行都不可信：Bearer/Basic 方案和带引号、含空格的值都可能在键后面。
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
  // 展示用掩码和消费控制不是凭证。比较时忽略大小写，避免 MASKED_CARD_NUMBER 被误删。
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
      // 字符串里再嵌一层 JSON 时先解析再走键规则，否则 cvv/token 只会留在文本里。
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          return walk(JSON.parse(trimmed) as unknown, depth + 1);
        } catch {
          // 不是合法 JSON，按普通文本脱敏。
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

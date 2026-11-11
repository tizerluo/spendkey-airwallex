// 只匹配键名。自由文本里的 authorization、secret、token、cookie、pan 等普通词不走这里。
const sensitiveKey = /cvv|cvc|(?:^|_|-)pan(?:$|_|-)|card_?number|security_?code|card_?security|(?:card[\w-]*expir(?:y|ation)|expir(?:y|ation)[\w-]*card)|^number$|token|secret|api[-_]?key|password|passwd|authorization|cookie|private[-_]?key/i;

// 自由文本只认高置信度形态，避免把商户名、失败原因和规则说明整段丢掉。
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

/** 值是否含高置信度密钥或通过 Luhn 的独立 PAN（含空格和连字符）。 */
function flagged(text: string): boolean {
  if (highConfidencePatterns.some(pattern => pattern.test(text))) return true;
  // 哈希和 13 位纪元毫秒不参与 PAN 判断，避免审批哈希被误伤。
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

/** 脱敏与最终守卫共用同一次遍历，避免两边规则漂移。 */
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
          // 敏感键名直接丢弃；键名本身不再套用自由文本词表。
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

/** 深拷贝 JSON：删除敏感键，并把高置信度密钥形态替换为 "[REDACTED]"。
 * 自由文本中的普通词会原样保留。masked_card_number 保留键名，值仍做内容检查。
 * append 会先对整条事件调用本函数，再跑 assertRedacted。
 */
export function redactValue(value: unknown): unknown { return walk(value, true); }

/** 最终守卫。自由文本只用高置信度形态；键只检查敏感键名。错误不回显键或值。 */
export function assertRedacted(value: unknown): void { walk(value, false); }

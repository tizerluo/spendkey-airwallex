// 金额展示。只做十进制字符串拼接，不用浮点乘除，也不做四舍五入。

import { currencyExponent } from '@sk/ledger';
export { currencyExponent } from '@sk/ledger';

/** 把最小货币单位格式化成十进制字符串。负数带显式减号，零不带符号。 */
export function formatMinor(minor: number, currency: string): string {
  if (typeof minor !== 'number' || !Number.isSafeInteger(minor)) {
    throw new RangeError('invalid_minor_amount');
  }
  const negative = minor < 0;
  const digits = String(negative ? -minor : minor);
  return finishDecimal(negative, digitsToParts(digits, currencyExponent(currency)));
}

/**
 * 格式化账本里的有符号十进制字符串，例如 "-12.50" 或 "+3"。
 * 小数位多于币种刻度且不全是 0 时直接抛错，避免静默舍入。
 */
export function formatSignedDecimal(amount: string, currency: string): string {
  const match = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(amount);
  if (match === null) throw new RangeError('invalid_signed_decimal');
  const sign = match[1];
  const wholeRaw = match[2];
  const fractionRaw = match[3];
  if (wholeRaw === undefined) throw new RangeError('invalid_signed_decimal');
  const whole = wholeRaw.replace(/^0+(?=\d)/, '');
  const fraction = fractionRaw ?? '';
  const exponent = currencyExponent(currency);
  const aligned = alignFraction(whole, fraction, exponent);
  return finishDecimal(sign === '-', aligned);
}

/** 区间两端相同只显示一个数，不同则用连字符拼成 low-high。 */
export function formatMinorRange(lowMinor: number, highMinor: number, currency: string): string {
  const low = formatMinor(lowMinor, currency);
  const high = formatMinor(highMinor, currency);
  return low === high ? low : `${low}-${high}`;
}

interface DecimalParts {
  whole: string;
  fraction: string;
}

/** 最小单位的数字串按小数位切开。位数不够时在左边补 0。 */
function digitsToParts(digits: string, exponent: number): DecimalParts {
  if (exponent === 0) return { whole: digits, fraction: '' };
  const padded = digits.padStart(exponent + 1, '0');
  return { whole: padded.slice(0, -exponent), fraction: padded.slice(-exponent) };
}

/** 把已经是十进制的整数和小数对齐到币种刻度。多出来的非零小数视为无法无损展示。 */
function alignFraction(whole: string, fraction: string, exponent: number): DecimalParts {
  if (fraction.length > exponent) {
    const extra = fraction.slice(exponent);
    if (!/^0+$/.test(extra)) throw new RangeError('inexact_decimal_scale');
    return { whole, fraction: fraction.slice(0, exponent) };
  }
  return { whole, fraction: fraction.padEnd(exponent, '0') };
}

/** 零值去掉负号。小数位为 0 的币种不输出小数点。 */
function finishDecimal(negative: boolean, parts: DecimalParts): string {
  const whole = parts.whole.replace(/^0+(?=\d)/, '');
  const text = parts.fraction === '' ? whole : `${whole}.${parts.fraction}`;
  const magnitude = `${whole}${parts.fraction}`;
  if (negative && !/^0+$/.test(magnitude)) return `-${text}`;
  return text;
}

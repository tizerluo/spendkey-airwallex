// Format amounts using decimal strings without floating-point arithmetic or rounding.

import { currencyExponent } from '@sk/ledger';
export { currencyExponent } from '@sk/ledger';

/** Format minor units as a decimal string; negative amounts have an explicit minus sign. */
export function formatMinor(minor: number, currency: string): string {
  if (typeof minor !== 'number' || !Number.isSafeInteger(minor)) {
    throw new RangeError('invalid_minor_amount');
  }
  const negative = minor < 0;
  const digits = String(negative ? -minor : minor);
  return finishDecimal(negative, digitsToParts(digits, currencyExponent(currency)));
}

/** Format signed ledger decimals such as -12.50 or +3.
 * Reject extra nonzero fractional digits instead of silently rounding. */
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

/** Show one amount for equal bounds, otherwise a low-high range. */
export function formatMinorRange(lowMinor: number, highMinor: number, currency: string): string {
  const low = formatMinor(lowMinor, currency);
  const high = formatMinor(highMinor, currency);
  return low === high ? low : `${low}-${high}`;
}

interface DecimalParts {
  whole: string;
  fraction: string;
}

/** Split minor-unit digits at the currency scale, padding with leading zeros as needed. */
function digitsToParts(digits: string, exponent: number): DecimalParts {
  if (exponent === 0) return { whole: digits, fraction: '' };
  const padded = digits.padStart(exponent + 1, '0');
  return { whole: padded.slice(0, -exponent), fraction: padded.slice(-exponent) };
}

/** Align decimal digits to the currency scale; reject lossy conversion. */
function alignFraction(whole: string, fraction: string, exponent: number): DecimalParts {
  if (fraction.length > exponent) {
    const extra = fraction.slice(exponent);
    if (!/^0+$/.test(extra)) throw new RangeError('inexact_decimal_scale');
    return { whole, fraction: fraction.slice(0, exponent) };
  }
  return { whole, fraction: fraction.padEnd(exponent, '0') };
}

/** Remove negative signs from zero and omit the decimal point for zero-scale currencies. */
function finishDecimal(negative: boolean, parts: DecimalParts): string {
  const whole = parts.whole.replace(/^0+(?=\d)/, '');
  const text = parts.fraction === '' ? whole : `${whole}.${parts.fraction}`;
  const magnitude = `${whole}${parts.fraction}`;
  if (negative && !/^0+$/.test(magnitude)) return `-${text}`;
  return text;
}

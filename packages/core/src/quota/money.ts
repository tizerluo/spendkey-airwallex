/** USD at the API boundary; all stored amounts and comparisons use integer micro-USD. */
export type UsdAmount = number | string;

/** Convert decimal USD, rounding fractional micro-USD up so tiny costs are never free. */
export function usdToMicroUsd(usd: UsdAmount): number {
  if (typeof usd !== 'number' && typeof usd !== 'string') {
    throw new TypeError('USD amount must be a number or decimal string');
  }
  if (typeof usd === 'number' && !Number.isFinite(usd)) {
    throw new RangeError('USD amount must be finite');
  }
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(usd));
  if (!match) throw new RangeError('USD amount must be nonnegative decimal USD');
  const whole = match[1]!;
  const fraction = match[2] ?? '';
  const digits = `${whole}${fraction}`.replace(/^0+/, '');
  const exponent = Number(match[3] ?? '0');
  if (!Number.isSafeInteger(exponent)) throw new RangeError('USD exponent is out of range');
  if (!digits) return 0;
  const shift = exponent - fraction.length + 6;
  // Bound powers before allocating them, including very large scientific exponents.
  if (digits.length + shift > 16) throw new RangeError('USD amount exceeds safe micro-USD range');
  if (shift <= -digits.length) return 1;
  const coefficient = BigInt(digits);
  const micros = shift >= 0
    ? coefficient * (10n ** BigInt(shift))
    : (coefficient + (10n ** BigInt(-shift)) - 1n) / (10n ** BigInt(-shift));
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('USD amount exceeds safe micro-USD range');
  }
  return Number(micros);
}

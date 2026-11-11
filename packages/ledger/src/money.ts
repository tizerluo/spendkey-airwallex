/** Exact signed cents for authorizations, reversals and refunds; never rounds. */
export function signedDecimalToMinor(value: string | number): number {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError('invalid_signed_decimal');
  const text = String(value);
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) throw new RangeError('invalid_signed_decimal');
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const magnitude = Number(`${whole}${fraction.padEnd(2, '0')}`);
  if (!Number.isSafeInteger(magnitude)) throw new RangeError('unsafe_signed_minor_amount');
  return magnitude === 0 ? 0 : negative ? -magnitude : magnitude;
}

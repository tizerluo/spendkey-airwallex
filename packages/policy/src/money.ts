/** Integer cents, never a floating-point currency amount. */
export type MinorAmount = number;

export function assertMinorAmount(value: number): MinorAmount {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('invalid_minor_amount');
  return value;
}

/** Strict cents parsing: concatenate digits, with no multiplication of floats or rounding. */
export function decimalToMinor(value: string | number): MinorAmount {
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError('invalid_decimal_amount');
  }
  const text = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new RangeError('invalid_decimal_amount');
  const [whole, fraction = ''] = text.split('.');
  return assertMinorAmount(Number(`${whole}${fraction.padEnd(2, '0')}`));
}

export function minorToDecimal(value: MinorAmount): string {
  const digits = String(assertMinorAmount(value)).padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

export function addMinor(left: MinorAmount, right: MinorAmount): MinorAmount {
  return assertMinorAmount(assertMinorAmount(left) + assertMinorAmount(right));
}

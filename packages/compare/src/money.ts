/**
 * Exact integer money helpers.
 *
 * Money is represented in minor units (for example cents) as safe integers.
 * Nothing here performs floating-point arithmetic on amounts, and no helper
 * ever silently rounds a value that does not fit the requested precision.
 */

const MINOR_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
const MICROS_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;
const MINOR_PER_UNIT = 100;
const MICROS_PER_UNIT = 1_000_000;

/** Assert that a value is a non-negative safe integer. Returns the value. */
export function assertSafeAmount(value: number, label = 'amount'): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

/** Multiply two non-negative safe integers, rejecting unsafe products. */
export function multiplySafeIntegers(a: number, b: number, label = 'amount'): number {
  assertSafeAmount(a, label);
  assertSafeAmount(b, label);
  const product = a * b;
  if (!Number.isSafeInteger(product)) {
    throw new Error(`${label} exceeds the safe integer range`);
  }
  return product;
}

/** Divide a non-negative safe integer by a positive divisor, rounding up. */
export function divideSafeCeil(value: number, divisor: number, label = 'amount'): number {
  assertSafeAmount(value, label);
  if (!Number.isSafeInteger(divisor) || divisor <= 0) {
    throw new Error(`${label} divisor must be a positive safe integer`);
  }
  const remainder = value % divisor;
  const quotient = (value - remainder) / divisor;
  const result = remainder === 0 ? quotient : quotient + 1;
  return assertSafeAmount(result, label);
}

function parseDecimal(
  amount: string,
  pattern: RegExp,
  decimalPlaces: number,
  label: string,
): number {
  if (typeof amount !== 'string' || !pattern.test(amount)) {
    throw new Error(`invalid ${label}: "${String(amount)}"`);
  }
  const dot = amount.indexOf('.');
  const wholeText = dot === -1 ? amount : amount.slice(0, dot);
  const fractionText = dot === -1 ? '' : amount.slice(dot + 1);

  const whole = Number(wholeText);
  if (!Number.isSafeInteger(whole)) {
    throw new Error(`${label} exceeds the safe integer range`);
  }

  const scale = 10 ** decimalPlaces;
  const fraction = Number(fractionText.padEnd(decimalPlaces, '0') || '0');
  return assertSafeAmount(
    multiplySafeIntegers(whole, scale, label) + fraction,
    label,
  );
}

/**
 * Parse a decimal amount with at most two decimal places into minor units.
 * "12.5" and "12.50" are both 1250; "1.234", "-1" and "1e3" throw.
 */
export function parseDecimalToMinor(amount: string): number {
  return parseDecimal(amount, MINOR_PATTERN, 2, 'minor amount');
}

/**
 * Parse a decimal amount with at most six decimal places into micros
 * (millionths of the currency unit). Used for per-call prices that may be
 * smaller than one minor unit.
 */
export function parseDecimalToMicros(amount: string): number {
  return parseDecimal(amount, MICROS_PATTERN, 6, 'micro amount');
}

/** Render a non-negative integer minor amount as a decimal string ("12.50"). */
export function minorToDecimal(amount: number): string {
  assertSafeAmount(amount, 'minor amount');
  const whole = Math.floor(amount / MINOR_PER_UNIT);
  const fraction = amount % MINOR_PER_UNIT;
  return `${whole}.${String(fraction).padStart(2, '0')}`;
}

/** Convert micros to minor units, rounding up so tiny charges are not hidden. */
export function microsToMinorCeil(micros: number): number {
  return divideSafeCeil(micros, MICROS_PER_UNIT / MINOR_PER_UNIT, 'micro amount');
}

/** @deprecated Use microsToMinorCeil; this alias keeps the rounding explicit. */
export const ceilMicrosToMinor = microsToMinorCeil;

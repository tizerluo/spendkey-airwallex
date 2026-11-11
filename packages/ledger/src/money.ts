const zeroDecimal = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const threeDecimal = new Set(['KWD', 'BHD', 'OMR', 'JOD', 'TND', 'IQD', 'LYD']);

/** Currency exponent shared by ledger validation and display; other ISO-style codes use 2. */
export function currencyExponent(currency: string): number {
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new RangeError('invalid_currency');
  return zeroDecimal.has(code) ? 0 : threeDecimal.has(code) ? 3 : 2;
}

/** Exact signed minor units per currency; never rounds. */
export function signedDecimalToMinor(value: string | number, currency: string): number {
  if (!/^[A-Z]{3}$/.test(currency)) throw new RangeError('invalid_currency');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError('invalid_signed_decimal');
  const exponent = currencyExponent(currency);
  const text = String(value);
  const pattern = exponent === 0 ? /^-?\d+$/ : new RegExp(`^-?\\d+(?:\\.\\d{1,${exponent}})?$`);
  if (!pattern.test(text)) throw new RangeError('invalid_signed_decimal');
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const magnitude = Number(`${whole}${fraction.padEnd(exponent, '0')}`);
  if (!Number.isSafeInteger(magnitude)) throw new RangeError('unsafe_signed_minor_amount');
  return magnitude === 0 ? 0 : negative ? -magnitude : magnitude;
}

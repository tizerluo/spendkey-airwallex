import { describe, expect, it } from 'vitest';
import {
  assertSafeAmount,
  divideSafeCeil,
  microsToMinorCeil,
  minorToDecimal,
  multiplySafeIntegers,
  parseDecimalToMicros,
  parseDecimalToMinor,
} from './money.js';

describe('parseDecimalToMinor', () => {
  it('parses whole and one/two-decimal amounts exactly', () => {
    expect(parseDecimalToMinor('0')).toBe(0);
    expect(parseDecimalToMinor('0.00')).toBe(0);
    expect(parseDecimalToMinor('12')).toBe(1200);
    expect(parseDecimalToMinor('12.5')).toBe(1250);
    expect(parseDecimalToMinor('12.50')).toBe(1250);
    expect(parseDecimalToMinor('0.01')).toBe(1);
    expect(parseDecimalToMinor('600.00')).toBe(60000);
  });

  it('is safe at the edge of the safe integer range', () => {
    const max = '90071992547409.91';
    expect(parseDecimalToMinor(max)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parseDecimalToMinor('90071992547409.92')).toThrow(/safe integer/);
  });

  it.each(['1.234', '1.2.3', '-1', '1e3', '1E3', '', '1.', '.5', '01.00', ' 1.00'])(
    'rejects the malformed amount %j',
    (amount) => {
      expect(() => parseDecimalToMinor(amount)).toThrow(/invalid minor amount/);
    },
  );

  it('rejects values that are not strings', () => {
    expect(() => parseDecimalToMinor(12 as unknown as string)).toThrow(/invalid minor amount/);
  });
});

describe('parseDecimalToMicros', () => {
  it('keeps sub-cent per-call prices exact', () => {
    expect(parseDecimalToMicros('0.001')).toBe(1000);
    expect(parseDecimalToMicros('0.0100')).toBe(10000);
    expect(parseDecimalToMicros('0.0035')).toBe(3500);
    expect(parseDecimalToMicros('0.000001')).toBe(1);
    expect(parseDecimalToMicros('150')).toBe(150_000_000);
  });

  it.each(['0.0000001', '1.2345678', '-1', '1e3', '', '1.', '01.00'])(
    'rejects the malformed micro amount %j',
    (amount) => {
      expect(() => parseDecimalToMicros(amount)).toThrow(/invalid micro amount/);
    },
  );

  it('rejects unsafe results', () => {
    expect(() => parseDecimalToMicros('9007199254.740992')).toThrow(/safe integer/);
  });
});

describe('minorToDecimal', () => {
  it('always renders two decimal places', () => {
    expect(minorToDecimal(0)).toBe('0.00');
    expect(minorToDecimal(1)).toBe('0.01');
    expect(minorToDecimal(5)).toBe('0.05');
    expect(minorToDecimal(1250)).toBe('12.50');
    expect(minorToDecimal(123456)).toBe('1234.56');
  });

  it('rejects negative, fractional, and unsafe values', () => {
    expect(() => minorToDecimal(-1)).toThrow(/non-negative safe integer/);
    expect(() => minorToDecimal(1.5)).toThrow(/non-negative safe integer/);
    expect(() => minorToDecimal(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      /non-negative safe integer/,
    );
  });
});

describe('microsToMinorCeil', () => {
  it('rounds micros up to the next minor unit', () => {
    expect(microsToMinorCeil(0)).toBe(0);
    expect(microsToMinorCeil(1)).toBe(1);
    expect(microsToMinorCeil(9999)).toBe(1);
    expect(microsToMinorCeil(10000)).toBe(1);
    expect(microsToMinorCeil(10001)).toBe(2);
    expect(microsToMinorCeil(5_000_000)).toBe(500);
  });

  it('rejects invalid micros', () => {
    expect(() => microsToMinorCeil(-1)).toThrow(/non-negative safe integer/);
    expect(() => microsToMinorCeil(1.25)).toThrow(/non-negative safe integer/);
  });
});

describe('integer helpers', () => {
  it('multiplies and divides without floating point drift', () => {
    expect(multiplySafeIntegers(6000, 18)).toBe(108000);
    expect(divideSafeCeil(60000, 12)).toBe(5000);
    expect(divideSafeCeil(60001, 12)).toBe(5001);
    expect(divideSafeCeil(0, 12)).toBe(0);
  });

  it('rejects unsafe products and invalid divisors', () => {
    expect(() => multiplySafeIntegers(Number.MAX_SAFE_INTEGER, 2)).toThrow(
      /safe integer range/,
    );
    expect(() => divideSafeCeil(10, 0)).toThrow(/positive safe integer/);
    expect(() => divideSafeCeil(-1, 2)).toThrow(/non-negative safe integer/);
    expect(() => assertSafeAmount(Number.NaN)).toThrow(/non-negative safe integer/);
  });
});

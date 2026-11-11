import { describe, expect, it } from 'vitest';
import { addMinor, assertMinorAmount, decimalToMinor, minorToDecimal } from './index.js';

describe('strict money', () => {
  it.each([
    ['0', 0], ['0.01', 1], ['1.1', 110], ['001.20', 120], ['12', 1200],
    [12.34, 1234], [0.29, 29], ['90071992547409.91', Number.MAX_SAFE_INTEGER],
  ])('parses %s exactly', (decimal, minor) => {
    expect(decimalToMinor(decimal)).toBe(minor);
  });
  it.each(['', ' 1', '1 ', '-1', '+1', '.5', '1.', '1e2', '1,000', 'NaN', 'Infinity', '0.001', '1.005', '90071992547409.92', NaN, Infinity, -1, 0.1 + 0.2, Number.MAX_SAFE_INTEGER])('rejects invalid or unsafe decimal %s', value => {
    expect(() => decimalToMinor(value)).toThrow(RangeError);
  });
  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid minor %s', value => {
    expect(() => assertMinorAmount(value)).toThrow(RangeError);
  });
  it('formats cents with two digits and round-trips the safe integer boundary', () => {
    expect(minorToDecimal(0)).toBe('0.00');
    expect(minorToDecimal(5)).toBe('0.05');
    expect(minorToDecimal(1234)).toBe('12.34');
    expect(decimalToMinor(minorToDecimal(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => addMinor(Number.MAX_SAFE_INTEGER, 1)).toThrow(RangeError);
  });
});

// 金额格式化测试。不访问网络，也不经过浮点。

import { describe, expect, it } from 'vitest';
import { formatMinor, formatMinorRange, formatSignedDecimal } from './money.js';

const ZERO_DECIMAL = ['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'XOF', 'XAF'];
const THREE_DECIMAL = ['KWD', 'BHD', 'OMR', 'JOD', 'TND', 'IQD', 'LYD'];

describe('formatMinor', () => {
  it('按币种小数位格式化美元、日元和科威特第纳尔', () => {
    expect(formatMinor(2500, 'USD')).toBe('25.00');
    expect(formatMinor(1, 'USD')).toBe('0.01');
    expect(formatMinor(0, 'USD')).toBe('0.00');
    expect(formatMinor(100000, 'USD')).toBe('1000.00');
    expect(formatMinor(2500, 'JPY')).toBe('2500');
    expect(formatMinor(0, 'JPY')).toBe('0');
    expect(formatMinor(1234, 'KWD')).toBe('1.234');
    expect(formatMinor(1, 'KWD')).toBe('0.001');
    expect(formatMinor(0, 'KWD')).toBe('0.000');
  });

  it('负数带显式减号，零不带符号', () => {
    expect(formatMinor(-1250, 'USD')).toBe('-12.50');
    expect(formatMinor(-20, 'USD')).toBe('-0.20');
    expect(formatMinor(-3, 'JPY')).toBe('-3');
    expect(formatMinor(-1, 'KWD')).toBe('-0.001');
    expect(formatMinor(-0, 'USD')).toBe('0.00');
    expect(formatMinor(-0, 'JPY')).toBe('0');
  });

  it('大整数不丢精度，也不加千分位', () => {
    expect(formatMinor(9007199254740991, 'USD')).toBe('90071992547409.91');
    expect(formatMinor(9007199254740991, 'JPY')).toBe('9007199254740991');
    expect(formatMinor(-9007199254740991, 'KWD')).toBe('-9007199254740.991');
  });

  it('零小数和三小数币种走同一张表，其余默认两位', () => {
    for (const code of ZERO_DECIMAL) expect(formatMinor(10, code)).toBe('10');
    for (const code of THREE_DECIMAL) expect(formatMinor(10, code)).toBe('0.010');
    expect(formatMinor(10, 'usd')).toBe('0.10');
    expect(formatMinor(10, 'EUR')).toBe('0.10');
  });

  it('拒绝不是安全整数的最小单位', () => {
    expect(() => formatMinor(1.5, 'USD')).toThrow(RangeError);
    expect(() => formatMinor(Number.NaN, 'USD')).toThrow(RangeError);
    expect(() => formatMinor(Number.POSITIVE_INFINITY, 'JPY')).toThrow(RangeError);
  });
});

describe('formatSignedDecimal', () => {
  it('对齐美元、日元、第纳尔，并给负数显式符号', () => {
    expect(formatSignedDecimal('-12.50', 'USD')).toBe('-12.50');
    expect(formatSignedDecimal('+3', 'JPY')).toBe('3');
    expect(formatSignedDecimal('-3', 'JPY')).toBe('-3');
    expect(formatSignedDecimal('0', 'KWD')).toBe('0.000');
    expect(formatSignedDecimal('-1.5', 'KWD')).toBe('-1.500');
    expect(formatSignedDecimal('-0.00', 'USD')).toBe('0.00');
    expect(formatSignedDecimal('00012.5', 'USD')).toBe('12.50');
  });

  it('超长十进制保持原样，不经过浮点', () => {
    expect(formatSignedDecimal('999999999999999999.99', 'USD')).toBe('999999999999999999.99');
    expect(formatSignedDecimal('-999999999999999999.99', 'USD')).toBe('-999999999999999999.99');
    expect(formatSignedDecimal('1.2300', 'USD')).toBe('1.23');
  });

  it('多出来的非零小数直接拒绝，避免舍入', () => {
    expect(() => formatSignedDecimal('1.239', 'USD')).toThrow(RangeError);
    expect(() => formatSignedDecimal('12.50', 'JPY')).toThrow(RangeError);
    expect(() => formatSignedDecimal('1e2', 'USD')).toThrow(RangeError);
    expect(() => formatSignedDecimal(' 1.00', 'USD')).toThrow(RangeError);
    expect(() => formatSignedDecimal('', 'USD')).toThrow(RangeError);
  });
});

describe('formatMinorRange', () => {
  it('高低不同时用连字符，相同只显示一个数', () => {
    expect(formatMinorRange(12, 120, 'USD')).toBe('0.12-1.20');
    expect(formatMinorRange(5000, 5000, 'USD')).toBe('50.00');
    expect(formatMinorRange(0, 3, 'JPY')).toBe('0-3');
    expect(formatMinorRange(1, 1234, 'KWD')).toBe('0.001-1.234');
    expect(formatMinorRange(-250, 0, 'USD')).toBe('-2.50-0.00');
  });
});

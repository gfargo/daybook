import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import {
  parseCsvRows,
  pick,
  parseAmount,
  parseTimestamp,
  normalizeAsset,
  normalizeHeader,
  assetLeg,
  suffixDuplicateIds,
  sanitizeNativeId,
  hashRows,
  hashString,
  parsePackedFee,
  FIAT_CURRENCIES,
} from './csv-helpers.js';

describe('csv-helpers', () => {
  describe('parseCsvRows', () => {
    it('normalizes headers and starts row numbers at 2', () => {
      const rows = parseCsvRows('Date Acquired,Amount\n2024-01-15,1.5');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.rowNumber).toBe(2);
      expect(rows[0]?.values).toEqual({ dateacquired: '2024-01-15', amount: '1.5' });
      expect(rows[0]?.original).toEqual({ 'Date Acquired': '2024-01-15', Amount: '1.5' });
    });

    it('tolerates BOM, trims whitespace, skips empties, accepts ragged rows', () => {
      const csv = '﻿Col A,Col B\n  hi  ,  there  \n\nx,y,extra';
      const rows = parseCsvRows(csv);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.values).toEqual({ cola: 'hi', colb: 'there' });
    });
  });

  describe('pick', () => {
    const row = parseCsvRows('Foo,Bar Baz\n1,2')[0]!;
    it('returns the first matching alias value', () => {
      expect(pick(row, ['foo'])).toBe('1');
      expect(pick(row, ['bar baz'])).toBe('2');
      expect(pick(row, ['barbaz', 'bar_baz'])).toBe('2');
    });
    it('returns undefined for unknown aliases', () => {
      expect(pick(row, ['nope', 'also nope'])).toBeUndefined();
    });
    it('returns undefined for empty cells', () => {
      const r = parseCsvRows('Foo,Bar\n,2')[0]!;
      expect(pick(r, ['foo'])).toBeUndefined();
      expect(pick(r, ['bar'])).toBe('2');
    });
  });

  describe('parseAmount', () => {
    it('parses bare numbers and decimals', () => {
      expect(parseAmount('1.5')?.toString()).toBe('1.5');
      expect(parseAmount('-0.001')?.toString()).toBe('-0.001');
    });
    it('strips currency symbols, commas, and spaces', () => {
      expect(parseAmount('$1,234.56')?.toString()).toBe('1234.56');
      expect(parseAmount(' £ 99.00')?.toString()).toBe('99');
    });
    it('handles parenthesized negatives', () => {
      expect(parseAmount('(50)')?.toString()).toBe('-50');
    });
    it('returns undefined for empty / dash / unparsable', () => {
      expect(parseAmount(undefined)).toBeUndefined();
      expect(parseAmount('')).toBeUndefined();
      expect(parseAmount('-')).toBeUndefined();
      expect(parseAmount('NaN-ish')).toBeUndefined();
    });
    it('returns Decimal(0) for explicit "0" (callers distinguish missing from zero)', () => {
      expect(parseAmount('0')?.toString()).toBe('0');
      expect(parseAmount('0.0')?.toString()).toBe('0');
    });
    it('with zeroAsUndefined returns undefined for zero (legacy adapter mode)', () => {
      expect(parseAmount('0', { zeroAsUndefined: true })).toBeUndefined();
      expect(parseAmount('0.0', { zeroAsUndefined: true })).toBeUndefined();
      // Non-zero values are unaffected
      expect(parseAmount('1.5', { zeroAsUndefined: true })?.toString()).toBe('1.5');
    });
  });

  describe('parseTimestamp', () => {
    it('parses ISO 8601', () => {
      const d = parseTimestamp('2024-01-15T12:34:56Z');
      expect(d?.toISOString()).toBe('2024-01-15T12:34:56.000Z');
    });
    it('treats plain space-separated as UTC', () => {
      const d = parseTimestamp('2024-01-15 12:34:56');
      expect(d?.toISOString()).toBe('2024-01-15T12:34:56.000Z');
    });
    it('parses 13-digit Unix ms', () => {
      const d = parseTimestamp('1707561600000');
      expect(d?.toISOString()).toBe('2024-02-10T10:40:00.000Z');
    });
    it('tolerates trailing CR', () => {
      const d = parseTimestamp('2024-01-15 12:34:56\r');
      expect(d?.toISOString()).toBe('2024-01-15T12:34:56.000Z');
    });
    it('returns undefined for unparsable input', () => {
      expect(parseTimestamp('')).toBeUndefined();
      expect(parseTimestamp('garbage')).toBeUndefined();
    });
  });

  describe('normalizeAsset', () => {
    it('uppercases plain tickers', () => {
      expect(normalizeAsset('btc')).toBe('BTC');
      expect(normalizeAsset('  USDT  ')).toBe('USDT');
    });
    it('lowercases 0x-prefixed addresses', () => {
      expect(normalizeAsset('0xABCDef')).toBe('0xabcdef');
    });
    it('returns undefined for empty', () => {
      expect(normalizeAsset('')).toBeUndefined();
      expect(normalizeAsset(undefined)).toBeUndefined();
    });
  });

  describe('normalizeHeader', () => {
    it('lowercases, strips BOM and CR, removes non-alphanumeric', () => {
      expect(normalizeHeader('Date & Time(UTC)')).toBe('datetimeutc');
      expect(normalizeHeader('﻿Order ID\r')).toBe('orderid');
      expect(normalizeHeader('  spaced  out  ')).toBe('spacedout');
    });
  });

  describe('assetLeg', () => {
    it('serializes amount with toFixed', () => {
      expect(assetLeg('BTC', new Decimal('0.00000001'))).toEqual({
        asset: 'BTC',
        amount: '0.00000001',
      });
    });
    it('flags fees', () => {
      expect(assetLeg('USDT', new Decimal('-1.5'), true)).toEqual({
        asset: 'USDT',
        amount: '-1.5',
        feeFlag: true,
      });
    });
  });

  describe('suffixDuplicateIds', () => {
    it('suffixes second+ occurrences', () => {
      const out = suffixDuplicateIds([
        { id: 'a', source: 'okx', accountId: 'x', timestamp: new Date(0), type: 'trade', legs: [], raw: {} },
        { id: 'a', source: 'okx', accountId: 'x', timestamp: new Date(0), type: 'trade', legs: [], raw: {} },
        { id: 'b', source: 'okx', accountId: 'x', timestamp: new Date(0), type: 'trade', legs: [], raw: {} },
      ]);
      expect(out.map(e => e.id)).toEqual(['a', 'a:2', 'b']);
    });
  });

  describe('sanitizeNativeId', () => {
    it('preserves safe characters and replaces unsafe', () => {
      expect(sanitizeNativeId('abc-123_v.1')).toBe('abc-123_v.1');
      expect(sanitizeNativeId('with spaces!')).toBe('with_spaces_');
    });
    it('caps length at 120 chars', () => {
      const long = 'x'.repeat(200);
      expect(sanitizeNativeId(long)).toHaveLength(120);
    });
    it('collapses runs of unsafe characters into a single _', () => {
      // Regex uses `+` so consecutive unsafe chars collapse.
      expect(sanitizeNativeId('!@#$%')).toBe('_');
    });
    it('falls back to a stable hash when the input has no safe characters at all', () => {
      // Empty string sanitizes to empty → falls through to hash.
      const result = sanitizeNativeId('');
      expect(result).toMatch(/^[a-f0-9]{16}$/);
    });
  });

  describe('hashRows / hashString', () => {
    it('produces stable 16-char hex', () => {
      const h = hashRows([{ a: '1', b: '2' }]);
      expect(h).toMatch(/^[a-f0-9]{16}$/);
      expect(hashRows([{ a: '1', b: '2' }])).toBe(h); // stable
    });
    it('is order-independent on keys within a row', () => {
      expect(hashRows([{ a: '1', b: '2' }])).toBe(hashRows([{ b: '2', a: '1' }]));
    });
    it('hashString produces the same format', () => {
      expect(hashString('hello')).toMatch(/^[a-f0-9]{16}$/);
    });
  });

  describe('FIAT_CURRENCIES', () => {
    it('contains the major fiats', () => {
      for (const c of ['USD', 'EUR', 'GBP', 'JPY']) {
        expect(FIAT_CURRENCIES.has(c)).toBe(true);
      }
    });
  });

  describe('parsePackedFee', () => {
    it('parses simple packed "<amount><TICKER>" cell', () => {
      const result = parsePackedFee('0.001BTC');
      expect(result?.amount.toString()).toBe('0.001');
      expect(result?.asset).toBe('BTC');
    });

    it('parses thousands-separated amount with ticker', () => {
      const result = parsePackedFee('1,050.5USDT');
      expect(result?.amount.toString()).toBe('1050.5');
      expect(result?.asset).toBe('USDT');
    });

    it('parses scientific notation with ticker', () => {
      const result = parsePackedFee('1e3USDT');
      expect(result?.amount.toString()).toBe('1000');
      expect(result?.asset).toBe('USDT');
    });

    it('parses space-separated amount and ticker', () => {
      const result = parsePackedFee('600 USDT');
      expect(result?.amount.toString()).toBe('600');
      expect(result?.asset).toBe('USDT');
    });

    it('parses bare number and uses defaultAsset', () => {
      const result = parsePackedFee('1.5', 'ETH');
      expect(result?.amount.toString()).toBe('1.5');
      expect(result?.asset).toBe('ETH');
    });

    it('parses bare number with no defaultAsset, asset is undefined', () => {
      const result = parsePackedFee('1.5');
      expect(result?.amount.toString()).toBe('1.5');
      expect(result?.asset).toBeUndefined();
    });

    it('preserves negative sign for rebates', () => {
      const result = parsePackedFee('-1.5USDT');
      expect(result?.amount.toString()).toBe('-1.5');
      expect(result?.asset).toBe('USDT');
    });

    it('preserves negative bare number', () => {
      const result = parsePackedFee('-0.001', 'BTC');
      expect(result?.amount.toString()).toBe('-0.001');
      expect(result?.asset).toBe('BTC');
    });

    it('returns undefined for empty string', () => {
      expect(parsePackedFee('')).toBeUndefined();
    });

    it('returns undefined for whitespace only', () => {
      expect(parsePackedFee('   ')).toBeUndefined();
    });

    it('returns undefined for undefined input', () => {
      expect(parsePackedFee(undefined)).toBeUndefined();
    });

    it('returns undefined for unparsable junk', () => {
      expect(parsePackedFee('abc')).toBeUndefined();
      expect(parsePackedFee('!@#$')).toBeUndefined();
    });

    it('handles EOS ticker without confusing with scientific notation', () => {
      // "10EOS" should parse as number=10, asset=EOS (not 10*e0*S)
      const result = parsePackedFee('10EOS');
      expect(result?.amount.toString()).toBe('10');
      expect(result?.asset).toBe('EOS');
    });

    it('handles 1E3USDT (uppercase E scientific) with ticker', () => {
      const result = parsePackedFee('1E3USDT');
      expect(result?.amount.toString()).toBe('1000');
      expect(result?.asset).toBe('USDT');
    });

    it('handles large numbers with commas', () => {
      const result = parsePackedFee('1,000,000.5BTC');
      expect(result?.amount.toString()).toBe('1000000.5');
      expect(result?.asset).toBe('BTC');
    });
  });
});

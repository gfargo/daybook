/**
 * Tests for account command validation.
 */

import { describe, expect, it } from 'vitest';
import { resolveAccountSource } from './account.js';

describe('resolveAccountSource', () => {
  it('accepts currently implemented sync sources', () => {
    expect(resolveAccountSource('coinbase')).toBe('coinbase');
    expect(resolveAccountSource('kraken')).toBe('kraken');
    expect(resolveAccountSource('csv')).toBe('csv');
    expect(resolveAccountSource('binance')).toBe('binance');
    expect(resolveAccountSource('binance-us')).toBe('binance-us');
    expect(resolveAccountSource('eth')).toBe('eth');
    expect(resolveAccountSource('polygon')).toBe('polygon');
  });

  it('rejects future sources that the sync command cannot handle yet', () => {
    expect(() => resolveAccountSource('coinbase-advanced')).toThrow(
      'Unsupported account source',
    );
    expect(() => resolveAccountSource('base')).toThrow(
      'Supported sources: coinbase, kraken, csv, binance, binance-us, eth, polygon',
    );
  });
});

/**
 * Tests for account command validation.
 */

import { describe, expect, it } from 'vitest';
import { resolveAccountSource } from './account.js';

describe('resolveAccountSource', () => {
  it('accepts currently implemented sync sources', () => {
    expect(resolveAccountSource('coinbase')).toBe('coinbase');
    expect(resolveAccountSource('kraken')).toBe('kraken');
    expect(resolveAccountSource('crypto-com')).toBe('crypto-com');
    expect(resolveAccountSource('csv')).toBe('csv');
    expect(resolveAccountSource('binance')).toBe('binance');
    expect(resolveAccountSource('binance-us')).toBe('binance-us');
    expect(resolveAccountSource('gemini')).toBe('gemini');
    expect(resolveAccountSource('robinhood')).toBe('robinhood');
    expect(resolveAccountSource('eth')).toBe('eth');
    expect(resolveAccountSource('polygon')).toBe('polygon');
    expect(resolveAccountSource('arbitrum')).toBe('arbitrum');
    expect(resolveAccountSource('base')).toBe('base');
    expect(resolveAccountSource('optimism')).toBe('optimism');
    expect(resolveAccountSource('bnb')).toBe('bnb');
  });

  it('rejects future sources that the sync command cannot handle yet', () => {
    expect(() => resolveAccountSource('coinbase-advanced')).toThrow(
      'Unsupported account source',
    );
    expect(() => resolveAccountSource('solana')).toThrow(
      'Supported sources: coinbase, kraken, crypto-com, csv, binance, binance-us, gemini, robinhood, eth, polygon, arbitrum, base, optimism, bnb',
    );
  });
});

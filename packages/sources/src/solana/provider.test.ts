/**
 * Unit tests for the Solana provider interface helpers.
 */

import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { lamportsToSol, rawTokenToDecimal, LAMPORTS_PER_SOL } from './provider.js';

describe('lamportsToSol', () => {
  it('converts 1 SOL correctly', () => {
    expect(lamportsToSol(LAMPORTS_PER_SOL).toString()).toBe('1');
  });

  it('converts 0.5 SOL without float precision loss', () => {
    expect(lamportsToSol(500_000_000).toString()).toBe('0.5');
  });

  it('converts small lamport amounts precisely', () => {
    // 1 lamport = 0.000000001 SOL
    expect(lamportsToSol(1).toString()).toBe('1e-9');
  });

  it('handles zero', () => {
    expect(lamportsToSol(0).toString()).toBe('0');
  });

  it('handles negative delta (outgoing)', () => {
    const result = lamportsToSol(-1_000_000_000);
    expect(result.toString()).toBe('-1');
  });
});

describe('rawTokenToDecimal', () => {
  it('converts USDC (6 decimals) correctly', () => {
    // 1,000,000 raw = 1.000000 USDC
    expect(rawTokenToDecimal('1000000', 6).toString()).toBe('1');
  });

  it('converts USDC partial amount without float drift', () => {
    // 1,500,000 raw = 1.5 USDC
    expect(rawTokenToDecimal('1500000', 6).toString()).toBe('1.5');
  });

  it('converts 18-decimal token', () => {
    const raw = '1000000000000000000'; // 1e18
    const result = rawTokenToDecimal(raw, 18);
    expect(result.toString()).toBe('1');
  });

  it('handles zero amount', () => {
    expect(rawTokenToDecimal('0', 6).toString()).toBe('0');
  });

  it('returns a Decimal instance for further arithmetic', () => {
    const result = rawTokenToDecimal('2500000', 6);
    expect(result).toBeInstanceOf(Decimal);
    expect(result.times(2).toString()).toBe('5');
  });
});

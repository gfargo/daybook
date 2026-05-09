import { describe, expect, it } from 'vitest';
import { CHAIN_ID_BY_SOURCE, SOURCE_BY_CHAIN_ID } from './provider.js';

describe('EVM source chain mappings', () => {
  it.each([
    ['eth', 1],
    ['polygon', 137],
    ['arbitrum', 42161],
    ['optimism', 10],
    ['base', 8453],
    ['bnb', 56],
  ] as const)('maps %s to chain ID %i and back', (source, chainId) => {
    expect(CHAIN_ID_BY_SOURCE[source]).toBe(chainId);
    expect(SOURCE_BY_CHAIN_ID[chainId]).toBe(source);
  });
});

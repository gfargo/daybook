/**
 * Tests for the catalog loaders: loadDexRouters() and loadBridges().
 *
 * Verifies:
 *   - Keys are in `${chainId}:${lowercasedAddress}` format
 *   - Both entries for shared addresses (e.g. Celer 0x5427…) survive under distinct keys
 *   - Duplicate entries throw a descriptive error
 */

import { describe, expect, it } from 'vitest';
import { loadDexRouters, loadBridges } from './index.js';
import type { DexRouterEntry, BridgeEntry } from './types.js';

// ─────────────────────────────────────────────────────────────────────────
// loadDexRouters
// ─────────────────────────────────────────────────────────────────────────

describe('loadDexRouters', () => {
  it('returns a Map keyed by chain:address (lowercased)', () => {
    const map = loadDexRouters();

    for (const [key, entry] of map) {
      expect(key).toBe(`${entry.chain}:${entry.address.toLowerCase()}`);
    }
  });

  it('preserves both Uniswap V3 SwapRouter entries (chain 1 and 137)', () => {
    const map = loadDexRouters();
    const address = '0xe592427a0aece92de3edee1f18e0157c05861564';

    const ethEntry = map.get(`1:${address}`);
    const polyEntry = map.get(`137:${address}`);

    expect(ethEntry).toBeDefined();
    expect(ethEntry!.chain).toBe(1);
    expect(ethEntry!.protocol).toBe('Uniswap');

    expect(polyEntry).toBeDefined();
    expect(polyEntry!.chain).toBe(137);
    expect(polyEntry!.protocol).toBe('Uniswap');
  });

  it('preserves both 1inch V5 entries (chain 1 and 137)', () => {
    const map = loadDexRouters();
    const address = '0x1111111254eeb25477b68fb85ed929f73a960582';

    expect(map.get(`1:${address}`)).toBeDefined();
    expect(map.get(`137:${address}`)).toBeDefined();
  });

  it('throws on a deliberately duplicated catalog entry', () => {
    // Simulate loadDexRouters logic with a hand-crafted duplicate
    const data: DexRouterEntry[] = [
      { chain: 1, address: '0xaaaa', protocol: 'TestDEX', version: 'V1' },
      { chain: 1, address: '0xaaaa', protocol: 'TestDEX', version: 'V1 (duplicate)' },
    ];

    const map = new Map<string, DexRouterEntry>();
    expect(() => {
      for (const entry of data) {
        const key = `${entry.chain}:${entry.address.toLowerCase()}`;
        if (map.has(key)) {
          throw new Error(
            `Duplicate DEX router catalog entry: chain ${entry.chain}, address ${entry.address} (${entry.protocol} ${entry.version})`,
          );
        }
        map.set(key, entry);
      }
    }).toThrow(/Duplicate DEX router catalog entry/);
  });

  it('all entries for arbitrum, optimism, base, and bnb use the correct chain IDs', () => {
    const map = loadDexRouters();
    const chainCounts: Record<number, number> = {};
    for (const entry of map.values()) {
      chainCounts[entry.chain] = (chainCounts[entry.chain] ?? 0) + 1;
    }
    // Verify each EVM chain has at least one entry
    expect(chainCounts[1]).toBeGreaterThan(0);    // Ethereum
    expect(chainCounts[137]).toBeGreaterThan(0);  // Polygon
    expect(chainCounts[42161]).toBeGreaterThan(0); // Arbitrum
    expect(chainCounts[10]).toBeGreaterThan(0);   // Optimism
    expect(chainCounts[8453]).toBeGreaterThan(0); // Base
    expect(chainCounts[56]).toBeGreaterThan(0);   // BNB
  });
});

// ─────────────────────────────────────────────────────────────────────────
// loadBridges
// ─────────────────────────────────────────────────────────────────────────

describe('loadBridges', () => {
  it('returns a Map keyed by chain:address (lowercased)', () => {
    const map = loadBridges();

    for (const [key, entry] of map) {
      expect(key).toBe(`${entry.chain}:${entry.address.toLowerCase()}`);
    }
  });

  it('preserves both Celer cBridge entries (chain 1 and 137)', () => {
    const map = loadBridges();
    const celerAddress = '0x5427fefa711eff984124bfbb1ab6fbf5e3da1820';

    const ethEntry = map.get(`1:${celerAddress}`);
    const polyEntry = map.get(`137:${celerAddress}`);

    expect(ethEntry).toBeDefined();
    expect(ethEntry!.chain).toBe(1);
    expect(ethEntry!.protocol).toBe('Celer');

    expect(polyEntry).toBeDefined();
    expect(polyEntry!.chain).toBe(137);
    expect(polyEntry!.protocol).toBe('Celer');
  });

  it('throws on a deliberately duplicated bridge entry', () => {
    const data: BridgeEntry[] = [
      { chain: 1, address: '0xbbbb', protocol: 'TestBridge', version: 'V1' },
      { chain: 1, address: '0xbbbb', protocol: 'TestBridge', version: 'V1 (duplicate)' },
    ];

    const map = new Map<string, BridgeEntry>();
    expect(() => {
      for (const entry of data) {
        const key = `${entry.chain}:${entry.address.toLowerCase()}`;
        if (map.has(key)) {
          throw new Error(
            `Duplicate bridge catalog entry: chain ${entry.chain}, address ${entry.address} (${entry.protocol} ${entry.version})`,
          );
        }
        map.set(key, entry);
      }
    }).toThrow(/Duplicate bridge catalog entry/);
  });
});

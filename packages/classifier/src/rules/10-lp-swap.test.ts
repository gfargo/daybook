/**
 * Unit tests for Rule 10 — LP deposit/withdrawal collapse.
 *
 * Tests mirror the style of 08-nft-classification.test.ts and
 * 09-defi-classification.test.ts.
 */

import { describe, expect, it } from 'vitest';
import type { RawEvent } from '@daybook/ledger';
import { lpSwap } from './10-lp-swap.js';
import { classify } from '../runner.js';
import { DEFAULT_RULES, loadDeFiContracts } from '../index.js';
import type { ClassifierContext, DeFiContractEntry } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Ethereum mainnet Uniswap V2 Factory — present in the real catalog with
 * kind: 'lp-router'.
 */
const UNI_V2_FACTORY = '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f';

/**
 * An address on Ethereum mainnet that is NOT in any catalog.
 */
const UNKNOWN_ADDR = '0x1234567890abcdef1234567890abcdef12345678';

/**
 * Build a ClassifierContext whose defiContracts catalog contains the real
 * catalog entries plus any provided extras.
 */
function makeContext(
  extras: [string, DeFiContractEntry][] = [],
): ClassifierContext {
  const defiContracts = loadDeFiContracts();
  for (const [key, entry] of extras) {
    defiContracts.set(key, entry);
  }
  return {
    ownAddresses: [],
    accountIds: [],
    dexRouters: new Map(),
    bridges: new Map(),
    defiContracts,
  };
}

/**
 * Build a minimal ClassifierContext with a synthetic lp-router entry keyed
 * `1:<address>` (Ethereum mainnet, chain 1) pointing at `LP_ROUTER_ADDR`.
 */
const SYNTH_LP_ROUTER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function makeContextWithSyntheticRouter(chain = 1): ClassifierContext {
  const entry: DeFiContractEntry = {
    chain,
    address: SYNTH_LP_ROUTER,
    protocol: 'TestProtocol',
    version: 'V2',
    kind: 'lp-router',
  };
  return makeContext([[`${chain}:${SYNTH_LP_ROUTER}`, entry]]);
}

/** Build a minimal RawEvent for an EVM (eth) source. */
function makeEvt(
  id: string,
  type: RawEvent['type'],
  amount: string,
  asset: string,
  overrides: Partial<RawEvent> = {},
): RawEvent {
  return {
    id,
    source: 'eth',
    accountId: 'eth-main',
    timestamp: new Date('2024-05-01T12:00:00Z'),
    type,
    legs: [{ asset, amount }],
    txHash: 'tx-lp-001',
    counterparty: SYNTH_LP_ROUTER,
    raw: {},
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// LP deposit: 2 out + 1 in
// ─────────────────────────────────────────────────────────────────────────

describe('LP deposit (2-out + 1-in)', () => {
  it('collapses two crypto_out + one crypto_in into a single trade entry', () => {
    const wethOut = makeEvt('eth:lp-d-weth-out', 'crypto_out', '-1', 'WETH');
    const usdcOut = makeEvt('eth:lp-d-usdc-out', 'crypto_out', '-2000', 'USDC');
    const lpIn = makeEvt('eth:lp-d-lp-in', 'crypto_in', '0.5', 'UNI-V2');

    const ctx = makeContextWithSyntheticRouter();
    const result = lpSwap.apply([wethOut, usdcOut, lpIn], ctx);

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.type).toBe('trade');
    expect(entry.reason).toMatch(/LP deposit/);
    expect(entry.reason).toMatch(/TestProtocol/);
    expect(entry.rawEventIds).toContain('eth:lp-d-weth-out');
    expect(entry.rawEventIds).toContain('eth:lp-d-usdc-out');
    expect(entry.rawEventIds).toContain('eth:lp-d-lp-in');
    expect(entry.legs).toHaveLength(3);

    // All three events consumed
    expect(result.consumedEventIds.has('eth:lp-d-weth-out')).toBe(true);
    expect(result.consumedEventIds.has('eth:lp-d-usdc-out')).toBe(true);
    expect(result.consumedEventIds.has('eth:lp-d-lp-in')).toBe(true);
  });

  it('includes the out legs with negative amounts and the in leg with positive amount', () => {
    const wethOut = makeEvt('eth:lp-d2-weth', 'crypto_out', '-1', 'WETH');
    const usdcOut = makeEvt('eth:lp-d2-usdc', 'crypto_out', '-2000', 'USDC');
    const lpIn = makeEvt('eth:lp-d2-lp', 'crypto_in', '0.5', 'UNI-V2');

    const ctx = makeContextWithSyntheticRouter();
    const result = lpSwap.apply([wethOut, usdcOut, lpIn], ctx);

    expect(result.entries).toHaveLength(1);
    const legs = result.entries[0]!.legs;
    const outCount = legs.filter((l) => parseFloat(l.amount) < 0).length;
    const inCount = legs.filter((l) => parseFloat(l.amount) > 0).length;
    expect(outCount).toBe(2);
    expect(inCount).toBe(1);
  });

  it('uses the earliest timestamp across the group', () => {
    const early = makeEvt('eth:lp-ts-a', 'crypto_out', '-1', 'WETH', {
      timestamp: new Date('2024-05-01T08:00:00Z'),
    });
    const late = makeEvt('eth:lp-ts-b', 'crypto_out', '-2000', 'USDC', {
      timestamp: new Date('2024-05-01T12:00:00Z'),
    });
    const lpIn = makeEvt('eth:lp-ts-c', 'crypto_in', '0.5', 'UNI-V2', {
      timestamp: new Date('2024-05-01T12:00:01Z'),
    });

    const ctx = makeContextWithSyntheticRouter();
    const result = lpSwap.apply([early, late, lpIn], ctx);

    expect(result.entries[0]!.timestamp).toEqual(new Date('2024-05-01T08:00:00Z'));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// LP withdrawal: 1 out + 2 in
// ─────────────────────────────────────────────────────────────────────────

describe('LP withdrawal (1-out + 2-in)', () => {
  it('collapses one crypto_out + two crypto_in into a single trade entry', () => {
    const lpOut = makeEvt('eth:lp-w-lp-out', 'crypto_out', '-0.5', 'UNI-V2');
    const wethIn = makeEvt('eth:lp-w-weth-in', 'crypto_in', '1', 'WETH');
    const usdcIn = makeEvt('eth:lp-w-usdc-in', 'crypto_in', '2000', 'USDC');

    const ctx = makeContextWithSyntheticRouter();
    const result = lpSwap.apply([lpOut, wethIn, usdcIn], ctx);

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.type).toBe('trade');
    expect(entry.reason).toMatch(/LP withdrawal/);
    expect(entry.rawEventIds).toContain('eth:lp-w-lp-out');
    expect(entry.rawEventIds).toContain('eth:lp-w-weth-in');
    expect(entry.rawEventIds).toContain('eth:lp-w-usdc-in');
    expect(entry.legs).toHaveLength(3);

    expect(result.consumedEventIds.has('eth:lp-w-lp-out')).toBe(true);
    expect(result.consumedEventIds.has('eth:lp-w-weth-in')).toBe(true);
    expect(result.consumedEventIds.has('eth:lp-w-usdc-in')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Fee leg preservation
// ─────────────────────────────────────────────────────────────────────────

describe('fee leg preservation', () => {
  it('separates feeFlag legs into the trade but does not count them as principal legs', () => {
    const wethOut = makeEvt('eth:lp-fee-weth', 'crypto_out', '-1', 'WETH');
    const usdcOut = makeEvt('eth:lp-fee-usdc', 'crypto_out', '-2000', 'USDC');
    const lpIn = makeEvt('eth:lp-fee-lp', 'crypto_in', '0.5', 'UNI-V2');
    // A gas fee event in the same tx
    const gasOut: RawEvent = {
      ...makeEvt('eth:lp-fee-gas', 'crypto_out', '-0.002', 'ETH'),
      legs: [{ asset: 'ETH', amount: '-0.002', feeFlag: true, amountUsdAtTime: '5' }],
    };

    const ctx = makeContextWithSyntheticRouter();
    const result = lpSwap.apply([wethOut, usdcOut, lpIn, gasOut], ctx);

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    // 3 principal legs + 1 fee leg
    expect(entry.legs).toHaveLength(4);
    const feeLeg = entry.legs.find((l) => l.feeFlag);
    expect(feeLeg).toBeDefined();
    expect(feeLeg!.asset).toBe('ETH');

    // All 4 events consumed
    expect(result.consumedEventIds.size).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Non-match: counterparty not in catalog
// ─────────────────────────────────────────────────────────────────────────

describe('non-match: counterparty not in catalog', () => {
  it('does not consume events when the counterparty address is not an lp-router', () => {
    const wethOut = makeEvt('eth:nm-weth', 'crypto_out', '-1', 'WETH', {
      counterparty: UNKNOWN_ADDR,
    });
    const usdcOut = makeEvt('eth:nm-usdc', 'crypto_out', '-2000', 'USDC', {
      counterparty: UNKNOWN_ADDR,
    });
    const lpIn = makeEvt('eth:nm-lp', 'crypto_in', '0.5', 'UNI-V2', {
      counterparty: UNKNOWN_ADDR,
    });

    const ctx = makeContextWithSyntheticRouter();
    const result = lpSwap.apply([wethOut, usdcOut, lpIn], ctx);

    expect(result.entries).toHaveLength(0);
    expect(result.consumedEventIds.size).toBe(0);
  });

  it('does not match when the catalog entry is a DEX router (not lp-router)', () => {
    // Uniswap V2 swap router is in dex-routers.json, not defiContracts
    // Simulate a defi catalog entry with kind 'staking' at the same address
    const entry: DeFiContractEntry = {
      chain: 1,
      address: SYNTH_LP_ROUTER,
      protocol: 'TestProtocol',
      version: 'V2',
      kind: 'staking', // wrong kind
    };
    const ctx = makeContext([[`1:${SYNTH_LP_ROUTER}`, entry]]);

    const wethOut = makeEvt('eth:kind-weth', 'crypto_out', '-1', 'WETH');
    const usdcOut = makeEvt('eth:kind-usdc', 'crypto_out', '-2000', 'USDC');
    const lpIn = makeEvt('eth:kind-lp', 'crypto_in', '0.5', 'UNI-V2');

    const result = lpSwap.apply([wethOut, usdcOut, lpIn], ctx);

    expect(result.entries).toHaveLength(0);
    expect(result.consumedEventIds.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Non-match: wrong chain
// ─────────────────────────────────────────────────────────────────────────

describe('non-match: lp-router on different chain', () => {
  it('does not match when the event source maps to chain 137 but the catalog entry is chain 1', () => {
    // SYNTH_LP_ROUTER is only in the catalog for chain 1 (Ethereum mainnet).
    // Events with source: 'polygon' map to chain 137.
    const polygonWethOut: RawEvent = {
      ...makeEvt('polygon:lp-weth', 'crypto_out', '-1', 'WETH'),
      source: 'polygon',
      counterparty: SYNTH_LP_ROUTER, // this address is not in the catalog for chain 137
    };
    const polygonUsdcOut: RawEvent = {
      ...makeEvt('polygon:lp-usdc', 'crypto_out', '-2000', 'USDC'),
      source: 'polygon',
      counterparty: SYNTH_LP_ROUTER,
    };
    const polygonLpIn: RawEvent = {
      ...makeEvt('polygon:lp-lp', 'crypto_in', '0.5', 'SLP'),
      source: 'polygon',
      counterparty: SYNTH_LP_ROUTER,
    };

    // Context only has the synthetic router at chain 1
    const ctx = makeContextWithSyntheticRouter(1);
    const result = lpSwap.apply([polygonWethOut, polygonUsdcOut, polygonLpIn], ctx);

    expect(result.entries).toHaveLength(0);
    expect(result.consumedEventIds.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Non-match: single-event group
// ─────────────────────────────────────────────────────────────────────────

describe('non-match: single-event group', () => {
  it('does not collapse a group of 1 event', () => {
    const solo = makeEvt('eth:solo', 'crypto_in', '1', 'WETH');

    const ctx = makeContextWithSyntheticRouter();
    const result = lpSwap.apply([solo], ctx);

    expect(result.entries).toHaveLength(0);
    expect(result.consumedEventIds.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Non-match: shape not recognized (e.g. 1-out + 1-in)
// ─────────────────────────────────────────────────────────────────────────

describe('non-match: shape not recognized', () => {
  it('does not collapse a 1-out + 1-in group (ambiguous — could be a simple DEX swap)', () => {
    const ethOut = makeEvt('eth:shape-eth-out', 'crypto_out', '-1', 'ETH');
    const wethIn = makeEvt('eth:shape-weth-in', 'crypto_in', '1', 'WETH');

    const ctx = makeContextWithSyntheticRouter();
    const result = lpSwap.apply([ethOut, wethIn], ctx);

    expect(result.entries).toHaveLength(0);
    expect(result.consumedEventIds.size).toBe(0);
  });

  it('does not collapse a 2-out + 1-in group where both out-legs are the same asset', () => {
    // Same asset (WETH) on both out legs — not a real LP deposit (two distinct tokens required)
    const weth1 = makeEvt('eth:dup-weth-1', 'crypto_out', '-1', 'WETH');
    const weth2 = makeEvt('eth:dup-weth-2', 'crypto_out', '-1', 'WETH');
    const lpIn = makeEvt('eth:dup-lp', 'crypto_in', '0.5', 'UNI-V2');

    const ctx = makeContextWithSyntheticRouter();
    const result = lpSwap.apply([weth1, weth2, lpIn], ctx);

    expect(result.entries).toHaveLength(0);
    expect(result.consumedEventIds.size).toBe(0);
  });

  it('does not collapse a 1-out + 2-in group where both in-legs are the same asset', () => {
    const lpOut = makeEvt('eth:dup-lp-out', 'crypto_out', '-0.5', 'UNI-V2');
    const weth1 = makeEvt('eth:dup-in-1', 'crypto_in', '0.5', 'WETH');
    const weth2 = makeEvt('eth:dup-in-2', 'crypto_in', '0.5', 'WETH');

    const ctx = makeContextWithSyntheticRouter();
    const result = lpSwap.apply([lpOut, weth1, weth2], ctx);

    expect(result.entries).toHaveLength(0);
    expect(result.consumedEventIds.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Non-match: no txHash
// ─────────────────────────────────────────────────────────────────────────

describe('non-match: no txHash', () => {
  it('ignores events without a txHash', () => {
    const wethOut: RawEvent = {
      ...makeEvt('eth:notx-weth', 'crypto_out', '-1', 'WETH'),
      txHash: undefined,
    };
    const usdcOut: RawEvent = {
      ...makeEvt('eth:notx-usdc', 'crypto_out', '-2000', 'USDC'),
      txHash: undefined,
    };
    const lpIn: RawEvent = {
      ...makeEvt('eth:notx-lp', 'crypto_in', '0.5', 'UNI-V2'),
      txHash: undefined,
    };

    const ctx = makeContextWithSyntheticRouter();
    const result = lpSwap.apply([wethOut, usdcOut, lpIn], ctx);

    expect(result.entries).toHaveLength(0);
    expect(result.consumedEventIds.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Real catalog entry: Uniswap V2 Factory on Ethereum mainnet (chain 1)
// ─────────────────────────────────────────────────────────────────────────

// Smoke test that the real defi-contracts.json loads and rule 10 finds its
// lp-router entries by address — not a correctness test of the catalog
// contents. If this address is ever corrected or removed in
// defi-contracts.json, update UNI_V2_FACTORY above to match.
describe('real catalog: Uniswap V2 Factory (chain 1)', () => {
  it('collapses an LP deposit using the real catalog entry', () => {
    const wethOut: RawEvent = {
      ...makeEvt('eth:real-weth', 'crypto_out', '-1', 'WETH'),
      counterparty: UNI_V2_FACTORY,
    };
    const usdcOut: RawEvent = {
      ...makeEvt('eth:real-usdc', 'crypto_out', '-2000', 'USDC'),
      counterparty: UNI_V2_FACTORY,
    };
    const lpIn: RawEvent = {
      ...makeEvt('eth:real-lp', 'crypto_in', '0.5', 'UNI-V2'),
      counterparty: UNI_V2_FACTORY,
    };

    const ctx = makeContext(); // uses real loaded catalog (no extras)
    const result = lpSwap.apply([wethOut, usdcOut, lpIn], ctx);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.type).toBe('trade');
    expect(result.entries[0]!.reason).toMatch(/LP deposit/);
    expect(result.entries[0]!.reason).toMatch(/Uniswap/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DEFAULT_RULES integration: rule 04 and rule 10 don't double-claim
// ─────────────────────────────────────────────────────────────────────────

describe('DEFAULT_RULES integration', () => {
  it('rule 04 and rule 10 do not both consume the same tx', () => {
    // Use SYNTH_LP_ROUTER which is only in defiContracts (lp-router), not in dexRouters.
    // Rule 04 will not see this address; rule 10 will.
    const wethOut = makeEvt('eth:int-weth', 'crypto_out', '-1', 'WETH');
    const usdcOut = makeEvt('eth:int-usdc', 'crypto_out', '-2000', 'USDC');
    const lpIn = makeEvt('eth:int-lp', 'crypto_in', '0.5', 'UNI-V2');

    const ctx = makeContextWithSyntheticRouter();
    const result = classify([wethOut, usdcOut, lpIn], [], ctx, DEFAULT_RULES);

    // Exactly one trade entry — not duplicated
    const tradeEntries = result.entries.filter((e) => e.type === 'trade');
    expect(tradeEntries).toHaveLength(1);
    expect(tradeEntries[0]!.reason).toMatch(/LP deposit/);
  });
});

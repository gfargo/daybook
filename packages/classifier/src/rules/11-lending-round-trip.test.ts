/**
 * Unit tests for Rule 11 — lending round-trip (Aave / Compound).
 *
 * Mirrors the structure of 08-nft-classification.test.ts and
 * 09-defi-classification.test.ts.
 *
 * The synthetic lending-pool entries injected here use the SAME addresses
 * that appear in defi-contracts.json so that catalog-integrity is implicitly
 * exercised alongside rule logic.
 */

import { describe, expect, it } from 'vitest';
import type { RawEvent } from '@daybook/ledger';
import { lendingRoundTrip } from './11-lending-round-trip.js';
import { loadDeFiContracts } from '../index.js';
import type { ClassifierContext, DeFiContractEntry } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────
// Well-known addresses (from defi-contracts.json — keep in sync)
// ─────────────────────────────────────────────────────────────────────────

// Aave V3 on Ethereum — aToken contracts
const AAVE_V3_AUSDC_ETH = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c';
const AAVE_V3_AWETH_ETH = '0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8';

// Aave V2 on Ethereum — aToken contracts
const AAVE_V2_AWETH_ETH = '0x030ba81f1c18d280636f32af80b9aad02cf0854e';

// Compound V2 on Ethereum — cToken contracts
const COMPOUND_V2_CUSDC = '0x39aa39c021dfbae8fac545936693ac917d5e7563';
const COMPOUND_V2_CETH  = '0x4ddc2d193948926d02f9b1fe9e1daa0718270ed5';

// A random address that is NOT in the catalog
const UNKNOWN_ADDR = '0x1234567890abcdef1234567890abcdef12345678';

// The Ethereum null address — Aave aTokens are minted from here
const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';

// ─────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────

function makeContext(
  extraEntries: [string, DeFiContractEntry][] = [],
): ClassifierContext {
  const defiContracts = loadDeFiContracts();
  for (const [key, entry] of extraEntries) {
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

let _eventCounter = 0;
function makeEvent(overrides: Partial<RawEvent> & Pick<RawEvent, 'type' | 'legs'>): RawEvent {
  _eventCounter++;
  return {
    id: `eth:test-${_eventCounter}`,
    source: 'eth',
    accountId: 'eth-main',
    timestamp: new Date('2024-06-01T12:00:00Z'),
    txHash: '0xdeadbeef0001',
    counterparty: undefined,
    raw: {},
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Aave V3 deposit (supply): USDC out → aUSDC in
// ─────────────────────────────────────────────────────────────────────────

describe('Aave V3 deposit (supply)', () => {
  it('classifies underlying out + aToken in as a single trade entry', () => {
    const txHash = '0xaave_v3_deposit_1';
    const underlying = makeEvent({
      id: 'eth:aave-v3-deposit-usdc-out',
      type: 'crypto_out',
      txHash,
      counterparty: AAVE_V3_AUSDC_ETH,
      legs: [
        { asset: 'USDC', amount: '-1000', amountUsdAtTime: '1000',
          contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
      ],
    });
    const receipt = makeEvent({
      id: 'eth:aave-v3-deposit-ausdc-in',
      type: 'crypto_in',
      txHash,
      counterparty: NULL_ADDRESS,
      legs: [
        { asset: 'aEthUSDC', amount: '1000', amountUsdAtTime: '1000',
          contractAddress: AAVE_V3_AUSDC_ETH },
      ],
    });

    const ctx = makeContext();
    const result = lendingRoundTrip.apply([underlying, receipt], ctx);

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.type).toBe('trade');
    expect(entry.rawEventIds).toContain('eth:aave-v3-deposit-usdc-out');
    expect(entry.rawEventIds).toContain('eth:aave-v3-deposit-ausdc-in');
    expect(entry.legs).toHaveLength(2);
    expect(entry.reason).toMatch(/Aave.*supply/i);
    expect(result.consumedEventIds.has('eth:aave-v3-deposit-usdc-out')).toBe(true);
    expect(result.consumedEventIds.has('eth:aave-v3-deposit-ausdc-in')).toBe(true);
  });

  it('detection fires via leg.contractAddress on the aToken in-leg (null-address mint path)', () => {
    // The underlying out-leg's counterparty is the Aave Pool (NOT in the catalog).
    // Detection must still fire because the aToken in-leg carries contractAddress
    // matching a cataloged lending-pool entry.
    const txHash = '0xaave_v3_deposit_contractaddr';
    const underlying = makeEvent({
      id: 'eth:aave-v3-deposit-underlying',
      type: 'crypto_out',
      txHash,
      counterparty: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', // Aave V3 Pool (not cataloged)
      legs: [
        { asset: 'WETH', amount: '-1', amountUsdAtTime: '3000',
          contractAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' },
      ],
    });
    const receipt = makeEvent({
      id: 'eth:aave-v3-deposit-aweth-in',
      type: 'crypto_in',
      txHash,
      counterparty: NULL_ADDRESS,
      legs: [
        { asset: 'aEthWETH', amount: '1', amountUsdAtTime: '3000',
          contractAddress: AAVE_V3_AWETH_ETH },
      ],
    });

    const ctx = makeContext();
    const result = lendingRoundTrip.apply([underlying, receipt], ctx);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.type).toBe('trade');
    expect(result.consumedEventIds.has('eth:aave-v3-deposit-underlying')).toBe(true);
    expect(result.consumedEventIds.has('eth:aave-v3-deposit-aweth-in')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Aave V3 withdrawal (redeem): aUSDC out → USDC in
// ─────────────────────────────────────────────────────────────────────────

describe('Aave V3 withdrawal (redeem)', () => {
  it('classifies aToken out + underlying in as a single trade entry', () => {
    const txHash = '0xaave_v3_withdraw_1';
    const receiptOut = makeEvent({
      id: 'eth:aave-v3-withdraw-ausdc-out',
      type: 'crypto_out',
      txHash,
      counterparty: NULL_ADDRESS,
      legs: [
        { asset: 'aEthUSDC', amount: '-1000', amountUsdAtTime: '1000',
          contractAddress: AAVE_V3_AUSDC_ETH },
      ],
    });
    const underlyingIn = makeEvent({
      id: 'eth:aave-v3-withdraw-usdc-in',
      type: 'crypto_in',
      txHash,
      counterparty: AAVE_V3_AUSDC_ETH,
      legs: [
        { asset: 'USDC', amount: '1000', amountUsdAtTime: '1000',
          contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
      ],
    });

    const ctx = makeContext();
    const result = lendingRoundTrip.apply([receiptOut, underlyingIn], ctx);

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.type).toBe('trade');
    expect(entry.rawEventIds).toContain('eth:aave-v3-withdraw-ausdc-out');
    expect(entry.rawEventIds).toContain('eth:aave-v3-withdraw-usdc-in');
    expect(entry.reason).toMatch(/redeem/i);
    expect(result.consumedEventIds.has('eth:aave-v3-withdraw-ausdc-out')).toBe(true);
    expect(result.consumedEventIds.has('eth:aave-v3-withdraw-usdc-in')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Aave V2 deposit: WETH out → aWETH in
// ─────────────────────────────────────────────────────────────────────────

describe('Aave V2 deposit', () => {
  it('classifies Aave V2 underlying out + aToken in as trade', () => {
    const txHash = '0xaave_v2_deposit_1';
    const underlying = makeEvent({
      id: 'eth:aave-v2-weth-out',
      type: 'crypto_out',
      txHash,
      counterparty: AAVE_V2_AWETH_ETH,
      legs: [
        { asset: 'WETH', amount: '-2', amountUsdAtTime: '6000',
          contractAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' },
      ],
    });
    const receipt = makeEvent({
      id: 'eth:aave-v2-aweth-in',
      type: 'crypto_in',
      txHash,
      counterparty: NULL_ADDRESS,
      legs: [
        { asset: 'aWETH', amount: '2', amountUsdAtTime: '6000',
          contractAddress: AAVE_V2_AWETH_ETH },
      ],
    });

    const ctx = makeContext();
    const result = lendingRoundTrip.apply([underlying, receipt], ctx);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.type).toBe('trade');
    expect(result.entries[0]!.reason).toMatch(/Aave.*supply/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Compound V2 deposit: USDC out → cUSDC in
// ─────────────────────────────────────────────────────────────────────────

describe('Compound V2 deposit', () => {
  it('classifies USDC out + cUSDC in (counterparty-based detection) as trade', () => {
    const txHash = '0xcompound_v2_deposit_1';
    // On Compound V2, the cToken contract is the counterparty on the underlying leg
    const underlying = makeEvent({
      id: 'eth:compound-usdc-out',
      type: 'crypto_out',
      txHash,
      counterparty: COMPOUND_V2_CUSDC, // cToken = counterparty
      legs: [
        { asset: 'USDC', amount: '-500', amountUsdAtTime: '500',
          contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
      ],
    });
    const receipt = makeEvent({
      id: 'eth:compound-cusdc-in',
      type: 'crypto_in',
      txHash,
      counterparty: NULL_ADDRESS,
      legs: [
        { asset: 'cUSDC', amount: '22500', amountUsdAtTime: '500',
          contractAddress: COMPOUND_V2_CUSDC },
      ],
    });

    const ctx = makeContext();
    const result = lendingRoundTrip.apply([underlying, receipt], ctx);

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.type).toBe('trade');
    expect(entry.rawEventIds).toContain('eth:compound-usdc-out');
    expect(entry.rawEventIds).toContain('eth:compound-cusdc-in');
    expect(entry.reason).toMatch(/Compound.*supply/i);
    expect(result.consumedEventIds.has('eth:compound-usdc-out')).toBe(true);
    expect(result.consumedEventIds.has('eth:compound-cusdc-in')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Compound V2 cETH: native ETH out → cETH in
// ─────────────────────────────────────────────────────────────────────────

describe('Compound V2 cETH (native ETH deposit)', () => {
  it('classifies native ETH out + cETH in as trade', () => {
    const txHash = '0xcompound_ceth_deposit_1';
    // The native ETH out-leg has no contractAddress; detection fires on the
    // cETH in-leg's contractAddress (the robust contractAddress path).
    const ethOut = makeEvent({
      id: 'eth:compound-eth-out',
      type: 'crypto_out',
      txHash,
      counterparty: COMPOUND_V2_CETH,
      legs: [
        // Native ETH — no contractAddress
        { asset: 'ETH', amount: '-1', amountUsdAtTime: '3000' },
      ],
    });
    const cethIn = makeEvent({
      id: 'eth:compound-ceth-in',
      type: 'crypto_in',
      txHash,
      counterparty: NULL_ADDRESS,
      legs: [
        { asset: 'cETH', amount: '47.5', amountUsdAtTime: '3000',
          contractAddress: COMPOUND_V2_CETH },
      ],
    });

    const ctx = makeContext();
    const result = lendingRoundTrip.apply([ethOut, cethIn], ctx);

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.type).toBe('trade');
    // The native ETH leg (no contractAddress) must be in the entry
    const ethLeg = entry.legs.find(l => l.asset === 'ETH');
    expect(ethLeg).toBeDefined();
    expect(ethLeg!.amount).toBe('-1');
    // The cETH leg must also be present
    const cethLeg = entry.legs.find(l => l.asset === 'cETH');
    expect(cethLeg).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Compound V2 withdrawal: cUSDC out → USDC in
// ─────────────────────────────────────────────────────────────────────────

describe('Compound V2 withdrawal (redeem)', () => {
  it('classifies cUSDC out + USDC in as trade', () => {
    const txHash = '0xcompound_v2_withdraw_1';
    const cTokenOut = makeEvent({
      id: 'eth:compound-cusdc-out',
      type: 'crypto_out',
      txHash,
      counterparty: NULL_ADDRESS,
      legs: [
        { asset: 'cUSDC', amount: '-22500', amountUsdAtTime: '500',
          contractAddress: COMPOUND_V2_CUSDC },
      ],
    });
    const underlyingIn = makeEvent({
      id: 'eth:compound-usdc-in',
      type: 'crypto_in',
      txHash,
      counterparty: COMPOUND_V2_CUSDC,
      legs: [
        { asset: 'USDC', amount: '500', amountUsdAtTime: '500',
          contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
      ],
    });

    const ctx = makeContext();
    const result = lendingRoundTrip.apply([cTokenOut, underlyingIn], ctx);

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.type).toBe('trade');
    expect(entry.reason).toMatch(/redeem/i);
    expect(result.consumedEventIds.has('eth:compound-cusdc-out')).toBe(true);
    expect(result.consumedEventIds.has('eth:compound-usdc-in')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Fee leg is preserved on the trade entry
// ─────────────────────────────────────────────────────────────────────────

describe('fee leg preservation', () => {
  it('includes gas fee leg on the trade entry', () => {
    const txHash = '0xaave_fee_test_1';
    const underlying = makeEvent({
      id: 'eth:aave-fee-usdc-out',
      type: 'crypto_out',
      txHash,
      counterparty: AAVE_V3_AUSDC_ETH,
      legs: [
        { asset: 'USDC', amount: '-1000', amountUsdAtTime: '1000',
          contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
        { asset: 'ETH', amount: '-0.002', amountUsdAtTime: '6', feeFlag: true },
      ],
    });
    const receipt = makeEvent({
      id: 'eth:aave-fee-ausdc-in',
      type: 'crypto_in',
      txHash,
      counterparty: NULL_ADDRESS,
      legs: [
        { asset: 'aEthUSDC', amount: '1000', amountUsdAtTime: '1000',
          contractAddress: AAVE_V3_AUSDC_ETH },
      ],
    });

    const ctx = makeContext();
    const result = lendingRoundTrip.apply([underlying, receipt], ctx);

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    const feeLeg = entry.legs.find(l => l.feeFlag);
    expect(feeLeg).toBeDefined();
    expect(feeLeg!.asset).toBe('ETH');
    expect(feeLeg!.amount).toBe('-0.002');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Negative cases — must NOT be consumed
// ─────────────────────────────────────────────────────────────────────────

describe('unknown contract — not consumed', () => {
  it('does not consume events whose contract is not in the lending catalog', () => {
    const txHash = '0xunknown_contract_1';
    const out = makeEvent({
      id: 'eth:unknown-out',
      type: 'crypto_out',
      txHash,
      counterparty: UNKNOWN_ADDR,
      legs: [{ asset: 'DAI', amount: '-100', contractAddress: UNKNOWN_ADDR }],
    });
    const inn = makeEvent({
      id: 'eth:unknown-in',
      type: 'crypto_in',
      txHash,
      counterparty: UNKNOWN_ADDR,
      legs: [{ asset: 'xDAI', amount: '100', contractAddress: UNKNOWN_ADDR }],
    });

    const result = lendingRoundTrip.apply([out, inn], makeContext());

    expect(result.entries).toHaveLength(0);
    expect(result.consumedEventIds.size).toBe(0);
  });
});

describe('non-EVM source — not consumed', () => {
  it('does not consume events from non-EVM sources even with a cataloged address', () => {
    const txHash = '0xcoinbase_lending_1';
    const out = makeEvent({
      id: 'coinbase:out-1',
      source: 'coinbase',
      type: 'crypto_out',
      txHash,
      counterparty: AAVE_V3_AUSDC_ETH,
      legs: [{ asset: 'USDC', amount: '-100' }],
    });
    const inn = makeEvent({
      id: 'coinbase:in-1',
      source: 'coinbase',
      type: 'crypto_in',
      txHash,
      counterparty: NULL_ADDRESS,
      legs: [
        { asset: 'aUSDC', amount: '100', contractAddress: AAVE_V3_AUSDC_ETH },
      ],
    });

    const result = lendingRoundTrip.apply([out, inn], makeContext());

    expect(result.entries).toHaveLength(0);
    expect(result.consumedEventIds.size).toBe(0);
  });
});

describe('single-leg (no round-trip) — not consumed', () => {
  it('does not consume a lone crypto_out touching a lending contract', () => {
    const out = makeEvent({
      id: 'eth:single-out',
      type: 'crypto_out',
      txHash: '0xsingle_out',
      counterparty: AAVE_V3_AUSDC_ETH,
      legs: [
        { asset: 'USDC', amount: '-100',
          contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
      ],
    });

    const result = lendingRoundTrip.apply([out], makeContext());

    expect(result.entries).toHaveLength(0);
    expect(result.consumedEventIds.size).toBe(0);
  });

  it('does not consume a lone crypto_in touching a lending contract', () => {
    const inn = makeEvent({
      id: 'eth:single-in',
      type: 'crypto_in',
      txHash: '0xsingle_in',
      counterparty: NULL_ADDRESS,
      legs: [
        { asset: 'aEthUSDC', amount: '100',
          contractAddress: AAVE_V3_AUSDC_ETH },
      ],
    });

    const result = lendingRoundTrip.apply([inn], makeContext());

    expect(result.entries).toHaveLength(0);
    expect(result.consumedEventIds.size).toBe(0);
  });
});

describe('no txHash — not consumed', () => {
  it('does not consume events without a txHash', () => {
    const out = makeEvent({
      id: 'eth:no-txhash-out',
      type: 'crypto_out',
      txHash: undefined,
      counterparty: AAVE_V3_AUSDC_ETH,
      legs: [
        { asset: 'USDC', amount: '-100',
          contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
      ],
    });

    const result = lendingRoundTrip.apply([out], makeContext());

    expect(result.entries).toHaveLength(0);
    expect(result.consumedEventIds.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Determinism: same input → same entryId
// ─────────────────────────────────────────────────────────────────────────

describe('determinism', () => {
  it('produces the same entry ID for the same input on repeated calls', () => {
    const txHash = '0xdeterminism_test';
    const underlying = makeEvent({
      id: 'eth:determ-usdc-out',
      type: 'crypto_out',
      txHash,
      counterparty: AAVE_V3_AUSDC_ETH,
      legs: [
        { asset: 'USDC', amount: '-1000', amountUsdAtTime: '1000',
          contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
      ],
    });
    const receipt = makeEvent({
      id: 'eth:determ-ausdc-in',
      type: 'crypto_in',
      txHash,
      counterparty: NULL_ADDRESS,
      legs: [
        { asset: 'aEthUSDC', amount: '1000', amountUsdAtTime: '1000',
          contractAddress: AAVE_V3_AUSDC_ETH },
      ],
    });

    const ctx = makeContext();
    const r1 = lendingRoundTrip.apply([underlying, receipt], ctx);
    const r2 = lendingRoundTrip.apply([underlying, receipt], ctx);

    expect(r1.entries[0]!.id).toBe(r2.entries[0]!.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Catalog integrity: loadDeFiContracts() must not throw on production data
// ─────────────────────────────────────────────────────────────────────────

describe('catalog integrity', () => {
  it('loadDeFiContracts() builds without duplicate-key errors', () => {
    expect(() => loadDeFiContracts()).not.toThrow();
  });

  it('catalog contains lending-pool entries for Aave and Compound', () => {
    const catalog = loadDeFiContracts();
    // At least one Aave V3 aToken
    expect(catalog.get(`1:${AAVE_V3_AUSDC_ETH}`)?.kind).toBe('lending-pool');
    // At least one Compound V2 cToken
    expect(catalog.get(`1:${COMPOUND_V2_CUSDC}`)?.kind).toBe('lending-pool');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Staking contracts must NOT be consumed by this rule
// ─────────────────────────────────────────────────────────────────────────

describe('staking contracts — not consumed by this rule', () => {
  it('does not consume events touching a staking contract (lp-router or staking kind)', () => {
    const LIDO_STETH = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84';
    const txHash = '0xstaking_not_lending';
    const out = makeEvent({
      id: 'eth:staking-eth-out',
      type: 'crypto_out',
      txHash,
      counterparty: LIDO_STETH,
      legs: [{ asset: 'ETH', amount: '-1' }],
    });
    const inn = makeEvent({
      id: 'eth:staking-steth-in',
      type: 'crypto_in',
      txHash,
      counterparty: NULL_ADDRESS,
      legs: [
        { asset: 'stETH', amount: '1',
          contractAddress: LIDO_STETH },
      ],
    });

    const result = lendingRoundTrip.apply([out, inn], makeContext());

    // Lido stETH is kind='staking', not 'lending-pool' — rule 10 must not consume it
    expect(result.entries).toHaveLength(0);
    expect(result.consumedEventIds.size).toBe(0);
  });
});

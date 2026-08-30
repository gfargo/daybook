/**
 * Unit tests for Rule 09 — DeFi classification.
 */

import { describe, expect, it } from 'vitest';
import type { RawEvent } from '@daybook/ledger';
import { defiClassification } from './09-defi-classification.js';
import { loadDeFiContracts } from '../index.js';
import type { ClassifierContext, DeFiContractEntry } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────

/** Known Lido stETH staking contract on Ethereum mainnet (chain 1). */
const LIDO_STETH = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84';
/** Known Lido Execution Layer Rewards Vault (reward-distributor) on chain 1. */
const LIDO_REWARDS = '0x388c818ca8b9251b393131c08a736a67ccb19297';
/** A random address that is NOT in the catalog. */
const UNKNOWN_ADDR = '0x1234567890abcdef1234567890abcdef12345678';

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

function makeEthEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    id: 'eth:test-event-1',
    source: 'eth',
    accountId: 'eth-main',
    timestamp: new Date('2024-06-01T12:00:00Z'),
    type: 'crypto_in',
    legs: [{ asset: 'ETH', amount: '0.05' }],
    txHash: '0xdeadbeef',
    counterparty: LIDO_STETH,
    raw: {},
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// reward-distributor → income
// ─────────────────────────────────────────────────────────────────────────

describe('reward-distributor crypto_in', () => {
  it('classifies crypto_in from a reward-distributor as income', () => {
    const evt = makeEthEvent({
      id: 'eth:reward-1',
      type: 'crypto_in',
      counterparty: LIDO_REWARDS,
      legs: [{ asset: 'ETH', amount: '0.02' }],
    });

    const result = defiClassification.apply([evt], makeContext());

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.type).toBe('income');
    expect(entry.rawEventIds).toEqual(['eth:reward-1']);
    expect(entry.reason).toMatch(/Lido/);
    expect(result.consumedEventIds.has('eth:reward-1')).toBe(true);
  });

  it('does NOT classify crypto_out from a reward-distributor (not consumed)', () => {
    const evt = makeEthEvent({
      id: 'eth:reward-out-1',
      type: 'crypto_out',
      counterparty: LIDO_REWARDS,
      legs: [{ asset: 'ETH', amount: '-0.01' }],
    });

    const result = defiClassification.apply([evt], makeContext());

    expect(result.entries).toHaveLength(0);
    expect(result.consumedEventIds.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// staking + native-asset crypto_out → transfer_self (stake)
// ─────────────────────────────────────────────────────────────────────────

describe('staking crypto_out of native asset (stake)', () => {
  it('classifies native-asset crypto_out to a staking contract as transfer_self', () => {
    const evt = makeEthEvent({
      id: 'eth:stake-1',
      type: 'crypto_out',
      counterparty: LIDO_STETH,
      legs: [{ asset: 'ETH', amount: '-1.0' }],
    });

    const result = defiClassification.apply([evt], makeContext());

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.type).toBe('transfer_self');
    expect(entry.reason).toMatch(/Stake to Lido/);
    expect(entry.rawEventIds).toEqual(['eth:stake-1']);
    expect(result.consumedEventIds.has('eth:stake-1')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// staking + native-asset crypto_in → transfer_self (unstake)
// ─────────────────────────────────────────────────────────────────────────

describe('staking crypto_in of native asset (unstake)', () => {
  it('classifies native-asset crypto_in from a staking contract as transfer_self', () => {
    const evt = makeEthEvent({
      id: 'eth:unstake-1',
      type: 'crypto_in',
      counterparty: LIDO_STETH,
      legs: [{ asset: 'ETH', amount: '1.0' }],
    });

    const result = defiClassification.apply([evt], makeContext());

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.type).toBe('transfer_self');
    expect(entry.reason).toMatch(/Unstake from Lido/);
    expect(entry.rawEventIds).toEqual(['eth:unstake-1']);
    expect(result.consumedEventIds.has('eth:unstake-1')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// staking + token crypto_in → income (reward token)
// ─────────────────────────────────────────────────────────────────────────

describe('staking crypto_in of reward token', () => {
  it('classifies ERC-20 token crypto_in from a staking contract as income', () => {
    const evt = makeEthEvent({
      id: 'eth:staking-token-reward-1',
      type: 'crypto_in',
      counterparty: LIDO_STETH,
      legs: [
        {
          asset: 'LDO',
          amount: '10.0',
          contractAddress: '0x5a98fcbea516cf06857215779fd812ca3bef1b32',
        },
      ],
    });

    const result = defiClassification.apply([evt], makeContext());

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.type).toBe('income');
    expect(entry.reason).toMatch(/Staking reward token from Lido/);
    expect(entry.rawEventIds).toEqual(['eth:staking-token-reward-1']);
    expect(result.consumedEventIds.has('eth:staking-token-reward-1')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Unknown counterparty — should NOT be consumed
// ─────────────────────────────────────────────────────────────────────────

describe('unknown counterparty', () => {
  it('does not consume events whose counterparty is not in the catalog', () => {
    const evt = makeEthEvent({
      id: 'eth:unknown-1',
      type: 'crypto_in',
      counterparty: UNKNOWN_ADDR,
      legs: [{ asset: 'ETH', amount: '0.5' }],
    });

    const result = defiClassification.apply([evt], makeContext());

    expect(result.entries).toHaveLength(0);
    expect(result.consumedEventIds.size).toBe(0);
  });

  it('does not consume events with no counterparty', () => {
    const evt = makeEthEvent({
      id: 'eth:no-counterparty-1',
      type: 'crypto_in',
      counterparty: undefined,
      legs: [{ asset: 'ETH', amount: '0.1' }],
    });

    const result = defiClassification.apply([evt], makeContext());

    expect(result.entries).toHaveLength(0);
    expect(result.consumedEventIds.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Non-EVM source — should NOT be consumed
// ─────────────────────────────────────────────────────────────────────────

describe('non-EVM source', () => {
  it('does not consume events from non-EVM sources (e.g. coinbase)', () => {
    // Use the same Lido address as counterparty — but on coinbase source,
    // CHAIN_ID_BY_SOURCE returns undefined so the catalog lookup is skipped.
    const evt = makeEthEvent({
      id: 'coinbase:non-evm-1',
      source: 'coinbase',
      type: 'crypto_in',
      counterparty: LIDO_STETH,
      legs: [{ asset: 'ETH', amount: '0.1' }],
    });

    const result = defiClassification.apply([evt], makeContext());

    expect(result.entries).toHaveLength(0);
    expect(result.consumedEventIds.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// lp-router / lending-pool kinds — should NOT be consumed (future rules)
// ─────────────────────────────────────────────────────────────────────────

describe('lp-router and lending-pool kinds', () => {
  it('does not consume lp-router events (falls through for future rules)', () => {
    const lpEntry: DeFiContractEntry = {
      chain: 1,
      address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      protocol: 'TestLP',
      version: 'V1',
      kind: 'lp-router',
    };
    const ctx = makeContext([['1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', lpEntry]]);

    const evt = makeEthEvent({
      id: 'eth:lp-1',
      type: 'crypto_in',
      counterparty: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      legs: [{ asset: 'UNI-V2', amount: '50.0' }],
    });

    const result = defiClassification.apply([evt], ctx);

    expect(result.entries).toHaveLength(0);
    expect(result.consumedEventIds.size).toBe(0);
  });

  it('does not consume lending-pool events (falls through for future rules)', () => {
    const lendingEntry: DeFiContractEntry = {
      chain: 1,
      address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      protocol: 'TestLending',
      version: 'V1',
      kind: 'lending-pool',
    };
    const ctx = makeContext([['1:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', lendingEntry]]);

    const evt = makeEthEvent({
      id: 'eth:lending-1',
      type: 'crypto_in',
      counterparty: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      legs: [{ asset: 'aETH', amount: '2.0', contractAddress: '0xcccc' }],
    });

    const result = defiClassification.apply([evt], ctx);

    expect(result.entries).toHaveLength(0);
    expect(result.consumedEventIds.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Non-crypto event types — should NOT be consumed
// ─────────────────────────────────────────────────────────────────────────

describe('non-crypto event types', () => {
  it('does not consume trade or nft_event types', () => {
    const trade = makeEthEvent({
      id: 'eth:trade-1',
      type: 'trade',
      counterparty: LIDO_STETH,
      legs: [
        { asset: 'ETH', amount: '-1.0' },
        { asset: 'stETH', amount: '1.0', contractAddress: LIDO_STETH },
      ],
    });
    const nft = makeEthEvent({
      id: 'eth:nft-1',
      type: 'nft_event',
      counterparty: LIDO_STETH,
      legs: [{ asset: 'NFT', amount: '1', contractAddress: '0x1234', tokenId: '1' }],
    });

    const result = defiClassification.apply([trade, nft], makeContext());

    expect(result.entries).toHaveLength(0);
    expect(result.consumedEventIds.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Leg preservation
// ─────────────────────────────────────────────────────────────────────────

describe('leg preservation', () => {
  it('preserves all legs from the source event on the produced entry', () => {
    const evt = makeEthEvent({
      id: 'eth:preserve-1',
      type: 'crypto_out',
      counterparty: LIDO_STETH,
      legs: [
        { asset: 'ETH', amount: '-2.0', amountUsdAtTime: '6000.00' },
        { asset: 'ETH', amount: '-0.002', feeFlag: true },
      ],
    });

    const result = defiClassification.apply([evt], makeContext());

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    // transfer_self because the first (non-fee) leg is a native leg
    expect(entry.type).toBe('transfer_self');
    expect(entry.legs).toHaveLength(2);
    expect(entry.legs[0]!.asset).toBe('ETH');
    expect(entry.legs[0]!.amountUsdAtTime).toBe('6000.00');
    expect(entry.legs[1]!.feeFlag).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Determinism: same input → same entryId
// ─────────────────────────────────────────────────────────────────────────

describe('determinism', () => {
  it('produces the same entry ID for the same input on repeated calls', () => {
    const evt = makeEthEvent({
      id: 'eth:determ-1',
      type: 'crypto_in',
      counterparty: LIDO_REWARDS,
      legs: [{ asset: 'ETH', amount: '0.05' }],
    });

    const r1 = defiClassification.apply([evt], makeContext());
    const r2 = defiClassification.apply([evt], makeContext());

    expect(r1.entries[0]!.id).toBe(r2.entries[0]!.id);
  });
});

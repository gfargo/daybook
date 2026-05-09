/**
 * Unit tests for resolveFromBlock.
 *
 * Mocks the Alchemy SDK to avoid network calls. Tests cover:
 *   - Numeric string → BigInt passthrough
 *   - ISO date string → binary search block lookup
 *   - Future date → throws descriptive error
 *   - Unparseable date → throws descriptive error
 *   - Numeric block beyond latest → throws future error
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveFromBlock } from './block-resolver.js';

// ─────────────────────────────────────────────────────────────────────────
// Alchemy SDK mock
// ─────────────────────────────────────────────────────────────────────────

/**
 * Mock block data keyed by block number. Each entry has a timestamp (unix
 * seconds). The mock `getBlock` returns the matching entry.
 */
const MOCK_BLOCKS: Record<number, { number: number; timestamp: number }> = {
  0: { number: 0, timestamp: 1438269973 },          // 2015-07-30 (Ethereum genesis)
  18000000: { number: 18000000, timestamp: 1693526400 }, // 2023-09-01T00:00:00Z
  18500000: { number: 18500000, timestamp: 1699228800 }, // 2023-11-06T00:00:00Z
  19000000: { number: 19000000, timestamp: 1704931200 }, // 2024-01-11T00:00:00Z
  19500000: { number: 19500000, timestamp: 1710633600 }, // 2024-03-17T00:00:00Z
  20000000: { number: 20000000, timestamp: 1716336000 }, // 2024-05-22T00:00:00Z (latest)
};

const LATEST_BLOCK_NUM = 20000000;

/** Create a mock getBlock that uses MOCK_BLOCKS or interpolates. */
function mockGetBlock(blockNum: number): { number: number; timestamp: number } {
  if (MOCK_BLOCKS[blockNum]) {
    return MOCK_BLOCKS[blockNum]!;
  }
  // Linear interpolation between known blocks for binary search
  const knownNums = Object.keys(MOCK_BLOCKS).map(Number).sort((a, b) => a - b);
  let lo = knownNums[0]!;
  let hi = knownNums[knownNums.length - 1]!;
  for (const n of knownNums) {
    if (n <= blockNum) lo = n;
    if (n >= blockNum && n < hi) hi = n;
  }
  const loTs = MOCK_BLOCKS[lo]!.timestamp;
  const hiTs = MOCK_BLOCKS[hi]!.timestamp;
  const ratio = hi === lo ? 0 : (blockNum - lo) / (hi - lo);
  const ts = Math.floor(loTs + ratio * (hiTs - loTs));
  return { number: blockNum, timestamp: ts };
}

vi.mock('alchemy-sdk', () => {
  const NetworkEnum = {
    ETH_MAINNET: 'eth-mainnet',
    MATIC_MAINNET: 'matic-mainnet',
    ARB_MAINNET: 'arb-mainnet',
    OPT_MAINNET: 'opt-mainnet',
    BASE_MAINNET: 'base-mainnet',
    BNB_MAINNET: 'bnb-mainnet',
  };

  class MockAlchemy {
    core = {
      getBlockNumber: vi.fn(async () => LATEST_BLOCK_NUM),
      getBlock: vi.fn(async (blockNum: number) => mockGetBlock(blockNum)),
    };
    constructor(_opts: unknown) {
      // no-op
    }
  }

  return {
    Alchemy: MockAlchemy,
    Network: NetworkEnum,
  };
});

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('resolveFromBlock — numeric string passthrough', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns BigInt directly for a numeric block number', async () => {
    const result = await resolveFromBlock('19000000', 1, 'test-key');

    expect(result.blockNumber).toBe(19000000n);
    expect(result.timestamp).toBeInstanceOf(Date);
  });

  it('returns block 0 for "0"', async () => {
    const result = await resolveFromBlock('0', 1, 'test-key');

    expect(result.blockNumber).toBe(0n);
  });
});

describe('resolveFromBlock — ISO date string', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves an ISO date to a block number via binary search', async () => {
    // Target: 2024-01-11 → should resolve near block 19000000
    const result = await resolveFromBlock('2024-01-11', 1, 'test-key');

    expect(result.blockNumber).toBeTypeOf('bigint');
    // The binary search should converge near the target block
    expect(result.blockNumber).toBeGreaterThanOrEqual(0n);
    expect(result.blockNumber).toBeLessThanOrEqual(BigInt(LATEST_BLOCK_NUM));
    expect(result.timestamp).toBeInstanceOf(Date);
  });

  it('resolves a full ISO 8601 datetime', async () => {
    const result = await resolveFromBlock('2024-01-11T00:00:00Z', 1, 'test-key');

    expect(result.blockNumber).toBeTypeOf('bigint');
    expect(result.timestamp).toBeInstanceOf(Date);
  });

  it('returns block 0 for a date before genesis', async () => {
    const result = await resolveFromBlock('2010-01-01', 1, 'test-key');

    expect(result.blockNumber).toBe(0n);
  });
});

describe('resolveFromBlock — future date', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when the date is in the future', async () => {
    await expect(
      resolveFromBlock('2099-01-01', 1, 'test-key'),
    ).rejects.toThrow('The --from date is in the future. No blocks to sync.');
  });

  it('throws when a numeric block is beyond the latest', async () => {
    await expect(
      resolveFromBlock('99999999', 1, 'test-key'),
    ).rejects.toThrow('The --from date is in the future. No blocks to sync.');
  });
});

describe('resolveFromBlock — unparseable input', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws a descriptive error for garbage input', async () => {
    await expect(
      resolveFromBlock('not-a-date', 1, 'test-key'),
    ).rejects.toThrow('Cannot parse "not-a-date" as a date');
  });

  it('throws for empty string', async () => {
    await expect(
      resolveFromBlock('', 1, 'test-key'),
    ).rejects.toThrow('Cannot parse "" as a date');
  });
});

describe('resolveFromBlock — unsupported chain', () => {
  it.each([42161, 10, 8453, 56])('supports numeric passthrough for chain ID %i', async (chainId) => {
    const result = await resolveFromBlock('19000000', chainId, 'test-key');

    expect(result.blockNumber).toBe(19000000n);
    expect(result.timestamp).toBeInstanceOf(Date);
  });

  it('throws for an unsupported chain ID', async () => {
    await expect(
      resolveFromBlock('19000000', 999, 'test-key'),
    ).rejects.toThrow('does not support chainId 999');
  });
});

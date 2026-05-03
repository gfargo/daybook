/**
 * Block resolution utility for `--from <date|block>`.
 *
 * Resolves a user-provided date string or block number into a concrete block
 * number that can be passed to `FetchTransfersOpts.fromBlock`.
 *
 * Two modes:
 *   1. Numeric string (e.g. "19000000") → returned as BigInt directly.
 *   2. ISO 8601 date (e.g. "2024-01-01") → binary search for the nearest
 *      block at or after that timestamp using Alchemy's `getBlock`.
 */

import { Alchemy, Network } from 'alchemy-sdk';
import type { ChainId } from './provider.js';

// ─────────────────────────────────────────────────────────────────────────
// Chain → Alchemy Network mapping (mirrors alchemy.ts)
// ─────────────────────────────────────────────────────────────────────────

const NETWORK_BY_CHAIN_ID: Record<number, Network> = {
  1: Network.ETH_MAINNET,
  137: Network.MATIC_MAINNET,
  42161: Network.ARB_MAINNET,
  10: Network.OPT_MAINNET,
  8453: Network.BASE_MAINNET,
};

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/** Result of block resolution, including the resolved block and its timestamp. */
export interface ResolvedBlock {
  /** The resolved block number. */
  blockNumber: bigint;
  /** The timestamp of the resolved block (for display). */
  timestamp: Date;
}

/**
 * Resolve a user-provided `--from` value to a block number.
 *
 * @param from - Either a numeric block number string or an ISO 8601 date.
 * @param chainId - The EVM chain to resolve against.
 * @param apiKey - Alchemy API key for block lookups.
 * @returns The resolved block number and its timestamp.
 * @throws If the date is unparseable, the network call fails, or the
 *         resolved block is in the future.
 */
export async function resolveFromBlock(
  from: string,
  chainId: ChainId,
  apiKey: string,
): Promise<ResolvedBlock> {
  const client = createClient(chainId, apiKey);

  // ─── Numeric passthrough ─────────────────────────────────────────
  if (/^\d+$/.test(from)) {
    const blockNumber = BigInt(from);
    await validateNotFuture(client, blockNumber);
    const block = await client.core.getBlock(Number(blockNumber));
    return {
      blockNumber,
      timestamp: new Date(block.timestamp * 1000),
    };
  }

  // ─── ISO 8601 date → binary search ──────────────────────────────
  const parsed = new Date(from);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `Cannot parse "${from}" as a date. Use ISO 8601 format (e.g. 2024-01-01 or 2024-01-01T00:00:00Z) or a block number.`,
    );
  }

  const targetTs = Math.floor(parsed.getTime() / 1000);
  const blockNumber = await findBlockByTimestamp(client, targetTs);
  const block = await client.core.getBlock(Number(blockNumber));

  return {
    blockNumber,
    timestamp: new Date(block.timestamp * 1000),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────

/** Create an Alchemy client for the given chain. */
function createClient(chainId: ChainId, apiKey: string): Alchemy {
  const network = NETWORK_BY_CHAIN_ID[chainId];
  if (!network) {
    throw new Error(
      `Block resolution does not support chainId ${chainId}. ` +
      `Supported: ${Object.keys(NETWORK_BY_CHAIN_ID).join(', ')}`,
    );
  }
  return new Alchemy({ apiKey, network });
}

/**
 * Validate that a block number is not greater than the latest block.
 * Throws a descriptive error if it is.
 */
async function validateNotFuture(client: Alchemy, blockNumber: bigint): Promise<void> {
  const latest = await client.core.getBlockNumber();
  if (blockNumber > BigInt(latest)) {
    throw new Error(
      'The --from date is in the future. No blocks to sync.',
    );
  }
}

/**
 * Binary search for the first block whose timestamp is >= the target.
 *
 * Uses Alchemy's `getBlock` to fetch block timestamps. Converges in
 * ~20 iterations for any chain (log2 of max block height).
 */
async function findBlockByTimestamp(
  client: Alchemy,
  targetTs: number,
): Promise<bigint> {
  const latestBlockNum = await client.core.getBlockNumber();
  const latestBlock = await client.core.getBlock(latestBlockNum);

  // If the target is in the future, bail.
  if (targetTs > latestBlock.timestamp) {
    throw new Error(
      'The --from date is in the future. No blocks to sync.',
    );
  }

  // If the target is at or before genesis, return block 0.
  const genesisBlock = await client.core.getBlock(0);
  if (targetTs <= genesisBlock.timestamp) {
    return 0n;
  }

  // Binary search: find the first block with timestamp >= targetTs.
  let lo = 0;
  let hi = latestBlockNum;

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const block = await client.core.getBlock(mid);

    if (block.timestamp < targetTs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  return BigInt(lo);
}

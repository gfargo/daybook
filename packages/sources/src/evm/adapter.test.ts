/**
 * Unit tests for the EVM adapter (ingestEvm).
 *
 * Uses a mock EvmTransferProvider with hand-written RawTransfer fixtures.
 * No network calls, no Alchemy SDK — pure translation logic.
 */

import { describe, expect, it } from 'vitest';
import { ingestEvm } from './adapter.js';
import type { EvmTransferProvider, RawTransfer } from './provider.js';

// ─────────────────────────────────────────────────────────────────────────
// Mock provider
// ─────────────────────────────────────────────────────────────────────────

const USER_ADDRESS = '0x1296Df1Ad1AabFBcBf28Dd45BeF9Bd0A4206F85b';
const COUNTERPARTY = '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43';

/** Build a RawTransfer fixture with sensible defaults. */
function transfer(partial: Partial<RawTransfer>): RawTransfer {
  return {
    providerId: 'test-id-1',
    chainId: 1,
    blockNum: 18000000n,
    txHash: '0xabc123',
    logIndex: null,
    timestamp: new Date('2023-09-22T03:07:23Z'),
    category: 'native',
    from: COUNTERPARTY,
    to: USER_ADDRESS,
    amount: '1.5',
    asset: 'ETH',
    raw: { fixture: true },
    ...partial,
  };
}

/** Create a mock provider that yields the given transfers. */
function mockProvider(transfers: RawTransfer[]): EvmTransferProvider {
  return {
    name: 'alchemy',
    async *fetchTransfers() {
      for (const t of transfers) {
        yield t;
      }
    },
    async getTokenMetadata() {
      return null;
    },
  };
}

const baseOpts = {
  address: USER_ADDRESS,
  chainId: 1,
  accountId: 'eth-main',
  source: 'eth' as const,
};

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('ingestEvm — direction assignment', () => {
  it('incoming transfer → crypto_in with positive amount', async () => {
    const provider = mockProvider([
      transfer({
        from: COUNTERPARTY,
        to: USER_ADDRESS,
        amount: '0.22348553',
        asset: 'ETH',
      }),
    ]);

    const { events, stats } = await ingestEvm({ ...baseOpts, provider });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('crypto_in');
    expect(events[0]!.legs[0]!.amount).toBe('0.22348553');
    expect(events[0]!.legs[0]!.asset).toBe('ETH');
    expect(events[0]!.counterparty).toBe(COUNTERPARTY);
    expect(stats.native).toBe(1);
  });

  it('outgoing transfer → crypto_out with negative amount', async () => {
    const provider = mockProvider([
      transfer({
        from: USER_ADDRESS,
        to: COUNTERPARTY,
        amount: '0.5',
        asset: 'ETH',
      }),
    ]);

    const { events, stats } = await ingestEvm({ ...baseOpts, provider });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('crypto_out');
    expect(events[0]!.legs[0]!.amount).toBe('-0.5');
    expect(events[0]!.counterparty).toBe(COUNTERPARTY);
    expect(stats.native).toBe(1);
  });

  it('handles case-insensitive address comparison', async () => {
    const provider = mockProvider([
      transfer({
        from: COUNTERPARTY,
        to: USER_ADDRESS.toLowerCase(),
        amount: '1.0',
      }),
    ]);

    const { events } = await ingestEvm({ ...baseOpts, provider });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('crypto_in');
  });
});

describe('ingestEvm — NFT handling', () => {
  it('ERC-721 → nft_event with amount ±1 and tokenId', async () => {
    const provider = mockProvider([
      transfer({
        providerId: 'nft-in-1',
        category: 'erc721',
        from: COUNTERPARTY,
        to: USER_ADDRESS,
        amount: undefined,
        asset: 'CryptoKitties',
        contractAddress: '0x06012c8cf97bead5deae237070f9587f8e7a266d',
        tokenId: '1234567',
      }),
    ]);

    const { events, stats } = await ingestEvm({ ...baseOpts, provider });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('nft_event');
    expect(events[0]!.legs[0]!.amount).toBe('1');
    expect(events[0]!.legs[0]!.asset).toBe('CryptoKitties');
    expect(events[0]!.legs[0]!.tokenId).toBe('1234567');
    expect(events[0]!.legs[0]!.contractAddress).toBe(
      '0x06012c8cf97bead5deae237070f9587f8e7a266d',
    );
    expect(stats.erc721).toBe(1);
  });

  it('outgoing ERC-721 → nft_event with amount -1', async () => {
    const provider = mockProvider([
      transfer({
        providerId: 'nft-out-1',
        category: 'erc721',
        from: USER_ADDRESS,
        to: COUNTERPARTY,
        amount: undefined,
        asset: 'Bored Ape',
        tokenId: '42',
      }),
    ]);

    const { events } = await ingestEvm({ ...baseOpts, provider });

    expect(events[0]!.type).toBe('nft_event');
    expect(events[0]!.legs[0]!.amount).toBe('-1');
  });

  it('ERC-1155 → nft_event', async () => {
    const provider = mockProvider([
      transfer({
        providerId: 'erc1155-1',
        category: 'erc1155',
        from: COUNTERPARTY,
        to: USER_ADDRESS,
        amount: undefined,
        asset: null,
        contractAddress: '0xdeadbeef',
        tokenId: '99',
      }),
    ]);

    const { events, stats } = await ingestEvm({ ...baseOpts, provider });

    expect(events[0]!.type).toBe('nft_event');
    expect(events[0]!.legs[0]!.asset).toBe('0xdeadbeef');
    expect(stats.erc1155).toBe(1);
  });

  it('NFT with no asset or contractAddress falls back to "NFT"', async () => {
    const provider = mockProvider([
      transfer({
        providerId: 'nft-unknown',
        category: 'erc721',
        from: COUNTERPARTY,
        to: USER_ADDRESS,
        amount: undefined,
        asset: null,
        contractAddress: undefined,
        tokenId: '1',
      }),
    ]);

    const { events } = await ingestEvm({ ...baseOpts, provider });

    expect(events[0]!.legs[0]!.asset).toBe('NFT');
  });
});

describe('ingestEvm — unknown/amountless transfers', () => {
  it('transfer with no amount → unknown event with amount 0', async () => {
    const provider = mockProvider([
      transfer({
        providerId: 'no-amount-1',
        category: 'erc20',
        from: COUNTERPARTY,
        to: USER_ADDRESS,
        amount: undefined,
        asset: 'USDC',
      }),
    ]);

    const { events } = await ingestEvm({ ...baseOpts, provider });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('unknown');
    expect(events[0]!.legs[0]!.amount).toBe('0');
    expect(events[0]!.legs[0]!.asset).toBe('USDC');
  });

  it('amountless transfer with no asset falls back to contract address', async () => {
    const provider = mockProvider([
      transfer({
        providerId: 'no-amount-no-asset',
        category: 'erc20',
        from: COUNTERPARTY,
        to: USER_ADDRESS,
        amount: undefined,
        asset: null,
        contractAddress: '0xdeadbeef',
      }),
    ]);

    const { events } = await ingestEvm({ ...baseOpts, provider });

    expect(events[0]!.legs[0]!.asset).toBe('0xdeadbeef');
  });

  it('amountless transfer with no asset or contract falls back to UNKNOWN', async () => {
    const provider = mockProvider([
      transfer({
        providerId: 'no-amount-no-asset-no-contract',
        category: 'erc20',
        from: COUNTERPARTY,
        to: USER_ADDRESS,
        amount: undefined,
        asset: null,
        contractAddress: undefined,
      }),
    ]);

    const { events } = await ingestEvm({ ...baseOpts, provider });

    expect(events[0]!.legs[0]!.asset).toBe('UNKNOWN');
  });
});

describe('ingestEvm — deduplication', () => {
  it('deduplicates transfers with the same providerId', async () => {
    const t = transfer({ providerId: 'dup-1' });
    const provider = mockProvider([t, t]);

    const { events, stats } = await ingestEvm({ ...baseOpts, provider });

    expect(events).toHaveLength(1);
    expect(stats.deduped).toBe(1);
  });

  it('does not deduplicate transfers with different providerIds', async () => {
    const provider = mockProvider([
      transfer({ providerId: 'unique-1' }),
      transfer({ providerId: 'unique-2' }),
    ]);

    const { events, stats } = await ingestEvm({ ...baseOpts, provider });

    expect(events).toHaveLength(2);
    expect(stats.deduped).toBe(0);
  });
});

describe('ingestEvm — deterministic IDs', () => {
  it('generates ID as ${source}:${providerId}', async () => {
    const provider = mockProvider([
      transfer({ providerId: 'abc-123' }),
    ]);

    const { events } = await ingestEvm({ ...baseOpts, provider });

    expect(events[0]!.id).toBe('eth:abc-123');
  });

  it('uses the source from options', async () => {
    const provider = mockProvider([
      transfer({ providerId: 'xyz-456' }),
    ]);

    const { events } = await ingestEvm({
      ...baseOpts,
      source: 'polygon',
      provider,
    });

    expect(events[0]!.id).toBe('polygon:xyz-456');
  });

  it('same input produces same output (deterministic)', async () => {
    const transfers = [
      transfer({ providerId: 'det-1', amount: '1.5' }),
      transfer({ providerId: 'det-2', amount: '2.5', from: USER_ADDRESS, to: COUNTERPARTY }),
    ];

    const result1 = await ingestEvm({ ...baseOpts, provider: mockProvider(transfers) });
    const result2 = await ingestEvm({ ...baseOpts, provider: mockProvider(transfers) });

    expect(result1.events.map(e => e.id)).toEqual(result2.events.map(e => e.id));
    expect(result1.events.map(e => e.type)).toEqual(result2.events.map(e => e.type));
    expect(result1.events.map(e => e.legs[0]!.amount)).toEqual(
      result2.events.map(e => e.legs[0]!.amount),
    );
  });
});

describe('ingestEvm — ERC-20 transfers', () => {
  it('incoming ERC-20 → crypto_in with contractAddress', async () => {
    const provider = mockProvider([
      transfer({
        providerId: 'erc20-in-1',
        category: 'erc20',
        from: COUNTERPARTY,
        to: USER_ADDRESS,
        amount: '1000.50',
        asset: 'USDC',
        contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      }),
    ]);

    const { events, stats } = await ingestEvm({ ...baseOpts, provider });

    expect(events[0]!.type).toBe('crypto_in');
    expect(events[0]!.legs[0]!.asset).toBe('USDC');
    expect(events[0]!.legs[0]!.amount).toBe('1000.50');
    expect(events[0]!.legs[0]!.contractAddress).toBe(
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    );
    expect(stats.erc20).toBe(1);
  });

  it('ERC-20 with null asset falls back to contractAddress', async () => {
    const provider = mockProvider([
      transfer({
        providerId: 'erc20-null-asset',
        category: 'erc20',
        from: COUNTERPARTY,
        to: USER_ADDRESS,
        amount: '500',
        asset: null,
        contractAddress: '0xdeadbeef1234',
      }),
    ]);

    const { events } = await ingestEvm({ ...baseOpts, provider });

    expect(events[0]!.legs[0]!.asset).toBe('0xdeadbeef1234');
  });
});

describe('ingestEvm — internal transfers', () => {
  it('internal transfer counts in stats', async () => {
    const provider = mockProvider([
      transfer({
        providerId: 'internal-1',
        category: 'internal',
        from: COUNTERPARTY,
        to: USER_ADDRESS,
        amount: '0.1',
        asset: 'ETH',
      }),
    ]);

    const { events, stats } = await ingestEvm({ ...baseOpts, provider });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('crypto_in');
    expect(stats.internal).toBe(1);
  });
});

describe('ingestEvm — txHash propagation', () => {
  it('preserves txHash on all events', async () => {
    const provider = mockProvider([
      transfer({ txHash: '0xdeadbeef' }),
    ]);

    const { events } = await ingestEvm({ ...baseOpts, provider });

    expect(events[0]!.txHash).toBe('0xdeadbeef');
  });
});

describe('ingestEvm — mixed batch', () => {
  it('handles a realistic mix of transfer types', async () => {
    const provider = mockProvider([
      transfer({ providerId: 'native-in', category: 'native', from: COUNTERPARTY, to: USER_ADDRESS, amount: '1.0', asset: 'ETH' }),
      transfer({ providerId: 'native-out', category: 'native', from: USER_ADDRESS, to: COUNTERPARTY, amount: '0.5', asset: 'ETH' }),
      transfer({ providerId: 'erc20-in', category: 'erc20', from: COUNTERPARTY, to: USER_ADDRESS, amount: '100', asset: 'USDC', contractAddress: '0xusdc' }),
      transfer({ providerId: 'nft-in', category: 'erc721', from: COUNTERPARTY, to: USER_ADDRESS, asset: 'Ape', tokenId: '1' }),
      transfer({ providerId: 'internal-in', category: 'internal', from: COUNTERPARTY, to: USER_ADDRESS, amount: '0.01', asset: 'ETH' }),
      // Duplicate of native-in
      transfer({ providerId: 'native-in', category: 'native', from: COUNTERPARTY, to: USER_ADDRESS, amount: '1.0', asset: 'ETH' }),
    ]);

    const { events, stats } = await ingestEvm({ ...baseOpts, provider });

    expect(events).toHaveLength(5);
    expect(stats).toEqual({
      native: 2,
      internal: 1,
      erc20: 1,
      erc721: 1,
      erc1155: 0,
      deduped: 1,
    });

    // Verify types
    expect(events[0]!.type).toBe('crypto_in');
    expect(events[1]!.type).toBe('crypto_out');
    expect(events[2]!.type).toBe('crypto_in');
    expect(events[3]!.type).toBe('nft_event');
    expect(events[4]!.type).toBe('crypto_in');
  });
});

describe('ingestEvm — self-transfer (from === to === user)', () => {
  it('handles self-transfer without error', async () => {
    const provider = mockProvider([
      transfer({
        providerId: 'self-1',
        from: USER_ADDRESS,
        to: USER_ADDRESS,
        amount: '0.1',
        asset: 'ETH',
      }),
    ]);

    const { events } = await ingestEvm({ ...baseOpts, provider });

    // When to === user, it's treated as crypto_in (positive).
    // The classifier will later recognize this as a self-transfer.
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('crypto_in');
    expect(events[0]!.legs[0]!.amount).toBe('0.1');
  });
});

describe('ingestEvm — transfer not involving user', () => {
  it('skips transfers where neither from nor to is the user', async () => {
    const provider = mockProvider([
      transfer({
        providerId: 'unrelated-1',
        from: '0xaaaa',
        to: '0xbbbb',
        amount: '1.0',
      }),
    ]);

    const { events } = await ingestEvm({ ...baseOpts, provider });

    expect(events).toHaveLength(0);
  });
});

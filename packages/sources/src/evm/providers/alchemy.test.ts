import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAssetTransfers: vi.fn(),
  getTokenMetadata: vi.fn(),
  alchemyConstructor: vi.fn(),
}));

vi.mock('alchemy-sdk', () => ({
  Alchemy: vi.fn((config: unknown) => {
    mocks.alchemyConstructor(config);
    return {
      core: {
        getAssetTransfers: mocks.getAssetTransfers,
        getTokenMetadata: mocks.getTokenMetadata,
      },
    };
  }),
  AssetTransfersCategory: {
    EXTERNAL: 'external',
    INTERNAL: 'internal',
    ERC20: 'erc20',
    ERC721: 'erc721',
    ERC1155: 'erc1155',
  },
  Network: {
    ETH_MAINNET: 'eth-mainnet',
    MATIC_MAINNET: 'polygon-mainnet',
    ARB_MAINNET: 'arbitrum-mainnet',
    OPT_MAINNET: 'optimism-mainnet',
    BASE_MAINNET: 'base-mainnet',
    BNB_MAINNET: 'bnb-mainnet',
  },
}));

describe('AlchemyTransferProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('paginates both directions and parses raw hex amounts without precision loss', async () => {
    const { AlchemyTransferProvider } = await import('./alchemy.js');

    mocks.getAssetTransfers
      .mockResolvedValueOnce({
        transfers: [
          {
            uniqueId: 'out-1',
            blockNum: '0x10',
            metadata: { blockTimestamp: '2024-01-01T00:00:00Z' },
            rawContract: {
              value: '0xde0b6b3a7640000',
              decimal: '0x12',
              address: '0xToken',
            },
            category: 'erc20',
            hash: '0xhash1',
            from: '0xUser',
            to: '0xOther',
            value: 1,
            asset: 'TOK',
            tokenId: null,
          },
        ],
        pageKey: 'next-page',
      })
      .mockResolvedValueOnce({
        transfers: [
          {
            uniqueId: 'out-2',
            blockNum: '0x11',
            metadata: { blockTimestamp: '2024-01-02T00:00:00Z' },
            rawContract: {
              value: '0x1bc16d674ec80000',
              decimal: '0x12',
              address: '0xToken',
            },
            category: 'erc20',
            hash: '0xhash2',
            from: '0xUser',
            to: '0xOther',
            value: 2,
            asset: 'TOK',
            tokenId: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        transfers: [],
      });

    const provider = new AlchemyTransferProvider('test-key');
    const transfers = [];
    for await (const transfer of provider.fetchTransfers({
      address: '0xUser',
      chainId: 1,
      fromBlock: 10n,
      toBlock: 20n,
    })) {
      transfers.push(transfer);
    }

    expect(mocks.alchemyConstructor).toHaveBeenCalledWith({
      apiKey: 'test-key',
      network: 'eth-mainnet',
    });
    expect(mocks.getAssetTransfers).toHaveBeenCalledTimes(3);
    expect(mocks.getAssetTransfers.mock.calls[0]![0]).toMatchObject({
      fromAddress: '0xUser',
      fromBlock: '0xa',
      toBlock: '0x14',
      maxCount: 1000,
    });
    expect(mocks.getAssetTransfers.mock.calls[1]![0]).toMatchObject({
      fromAddress: '0xUser',
      pageKey: 'next-page',
    });
    expect(mocks.getAssetTransfers.mock.calls[2]![0]).toMatchObject({
      toAddress: '0xUser',
    });

    expect(transfers).toHaveLength(2);
    expect(transfers[0]).toMatchObject({
      providerId: 'out-1',
      amount: '1',
      chainId: 1,
      blockNum: 16n,
      category: 'erc20',
      contractAddress: '0xToken',
      decimals: 18,
    });
    expect(transfers[1]!.amount).toBe('2');
  });

  it('caches token metadata lookups including misses', async () => {
    const { AlchemyTransferProvider } = await import('./alchemy.js');
    mocks.getTokenMetadata.mockResolvedValueOnce({
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
    });

    const provider = new AlchemyTransferProvider('test-key');
    const first = await provider.getTokenMetadata({
      contractAddress: '0xToken',
      chainId: 1,
    });
    const second = await provider.getTokenMetadata({
      contractAddress: '0xTOKEN',
      chainId: 1,
    });

    expect(first).toEqual({
      contractAddress: '0xToken',
      chainId: 1,
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
    });
    expect(second).toEqual(first);
    expect(mocks.getTokenMetadata).toHaveBeenCalledTimes(1);

    mocks.getTokenMetadata.mockRejectedValueOnce(new Error('missing'));
    const missOne = await provider.getTokenMetadata({
      contractAddress: '0xMissing',
      chainId: 1,
    });
    const missTwo = await provider.getTokenMetadata({
      contractAddress: '0xMISSING',
      chainId: 1,
    });

    expect(missOne).toBeNull();
    expect(missTwo).toBeNull();
    expect(mocks.getTokenMetadata).toHaveBeenCalledTimes(2);
  });

  it.each([
    [42161, 'arbitrum-mainnet'],
    [10, 'optimism-mainnet'],
    [8453, 'base-mainnet'],
    [56, 'bnb-mainnet'],
  ] as const)('supports chainId %i through Alchemy network %s', async (chainId, network) => {
    const { AlchemyTransferProvider } = await import('./alchemy.js');
    mocks.getAssetTransfers.mockResolvedValue({ transfers: [] });

    const provider = new AlchemyTransferProvider('test-key');
    for await (const _transfer of provider.fetchTransfers({
      address: '0xUser',
      chainId,
    })) {
      // Empty mock response; this loop only forces client creation.
    }

    expect(mocks.alchemyConstructor).toHaveBeenCalledWith({
      apiKey: 'test-key',
      network,
    });
  });
});

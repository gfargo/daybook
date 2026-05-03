/**
 * Unit tests for EtherscanTransferProvider.
 *
 * Mocks the global `fetch` to simulate Etherscan API responses.
 * No network calls — pure provider logic.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EtherscanTransferProvider } from './etherscan.js';
import type { RawTransfer } from '../provider.js';

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

/** Build a minimal Etherscan txlist row. */
function txRow(partial: Record<string, string> = {}): Record<string, string> {
  return {
    hash: '0xabc123',
    blockNumber: '18000000',
    timeStamp: '1695351600', // 2023-09-22T03:00:00Z
    from: '0x1234567890abcdef1234567890abcdef12345678',
    to: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    gasUsed: '21000',
    gasPrice: '20000000000', // 20 gwei
    isError: '1',
    ...partial,
  };
}

/** Wrap rows in an Etherscan API response envelope. */
function apiResponse(rows: Record<string, string>[]): {
  status: string;
  message: string;
  result: Record<string, string>[];
} {
  return {
    status: '1',
    message: 'OK',
    result: rows,
  };
}

/** Create a mock fetch that returns the given responses in sequence. */
function mockFetch(responses: Array<{ status?: number; body: unknown }>): void {
  let callIndex = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const resp = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return {
        ok: (resp!.status ?? 200) >= 200 && (resp!.status ?? 200) < 300,
        status: resp!.status ?? 200,
        statusText: resp!.status === 429 ? 'Too Many Requests' : 'OK',
        json: async () => resp!.body,
      };
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** Collect all RawTransfers from the async iterable. */
async function collect(provider: EtherscanTransferProvider, address: string): Promise<RawTransfer[]> {
  const transfers: RawTransfer[] = [];
  for await (const t of provider.fetchTransfers({ address, chainId: 1 })) {
    transfers.push(t);
  }
  return transfers;
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('EtherscanTransferProvider — constructor', () => {
  it('throws when API key is empty', () => {
    expect(() => new EtherscanTransferProvider('', 1)).toThrow(
      'ETHERSCAN_API_KEY is required',
    );
    expect(() => new EtherscanTransferProvider('', 1)).toThrow(
      'https://etherscan.io/apis',
    );
  });
});

describe('EtherscanTransferProvider — failed tx gas', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a RawTransfer for a failed transaction with correct gas cost', async () => {
    const failedTx = txRow({
      hash: '0xfailed1',
      gasUsed: '21000',
      gasPrice: '20000000000', // 20 gwei
      isError: '1',
    });

    mockFetch([{ body: apiResponse([failedTx]) }]);

    const provider = new EtherscanTransferProvider('test-key', 1);
    const transfers = await collect(provider, '0xuser');

    expect(transfers).toHaveLength(1);
    expect(transfers[0]!.providerId).toBe('etherscan-failed:0xfailed1');
    expect(transfers[0]!.category).toBe('native');
    expect(transfers[0]!.asset).toBe('ETH');

    // 21000 * 20000000000 / 1e18 = 0.00042 ETH
    expect(transfers[0]!.amount).toBe('0.00042');
  });

  it('computes gas cost with decimal precision (no floating-point drift)', async () => {
    // Use values that would cause floating-point issues
    const failedTx = txRow({
      hash: '0xprecision',
      gasUsed: '234567',
      gasPrice: '12345678901', // ~12.3 gwei
      isError: '1',
    });

    mockFetch([{ body: apiResponse([failedTx]) }]);

    const provider = new EtherscanTransferProvider('test-key', 1);
    const transfers = await collect(provider, '0xuser');

    expect(transfers).toHaveLength(1);
    // 234567 * 12345678901 / 1e18 = 0.002895888862770867
    // Verify it's a valid decimal string (not NaN, not Infinity)
    const amount = transfers[0]!.amount!;
    expect(Number.isFinite(Number(amount))).toBe(true);
    expect(amount).toBe('0.002895888862770867');
  });

  it('sets correct blockNum, timestamp, and addresses', async () => {
    const failedTx = txRow({
      hash: '0xmeta',
      blockNumber: '19500000',
      timeStamp: '1710000000', // 2024-03-09T16:00:00Z
      from: '0xAABB',
      to: '0xCCDD',
    });

    mockFetch([{ body: apiResponse([failedTx]) }]);

    const provider = new EtherscanTransferProvider('test-key', 1);
    const transfers = await collect(provider, '0xuser');

    expect(transfers[0]!.blockNum).toBe(19500000n);
    expect(transfers[0]!.timestamp).toEqual(new Date(1710000000 * 1000));
    expect(transfers[0]!.from).toBe('0xaabb');
    expect(transfers[0]!.to).toBe('0xccdd');
    expect(transfers[0]!.chainId).toBe(1);
  });
});

describe('EtherscanTransferProvider — successful tx skipping', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips successful transactions (isError !== "1")', async () => {
    const successTx = txRow({ hash: '0xsuccess', isError: '0' });
    const failedTx = txRow({ hash: '0xfailed', isError: '1' });

    mockFetch([{ body: apiResponse([successTx, failedTx]) }]);

    const provider = new EtherscanTransferProvider('test-key', 1);
    const transfers = await collect(provider, '0xuser');

    expect(transfers).toHaveLength(1);
    expect(transfers[0]!.providerId).toBe('etherscan-failed:0xfailed');
  });

  it('returns empty when all transactions are successful', async () => {
    const rows = [
      txRow({ hash: '0xs1', isError: '0' }),
      txRow({ hash: '0xs2', isError: '0' }),
    ];

    mockFetch([{ body: apiResponse(rows) }]);

    const provider = new EtherscanTransferProvider('test-key', 1);
    const transfers = await collect(provider, '0xuser');

    expect(transfers).toHaveLength(0);
  });
});

describe('EtherscanTransferProvider — pagination', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stops paginating when response length < offset (10000)', async () => {
    // First page: fewer than 10000 results → stop
    const rows = [txRow({ hash: '0xp1', isError: '1' })];

    mockFetch([{ body: apiResponse(rows) }]);

    const provider = new EtherscanTransferProvider('test-key', 1);
    const transfers = await collect(provider, '0xuser');

    expect(transfers).toHaveLength(1);
    // fetch should have been called exactly once
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('paginates when response length equals offset', async () => {
    // First page: exactly 10000 results → fetch page 2
    const fullPage = Array.from({ length: 10_000 }, (_, i) =>
      txRow({ hash: `0xfull-${i}`, isError: i === 0 ? '1' : '0' }),
    );
    const lastPage = [txRow({ hash: '0xlast', isError: '1' })];

    mockFetch([
      { body: apiResponse(fullPage) },
      { body: apiResponse(lastPage) },
    ]);

    const provider = new EtherscanTransferProvider('test-key', 1);
    const transfers = await collect(provider, '0xuser');

    // 1 failed from first page + 1 failed from second page
    expect(transfers).toHaveLength(2);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it('handles "No transactions found" string result gracefully', async () => {
    mockFetch([{
      body: {
        status: '0',
        message: 'No transactions found',
        result: 'No transactions found',
      },
    }]);

    const provider = new EtherscanTransferProvider('test-key', 1);
    const transfers = await collect(provider, '0xuser');

    expect(transfers).toHaveLength(0);
  });
});

describe('EtherscanTransferProvider — rate limiting', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries on HTTP 429 with exponential backoff', async () => {
    const rows = [txRow({ hash: '0xretry', isError: '1' })];

    mockFetch([
      { status: 429, body: {} },
      { body: apiResponse(rows) },
    ]);

    const provider = new EtherscanTransferProvider('test-key', 1);
    // Use instant sleep for testing
    (provider as unknown as { _sleep: (ms: number) => Promise<void> })._sleep = async () => {};

    const transfers = await collect(provider, '0xuser');
    expect(transfers).toHaveLength(1);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it('throws after 3 consecutive HTTP 429 responses', async () => {
    mockFetch([
      { status: 429, body: {} },
      { status: 429, body: {} },
      { status: 429, body: {} },
    ]);

    const provider = new EtherscanTransferProvider('test-key', 1);
    (provider as unknown as { _sleep: (ms: number) => Promise<void> })._sleep = async () => {};

    await expect(collect(provider, '0xuser')).rejects.toThrow(
      'rate limit exceeded after 3 retries',
    );
  });

  it('retries on Etherscan-level rate limit message', async () => {
    const rows = [txRow({ hash: '0xrl', isError: '1' })];

    mockFetch([
      {
        body: {
          status: '0',
          message: 'NOTOK',
          result: 'Max rate limit reached, please use API Key for higher rate limit',
        },
      },
      { body: apiResponse(rows) },
    ]);

    const provider = new EtherscanTransferProvider('test-key', 1);
    (provider as unknown as { _sleep: (ms: number) => Promise<void> })._sleep = async () => {};

    const transfers = await collect(provider, '0xuser');
    expect(transfers).toHaveLength(1);
  });
});

describe('EtherscanTransferProvider — getTokenMetadata', () => {
  it('always returns null', async () => {
    const provider = new EtherscanTransferProvider('test-key', 1);
    const result = await provider.getTokenMetadata({
      contractAddress: '0xusdc',
      chainId: 1,
    });
    expect(result).toBeNull();
  });
});

describe('EtherscanTransferProvider — unsupported chain', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws for unsupported chain ID', async () => {
    const provider = new EtherscanTransferProvider('test-key', 42161); // Arbitrum — not supported

    await expect(collect(provider, '0xuser')).rejects.toThrow(
      'does not support chainId 42161',
    );
  });
});

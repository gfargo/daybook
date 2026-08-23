import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoinGeckoProvider, CoinGeckoTransientError } from './coingecko.js';

describe('CoinGeckoProvider', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // ─── Basic happy-path ────────────────────────────────────────────────

  it('fetches historical prices by CoinGecko coin id and sends API key header', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        market_data: { current_price: { usd: 2305.73 } },
      }),
    });

    const provider = new CoinGeckoProvider({ apiKey: 'cg-test-key', requestsPerMinute: 600 });
    const result = await provider.getPrice('ETH', new Date('2024-01-15T12:00:00Z'));

    expect(result).toEqual({
      priceUsd: '2305.73',
      source: 'coingecko',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.coingecko.com/api/v3/coins/ethereum/history?date=15-01-2024&localization=false',
      {
        headers: {
          Accept: 'application/json',
          'x-cg-demo-api-key': 'cg-test-key',
        },
      },
    );
  });

  it('falls back to contract-address lookup when ticker is unknown', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        prices: [[1705276800000, 0.42]],
      }),
    });

    const provider = new CoinGeckoProvider({ requestsPerMinute: 600 });
    const result = await provider.getPrice(
      'KITTY',
      new Date('2024-01-15T12:00:00Z'),
      '0xABCDEF',
    );

    expect(result).toEqual({
      priceUsd: '0.42',
      source: 'coingecko',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.coingecko.com/api/v3/coins/ethereum/contract/0xabcdef/market_chart/range?vs_currency=usd&from=1705276800&to=1705363200',
      { headers: { Accept: 'application/json' } },
    );
  });

  it('retries once on HTTP 429 before returning a price', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          market_data: { current_price: { usd: 100 } },
        }),
      });

    const provider = new CoinGeckoProvider({ requestsPerMinute: 600 });
    const resultPromise = provider.getPrice('BTC', new Date('2024-01-15T12:00:00Z'));

    await vi.advanceTimersByTimeAsync(1000);

    await expect(resultPromise).resolves.toEqual({
      priceUsd: '100',
      source: 'coingecko',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ─── Transient error behaviour (throw, not null) ─────────────────────

  it('throws CoinGeckoTransientError when 429 exhausted after all retries', async () => {
    vi.useFakeTimers();
    // Return 429 on every attempt (maxRetries = 3 → 4 total attempts)
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({}),
    });

    const provider = new CoinGeckoProvider({ requestsPerMinute: 600 });
    let caughtError: unknown;
    const resultPromise = provider
      .getPrice('ETH', new Date('2024-01-15T12:00:00Z'))
      .catch(e => {
        caughtError = e;
      });

    // Advance timers past all backoff delays (1s + 2s + 4s = 7s)
    await vi.advanceTimersByTimeAsync(8000);
    await resultPromise;

    expect(caughtError).toBeInstanceOf(CoinGeckoTransientError);
    expect((caughtError as CoinGeckoTransientError).message).toMatch(/429.*exhausted/i);
  });

  it('throws CoinGeckoTransientError on non-2xx response (e.g. 500)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    const provider = new CoinGeckoProvider({ requestsPerMinute: 600 });
    await expect(
      provider.getPrice('ETH', new Date('2024-01-15T12:00:00Z')),
    ).rejects.toBeInstanceOf(CoinGeckoTransientError);
  });

  it('throws CoinGeckoTransientError on network error after all retries', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error('network down'));

    const provider = new CoinGeckoProvider({ requestsPerMinute: 600 });
    let caughtError: unknown;
    const resultPromise = provider
      .getPrice('ETH', new Date('2024-01-15T12:00:00Z'))
      .catch(e => {
        caughtError = e;
      });

    await vi.advanceTimersByTimeAsync(8000);
    await resultPromise;

    expect(caughtError).toBeInstanceOf(CoinGeckoTransientError);
  });

  // ─── Genuine no-data (return null) ──────────────────────────────────

  it('returns null (not throws) when 200 OK but market_data is missing', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 'some-obscure-token' }), // no market_data
    });

    const provider = new CoinGeckoProvider({ requestsPerMinute: 600 });
    const result = await provider.getPrice('ETH', new Date('2024-01-15T12:00:00Z'));
    expect(result).toBeNull();
  });

  it('returns null (not throws) when ticker is unknown and no contractAddress provided', async () => {
    // No fetch should happen for a totally unknown ticker without a contract address
    const provider = new CoinGeckoProvider({ requestsPerMinute: 600 });
    const result = await provider.getPrice('UNKNOWNTOKEN', new Date('2024-01-15T12:00:00Z'));
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null (not throws) when contract lookup returns empty prices array', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ prices: [] }),
    });

    const provider = new CoinGeckoProvider({ requestsPerMinute: 600 });
    const result = await provider.getPrice(
      'KITTY',
      new Date('2024-01-15T12:00:00Z'),
      '0xabcdef',
    );
    expect(result).toBeNull();
  });
});

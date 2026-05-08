import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoinGeckoProvider } from './coingecko.js';

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

  it('fetches historical prices by CoinGecko coin id and sends API key header', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        market_data: { current_price: { usd: 2305.73 } },
      }),
    });

    const provider = new CoinGeckoProvider({ apiKey: 'cg-test-key' });
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

    const provider = new CoinGeckoProvider();
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

    const provider = new CoinGeckoProvider();
    const resultPromise = provider.getPrice('BTC', new Date('2024-01-15T12:00:00Z'));

    await vi.advanceTimersByTimeAsync(1000);

    await expect(resultPromise).resolves.toEqual({
      priceUsd: '100',
      source: 'coingecko',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null instead of throwing on network errors', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error('network down'));

    const provider = new CoinGeckoProvider();
    const resultPromise = provider.getPrice('ETH', new Date('2024-01-15T12:00:00Z'));

    await vi.advanceTimersByTimeAsync(7000);

    await expect(resultPromise).resolves.toBeNull();
  });
});

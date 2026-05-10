import { describe, expect, it } from 'vitest';
import { CoinbaseAdvancedTradeApi } from './advanced-api.js';
import type { CoinbaseApiClient } from './api-client.js';

describe('CoinbaseAdvancedTradeApi', () => {
  it('collects paginated fills with date filters', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client = {
      async getJson(_path: string, query: Record<string, unknown>) {
        calls.push(query);
        if (!query.cursor) {
          return {
            fills: [{ entry_id: 'fill-1' }],
            cursor: 'cursor-1',
          };
        }
        return {
          fills: [{ entry_id: 'fill-2' }],
        };
      },
    } as CoinbaseApiClient;
    const api = new CoinbaseAdvancedTradeApi(client);

    const fills = await api.listFills({
      startSequenceTimestamp: '2024-01-01T00:00:00.000Z',
    });

    expect(fills.map(fill => fill.entry_id)).toEqual(['fill-1', 'fill-2']);
    expect(calls).toEqual([
      {
        limit: 100,
        start_sequence_timestamp: '2024-01-01T00:00:00.000Z',
      },
      {
        limit: 100,
        cursor: 'cursor-1',
        start_sequence_timestamp: '2024-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('stops when Coinbase explicitly marks the response as the last page', async () => {
    let calls = 0;
    const client = {
      async getJson() {
        calls++;
        return {
          fills: [{ entry_id: 'fill-1' }],
          cursor: 'cursor-1',
          has_next: false,
        };
      },
    } as CoinbaseApiClient;
    const api = new CoinbaseAdvancedTradeApi(client);

    await expect(api.listFills()).resolves.toHaveLength(1);
    expect(calls).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { mapCoinbaseApiData } from './api.js';
import type { CoinbaseTrackTransactionRecord } from './track-api.js';

describe('Coinbase API mapper', () => {
  it('maps matching Track transactions and Advanced Trade fills into one enriched trade', () => {
    const result = mapCoinbaseApiData({
      accountId: 'main-coinbase',
      records: [
        record({
          id: 'tx-1',
          type: 'advanced_trade_fill',
          status: 'completed',
          created_at: '2024-01-01T00:00:00Z',
          amount: { amount: '0.01', currency: 'BTC' },
          native_amount: { amount: '420', currency: 'USD' },
          advanced_trade_fill: { order_id: 'order-1' },
          details: { title: 'Bought BTC' },
        }, 'BTC'),
      ],
      fills: [{
        entry_id: 'fill-1',
        order_id: 'order-1',
        trade_time: '2024-01-01T00:00:01Z',
        product_id: 'BTC-USD',
        side: 'BUY',
        price: '42000',
        size: '0.01',
        commission: '1.25',
      }],
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      id: 'coinbase:api:v3:fill:fill-1',
      source: 'coinbase',
      accountId: 'main-coinbase',
      type: 'trade',
      notes: 'Bought BTC',
    });
    expect(result.events[0]!.timestamp.toISOString()).toBe('2024-01-01T00:00:01.000Z');
    expect(result.events[0]!.legs).toEqual([
      { asset: 'BTC', amount: '0.01' },
      { asset: 'USD', amount: '-420', amountUsdReportedBySource: '420' },
      { asset: 'USD', amount: '-1.25', amountUsdReportedBySource: '1.25', feeFlag: true },
    ]);
  });

  it('groups duplicate v2 transaction ids across Coinbase accounts into one event', () => {
    const result = mapCoinbaseApiData({
      accountId: 'main-coinbase',
      records: [
        record({
          id: 'buy-1',
          type: 'buy',
          status: 'completed',
          created_at: '2024-01-01T00:00:00Z',
          amount: { amount: '0.01', currency: 'BTC' },
          native_amount: { amount: '420', currency: 'USD' },
        }, 'BTC'),
        record({
          id: 'buy-1',
          type: 'buy',
          status: 'completed',
          created_at: '2024-01-01T00:00:00Z',
          amount: { amount: '-420', currency: 'USD' },
          native_amount: { amount: '420', currency: 'USD' },
        }, 'USD'),
      ],
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.id).toBe('coinbase:api:v2:buy-1');
    expect(result.events[0]!.type).toBe('trade');
    expect(result.events[0]!.legs).toEqual([
      { asset: 'BTC', amount: '0.01', amountUsdReportedBySource: '420' },
      { asset: 'USD', amount: '-420', amountUsdReportedBySource: '420' },
    ]);
  });

  it('maps rewards as income and skips incomplete transactions', () => {
    const result = mapCoinbaseApiData({
      accountId: 'main-coinbase',
      records: [
        record({
          id: 'reward-1',
          type: 'staking_reward',
          status: 'completed',
          created_at: '2024-01-02T00:00:00Z',
          amount: { amount: '1.5', currency: 'ATOM' },
          native_amount: { amount: '15', currency: 'USD' },
        }, 'ATOM'),
        record({
          id: 'pending-1',
          type: 'send',
          status: 'pending',
          created_at: '2024-01-02T01:00:00Z',
          amount: { amount: '-1', currency: 'ETH' },
        }, 'ETH'),
      ],
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.type).toBe('income');
    expect(result.events[0]!.legs).toEqual([
      { asset: 'ATOM', amount: '1.5', amountUsdReportedBySource: '15' },
    ]);
    expect(result.warnings).toContain(
      'Skipped Coinbase transaction pending-1 with status pending',
    );
  });
});

function record(
  transaction: CoinbaseTrackTransactionRecord['transaction'],
  currency: string,
): CoinbaseTrackTransactionRecord {
  return {
    account: {
      id: `account-${currency}`,
      currency: { code: currency },
    },
    transaction,
  };
}

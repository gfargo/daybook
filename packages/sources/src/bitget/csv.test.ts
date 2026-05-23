import { describe, expect, it } from 'vitest';
import { parseBitgetCsv } from './csv.js';

const accountId = 'main-bitget';

describe('parseBitgetCsv', () => {
  it('parses a UI-export spot buy', () => {
    const csv = [
      'Order ID,Trading Pair,Side,Filled Price,Filled Amount,Total,Fee,Fee Currency,Order Time,Order Type',
      'order-1,BTCUSDT,Buy,30000,0.05,1500,1.5,USDT,2024-01-15 12:00:00,Limit',
    ].join('\n');

    const result = parseBitgetCsv(csv, { accountId });

    expect(result.totalRows).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      id: 'bitget:order:order-1',
      source: 'bitget',
      accountId,
      type: 'trade',
      legs: [
        { asset: 'BTC', amount: '0.05' },
        { asset: 'USDT', amount: '-1500' },
        { asset: 'USDT', amount: '-1.5', feeFlag: true },
      ],
    });
  });

  it('parses an API-style export with cTime (Unix ms)', () => {
    const csv = [
      'orderId,symbol,side,priceAvg,size,baseVolume,quoteVolume,fee,feeCurrency,cTime',
      'order-2,ETHUSDT,sell,2000,0.5,0.5,1000,1,USDT,1707561600000',
    ].join('\n');

    const result = parseBitgetCsv(csv, { accountId });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      id: 'bitget:order:order-2',
      type: 'trade',
      legs: [
        { asset: 'ETH', amount: '-0.5' },
        { asset: 'USDT', amount: '1000' },
        { asset: 'USDT', amount: '-1', feeFlag: true },
      ],
    });
    // 1707561600000 ms → 2024-02-10T10:40:00Z (sanity check on ms parsing)
    expect(result.events[0]?.timestamp.toISOString()).toBe('2024-02-10T10:40:00.000Z');
  });

  it('groups multi-fill rows into a single trade', () => {
    const csv = [
      'Order ID,Trading Pair,Side,Filled Price,Filled Amount,Total,Fee,Fee Currency,Order Time,Order Type',
      'order-3,BTCUSDT,Buy,30000,0.02,600,0.6,USDT,2024-03-01 10:00:00,Limit',
      'order-3,BTCUSDT,Buy,30000,0.03,900,0.9,USDT,2024-03-01 10:00:01,Limit',
    ].join('\n');

    const result = parseBitgetCsv(csv, { accountId });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.legs).toEqual([
      { asset: 'BTC', amount: '0.05' },
      { asset: 'USDT', amount: '-1500' },
      { asset: 'USDT', amount: '-1.5', feeFlag: true },
    ]);
    expect(result.events[0]?.timestamp.toISOString()).toBe('2024-03-01T10:00:00.000Z');
  });

  it('strips legacy _SPBL suffix from spot symbols', () => {
    const csv = [
      'Order ID,Trading Pair,Side,Filled Price,Filled Amount,Total,Fee,Fee Currency,Order Time,Order Type',
      'order-4,BTCUSDT_SPBL,Buy,30000,0.01,300,0.3,USDT,2024-04-01 09:00:00,Limit',
    ].join('\n');

    const result = parseBitgetCsv(csv, { accountId });
    expect(result.events[0]?.legs[0]?.asset).toBe('BTC');
    expect(result.events[0]?.legs[1]?.asset).toBe('USDT');
  });

  it('parses deposit history filtered on success status', () => {
    const csv = [
      'Coin,Amount,Network,From Address,TXID,Time,Status',
      'BTC,0.5,Bitcoin,0xfromaddr,0xdeposit-tx-1,2024-05-01 09:00:00,success',
      'USDT,100,TRC20,Tfromaddr,0xdeposit-tx-2,2024-05-02 09:00:00,pending',
      'USDT,200,TRC20,Tfromaddr,0xdeposit-tx-3,2024-05-03 09:00:00,success',
    ].join('\n');

    const result = parseBitgetCsv(csv, { accountId });

    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      id: 'bitget:deposit:0xdeposit-tx-1',
      type: 'crypto_in',
      txHash: '0xdeposit-tx-1',
      legs: [{ asset: 'BTC', amount: '0.5' }],
    });
    expect(result.events[1]).toMatchObject({
      id: 'bitget:deposit:0xdeposit-tx-3',
      legs: [{ asset: 'USDT', amount: '200' }],
    });
  });

  it('parses withdrawal history with fee leg', () => {
    const csv = [
      'Coin,Amount,Network,To Address,TXID,Time,Status,Fee',
      'USDT,100,TRC20,Ttoaddr,0xwithdraw-tx-1,2024-06-01 09:00:00,success,1',
      'USDT,50,TRC20,Ttoaddr,0xwithdraw-tx-2,2024-06-02 09:00:00,rejected,1',
    ].join('\n');

    const result = parseBitgetCsv(csv, { accountId });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      id: 'bitget:withdrawal:0xwithdraw-tx-1',
      type: 'crypto_out',
      txHash: '0xwithdraw-tx-1',
      legs: [
        { asset: 'USDT', amount: '-100' },
        { asset: 'USDT', amount: '-1', feeFlag: true },
      ],
    });
  });

  it('handles Chinese side values (买入 / 卖出)', () => {
    const csv = [
      'Order ID,Trading Pair,Side,Filled Price,Filled Amount,Total,Fee,Fee Currency,Order Time,Order Type',
      'order-zh,ETHUSDT,买入,2000,0.1,200,0.2,USDT,2024-07-01 09:00:00,Limit',
    ].join('\n');

    const result = parseBitgetCsv(csv, { accountId });
    expect(result.events[0]?.legs).toEqual([
      { asset: 'ETH', amount: '0.1' },
      { asset: 'USDT', amount: '-200' },
      { asset: 'USDT', amount: '-0.2', feeFlag: true },
    ]);
  });

  it('produces stable IDs across reparses (idempotent)', () => {
    const csv = [
      'Order ID,Trading Pair,Side,Filled Price,Filled Amount,Total,Fee,Fee Currency,Order Time,Order Type',
      'order-stable,BTCUSDT,Buy,30000,0.01,300,0.3,USDT,2024-08-01 10:00:00,Limit',
    ].join('\n');

    const a = parseBitgetCsv(csv, { accountId });
    const b = parseBitgetCsv(csv, { accountId });
    expect(a.events[0]?.id).toBe(b.events[0]?.id);
  });

  it('warns and skips trade rows without Order ID', () => {
    const csv = [
      'Order ID,Trading Pair,Side,Filled Price,Filled Amount,Total,Fee,Fee Currency,Order Time,Order Type',
      ',BTCUSDT,Buy,30000,0.01,300,0,USDT,2024-09-01 10:00:00,Limit',
    ].join('\n');

    const result = parseBitgetCsv(csv, { accountId });
    expect(result.events).toEqual([]);
    expect(result.unparsedRowCount).toBe(1);
    expect(result.warnings.length).toBe(1);
  });

  it('rejects unrecognized headers', () => {
    expect(() => parseBitgetCsv('foo,bar\n1,2', { accountId })).toThrow(
      'Bitget CSV header not recognized',
    );
  });

  it('returns empty result for empty CSV', () => {
    const result = parseBitgetCsv('', { accountId });
    expect(result.events).toEqual([]);
    expect(result.totalRows).toBe(0);
  });

  it('sorts events ascending by timestamp', () => {
    const csv = [
      'Coin,Amount,Network,From Address,TXID,Time,Status',
      'BTC,1,Bitcoin,0xfrom,0xa,2024-09-01 09:00:00,success',
      'ETH,2,Ethereum,0xfrom,0xb,2024-07-01 09:00:00,success',
      'SOL,3,Solana,Sfrom,0xc,2024-08-01 09:00:00,success',
    ].join('\n');

    const result = parseBitgetCsv(csv, { accountId });
    expect(result.events.map((e) => e.txHash)).toEqual(['0xb', '0xc', '0xa']);
  });
});

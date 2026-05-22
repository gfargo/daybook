import { describe, expect, it } from 'vitest';
import { parseMexcCsv } from './csv.js';

const accountId = 'main-mexc';

describe('parseMexcCsv', () => {
  it('parses spot trade history with packed Fee cell', () => {
    const csv = [
      'UID,Pairs,Time,Side,Filled Price,Executed Amount,Total,Fee,Role',
      '123,BTCUSDT,2024-01-15 12:00:00,Buy,30000,0.05,1500,1.5USDT,Taker',
      '123,ETHUSDT,2024-02-10 09:00:00,Sell,2000,0.5,1000,1USDT,Maker',
    ].join('\n');

    const result = parseMexcCsv(csv, { accountId });

    expect(result.totalRows).toBe(2);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      source: 'mexc',
      accountId,
      type: 'trade',
      legs: [
        { asset: 'BTC', amount: '0.05' },
        { asset: 'USDT', amount: '-1500' },
        { asset: 'USDT', amount: '-1.5', feeFlag: true },
      ],
    });
    expect(result.events[1]).toMatchObject({
      type: 'trade',
      legs: [
        { asset: 'ETH', amount: '-0.5' },
        { asset: 'USDT', amount: '1000' },
        { asset: 'USDT', amount: '-1', feeFlag: true },
      ],
    });
  });

  it('parses legacy trade rows without UID and with bare-numeric Fee', () => {
    const csv = [
      'Pairs,Time,Side,Filled Price,Executed Amount,Total,Fee,Role',
      'BTCUSDT,2024-01-15 12:00:00,BUY,30000,0.05,1500,1.5,Taker',
    ].join('\n');

    const result = parseMexcCsv(csv, { accountId });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.legs).toEqual([
      { asset: 'BTC', amount: '0.05' },
      { asset: 'USDT', amount: '-1500' },
      // bare-numeric fee defaults to quote asset (USDT)
      { asset: 'USDT', amount: '-1.5', feeFlag: true },
    ]);
  });

  it('parses spot order history (fully-filled rows only)', () => {
    const csv = [
      'UID,Pairs,Time,Type,Direction,Average Filled Price,Order Price,Filled Quantity,Order Quantity,Order Amount,Status',
      '123,BTCUSDT,2024-03-01 10:00:00,LIMIT,Buy,30000,30000,0.02,0.02,600,Filled',
      '123,ETHUSDT,2024-03-02 11:00:00,LIMIT,Sell,2000,2000,0.5,0.5,1000,Cancelled',
      '123,ETHUSDT,2024-03-03 11:00:00,LIMIT,Sell,2000,2000,0.5,0.5,1000,Successful',
    ].join('\n');

    const result = parseMexcCsv(csv, { accountId });

    // Cancelled row skipped, Filled and Successful row produce events
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      type: 'trade',
      legs: [
        { asset: 'BTC', amount: '0.02' },
        { asset: 'USDT', amount: '-600' },
      ],
    });
    expect(result.events[1]).toMatchObject({
      type: 'trade',
      legs: [
        { asset: 'ETH', amount: '-0.5' },
        { asset: 'USDT', amount: '1000' },
      ],
    });
  });

  it('parses deposits, filtering on success status', () => {
    const csv = [
      'UID,Status,Time,Crypto,Network,Deposit Amount,TxID,Progress',
      '123,Credited Successfully,2024-04-01 09:00:00,BTC,Bitcoin,0.5,0xtxhash1,100%',
      '123,Pending,2024-04-02 09:00:00,USDT,TRC20,100,0xtxhash2,0%',
      '123,Credited Successfully,2024-04-03 09:00:00,USDT,TRC20,200,0xtxhash3,100%',
    ].join('\n');

    const result = parseMexcCsv(csv, { accountId });

    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      id: 'mexc:deposit:0xtxhash1',
      type: 'crypto_in',
      txHash: '0xtxhash1',
      legs: [{ asset: 'BTC', amount: '0.5' }],
    });
    expect(result.events[1]).toMatchObject({
      id: 'mexc:deposit:0xtxhash3',
      type: 'crypto_in',
      legs: [{ asset: 'USDT', amount: '200' }],
    });
  });

  it('parses withdrawals with settlement amount + trading fee', () => {
    const csv = [
      'UID,Status,Time,Crypto,Network,Request Amount,Withdrawal Address,memo,TxID,Trading Fee,Settlement Amount,Withdrawal Descriptions',
      '123,Withdrawal Successful,2024-05-01 09:00:00,USDT,TRC20,100,Taddress,,0xwtx,1,99,Normal',
      '123,Failed,2024-05-02 09:00:00,USDT,TRC20,50,Taddress,,0xwtx2,1,49,Normal',
    ].join('\n');

    const result = parseMexcCsv(csv, { accountId });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      id: 'mexc:withdrawal:0xwtx',
      type: 'crypto_out',
      txHash: '0xwtx',
      legs: [
        { asset: 'USDT', amount: '-99' },
        { asset: 'USDT', amount: '-1', feeFlag: true },
      ],
    });
  });

  it('splits underscore-separated pairs', () => {
    const csv = [
      'Pairs,Time,Side,Filled Price,Executed Amount,Total,Fee,Role',
      'SOL_USDC,2024-06-01 10:00:00,Buy,140,1,140,0.14USDC,Taker',
    ].join('\n');

    const result = parseMexcCsv(csv, { accountId });
    expect(result.events[0]?.legs[0]?.asset).toBe('SOL');
    expect(result.events[0]?.legs[1]?.asset).toBe('USDC');
  });

  it('peels known quote ticker off a concatenated pair', () => {
    const csv = [
      'Pairs,Time,Side,Filled Price,Executed Amount,Total,Fee,Role',
      'SHIBUSDT,2024-07-01 10:00:00,Buy,0.000025,1000000,25,0.025USDT,Taker',
    ].join('\n');

    const result = parseMexcCsv(csv, { accountId });
    expect(result.events[0]?.legs[0]?.asset).toBe('SHIB');
    expect(result.events[0]?.legs[1]?.asset).toBe('USDT');
  });

  it('produces stable IDs across reparses (idempotent)', () => {
    const csv = [
      'UID,Pairs,Time,Side,Filled Price,Executed Amount,Total,Fee,Role',
      '123,BTCUSDT,2024-08-01 10:00:00,Buy,30000,0.01,300,0.3USDT,Taker',
    ].join('\n');

    const a = parseMexcCsv(csv, { accountId });
    const b = parseMexcCsv(csv, { accountId });
    expect(a.events[0]?.id).toBe(b.events[0]?.id);
  });

  it('warns and skips trade rows missing critical fields', () => {
    const csv = [
      'Pairs,Time,Side,Filled Price,Executed Amount,Total,Fee,Role',
      ',2024-09-01 09:00:00,Buy,30000,,,,Taker',
    ].join('\n');

    const result = parseMexcCsv(csv, { accountId });
    expect(result.events).toEqual([]);
    expect(result.unparsedRowCount).toBe(1);
    expect(result.warnings.length).toBe(1);
  });

  it('rejects unrecognized headers', () => {
    expect(() => parseMexcCsv('foo,bar\n1,2', { accountId })).toThrow(
      'MEXC CSV header not recognized',
    );
  });

  it('returns empty result for empty CSV', () => {
    const result = parseMexcCsv('', { accountId });
    expect(result.events).toEqual([]);
    expect(result.totalRows).toBe(0);
  });

  it('sorts events ascending by timestamp', () => {
    const csv = [
      'UID,Status,Time,Crypto,Network,Deposit Amount,TxID,Progress',
      '123,Credited Successfully,2024-09-01 09:00:00,BTC,BTC,1,0xa,100%',
      '123,Credited Successfully,2024-07-01 09:00:00,ETH,ETH,2,0xb,100%',
      '123,Credited Successfully,2024-08-01 09:00:00,SOL,SOL,3,0xc,100%',
    ].join('\n');

    const result = parseMexcCsv(csv, { accountId });
    expect(result.events.map((e) => e.txHash)).toEqual(['0xb', '0xc', '0xa']);
  });
});

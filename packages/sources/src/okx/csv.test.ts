import { describe, expect, it } from 'vitest';
import { parseOkxCsv } from './csv.js';

const accountId = 'main-okx';

describe('parseOkxCsv', () => {
  it('normalizes V2 trade exports grouped by Order id', () => {
    const csv = [
      'id,Order id,Time,Trade Type,Symbol,Action,Amount,Trading Unit,Filled Price,Filled Price Unit,PnL,Fee,Fee Unit,Position Change,Position Balance,Position Unit,Balance Change,Balance,Balance Unit',
      '1,order-A,2024-01-15 12:00:00,spot,BTC-USDT,buy,0.05,BTC,30000,USDT,0,0,USDT,0.05,0.05,BTC,0,0,BTC',
      '2,order-A,2024-01-15 12:00:00,spot,BTC-USDT,sell,-1500,USDT,30000,USDT,0,0,USDT,0,0,USDT,-1500,0,USDT',
      '3,order-A,2024-01-15 12:00:00,fee,BTC-USDT,buy,0.00005,BTC,30000,USDT,0,0,USDT,0,0,BTC,0,0,BTC',
    ].join('\n');

    const result = parseOkxCsv(csv, { accountId });

    expect(result.totalRows).toBe(3);
    expect(result.events).toHaveLength(1);
    expect(result.unparsedRowCount).toBe(0);
    expect(result.events[0]).toMatchObject({
      id: 'okx:order:order-A',
      source: 'okx',
      accountId,
      type: 'trade',
      legs: [
        { asset: 'BTC', amount: '0.05' },
        { asset: 'USDT', amount: '-1500' },
        { asset: 'BTC', amount: '-0.00005', feeFlag: true },
      ],
    });
  });

  it('combines duplicate legs in the same order', () => {
    const csv = [
      'id,Order id,Time,Trade Type,Symbol,Action,Amount,Trading Unit,Filled Price,Filled Price Unit,PnL,Fee,Fee Unit,Position Change,Position Balance,Position Unit,Balance Change,Balance,Balance Unit',
      '1,order-B,2024-02-10 09:00:00,spot,ETH-USDT,buy,1,ETH,2000,USDT,0,0,USDT,1,1,ETH,0,0,ETH',
      '2,order-B,2024-02-10 09:00:00,spot,ETH-USDT,buy,0.5,ETH,2000,USDT,0,0,USDT,0.5,1.5,ETH,0,0,ETH',
      '3,order-B,2024-02-10 09:00:00,spot,ETH-USDT,sell,-3000,USDT,2000,USDT,0,0,USDT,0,0,USDT,-3000,0,USDT',
    ].join('\n');

    const result = parseOkxCsv(csv, { accountId });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.legs).toEqual([
      { asset: 'ETH', amount: '1.5' },
      { asset: 'USDT', amount: '-3000' },
    ]);
  });

  it('parses V1 legacy trade exports with concatenated Total/Fee', () => {
    const csv = [
      'Trade ID,Trade Time,Pairs,Amount,Price,Total,Fee,unit',
      'trade-1,2024-03-01 10:00:00,BTC_USDT,0.02,30000,600 USDT,0.6 USDT,USDT',
      'trade-2,2024-03-02 11:00:00,ETH_USDT,-0.5,2000,1000 USDT,0.001 ETH,ETH',
    ].join('\n');

    const result = parseOkxCsv(csv, { accountId });

    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      id: 'okx:trade:trade-1',
      type: 'trade',
      legs: [
        { asset: 'BTC', amount: '0.02' },
        { asset: 'USDT', amount: '-600' },
        { asset: 'USDT', amount: '-0.6', feeFlag: true },
      ],
    });
    expect(result.events[1]).toMatchObject({
      id: 'okx:trade:trade-2',
      type: 'trade',
      legs: [
        { asset: 'ETH', amount: '-0.5' },
        { asset: 'USDT', amount: '1000' },
        { asset: 'ETH', amount: '-0.001', feeFlag: true },
      ],
    });
  });

  it('tolerates the legacy BOM prefix and trailing CR on V1 headers', () => {
    const csv = [
      '﻿Trade ID,Trade Time,Pairs,Amount,Price,Total,Fee,unit\r',
      'trade-bom,2024-03-03 10:00:00,BTC_USDT,0.01,30000,300 USDT,0.3 USDT,USDT',
    ].join('\n');

    const result = parseOkxCsv(csv, { accountId });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.id).toBe('okx:trade:trade-bom');
  });

  it('parses funding deposits and withdrawals', () => {
    const csv = [
      'id,Time,Type,Amount,Before Balance,After Balance,Symbol',
      'fund-1,2024-04-01 09:00:00,Deposit,0.5,0,0.5,BTC',
      'fund-2,2024-04-15 09:00:00,Withdrawal,-100,500,400,USDT',
      'fund-3,2024-04-20 09:00:00,Distribution,5,0,5,OKB',
    ].join('\n');

    const result = parseOkxCsv(csv, { accountId });

    expect(result.events).toHaveLength(3);
    expect(result.events[0]).toMatchObject({
      id: 'okx:funding:fund-1',
      type: 'crypto_in',
      legs: [{ asset: 'BTC', amount: '0.5' }],
    });
    expect(result.events[1]).toMatchObject({
      id: 'okx:funding:fund-2',
      type: 'crypto_out',
      legs: [{ asset: 'USDT', amount: '-100' }],
    });
    expect(result.events[2]).toMatchObject({
      id: 'okx:funding:fund-3',
      type: 'income',
      legs: [{ asset: 'OKB', amount: '5' }],
    });
  });

  it('flips a positive withdrawal amount based on the type column', () => {
    const csv = [
      'id,Time,Type,Amount,Before Balance,After Balance,Symbol',
      'fund-w,2024-05-01 09:00:00,Withdrawal,100,500,400,USDT',
    ].join('\n');

    const result = parseOkxCsv(csv, { accountId });
    expect(result.events[0]?.legs).toEqual([{ asset: 'USDT', amount: '-100' }]);
  });

  it('produces stable IDs across reparses (idempotent)', () => {
    const csv = [
      'id,Time,Type,Amount,Before Balance,After Balance,Symbol',
      'fund-id,2024-06-01 09:00:00,Deposit,1,0,1,ETH',
    ].join('\n');

    const a = parseOkxCsv(csv, { accountId });
    const b = parseOkxCsv(csv, { accountId });
    expect(a.events[0]?.id).toBe(b.events[0]?.id);
  });

  it('warns and skips rows missing critical fields', () => {
    const csv = [
      'id,Time,Type,Amount,Before Balance,After Balance,Symbol',
      'bad,2024-06-01 09:00:00,Deposit,,0,0,',
    ].join('\n');

    const result = parseOkxCsv(csv, { accountId });
    expect(result.events).toEqual([]);
    expect(result.unparsedRowCount).toBe(1);
    expect(result.warnings.length).toBe(1);
  });

  it('rejects unrecognized headers', () => {
    expect(() => parseOkxCsv('foo,bar\n1,2', { accountId })).toThrow(
      'OKX CSV header not recognized',
    );
  });

  it('returns empty result for empty CSV', () => {
    const result = parseOkxCsv('', { accountId });
    expect(result.events).toEqual([]);
    expect(result.totalRows).toBe(0);
  });

  it('sorts events ascending by timestamp', () => {
    const csv = [
      'id,Time,Type,Amount,Before Balance,After Balance,Symbol',
      'b,2024-08-01 09:00:00,Deposit,1,0,1,BTC',
      'a,2024-07-01 09:00:00,Deposit,2,0,2,ETH',
      'c,2024-09-01 09:00:00,Deposit,3,0,3,SOL',
    ].join('\n');

    const result = parseOkxCsv(csv, { accountId });
    expect(result.events.map((e) => e.id)).toEqual([
      'okx:funding:a',
      'okx:funding:b',
      'okx:funding:c',
    ]);
  });
});

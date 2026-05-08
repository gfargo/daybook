import { describe, expect, it } from 'vitest';
import { parseBinanceCsv } from './csv.js';

describe('parseBinanceCsv', () => {
  it('groups Binance ledger trade rows with explicit fee rows', () => {
    const csv = [
      'User_ID,UTC_Time,Account,Operation,Coin,Change,Remark',
      '123,2024-01-15 10:00:00,Spot,Buy,ETH,0.5,order-001',
      '123,2024-01-15 10:00:00,Spot,Sell,USDT,-1000,order-001',
      '123,2024-01-15 10:00:00,Spot,Fee,BNB,-0.01,order-001',
    ].join('\n');

    const result = parseBinanceCsv(csv, {
      accountId: 'main-binance',
      source: 'binance',
    });

    expect(result.totalRows).toBe(3);
    expect(result.unparsedRowCount).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.events).toHaveLength(1);

    const event = result.events[0]!;
    expect(event.source).toBe('binance');
    expect(event.accountId).toBe('main-binance');
    expect(event.timestamp.toISOString()).toBe('2024-01-15T10:00:00.000Z');
    expect(event.type).toBe('trade');
    expect(event.legs).toEqual([
      { asset: 'ETH', amount: '0.5' },
      { asset: 'USDT', amount: '-1000' },
      { asset: 'BNB', amount: '-0.01', feeFlag: true },
    ]);
  });

  it('keeps Binance stablecoin deposits as crypto, not fiat', () => {
    const csv = [
      'User_ID,UTC_Time,Account,Operation,Coin,Change,Remark',
      '123,2024-02-01 12:00:00,Spot,Deposit,USDC,1000,deposit-001',
      '123,2024-02-02 12:00:00,Spot,Fiat Deposit,USD,250,ach-001',
    ].join('\n');

    const result = parseBinanceCsv(csv, {
      accountId: 'main-binance',
      source: 'binance',
    });

    expect(result.events.map(event => event.type)).toEqual(['crypto_in', 'fiat_deposit']);
    expect(result.events[0]!.legs).toEqual([{ asset: 'USDC', amount: '1000' }]);
    expect(result.events[1]!.legs).toEqual([{ asset: 'USD', amount: '250' }]);
  });

  it('classifies Binance rewards as income', () => {
    const csv = [
      'User_ID,UTC_Time,Account,Operation,Coin,Change,Remark',
      '123,2024-03-01 08:00:00,Earn,Simple Earn Flexible Interest,SOL,1.25,reward-001',
    ].join('\n');

    const result = parseBinanceCsv(csv, {
      accountId: 'main-binance',
      source: 'binance',
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.type).toBe('income');
    expect(result.events[0]!.legs).toEqual([{ asset: 'SOL', amount: '1.25' }]);
  });

  it('parses Binance.US tax-report style rows', () => {
    const csv = [
      'Time,Category,Operation,Order_ID,Transaction_ID,Primary_Asset,Realized_Amount_For_Primary_Asset,Quote_Asset,Realized_Amount_For_Quote_Asset,Fee_Asset,Realized_Amount_For_Fee_Asset',
      '2024-04-05 16:30:00,Trade,Buy,order-123,tx-123,BTC,0.1,USD,-3000,USD,5',
    ].join('\n');

    const result = parseBinanceCsv(csv, {
      accountId: 'main-binance-us',
      source: 'binance-us',
    });

    expect(result.totalRows).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.id).toBe('binance-us:tx-123');
    expect(result.events[0]!.source).toBe('binance-us');
    expect(result.events[0]!.type).toBe('trade');
    expect(result.events[0]!.legs).toEqual([
      { asset: 'BTC', amount: '0.1' },
      { asset: 'USD', amount: '-3000' },
      { asset: 'USD', amount: '-5', feeFlag: true },
    ]);
  });

  it('warns on unrecognized CSV headers', () => {
    expect(() => parseBinanceCsv('Date,Amount\n2024-01-01,1', {
      accountId: 'main-binance',
      source: 'binance',
    })).toThrow('Binance CSV header not recognized');
  });
});

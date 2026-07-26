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

  it('counts all rows of a grouped-timestamp drop (N rows → unparsedRowCount = N)', () => {
    // A 3-row group sharing an unparsable timestamp forms a trade candidate
    // but fails at buildLedgerGroupEvent (bad timestamp), then each row also
    // fails buildSingleLedgerEvent for the same reason.  Old code gave 1 (one
    // warning message); new code must give 3.
    const csv = [
      'User_ID,UTC_Time,Account,Operation,Coin,Change,Remark',
      '123,not-a-date,Spot,Buy,ETH,0.5,order-bad',
      '123,not-a-date,Spot,Sell,USDT,-1000,order-bad',
      '123,not-a-date,Spot,Fee,BNB,-0.01,order-bad',
    ].join('\n');

    const result = parseBinanceCsv(csv, {
      accountId: 'main-binance',
      source: 'binance',
    });

    expect(result.totalRows).toBe(3);
    expect(result.events).toHaveLength(0);
    expect(result.unparsedRowCount).toBe(3);
  });

  it('counts a toLedgerRow field-missing drop as 1 and still emits the valid sibling', () => {
    // Row 2 is missing Coin — toLedgerRow returns undefined → unparsedRowCount++.
    // Row 3 is valid → emits an event.
    const csv = [
      'User_ID,UTC_Time,Account,Operation,Coin,Change,Remark',
      '123,,Spot,Buy,,0.5,',          // missing time AND coin
      '123,2024-01-15 10:00:00,Spot,Deposit,BTC,0.1,',
    ].join('\n');

    const result = parseBinanceCsv(csv, {
      accountId: 'main-binance',
      source: 'binance',
    });

    expect(result.totalRows).toBe(2);
    expect(result.events).toHaveLength(1);
    expect(result.unparsedRowCount).toBe(1);
  });

  it('counts a tax-report row with an unparsable timestamp as 1', () => {
    const csv = [
      'Time,Category,Operation,Order_ID,Transaction_ID,Primary_Asset,Realized_Amount_For_Primary_Asset,Quote_Asset,Realized_Amount_For_Quote_Asset,Fee_Asset,Realized_Amount_For_Fee_Asset',
      'not-a-date,Trade,Buy,order-123,tx-123,BTC,0.1,USD,-3000,USD,5',
    ].join('\n');

    const result = parseBinanceCsv(csv, {
      accountId: 'main-binance-us',
      source: 'binance-us',
    });

    expect(result.totalRows).toBe(1);
    expect(result.events).toHaveLength(0);
    expect(result.unparsedRowCount).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/skipped/);
  });

  it('counts a tax-report row with no parsable asset columns as 1', () => {
    const csv = [
      'Time,Category,Operation,Order_ID,Transaction_ID,Primary_Asset,Realized_Amount_For_Primary_Asset,Quote_Asset,Realized_Amount_For_Quote_Asset,Fee_Asset,Realized_Amount_For_Fee_Asset',
      '2024-04-05 16:30:00,Trade,Buy,order-123,tx-123,,,,,,'
    ].join('\n');

    const result = parseBinanceCsv(csv, {
      accountId: 'main-binance-us',
      source: 'binance-us',
    });

    expect(result.totalRows).toBe(1);
    expect(result.events).toHaveLength(0);
    expect(result.unparsedRowCount).toBe(1);
    expect(result.warnings).toHaveLength(1);
  });
});

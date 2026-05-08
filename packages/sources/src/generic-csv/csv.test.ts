import { describe, expect, it } from 'vitest';
import { parseGenericCsv } from './csv.js';

const accountId = 'csv-imports';

describe('parseGenericCsv', () => {
  it('parses a Koinly-style universal CSV trade with a fee', () => {
    const csv = [
      'Date,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency,Net Worth Amount,Net Worth Currency,Label,Description,TxHash',
      '2024-01-15 10:00:00,0.5,BTC,10,ETH,25,USD,21000,USD,Trade,Converted BTC to ETH,0xabc',
    ].join('\n');

    const result = parseGenericCsv(csv, { accountId });

    expect(result.totalRows).toBe(1);
    expect(result.unparsedRowCount).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.events).toHaveLength(1);

    const event = result.events[0]!;
    expect(event.id).toBe('csv:0xabc');
    expect(event.source).toBe('csv');
    expect(event.accountId).toBe(accountId);
    expect(event.timestamp.toISOString()).toBe('2024-01-15T10:00:00.000Z');
    expect(event.type).toBe('trade');
    expect(event.txHash).toBe('0xabc');
    expect(event.notes).toBe('Converted BTC to ETH');
    expect(event.legs).toEqual([
      { asset: 'BTC', amount: '-0.5', amountUsdReportedBySource: '21000' },
      { asset: 'ETH', amount: '10', amountUsdReportedBySource: '21000' },
      { asset: 'USD', amount: '-25', amountUsdReportedBySource: '25', feeFlag: true },
    ]);
  });

  it('parses CoinTracker-style quantity aliases and income labels', () => {
    const csv = [
      'Date,Received Quantity,Received Currency,Tag,Description,Transaction ID',
      '2024-03-01T08:00:00Z,1.25,SOL,staking reward,Validator payout,reward-001',
    ].join('\n');

    const result = parseGenericCsv(csv, { accountId });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.id).toBe('csv:reward-001');
    expect(result.events[0]!.type).toBe('income');
    expect(result.events[0]!.legs).toEqual([
      { asset: 'SOL', amount: '1.25' },
    ]);
  });

  it('keeps stablecoins as crypto assets instead of fiat', () => {
    const csv = [
      'Date,Received Amount,Received Currency,Label,ID',
      '2024-04-10T12:00:00Z,100,USDC,Deposit,stable-001',
      '2024-04-11T12:00:00Z,50,USDT,Reward,stable-002',
    ].join('\n');

    const result = parseGenericCsv(csv, { accountId });

    expect(result.events.map(event => event.type)).toEqual(['crypto_in', 'income']);
    expect(result.events[0]!.legs[0]!.asset).toBe('USDC');
    expect(result.events[1]!.legs[0]!.asset).toBe('USDT');
  });

  it('treats actual fiat rows as fiat deposits and withdrawals', () => {
    const csv = [
      'Date,Amount,Currency,Type,ID',
      '2024-05-01T00:00:00Z,1000,USD,Deposit,fiat-in',
      '2024-05-02T00:00:00Z,250,USD,Withdrawal,fiat-out',
    ].join('\n');

    const result = parseGenericCsv(csv, { accountId });

    expect(result.events.map(event => event.type)).toEqual([
      'fiat_deposit',
      'fiat_withdrawal',
    ]);
    expect(result.events.map(event => event.legs[0]!.amount)).toEqual(['1000', '-250']);
  });

  it('creates deterministic hashed IDs and suffixes duplicate native IDs', () => {
    const csv = [
      'Date,Received Amount,Received Currency,Description,TxHash',
      '2024-06-01T00:00:00Z,1,ETH,First receive,0xdup',
      '2024-06-02T00:00:00Z,2,ETH,Second receive,0xdup',
      '2024-06-03T00:00:00Z,3,ETH,No native id,',
    ].join('\n');

    const first = parseGenericCsv(csv, { accountId });
    const second = parseGenericCsv(csv, { accountId });

    expect(first.events.map(event => event.id)).toEqual([
      'csv:0xdup',
      'csv:0xdup:2',
      expect.stringMatching(/^csv:row:[a-f0-9]{16}$/),
    ]);
    expect(second.events.map(event => event.id)).toEqual(first.events.map(event => event.id));
  });

  it('warns and skips rows without a date or asset movement', () => {
    const csv = [
      'Date,Received Amount,Received Currency,Description',
      ',1,ETH,No date',
      '2024-07-01T00:00:00Z,,,No amount',
    ].join('\n');

    const result = parseGenericCsv(csv, { accountId });

    expect(result.events).toEqual([]);
    expect(result.unparsedRowCount).toBe(2);
    expect(result.warnings).toEqual([
      'Row 2: missing date/timestamp',
      'Row 3: no asset movement columns could be parsed',
    ]);
  });
});

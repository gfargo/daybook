import { describe, expect, it } from 'vitest';
import { parseGateioCsv } from './csv.js';

const accountId = 'main-gateio';

describe('parseGateioCsv', () => {
  it('reconstructs a spot trade from grouped buy/sell/fee legs', () => {
    const csv = [
      'no,time,action_desc,action_data,type,change_amount,amount,total',
      '1,2024-01-15 12:00:00,Order Filled,trade-001,BTC,0.05,0.05,1500',
      '2,2024-01-15 12:00:00,Order Filled,trade-001,USDT,-1500,8500,8500',
      '3,2024-01-15 12:00:00,Trading Fees,trade-001,USDT,-1.5,8498.5,8498.5',
    ].join('\n');

    const result = parseGateioCsv(csv, { accountId });

    expect(result.totalRows).toBe(3);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      id: 'gateio:trade:trade-001',
      source: 'gateio',
      accountId,
      type: 'trade',
      legs: [
        { asset: 'BTC', amount: '0.05' },
        { asset: 'USDT', amount: '-1500' },
        { asset: 'USDT', amount: '-1.5', feeFlag: true },
      ],
    });
  });

  it('handles the "Order Fullfilled" misspelling literally', () => {
    const csv = [
      'no,time,action_desc,action_data,type,change_amount,amount,total',
      '1,2024-02-01 09:00:00,Order Fullfilled,trade-002,ETH,1,1,2000',
      '2,2024-02-01 09:00:00,Order Fullfilled,trade-002,USDT,-2000,6500,6500',
    ].join('\n');

    const result = parseGateioCsv(csv, { accountId });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.type).toBe('trade');
    expect(result.events[0]?.legs).toEqual([
      { asset: 'ETH', amount: '1' },
      { asset: 'USDT', amount: '-2000' },
    ]);
  });

  it('sums multiple partial-fill rows within one trade group', () => {
    const csv = [
      'no,time,action_desc,action_data,type,change_amount,amount,total',
      '1,2024-03-01 10:00:00,Order Filled,trade-003,BTC,0.02,0.02,600',
      '2,2024-03-01 10:00:00,Order Filled,trade-003,USDT,-600,7400,7400',
      '3,2024-03-01 10:00:01,Order Filled,trade-003,BTC,0.03,0.05,900',
      '4,2024-03-01 10:00:01,Order Filled,trade-003,USDT,-900,6500,6500',
      '5,2024-03-01 10:00:01,Trading Fees,trade-003,USDT,-1.5,6498.5,6498.5',
    ].join('\n');

    const result = parseGateioCsv(csv, { accountId });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.legs).toEqual([
      { asset: 'BTC', amount: '0.05' },
      { asset: 'USDT', amount: '-1500' },
      { asset: 'USDT', amount: '-1.5', feeFlag: true },
    ]);
    // Earliest timestamp wins for the grouped event
    expect(result.events[0]?.timestamp.toISOString()).toBe('2024-03-01T10:00:00.000Z');
  });

  it('parses deposits and withdrawals as singleton groups', () => {
    const csv = [
      'no,time,action_desc,action_data,type,change_amount,amount,total',
      '1,2024-04-01 09:00:00,Deposits,deposit-1,BTC,0.5,0.5,15000',
      '2,2024-04-15 09:00:00,Withdrawals,withdraw-1,USDT,-100,6400,6400',
    ].join('\n');

    const result = parseGateioCsv(csv, { accountId });

    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      id: 'gateio:crypto_in:deposit-1',
      type: 'crypto_in',
      legs: [{ asset: 'BTC', amount: '0.5' }],
    });
    expect(result.events[1]).toMatchObject({
      id: 'gateio:crypto_out:withdraw-1',
      type: 'crypto_out',
      legs: [{ asset: 'USDT', amount: '-100' }],
    });
  });

  it('classifies airdrop / interest / rebate as income', () => {
    const csv = [
      'no,time,action_desc,action_data,type,change_amount,amount,total',
      '1,2024-05-01 09:00:00,Airdrop,air-1,GT,10,10,30',
      '2,2024-05-02 09:00:00,HODL Interest,int-1,USDT,5,6405,6405',
      '3,2024-05-03 09:00:00,Referral Superior Rebate,ref-1,USDT,2,6407,6407',
    ].join('\n');

    const result = parseGateioCsv(csv, { accountId });

    expect(result.events.every((e) => e.type === 'income')).toBe(true);
    expect(result.events).toHaveLength(3);
  });

  it('reconstructs a dust swap as a trade event', () => {
    const csv = [
      'no,time,action_desc,action_data,type,change_amount,amount,total',
      '1,2024-06-01 09:00:00,Dust Swap-Small Balances Deducted,dust-1,ABC,-0.0001,0,0',
      '2,2024-06-01 09:00:00,Dust Swap-Small Balances Deducted,dust-1,XYZ,-0.0002,0,0',
      '3,2024-06-01 09:00:00,Dust Swap-GT Added,dust-1,GT,0.001,10.001,30.003',
    ].join('\n');

    const result = parseGateioCsv(csv, { accountId });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      id: 'gateio:dustswap:dust-1',
      type: 'trade',
      notes: 'dust swap',
    });
    expect(result.events[0]?.legs).toEqual([
      { asset: 'ABC', amount: '-0.0001' },
      { asset: 'XYZ', amount: '-0.0002' },
      { asset: 'GT', amount: '0.001' },
    ]);
  });

  it('skips zero-change rows', () => {
    const csv = [
      'no,time,action_desc,action_data,type,change_amount,amount,total',
      '1,2024-07-01 09:00:00,Order Placed,trade-zero,BTC,0,0,0',
    ].join('\n');

    const result = parseGateioCsv(csv, { accountId });
    expect(result.events).toEqual([]);
    expect(result.unparsedRowCount).toBe(1);
  });

  it('produces stable IDs across reparses (idempotent)', () => {
    const csv = [
      'no,time,action_desc,action_data,type,change_amount,amount,total',
      '1,2024-08-01 09:00:00,Order Filled,trade-stable,BTC,0.01,0.01,300',
      '2,2024-08-01 09:00:00,Order Filled,trade-stable,USDT,-300,7100,7100',
    ].join('\n');

    const a = parseGateioCsv(csv, { accountId });
    const b = parseGateioCsv(csv, { accountId });
    expect(a.events[0]?.id).toBe(b.events[0]?.id);
  });

  it('warns when a trade group has only one side', () => {
    const csv = [
      'no,time,action_desc,action_data,type,change_amount,amount,total',
      '1,2024-09-01 09:00:00,Order Filled,trade-broken,BTC,0.05,0.05,1500',
    ].join('\n');

    const result = parseGateioCsv(csv, { accountId });
    expect(result.events).toEqual([]);
    expect(result.warnings.some((w) => w.includes('incomplete legs'))).toBe(true);
  });

  it('rejects unrecognized headers', () => {
    expect(() => parseGateioCsv('foo,bar\n1,2', { accountId })).toThrow(
      'Gate.io CSV header not recognized',
    );
  });

  it('returns empty result for empty CSV', () => {
    const result = parseGateioCsv('', { accountId });
    expect(result.events).toEqual([]);
    expect(result.totalRows).toBe(0);
  });

  it('sorts events ascending by timestamp', () => {
    const csv = [
      'no,time,action_desc,action_data,type,change_amount,amount,total',
      '1,2024-09-01 09:00:00,Deposits,dep-c,BTC,1,1,30000',
      '2,2024-07-01 09:00:00,Deposits,dep-a,ETH,2,2,4000',
      '3,2024-08-01 09:00:00,Deposits,dep-b,SOL,3,3,420',
    ].join('\n');

    const result = parseGateioCsv(csv, { accountId });
    expect(result.events.map((e) => e.legs[0]?.asset)).toEqual(['ETH', 'SOL', 'BTC']);
  });
});

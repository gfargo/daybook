import { describe, expect, it } from 'vitest';
import { parseBybitCsv } from './csv.js';

const accountId = 'main-bybit';

describe('parseBybitCsv', () => {
  it('normalizes a single-fill spot buy', () => {
    const csv = [
      'Order ID,Transaction ID,Filled Time,Symbol,Side,Filled Price,Quantity,Exec Value,Fee,Fee Currency',
      'order-1,trade-1,2024-01-15 12:00:00,BTCUSDT,Buy,30000,0.05,1500,0.0000375,BTC',
    ].join('\n');

    const result = parseBybitCsv(csv, { accountId });

    expect(result.totalRows).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      id: 'bybit:order:order-1',
      source: 'bybit',
      accountId,
      type: 'trade',
      legs: [
        { asset: 'BTC', amount: '0.05' },
        { asset: 'USDT', amount: '-1500' },
        { asset: 'BTC', amount: '-0.0000375', feeFlag: true },
      ],
    });
  });

  it('normalizes a single-fill spot sell', () => {
    const csv = [
      'Order ID,Transaction ID,Filled Time,Symbol,Side,Filled Price,Quantity,Exec Value,Fee,Fee Currency',
      'order-2,trade-2,2024-02-10 09:00:00,ETHUSDT,Sell,2000,0.5,1000,1,USDT',
    ].join('\n');

    const result = parseBybitCsv(csv, { accountId });

    expect(result.events[0]).toMatchObject({
      id: 'bybit:order:order-2',
      type: 'trade',
      legs: [
        { asset: 'ETH', amount: '-0.5' },
        { asset: 'USDT', amount: '1000' },
        { asset: 'USDT', amount: '-1', feeFlag: true },
      ],
    });
  });

  it('groups multi-fill rows into a single trade', () => {
    const csv = [
      'Order ID,Transaction ID,Filled Time,Symbol,Side,Filled Price,Quantity,Exec Value,Fee,Fee Currency',
      'order-3,fill-3a,2024-03-01 10:00:00,BTCUSDT,Buy,30000,0.02,600,0.0000015,BTC',
      'order-3,fill-3b,2024-03-01 10:00:01,BTCUSDT,Buy,30000,0.03,900,0.0000023,BTC',
    ].join('\n');

    const result = parseBybitCsv(csv, { accountId });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.legs).toEqual([
      { asset: 'BTC', amount: '0.05' },
      { asset: 'USDT', amount: '-1500' },
      { asset: 'BTC', amount: '-0.0000038', feeFlag: true },
    ]);
    // Earliest timestamp wins for the grouped event
    expect(result.events[0]?.timestamp.toISOString()).toBe('2024-03-01T10:00:00.000Z');
  });

  it('parses funding v2 deposits and withdrawals', () => {
    const csv = [
      'Date & Time(UTC),Coin,QTY,Type,Account Balance,Description',
      '2024-04-01 09:00:00,BTC,0.5,TRANSFER,0.5,Deposit',
      '2024-04-15 09:00:00,USDT,100,TRANSFER,400,Withdrawal',
      '2024-04-20 09:00:00,USDT,50,TRANSFER,450,Transfer to Derivatives Account',
    ].join('\n');

    const result = parseBybitCsv(csv, { accountId });

    expect(result.events).toHaveLength(3);
    expect(result.events[0]).toMatchObject({
      type: 'crypto_in',
      legs: [{ asset: 'BTC', amount: '0.5' }],
    });
    expect(result.events[1]).toMatchObject({
      type: 'crypto_out',
      legs: [{ asset: 'USDT', amount: '-100' }],
    });
    // Transfer to Derivatives is treated as outbound from the spot wallet
    expect(result.events[2]).toMatchObject({
      type: 'crypto_out',
      legs: [{ asset: 'USDT', amount: '-50' }],
    });
  });

  it('parses funding v1 legacy deposit/withdrawal rows', () => {
    const csv = [
      'Type,Coin,Amount,Wallet Balance,Time(UTC)',
      'userDeposit,BTC,0.1,0.1,2024-05-01 09:00:00',
      'internalAccountTransferDeposit,USDT,500,500,2024-05-02 09:00:00',
      'internalAccountTransferWithdrawal,USDT,200,300,2024-05-03 09:00:00',
    ].join('\n');

    const result = parseBybitCsv(csv, { accountId });

    expect(result.events).toHaveLength(3);
    expect(result.events[0]).toMatchObject({
      type: 'crypto_in',
      legs: [{ asset: 'BTC', amount: '0.1' }],
    });
    expect(result.events[1]).toMatchObject({
      type: 'crypto_in',
      legs: [{ asset: 'USDT', amount: '500' }],
    });
    expect(result.events[2]).toMatchObject({
      type: 'crypto_out',
      legs: [{ asset: 'USDT', amount: '-200' }],
    });
  });

  it('classifies bonus/rebate rows as income', () => {
    const csv = [
      'Date & Time(UTC),Coin,QTY,Type,Account Balance,Description',
      '2024-06-01 09:00:00,USDT,5,REBATE,5,VIP Rebate',
      '2024-06-02 09:00:00,BIT,10,BONUS,10,Bonus distribution',
    ].join('\n');

    const result = parseBybitCsv(csv, { accountId });

    expect(result.events[0]?.type).toBe('income');
    expect(result.events[1]?.type).toBe('income');
  });

  it('produces stable IDs across reparses (idempotent)', () => {
    const csv = [
      'Order ID,Transaction ID,Filled Time,Symbol,Side,Filled Price,Quantity,Exec Value,Fee,Fee Currency',
      'order-stable,trade-x,2024-07-01 10:00:00,BTCUSDT,Buy,30000,0.01,300,0.0000003,BTC',
    ].join('\n');

    const a = parseBybitCsv(csv, { accountId });
    const b = parseBybitCsv(csv, { accountId });
    expect(a.events[0]?.id).toBe(b.events[0]?.id);
  });

  it('warns and skips rows without an Order ID', () => {
    const csv = [
      'Order ID,Transaction ID,Filled Time,Symbol,Side,Filled Price,Quantity,Exec Value,Fee,Fee Currency',
      ',trade-orphan,2024-07-02 10:00:00,BTCUSDT,Buy,30000,0.01,300,0,BTC',
    ].join('\n');

    const result = parseBybitCsv(csv, { accountId });
    expect(result.events).toEqual([]);
    expect(result.unparsedRowCount).toBe(1);
    expect(result.warnings.length).toBe(1);
  });

  it('rejects unrecognized headers', () => {
    expect(() => parseBybitCsv('foo,bar\n1,2', { accountId })).toThrow(
      'Bybit CSV header not recognized',
    );
  });

  it('returns empty result for empty CSV', () => {
    const result = parseBybitCsv('', { accountId });
    expect(result.events).toEqual([]);
    expect(result.totalRows).toBe(0);
  });

  it('sorts events ascending by timestamp', () => {
    const csv = [
      'Date & Time(UTC),Coin,QTY,Type,Account Balance,Description',
      '2024-09-01 09:00:00,BTC,1,TRANSFER,1,Deposit',
      '2024-07-01 09:00:00,ETH,2,TRANSFER,2,Deposit',
      '2024-08-01 09:00:00,SOL,3,TRANSFER,3,Deposit',
    ].join('\n');

    const result = parseBybitCsv(csv, { accountId });
    expect(result.events.map((e) => (e.legs[0]?.asset ?? ''))).toEqual([
      'ETH',
      'SOL',
      'BTC',
    ]);
  });

  it('interpolates exec value from filled price × quantity when exec value is missing', () => {
    const csv = [
      'Order ID,Transaction ID,Filled Time,Symbol,Side,Filled Price,Quantity,Exec Value,Fee,Fee Currency',
      // First fill: complete
      'order-interp,fill-a,2024-01-01 10:00:00,BTCUSDT,Buy,30000,0.02,600,0.000015,BTC',
      // Second fill: exec value missing but filled price present → 30100 × 0.03 = 903
      'order-interp,fill-b,2024-01-01 10:00:01,BTCUSDT,Buy,30100,0.03,,0.000023,BTC',
    ].join('\n');

    const result = parseBybitCsv(csv, { accountId });

    expect(result.events).toHaveLength(1);
    const [event] = result.events;
    // base = 0.02 + 0.03 = 0.05; quote = 600 + (30100 × 0.03) = 600 + 903 = 1503
    expect(event?.legs[0]).toMatchObject({ asset: 'BTC', amount: '0.05' });
    expect(event?.legs[1]).toMatchObject({ asset: 'USDT', amount: '-1503' });
    expect(result.warnings).toHaveLength(0);
  });

  it('excludes and warns on a fill that has quantity but no exec value and no filled price', () => {
    const csv = [
      'Order ID,Transaction ID,Filled Time,Symbol,Side,Filled Price,Quantity,Exec Value,Fee,Fee Currency',
      // First fill: complete
      'order-badrow,fill-a,2024-01-01 10:00:00,BTCUSDT,Buy,30000,0.02,600,0.000015,BTC',
      // Second fill: qty present but neither exec value nor filled price → excluded
      'order-badrow,fill-b,2024-01-01 10:00:01,BTCUSDT,Buy,,0.03,,0.000023,BTC',
    ].join('\n');

    const result = parseBybitCsv(csv, { accountId });

    expect(result.events).toHaveLength(1);
    const [event] = result.events;
    // Only the good fill counts: base = 0.02, quote = 600
    expect(event?.legs[0]).toMatchObject({ asset: 'BTC', amount: '0.02' });
    expect(event?.legs[1]).toMatchObject({ asset: 'USDT', amount: '-600' });
    // A warning naming the order should be emitted for the excluded fill
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/order-badrow/);
    expect(result.warnings[0]).toMatch(/fill excluded/);
  });

  it('skips the whole order (not just the fill) when every fill lacks exec value and price', () => {
    const csv = [
      'Order ID,Transaction ID,Filled Time,Symbol,Side,Filled Price,Quantity,Exec Value,Fee,Fee Currency',
      'order-allbad,fill-x,2024-01-01 10:00:00,BTCUSDT,Buy,,0.05,,0,BTC',
    ].join('\n');

    const result = parseBybitCsv(csv, { accountId });

    expect(result.events).toHaveLength(0);
    expect(result.unparsedRowCount).toBe(1);
    // Expects both a fill-level warning and the order-level zero-guard warning
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
    expect(result.warnings.some((w) => w.includes('order-allbad') && w.includes('fill excluded'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('order-allbad') && w.includes('skipped'))).toBe(true);
  });

  it('falls back to peeling the quote off a concatenated symbol', () => {
    const csv = [
      'Order ID,Transaction ID,Filled Time,Symbol,Side,Filled Price,Quantity,Exec Value,Fee,Fee Currency',
      'order-pair,trade-pair,2024-10-01 09:00:00,SOLUSDC,Buy,140,1,140,0.14,USDC',
    ].join('\n');

    const result = parseBybitCsv(csv, { accountId });
    expect(result.events[0]?.legs[0]?.asset).toBe('SOL');
    expect(result.events[0]?.legs[1]?.asset).toBe('USDC');
  });
});

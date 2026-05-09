import { describe, expect, it } from 'vitest';
import { parseRobinhoodCsv } from './csv.js';

const accountId = 'main-robinhood';

describe('parseRobinhoodCsv', () => {
  it('normalizes documented transaction-history style buys, sells, transfers, and rewards', () => {
    const csv = [
      'Transaction Date,Transaction Type,Crypto Symbol,Crypto Amount,Crypto Price,Total,Fee,Fee Currency,Transaction ID',
      '2024-01-02 10:00:00,Buy,BTC,0.01000000,42000,420.00,0,USD,rh-buy-1',
      '2024-02-03 11:00:00,Sell,ETH,0.50000000,3000,1500.00,1.25,USD,rh-sell-1',
      '2024-03-04 12:00:00,Receive,SOL,2.5,,,,,rh-receive-1',
      '2024-04-05 13:00:00,Staking reward,USDC,4.2,,,,,rh-reward-1',
    ].join('\n');

    const result = parseRobinhoodCsv(csv, { accountId });

    expect(result.totalRows).toBe(4);
    expect(result.unparsedRowCount).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.events.map(event => event.id)).toEqual([
      'robinhood:rh-buy-1',
      'robinhood:rh-sell-1',
      'robinhood:rh-receive-1',
      'robinhood:rh-reward-1',
    ]);

    expect(result.events[0]).toMatchObject({
      source: 'robinhood',
      accountId,
      type: 'trade',
      legs: [
        { asset: 'BTC', amount: '0.01' },
        { asset: 'USD', amount: '-420' },
      ],
    });
    expect(result.events[1]).toMatchObject({
      type: 'trade',
      legs: [
        { asset: 'ETH', amount: '-0.5' },
        { asset: 'USD', amount: '1500' },
        { asset: 'USD', amount: '-1.25', feeFlag: true },
      ],
    });
    expect(result.events[2]).toMatchObject({
      type: 'crypto_in',
      legs: [{ asset: 'SOL', amount: '2.5' }],
    });
    expect(result.events[3]).toMatchObject({
      type: 'income',
      legs: [{ asset: 'USDC', amount: '4.2' }],
    });
  });

  it('supports common Robinhood account-activity headers and asset names', () => {
    const csv = [
      'Activity Date,Trans Code,Instrument,Quantity,Price,Amount,Description,Activity ID',
      '2024-05-01T14:30:00Z,Buy,Bitcoin,0.005,60000,$300.00,Market buy,act-1',
      '2024-05-02T14:30:00Z,Sell,Ethereum (ETH),0.25,3200,$800.00,Market sell,act-2',
    ].join('\n');

    const result = parseRobinhoodCsv(csv, { accountId });

    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.legs).toEqual([
      { asset: 'BTC', amount: '0.005' },
      { asset: 'USD', amount: '-300' },
    ]);
    expect(result.events[1]!.legs).toEqual([
      { asset: 'ETH', amount: '-0.25' },
      { asset: 'USD', amount: '800' },
    ]);
  });

  it('derives USD trade amount from quantity and price when total is absent', () => {
    const csv = [
      'Date,Transaction Type,Symbol,Quantity,Price,Order ID',
      '2024-06-01,Buy,DOGE,100,0.12,order-1',
    ].join('\n');

    const result = parseRobinhoodCsv(csv, { accountId });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.legs).toEqual([
      { asset: 'DOGE', amount: '100' },
      { asset: 'USD', amount: '-12' },
    ]);
  });

  it('warns and skips ambiguous rows', () => {
    const csv = [
      'Date,Transaction Type,Amount,Description',
      '2024-06-01,Journal,$12.34,Unsupported activity',
    ].join('\n');

    const result = parseRobinhoodCsv(csv, { accountId });

    expect(result.events).toEqual([]);
    expect(result.unparsedRowCount).toBe(1);
    expect(result.warnings).toEqual([
      'Row 2 skipped: no Robinhood asset movement columns could be parsed',
    ]);
  });

  it('rejects unrecognized headers', () => {
    expect(() => parseRobinhoodCsv('foo,bar\n1,2', { accountId })).toThrow(
      'Robinhood CSV header not recognized',
    );
  });
});

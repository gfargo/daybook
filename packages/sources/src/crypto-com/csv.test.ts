import { describe, expect, it } from 'vitest';
import { parseCryptoComCsv } from './csv.js';

const accountId = 'main-crypto-com';

describe('parseCryptoComCsv', () => {
  it('normalizes Crypto.com App trades, transfers, rewards, and card spends', () => {
    const csv = [
      'Timestamp (UTC),Transaction Description,Currency,Amount,To Currency,To Amount,Native Currency,Native Amount,Native Amount (in USD),Transaction Kind,Transaction Hash',
      '2024-01-02 10:00:00,Buy BTC,BTC,0.01,USD,-420,USD,420,420,crypto_purchase,',
      '2024-02-03 11:00:00,Sell ETH,ETH,-0.5,USD,1500,USD,1500,1500,crypto_sell,',
      '2024-03-04 12:00:00,External Deposit,SOL,2.5,, ,USD,250,250,crypto_deposit,0xdep',
      '2024-04-05 13:00:00,Card Cashback,CRO,4.2,,,USD,1.00,1.00,referral_card_cashback,',
      '2024-05-06 14:00:00,Visa Card Purchase,USD,25,,,USD,25,25,card_purchase,',
    ].join('\n');

    const result = parseCryptoComCsv(csv, { accountId });

    expect(result.totalRows).toBe(5);
    expect(result.unparsedRowCount).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.events[0]).toMatchObject({
      source: 'crypto-com',
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
      ],
    });
    expect(result.events[2]).toMatchObject({
      type: 'crypto_in',
      txHash: '0xdep',
      legs: [{ asset: 'SOL', amount: '2.5' }],
    });
    expect(result.events[3]).toMatchObject({
      type: 'income',
      legs: [{ asset: 'CRO', amount: '4.2' }],
    });
    expect(result.events[4]).toMatchObject({
      type: 'fiat_withdrawal',
      legs: [{ asset: 'USD', amount: '-25' }],
    });
  });

  it('normalizes Crypto.com Exchange trade exports', () => {
    const csv = [
      'Order ID,Trade ID,Time (UTC),Symbol,Side,Trade Price,Trade Amount,Volume of Business,Fee,Fee Currency',
      'order-1,trade-1,2024-01-02 10:00:00,BTC_USDT,BUY,42000,0.01,420,0.42,USDT',
      'order-2,trade-2,2024-02-03 11:00:00,ETH_USDT,SELL,3000,0.5,1500,0.001,ETH',
    ].join('\n');

    const result = parseCryptoComCsv(csv, { accountId });

    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      id: 'crypto-com:trade-1',
      type: 'trade',
      legs: [
        { asset: 'BTC', amount: '0.01' },
        { asset: 'USDT', amount: '-420' },
        { asset: 'USDT', amount: '-0.42', feeFlag: true },
      ],
    });
    expect(result.events[1]).toMatchObject({
      id: 'crypto-com:trade-2',
      type: 'trade',
      legs: [
        { asset: 'ETH', amount: '-0.5' },
        { asset: 'USDT', amount: '1500' },
        { asset: 'ETH', amount: '-0.001', feeFlag: true },
      ],
    });
  });

  it('normalizes DeFi wallet style movement columns', () => {
    const csv = [
      'Date,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency,Label,Description,TxHash',
      '2024-06-01T00:00:00Z,100,USDC,0.05,ETH,0.001,ETH,swap,Swap USDC to ETH,0xswap',
    ].join('\n');

    const result = parseCryptoComCsv(csv, { accountId });

    expect(result.events[0]).toMatchObject({
      id: 'crypto-com:0xswap',
      type: 'trade',
      txHash: '0xswap',
      legs: [
        { asset: 'USDC', amount: '-100' },
        { asset: 'ETH', amount: '0.05' },
        { asset: 'ETH', amount: '-0.001', feeFlag: true },
      ],
    });
  });

  it('warns and skips ambiguous rows', () => {
    const csv = [
      'Timestamp (UTC),Transaction Description,Currency,Amount,Transaction Kind',
      '2024-06-01,Unknown Adjustment,,,unknown',
    ].join('\n');

    const result = parseCryptoComCsv(csv, { accountId });

    expect(result.events).toEqual([]);
    expect(result.unparsedRowCount).toBe(1);
    expect(result.warnings).toEqual([
      'Row 2 skipped: no Crypto.com asset movement columns could be parsed',
    ]);
  });

  it('rejects unrecognized headers', () => {
    expect(() => parseCryptoComCsv('foo,bar\n1,2', { accountId })).toThrow(
      'Crypto.com CSV header not recognized',
    );
  });
});

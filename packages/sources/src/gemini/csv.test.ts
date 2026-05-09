import { describe, expect, it } from 'vitest';
import { parseGeminiCsv } from './csv.js';

const accountId = 'main-gemini';

describe('parseGeminiCsv', () => {
  it('normalizes simple trade-history buys, sells, transfers, rewards, and fees', () => {
    const csv = [
      'Date,Type,Symbol,Quantity,Price,Amount,Fee,Fee Currency,Trade ID,Specification',
      '2024-01-02 10:00:00,Buy,BTCUSD,0.01000000,42000,420.00,1.25,USD,gem-buy-1,Exchange trade',
      '2024-02-03 11:00:00,Sell,ETH/USD,0.50000000,3000,1500.00,2.50,USD,gem-sell-1,Exchange trade',
      '2024-03-04 12:00:00,Credit,SOL,2.5,,,,,gem-deposit-1,Deposit',
      '2024-04-05 13:00:00,Credit,USDC,4.2,,,,,gem-reward-1,Referral Credit',
    ].join('\n');

    const result = parseGeminiCsv(csv, { accountId });

    expect(result.totalRows).toBe(4);
    expect(result.unparsedRowCount).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.events.map(event => event.id)).toEqual([
      'gemini:gem-buy-1',
      'gemini:gem-sell-1',
      'gemini:gem-deposit-1',
      'gemini:gem-reward-1',
    ]);
    expect(result.events[0]).toMatchObject({
      source: 'gemini',
      accountId,
      type: 'trade',
      legs: [
        { asset: 'BTC', amount: '0.01' },
        { asset: 'USD', amount: '-420' },
        { asset: 'USD', amount: '-1.25', feeFlag: true },
      ],
    });
    expect(result.events[1]).toMatchObject({
      type: 'trade',
      legs: [
        { asset: 'ETH', amount: '-0.5' },
        { asset: 'USD', amount: '1500' },
        { asset: 'USD', amount: '-2.5', feeFlag: true },
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

  it('normalizes Gemini transaction-history exports with per-asset amount columns', () => {
    const csv = [
      'Date,Time (UTC),Type,Symbol,Specification,Liquidity Indicator,Trading Fee Rate (bps),BTC Amount BTC,Fee (BTC) BTC,ETH Amount ETH,Fee (ETH) ETH,USD Amount USD,Trade ID,Order ID,Tx Hash',
      '2024-01-02,2024-01-02 10:00:00,Buy,BTCUSD,Exchange trade,Taker,40,0.01,0,,,-420,trade-1,order-1,',
      '2024-02-03,2024-02-03 11:00:00,Sell,BTCUSD,Exchange trade,Maker,20,-0.005,0.00001,,,250,trade-2,order-2,',
      '2024-03-04,2024-03-04 12:00:00,Withdrawal,ETH,On-chain withdrawal,,,,,-0.25,0.001,, , ,0xabc',
    ].join('\n');

    const result = parseGeminiCsv(csv, { accountId });

    expect(result.events).toHaveLength(3);
    expect(result.events[0]).toMatchObject({
      id: 'gemini:trade-1',
      type: 'trade',
      legs: [
        { asset: 'BTC', amount: '0.01' },
        { asset: 'USD', amount: '-420' },
      ],
    });
    expect(result.events[1]).toMatchObject({
      id: 'gemini:trade-2',
      type: 'trade',
      legs: [
        { asset: 'BTC', amount: '-0.005' },
        { asset: 'BTC', amount: '-0.00001', feeFlag: true },
        { asset: 'USD', amount: '250' },
      ],
    });
    expect(result.events[2]).toMatchObject({
      type: 'crypto_out',
      txHash: '0xabc',
      legs: [
        { asset: 'ETH', amount: '-0.25' },
        { asset: 'ETH', amount: '-0.001', feeFlag: true },
      ],
    });
  });

  it('derives quote amount from quantity and price when total is absent', () => {
    const csv = [
      'Date,Type,Symbol,Quantity,Price,Trade ID',
      '2024-06-01,Buy,DOGEUSD,100,0.12,trade-1',
    ].join('\n');

    const result = parseGeminiCsv(csv, { accountId });

    expect(result.events[0]!.legs).toEqual([
      { asset: 'DOGE', amount: '100' },
      { asset: 'USD', amount: '-12' },
    ]);
  });

  it('warns and skips ambiguous rows', () => {
    const csv = [
      'Date,Type,Symbol,Quantity,Specification',
      '2024-06-01,Adjustment,,,Unsupported row',
    ].join('\n');

    const result = parseGeminiCsv(csv, { accountId });

    expect(result.events).toEqual([]);
    expect(result.unparsedRowCount).toBe(1);
    expect(result.warnings).toEqual([
      'Row 2 skipped: no Gemini asset movement columns could be parsed',
    ]);
  });

  it('rejects unrecognized headers', () => {
    expect(() => parseGeminiCsv('foo,bar\n1,2', { accountId })).toThrow(
      'Gemini CSV header not recognized',
    );
  });
});

/**
 * Tests for parseCoinbaseRow against representative real rows.
 *
 * Fixtures use real values from the user's "All Transactions" export.
 * Wallet addresses are kept verbatim — they're public on chain.
 */

import { describe, expect, it } from 'vitest';
import {
  type CoinbaseCsvRow,
  parseCoinbaseRow,
  parseDollarString,
  parseTimestamp,
  negate,
} from './row.js';

const accountId = 'main-coinbase';
const opt = { accountId };

function row(partial: Partial<CoinbaseCsvRow>): CoinbaseCsvRow {
  return {
    id: 'fixture',
    timestamp: '2024-01-15 18:41:54 UTC',
    transactionType: 'Buy',
    asset: 'BTC',
    quantityTransacted: '0.00152134',
    priceCurrency: 'USD',
    priceAtTransaction: '$95822.58',
    subtotal: '$145.77872',
    total: '$150.00',
    feesAndSpread: '$4.2212761428',
    notes: 'Bought 0.00152134 BTC for 150 USD',
    ...partial,
  };
}

describe('parseCoinbaseRow — Buy', () => {
  it('produces a trade event with crypto-in, fiat-out, and fee legs', () => {
    const { event } = parseCoinbaseRow(row({}), opt);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('trade');
    expect(event!.legs).toHaveLength(3);

    // Crypto leg
    expect(event!.legs[0]!.asset).toBe('BTC');
    expect(event!.legs[0]!.amount).toBe('0.00152134');
    // Fiat leg
    expect(event!.legs[1]!.asset).toBe('USD');
    expect(event!.legs[1]!.amount).toBe('-150.00');
    // Fee leg
    expect(event!.legs[2]!.feeFlag).toBe(true);
    expect(event!.legs[2]!.amount).toBe('-4.2212761428');
  });
});

describe('parseCoinbaseRow — Convert', () => {
  it('extracts the second leg from Notes', () => {
    const { event } = parseCoinbaseRow(
      row({
        id: '67dad6ee7afc329efa601671',
        timestamp: '2025-03-19 14:38:38 UTC',
        transactionType: 'Convert',
        asset: 'USDC',
        quantityTransacted: '-10.683547',
        subtotal: '$10.54058',
        total: '$9.56389',
        feesAndSpread: '-$0.9766945326',
        notes: 'Converted 10.683547 USDC to 0.00011398 BTC',
      }),
      opt,
    );
    expect(event).not.toBeNull();
    expect(event!.type).toBe('trade');
    expect(event!.legs[0]!.asset).toBe('USDC');
    expect(event!.legs[0]!.amount).toBe('-10.683547');
    expect(event!.legs[1]!.asset).toBe('BTC');
    expect(event!.legs[1]!.amount).toBe('0.00011398');
  });
});

describe('parseCoinbaseRow — Send', () => {
  it('captures destination address as counterparty', () => {
    const { event } = parseCoinbaseRow(
      row({
        id: '6466dcb515ef8ea9864fecee',
        timestamp: '2023-05-19 02:19:33 UTC',
        transactionType: 'Send',
        asset: 'ETH',
        quantityTransacted: '-0.16362219',
        subtotal: '-$294.57721',
        total: '-$294.57721',
        feesAndSpread: '$0.00',
        notes:
          'Sent 0.16362219 ETH to 0xdB684E473929b2548460FA83f71516c5283bf283 (to 0xdB6...bf283)',
      }),
      opt,
    );
    expect(event!.type).toBe('crypto_out');
    expect(event!.counterparty).toBe(
      '0xdB684E473929b2548460FA83f71516c5283bf283',
    );
    expect(event!.legs).toHaveLength(1);
    expect(event!.legs[0]!.amount).toBe('-0.16362219');
  });
});

describe('parseCoinbaseRow — Staking Income', () => {
  it('emits a single positive-amount income event', () => {
    const { event } = parseCoinbaseRow(
      row({
        id: '697e2dad55bf2ddabd0ca8df',
        timestamp: '2026-01-31 16:28:29 UTC',
        transactionType: 'Staking Income',
        asset: 'ETH',
        quantityTransacted: '0.000017431113',
        priceAtTransaction: '$2521.605',
        subtotal: '$0.04395',
        total: '$0.04395',
        feesAndSpread: '$0.00',
        notes: '',
      }),
      opt,
    );
    expect(event!.type).toBe('income');
    expect(event!.legs).toHaveLength(1);
    expect(event!.legs[0]!.amount).toBe('0.000017431113');
    expect(event!.legs[0]!.amountUsdReportedBySource).toBe('0.04395');
  });
});

describe('parseCoinbaseRow — Retail Eth2 Deprecation', () => {
  it('flags the row as needsPairing and emits a single-leg event', () => {
    const result = parseCoinbaseRow(
      row({
        transactionType: 'Retail Eth2 Deprecation',
        asset: 'ETH2',
        quantityTransacted: '-0.395938385868',
        subtotal: '-$1338.28362',
        total: '-$1338.28362',
        notes: '',
      }),
      opt,
    );
    expect(result.needsPairing).toBe(true);
    expect(result.event!.type).toBe('internal_move');
    expect(result.event!.legs).toHaveLength(1);
  });
});

describe('parseCoinbaseRow — Withdrawal', () => {
  it('captures bank info as counterparty', () => {
    const { event } = parseCoinbaseRow(
      row({
        transactionType: 'Withdrawal',
        asset: 'USD',
        quantityTransacted: '-1391.7',
        notes: 'Withdrawal to Community Bank, N.A./ ... *******9407',
      }),
      opt,
    );
    expect(event!.type).toBe('fiat_withdrawal');
    expect(event!.counterparty).toBe('Community Bank, N.A.');
  });
});

describe('parseCoinbaseRow — unknown type', () => {
  it('emits an `unknown` event and a warning', () => {
    const result = parseCoinbaseRow(
      row({ transactionType: 'Some Future Type' as any }),
      opt,
    );
    expect(result.event!.type).toBe('unknown');
    expect(result.warning).toContain('Unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────────────

describe('parseDollarString', () => {
  it.each([
    ['$2521.605', '2521.605'],
    ['-$10.54058', '-10.54058'],
    ['$0.00', '0.00'],
    ['', null],
    ['junk', null],
  ])('parses %s → %s', (input, expected) => {
    expect(parseDollarString(input)).toBe(expected);
  });
});

describe('negate', () => {
  it.each([
    ['1.5', '-1.5'],
    ['-1.5', '1.5'],
    ['0', '0'],
    ['', '0'],
  ])('%s → %s', (input, expected) => {
    expect(negate(input)).toBe(expected);
  });
});

describe('parseTimestamp', () => {
  it('parses Coinbase UTC format', () => {
    const d = parseTimestamp('2026-01-31 16:28:29 UTC');
    expect(d.toISOString()).toBe('2026-01-31T16:28:29.000Z');
  });

  it('throws on garbage', () => {
    expect(() => parseTimestamp('not-a-date')).toThrow();
  });
});

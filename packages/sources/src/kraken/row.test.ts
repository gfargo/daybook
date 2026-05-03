/**
 * Tests for the Kraken CSV adapter.
 *
 * Covers row-level builders (row.ts) and file-level parsing (csv.ts).
 * Fixtures use realistic values matching Kraken "Export Ledger" format.
 */

import { describe, expect, it } from 'vitest';
import {
    normalizeKrakenAsset,
    parseKrakenTimestamp,
    buildTradeEvent,
    buildDepositEvent,
    buildWithdrawalEvent,
    buildStakingEvent,
    buildUnknownEvent,
    type KrakenRow,
} from './row.js';
import { parseKrakenCsv } from './csv.js';

const accountId = 'main-kraken';
const opts = { accountId };

// ─────────────────────────────────────────────────────────────────────────
// Helper to build a KrakenRow fixture
// ─────────────────────────────────────────────────────────────────────────

function row(partial: Partial<KrakenRow>): KrakenRow {
  return {
    txid: 'L0001',
    refid: 'R0001',
    time: '2024-06-15 14:30:00',
    type: 'trade',
    subtype: '',
    aclass: 'currency',
    asset: 'XXBT',
    amount: '-0.05000000',
    fee: '0.0000000000',
    balance: '1.95000000',
    ...partial,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Asset normalization
// ─────────────────────────────────────────────────────────────────────────

describe('normalizeKrakenAsset', () => {
  it.each([
    ['XXBT', 'BTC'],
    ['XBT', 'BTC'],
    ['XETH', 'ETH'],
    ['ZUSD', 'USD'],
    ['ZEUR', 'EUR'],
    ['XLTC', 'LTC'],
    ['XXRP', 'XRP'],
    ['ETH2', 'ETH'],
    ['ETH2.S', 'ETH'],
    ['DOT', 'DOT'],       // passthrough — already standard
    ['SOL', 'SOL'],       // passthrough
  ])('%s → %s', (input, expected) => {
    expect(normalizeKrakenAsset(input)).toBe(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// parseKrakenTimestamp
// ─────────────────────────────────────────────────────────────────────────

describe('parseKrakenTimestamp', () => {
  it('parses Kraken UTC format', () => {
    const d = parseKrakenTimestamp('2024-06-15 14:30:00');
    expect(d.toISOString()).toBe('2024-06-15T14:30:00.000Z');
  });

  it('throws on garbage', () => {
    expect(() => parseKrakenTimestamp('not-a-date')).toThrow('Unparsable Kraken timestamp');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Trade pair → one trade event with two legs
// ─────────────────────────────────────────────────────────────────────────

describe('buildTradeEvent', () => {
  it('produces a trade event with two legs (one negative, one positive)', () => {
    const sellSide = row({
      txid: 'L0001',
      refid: 'TRADE-001',
      asset: 'XXBT',
      amount: '-0.05000000',
      fee: '0.0000000000',
    });
    const buySide = row({
      txid: 'L0002',
      refid: 'TRADE-001',
      asset: 'ZUSD',
      amount: '3250.00000000',
      fee: '8.45000000',
    });

    const event = buildTradeEvent('TRADE-001', [sellSide, buySide], opts);

    expect(event.id).toBe('kraken:TRADE-001');
    expect(event.type).toBe('trade');
    expect(event.source).toBe('kraken');
    expect(event.accountId).toBe(accountId);

    // Two principal legs
    expect(event.legs[0]!.asset).toBe('BTC');
    expect(event.legs[0]!.amount).toBe('-0.05000000');
    expect(event.legs[1]!.asset).toBe('USD');
    expect(event.legs[1]!.amount).toBe('3250.00000000');

    // Fee leg from the buy side (sell side fee is zero)
    const feeLegs = event.legs.filter(l => l.feeFlag === true);
    expect(feeLegs).toHaveLength(1);
    expect(feeLegs[0]!.asset).toBe('USD');
    expect(feeLegs[0]!.amount).toBe('-8.45000000');
  });

  it('includes fee legs from both sides when both have non-zero fees', () => {
    const a = row({ txid: 'L1', refid: 'R1', asset: 'XETH', amount: '-1.0', fee: '0.001' });
    const b = row({ txid: 'L2', refid: 'R1', asset: 'ZUSD', amount: '2500.0', fee: '6.50' });

    const event = buildTradeEvent('R1', [a, b], opts);
    const feeLegs = event.legs.filter(l => l.feeFlag === true);
    expect(feeLegs).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Deposit → crypto_in positive leg
// ─────────────────────────────────────────────────────────────────────────

describe('buildDepositEvent', () => {
  it('produces a crypto_in event with a positive leg', () => {
    const event = buildDepositEvent(
      row({
        txid: 'DEP-001',
        type: 'deposit',
        asset: 'XETH',
        amount: '2.50000000',
        fee: '0.0000000000',
      }),
      opts,
    );

    expect(event.id).toBe('kraken:DEP-001');
    expect(event.type).toBe('crypto_in');
    expect(event.legs).toHaveLength(1);
    expect(event.legs[0]!.asset).toBe('ETH');
    expect(event.legs[0]!.amount).toBe('2.50000000');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Withdrawal → crypto_out negative leg
// ─────────────────────────────────────────────────────────────────────────

describe('buildWithdrawalEvent', () => {
  it('produces a crypto_out event with a negative leg', () => {
    const event = buildWithdrawalEvent(
      row({
        txid: 'WD-001',
        type: 'withdrawal',
        asset: 'XXBT',
        amount: '-0.10000000',
        fee: '0.00050000',
      }),
      opts,
    );

    expect(event.id).toBe('kraken:WD-001');
    expect(event.type).toBe('crypto_out');
    expect(event.legs).toHaveLength(2); // principal + fee
    expect(event.legs[0]!.asset).toBe('BTC');
    expect(event.legs[0]!.amount).toBe('-0.10000000');
    // Fee leg
    expect(event.legs[1]!.feeFlag).toBe(true);
    expect(event.legs[1]!.amount).toBe('-0.00050000');
    expect(event.legs[1]!.asset).toBe('BTC');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Staking → income positive leg
// ─────────────────────────────────────────────────────────────────────────

describe('buildStakingEvent', () => {
  it('produces an income event with a positive leg', () => {
    const event = buildStakingEvent(
      row({
        txid: 'STK-001',
        type: 'staking',
        subtype: 'stakingfromspot',
        asset: 'DOT',
        amount: '1.23456789',
        fee: '0.0000000000',
      }),
      opts,
    );

    expect(event.id).toBe('kraken:STK-001');
    expect(event.type).toBe('income');
    expect(event.legs).toHaveLength(1);
    expect(event.legs[0]!.asset).toBe('DOT');
    expect(event.legs[0]!.amount).toBe('1.23456789');
    expect(event.notes).toBe('stakingfromspot');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Non-zero fee → fee leg with feeFlag: true
// ─────────────────────────────────────────────────────────────────────────

describe('fee handling', () => {
  it('appends a fee leg when fee is non-zero', () => {
    const event = buildDepositEvent(
      row({
        txid: 'DEP-FEE',
        type: 'deposit',
        asset: 'XETH',
        amount: '5.0',
        fee: '0.01',
      }),
      opts,
    );

    expect(event.legs).toHaveLength(2);
    expect(event.legs[1]!.feeFlag).toBe(true);
    expect(event.legs[1]!.amount).toBe('-0.01');
    expect(event.legs[1]!.asset).toBe('ETH');
  });

  it('omits fee leg when fee is zero', () => {
    const event = buildDepositEvent(
      row({
        txid: 'DEP-NOFEE',
        type: 'deposit',
        asset: 'XETH',
        amount: '5.0',
        fee: '0.0000000000',
      }),
      opts,
    );

    expect(event.legs).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Unknown type
// ─────────────────────────────────────────────────────────────────────────

describe('buildUnknownEvent', () => {
  it('produces an unknown event with a descriptive note', () => {
    const event = buildUnknownEvent(
      row({ txid: 'UNK-001', type: 'margin' }),
      opts,
    );

    expect(event.id).toBe('kraken:UNK-001');
    expect(event.type).toBe('unknown');
    expect(event.notes).toContain('margin');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// File-level CSV parsing
// ─────────────────────────────────────────────────────────────────────────

const SAMPLE_CSV = `"txid","refid","time","type","subtype","aclass","asset","amount","fee","balance"
"L001","TRADE-A","2024-03-10 12:00:00","trade","","currency","XXBT","-0.10000000","0.0000000000","0.90000000"
"L002","TRADE-A","2024-03-10 12:00:00","trade","","currency","ZUSD","6500.00000000","16.90000000","6500.00000000"
"L003","DEP-B","2024-03-11 09:00:00","deposit","","currency","XETH","5.00000000","0.0000000000","5.00000000"
"L004","WD-C","2024-03-12 15:30:00","withdrawal","","currency","XXBT","-0.05000000","0.00010000","0.85000000"
"L005","STK-D","2024-03-13 00:00:00","staking","stakingfromspot","currency","DOT","2.50000000","0.0000000000","102.50000000"
`;

describe('parseKrakenCsv', () => {
  it('parses a complete CSV with mixed event types', () => {
    const result = parseKrakenCsv(SAMPLE_CSV, { accountId });

    expect(result.totalRows).toBe(5);
    // 1 trade (paired) + 1 deposit + 1 withdrawal + 1 staking = 4 events
    expect(result.events).toHaveLength(4);
    expect(result.warnings).toHaveLength(0);

    const types = result.events.map(e => e.type);
    expect(types).toContain('trade');
    expect(types).toContain('crypto_in');
    expect(types).toContain('crypto_out');
    expect(types).toContain('income');
  });

  it('events are sorted by timestamp ascending', () => {
    const result = parseKrakenCsv(SAMPLE_CSV, { accountId });
    for (let i = 1; i < result.events.length; i++) {
      expect(result.events[i]!.timestamp.getTime())
        .toBeGreaterThanOrEqual(result.events[i - 1]!.timestamp.getTime());
    }
  });

  it('emits a warning for unpaired trade rows', () => {
    const csv = `"txid","refid","time","type","subtype","aclass","asset","amount","fee","balance"
"L010","ORPHAN-REF","2024-04-01 10:00:00","trade","","currency","XXBT","-0.01","0.0000000000","0.99"
`;
    const result = parseKrakenCsv(csv, { accountId });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('ORPHAN-REF');
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.type).toBe('unknown');
  });

  it('emits a warning for unknown row types', () => {
    const csv = `"txid","refid","time","type","subtype","aclass","asset","amount","fee","balance"
"L020","REF-X","2024-04-02 10:00:00","margin","","currency","XXBT","0.5","0.0","1.5"
`;
    const result = parseKrakenCsv(csv, { accountId });

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.events[0]!.type).toBe('unknown');
  });

  it('handles staking via subtype stakingfromspot on a transfer row', () => {
    const csv = `"txid","refid","time","type","subtype","aclass","asset","amount","fee","balance"
"L030","REF-S","2024-04-03 10:00:00","transfer","stakingfromspot","currency","DOT","1.0","0.0","10.0"
`;
    const result = parseKrakenCsv(csv, { accountId });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.type).toBe('income');
  });

  it('strips preamble rows before the header', () => {
    const csvWithPreamble = `Some preamble line
Another preamble
"txid","refid","time","type","subtype","aclass","asset","amount","fee","balance"
"L040","DEP-P","2024-05-01 08:00:00","deposit","","currency","XETH","1.0","0.0","1.0"
`;
    const result = parseKrakenCsv(csvWithPreamble, { accountId });

    expect(result.totalRows).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.type).toBe('crypto_in');
  });

  it('throws when no header is found', () => {
    expect(() => parseKrakenCsv('no,valid,header\n1,2,3', { accountId }))
      .toThrow('Kraken CSV header not found');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Idempotency — same CSV parsed twice → identical RawEvent IDs
// ─────────────────────────────────────────────────────────────────────────

describe('idempotency', () => {
  it('produces identical event IDs when the same CSV is parsed twice', () => {
    const first = parseKrakenCsv(SAMPLE_CSV, { accountId });
    const second = parseKrakenCsv(SAMPLE_CSV, { accountId });

    expect(first.events.map(e => e.id)).toEqual(second.events.map(e => e.id));
  });

  it('produces identical event timestamps when parsed twice', () => {
    const first = parseKrakenCsv(SAMPLE_CSV, { accountId });
    const second = parseKrakenCsv(SAMPLE_CSV, { accountId });

    expect(first.events.map(e => e.timestamp.toISOString()))
      .toEqual(second.events.map(e => e.timestamp.toISOString()));
  });
});

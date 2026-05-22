/**
 * Unit tests for the 1099-DA reconciliation module.
 *
 * Covers:
 *   - parse1099DaCsv: column-alias resolution, value cleaning, year inference
 *   - reconcile: matching, discrepancy detection, missing-on-either-side
 *   - recommendCheckbox: A / B / C selection heuristic
 *   - formatReconciliationReport: text rendering
 */

import { describe, expect, it } from 'vitest';
import {
  parse1099DaCsv,
  reconcile,
  recommendCheckbox,
  formatReconciliationReport,
} from './reconcile.js';
import type { Form1099DaTransaction } from './reconcile.js';
import type { DisposalResult } from './types.js';

// ─── Test helpers ────────────────────────────────────────────────────────

function makeDisposal(overrides: Partial<DisposalResult> = {}): DisposalResult {
  return {
    asset: 'ETH',
    amount: '1.5',
    proceeds: '3000.00',
    costBasis: '2000.00',
    gainLoss: '1000.00',
    term: 'short-term',
    acquiredAt: new Date(Date.UTC(2025, 0, 15)),
    disposedAt: new Date(Date.UTC(2025, 6, 20)),
    sourceEntryId: 'entry-1',
    lotsConsumed: [{ lotId: 'lot-1', amount: '1.5', costBasis: '2000.00' }],
    washSaleFlag: false,
    ...overrides,
  };
}

function makeReportedTx(
  overrides: Partial<Form1099DaTransaction> = {},
): Form1099DaTransaction {
  return {
    dateAcquired: new Date(Date.UTC(2025, 0, 15)),
    dateSold: new Date(Date.UTC(2025, 6, 20)),
    description: '1.5 ETH',
    asset: 'ETH',
    amount: '1.5',
    proceeds: '3000.00',
    costBasis: '2000.00',
    washSaleDisallowed: '',
    term: 'short-term',
    sourceRow: 2,
    ...overrides,
  };
}

// ─── parse1099DaCsv ──────────────────────────────────────────────────────

describe('parse1099DaCsv', () => {
  it('parses an IRS box-number-style CSV', () => {
    const csv = `1a,1b,1c,1d,1e,1f,1g
01/15/2025,07/20/2025,1.5 ETH,3000.00,2000.00,0,Short-term
03/01/2024,08/05/2025,0.05 BTC,5000.00,4500.00,0,Long-term`;

    const result = parse1099DaCsv(csv);

    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]).toMatchObject({
      asset: 'ETH',
      amount: '1.5',
      proceeds: '3000',
      costBasis: '2000',
      term: 'short-term',
    });
    expect(result.transactions[1]).toMatchObject({
      asset: 'BTC',
      amount: '0.05',
      term: 'long-term',
    });
    expect(result.year).toBe(2025);
  });

  it('parses a human-readable CSV with USD dollar signs and commas', () => {
    const csv = `Date Acquired,Date Sold,Description,Proceeds,Cost Basis,Term
2025-01-15,2025-07-20,1.5 ETH,"$3,000.00","$2,000.00",Short
2024-03-01,2025-08-05,0.05 Bitcoin (BTC),"$5,000.00",,Long`;

    const result = parse1099DaCsv(csv);

    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]?.proceeds).toBe('3000');
    expect(result.transactions[0]?.costBasis).toBe('2000');
    // Empty cost basis stays as empty string
    expect(result.transactions[1]?.costBasis).toBe('');
    expect(result.transactions[1]?.asset).toBe('BTC');
  });

  it('skips rows missing critical fields and reports warnings', () => {
    const csv = `Date Sold,Description,Proceeds
2025-07-20,1.5 ETH,3000
,1.5 ETH,3000
2025-07-21,,3000
2025-07-22,1.5 ETH,`;

    const result = parse1099DaCsv(csv);

    expect(result.transactions).toHaveLength(1);
    expect(result.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it('infers the tax year from the most common dateSold year', () => {
    const csv = `Date Sold,Description,Proceeds
2024-12-31,1 ETH,3000
2025-01-02,1 ETH,3000
2025-07-04,1 ETH,3000`;

    const result = parse1099DaCsv(csv);
    expect(result.year).toBe(2025);
  });

  it('honors an explicit year option', () => {
    const csv = `Date Sold,Description,Proceeds
2025-01-02,1 ETH,3000`;

    const result = parse1099DaCsv(csv, { year: 2024 });
    expect(result.year).toBe(2024);
  });

  it('uses parenthesized tickers in descriptions', () => {
    const csv = `Date Sold,Description,Amount,Proceeds
2025-07-20,Ethereum (ETH),1.5,3000`;

    const result = parse1099DaCsv(csv);
    expect(result.transactions[0]?.asset).toBe('ETH');
  });
});

// ─── reconcile ───────────────────────────────────────────────────────────

describe('reconcile', () => {
  it('matches identical disposal and reported transaction', () => {
    const disposal = makeDisposal();
    const tx = makeReportedTx();

    const report = reconcile([disposal], {
      year: 2025,
      issuer: 'Test',
      transactions: [tx],
      warnings: [],
    });

    expect(report.matched).toHaveLength(1);
    expect(report.mismatched).toHaveLength(0);
    expect(report.missingIn1099Da).toHaveLength(0);
    expect(report.missingInDaybook).toHaveLength(0);
    expect(report.recommendedCheckbox).toBe('A');
  });

  it('flags proceeds discrepancy above tolerance', () => {
    const disposal = makeDisposal({ proceeds: '3000.00' });
    const tx = makeReportedTx({ proceeds: '2950.00' });

    const report = reconcile([disposal], {
      year: 2025,
      issuer: 'Test',
      transactions: [tx],
      warnings: [],
    });

    expect(report.mismatched).toHaveLength(1);
    expect(report.mismatched[0]?.discrepancies[0]?.field).toBe('proceeds');
    expect(report.recommendedCheckbox).toBe('B');
  });

  it('does not flag proceeds difference below tolerance', () => {
    const disposal = makeDisposal({ proceeds: '3000.00' });
    const tx = makeReportedTx({ proceeds: '3000.005' });

    const report = reconcile([disposal], {
      year: 2025,
      issuer: 'Test',
      transactions: [tx],
      warnings: [],
    });

    expect(report.matched).toHaveLength(1);
    expect(report.mismatched).toHaveLength(0);
  });

  it('does not flag missing cost basis on 1099-DA', () => {
    const disposal = makeDisposal({ costBasis: '2000.00' });
    const tx = makeReportedTx({ costBasis: '' });

    const report = reconcile([disposal], {
      year: 2025,
      issuer: 'Test',
      transactions: [tx],
      warnings: [],
    });

    expect(report.matched).toHaveLength(1);
    expect(report.mismatched).toHaveLength(0);
    // basis missing → checkbox B (corrections / unreported basis)
    expect(report.recommendedCheckbox).toBe('B');
  });

  it('flags term mismatch when 1099-DA reports a different term', () => {
    const disposal = makeDisposal({ term: 'short-term' });
    const tx = makeReportedTx({ term: 'long-term' });

    const report = reconcile([disposal], {
      year: 2025,
      issuer: 'Test',
      transactions: [tx],
      warnings: [],
    });

    expect(report.mismatched).toHaveLength(1);
    expect(report.mismatched[0]?.discrepancies.some((d) => d.field === 'term')).toBe(true);
  });

  it('does not flag term when 1099-DA term is unknown', () => {
    const disposal = makeDisposal({ term: 'short-term' });
    const tx = makeReportedTx({ term: 'unknown' });

    const report = reconcile([disposal], {
      year: 2025,
      issuer: 'Test',
      transactions: [tx],
      warnings: [],
    });

    expect(report.matched).toHaveLength(1);
  });

  it('surfaces daybook disposals not on the 1099-DA', () => {
    const d1 = makeDisposal({ asset: 'ETH', amount: '1.5', sourceEntryId: 'a' });
    const d2 = makeDisposal({ asset: 'SOL', amount: '10', sourceEntryId: 'b' });

    const report = reconcile([d1, d2], {
      year: 2025,
      issuer: 'Test',
      transactions: [makeReportedTx({ asset: 'ETH', amount: '1.5' })],
      warnings: [],
    });

    expect(report.matched).toHaveLength(1);
    expect(report.missingIn1099Da).toHaveLength(1);
    expect(report.missingIn1099Da[0]?.asset).toBe('SOL');
  });

  it('surfaces 1099-DA rows not in daybook', () => {
    const report = reconcile([makeDisposal({ asset: 'ETH', amount: '1.5' })], {
      year: 2025,
      issuer: 'Test',
      transactions: [
        makeReportedTx({ asset: 'ETH', amount: '1.5' }),
        makeReportedTx({ asset: 'BTC', amount: '0.1', sourceRow: 3 }),
      ],
      warnings: [],
    });

    expect(report.matched).toHaveLength(1);
    expect(report.missingInDaybook).toHaveLength(1);
    expect(report.missingInDaybook[0]?.asset).toBe('BTC');
  });

  it('accepts a 1-day date drift by default', () => {
    const disposal = makeDisposal({
      disposedAt: new Date(Date.UTC(2025, 6, 20, 23, 59)),
    });
    const tx = makeReportedTx({
      dateSold: new Date(Date.UTC(2025, 6, 21, 0, 1)),
    });

    const report = reconcile([disposal], {
      year: 2025,
      issuer: 'Test',
      transactions: [tx],
      warnings: [],
    });

    expect(report.matched).toHaveLength(1);
  });

  it('does not match rows for the same asset on very different dates', () => {
    const disposal = makeDisposal({ disposedAt: new Date(Date.UTC(2025, 0, 1)) });
    const tx = makeReportedTx({ dateSold: new Date(Date.UTC(2025, 11, 31)) });

    const report = reconcile([disposal], {
      year: 2025,
      issuer: 'Test',
      transactions: [tx],
      warnings: [],
    });

    expect(report.matched).toHaveLength(0);
    expect(report.mismatched).toHaveLength(0);
    expect(report.missingIn1099Da).toHaveLength(1);
    expect(report.missingInDaybook).toHaveLength(1);
  });

  it('matches each 1099-DA row to at most one disposal', () => {
    const d1 = makeDisposal({ amount: '1.5', sourceEntryId: 'a' });
    const d2 = makeDisposal({ amount: '1.5', sourceEntryId: 'b' });
    const tx = makeReportedTx({ amount: '1.5' });

    const report = reconcile([d1, d2], {
      year: 2025,
      issuer: 'Test',
      transactions: [tx],
      warnings: [],
    });

    expect(report.matched).toHaveLength(1);
    expect(report.missingIn1099Da).toHaveLength(1);
  });
});

// ─── recommendCheckbox ──────────────────────────────────────────────────

describe('recommendCheckbox', () => {
  it('returns A when all matched and basis reported', () => {
    const m = {
      matched: [
        {
          disposal: makeDisposal(),
          reported: makeReportedTx({ costBasis: '2000.00' }),
          discrepancies: [],
        },
      ],
      mismatched: [],
      missingIn1099Da: [],
      missingInDaybook: [],
    };
    expect(recommendCheckbox(m).checkbox).toBe('A');
  });

  it('returns B when mismatches present', () => {
    const m = {
      matched: [],
      mismatched: [
        {
          disposal: makeDisposal(),
          reported: makeReportedTx(),
          discrepancies: [
            { field: 'proceeds' as const, daybook: '3000', reported: '2950', delta: '50' },
          ],
        },
      ],
      missingIn1099Da: [],
      missingInDaybook: [],
    };
    expect(recommendCheckbox(m).checkbox).toBe('B');
  });

  it('returns C when most disposals are not on the 1099-DA', () => {
    const m = {
      matched: [],
      mismatched: [],
      missingIn1099Da: [makeDisposal(), makeDisposal(), makeDisposal()],
      missingInDaybook: [],
    };
    expect(recommendCheckbox(m).checkbox).toBe('C');
  });

  it('returns C when nothing to reconcile', () => {
    const m = {
      matched: [],
      mismatched: [],
      missingIn1099Da: [],
      missingInDaybook: [],
    };
    expect(recommendCheckbox(m).checkbox).toBe('C');
  });
});

// ─── formatReconciliationReport ─────────────────────────────────────────

describe('formatReconciliationReport', () => {
  it('renders a summary with counts and recommended checkbox', () => {
    const disposal = makeDisposal();
    const tx = makeReportedTx();
    const report = reconcile([disposal], {
      year: 2025,
      issuer: 'Coinbase',
      transactions: [tx],
      warnings: [],
    });

    const text = formatReconciliationReport(report);
    expect(text).toContain('1099-DA reconciliation — 2025');
    expect(text).toContain('Coinbase');
    expect(text).toContain('Matched:             1');
    expect(text).toContain('Recommended Form 8949 checkbox: A');
  });

  it('renders mismatch details', () => {
    const disposal = makeDisposal({ proceeds: '3000.00' });
    const tx = makeReportedTx({ proceeds: '2950.00' });
    const report = reconcile([disposal], {
      year: 2025,
      issuer: '',
      transactions: [tx],
      warnings: [],
    });

    const text = formatReconciliationReport(report);
    expect(text).toContain('Mismatches:');
    expect(text).toContain('proceeds');
    expect(text).toContain('daybook=3000');
    expect(text).toContain('reported=2950');
  });
});

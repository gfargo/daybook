/**
 * End-to-end integration test for the daybook pipeline.
 *
 * Verifies the full workflow: insert synthetic RawEvents → classify →
 * compute tax → export CSV. Uses an in-memory SQLite database for
 * isolation.
 *
 * **Validates: Requirements 31.1, 31.2**
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { RawEvent, LedgerEntry } from '@daybook/ledger';
import { openDatabase, createRepo, type DatabaseHandle, type Repo } from '@daybook/ledger';
import { classify, DEFAULT_RULES, type ClassifierContext } from '@daybook/classifier';
import { computeTax, formatCsv, FIFO } from '@daybook/tax';

// ─────────────────────────────────────────────────────────────────────────
// Test setup
// ─────────────────────────────────────────────────────────────────────────

let dbHandle: DatabaseHandle;
let repo: Repo;

beforeEach(() => {
  dbHandle = openDatabase(':memory:');
  repo = createRepo(dbHandle.raw);

  // Register a test account
  repo.upsertAccount({
    id: 'test-coinbase',
    source: 'coinbase',
    identifier: 'test@example.com',
    label: 'Test Coinbase',
  });
});

afterEach(() => {
  dbHandle.close();
});

// ─────────────────────────────────────────────────────────────────────────
// Synthetic RawEvent fixtures
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build a realistic set of Coinbase-style RawEvents:
 *
 * 1. Buy 1 ETH for $2,000 USD (trade)
 * 2. Receive 0.01 ETH staking reward at $20 (income)
 * 3. Sell 0.5 ETH for $1,500 USD (trade)
 */
function syntheticEvents(): RawEvent[] {
  return [
    // Event 1: Buy 1 ETH for $2,000
    {
      id: 'coinbase:buy-eth-001',
      source: 'coinbase',
      accountId: 'test-coinbase',
      timestamp: new Date('2024-01-15T10:00:00Z'),
      type: 'trade',
      legs: [
        { asset: 'ETH', amount: '1', amountUsdReportedBySource: '2000' },
        { asset: 'USD', amount: '-2000', amountUsdReportedBySource: '2000' },
      ],
      notes: 'Bought 1 ETH for $2,000',
      raw: { fixture: 'buy-eth' },
    },
    // Event 2: Staking income — 0.01 ETH at $20
    {
      id: 'coinbase:staking-001',
      source: 'coinbase',
      accountId: 'test-coinbase',
      timestamp: new Date('2024-03-01T08:00:00Z'),
      type: 'income',
      legs: [
        { asset: 'ETH', amount: '0.01', amountUsdReportedBySource: '20' },
      ],
      notes: 'Staking reward',
      raw: { fixture: 'staking-income' },
    },
    // Event 3: Sell 0.5 ETH for $1,500
    {
      id: 'coinbase:sell-eth-001',
      source: 'coinbase',
      accountId: 'test-coinbase',
      timestamp: new Date('2024-06-15T14:00:00Z'),
      type: 'trade',
      legs: [
        { asset: 'ETH', amount: '-0.5', amountUsdReportedBySource: '1500' },
        { asset: 'USD', amount: '1500', amountUsdReportedBySource: '1500' },
      ],
      notes: 'Sold 0.5 ETH for $1,500',
      raw: { fixture: 'sell-eth' },
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────
// End-to-end test
// ─────────────────────────────────────────────────────────────────────────

describe('end-to-end pipeline: RawEvents → classify → tax → CSV', () => {
  it('processes synthetic events through the full pipeline and produces correct CSV', () => {
    const events = syntheticEvents();

    // ── Step 1: Insert RawEvents ─────────────────────────────────────
    const insertResult = repo.insertRawEvents(events);
    expect(insertResult.inserted).toBe(3);
    expect(insertResult.skipped).toBe(0);

    // ── Step 2: Classify ─────────────────────────────────────────────
    const allEvents = repo.getRawEvents({ limit: 1_000_000 });
    expect(allEvents).toHaveLength(3);

    const overrides = repo.getClassifierOverrides();
    const context: ClassifierContext = {
      ownAddresses: [],
      accountIds: ['test-coinbase'],
      dexRouters: new Map(),
      bridges: new Map(),
    };

    const classifyResult = classify(allEvents, overrides, context, DEFAULT_RULES);
    expect(classifyResult.entries).toHaveLength(3);
    expect(classifyResult.unclassifiedCount).toBe(0);

    // Persist classified entries
    repo.rebuildLedgerEntries(classifyResult.entries);

    // ── Step 3: Verify LedgerEntries ─────────────────────────────────
    const ledgerEntries = repo.getLedgerEntries({ year: 2024 });
    expect(ledgerEntries).toHaveLength(3);

    const trades = ledgerEntries.filter((e: LedgerEntry) => e.type === 'trade');
    const incomes = ledgerEntries.filter((e: LedgerEntry) => e.type === 'income');
    expect(trades).toHaveLength(2);
    expect(incomes).toHaveLength(1);

    // Verify the income entry has the staking reward
    const incomeEntry = incomes[0]!;
    expect(incomeEntry.legs[0]!.asset).toBe('ETH');
    expect(incomeEntry.legs[0]!.amount).toBe('0.01');

    // ── Step 4: Compute tax with FIFO ────────────────────────────────
    const taxResult = computeTax(ledgerEntries, {
      method: FIFO,
      holdingPeriodDays: 365,
      year: 2024,
    });

    // Should have 1 disposal (the sell of 0.5 ETH)
    expect(taxResult.disposals).toHaveLength(1);
    expect(taxResult.year).toBe(2024);
    expect(taxResult.method).toBe('FIFO');

    const disposal = taxResult.disposals[0]!;
    expect(disposal.asset).toBe('ETH');
    expect(disposal.amount).toBe('0.5');

    // FIFO: oldest lot is the buy at $2,000/ETH
    // Cost basis: 0.5 ETH × $2,000/ETH = $1,000
    expect(disposal.costBasis).toBe('1000');
    // Proceeds: $1,500
    expect(disposal.proceeds).toBe('1500');
    // Gain: $1,500 - $1,000 = $500
    expect(disposal.gainLoss).toBe('500');
    // Bought Jan 15 → Sold Jun 15 = ~152 days → short-term
    expect(disposal.term).toBe('short-term');

    // Income summary: 0.01 ETH at $20
    expect(taxResult.income.totalUsd).toBe('20');
    expect(taxResult.income.byAsset['ETH']).toBe('20');
    expect(taxResult.income.events).toHaveLength(1);

    // ── Step 5: Generate CSV ─────────────────────────────────────────
    const csv = formatCsv(taxResult);

    // Verify CSV is non-empty and contains expected headers
    expect(csv).toBeTruthy();
    expect(csv).toContain('Date Acquired');
    expect(csv).toContain('Date Sold');
    expect(csv).toContain('Asset');
    expect(csv).toContain('Amount');
    expect(csv).toContain('Proceeds (USD)');
    expect(csv).toContain('Cost Basis (USD)');
    expect(csv).toContain('Gain/Loss (USD)');
    expect(csv).toContain('Term');

    // Verify disposal row values appear in CSV
    expect(csv).toContain('ETH');
    expect(csv).toContain('0.5');
    expect(csv).toContain('1500');
    expect(csv).toContain('1000');
    expect(csv).toContain('500');
    expect(csv).toContain('short-term');

    // Verify summary section
    expect(csv).toContain('Summary');
    expect(csv).toContain('Short-Term Gain');
    expect(csv).toContain('Long-Term Gain');
    expect(csv).toContain('Total Income');
    expect(csv).toContain('20');

    // Parse CSV lines to verify structure
    const lines = csv.trim().split('\n');
    // At minimum: header + 1 data row + blank line + 4 summary rows
    expect(lines.length).toBeGreaterThanOrEqual(6);

    // First line is the header
    const header = lines[0]!;
    expect(header).toContain('Date Acquired');
    expect(header).toContain('Date Sold');
  });

  it('idempotent re-insert of same events produces zero new writes', () => {
    const events = syntheticEvents();

    const first = repo.insertRawEvents(events);
    expect(first.inserted).toBe(3);

    const second = repo.insertRawEvents(events);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(3);
  });

  it('reclassification after adding an override produces updated entries', () => {
    const events = syntheticEvents();
    repo.insertRawEvents(events);

    const allEvents = repo.getRawEvents({ limit: 1_000_000 });
    const context: ClassifierContext = {
      ownAddresses: [],
      accountIds: ['test-coinbase'],
      dexRouters: new Map(),
      bridges: new Map(),
    };

    // First classification
    const result1 = classify(allEvents, [], context, DEFAULT_RULES);
    repo.rebuildLedgerEntries(result1.entries);

    // The buy event should be classified as 'trade'
    const entries1 = repo.getLedgerEntries({ year: 2024 });
    const buyEntry = entries1.find((e: LedgerEntry) =>
      e.rawEventIds.includes('coinbase:buy-eth-001'),
    );
    expect(buyEntry).toBeDefined();
    expect(buyEntry!.type).toBe('trade');

    // Add an override to reclassify the buy as income
    repo.insertClassifierOverride({
      id: 'override-buy-to-income',
      rawEventIds: ['coinbase:buy-eth-001'],
      type: 'income',
      createdAt: new Date(),
      note: 'Reclassify buy as income for testing',
    });

    // Reclassify with the override
    const overrides = repo.getClassifierOverrides();
    const result2 = classify(allEvents, overrides, context, DEFAULT_RULES);
    repo.rebuildLedgerEntries(result2.entries);

    // Verify the override took effect
    const entries2 = repo.getLedgerEntries({ year: 2024 });
    const overriddenEntry = entries2.find((e: LedgerEntry) =>
      e.rawEventIds.includes('coinbase:buy-eth-001'),
    );
    expect(overriddenEntry).toBeDefined();
    expect(overriddenEntry!.type).toBe('income');
    expect(overriddenEntry!.overrideId).toBe('override-buy-to-income');
  });
});

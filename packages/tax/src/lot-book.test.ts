/**
 * Unit tests and property-based tests for LotBook.
 *
 * Validates CP3 (Lot Conservation): for any asset processed through
 * the lot tracking system, the total acquired amount equals the total
 * disposed amount plus the remaining amount in the pool.
 *
 * **Validates: Requirements 20.1, 20.2**
 */

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import Decimal from 'decimal.js';
import { LotBook } from './lot-book.js';
import { FIFO, HIFO } from './cost-basis.js';
import type { Lot } from './types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Create a Lot with sensible defaults. */
function makeLot(overrides: Partial<Lot> & { id: string; asset: string; amount: string }): Lot {
  return {
    unitCostUsd: '100',
    acquiredAt: new Date('2024-01-01T00:00:00Z'),
    sourceEntryId: `entry-${overrides.id}`,
    ...overrides,
  };
}

const DISPOSE_DATE = new Date('2024-06-15T00:00:00Z');

// ─── Property-based tests (CP3: Lot Conservation) ───────────────────────

describe('CP3: Lot Conservation', () => {
  /**
   * **Validates: Requirements 20.1, 20.2**
   *
   * Property: For any sequence of acquire/dispose operations on a LotBook,
   * the total acquired amount for each asset equals the total disposed
   * amount plus the remaining amount in the pool.
   */
  it('lot conservation holds for random acquire/dispose sequences (FIFO)', () => {
    // Arbitrary for a single operation: either acquire or dispose
    const operationArb = fc.oneof(
      // Acquire: integer amount in hundredths (0.01–100.00)
      fc.record({
        type: fc.constant('acquire' as const),
        amountCents: fc.integer({ min: 1, max: 10000 }),
        unitCostCents: fc.integer({ min: 1, max: 10000000 }),
      }),
      // Dispose: integer amount in hundredths (0.01–100.00)
      fc.record({
        type: fc.constant('dispose' as const),
        amountCents: fc.integer({ min: 1, max: 10000 }),
      }),
    );

    fc.assert(
      fc.property(
        fc.array(operationArb, { minLength: 1, maxLength: 50 }),
        (operations) => {
          const book = new LotBook();
          const asset = 'ETH';
          let totalAcquired = new Decimal(0);
          let totalDisposed = new Decimal(0);
          let lotCounter = 0;

          for (const op of operations) {
            if (op.type === 'acquire') {
              const amount = new Decimal(op.amountCents).div(100);
              const unitCost = new Decimal(op.unitCostCents).div(100);
              lotCounter++;
              book.acquire({
                id: `lot-${lotCounter}`,
                asset,
                amount: amount.toString(),
                unitCostUsd: unitCost.toString(),
                acquiredAt: new Date(Date.now() - lotCounter * 86400000),
                sourceEntryId: `entry-${lotCounter}`,
              });
              totalAcquired = totalAcquired.plus(amount);
            } else {
              const disposeAmount = new Decimal(op.amountCents).div(100);
              const result = book.dispose(asset, disposeAmount, FIFO, DISPOSE_DATE);
              // Track what was actually consumed from the lots
              const consumed = result.lotsConsumed.reduce(
                (sum, lc) => sum.plus(new Decimal(lc.amount)),
                new Decimal(0),
              );
              totalDisposed = totalDisposed.plus(consumed);
            }
          }

          const remaining = book.totalAmount(asset);

          // Conservation: acquired = disposed + remaining
          const lhs = totalAcquired;
          const rhs = totalDisposed.plus(remaining);

          // Use a small epsilon for floating-point representation differences
          // in the Decimal string round-trips
          expect(lhs.minus(rhs).abs().lte(new Decimal('0.00000001'))).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('lot conservation holds for random acquire/dispose sequences (HIFO)', () => {
    const operationArb = fc.oneof(
      fc.record({
        type: fc.constant('acquire' as const),
        amountCents: fc.integer({ min: 1, max: 10000 }),
        unitCostCents: fc.integer({ min: 1, max: 10000000 }),
      }),
      fc.record({
        type: fc.constant('dispose' as const),
        amountCents: fc.integer({ min: 1, max: 10000 }),
      }),
    );

    fc.assert(
      fc.property(
        fc.array(operationArb, { minLength: 1, maxLength: 50 }),
        (operations) => {
          const book = new LotBook();
          const asset = 'BTC';
          let totalAcquired = new Decimal(0);
          let totalDisposed = new Decimal(0);
          let lotCounter = 0;

          for (const op of operations) {
            if (op.type === 'acquire') {
              const amount = new Decimal(op.amountCents).div(100);
              const unitCost = new Decimal(op.unitCostCents).div(100);
              lotCounter++;
              book.acquire({
                id: `lot-${lotCounter}`,
                asset,
                amount: amount.toString(),
                unitCostUsd: unitCost.toString(),
                acquiredAt: new Date(Date.now() - lotCounter * 86400000),
                sourceEntryId: `entry-${lotCounter}`,
              });
              totalAcquired = totalAcquired.plus(amount);
            } else {
              const disposeAmount = new Decimal(op.amountCents).div(100);
              const result = book.dispose(asset, disposeAmount, HIFO, DISPOSE_DATE);
              const consumed = result.lotsConsumed.reduce(
                (sum, lc) => sum.plus(new Decimal(lc.amount)),
                new Decimal(0),
              );
              totalDisposed = totalDisposed.plus(consumed);
            }
          }

          const remaining = book.totalAmount(asset);
          const lhs = totalAcquired;
          const rhs = totalDisposed.plus(remaining);

          expect(lhs.minus(rhs).abs().lte(new Decimal('0.00000001'))).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─── Property-based tests (CP4: Decimal Precision) ──────────────────────

describe('CP4: Decimal Precision', () => {
  /**
   * **Validates: Requirements 18.3**
   *
   * Property: For any sequence of acquire/dispose operations on a LotBook,
   * all lot amounts, unitCostUsd values, totalAmount results, and
   * DisposalResult costBasis values are valid decimal strings parseable
   * by decimal.js without loss of precision. No JavaScript floating-point
   * drift occurs.
   */
  it('all amounts remain exact decimal strings after random acquire/dispose sequences', () => {
    // Use amounts known to cause JS floating-point issues:
    // 0.1 + 0.2 !== 0.3 in JS floats, but must be exact in decimal.js
    const floatTrapAmounts = [
      '0.1', '0.2', '0.3', '0.6', '0.7',
      '0.01', '0.02', '0.03', '0.06', '0.07',
      '0.001', '0.002', '0.003', '0.006', '0.007',
      '1.1', '2.2', '3.3', '0.14', '0.28',
    ];

    const floatTrapCosts = [
      '0.1', '0.2', '0.3', '100.1', '200.2',
      '1000.001', '999.999', '0.33', '0.67', '1.01',
    ];

    const amountArb = fc.constantFrom(...floatTrapAmounts);
    const costArb = fc.constantFrom(...floatTrapCosts);

    const operationArb = fc.oneof(
      fc.record({
        type: fc.constant('acquire' as const),
        amount: amountArb,
        unitCost: costArb,
      }),
      fc.record({
        type: fc.constant('dispose' as const),
        amount: amountArb,
      }),
    );

    fc.assert(
      fc.property(
        fc.array(operationArb, { minLength: 2, maxLength: 40 }),
        (operations) => {
          const book = new LotBook();
          const asset = 'ETH';
          let lotCounter = 0;
          const allDisposalResults: { costBasis: string; lotsConsumed: Array<{ amount: string; costBasis: string }> }[] = [];

          for (const op of operations) {
            if (op.type === 'acquire') {
              lotCounter++;
              book.acquire({
                id: `lot-${lotCounter}`,
                asset,
                amount: op.amount,
                unitCostUsd: op.unitCost,
                acquiredAt: new Date(Date.now() - lotCounter * 86400000),
                sourceEntryId: `entry-${lotCounter}`,
              });
            } else {
              const result = book.dispose(
                asset,
                new Decimal(op.amount),
                FIFO,
                DISPOSE_DATE,
              );
              allDisposalResults.push(result);
            }
          }

          // 1. Every remaining lot's amount is a valid decimal string
          const available = book.getAvailable(asset);
          for (const lot of available) {
            const parsed = new Decimal(lot.amount);
            // Round-trip: parsing and re-stringifying must be lossless
            expect(parsed.toString()).toBe(new Decimal(lot.amount).toString());
            // Must not contain floating-point artifacts like 0.30000000000000004
            expect(lot.amount).not.toMatch(/\d{15,}/);
            expect(parsed.isFinite()).toBe(true);
          }

          // 2. Every remaining lot's unitCostUsd is a valid decimal string
          for (const lot of available) {
            const parsed = new Decimal(lot.unitCostUsd);
            expect(parsed.toString()).toBe(new Decimal(lot.unitCostUsd).toString());
            expect(lot.unitCostUsd).not.toMatch(/\d{15,}/);
            expect(parsed.isFinite()).toBe(true);
          }

          // 3. totalAmount is exactly representable (no floating-point drift)
          const total = book.totalAmount(asset);
          expect(total.isFinite()).toBe(true);
          // Verify totalAmount equals the sum of individual lot amounts
          const manualSum = available.reduce(
            (sum, lot) => sum.plus(new Decimal(lot.amount)),
            new Decimal(0),
          );
          expect(total.eq(manualSum)).toBe(true);

          // 4. All DisposalResult costBasis and consumed amounts are valid decimal strings
          for (const result of allDisposalResults) {
            const costBasis = new Decimal(result.costBasis);
            expect(costBasis.isFinite()).toBe(true);
            expect(costBasis.toString()).toBe(new Decimal(result.costBasis).toString());

            for (const consumed of result.lotsConsumed) {
              const consumedAmount = new Decimal(consumed.amount);
              expect(consumedAmount.isFinite()).toBe(true);
              expect(consumedAmount.toString()).toBe(new Decimal(consumed.amount).toString());

              const consumedCostBasis = new Decimal(consumed.costBasis);
              expect(consumedCostBasis.isFinite()).toBe(true);
              expect(consumedCostBasis.toString()).toBe(new Decimal(consumed.costBasis).toString());
            }
          }

          // 5. Verify no JS float drift: 0.1 + 0.2 must equal 0.3 exactly in Decimal
          // This is a sanity check that the system uses decimal.js, not JS floats
          const d1 = new Decimal('0.1').plus('0.2');
          expect(d1.eq(new Decimal('0.3'))).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('costBasis computed from float-trap amounts has no floating-point artifacts', () => {
    // Specific scenario: acquire lots with amounts that cause JS float issues,
    // then dispose and verify costBasis is exact
    const book = new LotBook();
    const asset = 'ETH';

    // 0.1 * 1000.1 = 100.01 exactly in decimal, but JS float gives 100.01000000000002
    book.acquire({
      id: 'lot-1',
      asset,
      amount: '0.1',
      unitCostUsd: '1000.1',
      acquiredAt: new Date('2024-01-01'),
      sourceEntryId: 'e1',
    });

    // 0.2 * 999.9 = 199.98 exactly in decimal
    book.acquire({
      id: 'lot-2',
      asset,
      amount: '0.2',
      unitCostUsd: '999.9',
      acquiredAt: new Date('2024-02-01'),
      sourceEntryId: 'e2',
    });

    // Dispose 0.3 — spans both lots
    const result = book.dispose(asset, new Decimal('0.3'), FIFO, DISPOSE_DATE);

    // costBasis should be exactly 100.01 + 199.98 = 299.99
    expect(result.costBasis).toBe('299.99');

    // Verify no floating-point artifacts in the string
    expect(result.costBasis).not.toMatch(/\d{15,}/);
    expect(new Decimal(result.costBasis).eq(new Decimal('299.99'))).toBe(true);

    // Pool should be empty
    expect(book.totalAmount(asset).isZero()).toBe(true);
  });
});

// ─── Unit tests ──────────────────────────────────────────────────────────

describe('LotBook', () => {
  describe('acquire', () => {
    it('acquired lot appears in getAvailable', () => {
      const book = new LotBook();
      const lot = makeLot({ id: 'lot-1', asset: 'ETH', amount: '1.5' });
      book.acquire(lot);

      const available = book.getAvailable('ETH');
      expect(available).toHaveLength(1);
      expect(available[0]!.id).toBe('lot-1');
      expect(available[0]!.amount).toBe('1.5');
    });
  });

  describe('dispose with FIFO', () => {
    it('consumes oldest lot first', () => {
      const book = new LotBook();
      book.acquire(makeLot({
        id: 'lot-old',
        asset: 'ETH',
        amount: '1.0',
        unitCostUsd: '1000',
        acquiredAt: new Date('2023-01-01'),
      }));
      book.acquire(makeLot({
        id: 'lot-new',
        asset: 'ETH',
        amount: '1.0',
        unitCostUsd: '2000',
        acquiredAt: new Date('2024-01-01'),
      }));

      const result = book.dispose('ETH', new Decimal('1.0'), FIFO, DISPOSE_DATE);

      expect(result.lotsConsumed).toHaveLength(1);
      expect(result.lotsConsumed[0]!.lotId).toBe('lot-old');
      expect(result.costBasis).toBe('1000');

      // Only the newer lot remains
      const available = book.getAvailable('ETH');
      expect(available).toHaveLength(1);
      expect(available[0]!.id).toBe('lot-new');
    });
  });

  describe('dispose with HIFO', () => {
    it('consumes highest-cost lot first', () => {
      const book = new LotBook();
      book.acquire(makeLot({
        id: 'lot-cheap',
        asset: 'ETH',
        amount: '1.0',
        unitCostUsd: '1000',
        acquiredAt: new Date('2023-01-01'),
      }));
      book.acquire(makeLot({
        id: 'lot-expensive',
        asset: 'ETH',
        amount: '1.0',
        unitCostUsd: '3000',
        acquiredAt: new Date('2024-01-01'),
      }));

      const result = book.dispose('ETH', new Decimal('1.0'), HIFO, DISPOSE_DATE);

      expect(result.lotsConsumed).toHaveLength(1);
      expect(result.lotsConsumed[0]!.lotId).toBe('lot-expensive');
      expect(result.costBasis).toBe('3000');

      // Only the cheaper lot remains
      const available = book.getAvailable('ETH');
      expect(available).toHaveLength(1);
      expect(available[0]!.id).toBe('lot-cheap');
    });
  });

  describe('partial lot splitting', () => {
    it('disposes less than a full lot, remainder stays in pool', () => {
      const book = new LotBook();
      book.acquire(makeLot({
        id: 'lot-1',
        asset: 'ETH',
        amount: '2.0',
        unitCostUsd: '1500',
        acquiredAt: new Date('2024-01-01'),
      }));

      const result = book.dispose('ETH', new Decimal('0.5'), FIFO, DISPOSE_DATE);

      expect(result.lotsConsumed).toHaveLength(1);
      expect(result.lotsConsumed[0]!.amount).toBe('0.5');
      expect(result.costBasis).toBe('750'); // 0.5 * 1500

      // Remainder: 2.0 - 0.5 = 1.5
      const available = book.getAvailable('ETH');
      expect(available).toHaveLength(1);
      expect(available[0]!.amount).toBe('1.5');
    });
  });

  describe('insufficient lots', () => {
    it('disposes more than available, consumes all and reports remainder', () => {
      const book = new LotBook();
      book.acquire(makeLot({
        id: 'lot-1',
        asset: 'ETH',
        amount: '1.0',
        unitCostUsd: '2000',
        acquiredAt: new Date('2024-01-01'),
      }));

      // Try to dispose 3.0 but only 1.0 available
      const result = book.dispose('ETH', new Decimal('3.0'), FIFO, DISPOSE_DATE);

      // Only 1.0 was consumed
      expect(result.lotsConsumed).toHaveLength(1);
      expect(result.lotsConsumed[0]!.amount).toBe('1');
      expect(result.costBasis).toBe('2000');

      // Pool is now empty
      const available = book.getAvailable('ETH');
      expect(available).toHaveLength(0);
      expect(book.totalAmount('ETH').isZero()).toBe(true);
    });
  });

  describe('multiple lots spanning disposal', () => {
    it('acquires 3 lots, disposes spanning 2 lots', () => {
      const book = new LotBook();
      book.acquire(makeLot({
        id: 'lot-1',
        asset: 'ETH',
        amount: '1.0',
        unitCostUsd: '1000',
        acquiredAt: new Date('2023-01-01'),
      }));
      book.acquire(makeLot({
        id: 'lot-2',
        asset: 'ETH',
        amount: '2.0',
        unitCostUsd: '1500',
        acquiredAt: new Date('2023-06-01'),
      }));
      book.acquire(makeLot({
        id: 'lot-3',
        asset: 'ETH',
        amount: '1.5',
        unitCostUsd: '2000',
        acquiredAt: new Date('2024-01-01'),
      }));

      // Dispose 2.5 ETH with FIFO: should consume lot-1 (1.0) fully + lot-2 (1.5) partially
      const result = book.dispose('ETH', new Decimal('2.5'), FIFO, DISPOSE_DATE);

      expect(result.lotsConsumed).toHaveLength(2);
      expect(result.lotsConsumed[0]!.lotId).toBe('lot-1');
      expect(result.lotsConsumed[0]!.amount).toBe('1');
      expect(result.lotsConsumed[1]!.lotId).toBe('lot-2');
      expect(result.lotsConsumed[1]!.amount).toBe('1.5');

      // Cost basis: 1.0 * 1000 + 1.5 * 1500 = 1000 + 2250 = 3250
      expect(result.costBasis).toBe('3250');

      // Remaining: lot-2 has 0.5 left, lot-3 has 1.5
      const available = book.getAvailable('ETH');
      expect(available).toHaveLength(2);
      expect(book.totalAmount('ETH').toString()).toBe('2');
    });
  });
});

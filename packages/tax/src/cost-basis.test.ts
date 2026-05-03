/**
 * Unit tests for the SpecificId cost-basis strategy.
 *
 * Validates:
 *   - Exact selection covers disposal → remainder '0'
 *   - Partial selection → non-zero remainder
 *   - Lot not in selections map → skipped
 *   - Selected amount capped by lot amount and remaining need
 *   - Multiple lots selected across a single disposal
 *
 * **Validates: Requirements 7.1, 7.2**
 */

import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { SpecificId } from './cost-basis.js';
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

// ─── SpecificId tests ────────────────────────────────────────────────────

describe('SpecificId', () => {
  it('has the correct name', () => {
    const strategy = new SpecificId(new Map());
    expect(strategy.name).toBe('Specific ID');
  });

  describe('exact selection covers disposal', () => {
    it('single lot exactly covers the disposal → remainder 0', () => {
      const lots: Lot[] = [
        makeLot({ id: 'lot-1', asset: 'ETH', amount: '2.0', unitCostUsd: '1500' }),
        makeLot({ id: 'lot-2', asset: 'ETH', amount: '3.0', unitCostUsd: '2000' }),
      ];

      const selections = new Map([['lot-1', '2.0']]);
      const strategy = new SpecificId(selections);

      const result = strategy.selectLots(lots, new Decimal('2.0'));

      expect(result.consumed).toHaveLength(1);
      expect(result.consumed[0]!.lot.id).toBe('lot-1');
      expect(result.consumed[0]!.amount).toBe('2');
      expect(result.remainder).toBe('0');
    });

    it('multiple lots exactly cover the disposal → remainder 0', () => {
      const lots: Lot[] = [
        makeLot({ id: 'lot-1', asset: 'ETH', amount: '1.0', unitCostUsd: '1000' }),
        makeLot({ id: 'lot-2', asset: 'ETH', amount: '1.5', unitCostUsd: '1500' }),
        makeLot({ id: 'lot-3', asset: 'ETH', amount: '2.0', unitCostUsd: '2000' }),
      ];

      const selections = new Map([
        ['lot-1', '1.0'],
        ['lot-3', '1.5'],
      ]);
      const strategy = new SpecificId(selections);

      const result = strategy.selectLots(lots, new Decimal('2.5'));

      expect(result.consumed).toHaveLength(2);
      expect(result.consumed[0]!.lot.id).toBe('lot-1');
      expect(result.consumed[0]!.amount).toBe('1');
      expect(result.consumed[1]!.lot.id).toBe('lot-3');
      expect(result.consumed[1]!.amount).toBe('1.5');
      expect(result.remainder).toBe('0');
    });
  });

  describe('partial selection', () => {
    it('selected lots do not cover the full disposal → non-zero remainder', () => {
      const lots: Lot[] = [
        makeLot({ id: 'lot-1', asset: 'ETH', amount: '1.0', unitCostUsd: '1000' }),
        makeLot({ id: 'lot-2', asset: 'ETH', amount: '1.0', unitCostUsd: '2000' }),
      ];

      const selections = new Map([['lot-1', '1.0']]);
      const strategy = new SpecificId(selections);

      const result = strategy.selectLots(lots, new Decimal('3.0'));

      expect(result.consumed).toHaveLength(1);
      expect(result.consumed[0]!.lot.id).toBe('lot-1');
      expect(result.consumed[0]!.amount).toBe('1');
      expect(result.remainder).toBe('2');
    });

    it('empty selections map → full amount as remainder', () => {
      const lots: Lot[] = [
        makeLot({ id: 'lot-1', asset: 'ETH', amount: '5.0' }),
      ];

      const strategy = new SpecificId(new Map());
      const result = strategy.selectLots(lots, new Decimal('3.0'));

      expect(result.consumed).toHaveLength(0);
      expect(result.remainder).toBe('3');
    });
  });

  describe('lot not in selections map → skipped', () => {
    it('only consumes lots present in the selections map', () => {
      const lots: Lot[] = [
        makeLot({ id: 'lot-1', asset: 'ETH', amount: '1.0', unitCostUsd: '1000' }),
        makeLot({ id: 'lot-2', asset: 'ETH', amount: '2.0', unitCostUsd: '2000' }),
        makeLot({ id: 'lot-3', asset: 'ETH', amount: '3.0', unitCostUsd: '3000' }),
      ];

      // Only select lot-2, skip lot-1 and lot-3
      const selections = new Map([['lot-2', '2.0']]);
      const strategy = new SpecificId(selections);

      const result = strategy.selectLots(lots, new Decimal('2.0'));

      expect(result.consumed).toHaveLength(1);
      expect(result.consumed[0]!.lot.id).toBe('lot-2');
      expect(result.consumed[0]!.amount).toBe('2');
      expect(result.remainder).toBe('0');
    });
  });

  describe('amount capping', () => {
    it('caps take at the lot amount when selection exceeds lot size', () => {
      const lots: Lot[] = [
        makeLot({ id: 'lot-1', asset: 'ETH', amount: '1.0' }),
      ];

      // Select more than the lot has
      const selections = new Map([['lot-1', '5.0']]);
      const strategy = new SpecificId(selections);

      const result = strategy.selectLots(lots, new Decimal('3.0'));

      expect(result.consumed).toHaveLength(1);
      expect(result.consumed[0]!.amount).toBe('1');
      expect(result.remainder).toBe('2');
    });

    it('caps take at remaining need when selection exceeds disposal amount', () => {
      const lots: Lot[] = [
        makeLot({ id: 'lot-1', asset: 'ETH', amount: '10.0' }),
      ];

      // Select more than needed
      const selections = new Map([['lot-1', '10.0']]);
      const strategy = new SpecificId(selections);

      const result = strategy.selectLots(lots, new Decimal('2.5'));

      expect(result.consumed).toHaveLength(1);
      expect(result.consumed[0]!.amount).toBe('2.5');
      expect(result.remainder).toBe('0');
    });

    it('stops consuming once disposal amount is fully covered', () => {
      const lots: Lot[] = [
        makeLot({ id: 'lot-1', asset: 'ETH', amount: '2.0' }),
        makeLot({ id: 'lot-2', asset: 'ETH', amount: '3.0' }),
      ];

      const selections = new Map([
        ['lot-1', '2.0'],
        ['lot-2', '3.0'],
      ]);
      const strategy = new SpecificId(selections);

      // Only need 2.0 — lot-1 covers it, lot-2 should not be touched
      const result = strategy.selectLots(lots, new Decimal('2.0'));

      expect(result.consumed).toHaveLength(1);
      expect(result.consumed[0]!.lot.id).toBe('lot-1');
      expect(result.consumed[0]!.amount).toBe('2');
      expect(result.remainder).toBe('0');
    });
  });

  describe('decimal precision', () => {
    it('handles float-trap amounts without precision loss', () => {
      const lots: Lot[] = [
        makeLot({ id: 'lot-1', asset: 'ETH', amount: '0.1', unitCostUsd: '1000.1' }),
        makeLot({ id: 'lot-2', asset: 'ETH', amount: '0.2', unitCostUsd: '999.9' }),
      ];

      const selections = new Map([
        ['lot-1', '0.1'],
        ['lot-2', '0.2'],
      ]);
      const strategy = new SpecificId(selections);

      const result = strategy.selectLots(lots, new Decimal('0.3'));

      expect(result.consumed).toHaveLength(2);
      expect(result.consumed[0]!.amount).toBe('0.1');
      expect(result.consumed[1]!.amount).toBe('0.2');
      expect(result.remainder).toBe('0');

      // Verify no floating-point artifacts
      const totalConsumed = result.consumed.reduce(
        (sum, c) => sum.plus(new Decimal(c.amount)),
        new Decimal(0),
      );
      expect(totalConsumed.eq(new Decimal('0.3'))).toBe(true);
    });
  });
});

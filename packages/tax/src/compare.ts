/**
 * Cost-basis method comparison.
 *
 * Runs `computeTax()` once per supported method (FIFO, HIFO) against
 * the same LedgerEntries and returns a structured result for
 * side-by-side table rendering in the CLI.
 *
 * All arithmetic uses decimal.js — never JavaScript floating-point.
 */

import Decimal from 'decimal.js';
import type { LedgerEntry } from '@daybook/ledger';
import { computeTax } from './compute.js';
import { FIFO, HIFO, LIFO } from './cost-basis.js';
import type { CostBasisStrategy } from './cost-basis.js';
import type { TaxResult } from './types.js';

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

/**
 * The result of comparing multiple cost-basis methods.
 *
 * Contains the full TaxResult for each method and identifies which
 * method produces the lowest total taxable amount.
 */
export interface CompareResult {
  /** Per-method tax computation results. */
  results: Array<{ method: string; result: TaxResult }>;
  /** The method name with the lowest total taxable amount. */
  lowestTaxMethod: string;
}

/**
 * A summary row for table rendering.
 *
 * Extracts the key figures from a TaxResult into a flat shape
 * suitable for CLI table output.
 */
export interface MethodSummary {
  /** Cost-basis method name (e.g. 'FIFO', 'HIFO'). */
  method: string;
  /** Number of disposal events. */
  disposalCount: number;
  /** Total short-term capital gain. Decimal string. */
  shortTermGain: string;
  /** Total long-term capital gain. Decimal string. */
  longTermGain: string;
  /** Total taxable amount (shortTermGain + longTermGain). Decimal string. */
  totalTaxable: string;
  /** Total income at FMV. Decimal string. */
  incomeTotal: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

/** Default holding period threshold in days. */
const DEFAULT_HOLDING_PERIOD_DAYS = 365;

/** All supported cost-basis strategies for comparison. */
const METHODS: CostBasisStrategy[] = [FIFO, HIFO, LIFO];

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Compute the total taxable amount for a TaxResult.
 *
 * Total taxable = sum of short-term gains + sum of long-term gains.
 *
 * @param result - A completed tax computation result.
 * @returns The total taxable amount as a Decimal.
 */
function totalTaxable(result: TaxResult): Decimal {
  let shortTerm = new Decimal(0);
  let longTerm = new Decimal(0);

  for (const d of result.disposals) {
    if (d.term === 'short-term') {
      shortTerm = shortTerm.plus(new Decimal(d.gainLoss));
    } else {
      longTerm = longTerm.plus(new Decimal(d.gainLoss));
    }
  }

  return shortTerm.plus(longTerm);
}

// ─────────────────────────────────────────────────────────────────────────
// Compare methods
// ─────────────────────────────────────────────────────────────────────────

/**
 * Run `computeTax` once per supported cost-basis method and compare
 * the results.
 *
 * Processes the same LedgerEntries under FIFO and HIFO, then
 * determines which method produces the lowest total taxable amount.
 *
 * @param entries - LedgerEntries with USD values already hydrated.
 * @param year - The tax year to compute.
 * @param holdingPeriodDays - Days for long-term threshold. Default 365.
 * @returns A CompareResult with per-method results and the winning method.
 */
export function compareMethods(
  entries: LedgerEntry[],
  year: number,
  holdingPeriodDays: number = DEFAULT_HOLDING_PERIOD_DAYS,
  lotPool: 'universal' | 'per-account' = 'universal',
): CompareResult {
  const results: Array<{ method: string; result: TaxResult }> = [];

  for (const strategy of METHODS) {
    const result = computeTax(entries, {
      method: strategy,
      holdingPeriodDays,
      year,
      lotPool,
    });
    results.push({ method: strategy.name, result });
  }

  // Determine the method with the lowest total taxable amount
  let lowestTaxMethod = results[0]!.method;
  let lowestTaxAmount = totalTaxable(results[0]!.result);

  for (let i = 1; i < results.length; i++) {
    const amount = totalTaxable(results[i]!.result);
    if (amount.lt(lowestTaxAmount)) {
      lowestTaxAmount = amount;
      lowestTaxMethod = results[i]!.method;
    }
  }

  return { results, lowestTaxMethod };
}

// ─────────────────────────────────────────────────────────────────────────
// Summarize for table rendering
// ─────────────────────────────────────────────────────────────────────────

/**
 * Extract summary data from a CompareResult for table rendering.
 *
 * Produces one MethodSummary per method with disposal count,
 * short-term gain, long-term gain, total taxable, and income total.
 *
 * @param compareResult - The output of `compareMethods()`.
 * @returns An array of MethodSummary objects, one per method.
 */
export function summarizeResults(compareResult: CompareResult): MethodSummary[] {
  return compareResult.results.map(({ method, result }) => {
    let shortTermGain = new Decimal(0);
    let longTermGain = new Decimal(0);

    for (const d of result.disposals) {
      if (d.term === 'short-term') {
        shortTermGain = shortTermGain.plus(new Decimal(d.gainLoss));
      } else {
        longTermGain = longTermGain.plus(new Decimal(d.gainLoss));
      }
    }

    const total = shortTermGain.plus(longTermGain);

    return {
      method,
      disposalCount: result.disposals.length,
      shortTermGain: shortTermGain.toString(),
      longTermGain: longTermGain.toString(),
      totalTaxable: total.toString(),
      incomeTotal: result.income.totalUsd,
    };
  });
}

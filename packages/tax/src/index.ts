/**
 * @daybook/tax
 *
 * Consumes LedgerEntries and produces tax-ready output.
 *
 * v1 scope:
 *   - FIFO and HIFO lot tracking
 *   - Per-disposal gain/loss with short/long-term split
 *   - Tax-ready CSV export (one row per disposal)
 *   - Income summary (staking, rewards, inflation) at FMV
 *   - Pricing module: source-reported → CoinGecko → manual override
 *
 * v2:
 *   - Form 8949 PDF generation
 *   - Schedule D summary
 *   - TXF export for TurboTax
 *   - Specific-ID lot picker
 *
 * Pending implementation.
 */

export type CostBasisMethod = 'FIFO' | 'HIFO' | 'LIFO' | 'Specific ID';

// ─── Tax engine types ────────────────────────────────────────────────────
export type {
  Lot,
  DisposalResult,
  TaxResult,
  IncomeSummary,
} from './types.js';

export type {
  CostBasisStrategy,
  LotSelection,
} from './cost-basis.js';

export { FIFO, HIFO, LIFO, SpecificId } from './cost-basis.js';

export { LotBook } from './lot-book.js';

// ─── Tax computation ─────────────────────────────────────────────────────
export { computeTax } from './compute.js';
export type { ComputeTaxConfig } from './compute.js';

// ─── Method comparison ───────────────────────────────────────────────────
export { compareMethods, summarizeResults } from './compare.js';
export type { CompareResult, MethodSummary } from './compare.js';

// ─── CSV export ──────────────────────────────────────────────────────────
export { formatCsv } from './csv-export.js';
export type { FormatCsvOptions } from './csv-export.js';

// ─── Wash sale ───────────────────────────────────────────────────────────
export { applyWashSaleFlags } from './wash-sale.js';
export type { AcquisitionRecord } from './wash-sale.js';

// ─── Pricing module ──────────────────────────────────────────────────────
export * from './pricing/index.js';

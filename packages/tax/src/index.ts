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
 *
 * v2:
 *   - Form 8949 PDF generation
 *   - Schedule D summary
 *   - TXF export for TurboTax
 *   - Specific-ID lot picker
 *
 * Pending implementation.
 */

export const TODO = 'tax engine pending — Phase 3 of roadmap';

export type CostBasisMethod = 'FIFO' | 'HIFO';

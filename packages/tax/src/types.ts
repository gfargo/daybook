/**
 * Core tax engine types.
 *
 * These types are consumed by the lot tracker, cost-basis strategies,
 * the `computeTax` entry point, and the CSV exporter.
 *
 * Decimal amounts are stored as `string` and converted to `Decimal`
 * at math boundaries — never JavaScript floating-point.
 */

// ─────────────────────────────────────────────────────────────────────────
// Lot
// ─────────────────────────────────────────────────────────────────────────

/**
 * A record of an asset acquisition.
 *
 * Created when the tax engine processes a buy, income event, or
 * inbound trade leg. Consumed (fully or partially) when the engine
 * processes a sell, outbound trade leg, or fee disposal.
 */
export interface Lot {
  /** Unique identifier for this lot. */
  id: string;
  /** Ticker symbol (e.g. 'ETH', 'BTC'). */
  asset: string;
  /** Remaining amount in this lot. Decimal string, always positive. */
  amount: string;
  /** Cost per unit in USD at acquisition time. Decimal string. */
  unitCostUsd: string;
  /** When this lot was acquired. */
  acquiredAt: Date;
  /** The LedgerEntry.id that created this lot. */
  sourceEntryId: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Disposal result
// ─────────────────────────────────────────────────────────────────────────

/**
 * The result of disposing (selling) an asset from the lot book.
 *
 * One DisposalResult per disposal event. Contains the gain/loss
 * calculation and references to the lots that were consumed.
 */
export interface DisposalResult {
  /** Ticker symbol of the disposed asset. */
  asset: string;
  /** Amount disposed. Decimal string. */
  amount: string;
  /** USD proceeds from the disposal. Decimal string. */
  proceeds: string;
  /** Total cost basis of the lots consumed. Decimal string. */
  costBasis: string;
  /** Gain or loss (proceeds - costBasis). Decimal string. */
  gainLoss: string;
  /** Holding period classification. */
  term: 'short-term' | 'long-term';
  /** Earliest acquisition date among consumed lots. */
  acquiredAt: Date;
  /** When the disposal occurred. */
  disposedAt: Date;
  /** The LedgerEntry.id that triggered this disposal. */
  sourceEntryId: string;
  /** Details of each lot (or partial lot) consumed. */
  lotsConsumed: Array<{ lotId: string; amount: string; costBasis: string }>;
  /**
   * Whether this disposal may be subject to wash-sale rules.
   *
   * `true` when the same asset was acquired within ±30 calendar days
   * of the disposal date and the disposal resulted in a loss.
   * Informational only — no disallowance is computed.
   */
  washSaleFlag: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// Income summary
// ─────────────────────────────────────────────────────────────────────────

/**
 * Summary of all income events in a tax year.
 *
 * Staking rewards, learn-and-earn, inflation rewards — all taxable
 * as ordinary income at fair market value at receipt.
 */
export interface IncomeSummary {
  /** Total income in USD. Decimal string. */
  totalUsd: string;
  /** Income broken down by asset ticker. */
  byAsset: Record<string, string>;
  /** Individual income events for the detail view. */
  events: Array<{
    entryId: string;
    asset: string;
    amount: string;
    usdValue: string;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────
// Tax result
// ─────────────────────────────────────────────────────────────────────────

/**
 * The complete output of a tax computation for one year.
 *
 * Produced by `computeTax()`, consumed by the CSV exporter and
 * the `compare` command.
 */
export interface TaxResult {
  /** The tax year this result covers. */
  year: number;
  /** Which cost-basis method was used (e.g. 'FIFO', 'HIFO'). */
  method: string;
  /** All disposal events with gain/loss calculations. */
  disposals: DisposalResult[];
  /** Income summary at FMV. */
  income: IncomeSummary;
  /** Warnings (e.g. insufficient basis, unusual patterns). */
  warnings: string[];
  /** LedgerEntry IDs that could not be priced. */
  unpricedEvents: string[];
}

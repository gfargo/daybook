/**
 * IRS Schedule D — Capital Gains and Losses.
 *
 * Converts a `TaxResult` into structured Schedule D data and renders
 * it as a filled PDF using the official IRS fillable template.
 *
 * Schedule D summarises the totals from Form 8949:
 *   - Part I line 1a = short-term totals (proceeds, cost basis, gain/loss)
 *   - Part I line 7  = net short-term capital gain or loss
 *   - Part II line 8a = long-term totals (proceeds, cost basis, gain/loss)
 *   - Part II line 15 = net long-term capital gain or loss
 *
 * Lines not computable from daybook data (carryover losses, 28% rate
 * gains, unrecaptured §1250 gains, etc.) are left blank — not zero.
 *
 * @see Requirements 2.1–2.7
 */

import { PDFDocument } from 'pdf-lib';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Decimal from 'decimal.js';
import type { TaxResult } from './types.js';
import { formatMoney } from './format-helpers.js';

// ─── Constants ───────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the IRS Schedule D fillable PDF template. */
const TEMPLATE_PATH = resolve(__dirname, 'templates', 'f1040sd.pdf');

// ─── Types ───────────────────────────────────────────────────────────────

/**
 * Structured Schedule D data.
 *
 * Contains only the lines computable from daybook disposal data.
 * All other Schedule D lines are left blank in the rendered PDF.
 */
export interface ScheduleDData {
  /** Tax year. */
  year: number;
  /** Part I line 1a: short-term totals from Form 8949. */
  line1a: { proceeds: string; costBasis: string; gainLoss: string };
  /** Part I line 7: net short-term capital gain or loss. */
  line7: string;
  /** Part II line 8a: long-term totals from Form 8949. */
  line8a: { proceeds: string; costBasis: string; gainLoss: string };
  /** Part II line 15: net long-term capital gain or loss. */
  line15: string;
}

// ─── AcroForm field mapping ──────────────────────────────────────────────

/**
 * Schedule D PDF field names for the lines we populate.
 *
 * Row1a (line 1a): 4 columns — (d) proceeds, (e) cost basis,
 *   (g) adjustments (unused), (h) gain/loss
 * Row8a (line 8a): same layout on Part II
 * Line 7 and line 15 are standalone text fields.
 *
 * Field numbering determined by inspecting the IRS template AcroForm.
 */
const FIELDS = {
  // Part I — Short-Term Capital Gains and Losses
  line1a: {
    proceeds: 'topmostSubform[0].Page1[0].Table_PartI[0].Row1a[0].f1_3[0]',
    costBasis: 'topmostSubform[0].Page1[0].Table_PartI[0].Row1a[0].f1_4[0]',
    gainLoss: 'topmostSubform[0].Page1[0].Table_PartI[0].Row1a[0].f1_6[0]',
  },
  line7: 'topmostSubform[0].Page1[0].f1_22[0]',

  // Part II — Long-Term Capital Gains and Losses
  line8a: {
    proceeds: 'topmostSubform[0].Page1[0].Table_PartII[0].Row8a[0].f1_23[0]',
    costBasis: 'topmostSubform[0].Page1[0].Table_PartII[0].Row8a[0].f1_24[0]',
    gainLoss: 'topmostSubform[0].Page1[0].Table_PartII[0].Row8a[0].f1_26[0]',
  },
  line15: 'topmostSubform[0].Page1[0].f1_43[0]',
} as const;

// ─── Data builder ────────────────────────────────────────────────────────

/**
 * Build Schedule D data from a TaxResult.
 *
 * Aggregates short-term and long-term disposal totals. Line 7 equals
 * the net short-term gain/loss (same as line 1a gain/loss when only
 * daybook data is present). Line 15 equals the net long-term gain/loss.
 *
 * @param result - The complete tax computation result.
 * @returns Structured Schedule D data ready for PDF rendering.
 */
export function buildScheduleDData(result: TaxResult): ScheduleDData {
  let stProceeds = new Decimal(0);
  let stCostBasis = new Decimal(0);
  let stGainLoss = new Decimal(0);

  let ltProceeds = new Decimal(0);
  let ltCostBasis = new Decimal(0);
  let ltGainLoss = new Decimal(0);

  for (const d of result.disposals) {
    if (d.term === 'short-term') {
      stProceeds = stProceeds.plus(new Decimal(d.proceeds));
      stCostBasis = stCostBasis.plus(new Decimal(d.costBasis));
      stGainLoss = stGainLoss.plus(new Decimal(d.gainLoss));
    } else {
      ltProceeds = ltProceeds.plus(new Decimal(d.proceeds));
      ltCostBasis = ltCostBasis.plus(new Decimal(d.costBasis));
      ltGainLoss = ltGainLoss.plus(new Decimal(d.gainLoss));
    }
  }

  return {
    year: result.year,
    line1a: {
      proceeds: formatMoney(stProceeds.toFixed(2)),
      costBasis: formatMoney(stCostBasis.toFixed(2)),
      gainLoss: formatMoney(stGainLoss.toFixed(2)),
    },
    line7: formatMoney(stGainLoss.toFixed(2)),
    line8a: {
      proceeds: formatMoney(ltProceeds.toFixed(2)),
      costBasis: formatMoney(ltCostBasis.toFixed(2)),
      gainLoss: formatMoney(ltGainLoss.toFixed(2)),
    },
    line15: formatMoney(ltGainLoss.toFixed(2)),
  };
}

// ─── PDF renderer ────────────────────────────────────────────────────────

/**
 * Load the IRS Schedule D PDF template bytes.
 *
 * @throws {Error} If the template file cannot be read.
 */
function loadTemplate(): Uint8Array {
  try {
    return readFileSync(TEMPLATE_PATH);
  } catch (err) {
    throw new Error(
      `Failed to load Schedule D template at ${TEMPLATE_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Render Schedule D data into a filled PDF.
 *
 * Loads the IRS fillable template and fills only the lines that are
 * computable from daybook data. All other lines are left blank (not
 * zero) per requirement 2.7.
 *
 * @param data - Structured Schedule D data.
 * @returns PDF bytes as Uint8Array.
 * @throws {Error} If PDF generation fails.
 */
export async function renderScheduleDPdf(data: ScheduleDData): Promise<Uint8Array> {
  const templateBytes = loadTemplate();

  try {
    const doc = await PDFDocument.load(templateBytes);
    const form = doc.getForm();

    // ── Part I line 1a (short-term totals) ────────────────────────
    form.getTextField(FIELDS.line1a.proceeds).setText(data.line1a.proceeds);
    form.getTextField(FIELDS.line1a.costBasis).setText(data.line1a.costBasis);
    form.getTextField(FIELDS.line1a.gainLoss).setText(data.line1a.gainLoss);

    // ── Part I line 7 (net short-term) ────────────────────────────
    form.getTextField(FIELDS.line7).setText(data.line7);

    // ── Part II line 8a (long-term totals) ────────────────────────
    form.getTextField(FIELDS.line8a.proceeds).setText(data.line8a.proceeds);
    form.getTextField(FIELDS.line8a.costBasis).setText(data.line8a.costBasis);
    form.getTextField(FIELDS.line8a.gainLoss).setText(data.line8a.gainLoss);

    // ── Part II line 15 (net long-term) ───────────────────────────
    form.getTextField(FIELDS.line15).setText(data.line15);

    // Flatten the form so fields become static text
    form.flatten();

    return doc.save();
  } catch (err) {
    throw new Error(
      `Schedule D PDF generation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Convenience function ────────────────────────────────────────────────

/**
 * Convert a TaxResult directly into a Schedule D PDF.
 *
 * Combines `buildScheduleDData` and `renderScheduleDPdf` in one call.
 *
 * @param result - The complete tax computation result.
 * @returns PDF bytes as Uint8Array.
 */
export async function formatScheduleD(result: TaxResult): Promise<Uint8Array> {
  const data = buildScheduleDData(result);
  return renderScheduleDPdf(data);
}

/**
 * IRS Form 8949 — Sales and Other Dispositions of Capital Assets.
 *
 * Converts a `TaxResult` into structured Form 8949 data and renders
 * it as a filled PDF using the official IRS fillable template.
 *
 * The IRS template has two pages:
 *   - Page 1 = Part I (short-term capital gains and losses)
 *   - Page 2 = Part II (long-term capital gains and losses)
 *
 * Each part has 11 data rows. When disposals exceed 11 rows for a
 * given part, continuation sheets are produced by cloning the
 * template page and filling additional pages.
 *
 * Also provides a parser for round-trip testing: read AcroForm field
 * values back into a `Form8949Data` structure.
 *
 * @see Requirements 1.1–1.11, 6.1, 6.2, 6.3, 8.3, 8.4
 */

import { PDFDocument } from 'pdf-lib';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Decimal from 'decimal.js';
import type { TaxResult, DisposalResult } from './types.js';
import { formatIrsDate, formatMoney, formatDescription } from './format-helpers.js';

// ─── Constants ───────────────────────────────────────────────────────────

/** Maximum data rows per part on a single Form 8949 page. */
const ROWS_PER_PAGE = 11;

/** Number of columns per data row in the AcroForm table. */
const COLS_PER_ROW = 8;

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the IRS Form 8949 fillable PDF template. */
const TEMPLATE_PATH = resolve(__dirname, 'templates', 'f8949.pdf');

// ─── Types ───────────────────────────────────────────────────────────────

/**
 * Checkbox category for Form 8949 reporting.
 * A = reported on 1099-B with basis reported to IRS
 * B = reported on 1099-B without basis reported to IRS
 * C = not reported on 1099-B
 */
export type CheckboxCategory = 'A' | 'B' | 'C';

/**
 * A single row on Form 8949.
 */
export interface Form8949Row {
  /** (a) Description: "<amount> <asset>" */
  description: string;
  /** (b) Date acquired: MM/DD/YYYY */
  dateAcquired: string;
  /** (c) Date sold: MM/DD/YYYY */
  dateSold: string;
  /** (d) Proceeds: decimal with 2 places */
  proceeds: string;
  /** (e) Cost or other basis: decimal with 2 places */
  costBasis: string;
  /** (h) Gain or loss: decimal with 2 places */
  gainLoss: string;
}

/**
 * A single page of Form 8949 (up to 11 rows per part).
 */
export interface Form8949Page {
  /** Which checkbox category this page uses. */
  checkbox: CheckboxCategory;
  /** Part I rows (short-term), up to 11. */
  partI: Form8949Row[];
  /** Part II rows (long-term), up to 11. */
  partII: Form8949Row[];
  /** Column totals for Part I. */
  partITotals: { proceeds: string; costBasis: string; gainLoss: string };
  /** Column totals for Part II. */
  partIITotals: { proceeds: string; costBasis: string; gainLoss: string };
}

/**
 * Complete structured Form 8949 data.
 */
export interface Form8949Data {
  /** Tax year. */
  year: number;
  /** All pages (first page + continuation sheets). */
  pages: Form8949Page[];
}

/**
 * Options for Form 8949 generation.
 */
export interface Form8949Options {
  /**
   * Default checkbox category for any disposal not present in
   * `disposalCheckboxes`. Default: 'C'.
   */
  checkbox?: CheckboxCategory | undefined;
  /**
   * Per-disposal checkbox override, keyed by `DisposalResult.sourceEntryId`.
   *
   * When provided, disposals are grouped by their assigned checkbox and
   * separate page groups are emitted for each box category that has at
   * least one row. Disposals whose `sourceEntryId` is not present in
   * the map fall back to the `checkbox` default.
   *
   * Typical source: `classifyDisposalsForForm8949(reconciliationReport)`.
   */
  disposalCheckboxes?: Map<string, CheckboxCategory> | undefined;
}

// ─── Checkbox field mapping ──────────────────────────────────────────────

/**
 * Maps checkbox category to the AcroForm checkbox index.
 *
 * The IRS template has 6 checkboxes per part (indices 0–5).
 * For Part I (Page 1): c1_1[0]=A, c1_1[1]=B, c1_1[2]=C
 * For Part II (Page 2): c2_1[0]=D, c2_1[1]=E, c2_1[2]=F
 *
 * Categories A/B/C map to the first three checkboxes in each part.
 * D/E/F are the long-term equivalents (same checkbox index).
 */
const CHECKBOX_INDEX: Record<CheckboxCategory, number> = {
  A: 0,
  B: 1,
  C: 2,
};

// ─── Data builder ────────────────────────────────────────────────────────

/**
 * Convert a DisposalResult into a Form 8949 row.
 *
 * Validates dates before formatting. Throws with asset and
 * sourceEntryId on invalid dates.
 */
function disposalToRow(d: DisposalResult): Form8949Row {
  if (isNaN(d.acquiredAt.getTime())) {
    throw new Error(
      `Invalid acquisition date for ${d.asset} (sourceEntryId: ${d.sourceEntryId}): cannot format as MM/DD/YYYY`,
    );
  }
  if (isNaN(d.disposedAt.getTime())) {
    throw new Error(
      `Invalid disposal date for ${d.asset} (sourceEntryId: ${d.sourceEntryId}): cannot format as MM/DD/YYYY`,
    );
  }

  return {
    description: formatDescription(d.amount, d.asset),
    dateAcquired: formatIrsDate(d.acquiredAt),
    dateSold: formatIrsDate(d.disposedAt),
    proceeds: formatMoney(d.proceeds),
    costBasis: formatMoney(d.costBasis),
    gainLoss: formatMoney(d.gainLoss),
  };
}

/**
 * Compute column totals for a set of rows.
 */
function computeTotals(rows: Form8949Row[]): { proceeds: string; costBasis: string; gainLoss: string } {
  let proceeds = new Decimal(0);
  let costBasis = new Decimal(0);
  let gainLoss = new Decimal(0);

  for (const row of rows) {
    proceeds = proceeds.plus(new Decimal(row.proceeds));
    costBasis = costBasis.plus(new Decimal(row.costBasis));
    gainLoss = gainLoss.plus(new Decimal(row.gainLoss));
  }

  return {
    proceeds: proceeds.toFixed(2),
    costBasis: costBasis.toFixed(2),
    gainLoss: gainLoss.toFixed(2),
  };
}

/**
 * Split an array into chunks of a given size.
 */
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Convert a TaxResult into structured Form 8949 data.
 *
 * Splits disposals into short-term (Part I) and long-term (Part II),
 * paginates into 11-row pages, and computes per-page column totals.
 *
 * When `options.disposalCheckboxes` is provided, disposals are first
 * grouped by their assigned box (A/B/C). One page group is emitted per
 * box category that has at least one row, in the canonical order A, B,
 * C. Pages within a group are paginated independently.
 *
 * @param result - The complete tax computation result.
 * @param options - Optional generation options.
 * @returns Structured Form 8949 data ready for PDF rendering.
 */
export function buildForm8949Data(
  result: TaxResult,
  options?: Form8949Options,
): Form8949Data {
  const defaultCheckbox: CheckboxCategory = options?.checkbox ?? 'C';
  const perDisposal = options?.disposalCheckboxes;

  // If no disposals at all, return empty pages array
  if (result.disposals.length === 0) {
    return { year: result.year, pages: [] };
  }

  // Bucket disposals by their assigned checkbox category
  const buckets: Record<CheckboxCategory, DisposalResult[]> = {
    A: [],
    B: [],
    C: [],
  };

  for (const d of result.disposals) {
    const box = perDisposal?.get(d.sourceEntryId) ?? defaultCheckbox;
    buckets[box].push(d);
  }

  const pages: Form8949Page[] = [];
  const order: CheckboxCategory[] = ['A', 'B', 'C'];

  for (const box of order) {
    const disposals = buckets[box];
    if (disposals.length === 0) continue;

    const shortTermRows = disposals
      .filter((d) => d.term === 'short-term')
      .map(disposalToRow);
    const longTermRows = disposals
      .filter((d) => d.term === 'long-term')
      .map(disposalToRow);

    if (shortTermRows.length === 0 && longTermRows.length === 0) continue;

    const shortTermPages = shortTermRows.length > 0
      ? chunk(shortTermRows, ROWS_PER_PAGE)
      : [[]];
    const longTermPages = longTermRows.length > 0
      ? chunk(longTermRows, ROWS_PER_PAGE)
      : [[]];

    const pageCount = Math.max(shortTermPages.length, longTermPages.length);
    for (let i = 0; i < pageCount; i++) {
      const partI = shortTermPages[i] ?? [];
      const partII = longTermPages[i] ?? [];

      pages.push({
        checkbox: box,
        partI,
        partII,
        partITotals: computeTotals(partI),
        partIITotals: computeTotals(partII),
      });
    }
  }

  return { year: result.year, pages };
}

// ─── PDF field name helpers ──────────────────────────────────────────────

/**
 * Build the AcroForm field name for a Part I (Page 1) data row cell.
 *
 * Row numbering: Row1–Row11 (1-indexed).
 * Field numbering: f1_03 through f1_90 (8 fields per row).
 *   Row 1: f1_03..f1_10, Row 2: f1_11..f1_18, ..., Row 11: f1_83..f1_90
 */
function partIFieldName(rowIndex: number, colIndex: number): string {
  // rowIndex is 0-based, colIndex is 0-based (0–7)
  const fieldNum = 3 + rowIndex * COLS_PER_ROW + colIndex;
  const padded = String(fieldNum).padStart(2, '0');
  return `topmostSubform[0].Page1[0].Table_Line1_Part1[0].Row${rowIndex + 1}[0].f1_${padded}[0]`;
}

/**
 * Build the AcroForm field name for a Part II (Page 2) data row cell.
 *
 * Same pattern as Part I but on Page2 with f2_ prefix.
 */
function partIIFieldName(rowIndex: number, colIndex: number): string {
  const fieldNum = 3 + rowIndex * COLS_PER_ROW + colIndex;
  const padded = String(fieldNum).padStart(2, '0');
  return `topmostSubform[0].Page2[0].Table_Line1_Part2[0].Row${rowIndex + 1}[0].f2_${padded}[0]`;
}

/**
 * Column indices for the 8 columns in each row.
 *
 * (a) Description, (b) Date acquired, (c) Date sold,
 * (d) Proceeds, (e) Cost basis, (f) Adjustment code,
 * (g) Adjustment amount, (h) Gain or loss
 */
const COL = {
  DESCRIPTION: 0,
  DATE_ACQUIRED: 1,
  DATE_SOLD: 2,
  PROCEEDS: 3,
  COST_BASIS: 4,
  ADJ_CODE: 5,
  ADJ_AMOUNT: 6,
  GAIN_LOSS: 7,
} as const;

/**
 * Part I totals field names.
 * f1_91 = proceeds total, f1_92 = cost basis total,
 * f1_93 = adjustment code (unused), f1_94 = adjustment amount (unused),
 * f1_95 = gain/loss total
 */
const PART_I_TOTALS = {
  proceeds: 'topmostSubform[0].Page1[0].f1_91[0]',
  costBasis: 'topmostSubform[0].Page1[0].f1_92[0]',
  gainLoss: 'topmostSubform[0].Page1[0].f1_95[0]',
} as const;

/**
 * Part II totals field names.
 */
const PART_II_TOTALS = {
  proceeds: 'topmostSubform[0].Page2[0].f2_91[0]',
  costBasis: 'topmostSubform[0].Page2[0].f2_92[0]',
  gainLoss: 'topmostSubform[0].Page2[0].f2_95[0]',
} as const;

// ─── PDF renderer ────────────────────────────────────────────────────────

/**
 * Load the IRS Form 8949 PDF template bytes.
 *
 * @throws {Error} If the template file cannot be read.
 */
function loadTemplate(): Uint8Array {
  try {
    return readFileSync(TEMPLATE_PATH);
  } catch (err) {
    throw new Error(
      `Failed to load Form 8949 template at ${TEMPLATE_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Fill a single row in the PDF form.
 */
function fillRow(
  form: ReturnType<PDFDocument['getForm']>,
  fieldNameFn: (rowIndex: number, colIndex: number) => string,
  rowIndex: number,
  row: Form8949Row,
): void {
  form.getTextField(fieldNameFn(rowIndex, COL.DESCRIPTION)).setText(row.description);
  form.getTextField(fieldNameFn(rowIndex, COL.DATE_ACQUIRED)).setText(row.dateAcquired);
  form.getTextField(fieldNameFn(rowIndex, COL.DATE_SOLD)).setText(row.dateSold);
  form.getTextField(fieldNameFn(rowIndex, COL.PROCEEDS)).setText(row.proceeds);
  form.getTextField(fieldNameFn(rowIndex, COL.COST_BASIS)).setText(row.costBasis);
  form.getTextField(fieldNameFn(rowIndex, COL.GAIN_LOSS)).setText(row.gainLoss);
}

/**
 * Fill totals fields in the PDF form.
 */
function fillTotals(
  form: ReturnType<PDFDocument['getForm']>,
  totalsFields: { proceeds: string; costBasis: string; gainLoss: string },
  totals: { proceeds: string; costBasis: string; gainLoss: string },
): void {
  form.getTextField(totalsFields.proceeds).setText(totals.proceeds);
  form.getTextField(totalsFields.costBasis).setText(totals.costBasis);
  form.getTextField(totalsFields.gainLoss).setText(totals.gainLoss);
}

/**
 * Check a checkbox in the PDF form.
 *
 * The IRS template uses checkbox arrays: c1_1[0..5] for Part I,
 * c2_1[0..5] for Part II. Index 0=A, 1=B, 2=C.
 */
function checkCheckbox(
  form: ReturnType<PDFDocument['getForm']>,
  pagePrefix: string,
  checkboxPrefix: string,
  category: CheckboxCategory,
): void {
  const index = CHECKBOX_INDEX[category];
  const fieldName = `topmostSubform[0].${pagePrefix}.${checkboxPrefix}[${index}]`;
  form.getCheckBox(fieldName).check();
}

/** Render options. */
export interface RenderOptions {
  /**
   * Whether to flatten form fields into static page content. Default
   * `true` — this is required for IRS-acceptable filing because some
   * PDF readers won't render unflattened AcroForm content correctly.
   *
   * Pass `false` only for tests that need to round-trip the data via
   * `parseForm8949Pdf`. Flattened PDFs have no live form fields, so
   * the parser cannot read them back.
   */
  flatten?: boolean;
}

/**
 * Render Form 8949 data into a filled PDF.
 *
 * For the first page, fills the original template. For continuation
 * sheets, creates a new PDF document from the template for each
 * additional page and merges them.
 *
 * @param data - Structured Form 8949 data.
 * @param options - Optional render options (see `RenderOptions`).
 * @returns PDF bytes as Uint8Array.
 * @throws {Error} If PDF generation fails.
 */
export async function renderForm8949Pdf(
  data: Form8949Data,
  options: RenderOptions = {},
): Promise<Uint8Array> {
  const flatten = options.flatten ?? true;

  if (data.pages.length === 0) {
    // Return an empty template with no data filled
    const templateBytes = loadTemplate();
    const doc = await PDFDocument.load(templateBytes);
    return doc.save();
  }

  const templateBytes = loadTemplate();

  try {
    // Create the output document from the first page's template
    const outputDoc = await PDFDocument.create();

    for (let pageIdx = 0; pageIdx < data.pages.length; pageIdx++) {
      const page = data.pages[pageIdx]!;

      // Load a fresh template for each page pair (Part I + Part II)
      const templateDoc = await PDFDocument.load(templateBytes);
      const form = templateDoc.getForm();

      // ── Fill Part I (Page 1) ──────────────────────────────────────
      checkCheckbox(form, 'Page1[0]', 'c1_1', page.checkbox);

      for (let r = 0; r < page.partI.length; r++) {
        fillRow(form, partIFieldName, r, page.partI[r]!);
      }

      if (page.partI.length > 0) {
        fillTotals(form, PART_I_TOTALS, page.partITotals);
      }

      // ── Fill Part II (Page 2) ─────────────────────────────────────
      checkCheckbox(form, 'Page2[0]', 'c2_1', page.checkbox);

      for (let r = 0; r < page.partII.length; r++) {
        fillRow(form, partIIFieldName, r, page.partII[r]!);
      }

      if (page.partII.length > 0) {
        fillTotals(form, PART_II_TOTALS, page.partIITotals);
      }

      if (flatten) {
        // Flatten the form so fields become static text
        form.flatten();
      }

      // Copy both pages into the output document
      const [p1, p2] = await outputDoc.copyPages(templateDoc, [0, 1]);
      outputDoc.addPage(p1!);
      outputDoc.addPage(p2!);
    }

    return outputDoc.save();
  } catch (err) {
    throw new Error(
      `Form 8949 PDF generation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Render Form 8949 data as one PDF per checkbox category.
 *
 * The IRS prefers separate Form 8949 filings per checkbox category
 * (A/B/C and their long-term equivalents D/E/F), so when a
 * reconciliation produces disposals in multiple boxes this mode emits
 * one file per box instead of a single merged PDF.
 *
 * Returns a Map keyed by the checkbox categories present in `data`.
 * Boxes with no disposals are omitted. The Map preserves canonical
 * A→B→C insertion order.
 *
 * @param data - Structured Form 8949 data (typically built with a
 *               `disposalCheckboxes` map from a 1099-DA reconciliation).
 * @param options - Optional render options forwarded to `renderForm8949Pdf`.
 * @returns Map from checkbox category to that box's PDF bytes.
 */
export async function renderForm8949PdfPerBox(
  data: Form8949Data,
  options: RenderOptions = {},
): Promise<Map<CheckboxCategory, Uint8Array>> {
  const grouped = new Map<CheckboxCategory, Form8949Page[]>();
  for (const page of data.pages) {
    const existing = grouped.get(page.checkbox);
    if (existing) existing.push(page);
    else grouped.set(page.checkbox, [page]);
  }

  const out = new Map<CheckboxCategory, Uint8Array>();
  // Emit in canonical A → B → C order regardless of input order.
  for (const box of ['A', 'B', 'C'] as const) {
    const pages = grouped.get(box);
    if (!pages || pages.length === 0) continue;
    const subData: Form8949Data = { year: data.year, pages };
    out.set(box, await renderForm8949Pdf(subData, options));
  }
  return out;
}

// ─── PDF parser (for round-trip testing) ─────────────────────────────────

/**
 * Read a text field value from a PDF form, returning empty string if blank.
 */
function readTextField(
  form: ReturnType<PDFDocument['getForm']>,
  fieldName: string,
): string {
  try {
    return form.getTextField(fieldName).getText() ?? '';
  } catch {
    return '';
  }
}

/**
 * Detect which checkbox category is checked on a page.
 */
function detectCheckbox(
  form: ReturnType<PDFDocument['getForm']>,
  pagePrefix: string,
  checkboxPrefix: string,
): CheckboxCategory {
  for (const [category, index] of Object.entries(CHECKBOX_INDEX)) {
    const fieldName = `topmostSubform[0].${pagePrefix}.${checkboxPrefix}[${index}]`;
    try {
      if (form.getCheckBox(fieldName).isChecked()) {
        return category as CheckboxCategory;
      }
    } catch {
      // Field doesn't exist on this page, skip
    }
  }
  return 'C'; // Default
}

/**
 * Parse a Form 8949 PDF back into structured data.
 *
 * Used for round-trip testing of `renderForm8949Pdf` output. The PDF
 * must have been rendered with `{ flatten: false }` — the default
 * (`flatten: true`) bakes form fields into static content and cannot
 * be parsed back.
 *
 * **Multi-page limitation:** for multi-page PDFs (continuation sheets
 * or per-checkbox page groups), pdf-lib renames duplicated form fields
 * during `copyPages`, so this parser currently only reads the first
 * logical page-pair correctly. Multi-page round-trip is a known gap.
 *
 * @param pdf - PDF bytes to parse.
 * @returns Structured Form 8949 data (first logical page-pair only).
 */
export async function parseForm8949Pdf(pdf: Uint8Array): Promise<Form8949Data> {
  const doc = await PDFDocument.load(pdf);
  const form = doc.getForm();
  const totalPages = doc.getPageCount();

  // Each "logical page" is 2 PDF pages (Part I + Part II)
  const logicalPageCount = Math.floor(totalPages / 2);
  const pages: Form8949Page[] = [];

  for (let lp = 0; lp < logicalPageCount; lp++) {
    // Detect checkbox
    const checkbox = detectCheckbox(form, 'Page1[0]', 'c1_1');

    // Read Part I rows
    const partI: Form8949Row[] = [];
    for (let r = 0; r < ROWS_PER_PAGE; r++) {
      const desc = readTextField(form, partIFieldName(r, COL.DESCRIPTION));
      if (!desc) break; // Empty row = end of data

      partI.push({
        description: desc,
        dateAcquired: readTextField(form, partIFieldName(r, COL.DATE_ACQUIRED)),
        dateSold: readTextField(form, partIFieldName(r, COL.DATE_SOLD)),
        proceeds: readTextField(form, partIFieldName(r, COL.PROCEEDS)),
        costBasis: readTextField(form, partIFieldName(r, COL.COST_BASIS)),
        gainLoss: readTextField(form, partIFieldName(r, COL.GAIN_LOSS)),
      });
    }

    // Read Part I totals
    const partITotals = {
      proceeds: readTextField(form, PART_I_TOTALS.proceeds),
      costBasis: readTextField(form, PART_I_TOTALS.costBasis),
      gainLoss: readTextField(form, PART_I_TOTALS.gainLoss),
    };

    // Read Part II rows
    const partII: Form8949Row[] = [];
    for (let r = 0; r < ROWS_PER_PAGE; r++) {
      const desc = readTextField(form, partIIFieldName(r, COL.DESCRIPTION));
      if (!desc) break;

      partII.push({
        description: desc,
        dateAcquired: readTextField(form, partIIFieldName(r, COL.DATE_ACQUIRED)),
        dateSold: readTextField(form, partIIFieldName(r, COL.DATE_SOLD)),
        proceeds: readTextField(form, partIIFieldName(r, COL.PROCEEDS)),
        costBasis: readTextField(form, partIIFieldName(r, COL.COST_BASIS)),
        gainLoss: readTextField(form, partIIFieldName(r, COL.GAIN_LOSS)),
      });
    }

    // Read Part II totals
    const partIITotals = {
      proceeds: readTextField(form, PART_II_TOTALS.proceeds),
      costBasis: readTextField(form, PART_II_TOTALS.costBasis),
      gainLoss: readTextField(form, PART_II_TOTALS.gainLoss),
    };

    // Only add page if it has data
    if (partI.length > 0 || partII.length > 0) {
      pages.push({ checkbox, partI, partII, partITotals, partIITotals });
    }
  }

  // Infer year from the first page (not stored in form fields)
  return { year: 0, pages };
}

// ─── Convenience function ────────────────────────────────────────────────

/**
 * Convert a TaxResult directly into a Form 8949 PDF.
 *
 * Combines `buildForm8949Data` and `renderForm8949Pdf` in one call.
 *
 * @param result - The complete tax computation result.
 * @param options - Optional generation options.
 * @returns PDF bytes as Uint8Array.
 */
export async function formatForm8949(
  result: TaxResult,
  options?: Form8949Options & RenderOptions,
): Promise<Uint8Array> {
  const data = buildForm8949Data(result, options);
  const renderOpts: RenderOptions = {};
  if (options?.flatten !== undefined) renderOpts.flatten = options.flatten;
  return renderForm8949Pdf(data, renderOpts);
}

// ─── Exported constant for testing ───────────────────────────────────────

/** Maximum rows per part per page (exported for test assertions). */
export { ROWS_PER_PAGE };

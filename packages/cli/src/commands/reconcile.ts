/**
 * `daybook reconcile <year> --1099da <file>` — reconcile daybook disposals
 * against a 1099-DA from an exchange or broker.
 *
 * Workflow:
 *   1. Parse and validate the year argument
 *   2. Load config, open DB, create repo
 *   3. Load LedgerEntries for the specified year (plus prior history for lot tracking)
 *   4. Hydrate USD prices using the same pricing chain as `export`
 *   5. Run computeTax with the configured or specified cost-basis method
 *   6. Parse the 1099-DA CSV
 *   7. Reconcile daybook disposals against the 1099-DA
 *   8. Print a text report (or JSON), optionally write to --output
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createRepo, openDatabase } from '@daybook/ledger';
import {
  computeTax,
  parse1099DaCsv,
  reconcile,
  formatReconciliationReport,
  FIFO,
  HIFO,
  LIFO,
} from '@daybook/tax';
import type { CostBasisStrategy } from '@daybook/tax';
import { expandPath, loadConfig } from '../config.js';
import { buildPricingChain, hydratePrices } from '../pricing-chain.js';

// ─────────────────────────────────────────────────────────────────────────
// Command interface
// ─────────────────────────────────────────────────────────────────────────

export interface ReconcileOptions {
  '1099da': string;
  method?: string;
  format?: string;
  output?: string;
  issuer?: string;
  config?: string;
  dateTolerance?: string;
  amountTolerance?: string;
  moneyTolerance?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function resolveMethod(flag: string | undefined, configDefault: string): CostBasisStrategy {
  const raw = (flag ?? configDefault).toLowerCase().replace(/[\s_]/g, '-');
  switch (raw) {
    case 'fifo':
      return FIFO;
    case 'hifo':
      return HIFO;
    case 'lifo':
      return LIFO;
    case 'specific-id':
      throw new Error(
        'Specific ID is not supported for reconciliation. Use FIFO, HIFO, or LIFO.',
      );
    default:
      throw new Error(
        `Unknown cost-basis method: "${flag ?? configDefault}". Supported: FIFO, HIFO, LIFO.`,
      );
  }
}

function parseFloatOption(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid --${name}: "${value}". Provide a non-negative number.`);
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────────
// Command handler
// ─────────────────────────────────────────────────────────────────────────

/** Handler for `daybook reconcile <year> --1099da <file>`. */
export async function reconcileCommand(
  year: string,
  opts: ReconcileOptions,
): Promise<void> {
  // 1. Parse and validate year
  const yearNum = Number(year);
  if (!Number.isInteger(yearNum) || yearNum < 2000 || yearNum > 2100) {
    throw new Error(`Invalid year: "${year}". Provide a four-digit year (e.g. 2025).`);
  }

  if (!opts['1099da']) {
    throw new Error('Missing required option: --1099da <path-to-csv>.');
  }

  // 2. Load config, open DB, create repo
  const config = loadConfig(opts.config);
  const db = openDatabase(expandPath(config.dbPath));
  const repo = createRepo(db.raw);

  try {
    // 3. Load entries for the target year + prior history for lot tracking
    const allEntries = repo.getLedgerEntries({ limit: 1 });
    if (allEntries.length === 0) {
      throw new Error('No classified events found. Run `daybook classify` first.');
    }

    const yearEntries = repo.getLedgerEntries({ year: yearNum });
    if (yearEntries.length === 0) {
      console.log(`No ledger entries found for ${yearNum}. Nothing to reconcile.`);
      return;
    }

    const allEntriesForLots = repo.getLedgerEntries({ limit: 1_000_000 });
    const yearStart = new Date(`${yearNum}-01-01T00:00:00Z`);
    const priorEntries = allEntriesForLots.filter((e) => e.timestamp < yearStart);

    // 4. Set up pricing chain and hydrate USD prices
    const pricingChain = buildPricingChain(db, config);
    const allHydratedEntries = [...priorEntries, ...yearEntries];
    await hydratePrices(allHydratedEntries, pricingChain);

    // 5. Compute tax
    const strategy = resolveMethod(opts.method, config.tax.costBasisMethod);
    const taxResult = computeTax(allHydratedEntries, {
      method: strategy,
      holdingPeriodDays: 365,
      year: yearNum,
    });

    // 6. Parse 1099-DA CSV
    const csv = readFileSync(opts['1099da'], 'utf-8');
    const form1099Da = parse1099DaCsv(csv, {
      year: yearNum,
      ...(opts.issuer ? { issuer: opts.issuer } : {}),
    });

    if (form1099Da.transactions.length === 0) {
      console.log(`No transactions parsed from ${opts['1099da']}.`);
      if (form1099Da.warnings.length > 0) {
        console.log(`\nWarnings (${form1099Da.warnings.length}):`);
        for (const w of form1099Da.warnings.slice(0, 20)) {
          console.log(`  - ${w}`);
        }
      }
      return;
    }

    // 7. Reconcile
    const reconcileOpts: Parameters<typeof reconcile>[2] = {};
    const dateTol = parseFloatOption('date-tolerance', opts.dateTolerance);
    if (dateTol !== undefined) reconcileOpts.dateToleranceDays = dateTol;
    const amountTol = parseFloatOption('amount-tolerance', opts.amountTolerance);
    if (amountTol !== undefined) reconcileOpts.amountTolerance = amountTol;
    const moneyTol = parseFloatOption('money-tolerance', opts.moneyTolerance);
    if (moneyTol !== undefined) reconcileOpts.moneyTolerance = moneyTol;

    const report = reconcile(taxResult.disposals, form1099Da, reconcileOpts);

    // 8. Output
    const format = (opts.format ?? 'text').toLowerCase();
    let output: string;
    if (format === 'json') {
      output = JSON.stringify(report, null, 2);
    } else if (format === 'text') {
      output = formatReconciliationReport(report);
    } else {
      throw new Error(`Unsupported format: "${opts.format}". Supported: text, json.`);
    }

    if (opts.output) {
      writeFileSync(opts.output, output, 'utf-8');
      console.log(`Reconciliation report written to: ${opts.output}`);
      console.log('');
      console.log(
        `Recommended Form 8949 checkbox: ${report.recommendedCheckbox} — ` +
          `${report.recommendedCheckboxReason}`,
      );
    } else {
      console.log(output);
    }
  } finally {
    db.close();
  }
}

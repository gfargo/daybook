/**
 * `daybook overrides` — manage manual price overrides.
 *
 * Subcommands:
 *   set <asset> <date> <price>  — insert or update a price override
 *   list                        — display all overrides in a formatted table
 *   remove <id>                 — delete an override by ID
 *
 * Price overrides are the last-resort pricing source for tokens that no
 * automated API covers. They live in the `price_overrides` SQLite table
 * and are consumed by the ManualOverrideProvider in the pricing chain.
 */

import { createRepo, openDatabase } from '@daybook/ledger';
import type { PriceOverride } from '@daybook/ledger';
import { expandPath, loadConfig } from '../config.js';
import { renderOverridesList } from './OverridesList.js';
import { writeJson } from '../ui/index.js';

// ─────────────────────────────────────────────────────────────────────────
// Command interfaces
// ─────────────────────────────────────────────────────────────────────────

export interface OverridesSetOptions {
  config?: string;
  note?: string;
}

export interface OverridesListOptions {
  config?: string;
  format?: string;
}

export interface OverridesRemoveOptions {
  config?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse a YYYY-MM-DD date string and return unix seconds at 00:00 UTC.
 *
 * @param dateStr - Date in YYYY-MM-DD format.
 * @returns Unix seconds at midnight UTC.
 * @throws If the date string is not valid YYYY-MM-DD.
 */
function parseDateToDay(dateStr: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) {
    throw new Error(
      `Invalid date format: "${dateStr}". Use YYYY-MM-DD (e.g. 2024-03-15).`,
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // Validate ranges
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(
      `Invalid date: "${dateStr}". Month must be 1–12, day must be 1–31.`,
    );
  }

  const d = new Date(Date.UTC(year, month - 1, day));

  // Verify the date didn't roll over (e.g. Feb 30 → Mar 2)
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    throw new Error(`Invalid date: "${dateStr}" does not exist.`);
  }

  return Math.floor(d.getTime() / 1000);
}

// ─────────────────────────────────────────────────────────────────────────
// Command handlers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Handler for `daybook overrides set <asset> <date> <price>`.
 *
 * Parses the asset (uppercased), date (YYYY-MM-DD → unix seconds at 00:00 UTC),
 * and price (decimal string). Generates a deterministic ID and inserts or
 * updates the row in the price_overrides table.
 */
export async function overridesSetCommand(
  asset: string,
  date: string,
  price: string,
  opts: OverridesSetOptions,
): Promise<void> {
  // 1. Validate inputs
  const normalizedAsset = asset.toUpperCase();

  const day = parseDateToDay(date);

  // Validate price is a valid positive decimal
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum) || priceNum < 0) {
    throw new Error(
      `Invalid price: "${price}". Provide a non-negative decimal number (e.g. 0.0042).`,
    );
  }

  // 2. Load config, open DB, create repo
  const config = loadConfig(opts.config);
  const db = openDatabase(expandPath(config.dbPath));
  const repo = createRepo(db.raw);

  try {
    // 3. Generate deterministic ID
    const id = `${normalizedAsset}:${day}`;

    // 4. Build override record
    const override: PriceOverride = {
      id,
      asset: normalizedAsset,
      day,
      priceUsd: price,
      createdAt: new Date(),
      ...(opts.note ? { note: opts.note } : {}),
    };

    // 5. Insert or update
    repo.insertPriceOverride(override);

    // 6. Print confirmation
    console.log(`Price override set: ${normalizedAsset} on ${date} = $${price} USD`);
    console.log(`  ID: ${id}`);
  } finally {
    db.close();
  }
}

/**
 * Handler for `daybook overrides list`.
 *
 * Loads all price overrides from the database and displays them
 * using the shared Table component via Ink.
 */
export async function overridesListCommand(
  opts: OverridesListOptions,
): Promise<void> {
  const config = loadConfig(opts.config);
  const db = openDatabase(expandPath(config.dbPath));
  const repo = createRepo(db.raw);

  try {
    const overrides = repo.getPriceOverrides();

    if (writeJson(opts.format, overrides)) {
      return;
    }

    renderOverridesList(overrides);
  } finally {
    db.close();
  }
}

/**
 * Handler for `daybook overrides remove <id>`.
 *
 * Deletes the specified price override by ID and prints confirmation.
 * Handles the "not found" case gracefully.
 */
export async function overridesRemoveCommand(
  id: string,
  opts: OverridesRemoveOptions,
): Promise<void> {
  const config = loadConfig(opts.config);
  const db = openDatabase(expandPath(config.dbPath));
  const repo = createRepo(db.raw);

  try {
    const deleted = repo.deletePriceOverride(id);

    if (deleted) {
      console.log(`Removed price override: ${id}`);
    } else {
      console.log(`No price override found with ID: ${id}`);
    }
  } finally {
    db.close();
  }
}

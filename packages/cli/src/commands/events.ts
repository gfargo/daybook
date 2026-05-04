/**
 * `daybook events count` and `daybook events list`.
 *
 * Read-only inspection of the raw_events table. Useful for verifying that a
 * sync produced the right counts and as a debugging surface.
 */

import React from 'react';
import { render } from 'ink';
import {
    createRepo,
    openDatabase,
    type LedgerEntryType,
    type RawEvent,
    type RawEventType,
    type SourceId,
} from '@daybook/ledger';
import { expandPath, loadConfig } from '../config.js';
import { EventsTable } from './EventsTable.js';
import { writeJson } from '../ui/index.js';

// ─────────────────────────────────────────────────────────────────────────
// NFT type helpers
// ─────────────────────────────────────────────────────────────────────────

/** LedgerEntryType values that require querying classified entries. */
const LEDGER_ONLY_TYPES = new Set<string>(['nft_acquisition', 'nft_disposal']);

export interface EventsCountOptions {
  account?: string;
  source?: string;
  config?: string;
  format?: string;
}

export async function eventsCountCommand(
  opts: EventsCountOptions,
): Promise<void> {
  const config = loadConfig(opts.config);
  const db = openDatabase(expandPath(config.dbPath));
  const repo = createRepo(db.raw);
  const filter = {
    ...(opts.account ? { accountId: opts.account } : {}),
    ...(opts.source ? { source: opts.source as SourceId } : {}),
  };
  const total = repo.countTotal(filter);
  const counts = repo.countByType(filter);
  db.close();

  if (writeJson(opts.format, { total, counts })) return;

  if (total === 0) {
    console.log('No events. Run `daybook sync ...` first.');
    return;
  }
  console.log(`${total} events`);
  console.log('');
  for (const { type, count } of counts) {
    console.log(`  ${(type + ':').padEnd(20)} ${count}`);
  }
}

/** Options for `daybook events list`. */
export interface EventsListOptions {
  limit: string;
  type?: string;
  source?: string;
  account?: string;
  config?: string;
  format?: string;
}

/**
 * Handler for `daybook events list`.
 *
 * Applies `--type`, `--source`, and `--account` filters via the repository
 * query, respects `--limit` (default 20), and renders the result using the
 * Ink-based EventsTable component.
 *
 * When `--type` is `nft_acquisition` or `nft_disposal`, queries classified
 * ledger entries instead of raw events, since these types only exist after
 * classification.
 */
export async function eventsListCommand(
  opts: EventsListOptions,
): Promise<void> {
  const config = loadConfig(opts.config);
  const db = openDatabase(expandPath(config.dbPath));
  const repo = createRepo(db.raw);
  const limit = Number.parseInt(opts.limit, 10);

  // NFT classified types require querying ledger entries
  if (opts.type && LEDGER_ONLY_TYPES.has(opts.type)) {
    const entries = repo.getLedgerEntries({
      type: opts.type as LedgerEntryType,
      limit,
    });
    db.close();

    // Adapt LedgerEntries to RawEvent shape for the EventsTable
    const adapted: RawEvent[] = entries.map((entry) => ({
      id: entry.id,
      source: 'eth' as SourceId,
      accountId: '',
      timestamp: entry.timestamp,
      type: entry.type as unknown as RawEventType,
      legs: entry.legs,
      ...(entry.reason ? { notes: entry.reason } : {}),
      raw: {},
    }));

    if (writeJson(opts.format, adapted)) return;

    const { unmount } = render(
      React.createElement(EventsTable, { events: adapted }),
    );
    unmount();
    return;
  }

  const events = repo.getRawEvents({
    ...(opts.type ? { type: opts.type as RawEventType } : {}),
    ...(opts.source ? { source: opts.source as SourceId } : {}),
    ...(opts.account ? { accountId: opts.account } : {}),
    limit,
  });
  db.close();

  if (writeJson(opts.format, events)) return;

  const { unmount } = render(
    React.createElement(EventsTable, { events }),
  );
  unmount();
}

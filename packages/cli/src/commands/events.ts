/**
 * `daybook events count` and `daybook events list`.
 *
 * Read-only inspection of the raw_events table. Useful for verifying that a
 * sync produced the right counts and as a debugging surface.
 */

import {
  createRepo,
  openDatabase,
  type RawEventType,
  type SourceId,
} from '@daybook/ledger';
import { expandPath, loadConfig } from '../config.js';

export interface EventsCountOptions {
  account?: string;
  source?: string;
  config?: string;
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

export interface EventsListOptions {
  limit: string;
  type?: string;
  config?: string;
}

export async function eventsListCommand(
  opts: EventsListOptions,
): Promise<void> {
  const config = loadConfig(opts.config);
  const db = openDatabase(expandPath(config.dbPath));
  const repo = createRepo(db.raw);
  const limit = Number.parseInt(opts.limit, 10);
  const events = repo.getRawEvents({
    ...(opts.type ? { type: opts.type as RawEventType } : {}),
    limit,
  });
  db.close();

  if (events.length === 0) {
    console.log('No events match. Run `daybook sync ...` or relax the filter.');
    return;
  }
  for (const e of events) {
    const ts = e.timestamp.toISOString().slice(0, 19);
    const legSummary = e.legs
      .map(l => `${l.amount} ${l.asset}${l.feeFlag ? ' (fee)' : ''}`)
      .join(' / ');
    console.log(`  [${ts}] ${e.type.padEnd(18)} ${legSummary}`);
  }
}

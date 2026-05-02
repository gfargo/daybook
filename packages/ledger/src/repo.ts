/**
 * Repository: typed read/write operations against the SQLite database.
 *
 * Design rules:
 *
 *   1. **Idempotent.** Inserting the same RawEvent twice is a no-op
 *      (INSERT OR IGNORE). Re-running an adapter against the same source
 *      data produces zero net writes.
 *
 *   2. **Atomic per-event.** A RawEvent and its legs are inserted in one
 *      transaction. Either both land or neither does.
 *
 *   3. **Batched.** insertRawEvents accepts a batch and uses a single
 *      transaction for the whole set. Important for the 1,945-event
 *      Coinbase import to land in milliseconds, not seconds.
 *
 *   4. **Round-trippable.** Reading an event back via getRawEventById
 *      returns the same RawEvent shape that was passed to insertRawEvents,
 *      modulo the loss of the original `raw` payload's shape (it's
 *      serialized to JSON and back).
 */

import type { Database as DatabaseInstance, Statement } from 'better-sqlite3';
import type {
  AccountRef,
  AssetLeg,
  RawEvent,
  RawEventType,
  SourceId,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

export interface InsertResult {
  /** Number of events newly written this call. */
  inserted: number;
  /** Number of events the DB already had (no-op on idempotent re-run). */
  skipped: number;
}

export interface RawEventFilter {
  accountId?: string;
  source?: SourceId;
  type?: RawEventType;
  /** Inclusive lower-bound timestamp (unix seconds). */
  fromTimestamp?: number;
  /** Inclusive upper-bound timestamp (unix seconds). */
  toTimestamp?: number;
  /** Default 1000. */
  limit?: number;
  offset?: number;
}

export interface CountByType {
  type: RawEventType;
  count: number;
}

export interface Repo {
  // ─── Accounts ──────────────────────────────────────────────────────
  upsertAccount(account: AccountRef): void;
  getAccount(id: string): AccountRef | null;
  listAccounts(): AccountRef[];

  // ─── Raw events (append-only) ──────────────────────────────────────
  insertRawEvents(events: ReadonlyArray<RawEvent>): InsertResult;
  getRawEventById(id: string): RawEvent | null;
  getRawEvents(filter: RawEventFilter): RawEvent[];
  countByType(filter: Omit<RawEventFilter, 'limit' | 'offset'>): CountByType[];
  countTotal(filter: Omit<RawEventFilter, 'limit' | 'offset'>): number;
}

/**
 * Build a Repo bound to an open database handle.
 * The repo prepares its statements once and reuses them.
 */
export function createRepo(db: DatabaseInstance): Repo {
  return new RepoImpl(db);
}

// ─────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────

class RepoImpl implements Repo {
  // Account statements
  private readonly upsertAccountStmt: Statement;
  private readonly getAccountStmt: Statement;
  private readonly listAccountsStmt: Statement;

  // RawEvent statements
  private readonly insertEventStmt: Statement;
  private readonly insertLegStmt: Statement;
  private readonly getEventStmt: Statement;
  private readonly getLegsStmt: Statement;

  // Bound transaction for batch insert
  private readonly insertEventsTxn: (
    events: ReadonlyArray<RawEvent>,
  ) => InsertResult;

  constructor(private readonly db: DatabaseInstance) {
    this.upsertAccountStmt = db.prepare(`
      INSERT INTO accounts (id, source, identifier, label, created_at)
      VALUES (@id, @source, @identifier, @label, @createdAt)
      ON CONFLICT(id) DO UPDATE SET
        source = excluded.source,
        identifier = excluded.identifier,
        label = excluded.label
    `);

    this.getAccountStmt = db.prepare(`
      SELECT id, source, identifier, label FROM accounts WHERE id = ?
    `);

    this.listAccountsStmt = db.prepare(`
      SELECT id, source, identifier, label FROM accounts ORDER BY id
    `);

    this.insertEventStmt = db.prepare(`
      INSERT OR IGNORE INTO raw_events
        (id, source, account_id, timestamp, type, tx_hash, log_index,
         counterparty, notes, raw_json)
      VALUES
        (@id, @source, @accountId, @timestamp, @type, @txHash, @logIndex,
         @counterparty, @notes, @rawJson)
    `);

    this.insertLegStmt = db.prepare(`
      INSERT INTO raw_event_legs
        (event_id, leg_index, asset, amount, amount_usd_at_time,
         amount_usd_reported_by_source, fee_flag, contract_address, token_id)
      VALUES
        (@eventId, @legIndex, @asset, @amount, @amountUsdAtTime,
         @amountUsdReportedBySource, @feeFlag, @contractAddress, @tokenId)
    `);

    this.getEventStmt = db.prepare(`
      SELECT id, source, account_id, timestamp, type, tx_hash, log_index,
             counterparty, notes, raw_json
      FROM raw_events WHERE id = ?
    `);

    this.getLegsStmt = db.prepare(`
      SELECT leg_index, asset, amount, amount_usd_at_time,
             amount_usd_reported_by_source, fee_flag, contract_address, token_id
      FROM raw_event_legs
      WHERE event_id = ?
      ORDER BY leg_index
    `);

    // Batched insert as a single transaction. better-sqlite3's `transaction()`
    // helper handles BEGIN/COMMIT/ROLLBACK and auto-commits per call.
    this.insertEventsTxn = db.transaction(
      (events: ReadonlyArray<RawEvent>): InsertResult => {
        let inserted = 0;
        let skipped = 0;
        for (const event of events) {
          const result = this.insertEventStmt.run({
            id: event.id,
            source: event.source,
            accountId: event.accountId,
            timestamp: Math.floor(event.timestamp.getTime() / 1000),
            type: event.type,
            txHash: event.txHash ?? null,
            logIndex: event.logIndex ?? null,
            counterparty: event.counterparty ?? null,
            notes: event.notes ?? null,
            rawJson: JSON.stringify(event.raw),
          });
          if (result.changes === 0) {
            // Row already existed — INSERT OR IGNORE made it a no-op.
            skipped++;
            continue;
          }
          inserted++;
          // Insert legs only for newly-inserted events.
          for (let i = 0; i < event.legs.length; i++) {
            const leg = event.legs[i]!;
            this.insertLegStmt.run({
              eventId: event.id,
              legIndex: i,
              asset: leg.asset,
              amount: leg.amount,
              amountUsdAtTime: leg.amountUsdAtTime ?? null,
              amountUsdReportedBySource:
                leg.amountUsdReportedBySource ?? null,
              feeFlag: leg.feeFlag ? 1 : 0,
              contractAddress: leg.contractAddress ?? null,
              tokenId: leg.tokenId ?? null,
            });
          }
        }
        return { inserted, skipped };
      },
    );
  }

  // ─── Accounts ────────────────────────────────────────────────────────
  upsertAccount(account: AccountRef): void {
    this.upsertAccountStmt.run({
      id: account.id,
      source: account.source,
      identifier: account.identifier,
      label: account.label ?? null,
      createdAt: Math.floor(Date.now() / 1000),
    });
  }

  getAccount(id: string): AccountRef | null {
    const row = this.getAccountStmt.get(id) as AccountRow | undefined;
    return row ? rowToAccount(row) : null;
  }

  listAccounts(): AccountRef[] {
    const rows = this.listAccountsStmt.all() as AccountRow[];
    return rows.map(rowToAccount);
  }

  // ─── Raw events ──────────────────────────────────────────────────────
  insertRawEvents(events: ReadonlyArray<RawEvent>): InsertResult {
    return this.insertEventsTxn(events);
  }

  getRawEventById(id: string): RawEvent | null {
    const row = this.getEventStmt.get(id) as RawEventRow | undefined;
    if (!row) return null;
    const legs = this.getLegsStmt.all(id) as RawLegRow[];
    return rowToEvent(row, legs);
  }

  getRawEvents(filter: RawEventFilter): RawEvent[] {
    const { sql, params } = buildEventQuery(filter);
    const rows = this.db.prepare(sql).all(...params) as RawEventRow[];
    return rows.map(row => {
      const legs = this.getLegsStmt.all(row.id) as RawLegRow[];
      return rowToEvent(row, legs);
    });
  }

  countByType(
    filter: Omit<RawEventFilter, 'limit' | 'offset'>,
  ): CountByType[] {
    const { sql, params } = buildCountByTypeQuery(filter);
    return this.db.prepare(sql).all(...params) as CountByType[];
  }

  countTotal(filter: Omit<RawEventFilter, 'limit' | 'offset'>): number {
    const { sql, params } = buildCountTotalQuery(filter);
    const row = this.db.prepare(sql).get(...params) as
      | { count: number }
      | undefined;
    return row?.count ?? 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Row mappers + query builders
// ─────────────────────────────────────────────────────────────────────────

interface AccountRow {
  id: string;
  source: string;
  identifier: string;
  label: string | null;
}

interface RawEventRow {
  id: string;
  source: string;
  account_id: string;
  timestamp: number;
  type: string;
  tx_hash: string | null;
  log_index: number | null;
  counterparty: string | null;
  notes: string | null;
  raw_json: string;
}

interface RawLegRow {
  leg_index: number;
  asset: string;
  amount: string;
  amount_usd_at_time: string | null;
  amount_usd_reported_by_source: string | null;
  fee_flag: number;
  contract_address: string | null;
  token_id: string | null;
}

function rowToAccount(row: AccountRow): AccountRef {
  return {
    id: row.id,
    source: row.source as SourceId,
    identifier: row.identifier,
    ...(row.label ? { label: row.label } : {}),
  };
}

function rowToEvent(row: RawEventRow, legRows: RawLegRow[]): RawEvent {
  const legs: AssetLeg[] = legRows.map(l => ({
    asset: l.asset,
    amount: l.amount,
    ...(l.amount_usd_at_time ? { amountUsdAtTime: l.amount_usd_at_time } : {}),
    ...(l.amount_usd_reported_by_source
      ? { amountUsdReportedBySource: l.amount_usd_reported_by_source }
      : {}),
    ...(l.fee_flag ? { feeFlag: true } : {}),
    ...(l.contract_address ? { contractAddress: l.contract_address } : {}),
    ...(l.token_id ? { tokenId: l.token_id } : {}),
  }));
  return {
    id: row.id,
    source: row.source as SourceId,
    accountId: row.account_id,
    timestamp: new Date(row.timestamp * 1000),
    type: row.type as RawEventType,
    legs,
    ...(row.tx_hash ? { txHash: row.tx_hash } : {}),
    ...(row.log_index !== null ? { logIndex: row.log_index } : {}),
    ...(row.counterparty ? { counterparty: row.counterparty } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
    raw: JSON.parse(row.raw_json),
  };
}

function buildWhereClause(
  filter: RawEventFilter,
): { whereSql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.accountId) {
    conditions.push('account_id = ?');
    params.push(filter.accountId);
  }
  if (filter.source) {
    conditions.push('source = ?');
    params.push(filter.source);
  }
  if (filter.type) {
    conditions.push('type = ?');
    params.push(filter.type);
  }
  if (filter.fromTimestamp !== undefined) {
    conditions.push('timestamp >= ?');
    params.push(filter.fromTimestamp);
  }
  if (filter.toTimestamp !== undefined) {
    conditions.push('timestamp <= ?');
    params.push(filter.toTimestamp);
  }
  return {
    whereSql: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '',
    params,
  };
}

function buildEventQuery(
  filter: RawEventFilter,
): { sql: string; params: unknown[] } {
  const { whereSql, params } = buildWhereClause(filter);
  const limit = filter.limit ?? 1000;
  const offset = filter.offset ?? 0;
  return {
    sql: `
      SELECT id, source, account_id, timestamp, type, tx_hash, log_index,
             counterparty, notes, raw_json
      FROM raw_events
      ${whereSql}
      ORDER BY timestamp ASC, id ASC
      LIMIT ? OFFSET ?
    `,
    params: [...params, limit, offset],
  };
}

function buildCountByTypeQuery(
  filter: RawEventFilter,
): { sql: string; params: unknown[] } {
  const { whereSql, params } = buildWhereClause(filter);
  return {
    sql: `
      SELECT type, COUNT(*) AS count
      FROM raw_events
      ${whereSql}
      GROUP BY type
      ORDER BY count DESC
    `,
    params,
  };
}

function buildCountTotalQuery(
  filter: RawEventFilter,
): { sql: string; params: unknown[] } {
  const { whereSql, params } = buildWhereClause(filter);
  return {
    sql: `SELECT COUNT(*) AS count FROM raw_events ${whereSql}`,
    params,
  };
}

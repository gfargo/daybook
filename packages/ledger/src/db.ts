/**
 * SQLite storage layer for daybook.
 *
 * Two main tables:
 *   raw_events / raw_event_legs       — append-only, immutable history
 *   ledger_entries / ledger_entry_legs — classifier output, rebuildable
 *
 * Plus:
 *   migrations             — schema version tracking
 *   accounts               — user's configured accounts
 *   classifier_overrides   — user's manual corrections
 *   prices                 — cached USD prices, keyed by (asset, timestamp)
 *
 * The schema is in migrations/001_initial.sql and applied automatically
 * by openDatabase().
 */

import Database, { type Database as DatabaseInstance } from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DatabaseHandle {
  /** Underlying better-sqlite3 instance. Use for direct queries. */
  raw: DatabaseInstance;
  /** Close the database. Idempotent. */
  close(): void;
}

/**
 * Open or create the SQLite database at the given path.
 *
 * Applies any pending migrations automatically.
 *
 * @param path - Filesystem path to the .db file. Use `:memory:` for tests.
 */
export function openDatabase(path: string): DatabaseHandle {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  applyMigrations(db);

  return {
    raw: db,
    close: () => db.close(),
  };
}

function applyMigrations(db: DatabaseInstance): void {
  // Ensure migrations table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT id FROM migrations').all() as { id: string }[]).map(r => r.id),
  );

  const migrations = [
    { id: '001_initial', file: 'migrations/001_initial.sql' },
    { id: '002_price_overrides', file: 'migrations/002_price_overrides.sql' },
    { id: '003_sync_state', file: 'migrations/003_sync_state.sql' },
    // Future migrations append here.
  ];

  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    const sql = readFileSync(join(__dirname, m.file), 'utf-8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)').run(
        m.id,
        Date.now(),
      );
    })();
  }
}

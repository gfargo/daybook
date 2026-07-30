/**
 * Repository tests run against an in-memory SQLite database.
 *
 * Each test creates a fresh DB so they don't interfere.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RawEvent } from './types.js';
import { openDatabase, type DatabaseHandle } from './db.js';
import { createRepo, type Repo } from './repo.js';

let dbHandle: DatabaseHandle;
let repo: Repo;

beforeEach(() => {
  dbHandle = openDatabase(':memory:');
  repo = createRepo(dbHandle.raw);
});

afterEach(() => {
  dbHandle.close();
});

// ─── Test fixtures ───────────────────────────────────────────────────────

function fixtureAccount() {
  return {
    id: 'main-coinbase',
    source: 'coinbase' as const,
    identifier: 'test@example.com',
    label: 'Test',
  };
}

function fixtureEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    id: 'coinbase:test-1',
    source: 'coinbase',
    accountId: 'main-coinbase',
    timestamp: new Date('2024-01-15T18:41:54Z'),
    type: 'trade',
    legs: [
      { asset: 'BTC', amount: '0.00152134' },
      { asset: 'USD', amount: '-150.00' },
      { asset: 'USD', amount: '-4.22', feeFlag: true },
    ],
    notes: 'Bought 0.00152134 BTC for 150 USD',
    raw: { csvRow: 'whatever' },
    ...overrides,
  };
}

// ─── Accounts ────────────────────────────────────────────────────────────

describe('accounts', () => {
  it('upserts and retrieves an account', () => {
    repo.upsertAccount(fixtureAccount());
    expect(repo.getAccount('main-coinbase')).toEqual(fixtureAccount());
  });

  it('returns null for unknown account', () => {
    expect(repo.getAccount('nope')).toBeNull();
  });

  it('updates on conflict', () => {
    repo.upsertAccount(fixtureAccount());
    repo.upsertAccount({ ...fixtureAccount(), label: 'Updated' });
    expect(repo.getAccount('main-coinbase')?.label).toBe('Updated');
  });

  it('lists accounts ordered by id', () => {
    repo.upsertAccount({ ...fixtureAccount(), id: 'b-account' });
    repo.upsertAccount({ ...fixtureAccount(), id: 'a-account' });
    expect(repo.listAccounts().map(a => a.id)).toEqual([
      'a-account',
      'b-account',
    ]);
  });
});

// ─── Raw events ──────────────────────────────────────────────────────────

describe('raw events — insert', () => {
  beforeEach(() => repo.upsertAccount(fixtureAccount()));

  it('inserts a new event with all legs', () => {
    const result = repo.insertRawEvents([fixtureEvent()]);
    expect(result).toEqual({ inserted: 1, skipped: 0 });
    expect(repo.countTotal({})).toBe(1);
  });

  it('is idempotent — same id returns skipped', () => {
    repo.insertRawEvents([fixtureEvent()]);
    const result = repo.insertRawEvents([fixtureEvent()]);
    expect(result).toEqual({ inserted: 0, skipped: 1 });
    expect(repo.countTotal({})).toBe(1);
  });

  it('inserts a batch in one transaction', () => {
    const batch: RawEvent[] = [];
    for (let i = 0; i < 100; i++) {
      batch.push(fixtureEvent({ id: `coinbase:bulk-${i}` }));
    }
    const result = repo.insertRawEvents(batch);
    expect(result.inserted).toBe(100);
    expect(repo.countTotal({})).toBe(100);
  });

  it('handles mixed-new-and-existing batches', () => {
    repo.insertRawEvents([fixtureEvent({ id: 'coinbase:a' })]);
    const result = repo.insertRawEvents([
      fixtureEvent({ id: 'coinbase:a' }),
      fixtureEvent({ id: 'coinbase:b' }),
    ]);
    expect(result).toEqual({ inserted: 1, skipped: 1 });
  });
});

describe('raw events — read', () => {
  beforeEach(() => repo.upsertAccount(fixtureAccount()));

  it('round-trips a stored event', () => {
    const original = fixtureEvent();
    repo.insertRawEvents([original]);
    const retrieved = repo.getRawEventById(original.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(original.id);
    expect(retrieved!.timestamp.getTime()).toBe(original.timestamp.getTime());
    expect(retrieved!.type).toBe(original.type);
    expect(retrieved!.legs).toHaveLength(3);
    // Fee flag preserved
    expect(retrieved!.legs[2]!.feeFlag).toBe(true);
    // Raw payload round-trips through JSON
    expect(retrieved!.raw).toEqual({ csvRow: 'whatever' });
  });

  it('filters by accountId', () => {
    repo.upsertAccount({ ...fixtureAccount(), id: 'second' });
    repo.insertRawEvents([
      fixtureEvent({ id: 'a', accountId: 'main-coinbase' }),
      fixtureEvent({ id: 'b', accountId: 'second' }),
    ]);
    expect(
      repo.getRawEvents({ accountId: 'main-coinbase' }).map(e => e.id),
    ).toEqual(['a']);
  });

  it('filters by type', () => {
    repo.insertRawEvents([
      fixtureEvent({ id: 'a', type: 'trade' }),
      fixtureEvent({ id: 'b', type: 'income' }),
      fixtureEvent({ id: 'c', type: 'income' }),
    ]);
    expect(repo.getRawEvents({ type: 'income' }).map(e => e.id)).toEqual([
      'b',
      'c',
    ]);
  });

  it('returns counts grouped by type', () => {
    repo.insertRawEvents([
      fixtureEvent({ id: 'a', type: 'income' }),
      fixtureEvent({ id: 'b', type: 'income' }),
      fixtureEvent({ id: 'c', type: 'trade' }),
    ]);
    const counts = repo.countByType({});
    expect(counts).toEqual([
      { type: 'income', count: 2 },
      { type: 'trade', count: 1 },
    ]);
  });

  it('respects timestamp range filter', () => {
    repo.insertRawEvents([
      fixtureEvent({ id: 'old', timestamp: new Date('2023-01-01Z') }),
      fixtureEvent({ id: 'new', timestamp: new Date('2024-06-01Z') }),
    ]);
    const result = repo.getRawEvents({
      fromTimestamp: Math.floor(new Date('2024-01-01Z').getTime() / 1000),
    });
    expect(result.map(e => e.id)).toEqual(['new']);
  });

  it('existingRawEventIds returns only the ids that exist', () => {
    repo.insertRawEvents([fixtureEvent({ id: 'a' }), fixtureEvent({ id: 'b' })]);
    const found = repo.existingRawEventIds(['a', 'b', 'missing']);
    expect(found).toEqual(new Set(['a', 'b']));
  });

  it('existingRawEventIds returns an empty set for no ids', () => {
    expect(repo.existingRawEventIds([])).toEqual(new Set());
  });
});

// ─── Source sync state ─────────────────────────────────────────────────

describe('source sync state', () => {
  beforeEach(() => repo.upsertAccount(fixtureAccount()));

  it('returns null for missing sync state', () => {
    expect(repo.getSyncState('coinbase', 'main-coinbase')).toBeNull();
  });

  it('upserts and retrieves sync state', () => {
    repo.upsertSyncState({
      source: 'coinbase',
      accountId: 'main-coinbase',
      cursor: 'cursor-1',
      lastSyncedAt: 1_718_400_000,
    });

    expect(repo.getSyncState('coinbase', 'main-coinbase')).toEqual({
      source: 'coinbase',
      accountId: 'main-coinbase',
      cursor: 'cursor-1',
      lastSyncedAt: 1_718_400_000,
      updatedAt: expect.any(Number),
    });
  });

  it('replaces existing sync state for the same source and account', () => {
    repo.upsertSyncState({
      source: 'coinbase',
      accountId: 'main-coinbase',
      cursor: 'old',
      lastSyncedAt: 1,
    });
    repo.upsertSyncState({
      source: 'coinbase',
      accountId: 'main-coinbase',
      cursor: 'new',
      lastSyncedAt: 2,
    });

    expect(repo.getSyncState('coinbase', 'main-coinbase')).toMatchObject({
      cursor: 'new',
      lastSyncedAt: 2,
    });
  });
});

// ─── rebuildLedgerEntries — transaction rollback ───────────────────────

describe('rebuildLedgerEntries — transaction rollback', () => {
  beforeEach(() => repo.upsertAccount(fixtureAccount()));

  it('preserves prior entries when a rebuild fails due to a UNIQUE constraint on id', () => {
    // Seed a valid event and a first successful rebuild
    const evt1: RawEvent = fixtureEvent({ id: 'evt-seed-1' });
    repo.insertRawEvents([evt1]);

    const priorEntry = {
      id: 'entry-prior-1',
      timestamp: evt1.timestamp,
      type: 'trade' as const,
      legs: evt1.legs,
      rawEventIds: [evt1.id],
      reason: 'initial',
    };
    repo.rebuildLedgerEntries([priorEntry]);

    const before = repo.getLedgerEntries({ limit: 100 });
    expect(before).toHaveLength(1);
    expect(before[0]!.id).toBe('entry-prior-1');

    // Attempt a rebuild with two entries sharing the same id (duplicate entryId)
    const badEntry1 = { ...priorEntry, id: 'entry-dup' };
    const badEntry2 = { ...priorEntry, id: 'entry-dup' }; // same id — UNIQUE violation

    expect(() => repo.rebuildLedgerEntries([badEntry1, badEntry2])).toThrow();

    // Prior entries must survive — the failed rebuild should have rolled back
    const after = repo.getLedgerEntries({ limit: 100 });
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe('entry-prior-1');
  });

  it('preserves prior entries when a rebuild fails due to a FOREIGN KEY violation (stale rawEventId)', () => {
    // Seed a valid event and initial rebuild
    const evt1: RawEvent = fixtureEvent({ id: 'evt-fk-1' });
    repo.insertRawEvents([evt1]);

    const priorEntry = {
      id: 'entry-fk-prior',
      timestamp: evt1.timestamp,
      type: 'income' as const,
      legs: evt1.legs,
      rawEventIds: [evt1.id],
      reason: 'initial',
    };
    repo.rebuildLedgerEntries([priorEntry]);

    const before = repo.getLedgerEntries({ limit: 100 });
    expect(before).toHaveLength(1);

    // Attempt a rebuild referencing a non-existent raw event id
    const badEntry = {
      id: 'entry-fk-bad',
      timestamp: evt1.timestamp,
      type: 'trade' as const,
      legs: evt1.legs,
      rawEventIds: ['raw-event-that-does-not-exist'],
      reason: 'bad',
    };

    expect(() => repo.rebuildLedgerEntries([badEntry])).toThrow();

    // Prior entries must survive
    const after = repo.getLedgerEntries({ limit: 100 });
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe('entry-fk-prior');
  });
});

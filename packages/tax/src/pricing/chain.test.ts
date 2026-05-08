/**
 * Unit tests for the PricingChain.
 *
 * Uses :memory: SQLite databases for isolation and mock providers
 * (simple objects implementing PricingProvider) to test the chain
 * logic without network calls.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseInstance } from 'better-sqlite3';
import type { PriceResult, PricingProvider } from './provider.js';
import { PriceCache, dayUtc } from './cache.js';
import { PricingChain } from './chain.js';
import { ManualOverrideProvider } from './providers/manual-override.js';
import { SourceReportedProvider } from './providers/source-reported.js';

// ─── Test helpers ────────────────────────────────────────────────────────

let db: DatabaseInstance;
let cache: PriceCache;

/**
 * Create the minimal schema needed for pricing tests.
 * We only need the `prices` and `price_overrides` tables — no need
 * to run the full ledger migration infrastructure.
 */
function createPricingSchema(db: DatabaseInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prices (
      asset TEXT NOT NULL,
      day INTEGER NOT NULL,
      source TEXT NOT NULL,
      price_usd TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (asset, day, source)
    );
    CREATE INDEX IF NOT EXISTS idx_prices_asset_day ON prices(asset, day);

    CREATE TABLE IF NOT EXISTS price_overrides (
      id TEXT PRIMARY KEY,
      asset TEXT NOT NULL,
      day INTEGER NOT NULL,
      price_usd TEXT NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_price_overrides_asset_day ON price_overrides(asset, day);

    CREATE TABLE IF NOT EXISTS raw_events (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      account_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS raw_event_legs (
      event_id TEXT NOT NULL,
      leg_index INTEGER NOT NULL,
      asset TEXT NOT NULL,
      amount TEXT NOT NULL,
      amount_usd_reported_by_source TEXT,
      PRIMARY KEY (event_id, leg_index)
    );
  `);
}

beforeEach(() => {
  db = new Database(':memory:');
  createPricingSchema(db);
  cache = new PriceCache(db);
});

afterEach(() => {
  db.close();
});

/** Create a mock provider that returns a fixed price for a specific asset. */
function mockProvider(
  name: string,
  prices: Record<string, string>,
): PricingProvider {
  return {
    name,
    async getPrice(asset: string): Promise<PriceResult | null> {
      const price = prices[asset.toUpperCase()];
      if (!price) return null;
      return { priceUsd: price, source: name };
    },
  };
}

/** A provider that always returns null. */
function nullProvider(name: string): PricingProvider {
  return {
    name,
    async getPrice(): Promise<PriceResult | null> {
      return null;
    },
  };
}

const JAN_15 = new Date('2024-01-15T14:30:00Z');

// ─── Tests ───────────────────────────────────────────────────────────────

describe('PricingChain', () => {
  it('source-reported provider returns a hit → chain returns it', async () => {
    const sourceReported = mockProvider('source-reported', { ETH: '2305.73' });
    const coingecko = mockProvider('coingecko', { ETH: '2310.00' });

    const chain = new PricingChain(
      { providers: [sourceReported, coingecko] },
      cache,
    );

    const result = await chain.priceAt('ETH', JAN_15);
    expect(result).not.toBeNull();
    expect(result!.priceUsd).toBe('2305.73');
    expect(result!.source).toBe('source-reported');
  });

  it('source-reported returns null, second provider returns a hit → chain returns it', async () => {
    const sourceReported = nullProvider('source-reported');
    const coingecko = mockProvider('coingecko', { ETH: '2310.00' });

    const chain = new PricingChain(
      { providers: [sourceReported, coingecko] },
      cache,
    );

    const result = await chain.priceAt('ETH', JAN_15);
    expect(result).not.toBeNull();
    expect(result!.priceUsd).toBe('2310.00');
    expect(result!.source).toBe('coingecko');
  });

  it('cache hit skips all providers', async () => {
    // Pre-populate cache
    const day = dayUtc(JAN_15);
    cache.set('ETH', day, 'coingecko', '2300.00');

    // Provider that would return a different price
    let providerCalled = false;
    const provider: PricingProvider = {
      name: 'should-not-be-called',
      async getPrice(): Promise<PriceResult | null> {
        providerCalled = true;
        return { priceUsd: '9999.99', source: 'should-not-be-called' };
      },
    };

    const chain = new PricingChain(
      { providers: [provider] },
      cache,
    );

    const result = await chain.priceAt('ETH', JAN_15);
    expect(result).not.toBeNull();
    expect(result!.priceUsd).toBe('2300.00');
    expect(result!.source).toBe('coingecko');
    expect(providerCalled).toBe(false);
  });

  it('manual override bypasses cached market price without replacing it', async () => {
    const day = dayUtc(JAN_15);
    cache.set('ETH', day, 'coingecko', '2300.00');

    db.prepare(`
      INSERT INTO price_overrides (id, asset, day, price_usd, note, created_at)
      VALUES ('ETH:1705276800', 'ETH', ?, '2400.00', NULL, ?)
    `).run(day, Math.floor(Date.now() / 1000));

    const chain = new PricingChain(
      {
        providers: [
          mockProvider('coingecko', { ETH: '9999.99' }),
          new ManualOverrideProvider(db),
        ],
      },
      cache,
    );

    const overrideResult = await chain.priceAt('ETH', JAN_15);
    expect(overrideResult).toEqual({
      priceUsd: '2400.00',
      source: 'manual-override',
    });

    db.prepare('DELETE FROM price_overrides WHERE asset = ? AND day = ?').run('ETH', day);

    const cachedResult = await chain.priceAt('ETH', JAN_15);
    expect(cachedResult).toEqual({
      priceUsd: '2300.00',
      source: 'coingecko',
    });
  });

  it('asset alias (POL → MATIC) is applied before lookup', async () => {
    const provider = mockProvider('coingecko', { MATIC: '0.85' });

    const chain = new PricingChain(
      { providers: [provider] },
      cache,
    );

    // Query with 'POL' — should be canonicalized to 'MATIC'
    const result = await chain.priceAt('POL', JAN_15);
    expect(result).not.toBeNull();
    expect(result!.priceUsd).toBe('0.85');
  });

  it('all providers return null → chain returns null', async () => {
    const chain = new PricingChain(
      {
        providers: [
          nullProvider('source-reported'),
          nullProvider('coingecko'),
          nullProvider('manual-override'),
        ],
      },
      cache,
    );

    const result = await chain.priceAt('KITTYINU', JAN_15);
    expect(result).toBeNull();
  });

  it('caches the winning result for subsequent lookups', async () => {
    let callCount = 0;
    const provider: PricingProvider = {
      name: 'counting-provider',
      async getPrice(): Promise<PriceResult | null> {
        callCount++;
        return { priceUsd: '42000.00', source: 'counting-provider' };
      },
    };

    const chain = new PricingChain(
      { providers: [provider] },
      cache,
    );

    // First call — hits provider
    const r1 = await chain.priceAt('BTC', JAN_15);
    expect(r1!.priceUsd).toBe('42000.00');
    expect(callCount).toBe(1);

    // Second call — should hit cache, not provider
    const r2 = await chain.priceAt('BTC', JAN_15);
    expect(r2!.priceUsd).toBe('42000.00');
    expect(callCount).toBe(1); // still 1
  });

  it('ETH2 alias resolves to ETH', async () => {
    const provider = mockProvider('coingecko', { ETH: '2500.00' });

    const chain = new PricingChain(
      { providers: [provider] },
      cache,
    );

    const result = await chain.priceAt('ETH2', JAN_15);
    expect(result).not.toBeNull();
    expect(result!.priceUsd).toBe('2500.00');
  });
});

describe('SourceReportedProvider', () => {
  it('returns unit price, not total source-reported leg value', async () => {
    const timestamp = Math.floor(JAN_15.getTime() / 1000);
    db.prepare(`
      INSERT INTO raw_events (id, source, account_id, timestamp, type, raw_json)
      VALUES ('evt-1', 'coinbase', 'acct-1', ?, 'trade', '{}')
    `).run(timestamp);
    db.prepare(`
      INSERT INTO raw_event_legs
        (event_id, leg_index, asset, amount, amount_usd_reported_by_source)
      VALUES ('evt-1', 0, 'ETH', '2', '4600')
    `).run();

    const provider = new SourceReportedProvider(db);
    const result = await provider.getPrice('ETH', JAN_15);

    expect(result).not.toBeNull();
    expect(result!.priceUsd).toBe('2300');
    expect(result!.source).toBe('source-reported');
  });
});

// ─── dayUtc helper ───────────────────────────────────────────────────────

describe('dayUtc', () => {
  it('truncates to midnight UTC', () => {
    const ts = new Date('2024-01-15T14:30:45.123Z');
    const day = dayUtc(ts);
    const midnight = new Date('2024-01-15T00:00:00Z');
    expect(day).toBe(Math.floor(midnight.getTime() / 1000));
  });

  it('handles midnight exactly', () => {
    const ts = new Date('2024-01-15T00:00:00Z');
    expect(dayUtc(ts)).toBe(Math.floor(ts.getTime() / 1000));
  });

  it('handles end of day', () => {
    const ts = new Date('2024-01-15T23:59:59.999Z');
    const expected = new Date('2024-01-15T00:00:00Z');
    expect(dayUtc(ts)).toBe(Math.floor(expected.getTime() / 1000));
  });
});

// ─── PriceCache ──────────────────────────────────────────────────────────

describe('PriceCache', () => {
  it('returns null for uncached asset', () => {
    const day = dayUtc(JAN_15);
    expect(cache.get('NOPE', day)).toBeNull();
  });

  it('round-trips a cached price', () => {
    const day = dayUtc(JAN_15);
    cache.set('ETH', day, 'coingecko', '2305.73');
    const result = cache.get('ETH', day);
    expect(result).not.toBeNull();
    expect(result!.priceUsd).toBe('2305.73');
    expect(result!.source).toBe('coingecko');
  });

  it('overwrites on re-set with same key', () => {
    const day = dayUtc(JAN_15);
    cache.set('ETH', day, 'coingecko', '2305.73');
    cache.set('ETH', day, 'coingecko', '2310.00');
    const result = cache.get('ETH', day);
    expect(result!.priceUsd).toBe('2310.00');
  });
});

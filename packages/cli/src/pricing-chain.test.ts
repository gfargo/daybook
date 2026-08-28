/**
 * Unit tests for `hydratePrices`' account → chain platform resolution.
 *
 * Regression coverage for a bug where `hydratePrices` never forwarded a
 * CoinGecko platform to `PricingChain.priceAt()`, so contract-address legs
 * on non-Ethereum EVM chains (Polygon, Arbitrum, Base, Optimism, BNB) were
 * always priced against Ethereum.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseInstance } from 'better-sqlite3';
import type { LedgerEntry } from '@daybook/ledger';
import { PriceCache, PricingChain } from '@daybook/tax';
import type { PriceResult, PricingProvider } from '@daybook/tax';
import { ConfigSchema, type Config } from './config.js';
import { hydratePrices } from './pricing-chain.js';

let db: DatabaseInstance;
let cache: PriceCache;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS prices (
      asset TEXT NOT NULL,
      day INTEGER NOT NULL,
      source TEXT NOT NULL,
      price_usd TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (asset, day, source)
    );
  `);
  cache = new PriceCache(db);
});

afterEach(() => {
  db.close();
});

/** Records the `platform` argument it was called with, always returns a fixed price. */
function recordingProvider(platforms: (string | undefined)[]): PricingProvider {
  return {
    name: 'recording',
    async getPrice(
      _asset: string,
      _timestamp: Date,
      _contractAddress?: string,
      platform?: string,
    ): Promise<PriceResult | null> {
      platforms.push(platform);
      return { priceUsd: '1.23', source: 'recording' };
    },
  };
}

function buildConfig(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse(overrides);
}

describe('hydratePrices platform resolution', () => {
  it('forwards the CoinGecko platform for a contract-address leg on a Polygon account', async () => {
    const platforms: (string | undefined)[] = [];
    const chain = new PricingChain({ providers: [recordingProvider(platforms)] }, cache);
    const config = buildConfig({
      accounts: [
        { id: 'my-polygon-wallet', source: 'polygon', identifier: '0xabc' },
      ],
    });

    const entries: LedgerEntry[] = [
      {
        id: 'entry-1',
        timestamp: new Date('2024-01-15T12:00:00Z'),
        type: 'trade',
        legs: [
          {
            asset: 'UNKNOWNTOKEN',
            amount: '10',
            contractAddress: '0xdeadbeef',
            accountId: 'my-polygon-wallet',
          },
        ],
        rawEventIds: ['raw-1'],
      },
    ];

    await hydratePrices(entries, chain, config);

    expect(platforms).toEqual(['polygon-pos']);
    expect(entries[0]!.legs[0]!.amountUsdAtTime).toBe('12.3');
  });

  it('leaves platform undefined when the leg has no matching account', async () => {
    const platforms: (string | undefined)[] = [];
    const chain = new PricingChain({ providers: [recordingProvider(platforms)] }, cache);
    const config = buildConfig({ accounts: [] });

    const entries: LedgerEntry[] = [
      {
        id: 'entry-1',
        timestamp: new Date('2024-01-15T12:00:00Z'),
        type: 'trade',
        legs: [
          { asset: 'ETH', amount: '1' },
        ],
        rawEventIds: ['raw-1'],
      },
    ];

    await hydratePrices(entries, chain, config);

    expect(platforms).toEqual([undefined]);
  });
});

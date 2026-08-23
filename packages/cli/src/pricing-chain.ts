/**
 * Shared pricing-chain setup used by `export`, `reconcile`, and `compare`
 * commands.
 *
 * All commands need to: build the standard provider chain
 * (source-reported → CoinGecko → manual override), then hydrate each
 * leg's `amountUsdAtTime` for downstream tax computation. Extracted
 * here so the three callers stay in sync as the chain evolves.
 *
 * Key improvements over the original sequential loop:
 *   - De-duplicates (canonicalAsset, dayUtc, contractAddress) before fetching
 *     so N identical legs produce 1 provider call, not N.
 *   - Bounded concurrency (default 4) keeps throughput high without
 *     overwhelming the API.
 *   - Rate limiting lives inside CoinGeckoProvider (default ≤25 req/min).
 *   - Genuine "no data" misses are negative-cached via PriceMissCache.
 *   - Optional onProgress callback for stderr progress reporting.
 */

import Decimal from 'decimal.js';
import type { LedgerEntry } from '@daybook/ledger';
import {
  CoinGeckoProvider,
  ManualOverrideProvider,
  PriceCache,
  PriceMissCache,
  PricingChain,
  SourceReportedProvider,
  canonicalAsset,
  dayUtc,
} from '@daybook/tax';
import type { Config } from './config.js';

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

/**
 * Maximum number of concurrent price lookups.
 * Rate limiting still lives inside CoinGeckoProvider, so this cap prevents
 * spawning thousands of simultaneous promises while staying responsive.
 */
const DEFAULT_CONCURRENCY = 4;

// ─────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────

interface DbWithRaw {
  raw: ConstructorParameters<typeof PriceCache>[0];
}

/**
 * Minimal promise-pool runner. Calls `task` for each item in `items`,
 * keeping at most `concurrency` promises in-flight simultaneously.
 *
 * @param items       - Input items.
 * @param concurrency - Max parallel tasks.
 * @param task        - Async function called for each item.
 */
async function poolMap<T>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const iterator = items.entries();
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (const [index, item] of iterator) {
      await task(item, index);
    }
  });
  await Promise.all(workers);
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build the daybook standard pricing chain wired to the given DB.
 * Injects both the positive PriceCache and the negative-miss PriceMissCache
 * so that hydratePrices benefits from both.
 */
export function buildPricingChain(db: DbWithRaw, config: Config): PricingChain {
  const cache = new PriceCache(db.raw);
  const missCache = new PriceMissCache(db.raw);
  const coingeckoApiKeyEnv =
    config.providers?.coingecko?.apiKeyEnv ?? 'COINGECKO_API_KEY';
  const coingeckoApiKey = process.env[coingeckoApiKeyEnv];
  const coingeckoOpts = coingeckoApiKey ? { apiKey: coingeckoApiKey } : {};

  return new PricingChain(
    {
      providers: [
        new SourceReportedProvider(db.raw),
        new CoinGeckoProvider(coingeckoOpts),
        new ManualOverrideProvider(db.raw),
      ],
    },
    cache,
    missCache,
  );
}

/**
 * Hydrate every unpriced leg's `amountUsdAtTime` using the given pricing chain.
 *
 * Mutates entries in place. De-duplicates (canonicalAsset, dayUtc,
 * contractAddress) keys so each distinct lookup is executed at most once per
 * call, regardless of how many legs share the same key. Results are applied
 * back to all matching legs.
 *
 * Lookups run with bounded concurrency (default 4) using a promise pool.
 * CoinGecko HTTP calls are throttled inside the provider (≤25 req/min).
 *
 * @param entries        - Combined prior + current-year entries (mutated).
 * @param pricingChain   - Chain to resolve prices.
 * @param onProgress     - Optional callback invoked after each distinct lookup
 *                         completes, with (completedCount, totalDistinct).
 * @param concurrency    - Max parallel lookups (default: 4).
 */
export async function hydratePrices(
  entries: LedgerEntry[],
  pricingChain: PricingChain,
  onProgress?: (done: number, total: number) => void,
  concurrency = DEFAULT_CONCURRENCY,
): Promise<void> {
  // ── 1. Collect unpriced legs and de-duplicate lookup keys ─────────────
  type LegRef = { entry: LedgerEntry; legIndex: number };

  // Maps dedup key → list of legs that need this price
  const keyToLegs = new Map<string, LegRef[]>();
  // Maps dedup key → representative (asset, timestamp, contractAddress)
  const keyToLookup = new Map<
    string,
    { asset: string; timestamp: Date; contractAddress?: string }
  >();

  for (const entry of entries) {
    for (let legIndex = 0; legIndex < entry.legs.length; legIndex++) {
      const leg = entry.legs[legIndex]!;
      if (leg.amountUsdAtTime || leg.amountUsdReportedBySource) continue;

      const canonical = canonicalAsset(leg.asset);
      const day = dayUtc(entry.timestamp);
      const contract = (leg.contractAddress ?? '').toLowerCase();
      const key = `${canonical}|${day}|${contract}`;

      if (!keyToLegs.has(key)) {
        keyToLegs.set(key, []);
        const lookup: { asset: string; timestamp: Date; contractAddress?: string } = {
          asset: leg.asset,
          timestamp: entry.timestamp,
        };
        if (leg.contractAddress) lookup.contractAddress = leg.contractAddress;
        keyToLookup.set(key, lookup);
      }
      keyToLegs.get(key)!.push({ entry, legIndex });
    }
  }

  const distinctKeys = [...keyToLegs.keys()];
  const total = distinctKeys.length;
  if (total === 0) return;

  // ── 2. Resolve distinct keys with bounded concurrency ─────────────────
  const results = new Map<string, string | null>(); // key → priceUsd or null
  let done = 0;

  await poolMap(distinctKeys, concurrency, async key => {
    const lookup = keyToLookup.get(key)!;
    const result = await pricingChain.priceAt(
      lookup.asset,
      lookup.timestamp,
      lookup.contractAddress,
    );
    results.set(key, result ? result.priceUsd : null);

    done += 1;
    onProgress?.(done, total);
  });

  // ── 3. Apply resolved prices back to all matching legs ────────────────
  for (const [key, priceUsd] of results) {
    if (!priceUsd) continue;

    for (const { entry, legIndex } of keyToLegs.get(key)!) {
      const leg = entry.legs[legIndex]!;
      const absAmount = new Decimal(leg.amount).abs();
      leg.amountUsdAtTime = absAmount.mul(new Decimal(priceUsd)).toString();
    }
  }
}

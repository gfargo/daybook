/**
 * Shared pricing-chain setup used by `export` and `reconcile` commands.
 *
 * Both commands need to: build the standard provider chain
 * (source-reported → CoinGecko → manual override), then hydrate each
 * leg's `amountUsdAtTime` for downstream tax computation. Extracted
 * here so the two callers stay in sync as the chain evolves.
 */

import Decimal from 'decimal.js';
import type { LedgerEntry } from '@daybook/ledger';
import {
  CoinGeckoProvider,
  COINGECKO_PLATFORM_BY_SOURCE,
  ManualOverrideProvider,
  PriceCache,
  PricingChain,
  SourceReportedProvider,
} from '@daybook/tax';
import type { Config } from './config.js';

interface DbWithRaw {
  raw: ConstructorParameters<typeof PriceCache>[0];
}

/**
 * Build the daybook standard pricing chain wired to the given DB.
 */
export function buildPricingChain(db: DbWithRaw, config: Config): PricingChain {
  const cache = new PriceCache(db.raw);
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
  );
}

/**
 * Hydrate every leg's `amountUsdAtTime` (when unset) using the given
 * pricing chain. Mutates the entries in place — caller passes the
 * combined prior + current-year set so lot history is fully priced.
 *
 * Resolves each leg's `accountId` to its configured chain (`config.accounts`)
 * and forwards the matching CoinGecko platform so contract-address lookups
 * hit the right chain instead of defaulting to Ethereum.
 */
export async function hydratePrices(
  entries: LedgerEntry[],
  pricingChain: PricingChain,
  config: Config,
): Promise<void> {
  const platformByAccountId = new Map(
    config.accounts.map(account => [
      account.id,
      COINGECKO_PLATFORM_BY_SOURCE[account.source],
    ]),
  );

  for (const entry of entries) {
    for (const leg of entry.legs) {
      if (leg.amountUsdAtTime || leg.amountUsdReportedBySource) continue;
      const platform = leg.accountId
        ? platformByAccountId.get(leg.accountId)
        : undefined;
      const result = await pricingChain.priceAt(
        leg.asset,
        entry.timestamp,
        leg.contractAddress,
        platform,
      );
      if (result) {
        const absAmount = new Decimal(leg.amount).abs();
        const totalUsd = absAmount.mul(new Decimal(result.priceUsd));
        leg.amountUsdAtTime = totalUsd.toString();
      }
    }
  }
}

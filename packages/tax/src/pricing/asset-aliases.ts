/**
 * Asset alias resolution.
 *
 * Some assets have multiple ticker symbols that refer to the same
 * underlying token. The pricing layer canonicalizes these before
 * cache lookups and provider calls so that POL and MATIC (same token,
 * renamed in 2024) share a single price entry.
 */

// ─────────────────────────────────────────────────────────────────────────
// Alias map
// ─────────────────────────────────────────────────────────────────────────

/**
 * Map of non-canonical tickers to their canonical form.
 *
 * Only add entries where two symbols genuinely refer to the same asset
 * for tax purposes. WETH ≠ ETH (wrapping is a taxable swap).
 */
const ASSET_ALIASES: Record<string, string> = {
  POL: 'MATIC',
  ETH2: 'ETH',
};

/**
 * Resolve an asset ticker to its canonical form.
 *
 * If the asset has a known alias, returns the canonical ticker.
 * Otherwise returns the input unchanged.
 *
 * @param asset - Ticker symbol (e.g. 'POL', 'ETH2', 'BTC').
 * @returns The canonical ticker (e.g. 'MATIC', 'ETH', 'BTC').
 */
export function canonicalAsset(asset: string): string {
  return ASSET_ALIASES[asset.toUpperCase()] ?? asset;
}

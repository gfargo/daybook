/**
 * NFT identifier helpers.
 *
 * Provides canonical identifier construction and display formatting
 * for NFTs identified by contract address + token ID.
 *
 * Three formats serve different contexts:
 *   - `nftId`              — canonical key for lot tracking (full, lowercased)
 *   - `formatNftId`        — truncated for CLI table columns
 *   - `formatNftDescription` — IRS form description field
 */

// ─── Canonical identifier ────────────────────────────────────────────────

/**
 * Build the canonical NFT identifier from contract address and token ID.
 *
 * Produces a lowercased `<contractAddress>:<tokenId>` string used as the
 * unique key in the `NftLotBook`. Deterministic — same inputs always
 * produce the same output.
 *
 * @param contractAddress - The NFT contract address (hex string).
 * @param tokenId - The token ID within the contract.
 * @returns Lowercased `<contractAddress>:<tokenId>`.
 */
export function nftId(contractAddress: string, tokenId: string): string {
  return `${contractAddress.toLowerCase()}:${tokenId}`;
}

// ─── CLI display format ──────────────────────────────────────────────────

/**
 * Format an NFT identifier for CLI display (truncated contract address).
 *
 * Produces `0x<first4>...<last2>:<tokenId>` when the address is long
 * enough to truncate. Short addresses are used as-is.
 *
 * Examples:
 *   - `formatNftId('0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', '4523')`
 *     → `'0xbc4c...3d:4523'`
 *
 * @param contractAddress - The NFT contract address (hex string).
 * @param tokenId - The token ID within the contract.
 * @returns Truncated display string.
 */
export function formatNftId(contractAddress: string, tokenId: string): string {
  const addr = contractAddress.toLowerCase();

  // A standard hex address is 42 chars (0x + 40 hex). Truncate only if
  // the address is long enough for the pattern to make sense.
  if (addr.length > 10) {
    const prefix = addr.slice(0, 6);  // '0xbc4c'
    const suffix = addr.slice(-2);    // '3d'
    return `${prefix}...${suffix}:${tokenId}`;
  }

  return `${addr}:${tokenId}`;
}

// ─── IRS form description ────────────────────────────────────────────────

/**
 * Format an NFT identifier for IRS form descriptions.
 *
 * Produces `1 0x<first6>...<last4>:<tokenId>` — the leading `1` is the
 * quantity (NFTs are always quantity 1), and the address is truncated to
 * first 6 + last 4 characters for readability within PDF field widths.
 *
 * Examples:
 *   - `formatNftDescription('0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', '4523')`
 *     → `'1 0xbc4ca0...f13d:4523'`
 *
 * @param contractAddress - The NFT contract address (hex string).
 * @param tokenId - The token ID within the contract.
 * @returns IRS-formatted description string.
 */
export function formatNftDescription(contractAddress: string, tokenId: string): string {
  const addr = contractAddress.toLowerCase();

  // Truncate: first 8 chars (0x + 6 hex) + last 4 hex chars
  if (addr.length > 14) {
    const prefix = addr.slice(0, 8);  // '0xbc4ca0'
    const suffix = addr.slice(-4);    // 'f13d'
    return `1 ${prefix}...${suffix}:${tokenId}`;
  }

  return `1 ${addr}:${tokenId}`;
}

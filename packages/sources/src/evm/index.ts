/**
 * EVM adapter.
 *
 * Pulls transaction history for a wallet on Ethereum mainnet, Polygon, and
 * other EVM chains via Alchemy's `getAssetTransfers`.
 *
 * Adapter contract: given (chainId, address, optional fromBlock), produce
 * a stream of RawEvents — one per asset transfer. Categories covered:
 *   - external (native ETH/MATIC transfers)
 *   - internal (contract-initiated value transfers)
 *   - erc20
 *   - erc721
 *   - erc1155
 *
 * Implementation pending. See `crypto-audit-research-and-plan.md` Phase 1.
 */

export const TODO = 'EVM adapter pending — see roadmap Phase 1';

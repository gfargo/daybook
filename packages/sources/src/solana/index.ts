/**
 * @daybook/sources/solana
 *
 * Solana wallet adapter — pulls native SOL and SPL-token transfer history
 * via the Solana JSON-RPC API and emits normalized RawEvents.
 *
 * Public API:
 *   - `ingestSolana()` — main entry point: fetches + translates → RawEvents
 *   - `SolanaTransferProvider` — interface for chain data providers
 *   - `SolanaRpcProvider` — JSON-RPC backed implementation
 *   - Helper types for callers
 */

// Provider interface and types
export type {
  FetchSolanaTransfersOpts,
  RawSolanaTransfer,
  SolanaSignatureInfo,
  SolanaTransaction,
  SolanaTokenBalance,
  SolanaTransactionMeta,
  SolanaTransferProvider,
} from './provider.js';
export { lamportsToSol, LAMPORTS_PER_SOL, rawTokenToDecimal } from './provider.js';

// Adapter
export type {
  SolanaAdapterOptions,
  SolanaIngestResult,
  SolanaIngestStats,
} from './adapter.js';
export { ingestSolana } from './adapter.js';

// Providers
export { SolanaRpcProvider } from './providers/rpc.js';

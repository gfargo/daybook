/**
 * EVM adapter.
 *
 * Pulls transaction history for a wallet on Ethereum mainnet, Polygon, and
 * other EVM chains via a pluggable provider interface (Alchemy default).
 *
 * Public API:
 *   - `ingestEvm()` — main entry point, translates provider data → RawEvents
 *   - `EvmTransferProvider` — interface for chain data providers
 *   - `AlchemyTransferProvider` — Alchemy-backed implementation
 *   - Chain ID mapping constants
 */

// Provider interface and types
export type {
  ChainId,
  EvmTransferProvider,
  FetchTransfersOpts,
  RawTransfer,
  TokenMetadata,
} from './provider.js';
export { CHAIN_ID_BY_SOURCE, SOURCE_BY_CHAIN_ID } from './provider.js';

// Adapter
export type {
  EvmAdapterOptions,
  EvmIngestResult,
  EvmIngestStats,
} from './adapter.js';
export { ingestEvm } from './adapter.js';

// Providers
export { AlchemyTransferProvider } from './providers/alchemy.js';

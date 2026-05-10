/**
 * Coinbase adapter.
 *
 *   notes.ts — regex parsers for the Notes column (the trickiest piece)
 *   row.ts   — pure CoinbaseCsvRow → RawEvent
 *   csv.ts   — file-level parser + Retail-pair merger
 *   api.ts   — Coinbase App Track API + Advanced Trade fills sync
 *
 * CSV import remains available via --file; API sync uses Coinbase v2 Track
 * transactions as the source of truth and v3 Advanced Trade fills for trade
 * fee/price enrichment.
 */

export * from './notes.js';
export * from './row.js';
export * from './csv.js';
export * from './api-auth.js';
export * from './api-client.js';
export * from './track-api.js';
export * from './advanced-api.js';
export * from './api.js';

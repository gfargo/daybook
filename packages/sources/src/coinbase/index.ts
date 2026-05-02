/**
 * Coinbase adapter.
 *
 *   notes.ts — regex parsers for the Notes column (the trickiest piece)
 *   row.ts   — pure CoinbaseCsvRow → RawEvent
 *   csv.ts   — file-level parser + Retail-pair merger
 *
 * v1: "All Transactions" CSV import.
 * v2: Coinbase Advanced Trade API for live sync (stub for now).
 */

export * from './notes.js';
export * from './row.js';
export * from './csv.js';

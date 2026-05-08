/**
 * @daybook/sources
 *
 * Adapters that turn source data into normalized RawEvents.
 * Each adapter is independent; nothing here knows about classification.
 */

export * as binance from './binance/index.js';
export * as coinbase from './coinbase/index.js';
export * as evm from './evm/index.js';
export * as genericCsv from './generic-csv/index.js';
export * as kraken from './kraken/index.js';

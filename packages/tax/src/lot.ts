/**
 * Lot data structure.
 *
 * A Lot represents a single acquisition of an asset — created when
 * the tax engine processes a buy, income event, or inbound trade leg.
 * The LotBook manages collections of lots per asset.
 *
 * Re-exports the Lot interface from types.ts for convenience.
 * This file exists as the canonical import path for lot-related code.
 */

export type { Lot } from './types.js';

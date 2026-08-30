/**
 * Shared fast-check arbitrary generators for property-based testing.
 *
 * Provides `Arbitrary<TaxResult>`, `Arbitrary<DisposalResult>`, and
 * `Arbitrary<Date>` (2020–2030 range) generators used across
 * form-8949, schedule-d, txf-export, and format-helpers property tests.
 *
 * Also provides `arbLedgerHistory` and `arbPureGainHistory` for
 * engine-level property tests (engine-invariants.test.ts).
 *
 * All generated values satisfy the invariants expected by the tax
 * formatters: valid dates, positive decimal amounts, and
 * `gainLoss === proceeds - costBasis`.
 */

import * as fc from 'fast-check';
import Decimal from 'decimal.js';
import type { DisposalResult, IncomeSummary, TaxResult } from './types.js';
import type { NftLot } from './nft-lot-book.js';
import type { LedgerEntry, AssetLeg, RawEvent } from '@daybook/ledger';

// ─── Constants ───────────────────────────────────────────────────────────

/** Minimum timestamp: 2020-01-01T00:00:00Z */
const MIN_DATE_MS = Date.UTC(2020, 0, 1);

/** Maximum timestamp: 2030-12-31T23:59:59Z */
const MAX_DATE_MS = Date.UTC(2030, 11, 31, 23, 59, 59);

/** Common crypto asset tickers for generated data. */
const ASSETS = ['BTC', 'ETH', 'SOL', 'MATIC', 'AVAX', 'LINK', 'UNI', 'DOGE'];

/** Cost-basis methods used in TaxResult. */
const METHODS = ['FIFO', 'HIFO', 'SpecificId'];

// ─── Date arbitrary ──────────────────────────────────────────────────────

/**
 * Arbitrary that generates valid `Date` objects in the 2020–2030 range.
 *
 * Useful for the IRS date format property test and any test needing
 * realistic tax-year dates.
 */
export const arbDate: fc.Arbitrary<Date> = fc
  .integer({ min: MIN_DATE_MS, max: MAX_DATE_MS })
  .map((ms) => new Date(ms));

// ─── Decimal string arbitrary ────────────────────────────────────────────

/**
 * Arbitrary that generates a positive decimal string with exactly
 * two decimal places, in the range [0.01, 999999.99].
 */
const arbDecimalString: fc.Arbitrary<string> = fc
  .float({ min: Math.fround(0.01), max: Math.fround(999999.99), noNaN: true })
  .map((n) => n.toFixed(2));

// ─── Ordered date pair arbitrary ─────────────────────────────────────────

/**
 * Arbitrary that generates a pair of dates where the first (acquiredAt)
 * is strictly before the second (disposedAt).
 */
const arbDatePair: fc.Arbitrary<{ acquiredAt: Date; disposedAt: Date }> = fc
  .tuple(
    fc.integer({ min: MIN_DATE_MS, max: MAX_DATE_MS - 1 }),
    fc.integer({ min: MIN_DATE_MS, max: MAX_DATE_MS - 1 }),
  )
  .map(([a, b]) => {
    const earlier = Math.min(a, b);
    const later = Math.max(a, b) + 1; // ensure strictly after
    return {
      acquiredAt: new Date(earlier),
      disposedAt: new Date(later),
    };
  });

// ─── DisposalResult arbitrary ────────────────────────────────────────────

/**
 * Arbitrary that generates a valid `DisposalResult`.
 *
 * The `gainLoss` field is computed as `proceeds - costBasis` using
 * decimal.js to ensure numerical consistency with the formatters.
 * Dates are valid objects in the 2020–2030 range with `acquiredAt`
 * strictly before `disposedAt`.
 */
export const arbDisposalResult: fc.Arbitrary<DisposalResult> = fc
  .record({
    asset: fc.constantFrom(...ASSETS),
    amount: arbDecimalString,
    proceeds: arbDecimalString,
    costBasis: arbDecimalString,
    term: fc.constantFrom('short-term' as const, 'long-term' as const),
    dates: arbDatePair,
    sourceEntryId: fc.uuid(),
    lotCount: fc.integer({ min: 1, max: 3 }),
    washSaleFlag: fc.boolean(),
  })
  .map(({ asset, amount, proceeds, costBasis, term, dates, sourceEntryId, lotCount, washSaleFlag }) => {
    const gainLoss = new Decimal(proceeds).minus(new Decimal(costBasis)).toFixed(2);

    const lotsConsumed = Array.from({ length: lotCount }, (_, i) => ({
      lotId: `lot-${sourceEntryId}-${i}`,
      amount: new Decimal(amount).div(lotCount).toFixed(2),
      costBasis: new Decimal(costBasis).div(lotCount).toFixed(2),
    }));

    return {
      asset,
      amount,
      proceeds,
      costBasis,
      gainLoss,
      term,
      acquiredAt: dates.acquiredAt,
      disposedAt: dates.disposedAt,
      sourceEntryId,
      lotsConsumed,
      washSaleFlag,
    };
  });

// ─── IncomeSummary arbitrary ─────────────────────────────────────────────

/**
 * Arbitrary that generates a valid `IncomeSummary` with 0–5 income events.
 */
const arbIncomeSummary: fc.Arbitrary<IncomeSummary> = fc
  .array(
    fc.record({
      entryId: fc.uuid(),
      asset: fc.constantFrom(...ASSETS),
      amount: arbDecimalString,
      usdValue: arbDecimalString,
    }),
    { minLength: 0, maxLength: 5 },
  )
  .map((events) => {
    const totalUsd = events
      .reduce((sum, e) => sum.plus(new Decimal(e.usdValue)), new Decimal('0'))
      .toFixed(2);

    const byAsset: Record<string, string> = {};
    for (const e of events) {
      byAsset[e.asset] = new Decimal(byAsset[e.asset] ?? '0')
        .plus(new Decimal(e.usdValue))
        .toFixed(2);
    }

    return { totalUsd, byAsset, events };
  });

// ─── TaxResult arbitrary ────────────────────────────────────────────────

/**
 * Arbitrary that generates a valid `TaxResult` with 0–100 disposals.
 *
 * All generated values satisfy the invariants expected by the tax
 * formatters: valid dates, positive decimal amounts, consistent
 * `gainLoss` computation, and realistic field values.
 */
export const arbTaxResult: fc.Arbitrary<TaxResult> = fc
  .record({
    year: fc.integer({ min: 2020, max: 2030 }),
    method: fc.constantFrom(...METHODS),
    disposals: fc.array(arbDisposalResult, { minLength: 0, maxLength: 100 }),
    income: arbIncomeSummary,
    warnings: fc.array(fc.string({ minLength: 1, maxLength: 80 }), { minLength: 0, maxLength: 5 }),
    unpricedEvents: fc.array(fc.uuid(), { minLength: 0, maxLength: 5 }),
  });

// ─── NFT arbitraries ─────────────────────────────────────────────────────

/** Hex character set for building Ethereum addresses. */
const HEX_CHARS = '0123456789abcdef'.split('');

/**
 * Arbitrary that generates a valid lowercased Ethereum address
 * (0x-prefixed, 40 hex characters).
 */
const arbContractAddress: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...HEX_CHARS), { minLength: 40, maxLength: 40 })
  .map((chars) => `0x${chars.join('')}`);

/**
 * Arbitrary that generates a valid NFT token ID string.
 *
 * Token IDs are typically numeric but can be large. Generates
 * integer strings in the range [0, 99999].
 */
const arbTokenId: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 99999 })
  .map(String);

/**
 * Arbitrary that generates valid NFT identifiers.
 *
 * Produces lowercased `<contractAddress>:<tokenId>` strings where
 * `contractAddress` is a valid 0x-prefixed 40-hex-char address.
 */
export const arbNftId: fc.Arbitrary<string> = fc
  .tuple(arbContractAddress, arbTokenId)
  .map(([addr, id]) => `${addr}:${id}`);

/**
 * Arbitrary that generates valid `NftLot` values.
 *
 * Each lot has a unique NFT identifier, a positive cost basis in USD
 * (decimal string), a valid acquisition date, and a source entry ID.
 */
export const arbNftLot: fc.Arbitrary<NftLot> = fc
  .record({
    nftId: arbNftId,
    costBasisUsd: arbDecimalString,
    acquiredAt: arbDate,
    sourceEntryId: fc.uuid(),
  });

/**
 * Arbitrary that generates `nft_event` type `RawEvent` objects.
 *
 * Each event has a single NFT leg with `contractAddress` and `tokenId`
 * set, a valid timestamp, and a deterministic ID. The leg amount is
 * either `'1'` (received) or `'-1'` (sent).
 */
export const arbNftRawEvent: fc.Arbitrary<RawEvent> = fc
  .record({
    contractAddress: arbContractAddress,
    tokenId: arbTokenId,
    timestamp: arbDate,
    eventId: fc.uuid(),
    accountId: fc.constant('test-account'),
    direction: fc.constantFrom('1', '-1'),
    txHash: fc.array(fc.constantFrom(...HEX_CHARS), { minLength: 64, maxLength: 64 }).map((chars) => `0x${chars.join('')}`),
    counterparty: arbContractAddress,
  })
  .map(({ contractAddress, tokenId, timestamp, eventId, accountId, direction, txHash, counterparty }) => ({
    id: `eth:${eventId}`,
    source: 'eth' as const,
    accountId,
    timestamp,
    type: 'nft_event' as const,
    legs: [
      {
        asset: contractAddress,
        amount: direction,
        contractAddress,
        tokenId,
      },
    ],
    txHash,
    counterparty,
    raw: {},
  }));

/**
 * Arbitrary that generates `DisposalResult` objects with NFT-style
 * asset identifiers.
 *
 * The `asset` field uses the truncated NFT description format
 * (`1 0x<first6>...<last4>:<tokenId>`), amount is always `'1'`,
 * and `lotsConsumed` has a single entry (NFTs are indivisible).
 */
export const arbNftDisposalResult: fc.Arbitrary<DisposalResult> = fc
  .record({
    contractAddress: arbContractAddress,
    tokenId: arbTokenId,
    proceeds: arbDecimalString,
    costBasis: arbDecimalString,
    term: fc.constantFrom('short-term' as const, 'long-term' as const),
    dates: arbDatePair,
    sourceEntryId: fc.uuid(),
    washSaleFlag: fc.boolean(),
  })
  .map(({ contractAddress, tokenId, proceeds, costBasis, term, dates, sourceEntryId, washSaleFlag }) => {
    const gainLoss = new Decimal(proceeds).minus(new Decimal(costBasis)).toFixed(2);
    const addr = contractAddress.toLowerCase();

    // Truncated NFT description format for IRS forms: 1 0x<first6>...<last4>:<tokenId>
    const prefix = addr.slice(0, 8);  // '0x' + 6 hex chars
    const suffix = addr.slice(-4);
    const asset = `1 ${prefix}...${suffix}:${tokenId}`;

    return {
      asset,
      amount: '1',
      proceeds,
      costBasis,
      gainLoss,
      term,
      acquiredAt: dates.acquiredAt,
      disposedAt: dates.disposedAt,
      sourceEntryId,
      lotsConsumed: [
        {
          lotId: `${addr}:${tokenId}`,
          amount: '1',
          costBasis,
        },
      ],
      washSaleFlag,
    };
  });

// ─── LedgerEntry history arbitraries ────────────────────────────────────

/**
 * The small asset set used for generated LedgerEntry histories.
 *
 * Deliberately tiny so that buys consistently precede sells across the
 * generated sequence, avoiding "insufficient basis" warnings.
 */
const HISTORY_ASSETS = ['BTC', 'ETH', 'SOL'] as const;

/**
 * Base timestamp for generated histories: 2022-01-01T00:00:00Z.
 *
 * Each entry in the history uses `BASE_TS + index * ONE_DAY_MS` so
 * timestamps are strictly increasing and total-ordered — this sidesteps
 * the equal-timestamp tie-break issue in computeTax's sort.
 */
const BASE_TS = Date.UTC(2022, 0, 1);
const ONE_DAY_MS = 86_400_000;

/**
 * Tax year used for generated histories (2023).
 *
 * Entries span 2022–2023, so some disposals fall in-year and some
 * establish prior-year basis — a realistic scenario.
 */
export const HISTORY_TAX_YEAR = 2023;

/**
 * Build a `trade` LedgerEntry representing a buy.
 *
 * The entry has:
 *   - a positive leg for the crypto asset (amount = `qty`, USD at `price * qty`)
 *   - a negative USD leg (so computeTax sees it as a plain acquisition)
 *
 * @internal Used by arbLedgerHistory.
 */
function makeBuyEntry(
  id: string,
  asset: string,
  qty: string,
  priceUsd: string,
  timestamp: Date,
): LedgerEntry {
  const totalUsd = new Decimal(qty).mul(new Decimal(priceUsd)).toFixed(2);
  const legs: AssetLeg[] = [
    { asset, amount: qty, amountUsdAtTime: totalUsd },
    { asset: 'USD', amount: `-${totalUsd}`, amountUsdAtTime: totalUsd },
  ];
  return { id, timestamp, type: 'trade', legs, rawEventIds: [id] };
}

/**
 * Build a `trade` LedgerEntry representing a sell.
 *
 * The entry has:
 *   - a negative leg for the crypto asset (amount = `-qty`, USD at `price * qty`)
 *   - a positive USD leg
 *   - an optional fee leg with `feeFlag: true`
 *
 * @internal Used by arbLedgerHistory.
 */
function makeSellEntry(
  id: string,
  asset: string,
  qty: string,
  priceUsd: string,
  feeUsd: string | null,
  timestamp: Date,
): LedgerEntry {
  const totalUsd = new Decimal(qty).mul(new Decimal(priceUsd)).toFixed(2);
  const legs: AssetLeg[] = [
    { asset, amount: `-${qty}`, amountUsdAtTime: totalUsd },
    { asset: 'USD', amount: totalUsd, amountUsdAtTime: totalUsd },
  ];
  if (feeUsd !== null) {
    legs.push({ asset: 'USD', amount: `-${feeUsd}`, amountUsdAtTime: feeUsd, feeFlag: true });
  }
  return { id, timestamp, type: 'trade', legs, rawEventIds: [id] };
}

/**
 * Build an `income` LedgerEntry.
 *
 * @internal Used by arbLedgerHistory.
 */
function makeIncomeEntry(
  id: string,
  asset: string,
  qty: string,
  priceUsd: string,
  timestamp: Date,
): LedgerEntry {
  const totalUsd = new Decimal(qty).mul(new Decimal(priceUsd)).toFixed(2);
  const legs: AssetLeg[] = [
    { asset, amount: qty, amountUsdAtTime: totalUsd },
  ];
  return { id, timestamp, type: 'income', legs, rawEventIds: [id] };
}

/**
 * Arbitrary that generates a realistic sequence of LedgerEntries.
 *
 * ### Design invariants
 * - Strictly increasing timestamps (BASE_TS + index * ONE_DAY_MS).
 * - Per-asset pool is always funded before sells: buys precede sells for
 *   each asset, so "insufficient basis" warnings do not occur.
 * - Amounts are integers-in-cents (1–10 000 hundredths → 0.01–100.00)
 *   to keep Decimal arithmetic exact across the history.
 * - Prices are integers-in-cents (1–100 000 hundredths → 0.01–1 000.00
 *   USD per unit) — cheap enough to stay representable, varied enough
 *   to exercise FIFO vs HIFO ordering.
 * - Fees are optional (null = no fee leg). When present, fee is in
 *   [0.01, 5.00] USD.
 * - Tax year is HISTORY_TAX_YEAR (2023); entries span 2022–2023.
 * - At most 30 entries to keep shrinking fast.
 *
 * Exported so engine-invariants.test.ts can use it directly.
 */
export const arbLedgerHistory: fc.Arbitrary<LedgerEntry[]> = fc
  .array(
    fc.record({
      assetIndex: fc.integer({ min: 0, max: HISTORY_ASSETS.length - 1 }),
      qtyHundredths: fc.integer({ min: 1, max: 10_000 }),
      priceHundredths: fc.integer({ min: 1, max: 100_000 }),
      feeHundredths: fc.option(fc.integer({ min: 1, max: 500 }), { nil: null }),
      opType: fc.constantFrom('buy', 'sell', 'income' as const),
    }),
    { minLength: 2, maxLength: 30 },
  )
  .map((ops) => {
    // Per-asset running pool (in hundredths) — ensures sells never exceed available balance.
    const pools: Record<string, number> = { BTC: 0, ETH: 0, SOL: 0 };
    const entries: LedgerEntry[] = [];
    let entryIndex = 0;

    for (const op of ops) {
      const asset = HISTORY_ASSETS[op.assetIndex]!;
      const qty = new Decimal(op.qtyHundredths).div(100).toFixed(2);
      const price = new Decimal(op.priceHundredths).div(100).toFixed(2);
      const fee = op.feeHundredths !== null
        ? new Decimal(op.feeHundredths).div(100).toFixed(2)
        : null;
      const timestamp = new Date(BASE_TS + entryIndex * ONE_DAY_MS);
      const id = `gen-${entryIndex}-${op.opType}-${asset}`;

      if (op.opType === 'buy' || op.opType === 'income') {
        pools[asset]! += op.qtyHundredths;
        if (op.opType === 'buy') {
          entries.push(makeBuyEntry(id, asset, qty, price, timestamp));
        } else {
          entries.push(makeIncomeEntry(id, asset, qty, price, timestamp));
        }
        entryIndex++;
      } else {
        // sell — only if there's enough in the pool
        const available = pools[asset]!;
        if (available < op.qtyHundredths) {
          // Skip the sell if it would overdraw the pool
          continue;
        }
        pools[asset]! -= op.qtyHundredths;
        entries.push(makeSellEntry(id, asset, qty, price, fee, timestamp));
        entryIndex++;
      }
    }

    return entries;
  })
  // Require at least one buy (so the history is non-trivially funded)
  .filter((entries) => entries.some((e) => e.type === 'trade' && e.legs.some((l) => new Decimal(l.amount).isPositive() && l.asset !== 'USD')));

/**
 * Arbitrary that generates a pure-gain LedgerEntry history.
 *
 * Every buy is at a monotonically lower price than every subsequent sell,
 * guaranteeing all disposals produce a positive gain. This is required
 * for the method-ordering invariant (HIFO total gain <= FIFO total gain)
 * to be meaningful.
 *
 * ### Design
 * - All buys happen in 2022 at price `buyPriceHundredths` (low price).
 * - All sells happen in 2023 at price `sellPriceHundredths` (high price).
 * - `sellPriceHundredths > buyPriceHundredths` is guaranteed by construction.
 * - Uses a single asset (ETH) for simplicity.
 * - At most 20 buy/sell pairs.
 */
export const arbPureGainHistory: fc.Arbitrary<LedgerEntry[]> = fc
  .record({
    buyPriceHundredths: fc.integer({ min: 1, max: 50_000 }),
    // sell price is strictly higher than buy price
    sellPremiumHundredths: fc.integer({ min: 1, max: 50_000 }),
    lots: fc.array(
      fc.record({
        qtyHundredths: fc.integer({ min: 1, max: 10_000 }),
      }),
      { minLength: 1, maxLength: 20 },
    ),
  })
  .map(({ buyPriceHundredths, sellPremiumHundredths, lots }) => {
    const sellPriceHundredths = buyPriceHundredths + sellPremiumHundredths;
    const buyPrice = new Decimal(buyPriceHundredths).div(100).toFixed(2);
    const sellPrice = new Decimal(sellPriceHundredths).div(100).toFixed(2);

    const entries: LedgerEntry[] = [];
    let idx = 0;

    for (const lot of lots) {
      const qty = new Decimal(lot.qtyHundredths).div(100).toFixed(2);
      // Buy in 2022 (before the tax year)
      const buyTs = new Date(BASE_TS + idx * ONE_DAY_MS);
      entries.push(makeBuyEntry(`pure-buy-${idx}`, 'ETH', qty, buyPrice, buyTs));
      idx++;
    }

    for (const lot of lots) {
      const qty = new Decimal(lot.qtyHundredths).div(100).toFixed(2);
      // Sell in 2023 (within the tax year) — strictly after all buys
      const sellTs = new Date(Date.UTC(2023, 0, 1) + idx * ONE_DAY_MS);
      entries.push(makeSellEntry(`pure-sell-${idx}`, 'ETH', qty, sellPrice, null, sellTs));
      idx++;
    }

    return entries;
  });

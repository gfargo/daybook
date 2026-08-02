/**
 * Benchmark: applyWashSaleFlags — indexed O(A + D·W) vs naïve O(D·A)
 *
 * Run manually with:
 *   pnpm bench
 * or:
 *   pnpm --filter @daybook/tax exec vitest bench
 *
 * NOT included in `pnpm test` (vitest.config.ts only includes *.test.ts).
 */

import Decimal from 'decimal.js';
import { bench, describe } from 'vitest';
import type { AcquisitionRecord } from './wash-sale.js';
import { applyWashSaleFlags } from './wash-sale.js';
import type { DisposalResult } from './types.js';

// ─────────────────────────────────────────────────────────────────────────
// Deterministic dataset generation
// ─────────────────────────────────────────────────────────────────────────

/** Simple LCG so the dataset is reproducible. */
function makeLcg(seed: number): () => number {
  const a = 1_664_525;
  const c = 1_013_904_223;
  const m = 2 ** 32;
  let state = seed >>> 0;
  return () => {
    state = (a * state + c) >>> 0;
    return state / m;
  };
}

/** Naïve O(D×A) implementation kept here for reference comparison. */
function naiveApplyWashSaleFlags(
  disposals: DisposalResult[],
  acquisitions: ReadonlyArray<AcquisitionRecord>,
): DisposalResult[] {
  const MS = 86_400_000;
  const WINDOW = 30;
  const dayOf = (d: Date) => Math.floor(d.getTime() / MS);
  return disposals.map((d) => {
    if (new Decimal(d.gainLoss).gte(0)) return { ...d, washSaleFlag: false };
    const disposalDay = dayOf(d.disposedAt);
    const flag = acquisitions.some(
      (a) => a.asset === d.asset && Math.abs(dayOf(a.acquiredAt) - disposalDay) <= WINDOW,
    );
    return { ...d, washSaleFlag: flag };
  });
}

function makeDisposal(
  overrides: Partial<DisposalResult> & { asset: string; gainLoss: string; disposedAt: Date },
): DisposalResult {
  return {
    amount: '1.0',
    proceeds: '1000',
    costBasis: '1000',
    term: 'short-term',
    acquiredAt: new Date('2024-01-01T00:00:00Z'),
    sourceEntryId: 'entry-bench',
    lotsConsumed: [],
    washSaleFlag: false,
    ...overrides,
  };
}

function buildDataset(
  disposalCount: number,
  acquisitionCount: number,
  seed = 0xdeadbeef,
): { disposals: DisposalResult[]; acquisitions: AcquisitionRecord[] } {
  const rand = makeLcg(seed);
  const assets = ['BTC', 'ETH', 'SOL', 'MATIC', 'AVAX', 'LINK', 'UNI', 'AAVE', 'DOT', 'ADA'];
  const BASE_DAY = Math.floor(new Date('2024-01-01T00:00:00Z').getTime() / 86_400_000);
  const SPREAD = 1000;

  const acquisitions: AcquisitionRecord[] = Array.from({ length: acquisitionCount }, () => ({
    asset: assets[Math.floor(rand() * assets.length)]!,
    acquiredAt: new Date(
      (BASE_DAY + Math.floor(rand() * SPREAD * 2 - SPREAD)) * 86_400_000,
    ),
  }));

  const disposals: DisposalResult[] = Array.from({ length: disposalCount }, (_, i) => {
    const isLoss = rand() < 0.7;
    return makeDisposal({
      asset: assets[Math.floor(rand() * assets.length)]!,
      gainLoss: isLoss
        ? (-1 * (rand() * 1000 + 1)).toFixed(2)
        : (rand() * 1000 + 1).toFixed(2),
      disposedAt: new Date(
        (BASE_DAY + Math.floor(rand() * SPREAD * 2 - SPREAD)) * 86_400_000,
      ),
      sourceEntryId: `entry-${i}`,
    });
  });

  return { disposals, acquisitions };
}

// ─────────────────────────────────────────────────────────────────────────
// Benchmarks
// ─────────────────────────────────────────────────────────────────────────

describe('applyWashSaleFlags — 10k disposals × 50k acquisitions', () => {
  const { disposals, acquisitions } = buildDataset(10_000, 50_000);

  bench('indexed (O(A + D·W))', () => {
    applyWashSaleFlags(disposals, acquisitions);
  });

  bench('naïve (O(D·A))', () => {
    naiveApplyWashSaleFlags(disposals, acquisitions);
  });
});

describe('applyWashSaleFlags — 1k disposals × 5k acquisitions', () => {
  const { disposals, acquisitions } = buildDataset(1_000, 5_000);

  bench('indexed (O(A + D·W))', () => {
    applyWashSaleFlags(disposals, acquisitions);
  });

  bench('naïve (O(D·A))', () => {
    naiveApplyWashSaleFlags(disposals, acquisitions);
  });
});

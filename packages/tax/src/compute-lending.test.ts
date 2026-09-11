/**
 * Tax-engine integration tests for Aave/Compound lending round-trip
 * classification (OSS-1197, sub-item 3/5 of OSS-128).
 *
 * These tests verify that:
 *   1. A deposit (underlying disposal → receipt-token acquisition) is correctly
 *      processed by the trade cost-basis path — producing a disposal of the
 *      underlying and an acquisition of the aToken/cToken at the principal USD.
 *   2. A withdrawal (receipt-token disposal → underlying acquisition) is the
 *      symmetric case: disposes the receipt token at principal USD.
 *   3. No income event is produced by a lending round-trip (interest accrual
 *      is explicitly out of scope — deferred to sub-item 5 of OSS-128).
 *   4. A subsequent withdrawal at the same principal produces ~$0 gain/loss,
 *      confirming there is no synthetic interest baked into the trade basis.
 *
 * IMPORTANT — explicitly out of scope for these tests and for rule 10:
 *   aToken / cToken balance growth from interest accrual (rebasing on Aave V2,
 *   exchange-rate growth on Aave V3 / Compound V2) is NOT modelled here.
 *   Any extra tokens that accumulate in the wallet without a matching on-chain
 *   transfer event will be unpriced / unclassified until sub-item 5 implements
 *   the accrual / yield income classification rule.
 *
 * These tests build LedgerEntries exactly as the classifier (rule 10) would
 * emit them, then feed them directly to computeTax — isolating the tax-engine
 * behavior from the classification step.
 */

import { describe, expect, it } from 'vitest';
import type { AssetLeg, LedgerEntry, LedgerEntryType } from '@daybook/ledger';
import { computeTax } from './compute.js';
import { FIFO } from './cost-basis.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeEntry(overrides: {
  id: string;
  timestamp: Date;
  type: LedgerEntryType;
  legs: AssetLeg[];
  rawEventIds?: string[];
  reason?: string;
}): LedgerEntry {
  return {
    rawEventIds: [overrides.id],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Aave V3 USDC deposit: principal-only disposal/acquisition
// ─────────────────────────────────────────────────────────────────────────

describe('Aave V3 USDC deposit — principal-only disposal/acquisition', () => {
  /**
   * Scenario: user deposits 1000 USDC into Aave V3 at $1000 FMV.
   * Rule 10 produces a single 'trade' entry: -1000 USDC / +1000 aEthUSDC.
   * Expected tax outcome:
   *   - One USDC disposal at $1000 proceeds (acquired at $1000)
   *   - aEthUSDC lot created with $1000 basis
   *   - income.totalUsd === '0' (no income from lending principal)
   */
  it('produces a USDC disposal and aEthUSDC acquisition, zero income', () => {
    // Prior acquisition of 1000 USDC at $1000
    const buyUsdc = makeEntry({
      id: 'buy-usdc',
      timestamp: new Date('2024-01-15T00:00:00Z'),
      type: 'trade',
      legs: [
        { asset: 'USDC', amount: '1000', amountUsdAtTime: '1000' },
        { asset: 'USD', amount: '-1000', amountUsdAtTime: '1000' },
      ],
    });

    // Rule 10 trade: USDC out → aEthUSDC in (principal $1000)
    const deposit = makeEntry({
      id: 'aave-v3-deposit',
      timestamp: new Date('2024-06-01T00:00:00Z'),
      type: 'trade',
      reason: 'Aave V3 aEthUSDC supply (tx 0xdeadbeef…)',
      legs: [
        { asset: 'USDC', amount: '-1000', amountUsdAtTime: '1000' },
        {
          asset: 'aEthUSDC',
          amount: '1000',
          amountUsdAtTime: '1000',
          contractAddress: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
        },
      ],
    });

    const result = computeTax([buyUsdc, deposit], {
      method: FIFO,
      holdingPeriodDays: 365,
      year: 2024,
    });

    // The deposit disposes USDC
    const usdcDisposal = result.disposals.find(d => d.asset === 'USDC');
    expect(usdcDisposal).toBeDefined();
    expect(usdcDisposal!.proceeds).toBe('1000');
    expect(usdcDisposal!.costBasis).toBe('1000');
    expect(usdcDisposal!.gainLoss).toBe('0');

    // No income from the lending principal deposit
    expect(result.income.totalUsd).toBe('0');
    expect(result.income.events).toHaveLength(0);
  });

  it('aEthUSDC lot is available for disposal after the deposit', () => {
    // Prior acquisition of 1000 USDC at $1000
    const buyUsdc = makeEntry({
      id: 'buy-usdc-2',
      timestamp: new Date('2024-01-15T00:00:00Z'),
      type: 'trade',
      legs: [
        { asset: 'USDC', amount: '1000', amountUsdAtTime: '1000' },
        { asset: 'USD', amount: '-1000', amountUsdAtTime: '1000' },
      ],
    });

    // Deposit trade
    const deposit = makeEntry({
      id: 'aave-v3-deposit-2',
      timestamp: new Date('2024-06-01T00:00:00Z'),
      type: 'trade',
      reason: 'Aave V3 aEthUSDC supply (tx 0xdeadbeef…)',
      legs: [
        { asset: 'USDC', amount: '-1000', amountUsdAtTime: '1000' },
        {
          asset: 'aEthUSDC',
          amount: '1000',
          amountUsdAtTime: '1000',
          contractAddress: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
        },
      ],
    });

    // Sell aEthUSDC at same principal (simulates withdrawal → no gain)
    const sellAToken = makeEntry({
      id: 'sell-ausdc',
      timestamp: new Date('2024-09-01T00:00:00Z'),
      type: 'trade',
      legs: [
        {
          asset: 'aEthUSDC',
          amount: '-1000',
          amountUsdAtTime: '1000',
          contractAddress: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
        },
        { asset: 'USD', amount: '1000', amountUsdAtTime: '1000' },
      ],
    });

    const result = computeTax([buyUsdc, deposit, sellAToken], {
      method: FIFO,
      holdingPeriodDays: 365,
      year: 2024,
    });

    const aTokenDisposal = result.disposals.find(d => d.asset === 'aEthUSDC');
    expect(aTokenDisposal).toBeDefined();
    // Basis = $1000 (from deposit trade), proceeds = $1000 → $0 gain
    expect(aTokenDisposal!.costBasis).toBe('1000');
    expect(aTokenDisposal!.proceeds).toBe('1000');
    expect(aTokenDisposal!.gainLoss).toBe('0');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Aave V3 withdrawal: aToken disposal → underlying acquisition, no income
// ─────────────────────────────────────────────────────────────────────────

describe('Aave V3 USDC withdrawal — symmetric round-trip, no income', () => {
  it('withdrawal at same principal produces ~$0 gain/loss and no income', () => {
    // Step 1: acquire USDC
    const buyUsdc = makeEntry({
      id: 'buy-usdc-w',
      timestamp: new Date('2024-01-15T00:00:00Z'),
      type: 'trade',
      legs: [
        { asset: 'USDC', amount: '1000', amountUsdAtTime: '1000' },
        { asset: 'USD', amount: '-1000', amountUsdAtTime: '1000' },
      ],
    });

    // Step 2: deposit (from rule 10) → USDC disposed, aEthUSDC acquired
    const deposit = makeEntry({
      id: 'aave-deposit-w',
      timestamp: new Date('2024-06-01T00:00:00Z'),
      type: 'trade',
      reason: 'Aave V3 aEthUSDC supply (tx 0x1…)',
      legs: [
        { asset: 'USDC', amount: '-1000', amountUsdAtTime: '1000' },
        {
          asset: 'aEthUSDC',
          amount: '1000',
          amountUsdAtTime: '1000',
          contractAddress: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
        },
      ],
    });

    // Step 3: withdrawal (from rule 10) → aEthUSDC disposed, USDC re-acquired
    // NOTE: interest accrual would produce more than 1000 aEthUSDC/USDC in
    // reality — but that delta is out of scope for sub-item 3. This test
    // models the principal-only round-trip.
    const withdrawal = makeEntry({
      id: 'aave-withdraw-w',
      timestamp: new Date('2024-09-01T00:00:00Z'),
      type: 'trade',
      reason: 'Aave V3 aEthUSDC redeem (tx 0x2…)',
      legs: [
        {
          asset: 'aEthUSDC',
          amount: '-1000',
          amountUsdAtTime: '1000',
          contractAddress: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
        },
        { asset: 'USDC', amount: '1000', amountUsdAtTime: '1000' },
      ],
    });

    const result = computeTax([buyUsdc, deposit, withdrawal], {
      method: FIFO,
      holdingPeriodDays: 365,
      year: 2024,
    });

    // Deposit: USDC disposal → $0 gain (basis $1000, proceeds $1000)
    const usdcDisposal = result.disposals.find(
      d => d.asset === 'USDC' && d.sourceEntryId === 'aave-deposit-w',
    );
    expect(usdcDisposal).toBeDefined();
    expect(usdcDisposal!.gainLoss).toBe('0');

    // Withdrawal: aEthUSDC disposal → $0 gain (basis $1000, proceeds $1000)
    const aTokenDisposal = result.disposals.find(
      d => d.asset === 'aEthUSDC' && d.sourceEntryId === 'aave-withdraw-w',
    );
    expect(aTokenDisposal).toBeDefined();
    expect(aTokenDisposal!.costBasis).toBe('1000');
    expect(aTokenDisposal!.proceeds).toBe('1000');
    expect(aTokenDisposal!.gainLoss).toBe('0');

    // No income events from the lending round-trip
    expect(result.income.totalUsd).toBe('0');
    expect(result.income.events).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Compound V2 cUSDC deposit
// ─────────────────────────────────────────────────────────────────────────

describe('Compound V2 cUSDC deposit — principal-only', () => {
  it('produces a USDC disposal and cUSDC acquisition, zero income', () => {
    const buyUsdc = makeEntry({
      id: 'comp-buy-usdc',
      timestamp: new Date('2024-02-01T00:00:00Z'),
      type: 'trade',
      legs: [
        { asset: 'USDC', amount: '500', amountUsdAtTime: '500' },
        { asset: 'USD', amount: '-500', amountUsdAtTime: '500' },
      ],
    });

    // Rule 10 trade: USDC out → cUSDC in
    const deposit = makeEntry({
      id: 'comp-deposit',
      timestamp: new Date('2024-06-15T00:00:00Z'),
      type: 'trade',
      reason: 'Compound V2 cUSDC supply (tx 0xabc…)',
      legs: [
        { asset: 'USDC', amount: '-500', amountUsdAtTime: '500' },
        {
          asset: 'cUSDC',
          amount: '22500',   // cUSDC exchange rate ~0.022 USDC/cUSDC
          amountUsdAtTime: '500',
          contractAddress: '0x39aa39c021dfbae8fac545936693ac917d5e7563',
        },
      ],
    });

    const result = computeTax([buyUsdc, deposit], {
      method: FIFO,
      holdingPeriodDays: 365,
      year: 2024,
    });

    const usdcDisposal = result.disposals.find(d => d.asset === 'USDC');
    expect(usdcDisposal).toBeDefined();
    expect(usdcDisposal!.proceeds).toBe('500');
    expect(usdcDisposal!.costBasis).toBe('500');
    expect(usdcDisposal!.gainLoss).toBe('0');

    expect(result.income.totalUsd).toBe('0');
    expect(result.income.events).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Gas fee preserved on the trade entry
// ─────────────────────────────────────────────────────────────────────────

describe('gas fee leg is preserved on the deposit trade', () => {
  it('fee is subtracted from proceeds on the USDC disposal', () => {
    const buyUsdc = makeEntry({
      id: 'fee-buy-usdc',
      timestamp: new Date('2024-01-01T00:00:00Z'),
      type: 'trade',
      legs: [
        { asset: 'USDC', amount: '1000', amountUsdAtTime: '1000' },
        { asset: 'USD', amount: '-1000', amountUsdAtTime: '1000' },
      ],
    });

    // Rule 10 trade — gas fee included as a fee leg
    const deposit = makeEntry({
      id: 'fee-deposit',
      timestamp: new Date('2024-07-01T00:00:00Z'),
      type: 'trade',
      reason: 'Aave V3 aEthUSDC supply (tx 0xfee…)',
      legs: [
        { asset: 'USDC', amount: '-1000', amountUsdAtTime: '1000' },
        {
          asset: 'aEthUSDC',
          amount: '1000',
          amountUsdAtTime: '1000',
          contractAddress: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
        },
        // Gas fee: 0.002 ETH = $6
        { asset: 'ETH', amount: '-0.002', amountUsdAtTime: '6', feeFlag: true },
      ],
    });

    const result = computeTax([buyUsdc, deposit], {
      method: FIFO,
      holdingPeriodDays: 365,
      year: 2024,
    });

    const usdcDisposal = result.disposals.find(d => d.asset === 'USDC');
    expect(usdcDisposal).toBeDefined();
    // Proceeds: $1000 - $6 fee = $994
    expect(usdcDisposal!.proceeds).toBe('994');
    expect(usdcDisposal!.costBasis).toBe('1000');
    expect(usdcDisposal!.gainLoss).toBe('-6');

    // No income
    expect(result.income.totalUsd).toBe('0');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// No-income guard: lending trade MUST NOT appear in income summary
// ─────────────────────────────────────────────────────────────────────────

describe('lending trade entries do not produce income events', () => {
  it('a deposit + withdrawal round-trip has income.totalUsd === "0"', () => {
    const entries: LedgerEntry[] = [
      makeEntry({
        id: 'buy-for-guard',
        timestamp: new Date('2024-01-01T00:00:00Z'),
        type: 'trade',
        legs: [
          { asset: 'USDC', amount: '2000', amountUsdAtTime: '2000' },
          { asset: 'USD', amount: '-2000', amountUsdAtTime: '2000' },
        ],
      }),
      makeEntry({
        id: 'deposit-guard',
        timestamp: new Date('2024-03-01T00:00:00Z'),
        type: 'trade',
        reason: 'Aave V3 aEthUSDC supply (tx 0x01…)',
        legs: [
          { asset: 'USDC', amount: '-2000', amountUsdAtTime: '2000' },
          {
            asset: 'aEthUSDC',
            amount: '2000',
            amountUsdAtTime: '2000',
            contractAddress: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
          },
        ],
      }),
      makeEntry({
        id: 'withdraw-guard',
        timestamp: new Date('2024-08-01T00:00:00Z'),
        type: 'trade',
        reason: 'Aave V3 aEthUSDC redeem (tx 0x02…)',
        legs: [
          {
            asset: 'aEthUSDC',
            amount: '-2000',
            amountUsdAtTime: '2000',
            contractAddress: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
          },
          { asset: 'USDC', amount: '2000', amountUsdAtTime: '2000' },
        ],
      }),
    ];

    const result = computeTax(entries, {
      method: FIFO,
      holdingPeriodDays: 365,
      year: 2024,
    });

    expect(result.income.totalUsd).toBe('0');
    expect(result.income.events).toHaveLength(0);
  });
});

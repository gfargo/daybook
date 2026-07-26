/**
 * Unit tests for Rule 06 — Approval gas accounting.
 *
 * Covers:
 *  - Regression: real small-value USDC transfer is NOT consumed (not fee_disposal)
 *  - Positive: genuine zero-value transfer becomes fee_disposal
 *  - Vacuous guard: leg-less crypto_out is NOT consumed
 *  - Counterparty guard: zero-value transfer without counterparty is NOT consumed
 *  - fee_only: always becomes fee_disposal regardless of amount
 */

import { describe, expect, it } from 'vitest';
import type { RawEvent } from '@daybook/ledger';
import { classify } from '../runner.js';
import { DEFAULT_RULES } from '../index.js';
import type { ClassifierContext } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<ClassifierContext> = {}): ClassifierContext {
  return {
    ownAddresses: [],
    accountIds: [],
    dexRouters: new Map(),
    bridges: new Map(),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    id: 'eth:evt-1',
    source: 'eth',
    accountId: 'eth-main',
    timestamp: new Date('2024-06-01T10:00:00Z'),
    type: 'crypto_out',
    legs: [],
    raw: {},
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Regression: small non-zero USDC transfer must NOT become fee_disposal
// ─────────────────────────────────────────────────────────────────────────

describe('Rule 06 — regression: small non-zero value is not gas-only', () => {
  it('does not consume a -0.00000005 USDC crypto_out (previously misclassified)', () => {
    const evt = makeEvent({
      id: 'eth:small-usdc',
      type: 'crypto_out',
      counterparty: '0xcontract',
      legs: [{ asset: 'USDC', amount: '-0.00000005', contractAddress: '0xusdc' }],
    });

    const result = classify([evt], [], makeContext(), DEFAULT_RULES);

    // Should NOT be fee_disposal — rule 06 must not consume it
    const feeDisposals = result.entries.filter(e => e.type === 'fee_disposal');
    expect(feeDisposals).toHaveLength(0);

    // Should end up classified by rule 07 as transfer_external_out (or similar non-fee type)
    const entry = result.entries[0];
    expect(entry).toBeDefined();
    expect(entry!.type).not.toBe('fee_disposal');

    // The leg must not have feeFlag set to true by rule 06
    const flaggedLegs = entry!.legs.filter(l => l.feeFlag);
    expect(flaggedLegs).toHaveLength(0);
  });

  it('does not consume a -0.00000001 ETH crypto_out (just below old threshold)', () => {
    const evt = makeEvent({
      id: 'eth:small-eth',
      type: 'crypto_out',
      counterparty: '0xcontract',
      legs: [{ asset: 'ETH', amount: '-0.00000001' }],
    });

    const result = classify([evt], [], makeContext(), DEFAULT_RULES);

    const feeDisposals = result.entries.filter(e => e.type === 'fee_disposal');
    expect(feeDisposals).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Positive: genuine zero-value transfer becomes fee_disposal
// ─────────────────────────────────────────────────────────────────────────

describe('Rule 06 — positive: zero-value transfer to counterparty', () => {
  it('classifies a zero-amount crypto_out to a contract as fee_disposal', () => {
    const evt = makeEvent({
      id: 'eth:zero-usdc',
      type: 'crypto_out',
      counterparty: '0xcontract',
      legs: [{ asset: 'USDC', amount: '0', contractAddress: '0xusdc' }],
    });

    const result = classify([evt], [], makeContext(), DEFAULT_RULES);

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.type).toBe('fee_disposal');
    expect(entry.rawEventIds).toContain('eth:zero-usdc');
    // All legs must be marked feeFlag
    expect(entry.legs.every(l => l.feeFlag)).toBe(true);
  });

  it('handles -0 and 0.0 as zero (Decimal normalization)', () => {
    for (const amount of ['-0', '0.0', '0.000']) {
      const evt = makeEvent({
        id: `eth:zero-${amount}`,
        type: 'crypto_out',
        counterparty: '0xcontract',
        legs: [{ asset: 'ETH', amount }],
      });

      const result = classify([evt], [], makeContext(), DEFAULT_RULES);
      const entry = result.entries[0];
      expect(entry?.type).toBe('fee_disposal');
    }
  });

  it('does NOT classify when mixed legs: one zero + one non-zero principal', () => {
    const evt = makeEvent({
      id: 'eth:mixed',
      type: 'crypto_out',
      counterparty: '0xcontract',
      legs: [
        { asset: 'USDC', amount: '0' },
        { asset: 'ETH', amount: '-0.001' },
      ],
    });

    const result = classify([evt], [], makeContext(), DEFAULT_RULES);
    const feeDisposals = result.entries.filter(e => e.type === 'fee_disposal');
    expect(feeDisposals).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Vacuous guard: leg-less crypto_out is NOT consumed
// ─────────────────────────────────────────────────────────────────────────

describe('Rule 06 — vacuous guard: no principal legs', () => {
  it('does not consume a crypto_out with no legs', () => {
    const evt = makeEvent({
      id: 'eth:no-legs',
      type: 'crypto_out',
      counterparty: '0xcontract',
      legs: [],
    });

    const result = classify([evt], [], makeContext(), DEFAULT_RULES);
    const feeDisposals = result.entries.filter(e => e.type === 'fee_disposal');
    expect(feeDisposals).toHaveLength(0);
  });

  it('does not consume a crypto_out where every leg is already feeFlag', () => {
    const evt = makeEvent({
      id: 'eth:all-fee-legs',
      type: 'crypto_out',
      counterparty: '0xcontract',
      legs: [{ asset: 'ETH', amount: '-0.002', feeFlag: true }],
    });

    const result = classify([evt], [], makeContext(), DEFAULT_RULES);
    const rule06Entries = result.entries.filter(
      e => e.type === 'fee_disposal' && e.rawEventIds.includes('eth:all-fee-legs'),
    );
    // Should not be newly consumed by rule 06's crypto_out branch
    // (it may still produce a fee_disposal via another path, but
    //  rule 06's crypto_out guard requires at least one non-fee leg)
    expect(rule06Entries).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Counterparty guard: no counterparty → not consumed by rule 06
// ─────────────────────────────────────────────────────────────────────────

describe('Rule 06 — counterparty guard', () => {
  it('does not consume a zero-value crypto_out without a counterparty', () => {
    const evt = makeEvent({
      id: 'eth:no-counterparty',
      type: 'crypto_out',
      counterparty: undefined,
      legs: [{ asset: 'ETH', amount: '0' }],
    });

    const result = classify([evt], [], makeContext(), DEFAULT_RULES);
    const feeDisposals = result.entries.filter(e => e.type === 'fee_disposal');
    expect(feeDisposals).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Preserved: fee_only always becomes fee_disposal
// ─────────────────────────────────────────────────────────────────────────

describe('Rule 06 — preserved: fee_only events', () => {
  it('classifies fee_only events as fee_disposal', () => {
    const evt = makeEvent({
      id: 'eth:fee-only',
      type: 'fee_only',
      counterparty: '0xcontract',
      legs: [{ asset: 'ETH', amount: '-0.002', feeFlag: true }],
    });

    const result = classify([evt], [], makeContext(), DEFAULT_RULES);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.type).toBe('fee_disposal');
    expect(result.entries[0]!.rawEventIds).toContain('eth:fee-only');
  });

  it('classifies fee_only with no counterparty as fee_disposal', () => {
    const evt = makeEvent({
      id: 'eth:fee-only-no-cp',
      type: 'fee_only',
      counterparty: undefined,
      legs: [{ asset: 'ETH', amount: '-0.001', feeFlag: true }],
    });

    const result = classify([evt], [], makeContext(), DEFAULT_RULES);
    expect(result.entries[0]!.type).toBe('fee_disposal');
  });
});

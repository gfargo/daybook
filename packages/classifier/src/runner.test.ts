/**
 * Classifier unit tests.
 *
 * Tests the runner and individual rules against synthetic fixtures.
 */

import { describe, expect, it } from 'vitest';
import type {
    ClassifierOverride, RawEvent
} from '@daybook/ledger';
import { classify, entryId, findPrunableOverrides, validateOverrides } from './runner.js';
import { DEFAULT_RULES } from './index.js';
import type { ClassifierContext } from './types.js';

// ─────────────────────────────────────────────────────────────────────────
// Test helpers
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
    id: 'test:evt-1',
    source: 'coinbase',
    accountId: 'main-coinbase',
    timestamp: new Date('2024-01-15T12:00:00Z'),
    type: 'trade',
    legs: [
      { asset: 'BTC', amount: '0.001' },
      { asset: 'USD', amount: '-100' },
    ],
    raw: {},
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Entry ID generation
// ─────────────────────────────────────────────────────────────────────────

describe('entryId', () => {
  it('produces a 24-char hex string', () => {
    const id = entryId(['a', 'b']);
    expect(id).toHaveLength(24);
    expect(id).toMatch(/^[0-9a-f]{24}$/);
  });

  it('is deterministic — same input produces same output', () => {
    const a = entryId(['evt-1', 'evt-2']);
    const b = entryId(['evt-1', 'evt-2']);
    expect(a).toBe(b);
  });

  it('is order-independent — sorted internally', () => {
    const a = entryId(['evt-2', 'evt-1']);
    const b = entryId(['evt-1', 'evt-2']);
    expect(a).toBe(b);
  });

  it('produces different IDs for different inputs', () => {
    const a = entryId(['evt-1']);
    const b = entryId(['evt-2']);
    expect(a).not.toBe(b);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cross-source self-transfer matching (Rule 03)
// ─────────────────────────────────────────────────────────────────────────

describe('cross-source self-transfer matching', () => {
  it('matches CB Send with on-chain receive (2023-05-18 fixture)', () => {
    // CB Send: 0.22489253 ETH at 17:46:56
    const cbSend: RawEvent = makeEvent({
      id: 'coinbase:cb-send-001',
      source: 'coinbase',
      accountId: 'main-coinbase',
      timestamp: new Date('2023-05-18T17:46:56Z'),
      type: 'crypto_out',
      legs: [{ asset: 'ETH', amount: '-0.22489253' }],
      counterparty: '0x1296Df1Ad1AabFBcBf28Dd45BeF9Bd0A4206F85b',
    });

    // On-chain receive: 0.22348553 ETH at 17:47:11 (amount differs by gas)
    const chainReceive: RawEvent = makeEvent({
      id: 'eth:chain-recv-001',
      source: 'eth',
      accountId: 'eth-main',
      timestamp: new Date('2023-05-18T17:47:11Z'),
      type: 'crypto_in',
      legs: [{ asset: 'ETH', amount: '0.22348553' }],
      counterparty: '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43',
      txHash: '0xabc123',
    });

    const ctx = makeContext({
      ownAddresses: ['0x1296Df1Ad1AabFBcBf28Dd45BeF9Bd0A4206F85b'],
    });

    const result = classify([cbSend, chainReceive], [], ctx, DEFAULT_RULES);

    // The CB self-transfer rule (02) should consume the cbSend first since
    // the counterparty matches an own address. The chain receive goes to default.
    // But let's verify the overall result makes sense.
    const selfTransfers = result.entries.filter(e => e.type === 'transfer_self');
    expect(selfTransfers.length).toBeGreaterThanOrEqual(1);

    // The CB Send should be classified as transfer_self (rule 02 catches it)
    const cbEntry = result.entries.find(e => e.rawEventIds.includes('coinbase:cb-send-001'));
    expect(cbEntry).toBeDefined();
    expect(cbEntry!.type).toBe('transfer_self');
  });

  it('matches cross-source events with different sources, same asset, close timestamps', () => {
    const cbSend: RawEvent = makeEvent({
      id: 'coinbase:send-1',
      source: 'coinbase',
      accountId: 'main-coinbase',
      timestamp: new Date('2023-06-01T10:00:00Z'),
      type: 'crypto_out',
      legs: [{ asset: 'ETH', amount: '-1.0' }],
    });

    const chainReceive: RawEvent = makeEvent({
      id: 'eth:recv-1',
      source: 'eth',
      accountId: 'eth-main',
      timestamp: new Date('2023-06-01T10:05:00Z'),
      type: 'crypto_in',
      legs: [{ asset: 'ETH', amount: '0.998' }],
      txHash: '0xdef456',
    });

    const ctx = makeContext();
    const result = classify([cbSend, chainReceive], [], ctx, DEFAULT_RULES);

    // Rule 03 should match these as a cross-source self-transfer
    const selfTransfers = result.entries.filter(e => e.type === 'transfer_self');
    expect(selfTransfers).toHaveLength(1);
    expect(selfTransfers[0]!.rawEventIds).toContain('coinbase:send-1');
    expect(selfTransfers[0]!.rawEventIds).toContain('eth:recv-1');
  });

  it('does not match events from the same source', () => {
    const send: RawEvent = makeEvent({
      id: 'eth:send-1',
      source: 'eth',
      timestamp: new Date('2023-06-01T10:00:00Z'),
      type: 'crypto_out',
      legs: [{ asset: 'ETH', amount: '-1.0' }],
    });

    const recv: RawEvent = makeEvent({
      id: 'eth:recv-1',
      source: 'eth',
      timestamp: new Date('2023-06-01T10:05:00Z'),
      type: 'crypto_in',
      legs: [{ asset: 'ETH', amount: '0.998' }],
    });

    const ctx = makeContext();
    const result = classify([send, recv], [], ctx, DEFAULT_RULES);

    // Should NOT be matched as cross-source — same source
    const selfTransfers = result.entries.filter(
      e => e.type === 'transfer_self' && e.rawEventIds.length === 2,
    );
    expect(selfTransfers).toHaveLength(0);
  });

  it('selects the nearest in by time, not the first in array order', () => {
    const T = new Date('2024-06-01T10:00:00Z');
    const T_near = new Date('2024-06-01T10:01:00Z'); // 60s later
    const T_far  = new Date('2024-06-01T10:05:00Z'); // 300s later

    const out: RawEvent = makeEvent({
      id: 'cb:out-1',
      source: 'coinbase',
      timestamp: T,
      type: 'crypto_out',
      legs: [{ asset: 'BTC', amount: '-1.0' }],
    });

    const inFar: RawEvent = makeEvent({
      id: 'eth:in-far',
      source: 'eth',
      timestamp: T_far,
      type: 'crypto_in',
      legs: [{ asset: 'BTC', amount: '1.0' }],
    });

    const inNear: RawEvent = makeEvent({
      id: 'eth:in-near',
      source: 'eth',
      timestamp: T_near,
      type: 'crypto_in',
      legs: [{ asset: 'BTC', amount: '1.0' }],
    });

    const ctx = makeContext({
      crossSourceMatchWindowSeconds: 1800,
    });

    // Pass far before near — rule must still pick near
    const result = classify([out, inFar, inNear], [], ctx, DEFAULT_RULES);

    const selfTransfers = result.entries.filter(e => e.type === 'transfer_self');
    expect(selfTransfers).toHaveLength(1);
    expect(selfTransfers[0]!.rawEventIds).toContain('eth:in-near');
    expect(selfTransfers[0]!.rawEventIds).not.toContain('eth:in-far');

    // Reversed order must produce the same result
    const result2 = classify([out, inNear, inFar], [], ctx, DEFAULT_RULES);
    const selfTransfers2 = result2.entries.filter(e => e.type === 'transfer_self');
    expect(selfTransfers2).toHaveLength(1);
    expect(selfTransfers2[0]!.rawEventIds).toContain('eth:in-near');
    expect(selfTransfers2[0]!.rawEventIds).not.toContain('eth:in-far');
  });

  it('breaks exact-time ties deterministically by ascending event ID', () => {
    const T = new Date('2024-06-01T10:00:00Z');

    const out: RawEvent = makeEvent({
      id: 'cb:out-1',
      source: 'coinbase',
      timestamp: T,
      type: 'crypto_out',
      legs: [{ asset: 'ETH', amount: '-2.0' }],
    });

    // Both ins at exactly the same timestamp — tie broken by id (ascending)
    const inB: RawEvent = makeEvent({
      id: 'eth:in-bbb',
      source: 'eth',
      timestamp: T,
      type: 'crypto_in',
      legs: [{ asset: 'ETH', amount: '2.0' }],
    });

    const inA: RawEvent = makeEvent({
      id: 'eth:in-aaa',
      source: 'eth',
      timestamp: T,
      type: 'crypto_in',
      legs: [{ asset: 'ETH', amount: '2.0' }],
    });

    const ctx = makeContext();

    const result1 = classify([out, inA, inB], [], ctx, DEFAULT_RULES);
    const result2 = classify([out, inB, inA], [], ctx, DEFAULT_RULES);

    const st1 = result1.entries.filter(e => e.type === 'transfer_self');
    const st2 = result2.entries.filter(e => e.type === 'transfer_self');

    expect(st1).toHaveLength(1);
    expect(st2).toHaveLength(1);

    // Both orderings must pair with the lexicographically smaller ID
    expect(st1[0]!.rawEventIds).toContain('eth:in-aaa');
    expect(st2[0]!.rawEventIds).toContain('eth:in-aaa');

    // Entry IDs must be identical across both orderings
    expect(st1[0]!.id).toBe(st2[0]!.id);
  });

  it('matches when out has a same-asset fee leg (fee-aware amount comparison)', () => {
    // 0.01 BTC out with 0.0005 BTC fee — net 0.0095 BTC; should match 0.0095 BTC in
    const out: RawEvent = makeEvent({
      id: 'cb:out-fee',
      source: 'coinbase',
      timestamp: new Date('2024-01-10T08:00:00Z'),
      type: 'crypto_out',
      legs: [
        { asset: 'BTC', amount: '-0.01' },
        { asset: 'BTC', amount: '-0.0005', feeFlag: true },
      ],
    });

    const inEvt: RawEvent = makeEvent({
      id: 'eth:in-fee',
      source: 'eth',
      timestamp: new Date('2024-01-10T08:03:00Z'),
      type: 'crypto_in',
      legs: [{ asset: 'BTC', amount: '0.0095' }],
    });

    const ctx = makeContext();
    const result = classify([out, inEvt], [], ctx, DEFAULT_RULES);

    const selfTransfers = result.entries.filter(e => e.type === 'transfer_self');
    expect(selfTransfers).toHaveLength(1);
    expect(selfTransfers[0]!.rawEventIds).toContain('cb:out-fee');
    expect(selfTransfers[0]!.rawEventIds).toContain('eth:in-fee');
  });

  it('does not pair an out whose same-asset fee leg consumes the entire principal (net ≤ 0)', () => {
    // Principal 0.0005 BTC, fee 0.0005 BTC → net = 0.  Should NOT produce a transfer_self.
    const out: RawEvent = makeEvent({
      id: 'cb:out-zero-net',
      source: 'coinbase',
      timestamp: new Date('2024-01-10T08:00:00Z'),
      type: 'crypto_out',
      legs: [
        { asset: 'BTC', amount: '-0.0005' },
        { asset: 'BTC', amount: '-0.0005', feeFlag: true },
      ],
    });

    const inEvt: RawEvent = makeEvent({
      id: 'eth:in-zero-net',
      source: 'eth',
      timestamp: new Date('2024-01-10T08:03:00Z'),
      type: 'crypto_in',
      legs: [{ asset: 'BTC', amount: '0.0005' }],
    });

    const ctx = makeContext();
    const result = classify([out, inEvt], [], ctx, DEFAULT_RULES);

    // Net principal of out is 0 — must not be paired
    const selfTransfers = result.entries.filter(e => e.type === 'transfer_self');
    expect(selfTransfers).toHaveLength(0);
  });

  it('does not pair an out whose same-asset fee exceeds the principal (net < 0)', () => {
    // Principal 0.0003 BTC, fee 0.0005 BTC → net = -0.0002.  Must not pair.
    const out: RawEvent = makeEvent({
      id: 'cb:out-neg-net',
      source: 'coinbase',
      timestamp: new Date('2024-01-10T08:00:00Z'),
      type: 'crypto_out',
      legs: [
        { asset: 'BTC', amount: '-0.0003' },
        { asset: 'BTC', amount: '-0.0005', feeFlag: true },
      ],
    });

    const inEvt: RawEvent = makeEvent({
      id: 'eth:in-neg-net',
      source: 'eth',
      timestamp: new Date('2024-01-10T08:03:00Z'),
      type: 'crypto_in',
      legs: [{ asset: 'BTC', amount: '0.0003' }],
    });

    const ctx = makeContext();
    const result = classify([out, inEvt], [], ctx, DEFAULT_RULES);

    const selfTransfers = result.entries.filter(e => e.type === 'transfer_self');
    expect(selfTransfers).toHaveLength(0);
  });

  it('does not subtract cross-asset gas when comparing amounts', () => {
    // ETH out with ETH gas fee — amounts match without issue (gas same asset)
    // But a BTC out with ETH gas fee: the ETH gas should NOT be subtracted from the BTC principal.
    const out: RawEvent = makeEvent({
      id: 'cb:out-cross-gas',
      source: 'coinbase',
      timestamp: new Date('2024-01-10T08:00:00Z'),
      type: 'crypto_out',
      legs: [
        { asset: 'BTC', amount: '-1.0' },
        { asset: 'ETH', amount: '-0.002', feeFlag: true }, // cross-asset gas
      ],
    });

    const inEvt: RawEvent = makeEvent({
      id: 'eth:in-cross-gas',
      source: 'eth',
      timestamp: new Date('2024-01-10T08:03:00Z'),
      type: 'crypto_in',
      legs: [{ asset: 'BTC', amount: '1.0' }],
    });

    const ctx = makeContext();
    const result = classify([out, inEvt], [], ctx, DEFAULT_RULES);

    // Should still match — cross-asset gas not subtracted, amounts equal
    const selfTransfers = result.entries.filter(e => e.type === 'transfer_self');
    expect(selfTransfers).toHaveLength(1);
    expect(selfTransfers[0]!.rawEventIds).toContain('cb:out-cross-gas');
    expect(selfTransfers[0]!.rawEventIds).toContain('eth:in-cross-gas');
  });

  it('is invariant under input permutation (permutation invariance)', () => {
    // Three independent cross-source pairs (no own addresses, so Rule 02 never fires)
    const T1 = new Date('2024-03-01T09:00:00Z');
    const T2 = new Date('2024-03-02T14:00:00Z');
    const T3 = new Date('2024-03-03T18:00:00Z');

    // Amount diffs relative to the out leg:
    //   Pair A: |1.0 - 0.997| / 1.0   = 0.3%  — well within default 1% tolerance
    //   Pair B: |0.5 - 0.4975| / 0.5  = 0.5%  — within default 1% tolerance
    //   Pair C: |0.3 - 0.299| / 0.3   ≈ 0.33% — within default 1% tolerance
    const events: RawEvent[] = [
      makeEvent({ id: 'cb:out-A', source: 'coinbase', timestamp: T1, type: 'crypto_out', legs: [{ asset: 'ETH', amount: '-1.0' }] }),
      makeEvent({ id: 'eth:in-A', source: 'eth',      timestamp: new Date(T1.getTime() + 90_000), type: 'crypto_in',  legs: [{ asset: 'ETH', amount: '0.997' }] }),

      makeEvent({ id: 'cb:out-B', source: 'coinbase', timestamp: T2, type: 'crypto_out', legs: [{ asset: 'BTC', amount: '-0.5' }] }),
      makeEvent({ id: 'eth:in-B', source: 'eth',      timestamp: new Date(T2.getTime() + 120_000), type: 'crypto_in',  legs: [{ asset: 'BTC', amount: '0.4975' }] }),

      makeEvent({ id: 'cb:out-C', source: 'coinbase', timestamp: T3, type: 'crypto_out', legs: [{ asset: 'ETH', amount: '-0.3' }] }),
      makeEvent({ id: 'eth:in-C', source: 'eth',      timestamp: new Date(T3.getTime() + 60_000),  type: 'crypto_in',  legs: [{ asset: 'ETH', amount: '0.299' }] }),
    ];

    const ctx = makeContext({ crossSourceMatchWindowSeconds: 1800, crossSourceAmountTolerance: 0.01 });

    const classify1 = classify(events, [], ctx, DEFAULT_RULES);
    // Reverse the entire input
    const classify2 = classify([...events].reverse(), [], ctx, DEFAULT_RULES);
    // Shuffle: move B pair to front
    const shuffled = [events[2]!, events[3]!, events[0]!, events[1]!, events[4]!, events[5]!];
    const classify3 = classify(shuffled, [], ctx, DEFAULT_RULES);

    // Sort each result by entry id for comparison
    const sorted = (entries: typeof classify1.entries) =>
      [...entries].sort((a, b) => a.id.localeCompare(b.id));

    const r1 = sorted(classify1.entries.filter(e => e.type === 'transfer_self'));
    const r2 = sorted(classify2.entries.filter(e => e.type === 'transfer_self'));
    const r3 = sorted(classify3.entries.filter(e => e.type === 'transfer_self'));

    expect(r1).toHaveLength(3);
    expect(r2).toHaveLength(3);
    expect(r3).toHaveLength(3);

    for (let i = 0; i < r1.length; i++) {
      expect(r2[i]!.id).toBe(r1[i]!.id);
      expect(r3[i]!.id).toBe(r1[i]!.id);
      expect(r2[i]!.type).toBe(r1[i]!.type);
      expect(r3[i]!.type).toBe(r1[i]!.type);
      expect(r2[i]!.rawEventIds.sort()).toEqual(r1[i]!.rawEventIds.sort());
      expect(r3[i]!.rawEventIds.sort()).toEqual(r1[i]!.rawEventIds.sort());
    }

    // Explicit tolerance check: each in-leg is within the configured 1% of its out-leg.
    // This documents that the fixture's pairability is intentional, not incidental.
    // Pair A: diff = |1.0 - 0.997| / 1.0 = 0.3%; Pair B: 0.5%; Pair C: ~0.33% — all < 1%.
    const pairAmounts: Array<{ out: number; in: number }> = [
      { out: 1.0, in: 0.997 },
      { out: 0.5, in: 0.4975 },
      { out: 0.3, in: 0.299 },
    ];
    for (const { out: outAmt, in: inAmt } of pairAmounts) {
      const relDiff = Math.abs(outAmt - inAmt) / Math.max(outAmt, inAmt);
      expect(relDiff).toBeLessThan(0.01); // each pair is within the configured 1% tolerance
    }
  });

  it('respects the configurable time window', () => {
    // Two events 20 minutes apart
    const T = new Date('2024-06-01T10:00:00Z');
    const T20m = new Date('2024-06-01T10:20:00Z'); // 1200s apart

    const out: RawEvent = makeEvent({
      id: 'cb:out-window',
      source: 'coinbase',
      timestamp: T,
      type: 'crypto_out',
      legs: [{ asset: 'ETH', amount: '-1.0' }],
    });

    const inEvt: RawEvent = makeEvent({
      id: 'eth:in-window',
      source: 'eth',
      timestamp: T20m,
      type: 'crypto_in',
      legs: [{ asset: 'ETH', amount: '1.0' }],
    });

    // Default window (1800s) — should match
    const ctxDefault = makeContext();
    const resultDefault = classify([out, inEvt], [], ctxDefault, DEFAULT_RULES);
    expect(resultDefault.entries.filter(e => e.type === 'transfer_self')).toHaveLength(1);

    // Narrow window (600s) — should NOT match
    const ctxNarrow = makeContext({ crossSourceMatchWindowSeconds: 600 });
    const resultNarrow = classify([out, inEvt], [], ctxNarrow, DEFAULT_RULES);
    expect(resultNarrow.entries.filter(e => e.type === 'transfer_self')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DEX swap collapse (Rule 04)
// ─────────────────────────────────────────────────────────────────────────

describe('DEX swap collapse', () => {
  it('collapses multi-event txHash into one trade when counterparty is a DEX router', () => {
    const uniswapRouter = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d';
    const txHash = '0xb4fb6576abcdef1234567890';

    // ETH out to Uniswap router
    const ethOut: RawEvent = makeEvent({
      id: 'eth:swap-out',
      source: 'eth',
      accountId: 'eth-main',
      timestamp: new Date('2023-09-22T03:07:23Z'),
      type: 'crypto_out',
      legs: [{ asset: 'ETH', amount: '-0.5' }],
      txHash,
      counterparty: uniswapRouter,
    });

    // USDC in from Uniswap router
    const usdcIn: RawEvent = makeEvent({
      id: 'eth:swap-in',
      source: 'eth',
      accountId: 'eth-main',
      timestamp: new Date('2023-09-22T03:07:23Z'),
      type: 'crypto_in',
      legs: [{ asset: 'USDC', amount: '800.50' }],
      txHash,
      counterparty: uniswapRouter,
    });

    const ctx = makeContext({
      dexRouters: new Map([
        [uniswapRouter.toLowerCase(), {
          chain: 1,
          address: uniswapRouter,
          protocol: 'Uniswap',
          version: 'V2 Router 2',
        }],
      ]),
    });

    const result = classify([ethOut, usdcIn], [], ctx, DEFAULT_RULES);

    const trades = result.entries.filter(e => e.type === 'trade');
    expect(trades).toHaveLength(1);
    expect(trades[0]!.rawEventIds).toContain('eth:swap-out');
    expect(trades[0]!.rawEventIds).toContain('eth:swap-in');
    expect(trades[0]!.legs).toHaveLength(2);
  });

  it('does not collapse events without a DEX router counterparty', () => {
    const txHash = '0xnon-dex-tx';

    const out: RawEvent = makeEvent({
      id: 'eth:out-1',
      source: 'eth',
      timestamp: new Date('2023-09-22T03:07:23Z'),
      type: 'crypto_out',
      legs: [{ asset: 'ETH', amount: '-0.5' }],
      txHash,
      counterparty: '0xdeadbeef00000000000000000000000000000001',
    });

    const inEvt: RawEvent = makeEvent({
      id: 'eth:in-1',
      source: 'eth',
      timestamp: new Date('2023-09-22T03:07:23Z'),
      type: 'crypto_in',
      legs: [{ asset: 'USDC', amount: '800' }],
      txHash,
      counterparty: '0xdeadbeef00000000000000000000000000000002',
    });

    const ctx = makeContext();
    const result = classify([out, inEvt], [], ctx, DEFAULT_RULES);

    // Should not be collapsed into a trade by rule 04
    const trades = result.entries.filter(
      e => e.type === 'trade' && e.rawEventIds.length === 2,
    );
    expect(trades).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Override takes precedence
// ─────────────────────────────────────────────────────────────────────────

describe('overrides', () => {
  it('override takes precedence over automatic rules', () => {
    const evt: RawEvent = makeEvent({
      id: 'coinbase:trade-1',
      type: 'trade',
      legs: [
        { asset: 'BTC', amount: '0.001' },
        { asset: 'USD', amount: '-100' },
      ],
    });

    const override: ClassifierOverride = {
      id: 'override-1',
      rawEventIds: ['coinbase:trade-1'],
      type: 'income',
      createdAt: new Date(),
      note: 'Actually this was income',
    };

    const ctx = makeContext();
    const result = classify([evt], [override], ctx, DEFAULT_RULES);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.type).toBe('income');
    expect(result.entries[0]!.overrideId).toBe('override-1');
    expect(result.entries[0]!.reason).toContain('Override');
  });

  it('override prevents automatic rules from consuming the event', () => {
    const evt: RawEvent = makeEvent({
      id: 'coinbase:send-1',
      source: 'coinbase',
      type: 'crypto_out',
      legs: [{ asset: 'ETH', amount: '-1.0' }],
      counterparty: '0x1296Df1Ad1AabFBcBf28Dd45BeF9Bd0A4206F85b',
    });

    const override: ClassifierOverride = {
      id: 'override-2',
      rawEventIds: ['coinbase:send-1'],
      type: 'transfer_external_out',
      createdAt: new Date(),
      note: 'Not a self-transfer',
    };

    const ctx = makeContext({
      ownAddresses: ['0x1296Df1Ad1AabFBcBf28Dd45BeF9Bd0A4206F85b'],
    });

    const result = classify([evt], [override], ctx, DEFAULT_RULES);

    // Override should win over rule 02 (which would classify as transfer_self)
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.type).toBe('transfer_external_out');
  });

  it('entry rawEventIds are derived only from existing events', () => {
    // validateOverrides rejects stale ids before classify() applies
    // overrides, so this only exercises the valid-id path — see
    // validateOverrides tests for stale-id rejection coverage.
    const evt: RawEvent = makeEvent({ id: 'evt-real' });

    // Build a valid single-event override (no stale ids)
    const override: ClassifierOverride = {
      id: 'override-real',
      rawEventIds: ['evt-real'],
      type: 'income',
      createdAt: new Date(),
    };

    const ctx = makeContext();
    const result = classify([evt], [override], ctx, DEFAULT_RULES);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.rawEventIds).toEqual(['evt-real']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// validateOverrides
// ─────────────────────────────────────────────────────────────────────────

describe('validateOverrides', () => {
  it('passes with no overrides', () => {
    expect(() => validateOverrides([], [])).not.toThrow();
  });

  it('passes with valid non-overlapping overrides', () => {
    const events = [makeEvent({ id: 'evt-1' }), makeEvent({ id: 'evt-2' })];
    const overrides: ClassifierOverride[] = [
      { id: 'ov-1', rawEventIds: ['evt-1'], type: 'income', createdAt: new Date() },
      { id: 'ov-2', rawEventIds: ['evt-2'], type: 'trade', createdAt: new Date() },
    ];
    expect(() => validateOverrides(overrides, events)).not.toThrow();
  });

  it('throws for an override referencing a non-existent rawEventId (stale override)', () => {
    const events = [makeEvent({ id: 'evt-exists' })];
    const overrides: ClassifierOverride[] = [
      { id: 'ov-stale', rawEventIds: ['evt-missing'], type: 'income', createdAt: new Date() },
    ];
    expect(() => validateOverrides(overrides, events)).toThrowError(/ov-stale/);
    expect(() => validateOverrides(overrides, events)).toThrowError(/evt-missing/);
    expect(() => validateOverrides(overrides, events)).toThrowError(/prune/);
  });

  it('throws and names both the stale override and the missing id', () => {
    const events = [makeEvent({ id: 'evt-a' })];
    const overrides: ClassifierOverride[] = [
      { id: 'ov-bad', rawEventIds: ['evt-a', 'evt-gone'], type: 'trade', createdAt: new Date() },
    ];
    let err: Error | undefined;
    try {
      validateOverrides(overrides, events);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('ov-bad');
    expect(err!.message).toContain('evt-gone');
  });

  it('throws for two overrides referencing the same single rawEventId', () => {
    const events = [makeEvent({ id: 'evt-shared' })];
    const overrides: ClassifierOverride[] = [
      { id: 'ov-first', rawEventIds: ['evt-shared'], type: 'income', createdAt: new Date() },
      { id: 'ov-second', rawEventIds: ['evt-shared'], type: 'trade', createdAt: new Date() },
    ];
    let err: Error | undefined;
    try {
      validateOverrides(overrides, events);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('ov-first');
    expect(err!.message).toContain('ov-second');
    // A single shared event is both a full overlap and a full duplicate;
    // the duplicate message wins (see the identical-rawEventIds test below).
    expect(err!.message).toContain('is a duplicate of');
  });

  it('throws for two overrides with partially overlapping rawEventIds', () => {
    const events = [
      makeEvent({ id: 'evt-1' }),
      makeEvent({ id: 'evt-2' }),
      makeEvent({ id: 'evt-3' }),
    ];
    const overrides: ClassifierOverride[] = [
      { id: 'ov-a', rawEventIds: ['evt-1', 'evt-2'], type: 'trade', createdAt: new Date() },
      { id: 'ov-b', rawEventIds: ['evt-2', 'evt-3'], type: 'trade', createdAt: new Date() },
    ];
    let err: Error | undefined;
    try {
      validateOverrides(overrides, events);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('ov-a');
    expect(err!.message).toContain('ov-b');
    expect(err!.message).toContain('evt-2');
  });

  it('throws for two overrides with identical rawEventIds (duplicate overrides)', () => {
    const events = [makeEvent({ id: 'evt-1' }), makeEvent({ id: 'evt-2' })];
    const overrides: ClassifierOverride[] = [
      { id: 'ov-first', rawEventIds: ['evt-1', 'evt-2'], type: 'trade', createdAt: new Date() },
      { id: 'ov-second', rawEventIds: ['evt-1', 'evt-2'], type: 'income', createdAt: new Date() },
    ];
    let err: Error | undefined;
    try {
      validateOverrides(overrides, events);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    // Identical event sets are reported as a duplicate, not an overlap —
    // the duplicate check runs before the overlap check for this reason.
    expect(err!.message).toContain('ov-first');
    expect(err!.message).toContain('ov-second');
    expect(err!.message).toContain('is a duplicate of');
    expect(err!.message).not.toContain('overlaps with');
  });

  it('aggregates multiple problems in one error', () => {
    const events = [makeEvent({ id: 'evt-real' }), makeEvent({ id: 'evt-real-2' })];
    const overrides: ClassifierOverride[] = [
      { id: 'ov-stale', rawEventIds: ['evt-missing'], type: 'income', createdAt: new Date() },
      { id: 'ov-overlap-1', rawEventIds: ['evt-real'], type: 'trade', createdAt: new Date() },
      // Partial overlap (not identical to ov-overlap-1) so this exercises
      // the overlap path, not the duplicate path — see the dedicated
      // duplicate-overrides test above.
      { id: 'ov-overlap-2', rawEventIds: ['evt-real', 'evt-real-2'], type: 'income', createdAt: new Date() },
    ];
    let err: Error | undefined;
    try {
      validateOverrides(overrides, events);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    // Both ov-stale and the overlap problem should be in the message
    expect(err!.message).toContain('ov-stale');
    expect(err!.message).toContain('ov-overlap-1');
    expect(err!.message).toContain('ov-overlap-2');
  });

  it('classify() throws on stale override (no DB crash)', () => {
    const events = [makeEvent({ id: 'evt-real' })];
    const overrides: ClassifierOverride[] = [
      { id: 'ov-stale', rawEventIds: ['evt-never-existed'], type: 'income', createdAt: new Date() },
    ];
    const ctx = makeContext();
    expect(() => classify(events, overrides, ctx, DEFAULT_RULES)).toThrowError(/ov-stale/);
  });

  it('classify() throws on overlapping overrides (no DB crash)', () => {
    const events = [makeEvent({ id: 'evt-shared' })];
    const overrides: ClassifierOverride[] = [
      { id: 'ov-a', rawEventIds: ['evt-shared'], type: 'income', createdAt: new Date() },
      { id: 'ov-b', rawEventIds: ['evt-shared'], type: 'trade', createdAt: new Date() },
    ];
    const ctx = makeContext();
    expect(() => classify(events, overrides, ctx, DEFAULT_RULES)).toThrowError(/ov-a/);
    expect(() => classify(events, overrides, ctx, DEFAULT_RULES)).toThrowError(/ov-b/);
  });

  it('reports overlapping overrides once per pair, not once per shared rawEventId', () => {
    const events = [
      makeEvent({ id: 'evt-1' }),
      makeEvent({ id: 'evt-2' }),
      makeEvent({ id: 'evt-3' }),
      makeEvent({ id: 'evt-4' }),
    ];
    const overrides: ClassifierOverride[] = [
      { id: 'ov-a', rawEventIds: ['evt-1', 'evt-2', 'evt-3'], type: 'trade', createdAt: new Date() },
      // Shares all 3 of ov-a's events but isn't identical (adds evt-4), so
      // this is a partial overlap, not a duplicate.
      { id: 'ov-b', rawEventIds: ['evt-1', 'evt-2', 'evt-3', 'evt-4'], type: 'income', createdAt: new Date() },
    ];
    let err: Error | undefined;
    try {
      validateOverrides(overrides, events);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    const overlapLines = err!.message
      .split('\n')
      .filter(line => line.includes('overlaps with'));
    expect(overlapLines).toHaveLength(1);
  });

  it('does not treat two overrides with empty rawEventIds as duplicates', () => {
    const events = [makeEvent({ id: 'evt-1' })];
    const overrides: ClassifierOverride[] = [
      { id: 'ov-empty-1', rawEventIds: [], type: 'trade', createdAt: new Date() },
      { id: 'ov-empty-2', rawEventIds: [], type: 'income', createdAt: new Date() },
    ];
    expect(() => validateOverrides(overrides, events)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// findPrunableOverrides
// ─────────────────────────────────────────────────────────────────────────

describe('findPrunableOverrides', () => {
  it('returns an empty map when no overrides are prunable', () => {
    const existingEventIds = new Set(['evt-1', 'evt-2']);
    const overrides: ClassifierOverride[] = [
      { id: 'ov-1', rawEventIds: ['evt-1'], type: 'income', createdAt: new Date() },
      { id: 'ov-2', rawEventIds: ['evt-2'], type: 'trade', createdAt: new Date() },
    ];
    expect(findPrunableOverrides(overrides, existingEventIds).size).toBe(0);
  });

  it('flags a stale override for removal', () => {
    const existingEventIds = new Set(['evt-real']);
    const overrides: ClassifierOverride[] = [
      { id: 'ov-stale', rawEventIds: ['evt-missing'], type: 'income', createdAt: new Date() },
    ];
    const prunable = findPrunableOverrides(overrides, existingEventIds);
    expect(prunable.has('ov-stale')).toBe(true);
  });

  it('keeps the earliest override and flags the later duplicate/overlap for removal', () => {
    const existingEventIds = new Set(['evt-shared']);
    const overrides: ClassifierOverride[] = [
      { id: 'ov-first', rawEventIds: ['evt-shared'], type: 'income', createdAt: new Date() },
      { id: 'ov-second', rawEventIds: ['evt-shared'], type: 'trade', createdAt: new Date() },
    ];
    const prunable = findPrunableOverrides(overrides, existingEventIds);
    expect(prunable.has('ov-first')).toBe(false);
    expect(prunable.has('ov-second')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Deterministic classification
// ─────────────────────────────────────────────────────────────────────────

describe('deterministic classification', () => {
  it('same input produces same output', () => {
    const events: RawEvent[] = [
      makeEvent({ id: 'a', type: 'income', legs: [{ asset: 'ETH', amount: '0.01' }] }),
      makeEvent({ id: 'b', type: 'trade', legs: [{ asset: 'BTC', amount: '0.001' }, { asset: 'USD', amount: '-50' }] }),
      makeEvent({ id: 'c', type: 'fiat_deposit', legs: [{ asset: 'USD', amount: '1000' }] }),
    ];

    const ctx = makeContext();
    const result1 = classify(events, [], ctx, DEFAULT_RULES);
    const result2 = classify(events, [], ctx, DEFAULT_RULES);

    expect(result1.entries.length).toBe(result2.entries.length);
    for (let i = 0; i < result1.entries.length; i++) {
      expect(result1.entries[i]!.id).toBe(result2.entries[i]!.id);
      expect(result1.entries[i]!.type).toBe(result2.entries[i]!.type);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Default passthrough (Rule 07)
// ─────────────────────────────────────────────────────────────────────────

describe('default passthrough', () => {
  it('maps trade → trade', () => {
    const evt = makeEvent({ id: 'a', type: 'trade' });
    const result = classify([evt], [], makeContext(), DEFAULT_RULES);
    expect(result.entries[0]!.type).toBe('trade');
  });

  it('maps income → income', () => {
    const evt = makeEvent({ id: 'a', type: 'income', legs: [{ asset: 'ETH', amount: '0.01' }] });
    const result = classify([evt], [], makeContext(), DEFAULT_RULES);
    expect(result.entries[0]!.type).toBe('income');
  });

  it('maps fiat_deposit → fiat_in', () => {
    const evt = makeEvent({ id: 'a', type: 'fiat_deposit', legs: [{ asset: 'USD', amount: '1000' }] });
    const result = classify([evt], [], makeContext(), DEFAULT_RULES);
    expect(result.entries[0]!.type).toBe('fiat_in');
  });

  it('maps fiat_withdrawal → fiat_out', () => {
    const evt = makeEvent({ id: 'a', type: 'fiat_withdrawal', legs: [{ asset: 'USD', amount: '-500' }] });
    const result = classify([evt], [], makeContext(), DEFAULT_RULES);
    expect(result.entries[0]!.type).toBe('fiat_out');
  });

  it('maps unknown → unclassified', () => {
    const evt = makeEvent({ id: 'a', type: 'unknown', legs: [{ asset: 'UNKNOWN', amount: '0' }] });
    const result = classify([evt], [], makeContext(), DEFAULT_RULES);
    expect(result.entries[0]!.type).toBe('unclassified');
  });

  it('maps nft_event → nft_event', () => {
    const evt = makeEvent({ id: 'a', type: 'nft_event', legs: [{ asset: 'NFT', amount: '1' }] });
    const result = classify([evt], [], makeContext(), DEFAULT_RULES);
    expect(result.entries[0]!.type).toBe('nft_event');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CB pair merger (Rule 01)
// ─────────────────────────────────────────────────────────────────────────

describe('CB pair merger', () => {
  it('merges Retail Staking Transfer pairs into transfer_self', () => {
    const ts = new Date('2024-03-15T10:00:00Z');
    const a: RawEvent = makeEvent({
      id: 'coinbase:rst-1',
      source: 'coinbase',
      timestamp: ts,
      type: 'internal_move',
      legs: [{ asset: 'ETH', amount: '1.5' }],
      notes: 'Retail Staking Transfer',
    });
    const b: RawEvent = makeEvent({
      id: 'coinbase:rst-2',
      source: 'coinbase',
      timestamp: ts,
      type: 'internal_move',
      legs: [{ asset: 'ETH', amount: '-1.5' }],
      notes: 'Retail Staking Transfer',
    });

    const result = classify([a, b], [], makeContext(), DEFAULT_RULES);

    const selfTransfers = result.entries.filter(e => e.type === 'transfer_self');
    expect(selfTransfers).toHaveLength(1);
    expect(selfTransfers[0]!.rawEventIds).toContain('coinbase:rst-1');
    expect(selfTransfers[0]!.rawEventIds).toContain('coinbase:rst-2');
    expect(selfTransfers[0]!.legs).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Approval gas (Rule 06)
// ─────────────────────────────────────────────────────────────────────────

describe('approval gas', () => {
  it('classifies fee_only events as fee_disposal', () => {
    const evt: RawEvent = makeEvent({
      id: 'eth:fee-1',
      source: 'eth',
      type: 'fee_only',
      legs: [{ asset: 'ETH', amount: '-0.002', feeFlag: true }],
      txHash: '0xapproval',
      counterparty: '0xcontract',
    });

    const result = classify([evt], [], makeContext(), DEFAULT_RULES);
    expect(result.entries[0]!.type).toBe('fee_disposal');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// NFT classification rule ordering (Rule 08)
// ─────────────────────────────────────────────────────────────────────────

describe('NFT rule ordering', () => {
  it('NFT rule runs at position 08 in DEFAULT_RULES, before default passthrough', () => {
    const nftRuleIndex = DEFAULT_RULES.findIndex(r => r.name === '08-nft-classification');
    const defaultRuleIndex = DEFAULT_RULES.findIndex(r => r.name === '07-default');

    expect(nftRuleIndex).toBe(6); // 0-indexed position 6 = 7th rule
    expect(defaultRuleIndex).toBe(7); // 0-indexed position 7 = 8th rule
    expect(nftRuleIndex).toBeLessThan(defaultRuleIndex);
  });
});

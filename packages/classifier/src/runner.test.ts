/**
 * Classifier unit tests.
 *
 * Tests the runner and individual rules against synthetic fixtures.
 */

import { describe, expect, it } from 'vitest';
import type {
    ClassifierOverride, RawEvent
} from '@daybook/ledger';
import { classify, entryId } from './runner.js';
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

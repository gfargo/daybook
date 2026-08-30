/**
 * Unit tests for the Solana adapter (ingestSolana).
 *
 * Uses a mock SolanaTransferProvider with hand-written RawSolanaTransfer
 * fixtures. No network calls — pure translation logic.
 */

import { describe, expect, it } from 'vitest';
import { ingestSolana } from './adapter.js';
import type { RawSolanaTransfer, SolanaTransferProvider } from './provider.js';

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

const OWNER_ADDRESS = '5YNmS1R9nNSCDzb5a7mMJ1dwK9uHeAAF4CerVnx7z6Y2';
const TX_SIG_1 = '4GgB9n7V2KGBPKCMFSoGYP4pqDQQ2QhDQSTRMdHc4mNqv1z3fW5JxjXkzgkY7';
const TX_SIG_2 = '2TXabc1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

function makeTransfer(partial: Partial<RawSolanaTransfer>): RawSolanaTransfer {
  return {
    providerId: `solana:${TX_SIG_1}`,
    signature: TX_SIG_1,
    blockTime: 1_700_000_000,
    slot: 250_000_000,
    category: 'native',
    delta: '1.5',
    asset: 'SOL',
    isFeeLeg: false,
    raw: { fixture: true },
    ...partial,
  };
}

function mockProvider(transfers: RawSolanaTransfer[]): SolanaTransferProvider {
  return {
    name: 'rpc',
    async *fetchTransfers() {
      for (const t of transfers) {
        yield t;
      }
    },
  };
}

const baseOpts = {
  address: OWNER_ADDRESS,
  accountId: 'sol-main',
};

// ─────────────────────────────────────────────────────────────────────────
// Direction tests
// ─────────────────────────────────────────────────────────────────────────

describe('ingestSolana — direction assignment', () => {
  it('positive delta → crypto_in with positive amount', async () => {
    const provider = mockProvider([
      makeTransfer({ delta: '1.5', asset: 'SOL', category: 'native' }),
    ]);

    const { events, stats } = await ingestSolana({ ...baseOpts, provider });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('crypto_in');
    expect(events[0]!.legs[0]!.amount).toBe('1.5');
    expect(events[0]!.legs[0]!.asset).toBe('SOL');
    expect(stats.native).toBe(1);
  });

  it('negative delta → crypto_out with negative amount', async () => {
    const provider = mockProvider([
      makeTransfer({ delta: '-0.5', asset: 'SOL', category: 'native' }),
    ]);

    const { events, stats } = await ingestSolana({ ...baseOpts, provider });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('crypto_out');
    expect(events[0]!.legs[0]!.amount).toBe('-0.5');
    expect(stats.native).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Fee leg tests
// ─────────────────────────────────────────────────────────────────────────

describe('ingestSolana — fee legs', () => {
  it('fee leg → fee_only type with feeFlag', async () => {
    const provider = mockProvider([
      makeTransfer({
        providerId: `solana:${TX_SIG_1}:fee`,
        delta: '-0.000005',
        asset: 'SOL',
        isFeeLeg: true,
      }),
    ]);

    const { events, stats } = await ingestSolana({ ...baseOpts, provider });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('fee_only');
    expect(events[0]!.legs[0]!.feeFlag).toBe(true);
    expect(events[0]!.legs[0]!.amount).toBe('-0.000005');
    expect(stats.fee).toBe(1);
    expect(stats.native).toBe(0);
  });

  it('combines principal and fee events from same transaction', async () => {
    const provider = mockProvider([
      makeTransfer({
        providerId: `solana:${TX_SIG_1}`,
        delta: '-1.0',
        asset: 'SOL',
        isFeeLeg: false,
      }),
      makeTransfer({
        providerId: `solana:${TX_SIG_1}:fee`,
        delta: '-0.000005',
        asset: 'SOL',
        isFeeLeg: true,
      }),
    ]);

    const { events, stats } = await ingestSolana({ ...baseOpts, provider });

    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('crypto_out');
    expect(events[1]!.type).toBe('fee_only');
    expect(stats.native).toBe(1);
    expect(stats.fee).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// SPL token tests
// ─────────────────────────────────────────────────────────────────────────

describe('ingestSolana — SPL tokens', () => {
  it('SPL receive → crypto_in with mint as contractAddress', async () => {
    const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const provider = mockProvider([
      makeTransfer({
        providerId: `solana:${TX_SIG_1}:spl:${usdcMint}`,
        category: 'spl',
        delta: '100.5',
        asset: usdcMint,
        mintAddress: usdcMint,
        decimals: 6,
      }),
    ]);

    const { events, stats } = await ingestSolana({ ...baseOpts, provider });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('crypto_in');
    expect(events[0]!.legs[0]!.amount).toBe('100.5');
    expect(events[0]!.legs[0]!.asset).toBe(usdcMint);
    expect(events[0]!.legs[0]!.contractAddress).toBe(usdcMint);
    expect(stats.spl).toBe(1);
    expect(stats.native).toBe(0);
  });

  it('SPL send → crypto_out with negative amount', async () => {
    const mint = 'So11111111111111111111111111111111111111112';
    const provider = mockProvider([
      makeTransfer({
        providerId: `solana:${TX_SIG_1}:spl:${mint}`,
        category: 'spl',
        delta: '-50',
        asset: mint,
        mintAddress: mint,
        decimals: 9,
      }),
    ]);

    const { events } = await ingestSolana({ ...baseOpts, provider });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('crypto_out');
    expect(events[0]!.legs[0]!.amount).toBe('-50');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Deterministic ID and idempotency tests
// ─────────────────────────────────────────────────────────────────────────

describe('ingestSolana — deterministic IDs', () => {
  it('native transfer ID is solana:solana:<signature>', async () => {
    const provider = mockProvider([makeTransfer()]);
    const { events } = await ingestSolana({ ...baseOpts, provider });

    expect(events[0]!.id).toBe(`solana:solana:${TX_SIG_1}`);
  });

  it('fee leg ID is solana:solana:<signature>:fee', async () => {
    const provider = mockProvider([
      makeTransfer({
        providerId: `solana:${TX_SIG_1}:fee`,
        isFeeLeg: true,
        delta: '-0.000005',
      }),
    ]);
    const { events } = await ingestSolana({ ...baseOpts, provider });

    expect(events[0]!.id).toBe(`solana:solana:${TX_SIG_1}:fee`);
  });

  it('produces identical IDs on re-run (idempotency)', async () => {
    const transfers = [makeTransfer()];
    const run1 = await ingestSolana({
      ...baseOpts,
      provider: mockProvider(transfers),
    });
    const run2 = await ingestSolana({
      ...baseOpts,
      provider: mockProvider(transfers),
    });

    expect(run1.events.map(e => e.id)).toEqual(run2.events.map(e => e.id));
  });

  it('deduplicates events with the same providerId in one run', async () => {
    const dup = makeTransfer({ providerId: `solana:${TX_SIG_1}` });
    const provider = mockProvider([dup, dup]);

    const { events, stats } = await ingestSolana({ ...baseOpts, provider });

    expect(events).toHaveLength(1);
    expect(stats.deduped).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cursor / incremental sync tests
// ─────────────────────────────────────────────────────────────────────────

describe('ingestSolana — incremental cursor', () => {
  it('passes sinceSignature as `until` to the provider', async () => {
    const receivedOpts: unknown[] = [];
    const provider: SolanaTransferProvider = {
      name: 'rpc',
      async *fetchTransfers(opts) {
        receivedOpts.push(opts);
        // Yield nothing — just capturing opts.
      },
    };

    await ingestSolana({
      ...baseOpts,
      provider,
      sinceSignature: TX_SIG_2,
    });

    expect(receivedOpts).toHaveLength(1);
    expect((receivedOpts[0] as Record<string, unknown>)['until']).toBe(TX_SIG_2);
  });

  it('returns newestSignature from the first (newest) transfer seen', async () => {
    const provider = mockProvider([
      makeTransfer({ providerId: `solana:${TX_SIG_1}`, signature: TX_SIG_1, blockTime: 1_700_000_100 }),
      makeTransfer({ providerId: `solana:${TX_SIG_2}`, signature: TX_SIG_2, blockTime: 1_700_000_000 }),
    ]);

    const { newestSignature } = await ingestSolana({ ...baseOpts, provider });

    // First yielded = newest (Solana RPC is newest-first).
    expect(newestSignature).toBe(TX_SIG_1);
  });

  it('returns undefined newestSignature when no transfers found', async () => {
    const provider = mockProvider([]);
    const { newestSignature } = await ingestSolana({ ...baseOpts, provider });
    expect(newestSignature).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// RawEvent shape tests
// ─────────────────────────────────────────────────────────────────────────

describe('ingestSolana — RawEvent shape', () => {
  it('stamps correct source, accountId, txHash, and timestamp', async () => {
    const provider = mockProvider([
      makeTransfer({
        signature: TX_SIG_1,
        blockTime: 1_700_000_000,
        delta: '1.0',
      }),
    ]);

    const { events } = await ingestSolana({ ...baseOpts, provider });

    expect(events[0]!.source).toBe('solana');
    expect(events[0]!.accountId).toBe('sol-main');
    expect(events[0]!.txHash).toBe(TX_SIG_1);
    expect(events[0]!.timestamp).toEqual(new Date(1_700_000_000 * 1000));
  });

  it('preserves raw payload', async () => {
    const rawPayload = { slot: 123, tx: 'data' };
    const provider = mockProvider([
      makeTransfer({ raw: rawPayload }),
    ]);

    const { events } = await ingestSolana({ ...baseOpts, provider });

    expect(events[0]!.raw).toEqual(rawPayload);
  });
});

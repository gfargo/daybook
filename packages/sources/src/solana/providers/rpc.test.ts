/**
 * Unit tests for SolanaRpcProvider.
 *
 * Mocks global `fetch` — no real network calls.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

const OWNER = '5YNmS1R9nNSCDzb5a7mMJ1dwK9uHeAAF4CerVnx7z6Y2';
const SIG_1 = 'Sig1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SIG_2 = 'Sig2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function makeSignatureList(signatures: string[]): object {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: signatures.map((sig, i) => ({
      signature: sig,
      slot: 250_000_000 + i,
      blockTime: 1_700_000_000 + i,
      confirmationStatus: 'finalized',
      err: null,
      memo: null,
    })),
  };
}

function makeEmptySignatureList(): object {
  return { jsonrpc: '2.0', id: 1, result: [] };
}

function makeTransaction(opts: {
  signature: string;
  ownerIndex?: number;
  preBalances?: number[];
  postBalances?: number[];
  fee?: number;
  preTokenBalances?: object[];
  postTokenBalances?: object[];
  accountKeys?: object[];
}): object {
  const {
    signature,
    ownerIndex = 0,
    preBalances = [2_000_000_000, 5_000_000],
    postBalances = [900_000_000, 5_000_000],
    fee = 5_000,
    preTokenBalances = [],
    postTokenBalances = [],
    accountKeys = [
      { pubkey: OWNER, signer: true, writable: true },
      { pubkey: 'CounterParty1111111111111111111111111111111', signer: false, writable: true },
    ],
  } = opts;

  // Adjust accountKeys if ownerIndex != 0
  const keys = ownerIndex === 0 ? accountKeys : [
    { pubkey: 'FeePayerXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', signer: true, writable: true },
    ...accountKeys,
  ];

  return {
    jsonrpc: '2.0',
    id: 2,
    result: {
      slot: 250_000_000,
      blockTime: 1_700_000_000,
      meta: {
        err: null,
        fee,
        preBalances,
        postBalances,
        preTokenBalances,
        postTokenBalances,
      },
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: keys,
        },
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('SolanaRpcProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches signatures and transactions, emits SOL delta + fee leg', async () => {
    const { SolanaRpcProvider } = await import('./providers/rpc.js');

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    fetchMock
      // First call: getSignaturesForAddress — returns SIG_1
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeSignatureList([SIG_1]),
      })
      // Second call: getTransaction for SIG_1
      // preBalance[0]=2e9, postBalance[0]=900e6, fee=5000
      // rawDelta (excl fee) = 900_000_000 - 2_000_000_000 + 5_000 = -1_094_995_000
      // feeDelta = -5_000 lamports
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () =>
          makeTransaction({
            signature: SIG_1,
            preBalances: [2_000_000_000, 100_000],
            postBalances: [900_000_000, 1_100_000],
            fee: 5_000,
          }),
      })
      // Third call: getSignaturesForAddress — empty (end of pagination)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeEmptySignatureList(),
      });

    const provider = new SolanaRpcProvider('https://fake-rpc.example.com');
    const transfers = [];
    for await (const t of provider.fetchTransfers({ address: OWNER })) {
      transfers.push(t);
    }

    // Should have SOL delta + fee leg
    expect(transfers.length).toBeGreaterThanOrEqual(1);

    const feeTransfer = transfers.find(t => t.isFeeLeg);
    const solTransfer = transfers.find(t => !t.isFeeLeg && t.category === 'native');

    expect(feeTransfer).toBeDefined();
    expect(feeTransfer!.asset).toBe('SOL');
    expect(feeTransfer!.providerId).toBe(`solana:${SIG_1}:fee`);
    // fee = 5000 lamports = -0.000005 SOL
    expect(feeTransfer!.delta).toBe('-0.000005');

    expect(solTransfer).toBeDefined();
    expect(solTransfer!.asset).toBe('SOL');
    expect(solTransfer!.providerId).toBe(`solana:${SIG_1}`);
  });

  it('skips failed transactions (meta.err !== null)', async () => {
    const { SolanaRpcProvider } = await import('./providers/rpc.js');

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeSignatureList([SIG_1]),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: 2,
          result: {
            slot: 250_000_000,
            blockTime: 1_700_000_000,
            meta: {
              err: { InstructionError: [0, 'GenericError'] }, // failed tx
              fee: 5_000,
              preBalances: [2_000_000_000],
              postBalances: [1_994_995_000],
              preTokenBalances: [],
              postTokenBalances: [],
            },
            transaction: {
              signatures: [SIG_1],
              message: {
                accountKeys: [
                  { pubkey: OWNER, signer: true, writable: true },
                ],
              },
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeEmptySignatureList(),
      });

    const provider = new SolanaRpcProvider('https://fake-rpc.example.com');
    const transfers = [];
    for await (const t of provider.fetchTransfers({ address: OWNER })) {
      transfers.push(t);
    }

    expect(transfers).toHaveLength(0);
  });

  it('emits SPL token delta when owner token balance changes', async () => {
    const { SolanaRpcProvider } = await import('./providers/rpc.js');

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeSignatureList([SIG_1]),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () =>
          makeTransaction({
            signature: SIG_1,
            preBalances: [1_000_000_000, 100_000],
            // Same SOL balance (no native movement besides fee)
            postBalances: [999_995_000, 100_000],
            fee: 5_000,
            preTokenBalances: [
              {
                accountIndex: 1,
                mint: USDC_MINT,
                owner: OWNER,
                uiTokenAmount: {
                  amount: '0',
                  decimals: 6,
                  uiAmount: null,
                  uiAmountString: '0',
                },
              },
            ],
            postTokenBalances: [
              {
                accountIndex: 1,
                mint: USDC_MINT,
                owner: OWNER,
                uiTokenAmount: {
                  amount: '100000000',  // 100 USDC (6 decimals)
                  decimals: 6,
                  uiAmount: 100,
                  uiAmountString: '100',
                },
              },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeEmptySignatureList(),
      });

    const provider = new SolanaRpcProvider('https://fake-rpc.example.com');
    const transfers = [];
    for await (const t of provider.fetchTransfers({ address: OWNER })) {
      transfers.push(t);
    }

    const splTransfer = transfers.find(t => t.category === 'spl');
    expect(splTransfer).toBeDefined();
    expect(splTransfer!.asset).toBe(USDC_MINT);
    expect(splTransfer!.mintAddress).toBe(USDC_MINT);
    expect(splTransfer!.decimals).toBe(6);
    // 100000000 - 0 = 100000000 raw, / 1e6 = 100
    expect(splTransfer!.delta).toBe('100');
    expect(splTransfer!.providerId).toBe(`solana:${SIG_1}:spl:${USDC_MINT}`);
  });

  it('passes `until` parameter to stop at already-seen signature', async () => {
    const { SolanaRpcProvider } = await import('./providers/rpc.js');

    const capturedBodies: unknown[] = [];
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBodies.push(JSON.parse(init.body as string));
      return {
        ok: true,
        status: 200,
        json: async () => makeEmptySignatureList(),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new SolanaRpcProvider('https://fake-rpc.example.com');
    for await (const _ of provider.fetchTransfers({
      address: OWNER,
      until: SIG_2,
    })) {
      // Empty
    }

    expect(capturedBodies).toHaveLength(1);
    const body = capturedBodies[0] as { params: [string, Record<string, unknown>] };
    expect(body.params[1]!['until']).toBe(SIG_2);
  });

  it('retries on HTTP 429 with backoff', async () => {
    const { SolanaRpcProvider } = await import('./providers/rpc.js');

    const sleepCalls: number[] = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests' })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeEmptySignatureList(),
      });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new SolanaRpcProvider('https://fake-rpc.example.com');
    provider._sleep = async (ms: number) => { sleepCalls.push(ms); };

    const transfers = [];
    for await (const t of provider.fetchTransfers({ address: OWNER })) {
      transfers.push(t);
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0]).toBe(1_000); // BASE_DELAY_MS * 2^0
  });

  it('does not emit a fee leg when owner is not the fee payer', async () => {
    const { SolanaRpcProvider } = await import('./providers/rpc.js');

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const FEE_PAYER = 'FeePayerXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeSignatureList([SIG_1]),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: 2,
          result: {
            slot: 250_000_000,
            blockTime: 1_700_000_000,
            meta: {
              err: null,
              fee: 5_000,
              preBalances: [10_000_000_000, 0],      // index 0 = FEE_PAYER, index 1 = OWNER
              postBalances: [9_994_995_000, 1_000_000_000],
              preTokenBalances: [],
              postTokenBalances: [],
            },
            transaction: {
              signatures: [SIG_1],
              message: {
                accountKeys: [
                  { pubkey: FEE_PAYER, signer: true, writable: true },
                  { pubkey: OWNER, signer: false, writable: true },
                ],
              },
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeEmptySignatureList(),
      });

    const provider = new SolanaRpcProvider('https://fake-rpc.example.com');
    const transfers = [];
    for await (const t of provider.fetchTransfers({ address: OWNER })) {
      transfers.push(t);
    }

    // Should have native SOL delta for OWNER receiving 1 SOL, but no fee leg
    const feeTransfers = transfers.filter(t => t.isFeeLeg);
    const nativeTransfers = transfers.filter(t => !t.isFeeLeg && t.category === 'native');

    expect(feeTransfers).toHaveLength(0);
    expect(nativeTransfers).toHaveLength(1);
    expect(nativeTransfers[0]!.delta).toBe('1'); // 1_000_000_000 lamports = 1 SOL
  });
});

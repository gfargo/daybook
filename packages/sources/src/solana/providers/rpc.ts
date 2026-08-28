/**
 * Solana JSON-RPC provider implementation.
 *
 * Uses the Solana JSON-RPC API directly via global `fetch`:
 *   - getSignaturesForAddress — paginated signature list (newest first)
 *   - getTransaction          — parsed transaction with pre/post balances
 *
 * Balance-delta approach:
 *   Native SOL: compute delta from meta.preBalances[ownerIndex] and
 *               meta.postBalances[ownerIndex]. The fee (meta.fee) is
 *               emitted as a separate fee leg only when the owner is the
 *               fee payer (index 0 of accountKeys is always the fee payer).
 *
 *   SPL tokens: compute delta by finding matching entries in
 *               meta.preTokenBalances and meta.postTokenBalances where
 *               the owner field equals the queried address.
 *               Uses raw integer amounts (uiTokenAmount.amount) + decimals
 *               with decimal.js — never the lossy uiAmount float.
 *
 * Incremental sync:
 *   getSignaturesForAddress returns newest-first. We paginate via `before`
 *   to walk backwards, and stop at `until` (exclusive — the newest
 *   already-seen signature). The caller passes the newest-seen signature
 *   as `until` for subsequent runs.
 *
 * Quirks handled:
 *   - maxSupportedTransactionVersion: 0 required for v0 versioned transactions.
 *   - Transactions with err !== null (failed) are skipped — they don't
 *     produce balance changes but may still appear in the signature list.
 *   - Rent / account-creation lamport dust: the adapter handles this by
 *     treating tiny unexpected SOL deltas correctly via decimal math.
 */

import Decimal from 'decimal.js';
import type {
  FetchSolanaTransfersOpts,
  RawSolanaTransfer,
  SolanaSignatureInfo,
  SolanaTransaction,
  SolanaTransferProvider,
} from '../provider.js';
import { lamportsToSol, rawTokenToDecimal } from '../provider.js';

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

/** Max signatures per getSignaturesForAddress page (Solana RPC max). */
const SIGNATURES_PAGE_LIMIT = 1000;

/** Maximum retry attempts on rate-limit or transient errors. */
const MAX_RETRIES = 3;

/** Base delay in milliseconds for exponential backoff. */
const BASE_DELAY_MS = 1_000;

/** Public Solana mainnet RPC endpoint — works for light usage. */
const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';

// ─────────────────────────────────────────────────────────────────────────
// JSON-RPC helpers
// ─────────────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown[];
}

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

// ─────────────────────────────────────────────────────────────────────────
// Provider implementation
// ─────────────────────────────────────────────────────────────────────────

/**
 * Solana JSON-RPC provider using getSignaturesForAddress + getTransaction.
 *
 * RPC endpoint can be overridden via constructor or SOLANA_RPC_URL env var.
 * For production use, set a Helius or QuickNode endpoint to avoid public
 * rate limits.
 */
export class SolanaRpcProvider implements SolanaTransferProvider {
  readonly name = 'rpc' as const;

  /** Overridable sleep function for testing. */
  _sleep: (ms: number) => Promise<void> = sleep;

  private readonly rpcUrl: string;
  private _idCounter = 1;

  constructor(rpcUrl?: string) {
    this.rpcUrl =
      rpcUrl ??
      process.env['SOLANA_RPC_URL'] ??
      DEFAULT_RPC_URL;
  }

  // ─── fetchTransfers ──────────────────────────────────────────────────

  /**
   * Stream transfers for a Solana address.
   *
   * Pages through getSignaturesForAddress (newest-first), fetches each
   * transaction, computes balance deltas, and yields one RawSolanaTransfer
   * per non-zero asset delta for the owner.
   */
  async *fetchTransfers(
    opts: FetchSolanaTransfersOpts,
  ): AsyncIterable<RawSolanaTransfer> {
    const { address, until } = opts;
    let before: string | undefined = opts.before;

    // Page through signature list (newest first). Stop when we see `until`.
    pageLoop: while (true) {
      const params: (string | Record<string, unknown>)[] = [
        address,
        {
          limit: SIGNATURES_PAGE_LIMIT,
          ...(before ? { before } : {}),
          ...(until ? { until } : {}),
          commitment: 'finalized',
        },
      ];

      const signaturesResult = await this.rpcCall<SolanaSignatureInfo[]>(
        'getSignaturesForAddress',
        params,
      );

      if (!signaturesResult || signaturesResult.length === 0) break;

      for (const sigInfo of signaturesResult) {
        // Fetch and parse the full transaction.
        const tx = await this.fetchTransaction(sigInfo.signature);
        if (!tx) continue;

        // Skip failed transactions — they don't produce balance changes.
        if (tx.meta?.err !== null && tx.meta?.err !== undefined) continue;

        // Yield RawSolanaTransfers for this transaction.
        yield* this.extractTransfers(address, sigInfo.signature, tx);
      }

      // If we got fewer results than the page size, we've reached the end.
      if (signaturesResult.length < SIGNATURES_PAGE_LIMIT) break pageLoop;

      // Advance cursor to the oldest signature in this page.
      const oldest = signaturesResult[signaturesResult.length - 1];
      if (!oldest) break pageLoop;
      before = oldest.signature;
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────

  /**
   * Fetch a single transaction by signature.
   * Returns null if the transaction is not found or couldn't be parsed.
   */
  private async fetchTransaction(
    signature: string,
  ): Promise<SolanaTransaction | null> {
    const result = await this.rpcCall<SolanaTransaction | null>(
      'getTransaction',
      [
        signature,
        {
          encoding: 'jsonParsed',
          maxSupportedTransactionVersion: 0,
          commitment: 'finalized',
        },
      ],
    );
    return result ?? null;
  }

  /**
   * Extract RawSolanaTransfers from a parsed transaction for the given owner.
   *
   * Emits:
   *   1. One native SOL transfer if the owner's SOL balance changed
   *      (net of the fee, which is emitted separately).
   *   2. One fee leg if the owner is the fee payer and the fee > 0.
   *   3. One SPL token transfer per mint where the owner's token balance changed.
   */
  private *extractTransfers(
    ownerAddress: string,
    signature: string,
    tx: SolanaTransaction,
  ): Generator<RawSolanaTransfer> {
    const meta = tx.meta;
    if (!meta) return;

    const blockTime = tx.blockTime ?? 0;
    const slot = tx.slot;
    const accountKeys = tx.transaction.message.accountKeys;

    // Find the owner's index in accountKeys.
    const ownerIndex = accountKeys.findIndex(
      k => k.pubkey.toLowerCase() === ownerAddress.toLowerCase(),
    );

    // ─── Native SOL delta ────────────────────────────────────────────
    if (ownerIndex !== -1) {
      const preLamports = meta.preBalances[ownerIndex] ?? 0;
      const postLamports = meta.postBalances[ownerIndex] ?? 0;
      const feeLamports = meta.fee ?? 0;

      // The fee is deducted from index 0 (the fee payer). Determine if
      // owner is the fee payer so we don't double-count it.
      const isFeePayer = ownerIndex === 0;

      // Net delta excluding fee (the fee is a separate leg below).
      const rawDelta = postLamports - preLamports + (isFeePayer ? feeLamports : 0);

      if (rawDelta !== 0) {
        const delta = lamportsToSol(rawDelta).toString();
        yield {
          providerId: `solana:${signature}`,
          signature,
          blockTime,
          slot,
          category: 'native',
          delta,
          asset: 'SOL',
          isFeeLeg: false,
          raw: tx,
        };
      }

      // Emit fee leg only when owner is the fee payer.
      if (isFeePayer && feeLamports > 0) {
        const feeDelta = lamportsToSol(-feeLamports).toString();
        yield {
          providerId: `solana:${signature}:fee`,
          signature,
          blockTime,
          slot,
          category: 'native',
          delta: feeDelta,
          asset: 'SOL',
          isFeeLeg: true,
          raw: tx,
        };
      }
    }

    // ─── SPL token deltas ────────────────────────────────────────────
    yield* this.extractSplDeltas(ownerAddress, signature, blockTime, slot, meta, tx);
  }

  /**
   * Compute SPL token balance deltas for the owner.
   *
   * Groups pre/post token balance entries by mint and owner. For each mint
   * where the owner's balance changed, emits one RawSolanaTransfer.
   */
  private *extractSplDeltas(
    ownerAddress: string,
    signature: string,
    blockTime: number,
    slot: number,
    meta: SolanaTransaction['meta'] & object,
    tx: SolanaTransaction,
  ): Generator<RawSolanaTransfer> {
    // Build maps: mint → { pre, post, decimals } for the owner.
    const splMap = new Map<
      string,
      { pre: Decimal; post: Decimal; decimals: number; mint: string }
    >();

    for (const entry of meta.preTokenBalances ?? []) {
      // owner field may be absent on older RPC responses.
      const entryOwner = entry.owner ?? '';
      if (entryOwner.toLowerCase() !== ownerAddress.toLowerCase()) continue;

      const key = entry.mint;
      const decimals = entry.uiTokenAmount.decimals;
      const preAmt = rawTokenToDecimal(entry.uiTokenAmount.amount, decimals);
      splMap.set(key, { pre: preAmt, post: new Decimal(0), decimals, mint: key });
    }

    for (const entry of meta.postTokenBalances ?? []) {
      const entryOwner = entry.owner ?? '';
      if (entryOwner.toLowerCase() !== ownerAddress.toLowerCase()) continue;

      const key = entry.mint;
      const decimals = entry.uiTokenAmount.decimals;
      const postAmt = rawTokenToDecimal(entry.uiTokenAmount.amount, decimals);
      if (splMap.has(key)) {
        const existing = splMap.get(key)!;
        existing.post = postAmt;
      } else {
        // Token balance appeared (wasn't in preTokenBalances).
        splMap.set(key, { pre: new Decimal(0), post: postAmt, decimals, mint: key });
      }
    }

    // Yield a transfer for each mint with a non-zero delta.
    for (const [mint, { pre, post, decimals }] of splMap) {
      const delta = post.minus(pre);
      if (delta.isZero()) continue;

      yield {
        providerId: `solana:${signature}:spl:${mint}`,
        signature,
        blockTime,
        slot,
        category: 'spl',
        delta: delta.toString(),
        // Use the mint address as the asset identifier — the pricing / display
        // layer can resolve human-readable symbols from the mint address.
        // Well-known mints (USDC, USDT, etc.) will be recognized by the
        // classifier; unknown mints fall back to displaying the mint address.
        asset: mint,
        mintAddress: mint,
        decimals,
        isFeeLeg: false,
        raw: tx,
      };
    }
  }

  /**
   * Make a JSON-RPC call with retry/backoff.
   */
  private async rpcCall<T>(method: string, params: unknown[]): Promise<T | null> {
    const body: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this._idCounter++,
      method,
      params,
    };

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const res = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      // HTTP-level rate limit.
      if (res.status === 429) {
        if (attempt === MAX_RETRIES - 1) {
          throw new Error(
            `Solana RPC rate limit exceeded after ${MAX_RETRIES} retries. ` +
            'Consider using a Helius or QuickNode endpoint (SOLANA_RPC_URL).',
          );
        }
        await this._sleep(BASE_DELAY_MS * Math.pow(2, attempt));
        continue;
      }

      if (!res.ok) {
        throw new Error(
          `Solana RPC returned HTTP ${res.status}: ${res.statusText}`,
        );
      }

      const json = (await res.json()) as JsonRpcResponse<T>;

      if (json.error) {
        // RPC-level rate limit (code -32429 or similar).
        if (json.error.code === -32429 || json.error.message.toLowerCase().includes('too many')) {
          if (attempt === MAX_RETRIES - 1) {
            throw new Error(
              `Solana RPC rate limit: ${json.error.message}. ` +
              'Consider using a Helius or QuickNode endpoint (SOLANA_RPC_URL).',
            );
          }
          await this._sleep(BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        throw new Error(`Solana RPC error (${json.error.code}): ${json.error.message}`);
      }

      return json.result ?? null;
    }

    throw new Error(`Solana RPC: unexpected retry loop exit for method ${method}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────

/** Promise-based sleep for backoff delays. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

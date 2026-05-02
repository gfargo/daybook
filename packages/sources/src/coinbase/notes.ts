/**
 * Parsers for the Coinbase CSV `Notes` column.
 *
 * Coinbase's "All Transactions" export puts critical structured data inside
 * the freeform Notes string for several transaction types. Most importantly:
 *
 *   - `Convert` rows have ONLY the leg spent in the regular columns.
 *     The asset received is buried in `Notes`: "Converted X USDC to Y BTC".
 *
 *   - `Send` rows have the destination address in `Notes`:
 *     "Sent X ETH to 0xABC... (to 0xAB...DE)"
 *
 *   - `Withdrawal` rows describe the bank account in `Notes`:
 *     "Withdrawal to Community Bank, N.A./ ... *******1234"
 *
 * These parsers are deliberately strict — if the format changes, we want to
 * fail loudly rather than silently misclassify.
 */

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export interface ConvertNote {
  sentQuantity: string;
  sentAsset: string;
  receivedQuantity: string;
  receivedAsset: string;
}

export interface SendNote {
  /** "Sent" or "Sold" — yes, sometimes Coinbase uses different verbs. */
  verb: string;
  quantity: string;
  asset: string;
  /** Full destination address (40 hex chars). */
  destinationAddress: string;
  /** Whether the address looks like an Ethereum-style address (`0x` + 40 hex). */
  isEvmAddress: boolean;
}

export interface ReceiveNote {
  quantity: string;
  asset: string;
  /** "external account" | "Coinbase" | other Coinbase-internal label. */
  source: string;
}

export interface WithdrawalNote {
  bankName: string;
  accountLast4?: string;
}

export interface BuyNote {
  quantity: string;
  asset: string;
  fiatAmount: string;
  fiatCurrency: string;
  /** Present when Coinbase appends "using bank account …" to the note. */
  bankName?: string;
  /** Last 4 digits of the bank account, when included. */
  bankAccountLast4?: string;
}

export interface AdvancedBuyNote extends BuyNote {
  pair: string;        // e.g. 'BTC-USD'
  unitPrice: string;   // e.g. '41874.83'
}

// ─────────────────────────────────────────────────────────────────────────
// Regexes (capture groups documented inline)
// ─────────────────────────────────────────────────────────────────────────

/** "Converted 10.683547 USDC to 0.00011398 BTC" */
const CONVERT_RE = /^Converted ([\d.]+) (\w+) to ([\d.]+) (\w+)$/;

/** "Sent 0.5 ETH to 0xABC...123 (to 0xAB...23)" — captures full address */
const SEND_EVM_RE = /^(Sent|Sold) ([\d.]+) (\w+) to (0x[a-fA-F0-9]{40})(?: \(to 0x[a-fA-F0-9.]+\))?$/;

/** "Sent 100 USDC to bc1q..."   — non-EVM destination */
const SEND_NON_EVM_RE = /^(Sent|Sold) ([\d.]+) (\w+) to (\S+)(?: \(to .+\))?$/;

/** "Received 0.5 ETH from an external account" or "from Coinbase" */
const RECEIVE_RE = /^Received ([\d.]+) (\w+) from (.+?)$/;

/** "Withdrawal to Community Bank, N.A./ ... *******9407" */
const WITHDRAWAL_RE = /^Withdrawal to ([^/]+?)(?:\/.*\*+(\d+))?$/;

/**
 * "Bought 0.00152134 BTC for 150 USD"
 * "Bought 3.22 AVAX for 125 USD using bank account Community Bank, N.A./ ... *******9407"
 *
 * The trailing "using bank account ..." is optional and captures bank name + last 4.
 */
const BUY_RE =
  /^Bought ([\d.]+) (\w+) for ([\d.]+) (\w+)(?: using bank account ([^/]+?)(?:\/.*\*+(\d+))?)?$/;

/**
 * "Bought 0.0029612 BTC for 124.743745075576 USD on BTC-USD at 41874.83 USD/BTC"
 * Matches Advanced Trade Buy.
 */
const ADVANCED_BUY_RE =
  /^Bought ([\d.]+) (\w+) for ([\d.]+) (\w+) on ([\w-]+) at ([\d.]+) \w+\/\w+$/;

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse a `Convert` Notes string. Throws if the format is unrecognized —
 * intentionally strict so changes surface immediately.
 */
export function parseConvertNote(notes: string): ConvertNote {
  const m = notes.trim().match(CONVERT_RE);
  if (!m) throw new Error(`Unparsable Convert note: ${JSON.stringify(notes)}`);
  return {
    sentQuantity: m[1]!,
    sentAsset: m[2]!,
    receivedQuantity: m[3]!,
    receivedAsset: m[4]!,
  };
}

/**
 * Parse a `Send` Notes string. Returns null if it doesn't look like a Send
 * (so callers can fall through to other parsers if needed).
 */
export function parseSendNote(notes: string): SendNote | null {
  const trimmed = notes.trim();

  const evm = trimmed.match(SEND_EVM_RE);
  if (evm) {
    return {
      verb: evm[1]!,
      quantity: evm[2]!,
      asset: evm[3]!,
      destinationAddress: evm[4]!,
      isEvmAddress: true,
    };
  }

  const nonEvm = trimmed.match(SEND_NON_EVM_RE);
  if (nonEvm) {
    return {
      verb: nonEvm[1]!,
      quantity: nonEvm[2]!,
      asset: nonEvm[3]!,
      destinationAddress: nonEvm[4]!,
      isEvmAddress: false,
    };
  }

  return null;
}

export function parseReceiveNote(notes: string): ReceiveNote | null {
  const m = notes.trim().match(RECEIVE_RE);
  if (!m) return null;
  return {
    quantity: m[1]!,
    asset: m[2]!,
    source: m[3]!,
  };
}

export function parseWithdrawalNote(notes: string): WithdrawalNote | null {
  const m = notes.trim().match(WITHDRAWAL_RE);
  if (!m) return null;
  return {
    bankName: m[1]!.trim(),
    ...(m[2] ? { accountLast4: m[2] } : {}),
  };
}

export function parseBuyNote(notes: string): BuyNote | null {
  const m = notes.trim().match(BUY_RE);
  if (!m) return null;
  return {
    quantity: m[1]!,
    asset: m[2]!,
    fiatAmount: m[3]!,
    fiatCurrency: m[4]!,
    ...(m[5] ? { bankName: m[5].trim() } : {}),
    ...(m[6] ? { bankAccountLast4: m[6] } : {}),
  };
}

export function parseAdvancedBuyNote(notes: string): AdvancedBuyNote | null {
  const m = notes.trim().match(ADVANCED_BUY_RE);
  if (!m) return null;
  return {
    quantity: m[1]!,
    asset: m[2]!,
    fiatAmount: m[3]!,
    fiatCurrency: m[4]!,
    pair: m[5]!,
    unitPrice: m[6]!,
  };
}

/**
 * Test if a string looks like a self-transfer destination —
 * matches one of the user's own EVM addresses.
 *
 * @param destinationAddress  the parsed address
 * @param ownAddresses        all known addresses belonging to the user (any case)
 */
export function isSelfTransferDestination(
  destinationAddress: string,
  ownAddresses: ReadonlyArray<string>,
): boolean {
  const target = destinationAddress.toLowerCase();
  return ownAddresses.some(a => a.toLowerCase() === target);
}

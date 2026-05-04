/**
 * Unit tests for Rule 08 — NFT classification.
 */

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import type { RawEvent } from '@daybook/ledger';
import { nftClassification } from './08-nft-classification.js';
import type { ClassifierContext } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────

function makeContext(): ClassifierContext {
  return {
    ownAddresses: [],
    accountIds: [],
    dexRouters: new Map(),
    bridges: new Map(),
  };
}

function makeNftEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    id: 'eth:nft-1',
    source: 'eth',
    accountId: 'eth-main',
    timestamp: new Date('2024-03-15T10:00:00Z'),
    type: 'nft_event',
    legs: [
      {
        asset: 'BAYC',
        amount: '1',
        contractAddress: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d',
        tokenId: '4523',
      },
    ],
    txHash: '0xabc123',
    counterparty: '0xseller',
    raw: {},
    ...overrides,
  };
}

function makeFungibleEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    id: 'eth:fungible-1',
    source: 'eth',
    accountId: 'eth-main',
    timestamp: new Date('2024-03-15T10:00:00Z'),
    type: 'crypto_out',
    legs: [
      {
        asset: 'ETH',
        amount: '-0.5',
        amountUsdAtTime: '1500.00',
      },
    ],
    txHash: '0xabc123',
    raw: {},
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// NFT purchase: NFT in + ETH out
// ─────────────────────────────────────────────────────────────────────────

describe('NFT purchase', () => {
  it('classifies NFT in + fungible out as nft_acquisition with purchase reason', () => {
    const nftIn = makeNftEvent({ id: 'eth:nft-in-1' });
    const ethOut = makeFungibleEvent({ id: 'eth:eth-out-1' });

    const result = nftClassification.apply([nftIn, ethOut], makeContext());

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.type).toBe('nft_acquisition');
    expect(result.entries[0]!.reason).toBe('NFT purchase');
    expect(result.entries[0]!.rawEventIds).toContain('eth:nft-in-1');
    expect(result.entries[0]!.rawEventIds).toContain('eth:eth-out-1');
    expect(result.entries[0]!.legs).toHaveLength(2);

    // NFT leg
    const nftLeg = result.entries[0]!.legs[0]!;
    expect(nftLeg.amount).toBe('1');
    expect(nftLeg.contractAddress).toBe('0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d');
    expect(nftLeg.tokenId).toBe('4523');

    // Payment leg
    const paymentLeg = result.entries[0]!.legs[1]!;
    expect(paymentLeg.asset).toBe('ETH');
    expect(paymentLeg.amount).toBe('-0.5');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// NFT mint: NFT in from null address + ETH out
// ─────────────────────────────────────────────────────────────────────────

describe('NFT mint', () => {
  it('classifies NFT in from null address + fungible out as nft_acquisition with mint reason', () => {
    const nftIn = makeNftEvent({
      id: 'eth:nft-mint-1',
      counterparty: '0x0000000000000000000000000000000000000000',
    });
    const ethOut = makeFungibleEvent({ id: 'eth:eth-out-mint' });

    const result = nftClassification.apply([nftIn, ethOut], makeContext());

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.type).toBe('nft_acquisition');
    expect(result.entries[0]!.reason).toBe('NFT mint');
    expect(result.entries[0]!.rawEventIds).toContain('eth:nft-mint-1');
    expect(result.entries[0]!.rawEventIds).toContain('eth:eth-out-mint');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// NFT airdrop: NFT in alone
// ─────────────────────────────────────────────────────────────────────────

describe('NFT airdrop', () => {
  it('classifies NFT in alone as nft_acquisition with airdrop reason', () => {
    const nftIn = makeNftEvent({ id: 'eth:nft-airdrop-1' });

    const result = nftClassification.apply([nftIn], makeContext());

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.type).toBe('nft_acquisition');
    expect(result.entries[0]!.reason).toBe('NFT airdrop');
    expect(result.entries[0]!.rawEventIds).toEqual(['eth:nft-airdrop-1']);
    expect(result.entries[0]!.legs).toHaveLength(1);
    expect(result.entries[0]!.legs[0]!.amount).toBe('1');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// NFT sale: NFT out + ETH in
// ─────────────────────────────────────────────────────────────────────────

describe('NFT sale', () => {
  it('classifies NFT out + fungible in as nft_disposal with sale reason', () => {
    const nftOut = makeNftEvent({
      id: 'eth:nft-out-1',
      legs: [
        {
          asset: 'BAYC',
          amount: '-1',
          contractAddress: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d',
          tokenId: '4523',
        },
      ],
    });
    const ethIn = makeFungibleEvent({
      id: 'eth:eth-in-1',
      type: 'crypto_in',
      legs: [{ asset: 'ETH', amount: '2.0', amountUsdAtTime: '6000.00' }],
    });

    const result = nftClassification.apply([nftOut, ethIn], makeContext());

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.type).toBe('nft_disposal');
    expect(result.entries[0]!.reason).toBe('NFT sale');
    expect(result.entries[0]!.rawEventIds).toContain('eth:nft-out-1');
    expect(result.entries[0]!.rawEventIds).toContain('eth:eth-in-1');
    expect(result.entries[0]!.legs).toHaveLength(2);

    // NFT leg
    const nftLeg = result.entries[0]!.legs[0]!;
    expect(nftLeg.amount).toBe('-1');

    // Proceeds leg
    const proceedsLeg = result.entries[0]!.legs[1]!;
    expect(proceedsLeg.asset).toBe('ETH');
    expect(proceedsLeg.amount).toBe('2.0');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// NFT transfer out: NFT out alone
// ─────────────────────────────────────────────────────────────────────────

describe('NFT transfer out', () => {
  it('classifies NFT out alone as nft_disposal with transfer_out reason', () => {
    const nftOut = makeNftEvent({
      id: 'eth:nft-transfer-out-1',
      legs: [
        {
          asset: 'BAYC',
          amount: '-1',
          contractAddress: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d',
          tokenId: '4523',
        },
      ],
    });

    const result = nftClassification.apply([nftOut], makeContext());

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.type).toBe('nft_disposal');
    expect(result.entries[0]!.reason).toBe('NFT transfer out');
    expect(result.entries[0]!.rawEventIds).toEqual(['eth:nft-transfer-out-1']);
    expect(result.entries[0]!.legs).toHaveLength(1);
    expect(result.entries[0]!.legs[0]!.amount).toBe('-1');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// NFT-for-NFT trade
// ─────────────────────────────────────────────────────────────────────────

describe('NFT-for-NFT trade', () => {
  it('produces both disposal and acquisition entries', () => {
    const nftOut = makeNftEvent({
      id: 'eth:nft-trade-out',
      legs: [
        {
          asset: 'BAYC',
          amount: '-1',
          contractAddress: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d',
          tokenId: '4523',
        },
      ],
    });
    const nftIn = makeNftEvent({
      id: 'eth:nft-trade-in',
      legs: [
        {
          asset: 'PUNK',
          amount: '1',
          contractAddress: '0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb',
          tokenId: '7804',
        },
      ],
    });

    const result = nftClassification.apply([nftOut, nftIn], makeContext());

    expect(result.entries).toHaveLength(2);

    const disposal = result.entries.find(e => e.type === 'nft_disposal');
    const acquisition = result.entries.find(e => e.type === 'nft_acquisition');

    expect(disposal).toBeDefined();
    expect(disposal!.reason).toBe('NFT sale');
    expect(disposal!.legs[0]!.amount).toBe('-1');
    expect(disposal!.legs[0]!.contractAddress).toBe('0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d');
    expect(disposal!.legs[0]!.tokenId).toBe('4523');

    expect(acquisition).toBeDefined();
    expect(acquisition!.reason).toBe('NFT purchase');
    expect(acquisition!.legs[0]!.amount).toBe('1');
    expect(acquisition!.legs[0]!.contractAddress).toBe('0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb');
    expect(acquisition!.legs[0]!.tokenId).toBe('7804');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Metadata preservation
// ─────────────────────────────────────────────────────────────────────────

describe('metadata preservation', () => {
  it('preserves contractAddress and tokenId on output legs', () => {
    const nftIn = makeNftEvent({
      id: 'eth:nft-meta-1',
      legs: [
        {
          asset: 'BAYC',
          amount: '1',
          contractAddress: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d',
          tokenId: '4523',
        },
      ],
    });

    const result = nftClassification.apply([nftIn], makeContext());

    const nftLeg = result.entries[0]!.legs[0]!;
    expect(nftLeg.contractAddress).toBe('0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d');
    expect(nftLeg.tokenId).toBe('4523');
    expect(nftLeg.asset).toBe('BAYC');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Only claims nft_event type events
// ─────────────────────────────────────────────────────────────────────────

describe('event type filtering', () => {
  it('only claims nft_event type events, passes others through', () => {
    const tradeEvent: RawEvent = {
      id: 'eth:trade-1',
      source: 'eth',
      accountId: 'eth-main',
      timestamp: new Date('2024-03-15T10:00:00Z'),
      type: 'trade',
      legs: [
        { asset: 'ETH', amount: '-1.0' },
        { asset: 'USDC', amount: '3000' },
      ],
      txHash: '0xabc123',
      raw: {},
    };

    const incomeEvent: RawEvent = {
      id: 'eth:income-1',
      source: 'eth',
      accountId: 'eth-main',
      timestamp: new Date('2024-03-15T10:00:00Z'),
      type: 'income',
      legs: [{ asset: 'ETH', amount: '0.01' }],
      raw: {},
    };

    const result = nftClassification.apply([tradeEvent, incomeEvent], makeContext());

    expect(result.entries).toHaveLength(0);
    expect(result.consumedEventIds.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Fungible counterpart consumption
// ─────────────────────────────────────────────────────────────────────────

describe('fungible counterpart consumption', () => {
  it('consumes paired fungible events so they are not double-counted', () => {
    const nftIn = makeNftEvent({ id: 'eth:nft-buy-1' });
    const ethOut = makeFungibleEvent({ id: 'eth:eth-pay-1' });

    const result = nftClassification.apply([nftIn, ethOut], makeContext());

    expect(result.consumedEventIds.has('eth:nft-buy-1')).toBe(true);
    expect(result.consumedEventIds.has('eth:eth-pay-1')).toBe(true);
  });

  it('does not consume fungible events from different txHash', () => {
    const nftIn = makeNftEvent({ id: 'eth:nft-1', txHash: '0xaaa' });
    const ethOut = makeFungibleEvent({ id: 'eth:eth-1', txHash: '0xbbb' });

    const result = nftClassification.apply([nftIn, ethOut], makeContext());

    expect(result.consumedEventIds.has('eth:nft-1')).toBe(true);
    expect(result.consumedEventIds.has('eth:eth-1')).toBe(false);
  });
});


// ─────────────────────────────────────────────────────────────────────────
// Property-based test generators
// ─────────────────────────────────────────────────────────────────────────

const HEX_CHARS = '0123456789abcdef'.split('');

/** Arbitrary that generates a valid lowercased Ethereum address. */
const arbAddress: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...HEX_CHARS), { minLength: 40, maxLength: 40 })
  .map((chars) => `0x${chars.join('')}`);

/** Arbitrary that generates a valid NFT token ID string. */
const arbTokenId: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 99999 })
  .map(String);

/** Arbitrary that generates a valid txHash. */
const arbTxHash: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...HEX_CHARS), { minLength: 64, maxLength: 64 })
  .map((chars) => `0x${chars.join('')}`);

/** Arbitrary that generates a valid Date in the 2020–2030 range. */
const arbDate: fc.Arbitrary<Date> = fc
  .integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2030, 11, 31) })
  .map((ms) => new Date(ms));

/** Arbitrary that generates a positive decimal string for fungible amounts. */
const arbPositiveAmount: fc.Arbitrary<string> = fc
  .float({ min: Math.fround(0.001), max: Math.fround(100.0), noNaN: true })
  .map((n) => n.toFixed(4));

/** Arbitrary that generates a USD value string. */
const arbUsdValue: fc.Arbitrary<string> = fc
  .float({ min: Math.fround(0.01), max: Math.fround(999999.99), noNaN: true })
  .map((n) => n.toFixed(2));

/** Common NFT asset symbols. */
const NFT_SYMBOLS = ['BAYC', 'PUNK', 'AZUKI', 'DOODLE', 'MAYC', 'MOONBIRD'];

/** Common fungible asset symbols. */
const FUNGIBLE_SYMBOLS = ['ETH', 'WETH', 'USDC', 'DAI'];

/**
 * The four NFT classification scenarios for Property 1.
 *
 * Each scenario defines the NFT direction and whether a fungible
 * counterpart is present, along with the expected output type.
 */
type NftScenario =
  | 'nft_in_with_fungible_out'
  | 'nft_in_alone'
  | 'nft_out_with_fungible_in'
  | 'nft_out_alone';

const arbScenario: fc.Arbitrary<NftScenario> = fc.constantFrom(
  'nft_in_with_fungible_out' as const,
  'nft_in_alone' as const,
  'nft_out_with_fungible_in' as const,
  'nft_out_alone' as const,
);

/** Build a complete set of raw events for a given scenario. */
interface ScenarioInput {
  scenario: NftScenario;
  contractAddress: string;
  tokenId: string;
  nftSymbol: string;
  txHash: string;
  timestamp: Date;
  counterparty: string;
  fungibleAsset: string;
  fungibleAmount: string;
  fungibleUsd: string;
  nftEventId: string;
  fungibleEventId: string;
}

function buildScenarioEvents(input: ScenarioInput): RawEvent[] {
  const events: RawEvent[] = [];

  const nftAmount = input.scenario === 'nft_out_with_fungible_in' || input.scenario === 'nft_out_alone'
    ? '-1'
    : '1';

  const nftEvent: RawEvent = {
    id: input.nftEventId,
    source: 'eth',
    accountId: 'test-account',
    timestamp: input.timestamp,
    type: 'nft_event',
    legs: [
      {
        asset: input.nftSymbol,
        amount: nftAmount,
        contractAddress: input.contractAddress,
        tokenId: input.tokenId,
      },
    ],
    txHash: input.txHash,
    counterparty: input.counterparty,
    raw: {},
  };
  events.push(nftEvent);

  if (input.scenario === 'nft_in_with_fungible_out') {
    events.push({
      id: input.fungibleEventId,
      source: 'eth',
      accountId: 'test-account',
      timestamp: input.timestamp,
      type: 'crypto_out',
      legs: [
        {
          asset: input.fungibleAsset,
          amount: `-${input.fungibleAmount}`,
          amountUsdAtTime: input.fungibleUsd,
        },
      ],
      txHash: input.txHash,
      raw: {},
    });
  } else if (input.scenario === 'nft_out_with_fungible_in') {
    events.push({
      id: input.fungibleEventId,
      source: 'eth',
      accountId: 'test-account',
      timestamp: input.timestamp,
      type: 'crypto_in',
      legs: [
        {
          asset: input.fungibleAsset,
          amount: input.fungibleAmount,
          amountUsdAtTime: input.fungibleUsd,
        },
      ],
      txHash: input.txHash,
      raw: {},
    });
  }

  return events;
}

// ─────────────────────────────────────────────────────────────────────────
// Property 1: NFT classification correctness
// ─────────────────────────────────────────────────────────────────────────

describe('Feature: nft-cost-basis, Property 1: NFT classification correctness', () => {
  /**
   * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 2.3, 2.4, 2.5**
   *
   * For any set of raw events grouped by txHash with at least one nft_event,
   * the classifier produces the correct LedgerEntryType based on NFT direction
   * and counterpart presence:
   *
   *   NFT in + fungible out → nft_acquisition
   *   NFT in alone → nft_acquisition
   *   NFT out + fungible in → nft_disposal
   *   NFT out alone → nft_disposal
   *
   * Acquisition legs have amount '1', disposal legs have amount '-1'.
   * When a fungible counterpart exists, the entry includes both the NFT leg
   * and the counterpart leg.
   */
  it('classifies NFT events with the correct LedgerEntryType based on direction and counterpart presence', () => {
    fc.assert(
      fc.property(
        arbScenario,
        arbAddress,
        arbTokenId,
        fc.constantFrom(...NFT_SYMBOLS),
        arbTxHash,
        arbDate,
        arbAddress,
        fc.constantFrom(...FUNGIBLE_SYMBOLS),
        arbPositiveAmount,
        arbUsdValue,
        fc.uuid(),
        fc.uuid(),
        (
          scenario,
          contractAddress,
          tokenId,
          nftSymbol,
          txHash,
          timestamp,
          counterparty,
          fungibleAsset,
          fungibleAmount,
          fungibleUsd,
          nftEventIdSeed,
          fungibleEventIdSeed,
        ) => {
          const nftEventId = `eth:${nftEventIdSeed}`;
          const fungibleEventId = `eth:${fungibleEventIdSeed}`;

          const events = buildScenarioEvents({
            scenario,
            contractAddress,
            tokenId,
            nftSymbol,
            txHash,
            timestamp,
            counterparty,
            fungibleAsset,
            fungibleAmount,
            fungibleUsd,
            nftEventId,
            fungibleEventId,
          });

          const ctx: ClassifierContext = {
            ownAddresses: [],
            accountIds: [],
            dexRouters: new Map(),
            bridges: new Map(),
          };

          const result = nftClassification.apply(events, ctx);

          // Should produce exactly one entry
          expect(result.entries).toHaveLength(1);
          const entry = result.entries[0]!;

          // Verify correct LedgerEntryType
          const isAcquisition = scenario === 'nft_in_with_fungible_out' || scenario === 'nft_in_alone';
          const expectedType = isAcquisition ? 'nft_acquisition' : 'nft_disposal';
          expect(entry.type).toBe(expectedType);

          // Verify NFT leg amount
          const nftLeg = entry.legs[0]!;
          const expectedNftAmount = isAcquisition ? '1' : '-1';
          expect(nftLeg.amount).toBe(expectedNftAmount);

          // Verify counterpart leg presence
          const hasCounterpart = scenario === 'nft_in_with_fungible_out' || scenario === 'nft_out_with_fungible_in';
          if (hasCounterpart) {
            expect(entry.legs.length).toBe(2);
            const counterpartLeg = entry.legs[1]!;
            expect(counterpartLeg.asset).toBe(fungibleAsset);
          } else {
            expect(entry.legs.length).toBe(1);
          }

          // Verify the NFT event is consumed
          expect(result.consumedEventIds.has(nftEventId)).toBe(true);

          // Verify the fungible event is consumed when present
          if (hasCounterpart) {
            expect(result.consumedEventIds.has(fungibleEventId)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Property 2: NFT metadata preservation
// ─────────────────────────────────────────────────────────────────────────

describe('Feature: nft-cost-basis, Property 2: NFT metadata preservation', () => {
  /**
   * **Validates: Requirements 1.6, 7.1, 7.2**
   *
   * For any nft_event with contractAddress and tokenId on its AssetLeg,
   * the classifier output LedgerEntry preserves both contractAddress and
   * tokenId on the corresponding NFT leg. This holds for both acquisition
   * (NFT in) and disposal (NFT out) scenarios.
   */
  it('preserves contractAddress and tokenId on classifier output legs for all NFT scenarios', () => {
    fc.assert(
      fc.property(
        arbScenario,
        arbAddress,
        arbTokenId,
        fc.constantFrom(...NFT_SYMBOLS),
        arbTxHash,
        arbDate,
        arbAddress,
        fc.constantFrom(...FUNGIBLE_SYMBOLS),
        arbPositiveAmount,
        arbUsdValue,
        fc.uuid(),
        fc.uuid(),
        (
          scenario,
          contractAddress,
          tokenId,
          nftSymbol,
          txHash,
          timestamp,
          counterparty,
          fungibleAsset,
          fungibleAmount,
          fungibleUsd,
          nftEventIdSeed,
          fungibleEventIdSeed,
        ) => {
          const nftEventId = `eth:${nftEventIdSeed}`;
          const fungibleEventId = `eth:${fungibleEventIdSeed}`;

          const events = buildScenarioEvents({
            scenario,
            contractAddress,
            tokenId,
            nftSymbol,
            txHash,
            timestamp,
            counterparty,
            fungibleAsset,
            fungibleAmount,
            fungibleUsd,
            nftEventId,
            fungibleEventId,
          });

          const ctx: ClassifierContext = {
            ownAddresses: [],
            accountIds: [],
            dexRouters: new Map(),
            bridges: new Map(),
          };

          const result = nftClassification.apply(events, ctx);

          // Should produce exactly one entry
          expect(result.entries).toHaveLength(1);
          const entry = result.entries[0]!;

          // The first leg is always the NFT leg
          const nftLeg = entry.legs[0]!;

          // contractAddress must be preserved from input
          expect(nftLeg.contractAddress).toBe(contractAddress);

          // tokenId must be preserved from input
          expect(nftLeg.tokenId).toBe(tokenId);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Property 10: NFT-for-NFT trade produces both entries
// ─────────────────────────────────────────────────────────────────────────

describe('Feature: nft-cost-basis, Property 10: NFT-for-NFT trade produces both entries', () => {
  /**
   * **Validates: Requirements 8.1**
   *
   * For any transaction containing both an NFT transfer out and an NFT
   * transfer in (different NFT identifiers) within the same txHash, the
   * classifier SHALL produce exactly one nft_disposal entry for the
   * outgoing NFT and one nft_acquisition entry for the incoming NFT.
   */
  it('produces exactly one nft_disposal and one nft_acquisition for NFT-for-NFT trades', () => {
    fc.assert(
      fc.property(
        arbAddress,
        arbTokenId,
        fc.constantFrom(...NFT_SYMBOLS),
        arbAddress,
        arbTokenId,
        fc.constantFrom(...NFT_SYMBOLS),
        arbTxHash,
        arbDate,
        fc.uuid(),
        fc.uuid(),
        (
          contractAddressOut,
          tokenIdOut,
          symbolOut,
          contractAddressIn,
          tokenIdIn,
          symbolIn,
          txHash,
          timestamp,
          outIdSeed,
          inIdSeed,
        ) => {
          // Ensure the two NFTs have different identifiers
          const idOut = `${contractAddressOut.toLowerCase()}:${tokenIdOut}`;
          const idIn = `${contractAddressIn.toLowerCase()}:${tokenIdIn}`;
          fc.pre(idOut !== idIn);

          const nftOutEvent: RawEvent = {
            id: `eth:${outIdSeed}`,
            source: 'eth',
            accountId: 'test-account',
            timestamp,
            type: 'nft_event',
            legs: [
              {
                asset: symbolOut,
                amount: '-1',
                contractAddress: contractAddressOut,
                tokenId: tokenIdOut,
              },
            ],
            txHash,
            counterparty: '0xbuyer',
            raw: {},
          };

          const nftInEvent: RawEvent = {
            id: `eth:${inIdSeed}`,
            source: 'eth',
            accountId: 'test-account',
            timestamp,
            type: 'nft_event',
            legs: [
              {
                asset: symbolIn,
                amount: '1',
                contractAddress: contractAddressIn,
                tokenId: tokenIdIn,
              },
            ],
            txHash,
            counterparty: '0xseller',
            raw: {},
          };

          const ctx: ClassifierContext = {
            ownAddresses: [],
            accountIds: [],
            dexRouters: new Map(),
            bridges: new Map(),
          };

          const result = nftClassification.apply([nftOutEvent, nftInEvent], ctx);

          // Must produce exactly 2 entries
          expect(result.entries).toHaveLength(2);

          // Exactly one nft_disposal
          const disposals = result.entries.filter(e => e.type === 'nft_disposal');
          expect(disposals).toHaveLength(1);

          // Exactly one nft_acquisition
          const acquisitions = result.entries.filter(e => e.type === 'nft_acquisition');
          expect(acquisitions).toHaveLength(1);

          // The disposal should reference the outgoing NFT
          const disposal = disposals[0]!;
          expect(disposal.legs[0]!.amount).toBe('-1');
          expect(disposal.legs[0]!.contractAddress).toBe(contractAddressOut);
          expect(disposal.legs[0]!.tokenId).toBe(tokenIdOut);

          // The acquisition should reference the incoming NFT
          const acquisition = acquisitions[0]!;
          expect(acquisition.legs[0]!.amount).toBe('1');
          expect(acquisition.legs[0]!.contractAddress).toBe(contractAddressIn);
          expect(acquisition.legs[0]!.tokenId).toBe(tokenIdIn);

          // Both NFT events should be consumed
          expect(result.consumedEventIds.has(nftOutEvent.id)).toBe(true);
          expect(result.consumedEventIds.has(nftInEvent.id)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Unit tests for NFT identifier helpers.
 *
 * Validates:
 *   - nftId: canonical lowercased identifier construction
 *   - formatNftId: truncated CLI display format
 *   - formatNftDescription: IRS form description format
 *   - Determinism: same inputs always produce same output
 *
 * **Validates: Requirements 5.2, 5.3, 6.4**
 */

import { describe, expect, it } from 'vitest';
import { nftId, formatNftId, formatNftDescription } from './nft-helpers.js';

// ─── nftId ───────────────────────────────────────────────────────────────

describe('nftId', () => {
  it('joins contract address and token ID with a colon', () => {
    expect(nftId('0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', '4523')).toBe(
      '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d:4523',
    );
  });

  it('lowercases the contract address', () => {
    expect(nftId('0xBC4CA0EDA7647A8AB7C2061C2E118A18A936F13D', '4523')).toBe(
      '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d:4523',
    );
  });

  it('handles mixed-case input', () => {
    expect(nftId('0xBc4cA0EdA7647a8aB7C2061c2E118A18a936f13D', '100')).toBe(
      '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d:100',
    );
  });

  it('preserves token ID as-is (no lowercasing)', () => {
    expect(nftId('0xabcdef1234567890abcdef1234567890abcdef12', 'TokenABC')).toBe(
      '0xabcdef1234567890abcdef1234567890abcdef12:TokenABC',
    );
  });

  it('handles numeric token IDs', () => {
    expect(nftId('0xabcdef1234567890abcdef1234567890abcdef12', '0')).toBe(
      '0xabcdef1234567890abcdef1234567890abcdef12:0',
    );
  });

  it('handles "unknown" token ID', () => {
    expect(nftId('0xabcdef1234567890abcdef1234567890abcdef12', 'unknown')).toBe(
      '0xabcdef1234567890abcdef1234567890abcdef12:unknown',
    );
  });
});

// ─── formatNftId ─────────────────────────────────────────────────────────

describe('formatNftId', () => {
  it('truncates a standard 42-char address to 0x<first4>...<last2>:<tokenId>', () => {
    expect(formatNftId('0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', '4523')).toBe(
      '0xbc4c...3d:4523',
    );
  });

  it('lowercases the address in the output', () => {
    expect(formatNftId('0xBC4CA0EDA7647A8AB7C2061C2E118A18A936F13D', '4523')).toBe(
      '0xbc4c...3d:4523',
    );
  });

  it('handles various token IDs', () => {
    expect(formatNftId('0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', '0')).toBe(
      '0xbc4c...3d:0',
    );
    expect(formatNftId('0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', '999999')).toBe(
      '0xbc4c...3d:999999',
    );
  });

  it('does not truncate short addresses (10 chars or fewer)', () => {
    expect(formatNftId('0xabcdef', '1')).toBe('0xabcdef:1');
  });

  it('truncates addresses longer than 10 chars', () => {
    // 12 chars: '0xabcdefghij' → prefix '0xabcd', suffix 'ij'
    expect(formatNftId('0x1234567890ab', '42')).toBe('0x1234...ab:42');
  });
});

// ─── formatNftDescription ────────────────────────────────────────────────

describe('formatNftDescription', () => {
  it('produces IRS description with first 6 + last 4 hex chars', () => {
    expect(formatNftDescription('0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', '4523')).toBe(
      '1 0xbc4ca0...f13d:4523',
    );
  });

  it('lowercases the address in the output', () => {
    expect(formatNftDescription('0xBC4CA0EDA7647A8AB7C2061C2E118A18A936F13D', '4523')).toBe(
      '1 0xbc4ca0...f13d:4523',
    );
  });

  it('prefixes with quantity 1', () => {
    const result = formatNftDescription('0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', '7804');
    expect(result).toMatch(/^1 /);
  });

  it('handles various token IDs', () => {
    expect(formatNftDescription('0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', '0')).toBe(
      '1 0xbc4ca0...f13d:0',
    );
  });

  it('does not truncate short addresses (14 chars or fewer)', () => {
    expect(formatNftDescription('0xabcdef1234', '1')).toBe('1 0xabcdef1234:1');
  });

  it('truncates addresses longer than 14 chars', () => {
    // 16 chars: '0xabcdef12345678' → prefix '0xabcdef' (8), suffix '5678' (4)
    expect(formatNftDescription('0xabcdef12345678', '42')).toBe('1 0xabcdef...5678:42');
  });
});

// ─── Determinism ─────────────────────────────────────────────────────────

describe('determinism', () => {
  const addr = '0xBC4CA0EDA7647A8AB7C2061C2E118A18A936F13D';
  const token = '4523';

  it('nftId produces the same output for the same inputs', () => {
    const a = nftId(addr, token);
    const b = nftId(addr, token);
    expect(a).toBe(b);
  });

  it('formatNftId produces the same output for the same inputs', () => {
    const a = formatNftId(addr, token);
    const b = formatNftId(addr, token);
    expect(a).toBe(b);
  });

  it('formatNftDescription produces the same output for the same inputs', () => {
    const a = formatNftDescription(addr, token);
    const b = formatNftDescription(addr, token);
    expect(a).toBe(b);
  });
});

// ─── Property-based tests ────────────────────────────────────────────────

import * as fc from 'fast-check';

/**
 * Property 9: NFT identifier formatting
 *
 * For any valid Ethereum contract address (40 hex chars after 0x) and any
 * token ID string, `formatNftId` produces the truncated pattern
 * `0x<first4>...<last2>:<tokenId>`, and `nftId` produces a deterministic
 * lowercased `<contractAddress>:<tokenId>` string.
 *
 * **Validates: Requirements 6.4**
 *
 * Tag: Feature: nft-cost-basis, Property 9: NFT identifier formatting
 */

/** Hex character set for building Ethereum addresses. */
const HEX_CHARS = '0123456789abcdef';

/**
 * Arbitrary that generates a valid Ethereum contract address:
 * 0x-prefixed with exactly 40 hex characters, in mixed case.
 */
const arbEthAddress: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...'0123456789abcdefABCDEF'.split('')), { minLength: 40, maxLength: 40 })
  .map((chars) => `0x${chars.join('')}`);

/**
 * Arbitrary that generates a token ID string (numeric, 0–99999).
 */
const arbTokenId: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 99999 })
  .map(String);

describe('Feature: nft-cost-basis, Property 9: NFT identifier formatting', () => {
  it('nftId produces a fully lowercased <contractAddress>:<tokenId> that is deterministic', () => {
    fc.assert(
      fc.property(arbEthAddress, arbTokenId, (address, tokenId) => {
        const result = nftId(address, tokenId);

        // Result is lowercased contract address + colon + tokenId
        expect(result).toBe(`${address.toLowerCase()}:${tokenId}`);

        // Result is fully lowercased (no uppercase hex chars in the address portion)
        const addressPart = result.split(':')[0]!;
        expect(addressPart).toBe(addressPart.toLowerCase());

        // Deterministic: same inputs always produce the same output
        expect(nftId(address, tokenId)).toBe(result);
      }),
      { numRuns: 100 },
    );
  });

  it('formatNftId produces 0x<first4>...<last2>:<tokenId> for standard Ethereum addresses', () => {
    fc.assert(
      fc.property(arbEthAddress, arbTokenId, (address, tokenId) => {
        const result = formatNftId(address, tokenId);
        const lower = address.toLowerCase();

        // Standard 42-char Ethereum addresses (0x + 40 hex) are always > 10 chars,
        // so they always get truncated.
        const expectedPrefix = lower.slice(0, 6);   // '0x' + first 4 hex chars
        const expectedSuffix = lower.slice(-2);      // last 2 hex chars
        const expected = `${expectedPrefix}...${expectedSuffix}:${tokenId}`;

        expect(result).toBe(expected);

        // Verify the pattern: starts with 0x, has 4 hex chars, ellipsis, 2 hex chars, colon, tokenId
        const pattern = /^0x[0-9a-f]{4}\.\.\.[0-9a-f]{2}:.+$/;
        expect(result).toMatch(pattern);

        // Deterministic: same inputs always produce the same output
        expect(formatNftId(address, tokenId)).toBe(result);
      }),
      { numRuns: 100 },
    );
  });
});

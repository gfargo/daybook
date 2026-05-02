/**
 * Tests for the Coinbase Notes parser.
 *
 * Fixtures are real strings from a 1,948-row "All Transactions" CSV export,
 * verified against the file (with addresses preserved — these are public on chain).
 */

import { describe, expect, it } from 'vitest';
import {
  isSelfTransferDestination,
  parseAdvancedBuyNote,
  parseBuyNote,
  parseConvertNote,
  parseReceiveNote,
  parseSendNote,
  parseWithdrawalNote,
} from './notes.js';

describe('parseConvertNote', () => {
  it('parses USDC→BTC convert', () => {
    expect(parseConvertNote('Converted 10.683547 USDC to 0.00011398 BTC')).toEqual({
      sentQuantity: '10.683547',
      sentAsset: 'USDC',
      receivedQuantity: '0.00011398',
      receivedAsset: 'BTC',
    });
  });

  it('parses BTC→USDC convert (reverse direction)', () => {
    expect(parseConvertNote('Converted 0.0026938 BTC to 245.29148 USDC')).toEqual({
      sentQuantity: '0.0026938',
      sentAsset: 'BTC',
      receivedQuantity: '245.29148',
      receivedAsset: 'USDC',
    });
  });

  it('parses USDC→ETH convert', () => {
    expect(parseConvertNote('Converted 303.45 USDC to 0.16362219 ETH')).toEqual({
      sentQuantity: '303.45',
      sentAsset: 'USDC',
      receivedQuantity: '0.16362219',
      receivedAsset: 'ETH',
    });
  });

  it('throws on an unparsable Convert note', () => {
    expect(() => parseConvertNote('Some other thing happened')).toThrow();
    expect(() => parseConvertNote('')).toThrow();
  });
});

describe('parseSendNote', () => {
  it('parses an ETH send with address in notes', () => {
    const result = parseSendNote(
      'Sent 0.16362219 ETH to 0xdB684E473929b2548460FA83f71516c5283bf283 (to 0xdB6...bf283)',
    );
    expect(result).toEqual({
      verb: 'Sent',
      quantity: '0.16362219',
      asset: 'ETH',
      destinationAddress: '0xdB684E473929b2548460FA83f71516c5283bf283',
      isEvmAddress: true,
    });
  });

  it('parses a self-send (DAI to user wallet)', () => {
    const result = parseSendNote(
      'Sent 1675.95154154 DAI to 0x1296Df1Ad1AabFBcBf28Dd45BeF9Bd0A4206F85b (to 0x129...6F85b)',
    );
    expect(result?.destinationAddress).toBe(
      '0x1296Df1Ad1AabFBcBf28Dd45BeF9Bd0A4206F85b',
    );
    expect(result?.isEvmAddress).toBe(true);
  });

  it('returns null for non-Send notes', () => {
    expect(parseSendNote('Bought 0.001 BTC for 100 USD')).toBeNull();
  });
});

describe('parseReceiveNote', () => {
  it('parses receive from external account', () => {
    expect(
      parseReceiveNote('Received 0.5 ETH from an external account'),
    ).toEqual({
      quantity: '0.5',
      asset: 'ETH',
      source: 'an external account',
    });
  });

  it('parses receive from Coinbase', () => {
    expect(
      parseReceiveNote('Received 0.000249 BTC from Coinbase'),
    ).toEqual({
      quantity: '0.000249',
      asset: 'BTC',
      source: 'Coinbase',
    });
  });
});

describe('parseWithdrawalNote', () => {
  it('parses fiat withdrawal with bank + account last 4', () => {
    expect(
      parseWithdrawalNote('Withdrawal to Community Bank, N.A./ ... *******9407'),
    ).toEqual({
      bankName: 'Community Bank, N.A.',
      accountLast4: '9407',
    });
  });
});

describe('parseBuyNote', () => {
  it('parses a simple Buy', () => {
    expect(parseBuyNote('Bought 0.00152134 BTC for 150 USD')).toEqual({
      quantity: '0.00152134',
      asset: 'BTC',
      fiatAmount: '150',
      fiatCurrency: 'USD',
    });
  });

  it('parses a Buy with bank account info appended', () => {
    expect(
      parseBuyNote(
        'Bought 3.22020528 AVAX for 125 USD using bank account Community Bank, N.A./ ... *******9407',
      ),
    ).toEqual({
      quantity: '3.22020528',
      asset: 'AVAX',
      fiatAmount: '125',
      fiatCurrency: 'USD',
      bankName: 'Community Bank, N.A.',
      bankAccountLast4: '9407',
    });
  });
});

describe('parseAdvancedBuyNote', () => {
  it('parses an Advanced Trade Buy with pair and unit price', () => {
    expect(
      parseAdvancedBuyNote(
        'Bought 0.0029612 BTC for 124.743745075576 USD on BTC-USD at 41874.83 USD/BTC',
      ),
    ).toEqual({
      quantity: '0.0029612',
      asset: 'BTC',
      fiatAmount: '124.743745075576',
      fiatCurrency: 'USD',
      pair: 'BTC-USD',
      unitPrice: '41874.83',
    });
  });

  it('parses an AVAX advanced buy', () => {
    expect(
      parseAdvancedBuyNote(
        'Bought 2.43 AVAX for 97.0468128 USD on AVAX-USD at 39.62 USD/AVAX',
      ),
    ).toMatchObject({
      asset: 'AVAX',
      pair: 'AVAX-USD',
      unitPrice: '39.62',
    });
  });
});

describe('isSelfTransferDestination', () => {
  const own = ['0x1296Df1Ad1AabFBcBf28Dd45BeF9Bd0A4206F85b'];

  it('matches case-insensitively', () => {
    expect(
      isSelfTransferDestination('0x1296df1ad1aabfbcbf28dd45bef9bd0a4206f85b', own),
    ).toBe(true);
    expect(
      isSelfTransferDestination('0x1296DF1AD1AABFBCBF28DD45BEF9BD0A4206F85B', own),
    ).toBe(true);
  });

  it('returns false for a different address', () => {
    expect(
      isSelfTransferDestination(
        '0xdB684E473929b2548460FA83f71516c5283bf283',
        own,
      ),
    ).toBe(false);
  });

  it('returns false when the user has no addresses configured', () => {
    expect(
      isSelfTransferDestination(
        '0x1296Df1Ad1AabFBcBf28Dd45BeF9Bd0A4206F85b',
        [],
      ),
    ).toBe(false);
  });
});

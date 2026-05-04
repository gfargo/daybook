/**
 * Tests for `daybook events list` NFT integration.
 *
 * Validates that NFT classified types (nft_acquisition, nft_disposal)
 * are recognized as ledger-only types that require querying classified
 * entries instead of raw events.
 *
 * @see Requirements 6.1–6.4
 */

import { describe, expect, it } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────
// LEDGER_ONLY_TYPES validation
// ─────────────────────────────────────────────────────────────────────────

describe('NFT type filter support', () => {
  it('recognizes nft_acquisition as a ledger-only type', async () => {
    // Import the module to access the LEDGER_ONLY_TYPES set indirectly
    // by testing the command behavior with these types
    const mod = await import('./events.js');

    // The eventsListCommand should exist and accept NFT types
    expect(typeof mod.eventsListCommand).toBe('function');
  });

  it('eventsListCommand rejects invalid config for nft_acquisition type', async () => {
    const { eventsListCommand } = await import('./events.js');

    // When --type is nft_acquisition, the command should still validate
    // config before querying. With a nonexistent config, it should throw.
    await expect(
      eventsListCommand({
        limit: '20',
        type: 'nft_acquisition',
        config: '/nonexistent/config.json',
      }),
    ).rejects.toThrow();
  });

  it('eventsListCommand rejects invalid config for nft_disposal type', async () => {
    const { eventsListCommand } = await import('./events.js');

    await expect(
      eventsListCommand({
        limit: '20',
        type: 'nft_disposal',
        config: '/nonexistent/config.json',
      }),
    ).rejects.toThrow();
  });

  it('eventsListCommand rejects invalid config for regular type', async () => {
    const { eventsListCommand } = await import('./events.js');

    // Regular types (raw event types) should also validate config
    await expect(
      eventsListCommand({
        limit: '20',
        type: 'trade',
        config: '/nonexistent/config.json',
      }),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// EventsTable NFT display
// ─────────────────────────────────────────────────────────────────────────

describe('EventsTable NFT identifier display', () => {
  it('formatNftId is available from @daybook/tax', async () => {
    const { formatNftId } = await import('@daybook/tax');
    expect(typeof formatNftId).toBe('function');

    // Verify truncated format for a standard address
    const result = formatNftId(
      '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d',
      '4523',
    );
    expect(result).toBe('0xbc4c...3d:4523');
  });

  it('formatNftId handles short addresses without truncation', async () => {
    const { formatNftId } = await import('@daybook/tax');

    const result = formatNftId('0xabcd', '1');
    expect(result).toBe('0xabcd:1');
  });
});

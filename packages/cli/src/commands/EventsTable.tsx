/**
 * Ink-based events table for `daybook events list`.
 *
 * Renders a fixed-width table of RawEvents using the shared UI library.
 * Column widths: Timestamp (20), Type (18), Asset/Amount (30),
 * Source (12), Account (16 — omitted when terminal < 100 chars).
 *
 * Fee legs are rendered with dimmed color. Multi-leg events join
 * all legs with a ` / ` separator.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { RawEvent } from '@daybook/ledger';
import { formatNftId } from '@daybook/tax';
import { color, EmptyState } from '../ui/index.js';

// ─────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────

/** Props for the EventsTable component. */
export interface EventsTableProps {
  /** Array of RawEvent objects to display. */
  events: RawEvent[];
}

// ─────────────────────────────────────────────────────────────────────────
// Column widths
// ─────────────────────────────────────────────────────────────────────────

const COL_TIMESTAMP = 20;
const COL_TYPE = 18;
const COL_ASSET_AMOUNT = 30;
const COL_SOURCE = 12;
const COL_ACCOUNT = 16;

/** Minimum terminal width required to show the Account column. */
const MIN_WIDTH_FOR_ACCOUNT = 100;

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** Format a Date to ISO 8601 with seconds precision. */
function formatTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19);
}

/** Determine whether the Account column should be shown based on terminal width. */
function shouldShowAccount(): boolean {
  return (process.stdout.columns ?? 80) >= MIN_WIDTH_FOR_ACCOUNT;
}

// ─────────────────────────────────────────────────────────────────────────
// Leg renderer
// ─────────────────────────────────────────────────────────────────────────

/** Render a single AssetLeg. Fee legs use paper color with a `(fee)` prefix. NFT legs show truncated identifier. */
function LegText({ amount, asset, feeFlag, contractAddress, tokenId }: { amount: string; asset: string; feeFlag: boolean | undefined; contractAddress: string | undefined; tokenId: string | undefined }): React.ReactElement {
  // NFT legs: show truncated identifier instead of raw asset/amount
  if (contractAddress && tokenId) {
    const nftDisplay = formatNftId(contractAddress, tokenId);
    if (feeFlag) {
      return <Text>{color.paper(`(fee) ${amount} ${nftDisplay}`)}</Text>;
    }
    return <Text>{amount} {nftDisplay}</Text>;
  }

  if (feeFlag) {
    return <Text>{color.paper(`(fee) ${amount} ${asset}`)}</Text>;
  }
  return <Text>{amount} {asset}</Text>;
}

// ─────────────────────────────────────────────────────────────────────────
// Row component
// ─────────────────────────────────────────────────────────────────────────

interface EventRowProps {
  event: RawEvent;
  showAccount: boolean;
}

/** Renders a single event row in the table. */
function EventRow({ event, showAccount }: EventRowProps): React.ReactElement {
  return (
    <Box>
      <Box width={COL_TIMESTAMP}>
        <Text>{formatTimestamp(event.timestamp)}</Text>
      </Box>
      <Box width={COL_TYPE}>
        <Text>{color.stamp(event.type)}</Text>
      </Box>
      <Box width={COL_ASSET_AMOUNT}>
        {event.legs.map((leg, i) => (
          <React.Fragment key={i}>
            {i > 0 && <Text> / </Text>}
            <LegText amount={leg.amount} asset={leg.asset} feeFlag={leg.feeFlag} contractAddress={leg.contractAddress} tokenId={leg.tokenId} />
          </React.Fragment>
        ))}
      </Box>
      <Box width={COL_SOURCE}>
        <Text>{color.stamp(event.source)}</Text>
      </Box>
      {showAccount && (
        <Box width={COL_ACCOUNT}>
          <Text>{color.paper(event.accountId)}</Text>
        </Box>
      )}
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Header component
// ─────────────────────────────────────────────────────────────────────────

interface HeaderRowProps {
  showAccount: boolean;
}

/** Renders the table header row. */
function HeaderRow({ showAccount }: HeaderRowProps): React.ReactElement {
  return (
    <Box>
      <Box width={COL_TIMESTAMP}>
        <Text bold>{color.paper('Timestamp')}</Text>
      </Box>
      <Box width={COL_TYPE}>
        <Text bold>{color.paper('Type')}</Text>
      </Box>
      <Box width={COL_ASSET_AMOUNT}>
        <Text bold>{color.paper('Asset/Amount')}</Text>
      </Box>
      <Box width={COL_SOURCE}>
        <Text bold>{color.paper('Source')}</Text>
      </Box>
      {showAccount && (
        <Box width={COL_ACCOUNT}>
          <Text bold>{color.paper('Account')}</Text>
        </Box>
      )}
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────

/**
 * Renders a table of RawEvents using the shared UI library.
 *
 * Shows one row per event with columns for timestamp, type, asset/amount
 * legs, source, and (when the terminal is wide enough) account ID.
 */
export function EventsTable({ events }: EventsTableProps): React.ReactElement {
  if (events.length === 0) {
    return (
      <EmptyState
        title="No events match"
        hint="Run daybook sync first, or relax the --type filter."
      />
    );
  }

  const showAccount = shouldShowAccount();

  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1} paddingBottom={1}>
      <HeaderRow showAccount={showAccount} />
      {events.map(event => (
        <EventRow key={event.id} event={event} showAccount={showAccount} />
      ))}
    </Box>
  );
}

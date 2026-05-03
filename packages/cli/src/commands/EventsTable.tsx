/**
 * Ink-based events table for `daybook events list`.
 *
 * Renders a fixed-width table of RawEvents using Ink's Box and Text
 * components. Modelled on the existing CompareTable.tsx pattern.
 *
 * Column widths: Timestamp (20), Type (18), Asset/Amount (30),
 * Source (12), Account (16 — omitted when terminal < 100 chars).
 *
 * Fee legs are rendered with dimmed color. Multi-leg events join
 * all legs with a ` / ` separator.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { RawEvent } from '@daybook/ledger';

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

/**
 * Format a Date to ISO 8601 with seconds precision (no milliseconds, no Z suffix).
 */
function formatTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19);
}

/**
 * Determine whether the Account column should be shown based on terminal width.
 */
function shouldShowAccount(): boolean {
  return (process.stdout.columns ?? 80) >= MIN_WIDTH_FOR_ACCOUNT;
}

// ─────────────────────────────────────────────────────────────────────────
// Leg renderer
// ─────────────────────────────────────────────────────────────────────────

/**
 * Render a single AssetLeg as a React element.
 * Fee legs use dimmed color with a `(fee)` prefix.
 */
function LegText({ amount, asset, feeFlag }: { amount: string; asset: string; feeFlag: boolean | undefined }): React.ReactElement {
  if (feeFlag) {
    return <Text dimColor>(fee) {amount} {asset}</Text>;
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
        <Text>{event.type}</Text>
      </Box>
      <Box width={COL_ASSET_AMOUNT}>
        {event.legs.map((leg, i) => (
          <React.Fragment key={i}>
            {i > 0 && <Text> / </Text>}
            <LegText amount={leg.amount} asset={leg.asset} feeFlag={leg.feeFlag} />
          </React.Fragment>
        ))}
      </Box>
      <Box width={COL_SOURCE}>
        <Text>{event.source}</Text>
      </Box>
      {showAccount && (
        <Box width={COL_ACCOUNT}>
          <Text>{event.accountId}</Text>
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
        <Text bold>Timestamp</Text>
      </Box>
      <Box width={COL_TYPE}>
        <Text bold>Type</Text>
      </Box>
      <Box width={COL_ASSET_AMOUNT}>
        <Text bold>Asset/Amount</Text>
      </Box>
      <Box width={COL_SOURCE}>
        <Text bold>Source</Text>
      </Box>
      {showAccount && (
        <Box width={COL_ACCOUNT}>
          <Text bold>Account</Text>
        </Box>
      )}
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────

/**
 * Renders a table of RawEvents using Ink Box/Text components.
 *
 * Shows one row per event with columns for timestamp, type, asset/amount
 * legs, source, and (when the terminal is wide enough) account ID.
 *
 * When the events array is empty, renders a plain empty-state message.
 */
export function EventsTable({ events }: EventsTableProps): React.ReactElement {
  if (events.length === 0) {
    return <Text>No events match. Run `daybook sync ...` or relax the filter.</Text>;
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

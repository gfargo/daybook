/**
 * Ink-based interactive review for unclassified LedgerEntries.
 *
 * After classification, this component displays all entries with type
 * `unclassified` and lets the user override each one inline using
 * arrow-key navigation and type selection.
 *
 * State machine:
 *   LISTING → (Enter) → SELECTING_TYPE → (confirm) → LISTING (entry removed)
 *                                      → (Escape/q) → LISTING (no change)
 *   LISTING → (q) → DONE
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import type { LedgerEntry, LedgerEntryType } from '@daybook/ledger';

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

/** All LedgerEntryType values the user can pick from. */
const ENTRY_TYPES: LedgerEntryType[] = [
  'fiat_in',
  'fiat_out',
  'transfer_self',
  'transfer_external_out',
  'transfer_external_in',
  'trade',
  'income',
  'fee_disposal',
  'nft_event',
];

// ─────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────

/** Props for the UnclassifiedReview component. */
export interface UnclassifiedReviewProps {
  /** Unclassified ledger entries to review. */
  entries: LedgerEntry[];
  /** Called when the user confirms a type override for an entry. */
  onOverride: (entry: LedgerEntry, selectedType: LedgerEntryType) => void;
  /** Called when the user exits the review (q on main list or list empty). */
  onDone: (overridesCreated: number) => void;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** Truncate a string to a max length, appending '…' if truncated. */
function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

/** Format a Date to ISO 8601 with seconds precision. */
function formatTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19);
}

/**
 * Format the asset legs of an entry as a compact string.
 * Fee legs are prefixed with `(fee)`.
 */
function formatLegs(entry: LedgerEntry): string {
  return entry.legs
    .map(leg => {
      const prefix = leg.feeFlag ? '(fee) ' : '';
      return `${prefix}${leg.amount} ${leg.asset}`;
    })
    .join(' / ');
}

/**
 * Collect the backing RawEvent types from the entry's rawEventIds.
 * Since we only have the IDs (not the full events), we extract the
 * source prefix as a proxy for the event type context.
 */
function formatBackingTypes(entry: LedgerEntry): string {
  // rawEventIds look like "coinbase:xxx", "eth:xxx", "kraken:xxx"
  const sources = new Set(
    entry.rawEventIds.map(id => {
      const colonIdx = id.indexOf(':');
      return colonIdx > 0 ? id.slice(0, colonIdx) : 'unknown';
    }),
  );
  return [...sources].join(', ');
}

// ─────────────────────────────────────────────────────────────────────────
// Entry row component
// ─────────────────────────────────────────────────────────────────────────

interface EntryRowProps {
  entry: LedgerEntry;
  isSelected: boolean;
}

/** Renders a single unclassified entry row. */
function EntryRow({ entry, isSelected }: EntryRowProps): React.ReactElement {
  return (
    <Box>
      <Text>{isSelected ? '▸ ' : '  '}</Text>
      <Box width={14}>
        <Text bold={isSelected}>{truncate(entry.id, 12)}</Text>
      </Box>
      <Box width={21}>
        <Text>{formatTimestamp(entry.timestamp)}</Text>
      </Box>
      <Box width={14}>
        <Text dimColor>{formatBackingTypes(entry)}</Text>
      </Box>
      <Box>
        <Text>{formatLegs(entry)}</Text>
      </Box>
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Type selector component
// ─────────────────────────────────────────────────────────────────────────

interface TypeSelectorProps {
  selectedIndex: number;
}

/** Renders the inline type-selection prompt. */
function TypeSelector({ selectedIndex }: TypeSelectorProps): React.ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={1}>
      <Text bold>Select type (↑/↓ to navigate, Enter to confirm, Esc/q to cancel):</Text>
      {ENTRY_TYPES.map((type, i) => (
        <Box key={type}>
          <Text>{i === selectedIndex ? '▸ ' : '  '}</Text>
          {i === selectedIndex ? (
            <Text bold color="cyan">{type}</Text>
          ) : (
            <Text>{type}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────

type Mode = 'listing' | 'selecting';

/**
 * Interactive review component for unclassified LedgerEntries.
 *
 * Displays a navigable list of unclassified entries. Pressing Enter
 * opens an inline type selector. Confirming a type calls `onOverride`
 * and removes the entry from the list. Pressing `q` on the main list
 * exits the review.
 */
export function UnclassifiedReview({
  entries: initialEntries,
  onOverride,
  onDone,
}: UnclassifiedReviewProps): React.ReactElement {
  const [remaining, setRemaining] = useState<LedgerEntry[]>(initialEntries);
  const [listIndex, setListIndex] = useState(0);
  const [mode, setMode] = useState<Mode>('listing');
  const [typeIndex, setTypeIndex] = useState(0);
  const [overrideCount, setOverrideCount] = useState(0);

  const handleDone = useCallback(
    (count: number) => {
      onDone(count);
    },
    [onDone],
  );

  useInput((input, key) => {
    if (mode === 'listing') {
      // ── List navigation ──────────────────────────────────────────
      if (key.upArrow) {
        setListIndex(prev => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setListIndex(prev => Math.min(remaining.length - 1, prev + 1));
      } else if (key.return) {
        // Enter → open type selector for the selected entry
        if (remaining.length > 0) {
          setTypeIndex(0);
          setMode('selecting');
        }
      } else if (input === 'q') {
        // Quit the review
        handleDone(overrideCount);
      }
    } else if (mode === 'selecting') {
      // ── Type selection ───────────────────────────────────────────
      if (key.upArrow) {
        setTypeIndex(prev => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setTypeIndex(prev => Math.min(ENTRY_TYPES.length - 1, prev + 1));
      } else if (key.return) {
        // Confirm type selection
        const entry = remaining[listIndex]!;
        const selectedType = ENTRY_TYPES[typeIndex]!;
        onOverride(entry, selectedType);

        const newRemaining = remaining.filter((_, i) => i !== listIndex);
        const newCount = overrideCount + 1;
        setOverrideCount(newCount);
        setRemaining(newRemaining);
        setMode('listing');

        // Adjust list index if we removed the last item
        if (listIndex >= newRemaining.length && newRemaining.length > 0) {
          setListIndex(newRemaining.length - 1);
        }

        // Auto-exit when list is empty
        if (newRemaining.length === 0) {
          handleDone(newCount);
        }
      } else if (key.escape || input === 'q') {
        // Cancel type selection → return to list
        setMode('listing');
      }
    }
  });

  // ── Empty state (should not normally render — auto-exit handles it) ──
  if (remaining.length === 0) {
    return <Text>No unclassified entries remaining.</Text>;
  }

  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1} paddingBottom={1}>
      <Text bold>Unclassified Event Review ({remaining.length} remaining)</Text>
      <Text dimColor>↑/↓ navigate · Enter select · q quit</Text>
      <Text> </Text>

      {/* Header */}
      <Box>
        <Text>  </Text>
        <Box width={14}>
          <Text bold>ID</Text>
        </Box>
        <Box width={21}>
          <Text bold>Timestamp</Text>
        </Box>
        <Box width={14}>
          <Text bold>Source</Text>
        </Box>
        <Box>
          <Text bold>Legs</Text>
        </Box>
      </Box>

      {/* Entry rows */}
      {remaining.map((entry, i) => (
        <EntryRow key={entry.id} entry={entry} isSelected={i === listIndex} />
      ))}

      {/* Inline type selector */}
      {mode === 'selecting' && <TypeSelector selectedIndex={typeIndex} />}
    </Box>
  );
}

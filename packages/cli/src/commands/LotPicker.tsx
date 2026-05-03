/**
 * Ink-based interactive lot picker for `daybook export --method specific-id`.
 *
 * Displays one disposal at a time and lets the user select which lots
 * to consume using checkbox-style toggling. Shows a running total vs
 * the required disposal amount. Pressing `s` skips a disposal (falls
 * back to FIFO). On completion, returns a `Map<string, string>` of
 * lot selections (lotId → amount to take).
 *
 * State machine:
 *   PICKING → (Space) → toggle lot → PICKING
 *   PICKING → (Enter, when total ≥ required) → next disposal → PICKING
 *   PICKING → (s) → skip disposal (FIFO fallback) → next disposal
 *   PICKING → (last disposal done) → DONE
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import Decimal from 'decimal.js';
import type { Lot, DisposalResult } from '@daybook/tax';

// ─────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────

/** A disposal that needs lot selection. */
export interface PendingDisposal {
  /** The disposal result (with lots not yet finalized). */
  disposal: DisposalResult;
  /** Available lots for this asset at the time of disposal. */
  availableLots: ReadonlyArray<Lot>;
}

/** Props for the LotPicker component. */
export interface LotPickerProps {
  /** Disposals that need lot selection, in chronological order. */
  disposals: PendingDisposal[];
  /** Called when all disposals have been processed. */
  onDone: (selections: Map<string, string>, skippedDisposalIndices: Set<number>) => void;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** Truncate a string to a max length, appending '…' if truncated. */
function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

/** Format a Date as YYYY-MM-DD in UTC. */
function formatDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Compute holding period in days between two dates. */
function holdingDays(acquired: Date, disposed: Date): number {
  return Math.floor((disposed.getTime() - acquired.getTime()) / 86_400_000);
}

/** Format holding period as a human-readable string. */
function formatHolding(days: number): string {
  if (days > 365) {
    const years = Math.floor(days / 365);
    const rem = days % 365;
    return rem > 0 ? `${years}y ${rem}d` : `${years}y`;
  }
  return `${days}d`;
}

// ─────────────────────────────────────────────────────────────────────────
// Lot row component
// ─────────────────────────────────────────────────────────────────────────

interface LotRowProps {
  lot: Lot;
  isSelected: boolean;
  isCursor: boolean;
  disposedAt: Date;
}

/** Renders a single lot row with checkbox, details, and holding period. */
function LotRow({ lot, isSelected, isCursor, disposedAt }: LotRowProps): React.ReactElement {
  const days = holdingDays(lot.acquiredAt, disposedAt);
  const term = days > 365 ? 'long' : 'short';

  return (
    <Box>
      <Text>{isCursor ? '▸ ' : '  '}</Text>
      <Text>{isSelected ? '[✓] ' : '[ ] '}</Text>
      <Box width={14}>
        <Text bold={isCursor}>{truncate(lot.id, 12)}</Text>
      </Box>
      <Box width={12}>
        <Text>{formatDate(lot.acquiredAt)}</Text>
      </Box>
      <Box width={16}>
        <Text>{lot.amount}</Text>
      </Box>
      <Box width={14}>
        <Text>${lot.unitCostUsd}</Text>
      </Box>
      <Box width={12}>
        <Text color={term === 'long' ? 'green' : 'yellow'}>
          {formatHolding(days)} ({term})
        </Text>
      </Box>
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────

/**
 * Interactive lot picker for Specific ID cost-basis selection.
 *
 * Shows one disposal at a time with its available lots. The user
 * toggles lots with Space, advances with Enter when the total is
 * covered, or presses `s` to skip (FIFO fallback).
 */
export function LotPicker({ disposals, onDone }: LotPickerProps): React.ReactElement {
  const [disposalIndex, setDisposalIndex] = useState(0);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [selectedLotIds, setSelectedLotIds] = useState<Set<string>>(new Set());
  const [allSelections] = useState<Map<string, string>>(() => new Map());
  const [skippedIndices] = useState<Set<number>>(() => new Set());

  const current = disposals[disposalIndex];

  const handleComplete = useCallback(
    (selections: Map<string, string>, skipped: Set<number>) => {
      onDone(selections, skipped);
    },
    [onDone],
  );

  const advanceToNext = useCallback(
    (newSelections: Map<string, string>, newSkipped: Set<number>) => {
      const nextIdx = disposalIndex + 1;
      if (nextIdx >= disposals.length) {
        handleComplete(newSelections, newSkipped);
      } else {
        setDisposalIndex(nextIdx);
        setCursorIndex(0);
        setSelectedLotIds(new Set());
      }
    },
    [disposalIndex, disposals.length, handleComplete],
  );

  useInput((input, key) => {
    if (!current) return;

    const lots = current.availableLots;

    if (key.upArrow) {
      setCursorIndex(prev => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setCursorIndex(prev => Math.min(lots.length - 1, prev + 1));
    } else if (input === ' ') {
      // Toggle lot selection
      const lot = lots[cursorIndex];
      if (!lot) return;

      setSelectedLotIds(prev => {
        const next = new Set(prev);
        if (next.has(lot.id)) {
          next.delete(lot.id);
        } else {
          next.add(lot.id);
        }
        return next;
      });
    } else if (key.return) {
      // Confirm selection — only if total covers the disposal
      const requiredAmount = new Decimal(current.disposal.amount);
      let total = new Decimal(0);
      for (const lot of lots) {
        if (selectedLotIds.has(lot.id)) {
          total = total.plus(new Decimal(lot.amount));
        }
      }

      if (total.gte(requiredAmount)) {
        // Record selections: take exactly what's needed from each lot
        let remaining = requiredAmount;
        for (const lot of lots) {
          if (!selectedLotIds.has(lot.id)) continue;
          if (remaining.isZero()) break;

          const lotAmount = new Decimal(lot.amount);
          const take = Decimal.min(lotAmount, remaining);
          allSelections.set(lot.id, take.toString());
          remaining = remaining.minus(take);
        }

        advanceToNext(allSelections, skippedIndices);
      }
    } else if (input === 's') {
      // Skip this disposal — FIFO fallback
      skippedIndices.add(disposalIndex);
      advanceToNext(allSelections, skippedIndices);
    }
  });

  // ── Done state ──────────────────────────────────────────────────────
  if (!current) {
    return <Text>Lot selection complete.</Text>;
  }

  const { disposal, availableLots } = current;
  const requiredAmount = new Decimal(disposal.amount);

  // Compute running total of selected lots
  let selectedTotal = new Decimal(0);
  for (const lot of availableLots) {
    if (selectedLotIds.has(lot.id)) {
      selectedTotal = selectedTotal.plus(new Decimal(lot.amount));
    }
  }

  const covered = selectedTotal.gte(requiredAmount);
  const remainingStr = requiredAmount.minus(Decimal.min(selectedTotal, requiredAmount)).toString();

  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1} paddingBottom={1}>
      <Text bold>
        Disposal {disposalIndex + 1} of {disposals.length}
      </Text>
      <Text>
        Asset: <Text bold>{disposal.asset}</Text>  Amount: <Text bold>{disposal.amount}</Text>  Date: {formatDate(disposal.disposedAt)}
      </Text>
      <Text dimColor>Space toggle · Enter confirm · s skip (FIFO) · ↑/↓ navigate</Text>
      <Text> </Text>

      {/* Lot table header */}
      <Box>
        <Text>      </Text>
        <Box width={14}>
          <Text bold>Lot ID</Text>
        </Box>
        <Box width={12}>
          <Text bold>Acquired</Text>
        </Box>
        <Box width={16}>
          <Text bold>Amount</Text>
        </Box>
        <Box width={14}>
          <Text bold>Unit Cost</Text>
        </Box>
        <Box width={12}>
          <Text bold>Holding</Text>
        </Box>
      </Box>

      {/* Lot rows */}
      {availableLots.map((lot, i) => (
        <LotRow
          key={lot.id}
          lot={lot}
          isSelected={selectedLotIds.has(lot.id)}
          isCursor={i === cursorIndex}
          disposedAt={disposal.disposedAt}
        />
      ))}

      {/* Running total */}
      <Text> </Text>
      <Box>
        <Text>
          Selected: <Text bold color={covered ? 'green' : 'yellow'}>{selectedTotal.toString()}</Text>
          {' / '}
          <Text bold>{requiredAmount.toString()}</Text>
          {covered ? (
            <Text color="green"> ✓ covered — press Enter to confirm</Text>
          ) : (
            <Text color="yellow"> ({remainingStr} remaining)</Text>
          )}
        </Text>
      </Box>
    </Box>
  );
}

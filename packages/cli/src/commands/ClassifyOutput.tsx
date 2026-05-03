/**
 * Ink-based output for `daybook classify` results.
 *
 * Replaces the plain console.log output with themed rendering
 * using the shared UI component library.
 */

import React from 'react';
import { render, Box, Text } from 'ink';
import { color, glyph, Row, Section, formatCount } from '../ui/index.js';

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export interface ClassifyResult {
  entries: Array<{ id: string; type: string }>;
  unclassifiedCount: number;
  perRuleCounts: Record<string, number>;
}

// ─────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────

function TypeBreakdown({ entries }: { entries: Array<{ type: string }> }): React.ReactElement {
  const typeCounts = new Map<string, number>();
  for (const entry of entries) {
    typeCounts.set(entry.type, (typeCounts.get(entry.type) ?? 0) + 1);
  }
  const sorted = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <Section title="By type">
      {sorted.map(([type, count]) => (
        <Row key={type} label={type} value={count} labelWidth={28} />
      ))}
    </Section>
  );
}

function RuleBreakdown({ perRuleCounts }: { perRuleCounts: Record<string, number> }): React.ReactElement | null {
  const entries = Object.entries(perRuleCounts);
  if (entries.length === 0) return null;

  return (
    <Section title="By rule">
      {entries.map(([rule, count]) => (
        <Row key={rule} label={rule} value={count} labelWidth={28} />
      ))}
    </Section>
  );
}

function UnclassifiedWarning({ count }: { count: number }): React.ReactElement | null {
  if (count === 0) return null;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{color.caution(`${glyph('warning')}  ${formatCount(count, 'unclassified event')}`)}</Text>
      <Box paddingLeft={4}>
        <Text>{color.paper('Use daybook classify --review or daybook overrides to classify these.')}</Text>
      </Box>
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Normal output
// ─────────────────────────────────────────────────────────────────────────

function NormalOutput({
  result,
  eventCount,
  overrideCount,
}: {
  result: ClassifyResult;
  eventCount: number;
  overrideCount: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1} paddingBottom={1}>
      <Box>
        <Text>{color.gain(`${glyph('check')}  Classification complete`)}</Text>
      </Box>

      <Box marginTop={1}>
        <Row label="Events processed" value={eventCount} labelWidth={20} />
      </Box>
      <Row label="Ledger entries" value={result.entries.length} labelWidth={20} />
      {overrideCount > 0 && (
        <Row label="Overrides applied" value={overrideCount} labelWidth={20} />
      )}

      <TypeBreakdown entries={result.entries} />
      <RuleBreakdown perRuleCounts={result.perRuleCounts} />
      <UnclassifiedWarning count={result.unclassifiedCount} />
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Dry-run output
// ─────────────────────────────────────────────────────────────────────────

interface DryRunDiff {
  added: number;
  removed: number;
  unchanged: number;
}

function DryRunOutput({
  result,
  eventCount,
  overrideCount,
  diff,
}: {
  result: ClassifyResult;
  eventCount: number;
  overrideCount: number;
  diff?: DryRunDiff;
}): React.ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1} paddingBottom={1}>
      <Box>
        <Text>{color.note(`${glyph('info')}  Dry run — no changes written to database`)}</Text>
      </Box>

      <Box marginTop={1}>
        <Row label="Events processed" value={eventCount} labelWidth={20} />
      </Box>
      <Row label="Entries computed" value={result.entries.length} labelWidth={20} />
      {overrideCount > 0 && (
        <Row label="Overrides applied" value={overrideCount} labelWidth={20} />
      )}

      <TypeBreakdown entries={result.entries} />
      <UnclassifiedWarning count={result.unclassifiedCount} />

      {diff && (
        <Section title="Changes vs current DB">
          <Row label="+ new" value={diff.added} labelWidth={14} />
          <Row label="- removed" value={diff.removed} labelWidth={14} />
          <Row label="= unchanged" value={diff.unchanged} labelWidth={14} />
        </Section>
      )}
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Public render functions
// ─────────────────────────────────────────────────────────────────────────

/** Render normal classification output. */
export function renderClassifyOutput(
  result: ClassifyResult,
  eventCount: number,
  overrideCount: number,
): void {
  render(<NormalOutput result={result} eventCount={eventCount} overrideCount={overrideCount} />);
}

/** Render dry-run classification output. */
export function renderClassifyDryRun(
  result: ClassifyResult,
  eventCount: number,
  overrideCount: number,
  diff?: DryRunDiff,
): void {
  if (diff) {
    render(<DryRunOutput result={result} eventCount={eventCount} overrideCount={overrideCount} diff={diff} />);
  } else {
    render(<DryRunOutput result={result} eventCount={eventCount} overrideCount={overrideCount} />);
  }
}

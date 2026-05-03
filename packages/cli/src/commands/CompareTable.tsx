/**
 * Ink-based comparison table for `daybook compare <year>`.
 *
 * Renders a styled table showing FIFO vs HIFO side by side
 * using the shared UI component library. The method with the
 * lowest total taxable amount is highlighted via the `note` color.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { MethodSummary } from '@daybook/tax';
import { color, formatUsd as fmtUsd, Header, ErrorBlock } from '../ui/index.js';

// ─────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────

export interface CompareTableProps {
  /** Summary data for each cost-basis method. */
  summaries: MethodSummary[];
  /** The method name with the lowest total taxable amount. */
  lowestTaxMethod: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** Format a decimal string as USD. */
function formatUsd(value: string): string {
  return fmtUsd(Number(value));
}

// ─────────────────────────────────────────────────────────────────────────
// Row component
// ─────────────────────────────────────────────────────────────────────────

interface TableRowProps {
  label: string;
  values: string[];
  highlight?: number;
  labelWidth: number;
  colWidth: number;
}

function TableRow({ label, values, highlight, labelWidth, colWidth }: TableRowProps): React.ReactElement {
  return (
    <Box>
      <Box width={labelWidth}>
        <Text>{color.paper(label)}</Text>
      </Box>
      <Text>{color.rule('│')} </Text>
      {values.map((val, i) => (
        <Box key={i} width={colWidth} justifyContent="flex-end">
          {highlight === i ? (
            <Text bold>{color.note(val)}</Text>
          ) : (
            <Text>{val}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────

/**
 * Renders a comparison table using the shared UI library.
 *
 * Shows: Metric | FIFO | HIFO with the lowest total taxable
 * method highlighted in note color + bold.
 */
export function CompareTable({ summaries, lowestTaxMethod }: CompareTableProps): React.ReactElement {
  const methods = summaries.map(s => s.method);
  const methodSummaries = summaries;

  if (methods.length === 0) {
    return (
      <ErrorBlock
        title="No method results to compare"
        recovery="Run daybook compare <year> to generate comparison data."
      />
    );
  }

  const rows: Array<{ label: string; values: string[]; highlightLowest?: boolean }> = [
    {
      label: 'Disposal count',
      values: methodSummaries.map(s => String(s.disposalCount)),
    },
    {
      label: 'Short-term gain',
      values: methodSummaries.map(s => formatUsd(s.shortTermGain)),
    },
    {
      label: 'Long-term gain',
      values: methodSummaries.map(s => formatUsd(s.longTermGain)),
    },
    {
      label: 'Total taxable',
      values: methodSummaries.map(s => formatUsd(s.totalTaxable)),
      highlightLowest: true,
    },
    {
      label: 'Income',
      values: methodSummaries.map(s => formatUsd(s.incomeTotal)),
    },
  ];

  const labelWidth = 20;
  const colWidth = 20;

  const lowestIdx = methods.indexOf(lowestTaxMethod);
  const divider = color.rule('─'.repeat(labelWidth - 1) + '┼' + '─'.repeat(colWidth * methods.length + 1));

  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1} paddingBottom={1}>
      <Header>Tax method comparison</Header>

      {/* Header */}
      <Box>
        <Box width={labelWidth}>
          <Text bold>{color.paper('Metric')}</Text>
        </Box>
        <Text>{color.rule('│')} </Text>
        {methods.map(m => (
          <Box key={m} width={colWidth} justifyContent="flex-end">
            <Text bold>{color.paper(m)}</Text>
          </Box>
        ))}
      </Box>

      {/* Divider */}
      <Text>{divider}</Text>

      {/* Data rows */}
      {rows.map(row => (
        <TableRow
          key={row.label}
          label={row.label}
          values={row.values}
          {...(row.highlightLowest && lowestIdx >= 0 ? { highlight: lowestIdx } : {})}
          labelWidth={labelWidth}
          colWidth={colWidth}
        />
      ))}
    </Box>
  );
}

/**
 * Ink-based comparison table for `daybook compare <year>`.
 *
 * Renders a styled table showing FIFO vs HIFO side by side
 * using Ink's Box and Text components. The method with the
 * lowest total taxable amount is highlighted in green + bold.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { MethodSummary } from '@daybook/tax';

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

/**
 * Format a decimal string as a USD value with two decimal places
 * and thousands separators.
 */
function formatUsd(value: string): string {
  const num = Number(value);
  const abs = Math.abs(num).toFixed(2);
  const [whole, frac] = abs.split('.');
  const withCommas = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const formatted = `$${withCommas}.${frac}`;
  return num < 0 ? `-${formatted}` : formatted;
}

// ─────────────────────────────────────────────────────────────────────────
// Row component
// ─────────────────────────────────────────────────────────────────────────

interface TableRowProps {
  label: string;
  values: string[];
  highlight?: number; // index of the value to highlight
  labelWidth: number;
  colWidth: number;
}

function TableRow({ label, values, highlight, labelWidth, colWidth }: TableRowProps): React.ReactElement {
  return (
    <Box>
      <Box width={labelWidth}>
        <Text>{label}</Text>
      </Box>
      <Text>│ </Text>
      {values.map((val, i) => (
        <Box key={i} width={colWidth}>
          {highlight === i ? (
            <Text bold color="green">{val}</Text>
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
 * Renders a comparison table using Ink Box/Text components.
 *
 * Shows: Metric | FIFO | HIFO with the lowest total taxable
 * method highlighted in green bold text.
 */
export function CompareTable({ summaries, lowestTaxMethod }: CompareTableProps): React.ReactElement {
  const byMethod = new Map<string, MethodSummary>();
  for (const s of summaries) {
    byMethod.set(s.method, s);
  }

  const fifo = byMethod.get('FIFO');
  const hifo = byMethod.get('HIFO');

  if (!fifo || !hifo) {
    return <Text color="red">Comparison requires both FIFO and HIFO results.</Text>;
  }

  const methods = ['FIFO', 'HIFO'] as const;
  const methodSummaries = [fifo, hifo];

  // Build rows: [label, fifoValue, hifoValue]
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

  // Find which column index to highlight for the "Total taxable" row
  const lowestIdx = methods.indexOf(lowestTaxMethod as typeof methods[number]);

  const divider = '─'.repeat(labelWidth - 1) + '┼' + '─'.repeat(colWidth * methods.length + 1);

  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1} paddingBottom={1}>
      <Text bold>Tax Method Comparison</Text>
      <Text> </Text>

      {/* Header */}
      <Box>
        <Box width={labelWidth}>
          <Text bold>Metric</Text>
        </Box>
        <Text>│ </Text>
        {methods.map(m => (
          <Box key={m} width={colWidth}>
            <Text bold>{m}</Text>
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

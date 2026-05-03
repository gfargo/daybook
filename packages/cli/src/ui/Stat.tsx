/**
 * `<Stat>` — single prominent statistic.
 *
 * Two lines: bold value on top, dim paper label below.
 * Used in summary blocks, never in tables.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { color, formatUsd } from './theme.js';

export interface StatProps {
  /** Label text (rendered below the value in dim paper). */
  label: string;
  /** Numeric value to display. */
  value: number;
  /** Format: 'usd' for dollar formatting, 'number' for plain commas (default: 'number'). */
  format?: 'usd' | 'number';
}

/** Prominent single statistic with bold value and dim label. */
export function Stat({ label, value, format = 'number' }: StatProps): React.ReactElement {
  const formatted = format === 'usd'
    ? formatUsd(value)
    : value.toLocaleString('en-US');

  return (
    <Box flexDirection="column">
      <Text bold>{formatted}</Text>
      <Text>{color.paper.dim(label)}</Text>
    </Box>
  );
}

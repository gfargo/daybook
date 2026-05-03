/**
 * `<Row>` — labelled line.
 *
 * The most-used component. A label + value pair, optionally with a
 * trailing note. Label width is shared across siblings for alignment.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { color, LAYOUT } from './theme.js';

export interface RowProps {
  /** Label text (rendered in paper color with trailing colon). */
  label: string;
  /** Value to display. Numbers are auto-formatted with commas. */
  value: React.ReactNode;
  /** Optional trailing note (rendered in dim paper). */
  note?: string;
  /** Override the default label width (default: 14 cells). */
  labelWidth?: number;
}

/** Labelled line with optional trailing note. */
export function Row({ label, value, note, labelWidth }: RowProps): React.ReactElement {
  const width = labelWidth ?? LAYOUT.defaultLabelWidth;

  // Auto-format numeric values with commas
  let displayValue: React.ReactNode = value;
  if (typeof value === 'number') {
    displayValue = value.toLocaleString('en-US');
  }

  return (
    <Box>
      <Box width={width}>
        <Text>{color.paper(`${label}:`)}</Text>
      </Box>
      <Text>{displayValue}</Text>
      {note != null && (
        <Box marginLeft={2}>
          <Text>{color.paper.dim(note)}</Text>
        </Box>
      )}
    </Box>
  );
}

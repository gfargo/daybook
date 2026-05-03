/**
 * `<Section>` — collapsible group of rows.
 *
 * Title in note color (no bold — Header carries that role).
 * Content indented 4 cells.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { color, LAYOUT } from './theme.js';

export interface SectionProps {
  /** Section title (rendered in note color). */
  title: string;
  children: React.ReactNode;
}

/** Named group of content with indented children. */
export function Section({ title, children }: SectionProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text>{color.note(title)}</Text>
      <Box flexDirection="column" paddingLeft={LAYOUT.indent}>
        {children}
      </Box>
    </Box>
  );
}

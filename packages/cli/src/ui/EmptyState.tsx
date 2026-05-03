/**
 * `<EmptyState>` — when there's nothing to show.
 *
 * Quiet, never alarming. Title in paper, hint in dim paper indented
 * 2 cells below.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { color, space } from './theme.js';

export interface EmptyStateProps {
  /** Title text (rendered in paper color). */
  title: string;
  /** Optional hint text (rendered in dim paper, indented). */
  hint?: string;
}

/** Empty state with optional recovery hint. */
export function EmptyState({ title, hint }: EmptyStateProps): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text>{color.paper(title)}</Text>
      {hint != null && (
        <Box paddingLeft={space[2]}>
          <Text>{color.paper.dim(hint)}</Text>
        </Box>
      )}
    </Box>
  );
}

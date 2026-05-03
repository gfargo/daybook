/**
 * `<ErrorBlock>` — graceful failure display.
 *
 * Three lines: title (loss color + error glyph), detail (paper, indented),
 * recovery hint (dim paper, further indented).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { color, glyph, space } from './theme.js';

export interface ErrorBlockProps {
  /** Error title (rendered in loss color with error glyph). */
  title: string;
  /** Optional detail text (rendered in paper, indented). */
  detail?: string;
  /** Optional recovery hint (rendered in dim paper, further indented). */
  recovery?: string;
}

/** Structured error display with title, detail, and recovery hint. */
export function ErrorBlock({ title, detail, recovery }: ErrorBlockProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text>{color.loss(`${glyph('error')}  ${title}`)}</Text>
      {detail != null && (
        <Box paddingLeft={space[2]}>
          <Text>{color.paper(detail)}</Text>
        </Box>
      )}
      {recovery != null && (
        <Box paddingLeft={space[4]}>
          <Text>{color.paper.dim(recovery)}</Text>
        </Box>
      )}
    </Box>
  );
}

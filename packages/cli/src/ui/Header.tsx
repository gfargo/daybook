/**
 * `<Header>` — section heading.
 *
 * Bold + note-color text on its own line, with breathing room above
 * (unless first in output) and below.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { color } from './theme.js';

export interface HeaderProps {
  children: React.ReactNode;
}

/** Section heading rendered in bold + note color. */
export function Header({ children }: HeaderProps): React.ReactElement {
  return (
    <Box marginTop={1} marginBottom={1}>
      <Text bold>{color.note(String(children))}</Text>
    </Box>
  );
}

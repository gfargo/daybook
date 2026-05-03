/**
 * `<Glyph>` — renders a single icon from the glyph registry.
 *
 * Handles Nerd Font → ASCII fallback automatically via the theme.
 */

import React from 'react';
import { Text } from 'ink';
import { color as palette, glyph as getGlyph, type GlyphName, type ColorToken } from './theme.js';

export interface GlyphProps {
  /** Glyph name from the registry. */
  name: GlyphName;
  /** Semantic color token (default: ink). */
  color?: ColorToken;
}

/** Single icon with optional color. */
export function Glyph({ name, color: colorToken }: GlyphProps): React.ReactElement {
  const str = getGlyph(name);
  if (colorToken && colorToken !== 'ink') {
    return <Text>{palette[colorToken](str)}</Text>;
  }
  return <Text>{str}</Text>;
}

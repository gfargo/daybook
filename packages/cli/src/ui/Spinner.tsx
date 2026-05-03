/**
 * `<Spinner>` — labelled in-progress state.
 *
 * Animated braille spinner followed by a label in paper color.
 * After resolution, the consumer replaces it with a `<Row>`.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { color, SPINNER_FRAMES, SPINNER_INTERVAL_MS } from './theme.js';

export interface SpinnerProps {
  /** Label text shown next to the spinner. */
  label: string;
}

/** Animated spinner with a label. */
export function Spinner({ label }: SpinnerProps): React.ReactElement {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrameIndex(prev => (prev + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const frame = SPINNER_FRAMES[frameIndex] ?? SPINNER_FRAMES[0]!;

  return (
    <Box>
      <Text>{color.note(frame)}</Text>
      <Text>  </Text>
      <Text>{color.paper(label)}</Text>
    </Box>
  );
}

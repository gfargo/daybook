/**
 * `<Table>` — generic tabular data display.
 *
 * Right-aligns numeric columns. Header row is bold + paper.
 * Body rows are ink. Emphasized rows pick up note color.
 * No grid lines — alignment alone carries the structure.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { color, formatUsd as fmtUsd } from './theme.js';

// ─── Types ───────────────────────────────────────────────────────────────

export interface TableColumn<T> {
  /** Key to read from each row object. */
  key: keyof T & string;
  /** Column header text. */
  header: string;
  /** Alignment (default: 'left'). */
  align?: 'left' | 'right';
  /** Format: 'usd' applies dollar formatting to numeric values. */
  format?: 'usd';
  /** Column width in cells (auto-calculated if omitted). */
  width?: number;
  /** Optional emphasis predicate — row picks up note color if true. */
  emphasis?: (row: T) => boolean;
}

export interface TableProps<T> {
  /** Column definitions. */
  columns: ReadonlyArray<TableColumn<T>>;
  /** Row data. */
  rows: ReadonlyArray<T>;
  /** Padding between columns (default: 2). */
  gap?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function formatCell<T>(row: T, col: TableColumn<T>): string {
  const raw = row[col.key];
  if (raw == null) return '';
  if (col.format === 'usd' && typeof raw === 'number') {
    return fmtUsd(raw);
  }
  if (col.format === 'usd' && typeof raw === 'string') {
    const num = Number(raw);
    return Number.isFinite(num) ? fmtUsd(num) : String(raw);
  }
  if (typeof raw === 'number') {
    return raw.toLocaleString('en-US');
  }
  return String(raw);
}

function computeWidths<T>(
  columns: ReadonlyArray<TableColumn<T>>,
  rows: ReadonlyArray<T>,
): number[] {
  return columns.map(col => {
    if (col.width != null) return col.width;
    const headerLen = col.header.length;
    const dataMax = rows.reduce((max, row) => {
      const cell = formatCell(row, col);
      return Math.max(max, cell.length);
    }, 0);
    return Math.max(headerLen, dataMax) + 2; // +2 for breathing room
  });
}

// ─── Component ───────────────────────────────────────────────────────────

/** Generic table with auto-alignment and optional emphasis. */
export function Table<T>({ columns, rows, gap = 2 }: TableProps<T>): React.ReactElement {
  const widths = computeWidths(columns, rows);

  return (
    <Box flexDirection="column">
      {/* Header row */}
      <Box>
        {columns.map((col, i) => (
          <Box
            key={col.key}
            width={widths[i]}
            justifyContent={col.align === 'right' ? 'flex-end' : 'flex-start'}
            marginRight={i < columns.length - 1 ? gap : 0}
          >
            <Text bold>{color.paper(col.header)}</Text>
          </Box>
        ))}
      </Box>

      {/* Data rows */}
      {rows.map((row, rowIdx) => (
        <Box key={rowIdx}>
          {columns.map((col, colIdx) => {
            const cell = formatCell(row, col);
            const emphasized = col.emphasis?.(row) ?? false;

            return (
              <Box
                key={col.key}
                width={widths[colIdx]}
                justifyContent={col.align === 'right' ? 'flex-end' : 'flex-start'}
                marginRight={colIdx < columns.length - 1 ? gap : 0}
              >
                {emphasized ? (
                  <Text>{color.note(cell)}</Text>
                ) : (
                  <Text>{cell}</Text>
                )}
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

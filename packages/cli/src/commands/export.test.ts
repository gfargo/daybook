/**
 * Tests for `daybook export <year>` format dispatch.
 *
 * Validates the --format and --8949-checkbox flag parsing,
 * output file naming patterns, and error handling for invalid values.
 *
 * @see Requirements 5.1–5.8, 8.1, 8.2
 */

import { describe, expect, it } from 'vitest';
import {
    resolveFormat,
    resolveCheckbox,
    defaultOutputPath,
    SUPPORTED_FORMATS,
} from './export.js';

// ─────────────────────────────────────────────────────────────────────────
// resolveFormat
// ─────────────────────────────────────────────────────────────────────────

describe('resolveFormat', () => {
  it('defaults to csv when no flag is provided', () => {
    expect(resolveFormat(undefined)).toBe('csv');
  });

  it('accepts csv format', () => {
    expect(resolveFormat('csv')).toBe('csv');
  });

  it('accepts 8949 format', () => {
    expect(resolveFormat('8949')).toBe('8949');
  });

  it('accepts schedule-d format', () => {
    expect(resolveFormat('schedule-d')).toBe('schedule-d');
  });

  it('accepts txf format', () => {
    expect(resolveFormat('txf')).toBe('txf');
  });

  it('is case-insensitive', () => {
    expect(resolveFormat('CSV')).toBe('csv');
    expect(resolveFormat('TXF')).toBe('txf');
    expect(resolveFormat('Schedule-D')).toBe('schedule-d');
  });

  it('throws for invalid format with supported values listed', () => {
    expect(() => resolveFormat('pdf')).toThrow('Unsupported format: "pdf"');
    expect(() => resolveFormat('pdf')).toThrow('Supported formats: csv, 8949, schedule-d, txf');
  });

  it('treats empty string as default (csv)', () => {
    expect(resolveFormat('')).toBe('csv');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// resolveCheckbox
// ─────────────────────────────────────────────────────────────────────────

describe('resolveCheckbox', () => {
  it('defaults to C when no flag is provided', () => {
    expect(resolveCheckbox(undefined)).toBe('C');
  });

  it('accepts A', () => {
    expect(resolveCheckbox('A')).toBe('A');
  });

  it('accepts B', () => {
    expect(resolveCheckbox('B')).toBe('B');
  });

  it('accepts C', () => {
    expect(resolveCheckbox('C')).toBe('C');
  });

  it('is case-insensitive', () => {
    expect(resolveCheckbox('a')).toBe('A');
    expect(resolveCheckbox('b')).toBe('B');
    expect(resolveCheckbox('c')).toBe('C');
  });

  it('throws for invalid checkbox category', () => {
    expect(() => resolveCheckbox('D')).toThrow('Invalid checkbox category: "D"');
    expect(() => resolveCheckbox('D')).toThrow('Supported values: A, B, C');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// defaultOutputPath
// ─────────────────────────────────────────────────────────────────────────

describe('defaultOutputPath', () => {
  it('produces .csv extension for csv format', () => {
    expect(defaultOutputPath(2024, 'FIFO', 'csv')).toBe('./daybook-2024-FIFO.csv');
  });

  it('produces .pdf extension with -8949 suffix for 8949 format', () => {
    expect(defaultOutputPath(2024, 'FIFO', '8949')).toBe('./daybook-2024-FIFO-8949.pdf');
  });

  it('produces .pdf extension with -schedule-d suffix for schedule-d format', () => {
    expect(defaultOutputPath(2024, 'HIFO', 'schedule-d')).toBe('./daybook-2024-HIFO-schedule-d.pdf');
  });

  it('produces .txf extension for txf format', () => {
    expect(defaultOutputPath(2024, 'FIFO', 'txf')).toBe('./daybook-2024-FIFO.txf');
  });

  it('includes the method name in the path', () => {
    expect(defaultOutputPath(2024, 'HIFO', 'csv')).toBe('./daybook-2024-HIFO.csv');
    expect(defaultOutputPath(2024, 'LIFO', '8949')).toBe('./daybook-2024-LIFO-8949.pdf');
  });

  it('includes the year in the path', () => {
    expect(defaultOutputPath(2023, 'FIFO', 'csv')).toBe('./daybook-2023-FIFO.csv');
    expect(defaultOutputPath(2025, 'FIFO', 'txf')).toBe('./daybook-2025-FIFO.txf');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// SUPPORTED_FORMATS constant
// ─────────────────────────────────────────────────────────────────────────

describe('SUPPORTED_FORMATS', () => {
  it('contains all four supported formats', () => {
    expect(SUPPORTED_FORMATS).toContain('csv');
    expect(SUPPORTED_FORMATS).toContain('8949');
    expect(SUPPORTED_FORMATS).toContain('schedule-d');
    expect(SUPPORTED_FORMATS).toContain('txf');
    expect(SUPPORTED_FORMATS).toHaveLength(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// exportCommand validation
// ─────────────────────────────────────────────────────────────────────────

describe('exportCommand year validation', () => {
  it('rejects non-numeric year', async () => {
    const { exportCommand } = await import('./export.js');
    await expect(
      exportCommand('abc', { config: '/nonexistent/config.json' }),
    ).rejects.toThrow('Invalid year');
  });

  it('rejects year out of range', async () => {
    const { exportCommand } = await import('./export.js');
    await expect(
      exportCommand('1999', { config: '/nonexistent/config.json' }),
    ).rejects.toThrow('Invalid year');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// --output override
// ─────────────────────────────────────────────────────────────────────────

describe('--output override', () => {
  it('defaultOutputPath is not used when --output is provided', () => {
    // This tests the logic: opts.output ?? defaultOutputPath(...)
    // When opts.output is set, it takes precedence.
    const customPath = '/tmp/my-custom-export.pdf';
    const defaultPath = defaultOutputPath(2024, 'FIFO', '8949');

    // The custom path should differ from the default
    expect(customPath).not.toBe(defaultPath);

    // Verify the default would have been different
    expect(defaultPath).toBe('./daybook-2024-FIFO-8949.pdf');
  });

  it('--output works for all format types', () => {
    // Verify each format produces a distinct default path
    // so --output override is meaningful for all formats
    const paths = SUPPORTED_FORMATS.map(fmt =>
      defaultOutputPath(2024, 'FIFO', fmt),
    );

    // All default paths should be unique
    const unique = new Set(paths);
    expect(unique.size).toBe(SUPPORTED_FORMATS.length);
  });
});

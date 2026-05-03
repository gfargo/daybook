/**
 * JSON output mode for read commands.
 *
 * When `--format=json` is passed, commands serialize their data
 * directly to stdout as a single valid JSON document. No colors,
 * no spinners, no Ink rendering.
 *
 * Decimal values serialize as strings to preserve precision.
 */

/**
 * Write a value as formatted JSON to stdout and return true.
 * Returns false if format is not 'json', so callers can use:
 *
 *   if (writeJson(opts.format, data)) return;
 *   // ... normal Ink rendering
 */
export function writeJson(format: string | undefined, data: unknown): boolean {
  if (format !== 'json') return false;
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  return true;
}

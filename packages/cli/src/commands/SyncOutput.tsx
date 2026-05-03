/**
 * Ink-based output for `daybook sync` results.
 *
 * Replaces the plain console.log output with themed rendering
 * using the shared UI component library.
 */

import React from 'react';
import { render, Box, Text } from 'ink';
import { color, glyph, Header, Row, Section, formatCount } from '../ui/index.js';

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export interface SyncResult {
  source: string;
  accountId: string;
  totalRows?: number;
  eventCount: number;
  inserted: number;
  skipped: number;
  unparsedRows?: number;
  warnings?: string[];
  /** Per-type counts from the DB after sync. */
  dbCounts?: Array<{ type: string; count: number }>;
}

export interface EvmSyncResult extends SyncResult {
  stats: {
    native: number;
    internal: number;
    erc20: number;
    erc721: number;
    erc1155: number;
    deduped: number;
  };
  failedGasCount?: number;
  fromBlock?: { blockNumber: bigint; date: string };
}

// ─────────────────────────────────────────────────────────────────────────
// CSV sync output (Coinbase / Kraken)
// ─────────────────────────────────────────────────────────────────────────

function CsvSyncOutput({ result }: { result: SyncResult }): React.ReactElement {
  const hasWarnings = (result.warnings?.length ?? 0) > 0;
  const statusGlyph = hasWarnings ? glyph('warning') : glyph('check');
  const statusColor = hasWarnings ? color.caution : color.gain;

  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1} paddingBottom={1}>
      <Header>{result.source} sync ({result.accountId})</Header>

      <Row label="CSV rows" value={result.totalRows ?? 0} labelWidth={18} />
      <Row label="Events parsed" value={result.eventCount} labelWidth={18} />
      <Row label="Inserted" value={result.inserted} labelWidth={18} />
      <Row label="Skipped" value={result.skipped} note="(already in DB)" labelWidth={18} />

      {(result.unparsedRows ?? 0) > 0 && (
        <Box marginTop={1}>
          <Text>{color.caution(`${glyph('warning')}  ${formatCount(result.unparsedRows!, 'unparsed row')}`)}</Text>
        </Box>
      )}

      {hasWarnings && (
        <Box flexDirection="column" marginTop={1}>
          <Text>{color.caution(`${glyph('warning')}  ${formatCount(result.warnings!.length, 'warning')}:`)}</Text>
          {result.warnings!.slice(0, 10).map((w, i) => (
            <Box key={i} paddingLeft={4}>
              <Text>{color.paper(`- ${w}`)}</Text>
            </Box>
          ))}
          {result.warnings!.length > 10 && (
            <Box paddingLeft={4}>
              <Text>{color.paper(`... and ${result.warnings!.length - 10} more`)}</Text>
            </Box>
          )}
        </Box>
      )}

      {result.dbCounts && result.dbCounts.length > 0 && (
        <Section title={`Events in DB for ${result.accountId}`}>
          {result.dbCounts.map(c => (
            <Row key={c.type} label={c.type} value={c.count} labelWidth={22} />
          ))}
        </Section>
      )}

      <Box marginTop={1}>
        <Text>{statusColor(`${statusGlyph}  Sync complete`)}</Text>
      </Box>
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// EVM sync output
// ─────────────────────────────────────────────────────────────────────────

function EvmSyncOutput({ result }: { result: EvmSyncResult }): React.ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1} paddingBottom={1}>
      <Header>EVM sync — {result.source} ({result.accountId})</Header>

      {result.fromBlock && (
        <Box marginBottom={1}>
          <Text>{color.paper(`Syncing from block ${result.fromBlock.blockNumber.toString()} (${result.fromBlock.date})`)}</Text>
        </Box>
      )}

      <Section title="Transfer categories">
        <Row label="Native" value={result.stats.native} labelWidth={18} />
        <Row label="Internal" value={result.stats.internal} labelWidth={18} />
        <Row label="ERC-20" value={result.stats.erc20} labelWidth={18} />
        <Row label="ERC-721" value={result.stats.erc721} note="(nft_event placeholders)" labelWidth={18} />
        <Row label="ERC-1155" value={result.stats.erc1155} labelWidth={18} />
        {result.stats.deduped > 0 && (
          <Row label="Deduped" value={result.stats.deduped} note="(duplicate transfers skipped)" labelWidth={18} />
        )}
      </Section>

      {result.failedGasCount !== undefined && result.failedGasCount > 0 && (
        <Row label="Failed-tx gas" value={result.failedGasCount} labelWidth={18} />
      )}

      <Box marginTop={1}>
        <Row label="Total" value={result.eventCount} labelWidth={18} />
        <Box marginLeft={2}>
          <Row label="Inserted" value={result.inserted} labelWidth={12} />
        </Box>
        <Box marginLeft={2}>
          <Row label="Skipped" value={result.skipped} labelWidth={12} />
        </Box>
      </Box>

      {result.dbCounts && result.dbCounts.length > 0 && (
        <Section title={`Events in DB for ${result.accountId}`}>
          {result.dbCounts.map(c => (
            <Row key={c.type} label={c.type} value={c.count} labelWidth={22} />
          ))}
        </Section>
      )}

      <Box marginTop={1}>
        <Text>{color.gain(`${glyph('check')}  Sync complete`)}</Text>
      </Box>
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Public render functions
// ─────────────────────────────────────────────────────────────────────────

/** Render CSV sync results (Coinbase / Kraken). */
export function renderCsvSyncOutput(result: SyncResult): void {
  render(<CsvSyncOutput result={result} />);
}

/** Render EVM sync results. */
export function renderEvmSyncOutput(result: EvmSyncResult): void {
  render(<EvmSyncOutput result={result} />);
}

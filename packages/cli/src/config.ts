/**
 * daybook config — loaded from `~/.daybook/config.json`.
 *
 * The config is the single source of truth for:
 *   - Which accounts the user has (mirrored into the DB on each sync).
 *   - DB and override-file paths.
 *   - Provider API key environment variable names (the values themselves
 *     stay in env vars; we never write secrets to disk).
 *
 * Any field can be missing — the loader fills in defaults. Validation is
 * via zod so a bad edit produces a useful error message rather than a
 * runtime crash deep in the call stack.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────

const SourceIdSchema = z.enum([
  'coinbase',
  'coinbase-advanced',
  'csv',
  'binance',
  'binance-us',
  'kraken',
  'robinhood',
  'eth',
  'polygon',
  'arbitrum',
  'base',
  'optimism',
  'solana',
  'bitcoin',
]);

const AccountConfigSchema = z.object({
  /** Stable id, e.g. 'main-coinbase'. Used as primary key in DB. */
  id: z.string().min(1),
  source: SourceIdSchema,
  /** Address for chains, account email/identifier for exchanges. */
  identifier: z.string().min(1),
  /** Optional display label. */
  label: z.string().optional(),
});

export type AccountConfig = z.infer<typeof AccountConfigSchema>;

const ProviderConfigSchema = z.object({
  /** Name of the env var holding the API key. We never store keys themselves. */
  apiKeyEnv: z.string().optional(),
  /** Optional override of the default endpoint. */
  endpoint: z.string().url().optional(),
});

const TaxConfigSchema = z.object({
  costBasisMethod: z.enum(['FIFO', 'LIFO', 'HIFO', 'SpecificID']).default('FIFO'),
  lotPool: z.enum(['universal', 'per-account']).default('universal'),
  feeAllocation: z
    .enum(['add-to-basis', 'subtract-from-proceeds'])
    .default('subtract-from-proceeds'),
});

export const ConfigSchema = z.object({
  /**
   * Where SQLite lives. Default: ~/.daybook/data.db. Tilde expansion is
   * applied at load time so callers receive an absolute path.
   */
  dbPath: z.string().default('~/.daybook/data.db'),
  accounts: z.array(AccountConfigSchema).default([]),
  tax: TaxConfigSchema.default({}),
  providers: z
    .object({
      alchemy: ProviderConfigSchema.optional(),
      coingecko: ProviderConfigSchema.optional(),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────────────────────────────────

/** Default config-file location. Override via $DAYBOOK_CONFIG. */
export function defaultConfigPath(): string {
  return process.env['DAYBOOK_CONFIG'] ?? join(homedir(), '.daybook', 'config.json');
}

/** Expand a leading `~` to the user's home directory. */
export function expandPath(path: string): string {
  if (path.startsWith('~/') || path === '~') {
    return path.replace(/^~/, homedir());
  }
  return path;
}

// ─────────────────────────────────────────────────────────────────────────
// Public API — load / save / init
// ─────────────────────────────────────────────────────────────────────────

export class ConfigError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Load the config from disk. Throws ConfigError on invalid JSON or schema. */
export function loadConfig(path: string = defaultConfigPath()): Config {
  if (!existsSync(path)) {
    throw new ConfigError(
      `No daybook config at ${path}. Run \`daybook init\` first.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new ConfigError(`Failed to parse config file ${path}: ${(err as Error).message}`, err);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid config at ${path}:\n${parsed.error.issues
        .map(i => `  • ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }
  // Expand all paths to absolute
  return {
    ...parsed.data,
    dbPath: expandPath(parsed.data.dbPath),
  };
}

/** Save a config to disk, creating the directory if needed. */
export function saveConfig(config: Config, path: string = defaultConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Create a default config at `path` if none exists.
 * Returns the config (existing or newly created).
 */
export function initConfig(path: string = defaultConfigPath()): Config {
  if (existsSync(path)) {
    return loadConfig(path);
  }
  const defaults = ConfigSchema.parse({});
  saveConfig(defaults, path);
  return { ...defaults, dbPath: expandPath(defaults.dbPath) };
}

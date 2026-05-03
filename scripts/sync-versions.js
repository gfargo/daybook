#!/usr/bin/env node

/**
 * Sync the release version into packages/cli/package.json and the
 * commander .version() call in packages/cli/src/index.ts.
 *
 * Called by release-it's after:bump hook:
 *   node scripts/sync-versions.js <version>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const version = process.argv[2];

if (!version) {
  console.error('Usage: node scripts/sync-versions.js <version>');
  process.exit(1);
}

// ─── 1. Sync packages/cli/package.json ──────────────────────────────
const cliPkgPath = resolve(__dirname, '..', 'packages', 'cli', 'package.json');
const cliPkg = JSON.parse(readFileSync(cliPkgPath, 'utf-8'));
cliPkg.version = version;
writeFileSync(cliPkgPath, JSON.stringify(cliPkg, null, 2) + '\n');
console.log(`  Updated packages/cli/package.json → ${version}`);

// ─── 2. Sync .version() in CLI entry point ──────────────────────────
const indexPath = resolve(__dirname, '..', 'packages', 'cli', 'src', 'index.ts');
let indexSrc = readFileSync(indexPath, 'utf-8');
indexSrc = indexSrc.replace(
  /\.version\(['"].*?['"]\)/,
  `.version('${version}')`,
);
writeFileSync(indexPath, indexSrc);
console.log(`  Updated packages/cli/src/index.ts .version() → ${version}`);

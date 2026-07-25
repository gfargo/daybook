#!/usr/bin/env node
/**
 * File the issues described in AUDIT-2026-07.md onto GitHub.
 *
 * Parses the audit document and creates one issue per `## <ID>. [SEVERITY] <Title>`
 * section, using the `<!-- labels: ... -->` marker that follows each heading.
 *
 * Requires the `gh` CLI, authenticated (`gh auth login`). No token is read from
 * this script or from the repo.
 *
 * Usage:
 *   node scripts/file-audit-issues.mjs --dry-run          # print what would be filed
 *   node scripts/file-audit-issues.mjs                    # file everything
 *   node scripts/file-audit-issues.mjs --only B1,B2,F1    # file a subset
 *   node scripts/file-audit-issues.mjs --skip-labels      # don't create/attach labels
 *
 * Safe to re-run: issues whose exact title already exists (open or closed) are
 * skipped rather than duplicated.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const AUDIT_PATH = resolve(REPO_ROOT, 'AUDIT-2026-07.md');
const AUDIT_DOC_LINK = 'AUDIT-2026-07.md';

// ─── Args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipLabels = args.includes('--skip-labels');
const onlyArg = args.find((a) => a.startsWith('--only'));
const only = onlyArg
  ? new Set(
      (onlyArg.includes('=')
        ? onlyArg.split('=')[1]
        : args[args.indexOf(onlyArg) + 1] ?? ''
      )
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  : null;

// ─── Label colours ───────────────────────────────────────────────────────

/** Label name -> { color, description }. Colors are hex without '#'. */
const LABEL_SPEC = {
  bug: { color: 'd73a4a', description: "Something isn't working" },
  enhancement: { color: 'a2eeef', description: 'New feature or request' },
  documentation: { color: '0075ca', description: 'Documentation improvements' },
  'tax-correctness': { color: 'b60205', description: 'Affects numbers on a filed tax form' },
  compliance: { color: '5319e7', description: 'IRS rules and regulatory requirements' },
  pricing: { color: '1d76db', description: 'USD price resolution' },
  adapter: { color: 'fbca04', description: 'Exchange or chain source adapter' },
  classifier: { color: 'c2e0c6', description: 'Event classification rule chain' },
  cli: { color: 'bfd4f2', description: 'Command-line interface' },
  config: { color: 'd4c5f9', description: 'Configuration handling' },
  sync: { color: 'fef2c0', description: 'Data ingestion and incremental sync' },
  testing: { color: '0e8a16', description: 'Test coverage and test infrastructure' },
  performance: { color: 'ff9f1c', description: 'Speed and resource usage' },
  security: { color: 'b60205', description: 'Security and credential handling' },
  architecture: { color: '5319e7', description: 'Structural and API design' },
  dx: { color: 'c5def5', description: 'Developer experience' },
  ci: { color: 'ededed', description: 'Continuous integration' },
  nft: { color: 'f9d0c4', description: 'NFT cost-basis handling' },
  'needs-sample': { color: 'e99695', description: 'Blocked on a real exchange export' },
};

// ─── Parse the audit document ────────────────────────────────────────────

/**
 * Extract issue sections from the audit markdown.
 *
 * A section starts at `## <ID>. [<SEVERITY>] <Title>` and runs until the next
 * `## ` or `# ` heading. The `<!-- labels: ... -->` line immediately following
 * the heading supplies labels and is stripped from the body.
 */
function parseIssues(markdown) {
  const lines = markdown.split('\n');
  const issues = [];
  let current = null;

  const headingRe = /^## ((?:B|F)\d+)\.\s+(?:\[([^\]]+)\]\s+)?(.+)$/;
  const labelsRe = /^<!--\s*labels:\s*(.+?)\s*-->$/;

  for (const line of lines) {
    const heading = headingRe.exec(line);
    if (heading) {
      if (current) issues.push(current);
      current = {
        id: heading[1],
        severity: heading[2] ?? null,
        title: heading[3].trim(),
        labels: [],
        bodyLines: [],
      };
      continue;
    }

    // Any other top-level or second-level heading ends the current section.
    if (current && /^#{1,2} /.test(line)) {
      issues.push(current);
      current = null;
      continue;
    }

    if (!current) continue;

    const labels = labelsRe.exec(line.trim());
    if (labels && current.labels.length === 0) {
      current.labels = labels[1].split(',').map((s) => s.trim()).filter(Boolean);
      continue;
    }

    current.bodyLines.push(line);
  }
  if (current) issues.push(current);

  return issues.map((i) => ({
    ...i,
    body: buildBody(i),
  }));
}

/** Assemble the final issue body, with a severity line and a provenance footer. */
function buildBody(issue) {
  const body = issue.bodyLines.join('\n').trim();
  const parts = [];

  if (issue.severity) {
    parts.push(`**Severity:** ${issue.severity}`, '');
  }
  parts.push(body);
  parts.push(
    '',
    '---',
    '',
    `<sub>Filed from the July 2026 post-v0.4.0 audit — see [\`${AUDIT_DOC_LINK}\`](${AUDIT_DOC_LINK}) ` +
      `(section \`${issue.id}\`) for the full report, audit method, and cross-references.</sub>`,
  );
  return parts.join('\n');
}

// ─── gh helpers ──────────────────────────────────────────────────────────

function gh(argv, opts = {}) {
  return execFileSync('gh', argv, {
    encoding: 'utf-8',
    stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

function assertGhReady() {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' });
  } catch {
    fail('`gh` CLI not found. Install it: https://cli.github.com/');
  }
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
  } catch {
    fail('`gh` is not authenticated. Run `gh auth login` first.');
  }
}

function currentRepo() {
  const out = gh(['repo', 'view', '--json', 'nameWithOwner']);
  return JSON.parse(out).nameWithOwner;
}

/** Titles of all existing issues, so re-runs don't duplicate. */
function existingTitles() {
  const out = gh([
    'issue', 'list',
    '--state', 'all',
    '--limit', '1000',
    '--json', 'title',
  ]);
  return new Set(JSON.parse(out).map((i) => i.title));
}

function ensureLabels(labels) {
  for (const name of labels) {
    const spec = LABEL_SPEC[name];
    const argv = ['label', 'create', name, '--force'];
    if (spec) argv.push('--color', spec.color, '--description', spec.description);
    try {
      gh(argv);
    } catch (err) {
      warn(`could not create label "${name}": ${oneLine(err)}`);
    }
  }
}

// ─── Output helpers ──────────────────────────────────────────────────────

const oneLine = (err) =>
  String(err?.stderr || err?.message || err).split('\n').filter(Boolean)[0] ?? 'unknown error';

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}
function warn(msg) {
  console.warn(`warning: ${msg}`);
}

// ─── Main ────────────────────────────────────────────────────────────────

function main() {
  let markdown;
  try {
    markdown = readFileSync(AUDIT_PATH, 'utf-8');
  } catch {
    fail(`could not read ${AUDIT_PATH}`);
  }

  let issues = parseIssues(markdown);
  if (issues.length === 0) fail('parsed 0 issues from the audit document');

  if (only) {
    issues = issues.filter((i) => only.has(i.id));
    if (issues.length === 0) fail(`--only matched no issues (${[...only].join(', ')})`);
  }

  const bugs = issues.filter((i) => i.id.startsWith('B')).length;
  const feats = issues.filter((i) => i.id.startsWith('F')).length;
  console.log(`Parsed ${issues.length} issues from ${AUDIT_DOC_LINK} (${bugs} bugs, ${feats} features)\n`);

  if (dryRun) {
    for (const i of issues) {
      const sev = i.severity ? `[${i.severity}] ` : '';
      console.log(`${i.id.padEnd(4)} ${sev}${i.title}`);
      console.log(`     labels: ${i.labels.join(', ') || '(none)'}`);
      console.log(`     body:   ${i.body.split('\n').length} lines, ${i.body.length} chars`);
    }
    const allLabels = [...new Set(issues.flatMap((i) => i.labels))].sort();
    console.log(`\nLabels that would be ensured: ${allLabels.join(', ')}`);
    console.log('\nDry run — nothing was filed. Re-run without --dry-run to file.');
    return;
  }

  assertGhReady();
  const repo = currentRepo();
  console.log(`Repository: ${repo}\n`);

  if (!skipLabels) {
    const allLabels = [...new Set(issues.flatMap((i) => i.labels))].sort();
    console.log(`Ensuring ${allLabels.length} labels...`);
    ensureLabels(allLabels);
  }

  const existing = existingTitles();
  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const issue of issues) {
    if (existing.has(issue.title)) {
      console.log(`  skip    ${issue.id.padEnd(4)} (title already exists) ${issue.title}`);
      skipped++;
      continue;
    }

    const argv = ['issue', 'create', '--title', issue.title, '--body', issue.body];
    for (const l of issue.labels) argv.push('--label', l);

    try {
      const out = gh(argv).trim();
      const url = out.split('\n').filter(Boolean).pop() ?? '(created)';
      console.log(`  created ${issue.id.padEnd(4)} ${url}`);
      created++;
    } catch (err) {
      console.error(`  FAILED  ${issue.id.padEnd(4)} ${issue.title}\n            ${oneLine(err)}`);
      failed++;
    }
  }

  console.log(`\nDone. created=${created} skipped=${skipped} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

main();

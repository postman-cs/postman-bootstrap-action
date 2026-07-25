#!/usr/bin/env node
/**
 * Automatic release cut.
 *
 * Owns the entire release transition in ONE node process: derive the next
 * version, bump manifests, rebuild dist, revalidate the multifile receipt
 * binding, run the declared gate set, commit, and only then create the tag.
 *
 * Two invariants this file exists to enforce, both learned from the burnt
 * v2.10.26 cut:
 *
 * 1. Every git sha is read in-process via `git rev-parse`. No sha is ever
 *    routed through a shell variable, so an unexported variable can never
 *    write `bootstrapCommit: undefined` into the receipt again.
 * 2. The tag is the LAST side effect, created only after the exact bytes of
 *    the release commit pass validation. A failed cut leaves no tag behind.
 *
 * Already-taken tags are treated as burnt and skipped, so a previously failed
 * version number is never reused (release tags are immutable by policy).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertMultifileSpecSyncReceiptSourceBinding,
  validateMultifileSpecSyncReceipt
} from './probe-multifile-spec-sync.mjs';
import { planMultifileReceiptRebind } from '../.github/scripts/rebind-multifile-receipt.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const RECEIPT_PATH = path.join(REPO_ROOT, 'validation/evidence/multifile-spec-sync.json');
const PKG_PATH = path.join(REPO_ROOT, 'package.json');
const LOCK_PATH = path.join(REPO_ROOT, 'package-lock.json');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Conventional-commit subjects that carry no shippable behavior on their own. */
const NON_SHIPPING_TYPES = new Set(['chore', 'ci', 'build', 'test', 'style']);

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', options.quiet ? 'ignore' : 'pipe']
  }).trim();
}

function run(command, args) {
  execFileSync(command, args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'inherit' });
}

/**
 * Classify a conventional-commit body into a semver bump.
 * @param {string[]} messages full commit messages (subject + body)
 * @returns {'major'|'minor'|'patch'|null} null when nothing shippable landed
 */
export function parseConventionalBump(messages) {
  const entries = (Array.isArray(messages) ? messages : []).filter(
    (message) => typeof message === 'string' && message.trim()
  );
  if (entries.length === 0) return null;

  let bump = null;
  const rank = { patch: 1, minor: 2, major: 3 };
  const raise = (next) => {
    if (!bump || rank[next] > rank[bump]) bump = next;
  };

  for (const message of entries) {
    const subject = message.split('\n', 1)[0];
    const header = /^([a-zA-Z]+)(\([^)]*\))?(!)?:/.exec(subject);
    const type = header ? header[1].toLowerCase() : '';
    const breaking = Boolean(header && header[3]) || /^BREAKING[ -]CHANGE:/m.test(message);

    if (breaking) {
      raise('major');
      continue;
    }
    if (type === 'feat') {
      raise('minor');
      continue;
    }
    if (header && NON_SHIPPING_TYPES.has(type)) continue;
    // fix, perf, refactor, revert, docs, and untyped commits all ship as a patch.
    raise('patch');
  }
  return bump;
}

/**
 * @param {string} version
 * @param {'major'|'minor'|'patch'} bump
 */
export function applyBump(version, bump) {
  const parsed = SEMVER.exec(String(version || ''));
  if (!parsed) throw new Error(`current version ${version} is not plain semver`);
  const [major, minor, patch] = parsed.slice(1).map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unsupported bump ${bump}`);
}

/**
 * Pick the next free version. Any tag that already exists is burnt: release
 * tags are immutable, so a previously failed cut (v2.10.26) is skipped rather
 * than reused, which is what lets a failed release heal on the next merge.
 *
 * @param {{current: string, bump: 'major'|'minor'|'patch', takenTags: Iterable<string>}} input
 */
export function selectNextVersion({ current, bump, takenTags }) {
  const taken = new Set(Array.from(takenTags || [], (tag) => String(tag).replace(/^v/, '')));
  let candidate = applyBump(current, bump);
  const skipped = [];
  // Only the patch axis can advance while skipping; a taken major/minor target
  // still resolves forward on patch so the release train never stalls.
  while (taken.has(candidate)) {
    skipped.push(candidate);
    candidate = applyBump(candidate, 'patch');
    if (skipped.length > 256) throw new Error('exhausted patch space searching for a free release version');
  }
  return { version: candidate, skipped };
}

/**
 * Set the version in package.json and package-lock.json without reformatting
 * either file.
 * @param {string} version
 */
export function writeVersion(version) {
  if (!SEMVER.test(version)) throw new Error(`refusing to write non-semver version ${version}`);

  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  pkg.version = version;
  writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`);

  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  lock.version = version;
  if (lock.packages && lock.packages['']) lock.packages[''].version = version;
  writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
}

/**
 * Assert the committed receipt is schema-valid and still bound to the source
 * it was probed against. This is the exact check whose absence let a receipt
 * carrying `bootstrapCommit: undefined` reach an immutable tag.
 *
 * @param {{headCommit: string}} options
 */
export function assertReceiptIntegrity({ headCommit }) {
  const receipt = JSON.parse(readFileSync(RECEIPT_PATH, 'utf8'));
  validateMultifileSpecSyncReceipt(receipt);
  assertMultifileSpecSyncReceiptSourceBinding(receipt, { headCommit, repoRoot: REPO_ROOT });
  return receipt;
}

/**
 * Rebind the receipt onto `headCommit` when behavior-bearing source moved
 * under it.
 *
 * ci.yml normalizes the receipt on every pull request, but a commit that
 * reaches main any other way never gets that pass and would leave the release
 * train permanently stuck on a stale receipt. This applies the identical
 * planner so the release path is self-sufficient however a commit arrived.
 *
 * The planner fails closed: it requires ancestry and refuses any rebind that
 * would alter a live evidence field, so this can only restate which source
 * revision the unchanged evidence covers.
 *
 * @param {{headCommit: string}} options
 * @returns {boolean} whether the receipt was rewritten
 */
export function normalizeReceipt({ headCommit }) {
  const receipt = JSON.parse(readFileSync(RECEIPT_PATH, 'utf8'));
  const plan = planMultifileReceiptRebind(receipt, {
    headCommit,
    isAncestor: (ancestor, descendant) => {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
          cwd: REPO_ROOT,
          stdio: 'ignore'
        });
        return true;
      } catch {
        return false;
      }
    },
    changedPaths: git(['diff', '--name-only', `${receipt.bootstrapCommit}..${headCommit}`])
      .split('\n')
      .filter(Boolean)
  });
  if (!plan.updated) return false;
  writeFileSync(RECEIPT_PATH, `${JSON.stringify(plan.receipt, null, 2)}\n`);
  return true;
}

/**
 * Rebuild dist from source. The receipt is imported by
 * src/lib/postman/spec-file-reconcile.ts, so normalizing the receipt changes
 * dist; the rebuild is what keeps the bundle and the receipt in step.
 */
export function rebuildDist() {
  run('npm', ['run', 'bundle']);
}

/**
 * Prove the committed dist matches a fresh rebuild.
 *
 * verify:dist:assert diffs the working tree against committed dist, so it is
 * only meaningful AFTER the release commit exists. Running it before the
 * commit would flag the intended version and receipt updates as drift.
 */
export function assertCommittedDistMatchesSource() {
  run('npm', ['run', 'verify:dist']);
}

function assertCleanTree() {
  const dirty = git(['status', '--porcelain']);
  if (dirty) throw new Error(`refusing to cut a release from a dirty tree:\n${dirty}`);
}

function allTags() {
  const local = git(['tag', '--list', 'v*']).split('\n').filter(Boolean);
  let remote;
  try {
    remote = git(['ls-remote', '--tags', 'origin'])
      .split('\n')
      .map((line) => line.split('\t')[1] || '')
      .map((ref) => ref.replace('refs/tags/', '').replace(/\^\{\}$/, ''))
      .filter((tag) => tag.startsWith('v'));
  } catch {
    throw new Error('could not list remote tags; refusing to cut a release blind to burnt versions');
  }
  return new Set([...local, ...remote]);
}

function commitsSince(tag) {
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  const raw = git(['log', range, '--no-merges', '--format=%B%x00']);
  return raw.split('\u0000').map((entry) => entry.trim()).filter(Boolean);
}

function latestReleaseTag(taken) {
  const versions = Array.from(taken)
    .map((tag) => tag.replace(/^v/, ''))
    .filter((version) => SEMVER.test(version))
    .sort((a, b) => {
      const left = a.split('.').map(Number);
      const right = b.split('.').map(Number);
      for (let i = 0; i < 3; i += 1) {
        if (left[i] !== right[i]) return left[i] - right[i];
      }
      return 0;
    });
  const newest = versions[versions.length - 1];
  return newest ? `v${newest}` : null;
}

/**
 * Decide whether a release is due and which version it takes.
 * Pure enough to run in --plan mode on any checkout.
 */
export function planRelease() {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  const taken = allTags();
  const previous = latestReleaseTag(taken);
  const messages = commitsSince(previous);
  const bump = parseConventionalBump(messages);

  if (!bump) {
    return { release: false, reason: 'no shippable commits since the last release tag', previous };
  }

  // The release train advances from the highest tag ever cut, not from
  // package.json, so a burnt cut that already bumped the manifest cannot
  // rewind or duplicate a version.
  const base = previous ? previous.replace(/^v/, '') : pkg.version;
  const { version, skipped } = selectNextVersion({ current: base, bump, takenTags: taken });
  return { release: true, previous, bump, version, skipped, commits: messages.length };
}

function executeRelease(plan) {
  assertCleanTree();

  // Bind and verify against the commit the release is cut from. The release
  // commit itself only touches release-only drift paths (package.json,
  // package-lock.json, dist/, validation/evidence/), so this binding stays
  // valid across the commit that follows.
  const sourceCommit = git(['rev-parse', 'HEAD']);
  normalizeReceipt({ headCommit: sourceCommit });
  assertReceiptIntegrity({ headCommit: sourceCommit });

  writeVersion(plan.version);
  rebuildDist();

  run('npm', ['run', 'typecheck']);
  run('npm', ['run', 'lint']);
  run('npm', ['test']);

  run('git', ['add', 'package.json', 'package-lock.json', 'dist', 'validation/evidence']);
  const staged = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  const offenders = staged.filter(
    (file) =>
      !['package.json', 'package-lock.json'].includes(file) &&
      !file.startsWith('dist/') &&
      !file.startsWith('validation/evidence/')
  );
  if (offenders.length > 0) {
    throw new Error(`release commit touched non-release paths: ${offenders.join(', ')}`);
  }

  run('git', ['commit', '-m', `chore(release): v${plan.version}`]);

  // Re-verify the exact bytes that the tag will point at. Everything above
  // ran against the working tree; this runs against the committed release.
  const releaseCommit = git(['rev-parse', 'HEAD']);
  assertReceiptIntegrity({ headCommit: releaseCommit });
  assertCommittedDistMatchesSource();

  const committedVersion = JSON.parse(
    git(['show', `${releaseCommit}:package.json`])
  ).version;
  if (committedVersion !== plan.version) {
    throw new Error(
      `committed version ${committedVersion} does not match planned ${plan.version}`
    );
  }

  // Tag last: nothing above this line creates a public identifier, so a
  // failure at any point leaves the version number unburnt.
  run('git', ['tag', '-a', `v${plan.version}`, '-m', `v${plan.version}`, releaseCommit]);
  return { version: plan.version, releaseCommit, sourceCommit };
}

function main() {
  const mode = process.argv[2] || '--plan';
  if (!['--plan', '--execute'].includes(mode)) {
    throw new Error('Usage: node scripts/release-cut.mjs --plan|--execute');
  }

  const plan = planRelease();
  if (!plan.release) {
    process.stdout.write(`${JSON.stringify({ ...plan, mode }, null, 2)}\n`);
    return;
  }

  if (mode === '--plan') {
    process.stdout.write(`${JSON.stringify({ ...plan, mode }, null, 2)}\n`);
    return;
  }

  const result = executeRelease(plan);
  process.stdout.write(`${JSON.stringify({ ...plan, ...result, mode }, null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

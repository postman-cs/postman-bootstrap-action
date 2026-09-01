#!/usr/bin/env node
// Fails when documentation or shipped templates reference a suite action at a
// rolling alias that is not that action's newest published major, or at an
// immutable tag that does not exist. README input/output tables have their own
// renderer gate; this covers the `uses:` pins those tables do not.
//
// Scans README.md, AGENTS.md, RELEASE_POLICY.md, SUPPORT.md, SECURITY.md,
// docs/**, templates/**, and .postman-template/** for
// `postman-cs/<action>@vN[.M.K]`. Tag truth comes from `git ls-remote --tags`
// against each referenced repository, so the check needs network access and
// no local tag fetch.
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const SCAN_ROOTS = [
  'README.md',
  'AGENTS.md',
  'RELEASE_POLICY.md',
  'SUPPORT.md',
  'SECURITY.md',
  'docs',
  'templates',
  '.postman-template'
];
const SCAN_EXTENSIONS = new Set(['.md', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git']);
const PIN = /postman-cs\/(postman-[a-z0-9-]+?(?:-action|-tdd))@v(\d+)(?:\.(\d+)\.(\d+))?\b/g;
const TAG = /refs\/tags\/v(\d+)\.(\d+)\.(\d+)$/;

function collectFiles(target, out) {
  let stats;
  try {
    stats = statSync(target);
  } catch {
    return;
  }
  if (stats.isFile()) {
    if (SCAN_EXTENSIONS.has(extname(target))) out.push(target);
    return;
  }
  for (const entry of readdirSync(target)) {
    if (SKIP_DIRS.has(entry)) continue;
    collectFiles(join(target, entry), out);
  }
}

const tagCache = new Map();
function publishedTags(repo) {
  if (!tagCache.has(repo)) {
    const url = `https://github.com/postman-cs/${repo}.git`;
    let output;
    try {
      output = execFileSync('git', ['ls-remote', '--tags', '--refs', url], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000
      });
    } catch (error) {
      throw new Error(
        `could not list tags for ${url}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    const versions = new Set();
    let topMajor = -1;
    for (const line of output.split('\n')) {
      const match = TAG.exec(line.trim());
      if (!match) continue;
      versions.add(`${match[1]}.${match[2]}.${match[3]}`);
      topMajor = Math.max(topMajor, Number(match[1]));
    }
    tagCache.set(repo, { versions, topMajor });
  }
  return tagCache.get(repo);
}

function findStalePins(files) {
  const failures = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const match of line.matchAll(PIN)) {
        const [, repo, major, minor, patch] = match;
        const where = `${relative(ROOT, file)}:${index + 1}`;
        const { versions, topMajor } = publishedTags(repo);
        if (topMajor < 0) {
          failures.push(`${where}: ${match[0]} references a repository with no vN.M.K tags`);
          continue;
        }
        if (minor === undefined) {
          if (Number(major) !== topMajor) {
            failures.push(`${where}: ${match[0]} is a rolling alias but the current major is v${topMajor}`);
          }
          continue;
        }
        if (!versions.has(`${major}.${minor}.${patch}`)) {
          failures.push(`${where}: ${match[0]} names a tag that is not published`);
        }
      }
    });
  }
  return failures;
}

const files = [];
for (const target of SCAN_ROOTS) collectFiles(join(ROOT, target), files);
const failures = findStalePins(files);
if (failures.length > 0) {
  console.error('Stale documentation pins:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`docs pins current across ${files.length} file(s)`);

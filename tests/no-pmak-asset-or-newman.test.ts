import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ACTION_ROOT = resolve(import.meta.dirname, '..');
const SRC_ROOT = join(ACTION_ROOT, 'src');

type PatternId = 'newman' | 'pmak-header' | 'pmak-cli-login';

/**
 * Sanctioned PMAK / Postman-CLI sites. PMAK survives ONLY for:
 *   1. minting/re-minting the service-account access token (token-provider mint POST),
 *   2. Insights linking (akita rejects service accounts — insights action only),
 *   3. `postman login --with-api-key` (the Postman CLI has no access-token login),
 * plus the user-approved read-only `GET /me` identity preflight (credential-identity)
 * and repo-sync's CI-key reuse-vs-mint /me check. Every Postman ASSET op runs on the
 * access-token gateway; a new `x-api-key:` header or `--with-api-key` outside this list
 * is a forbidden PMAK asset op. Newman is banned everywhere (never allowlisted): it
 * cannot run Collection v3, so only the Postman CLI (`postman collection run`) is allowed.
 */
const ALLOWLIST: Record<string, PatternId[]> = {
  'src/index.ts': ['pmak-cli-login'],
  'src/lib/postman/credential-identity.ts': ['pmak-header'],
  'src/lib/postman/token-provider.ts': ['pmak-header']
};

type Violation = { file: string; line: number; pattern: PatternId; text: string };

function walkTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      return walkTypeScriptFiles(abs);
    }
    return abs.endsWith('.ts') ? [abs] : [];
  });
}

/** Remove // and block comments without touching string/template contents. */
function stripComments(source: string): string {
  let result = '';
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') {
        i += 1;
      }
      result += '\n';
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        i += 1;
      }
      i += 2;
      result += '\n';
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      result += ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          result += source[i] + source[i + 1];
          i += 2;
          continue;
        }
        if (source[i] === ch) {
          result += source[i];
          i += 1;
          break;
        }
        result += source[i];
        i += 1;
      }
      continue;
    }

    result += ch;
    i += 1;
  }

  return result;
}

function matchPatterns(line: string): PatternId[] {
  const hits: PatternId[] = [];
  if (/['"]newman['"]|\bnewman\s+run\b|\bnewman\s*\.\s*run\b/i.test(line)) {
    hits.push('newman');
  }
  if (/['"]x-api-key['"]\s*:/i.test(line)) {
    hits.push('pmak-header');
  }
  if (/--with-api-key/.test(line)) {
    hits.push('pmak-cli-login');
  }
  return hits;
}

function scanSourceFile(absPath: string): Violation[] {
  const relPath = relative(ACTION_ROOT, absPath).replace(/\\/g, '/');
  const stripped = stripComments(readFileSync(absPath, 'utf8'));
  const hits: Violation[] = [];
  stripped.split('\n').forEach((line, index) => {
    for (const pattern of matchPatterns(line)) {
      hits.push({ file: relPath, line: index + 1, pattern, text: line.trim() });
    }
  });
  return hits;
}

function isSanctioned(v: Violation): boolean {
  // Newman is never allowlisted; x-api-key / --with-api-key only in the sanctioned files.
  return v.pattern !== 'newman' && (ALLOWLIST[v.file]?.includes(v.pattern) ?? false);
}

function format(vs: Violation[]): string {
  return vs.map((v) => `${v.file}:${v.line}: ${v.pattern} — ${v.text}`).join('\n');
}

describe('no PMAK asset op or Newman in production src/', () => {
  const allHits = walkTypeScriptFiles(SRC_ROOT).flatMap(scanSourceFile);

  it('has no un-sanctioned x-api-key / --with-api-key, and no Newman anywhere', () => {
    const violations = allHits.filter((v) => !isSanctioned(v));
    expect(violations, format(violations)).toEqual([]);
  });

  it('has no stale allowlist entries (every sanctioned site still exists)', () => {
    const stale: string[] = [];
    for (const [file, patterns] of Object.entries(ALLOWLIST)) {
      for (const pattern of patterns) {
        if (!allHits.some((v) => v.file === file && v.pattern === pattern)) {
          stale.push(`${file}: ${pattern}`);
        }
      }
    }
    expect(stale, `stale allowlist entries:\n${stale.join('\n')}`).toEqual([]);
  });

  it('declares no Newman dependency in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(ACTION_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const newmanDeps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {})
    ].filter((name) => /(^|[/@-])newman([/-]|$)/i.test(name));
    expect(newmanDeps, `Newman dependencies: ${newmanDeps.join(', ')}`).toEqual([]);
  });
});

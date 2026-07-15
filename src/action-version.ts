import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Embedded at SEA build time via esbuild --define (scripts/build-sea.sh); the
// standalone binary ships no package.json. The main bundle defines this as a
// constant undefined, so the guard below is inert there — the committed dist
// does not vary with the version (no per-bump churn), preserving the original
// intent of resolving the version without baking it into dist.
declare const __SEA_VERSION__: string | undefined;

// Resolve this action's version. Prefer the SEA-embedded constant; otherwise
// read the packaged package.json at runtime (GitHub Action / npm paths).
export function resolveActionVersion(): string {
  if (typeof __SEA_VERSION__ === 'string' && __SEA_VERSION__) {
    return __SEA_VERSION__;
  }
  try {
    const raw = readFileSync(join(__dirname, '..', 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

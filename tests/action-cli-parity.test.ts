import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..');

/**
 * P3 drift gate (.plans/e2e-suite-tuneup.md): the CLI maintains a hard-coded
 * input-name array (cliInputNames) separate from action.yml. Assert the two
 * stay equal so a new action input cannot ship without its CLI flag (and vice
 * versa), minus the explicit CLI-only allowlist below.
 */

// repo-url: read by src/index.ts via optionalInput but deliberately not
// declared in action.yml -- on the runner the repo URL is auto-detected from
// the GitHub context; the CLI needs a flag for detached (non-runner) runs.
const CLI_ONLY_INPUTS = ['repo-url'];

function actionManifestInputs(): string[] {
  const manifest = parse(readFileSync(resolve(repoRoot, 'action.yml'), 'utf8')) as {
    inputs?: Record<string, unknown>;
  };
  return Object.keys(manifest.inputs ?? {});
}

function cliInputNames(): string[] {
  const source = readFileSync(resolve(repoRoot, 'src/cli.ts'), 'utf8');
  const match = source.match(/const cliInputNames = \[([^\]]*)\]/);
  if (!match) throw new Error('cliInputNames array not found in src/cli.ts');
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

describe('action.yml <-> CLI flag parity', () => {
  it('every action.yml input has a CLI flag', () => {
    const cli = new Set(cliInputNames());
    const missing = actionManifestInputs().filter((name) => !cli.has(name));
    expect(missing).toEqual([]);
  });

  it('every CLI input flag is an action.yml input, minus the explicit CLI-only allowlist', () => {
    const manifest = new Set(actionManifestInputs());
    const extras = cliInputNames().filter(
      (name) => !manifest.has(name) && !CLI_ONLY_INPUTS.includes(name)
    );
    expect(extras).toEqual([]);
  });

  it('keeps the CLI-only allowlist minimal: every entry is a real CLI flag and not a manifest input', () => {
    const cli = new Set(cliInputNames());
    const manifest = new Set(actionManifestInputs());
    expect(CLI_ONLY_INPUTS.filter((name) => !cli.has(name))).toEqual([]);
    expect(CLI_ONLY_INPUTS.filter((name) => manifest.has(name))).toEqual([]);
  });
});

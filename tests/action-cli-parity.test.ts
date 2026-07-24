import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { readActionInputs } from '../src/index.js';

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
/**
 * Runner-vs-CLI input bridge (LANE 5).
 *
 * On a GitHub runner the Actions toolkit reads `INPUT_<NAME>` with ONLY spaces
 * replaced by underscores, so a kebab-case input arrives as a hyphenated env
 * var (`INPUT_PROTOCOL-ENDPOINT-URL`). This package's own `getInput` helper
 * instead maps `-` to `_` (`INPUT_PROTOCOL_ENDPOINT_URL`) because the CLI
 * synthesizes that shape from its flags. `readActionInputs` is the ONLY bridge
 * between the two spellings: every action.yml input must be read through
 * `actionCore.getInput` and handed to `resolveInputs` under the underscore key.
 *
 * An input missing from that bridge is silently empty on the Action while
 * working on the CLI -- exactly the "Action and CLI disagree" failure mode.
 */
describe('action.yml -> readActionInputs runner bridge', () => {
  function readActionInputsBody(): string {
    const source = readFileSync(resolve(repoRoot, 'src/index.ts'), 'utf8');
    const start = source.indexOf('export function readActionInputs');
    if (start === -1) throw new Error('readActionInputs not found in src/index.ts');
    const end = source.indexOf('\nfunction createWorkspaceName', start);
    if (end === -1) throw new Error('readActionInputs end boundary not found in src/index.ts');
    return source.slice(start, end);
  }

  function underscoreEnvKey(name: string): string {
    return `INPUT_${name.replace(/-/g, '_').toUpperCase()}`;
  }

  it('explicitly wires every action.yml input into resolveInputs', () => {
    const body = readActionInputsBody();
    const wired = new Set(
      [...body.matchAll(/^\s{4}(INPUT_[A-Z0-9_]+):/gm)].map((entry) => entry[1])
    );
    const unwired = actionManifestInputs().filter((name) => !wired.has(underscoreEnvKey(name)));
    expect(unwired).toEqual([]);
  });
});

describe('runner input semantics', () => {
  /**
   * Byte-exact @actions/core getInput: `INPUT_` + name with spaces (not
   * hyphens) replaced by underscores, uppercased. See
   * node_modules/@actions/core/lib/core.js.
   */
  function createRunnerCore(runnerEnv: Record<string, string>) {
    return {
      getInput(name: string, options?: { required?: boolean }): string {
        const value = runnerEnv[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] || '';
        if (options?.required && !value) {
          throw new Error(`Input required and not supplied: ${name}`);
        }
        return value.trim();
      },
      setSecret(): void {}
    };
  }

  it('resolves protocol-endpoint-url from the hyphenated runner env var', () => {
    const core = createRunnerCore({
      'INPUT_PROJECT-NAME': 'payments-grpc',
      'INPUT_SPEC-PATH': 'apis/payments/payments.proto',
      'INPUT_PROTOCOL': 'grpc',
      'INPUT_PROTOCOL-ENDPOINT-URL': 'grpc://payments.internal.test:443'
    });

    const inputs = readActionInputs(core);

    expect(inputs.protocol).toBe('grpc');
    expect(inputs.protocolEndpointUrl).toBe('grpc://payments.internal.test:443');
  });

  it('never reads a hyphenated runner input through the underscore CLI spelling', () => {
    // The runner never sets the underscore form. If readActionInputs leaned on
    // the ambient process.env spread instead of core.getInput, this would leak.
    const core = createRunnerCore({
      'INPUT_PROJECT-NAME': 'payments-graphql',
      'INPUT_SPEC-PATH': 'apis/payments/schema.graphql',
      'INPUT_PROTOCOL': 'graphql'
    });

    expect(readActionInputs(core).protocolEndpointUrl).toBeUndefined();
  });
});

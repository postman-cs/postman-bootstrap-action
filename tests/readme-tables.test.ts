import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain Node script without type declarations
import { renderReadme } from '../scripts/render-action-tables.mjs';

const repoRoot = resolve(import.meta.dirname, '..');

describe('README action tables', () => {
  it('keeps the Inputs and Outputs tables in sync with action.yml', () => {
    const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
    const actionYaml = readFileSync(resolve(repoRoot, 'action.yml'), 'utf8');
    expect(readme).toContain('<!-- inputs-table:start -->');
    expect(readme).toContain('<!-- outputs-table:start -->');
    expect(renderReadme(readme, actionYaml)).toBe(readme);
  });
});

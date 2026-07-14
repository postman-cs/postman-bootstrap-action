import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const liveE2eWorkflow = readFileSync(join(process.cwd(), '.github/workflows/live-e2e.yml'), 'utf8');

describe('live e2e workflow path filter', () => {
  it('limits PR triggers to src/dist/action.yml/package manifests/fixtures', () => {
    expect(liveE2eWorkflow).toMatch(/pull_request:\n(?: {4}.+\n)* {4}paths:/);

    const pathsBlock = liveE2eWorkflow.match(/pull_request:\n(?: {4}.+\n)* {4}paths:\n((?: {6}-.+\n)+)/)?.[1] ?? '';
    const paths = pathsBlock
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).replace(/^['"]|['"]$/g, ''));

    expect(paths).toEqual(['src/**', 'dist/**', 'action.yml', 'package*.json', 'fixtures/**']);
  });
});

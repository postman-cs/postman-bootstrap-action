import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Cassette } from '@postman-cse/automation-core/cassette';
import { describe, expect, it } from 'vitest';

import { assertCassetteRedacted } from '../../scripts/sanitize-cassette.js';

const COMMITTED_CASSETTES = resolve('tests/contract/cassettes');

describe('contract: committed cassette redaction invariant', () => {
  it('rejects secret-shaped or live-identity content in every committed cassette', () => {
    const cassetteFiles = readdirSync(COMMITTED_CASSETTES)
      .filter((name) => name.endsWith('.json'))
      .sort();

    expect(cassetteFiles.length).toBeGreaterThan(0);
    for (const name of cassetteFiles) {
      const cassette = JSON.parse(
        readFileSync(resolve(COMMITTED_CASSETTES, name), 'utf8')
      ) as Cassette;
      expect(() => assertCassetteRedacted(cassette), name).not.toThrow();
    }
  });
});

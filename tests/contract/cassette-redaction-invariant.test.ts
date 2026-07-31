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

    // Additions require explicit redaction and behavioral replay classification.
    expect(cassetteFiles).toEqual([
      'branch-preview.json',
      'fresh-onboard.json',
      'large-spec.json',
      'multifile-openapi.json',
      'non-org-visibility-flip.json',
      'org-mode.json',
      'protobuf-grpc.json',
      'refresh-deep-update.json'
    ]);
    for (const name of cassetteFiles) {
      const cassette = JSON.parse(
        readFileSync(resolve(COMMITTED_CASSETTES, name), 'utf8')
      ) as Cassette;
      expect(() => assertCassetteRedacted(cassette), name).not.toThrow();
    }
  });

  it('rejects raw capture material before it can enter a committed cassette', () => {
    const poisoned = {
      version: 2 as const,
      interactions: [{
        key: 'POST https://api.getpostman.com/collections #body-sha256=0000000000000000000000000000000000000000000000000000000000000000',
        requestQuery: '',
        requestBodySha256: '0000000000000000000000000000000000000000000000000000000000000000',
        rawRequestBody: '{"id":"12345678-1234-4234-8234-123456789abc","email":"operator@example.com","apiKey":"PMAK-live-secret"}',
        status: 200,
        body: '{}',
        responseHeaders: {}
      }]
    };

    expect(() => assertCassetteRedacted(poisoned)).toThrow(/rawRequestBody|raw capture/i);
  });
});

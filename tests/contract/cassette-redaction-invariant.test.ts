import { describe, expect, it } from 'vitest';

import { assertCassetteRedacted } from '../../scripts/sanitize-cassette.js';
import { listCommittedCassetteJsonFiles, readCassette } from './cassettes/replay.js';

describe('contract: committed cassette redaction invariant', () => {
  it('rejects secret-shaped or live-identity content in every committed cassette', () => {
    const cassetteFiles = listCommittedCassetteJsonFiles();

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
      const cassette = readCassette(name.replace(/\.json$/, ''));
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

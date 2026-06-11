import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CONTRACT_SIZE_LIMITS, createContractScript } from '../src/lib/spec/collection-contracts.js';
import { buildContractIndex } from '../src/lib/spec/contract-index.js';
import { parseOpenApiDocument } from '../src/lib/spec/openapi-loader.js';

// Large real-world public specs (GitHub, Stripe, Plaid, DigitalOcean,
// Spotify) live in the internal e2e harness checkout, so this regression
// corpus runs locally in the holding-folder layout and skips in repo CI.
const CORPUS_DIR = process.env.LARGE_SPEC_CORPUS_DIR ?? resolve(import.meta.dirname, '..', '..', 'onboarding-e2e', 'fixtures', 'large-specs');

describe.skipIf(!existsSync(CORPUS_DIR))('large real-world spec corpus', () => {
  const files = existsSync(CORPUS_DIR) ? readdirSync(CORPUS_DIR).filter((file) => /\.(json|ya?ml)$/.test(file)).sort() : [];

  it.each(files)('indexes and instruments every operation of %s without fatal errors', (file) => {
    const document = parseOpenApiDocument(readFileSync(join(CORPUS_DIR, file), 'utf8'));
    const index = buildContractIndex(document);
    expect(index.operations.length).toBeGreaterThan(50);
    let unsupportedMedia = 0;
    for (const operation of index.operations) {
      for (const response of Object.values(operation.responses)) {
        for (const media of Object.values(response.content)) {
          if (media.unsupported) unsupportedMedia += 1;
        }
      }
      const warnings: string[] = [];
      const script = createContractScript(operation, warnings);
      const bytes = Buffer.byteLength(script.join('\n'), 'utf8');
      expect(bytes).toBeLessThanOrEqual(CONTRACT_SIZE_LIMITS.maxTestScriptBytes);
    }
    expect(unsupportedMedia).toBe(0);
  }, 120_000);
});

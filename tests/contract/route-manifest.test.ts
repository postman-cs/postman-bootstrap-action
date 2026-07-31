import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  validateRouteManifest,
  type RouteManifest
} from '@postman-cse/automation-core/route-manifest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const manifestPath = path.join(import.meta.dirname, 'route-manifest.json');

describe('route manifest ratchet', () => {
  it('covers every statically extracted route and binds simulated routes to cassettes', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RouteManifest;
    const result = validateRouteManifest({ repoRoot, manifest });

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  extractRoutesFromSource,
  validateRouteManifest,
  type RouteManifest
} from '@postman-cs/automation-core/route-manifest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const manifestPath = path.join(import.meta.dirname, 'route-manifest.json');

const EXTRACTION_CONFIG = {
  proxyHelpers: {
    proxyRequest: [
      {
        files: ['lib/postman/internal-integration-adapter.ts'],
        serviceArg: 0,
        methodArg: 1,
        pathArg: 2,
        dynamicCallReason: 'The generic dispatcher forwards a payload whose literal routes are extracted at its callers.'
      },
      {
        files: ['lib/postman/postman-ec-client.ts'],
        service: 'collection',
        dynamicCallReason: 'proxyJson owns the literal collection route call sites.'
      }
    ],
    proxyJson: {
      files: ['lib/postman/postman-ec-client.ts'],
      service: 'collection'
    },
    request: {
      files: ['lib/github/github-api-client.ts'],
      service: 'api.github.com',
      pathArg: 0,
      initArg: 1
    }
  },
  serviceAliases: {
    'probeSessionIdentity:baseUrl': 'iapub',
    'this.apiBaseUrl': 'postman-api',
    'this.versionUrl': {
      service: 'dl.pstmn.io',
      path: '/update/status?currentVersion=12.0.0&platform=osx_arm64'
    }
  },
  allowedPassthroughs: [
    {
      file: 'lib/github/github-api-client.ts',
      urlExpression: '`${this.apiBase}${path}`',
      reason: 'HTTP transport for the file-scoped request helper; literal GitHub routes are extracted at request callers.'
    },
    {
      file: 'lib/postman/internal-integration-adapter.ts',
      urlExpression: 'input',
      reason: 'Deadline wrapper forwards the URL already attributed at proxyRequest callers.'
    },
    {
      file: 'lib/postman/postman-ec-client.ts',
      urlExpression: 'url',
      reason: 'Bifrost carrier for literal collection routes extracted at proxyJson callers.'
    }
  ]
} as const;

describe('route manifest ratchet', () => {
  it('covers every statically extracted route and binds simulated routes to cassettes', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RouteManifest;
    const result = validateRouteManifest({ repoRoot, manifest, ...EXTRACTION_CONFIG });
    const extraction = extractRoutesFromSource({
      sourceRoot: path.join(repoRoot, 'src'),
      ...EXTRACTION_CONFIG
    });

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(extraction.unattributed).toEqual([]);
    expect(extraction.routes).toHaveLength(59);
  });
});

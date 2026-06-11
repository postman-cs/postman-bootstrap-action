import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONTRACT_SIZE_LIMITS, createContractScript, instrumentContractCollection, matchOperation } from '../src/lib/spec/collection-contracts.js';
import { buildContractIndex } from '../src/lib/spec/contract-index.js';
import { loadOpenApiContractSpec, loadOpenApiContractSpecFromPath, parseOpenApiDocument, detectOpenApiVersion, normalizeSpecTypeFromContent } from '../src/lib/spec/openapi-loader.js';
import { createPinnedLookup, isBlockedAddress, safeFetchText, validateSafeHttpsUrl } from '../src/lib/spec/safe-spec-fetch.js';

const BASE_SPEC = `openapi: 3.1.0
info:
  title: T
  version: 1.0.0
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
`;

function indexFrom(spec: string) {
  return buildContractIndex(parseOpenApiDocument(spec));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = resolve(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('dynamic contract hardening', () => {
  it('pins HTTPS DNS lookups using the callback shape requested by Node', async () => {
    const lookup = createPinnedLookup('93.184.216.34', 4);

    await new Promise<void>((resolvePromise, reject) => {
      lookup('example.test', {}, (error, address, family) => {
        try {
          expect(error).toBeNull();
          expect(address).toBe('93.184.216.34');
          expect(family).toBe(4);
          resolvePromise();
        } catch (assertionError) {
          reject(assertionError);
        }
      });
    });

    await new Promise<void>((resolvePromise, reject) => {
      lookup('example.test', { all: true }, (error, addresses) => {
        try {
          expect(error).toBeNull();
          expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
          resolvePromise();
        } catch (assertionError) {
          reject(assertionError);
        }
      });
    });
  });

  it('safe fetch rejects non-HTTPS, private hostnames, redirect-to-private, and DNS rebinding', async () => {
    expect(() => validateSafeHttpsUrl('http://example.test/openapi.yaml')).toThrow('Only HTTPS');
    expect(() => validateSafeHttpsUrl('file:///tmp/openapi.yaml')).toThrow('Only HTTPS');
    expect(() => validateSafeHttpsUrl('https://localhost/openapi.yaml')).toThrow('Private hostname');
    expect(() => validateSafeHttpsUrl('https://[::1]/openapi.yaml')).toThrow('Private IP address');
    await expect(safeFetchText('https://example.test/openapi.yaml', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async () => ({
        statusCode: 302,
        headers: { location: 'https://127.0.0.1/openapi.yaml' },
        body: '',
        remoteAddress: '93.184.216.34'
      })
    })).rejects.toThrow('Private IP address');
    await expect(safeFetchText('https://example.test/openapi.yaml', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async () => ({
        statusCode: 200,
        headers: {},
        body: BASE_SPEC,
        remoteAddress: '127.0.0.1'
      })
    })).rejects.toThrow('Remote socket address');
  });

  it('blocks special-use public-only address and URL parser edge cases before transport', async () => {
    const blockedUrlHosts = [
      'https://2130706433/openapi.yaml',
      'https://0177.0.0.1/openapi.yaml',
      'https://0x7f000001/openapi.yaml',
      'https://127.1/openapi.yaml',
      'https://%31%32%37.0.0.1/openapi.yaml',
      'https://[::ffff:127.0.0.1]/openapi.yaml',
      'https://[::127.0.0.1]/openapi.yaml',
      'https://[2001:db8::1]/openapi.yaml'
    ];
    for (const url of blockedUrlHosts) {
      expect(() => validateSafeHttpsUrl(url), url).toThrow('CONTRACT_SPEC_FETCH_BLOCKED');
    }

    for (const address of [
      '0.0.0.0',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.1.1',
      '172.16.0.1',
      '192.0.0.1',
      '192.0.2.1',
      '192.88.99.1',
      '192.168.0.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '::',
      '::1',
      '::ffff:192.168.0.1',
      '::a00:1',
      '64:ff9b:1::1',
      '100::1',
      '2001::1',
      '2001:db8::1',
      '2002:0a00:0001::1',
      'fc00::1',
      'fe80::1',
      'ff02::1'
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }

    const lookup = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 as const },
      { address: '192.0.2.10', family: 4 as const }
    ]);
    const transport = vi.fn();
    await expect(safeFetchText('https://example.test/openapi.yaml', { lookup, transport })).rejects.toThrow('DNS for example.test resolved to blocked address 192.0.2.10');
    expect(transport).not.toHaveBeenCalled();
  });

  it('normalizes redirect caps, missing locations, DNS, transport, and size failures to contract errors', async () => {
    const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]);

    await expect(safeFetchText('https://example.test/openapi.yaml', {
      lookup,
      transport: async () => ({ statusCode: 302, headers: {}, body: '', remoteAddress: '93.184.216.34' })
    })).rejects.toThrow('CONTRACT_SPEC_FETCH_FAILED: OpenAPI redirect omitted Location header');

    await expect(safeFetchText('https://example.test/openapi.yaml', {
      lookup,
      maxRedirects: 1,
      transport: async () => ({ statusCode: 302, headers: { location: 'https://example.test/next.yaml' }, body: '', remoteAddress: '93.184.216.34' })
    })).rejects.toThrow('CONTRACT_SPEC_FETCH_FAILED: OpenAPI fetch exceeded 1 redirects');

    await expect(safeFetchText('https://example.test/openapi.yaml', {
      lookup: async () => {
        throw new Error('ENOTFOUND');
      },
      transport: vi.fn()
    })).rejects.toThrow('CONTRACT_SPEC_FETCH_FAILED: DNS lookup failed for example.test: ENOTFOUND');

    await expect(safeFetchText('https://example.test/openapi.yaml', {
      lookup,
      transport: async () => {
        throw new Error('socket hang up');
      }
    })).rejects.toThrow('CONTRACT_SPEC_FETCH_FAILED: OpenAPI fetch failed for https://example.test/openapi.yaml: socket hang up');

    await expect(safeFetchText('https://example.test/openapi.yaml', {
      lookup,
      maxBytesPerResource: 2,
      transport: async () => ({ statusCode: 200, headers: {}, body: 'abc', remoteAddress: '93.184.216.34' })
    })).rejects.toThrow('CONTRACT_REF_SIZE_EXCEEDED: OpenAPI resource exceeded 2 bytes');
  });

  describe('loadOpenApiContractSpecFromPath', () => {
    let workspaceDir = '';
    let originalWorkspace: string | undefined;

    beforeEach(() => {
      workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), 'spec-ws-')));
      originalWorkspace = process.env.GITHUB_WORKSPACE;
      process.env.GITHUB_WORKSPACE = workspaceDir;
    });

    afterEach(() => {
      if (originalWorkspace === undefined) {
        delete process.env.GITHUB_WORKSPACE;
      } else {
        process.env.GITHUB_WORKSPACE = originalWorkspace;
      }
      rmSync(workspaceDir, { recursive: true, force: true });
    });

    const writeSpec = (relPath: string, body: string): string => {
      const full = join(workspaceDir, relPath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body);
      return full;
    };

    const baseSpec = `openapi: 3.0.3
info:
  title: Local Spec
  version: 1.0.0
paths:
  /ping:
    get:
      responses:
        '200':
          description: OK
`;

    it.each([
      {
        content: JSON.stringify({
          openapi: '3.0.3',
          info: { title: 'Local Spec', version: '1.0.0' },
          paths: { '/ping': { get: { responses: { '200': { description: 'OK' } } } } }
        }, null, 2),
        expectedVersion: '3.0',
        label: 'OpenAPI 3.0 JSON',
        path: 'apis/svc/openapi-3-0.json'
      },
      {
        content: `openapi: 3.0.3
info:
  title: Local Spec
  version: 1.0.0
paths:
  /ping:
    get:
      responses:
        '200':
          description: OK
`,
        expectedVersion: '3.0',
        label: 'OpenAPI 3.0 YAML',
        path: 'apis/svc/openapi-3-0.yaml'
      },
      {
        content: JSON.stringify({
          openapi: '3.1.0',
          info: { title: 'Local Spec', version: '1.0.0' },
          paths: { '/ping': { get: { responses: { '200': { description: 'OK' } } } } }
        }, null, 2),
        expectedVersion: '3.1',
        label: 'OpenAPI 3.1 JSON',
        path: 'apis/svc/openapi-3-1.json'
      },
      {
        content: `openapi: 3.1.0
info:
  title: Local Spec
  version: 1.0.0
paths:
  /ping:
    get:
      responses:
        '200':
          description: OK
`,
        expectedVersion: '3.1',
        label: 'OpenAPI 3.1 YAML',
        path: 'apis/svc/openapi-3-1.yaml'
      }
    ] as const)('loads $label through the full local contract loader', async ({ content, expectedVersion, path }) => {
      writeSpec(path, content);
      const fetchText = vi.fn();
      const loaded = await loadOpenApiContractSpecFromPath(path, { fetchText });

      expect(fetchText).not.toHaveBeenCalled();
      expect(loaded.version).toBe(expectedVersion);
      expect(loaded.contractIndex.version).toBe(expectedVersion);
      expect(loaded.contractIndex.operations[0]?.path).toBe('/ping');
    });

    it('loads a spec from a local filesystem path', async () => {
      writeSpec('apis/svc/openapi.yaml', baseSpec);
      const fetchText = vi.fn();
      const loaded = await loadOpenApiContractSpecFromPath('apis/svc/openapi.yaml', { fetchText });
      expect(fetchText).not.toHaveBeenCalled();
      expect(loaded.version).toBe('3.0');
      expect(loaded.contractIndex.operations[0]?.path).toBe('/ping');
    });

    it('reports CONTRACT_SPEC_READ_FAILED when the local spec is missing', async () => {
      await expect(
        loadOpenApiContractSpecFromPath('apis/svc/missing.yaml')
      ).rejects.toThrow('CONTRACT_SPEC_READ_FAILED');
    });

    it('rejects paths that traverse outside the workspace', async () => {
      const outside = realpathSync(mkdtempSync(join(tmpdir(), 'spec-outside-')));
      try {
        writeFileSync(join(outside, 'openapi.yaml'), baseSpec);
        await expect(
          loadOpenApiContractSpecFromPath(join(outside, 'openapi.yaml'))
        ).rejects.toThrow('CONTRACT_SPEC_READ_FAILED');
        await expect(
          loadOpenApiContractSpecFromPath('../outside/openapi.yaml')
        ).rejects.toThrow('CONTRACT_SPEC_READ_FAILED');
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('wraps directory targets and other read failures as CONTRACT_SPEC_READ_FAILED', async () => {
      mkdirSync(join(workspaceDir, 'apis/svc'), { recursive: true });
      // Pointing spec-path at a directory: realpath/stat succeed but
      // readFile rejects with EISDIR. Should surface the contract error.
      await expect(
        loadOpenApiContractSpecFromPath('apis/svc')
      ).rejects.toThrow('CONTRACT_SPEC_READ_FAILED');
    });

    it('rejects oversized local specs before parsing', async () => {
      writeSpec('apis/svc/openapi.yaml', baseSpec);
      await expect(
        loadOpenApiContractSpecFromPath('apis/svc/openapi.yaml', {
          maxBytesPerResource: 16
        })
      ).rejects.toThrow('CONTRACT_REF_SIZE_EXCEEDED');
    });

    it('fails fast on an unsupported root spec without fetching its refs', async () => {
      writeSpec(
        'apis/svc/openapi.yaml',
        `swagger: '2.0'
info: { title: T, version: 1.0.0 }
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          schema:
            $ref: 'https://cdn.example.test/level-0.yaml'
`
      );
      const fetchText = vi.fn();
      await expect(
        loadOpenApiContractSpecFromPath('apis/svc/openapi.yaml', { fetchText })
      ).rejects.toThrow('CONTRACT_UNSUPPORTED_OPENAPI_VERSION');
      expect(fetchText).not.toHaveBeenCalled();
    });

    it('rejects a local spec that would blow the total byte budget', async () => {
      writeSpec('apis/svc/openapi.yaml', baseSpec);
      await expect(
        loadOpenApiContractSpecFromPath('apis/svc/openapi.yaml', {
          maxTotalBytes: 16
        })
      ).rejects.toThrow('CONTRACT_REF_SIZE_EXCEEDED');
    });

    it('enforces ref-depth limits on HTTPS $ref chains starting from a local spec', async () => {
      writeSpec(
        'apis/svc/openapi.yaml',
        `openapi: 3.0.3
info: { title: T, version: 1.0.0 }
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: 'https://cdn.example.test/level-0.yaml'
`
      );
      const fetchText = vi.fn(async (url: string) => {
        const match = /level-(\d+)\.yaml$/.exec(url);
        const next = Number(match?.[1] ?? '0') + 1;
        return `type: object
properties:
  next:
    $ref: 'https://cdn.example.test/level-${next}.yaml'
`;
      });
      await expect(
        loadOpenApiContractSpecFromPath('apis/svc/openapi.yaml', {
          fetchText,
          maxDepth: 3
        })
      ).rejects.toThrow('CONTRACT_REF_DEPTH_EXCEEDED');
    });

    it('rejects local-file $refs with CONTRACT_SPEC_FETCH_BLOCKED', async () => {
      writeSpec('apis/svc/sibling.yaml', 'type: object\n');
      writeSpec(
        'apis/svc/openapi.yaml',
        `openapi: 3.0.3
info: { title: T, version: 1.0.0 }
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: './sibling.yaml'
`
      );
      // No mock fetchText - exercise the real safeFetchText so the
      // protocol guard fires and surfaces the documented contract error.
      await expect(
        loadOpenApiContractSpecFromPath('apis/svc/openapi.yaml')
      ).rejects.toThrow('CONTRACT_SPEC_FETCH_BLOCKED');
    });

    it('rejects non-HTTPS external $refs with CONTRACT_SPEC_FETCH_BLOCKED', async () => {
      writeSpec(
        'apis/svc/openapi.yaml',
        `openapi: 3.0.3
info: { title: T, version: 1.0.0 }
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: 'http://example.test/schema.yaml'
`
      );
      await expect(
        loadOpenApiContractSpecFromPath('apis/svc/openapi.yaml')
      ).rejects.toThrow('CONTRACT_SPEC_FETCH_BLOCKED');
    });
  });

  it('loads external refs through the custom resolver and validates with external resolution disabled', async () => {
    const root = `openapi: 3.1.0
info:
  title: T
  version: 1.0.0
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: 'https://cdn.example.test/schemas/pet.yaml'
`;
    const fetchText = vi.fn(async (url: string) => {
      if (url.includes('pet.yaml')) return 'type: object\nproperties:\n  id:\n    type: integer\n';
      return root;
    });

    const loaded = await loadOpenApiContractSpec('https://api.example.test/openapi.yaml', { fetchText });

    expect(fetchText).toHaveBeenCalledWith('https://api.example.test/openapi.yaml', expect.any(Object));
    expect(fetchText).toHaveBeenCalledWith('https://cdn.example.test/schemas/pet.yaml', expect.any(Object));
    expect(loaded.contractIndex.operations[0]?.responses['200']?.content['application/json']?.schema).toBeTruthy();
  });

  it('retries classified transient fetch failures for root specs and external refs', async () => {
    vi.useFakeTimers();
    try {
      const root = `openapi: 3.1.0
info:
  title: T
  version: 1.0.0
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: 'https://cdn.example.test/schemas/pet.yaml'
`;
      let rootAttempts = 0;
      let refAttempts = 0;
      const fetchText = vi.fn(async (url: string) => {
        if (url.includes('pet.yaml')) {
          refAttempts += 1;
          if (refAttempts === 1) {
            throw new Error('CONTRACT_SPEC_FETCH_FAILED: DNS lookup failed for cdn.example.test: ENOTFOUND');
          }
          return 'type: object\nproperties:\n  id:\n    type: integer\n';
        }
        rootAttempts += 1;
        if (rootAttempts === 1) {
          throw new Error('CONTRACT_SPEC_FETCH_FAILED: OpenAPI resource returned HTTP 503');
        }
        return root;
      });

      const loadPromise = loadOpenApiContractSpec('https://api.example.test/openapi.yaml', { fetchText });
      await vi.advanceTimersByTimeAsync(6000);

      await expect(loadPromise).resolves.toMatchObject({ version: '3.1' });
      expect(fetchText).toHaveBeenCalledTimes(4);
      expect(rootAttempts).toBe(2);
      expect(refAttempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies safe fetch limits and actionable parse errors to external refs', async () => {
    const root = `openapi: 3.1.0
info: { title: T, version: '1' }
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: 'https://cdn.example.test/schema.yaml'
`;

    await expect(loadOpenApiContractSpec('https://api.example.test/openapi.yaml', {
      maxExternalRefs: 0,
      fetchText: async (url, options) => {
        if (url.includes('schema.yaml')) {
          return safeFetchText(url, {
            ...options,
            lookup: async () => [{ address: '93.184.216.34', family: 4 }],
            transport: async () => ({ statusCode: 200, headers: {}, body: 'type: object\n' })
          });
        }
        return root;
      }
    })).rejects.toThrow('CONTRACT_REF_LIMIT_EXCEEDED');

    await expect(loadOpenApiContractSpec('https://api.example.test/openapi.yaml', {
      fetchText: async (url) => url.includes('schema.yaml') ? 'type: [unterminated' : root
    })).rejects.toThrow('CONTRACT_SPEC_PARSE_FAILED: Referenced OpenAPI document https://cdn.example.test/schema.yaml is not valid JSON or YAML');
  });

  it('enforces OpenAPI version detection for supported, unsupported, missing, and mismatched content', () => {
    expect(detectOpenApiVersion(parseOpenApiDocument('openapi: 3.0.3\ninfo: { title: T, version: 1 }\npaths: {}\n'))).toBe('3.0');
    expect(detectOpenApiVersion(parseOpenApiDocument('openapi: 3.1.0\ninfo: { title: T, version: 1 }\npaths: {}\n'))).toBe('3.1');
    expect(normalizeSpecTypeFromContent('openapi: 3.1.1\ninfo: { title: T, version: 1 }\npaths: {}\n')).toBe('OPENAPI:3.1');
    expect(() => detectOpenApiVersion(parseOpenApiDocument('swagger: "2.0"\ninfo: { title: T, version: 1 }\npaths: {}\n'))).toThrow('CONTRACT_UNSUPPORTED_OPENAPI_VERSION');
    expect(() => detectOpenApiVersion(parseOpenApiDocument('info: { title: T, version: 1 }\npaths: {}\n'))).toThrow('missing openapi');
    expect(() => detectOpenApiVersion(parseOpenApiDocument('openapi: 3\ninfo: { title: T, version: 1 }\npaths: {}\n'))).toThrow('found openapi 3');
    expect(() => detectOpenApiVersion(parseOpenApiDocument('openapi: 2.0.0\ninfo: { title: T, version: 1 }\npaths: {}\n'))).toThrow('found openapi 2.0.0');
  });

  it('resolves response, parameter, header, and requestBody refs for static checks and scripts', () => {
    const spec = `openapi: 3.1.0
info:
  title: T
  version: 1.0.0
paths:
  /pets/{id}:
    parameters:
      - $ref: '#/components/parameters/PetId'
    post:
      parameters:
        - $ref: '#/components/parameters/TraceId'
        - $ref: '#/components/parameters/Mode'
      requestBody:
        $ref: '#/components/requestBodies/PetBody'
      responses:
        '201':
          $ref: '#/components/responses/PetCreated'
components:
  parameters:
    PetId: { name: id, in: path, required: true, schema: { type: string } }
    TraceId: { name: X-Trace-Id, in: header, required: true, schema: { type: string } }
    Mode: { name: mode, in: query, required: true, schema: { type: string } }
  requestBodies:
    PetBody:
      required: true
      content:
        application/json:
          schema: { type: object }
  responses:
    PetCreated:
      description: OK
      headers:
        X-Rate-Limit:
          $ref: '#/components/headers/RateLimit'
      content:
        application/json:
          schema: { type: object }
  headers:
    RateLimit:
      schema: { type: string }
`;
    const index = indexFrom(spec);
    const operation = index.operations[0]!;
    expect(operation.requiredParameters).toEqual([
      { in: 'path', name: 'id', securityDerived: false },
      { in: 'header', name: 'X-Trace-Id', securityDerived: false },
      { in: 'query', name: 'mode', securityDerived: false }
    ]);
    expect(operation.requestBody?.required).toBe(true);
    expect(operation.responses['201']?.headers[0]?.name).toBe('X-Rate-Limit');
    expect(() => instrumentContractCollection({ item: [{ request: { method: 'POST', url: { path: ['pets', '1'] }, header: [], body: { raw: '{}' } } }] }, index)).toThrow('missing required header');
    expect(() => instrumentContractCollection({ item: [{ request: { method: 'POST', url: { path: ['pets', '1'], query: [{ key: 'other', value: '1' }] }, header: [{ key: 'X-Trace-Id', value: 'trace-1' }, { key: 'Content-Type', value: 'application/json' }], body: { raw: '{}' } } }] }, index)).toThrow('missing required query parameter mode');
    expect(() => instrumentContractCollection({ item: [{ request: { method: 'POST', url: { path: ['pets', '1'], query: [{ key: 'mode', value: 'full' }] }, header: [{ key: 'X-Trace-Id', value: 'trace-1' }, { key: 'Content-Type', value: 'application/json' }] } }] }, index)).toThrow('missing required requestBody');
    expect(() => instrumentContractCollection({ item: [{ request: { method: 'POST', url: { path: ['pets', '1'], query: [{ key: 'mode', value: 'full' }] }, header: [{ key: 'X-Trace-Id', value: 'trace-1' }], body: { raw: '{}' } } }] }, index)).toThrow('missing required request Content-Type');
    expect(() => instrumentContractCollection({ item: [{ request: { method: 'POST', url: { path: ['pets', '1'], query: [{ key: 'mode', value: 'full' }] }, header: [{ key: 'X-Trace-Id', value: 'trace-1' }, { key: 'Content-Type', value: 'text/plain' }], body: { raw: '{}' } } }] }, index)).toThrow('request Content-Type text/plain does not match application/json');
  });

  it('handles OAS 3.0 ref siblings, OAS 3.1 ref siblings, nullable, and writeOnly packaging', () => {
    const spec30 = `openapi: 3.0.3
info: { title: T, version: 1 }
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Pet'
                minLength: 5
components:
  schemas:
    Pet: { type: string }
`;
    const spec31 = spec30.replace('3.0.3', '3.1.0');
    const schema30 = indexFrom(spec30).operations[0]!.responses['200']!.content['application/json']!.schema as Record<string, unknown>;
    const schema31 = indexFrom(spec31).operations[0]!.responses['200']!.content['application/json']!.schema as Record<string, unknown>;
    expect(schema30).not.toHaveProperty('allOf');
    expect(schema31).toHaveProperty('allOf');
    expect(() => instrumentContractCollection({ item: [{ request: { method: 'GET', url: { path: ['pets'] } } }] }, indexFrom(spec31))).not.toThrow();

    const nullable = indexFrom(`openapi: 3.0.3
info: { title: T, version: 1 }
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [name, secret]
                properties:
                  name: { type: string, nullable: true }
                  secret: { type: string, writeOnly: true }
`).operations[0]!.responses['200']!.content['application/json']!.schema as { properties: Record<string, unknown>; required: string[] };
    expect(nullable.required).toEqual(['name']);
    expect(nullable.properties.secret).toBeUndefined();
    expect(nullable.properties.name).toMatchObject({ type: ['string', 'null'] });

    expect(() => instrumentContractCollection({ item: [{ request: { method: 'GET', url: { path: ['pets'] } } }] }, indexFrom(`openapi: 3.0.3
info: { title: T, version: 1 }
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                nullable: true
                allOf:
                  - type: object
                    properties: { id: { type: integer } }
`))).not.toThrow();
  });

  it('generates schemasafe IIFE scripts without Postman jsonSchema, eval, or new Function', () => {
    const result = instrumentContractCollection({ item: [{ request: { method: 'GET', url: { path: ['pets'] } } }] }, indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties: { id: { type: integer } }
`));
    const script = ((result.collection.item as Array<{ event?: Array<{ script: { exec: string[] } }> }>)[1]!.event![0]!.script.exec).join('\n');
    expect(script).toContain('(function()');
    expect(script).not.toContain('pm.response.to.have.jsonSchema');
    expect(script).not.toMatch(/\beval\s*\(/);
    expect(script).not.toContain('new Function');
  });

  it('generates status, body, media type, JSON body, and header schema validators', () => {
    const result = instrumentContractCollection({ item: [{ request: { method: 'GET', url: { path: ['pets'] } } }] }, indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets:
    get:
      responses:
        '2XX':
          description: OK
          headers:
            X-Rate-Limit:
              required: true
              schema: { type: string, pattern: '^[0-9]+$' }
          content:
            application/json:
              schema:
                type: object
                required: [id]
                properties: { id: { type: integer } }
        '204':
          description: No content
`));
    const script = ((result.collection.item as Array<{ event?: Array<{ script: { exec: string[] } }> }>)[1]!.event![0]!.script.exec).join('\n');
    expect(script).toContain("var range = String(Math.floor(pm.response.code / 100)) + 'XX';");
    expect(script).toContain("pm.test('Status code is defined by OpenAPI'");
    expect(script).toContain("pm.test('Response body matches OpenAPI body contract'");
    expect(script).toContain("pm.test('Content-Type matches OpenAPI response content'");
    expect(script).toContain("pm.test('Response headers match OpenAPI'");
    expect(script).toContain('validators[selected.key].__headers[String(header.name).toLowerCase()]');
    expect(script).toContain('isJsonSubtype(actual.subtype) ? pm.response.json() : responseText()');
  });

  it('scans every executable script in the final collection for forbidden constructs', () => {
    expect(() => instrumentContractCollection({
      event: [{ listen: 'prerequest', script: { exec: ['eval("leak")'] } }],
      item: [{ request: { method: 'GET', url: { path: ['pets'] } } }]
    }, indexFrom(BASE_SPEC))).toThrow('CONTRACT_FORBIDDEN_SCRIPT_CONSTRUCT');
  });

  it('fails closed for unsupported schemas with explicit runtime-failing tests', () => {
    const result = instrumentContractCollection({ item: [{ request: { method: 'GET', url: { path: ['pets'] } } }] }, indexFrom(`openapi: 3.0.3
info: { title: T, version: 1 }
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: array
                items:
                  - type: string
                  - type: integer
`));
    const script = ((result.collection.item as Array<{ event?: Array<{ script: { exec: string[] } }> }>)[1]!.event![0]!.script.exec).join('\n');
    expect(script).toContain('OpenAPI schema unsupported');
    expect(script).toContain('Tuple array items are unsupported in OpenAPI 3.0');
    expect(script).not.toContain('pm.response.to.have.jsonSchema');
  });

  it('enforces operation coverage and duplicate generated request mapping', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets:
    get: { responses: { '200': { description: OK } } }
  /users:
    get: { responses: { '200': { description: OK } } }
`);
    expect(() => instrumentContractCollection({ item: [{ request: { method: 'GET', url: { path: ['pets'] } } }] }, index)).toThrow('CONTRACT_OPERATION_COVERAGE_FAILED');
    expect(() => instrumentContractCollection({ item: [
      { name: 'first', request: { method: 'GET', url: { path: ['pets'] } } },
      { name: 'second', request: { method: 'GET', url: { path: ['pets'] } } },
      { name: 'users', request: { method: 'GET', url: { path: ['users'] } } }
    ] }, index)).toThrow('CONTRACT_DUPLICATE_OPERATION_REQUEST');
  });

  it('enforces hard generated script and collection update size gates', () => {
    const softContent = Object.fromEntries(
      Array.from({ length: 10_000 }, (_value, index) => [`application/vnd.soft-${index}+json`, {}])
    );
    const softResult = instrumentContractCollection({ item: [{ request: { method: 'GET', url: { path: ['pets'] } } }] }, buildContractIndex({
      openapi: '3.1.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/pets': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                content: softContent
              }
            }
          }
        }
      }
    }));
    expect(softResult.warnings.some((warning) => warning.includes(`soft size limit ${CONTRACT_SIZE_LIMITS.warnTestScriptBytes} bytes`))).toBe(true);

    const content = Object.fromEntries(
      Array.from({ length: 35_000 }, (_value, index) => [`application/vnd.contract-${index}+json`, {}])
    );
    const index = buildContractIndex({
      openapi: '3.1.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/pets': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                content
              }
            }
          }
        }
      }
    });
    expect(() => instrumentContractCollection({ item: [{ request: { method: 'GET', url: { path: ['pets'] } } }] }, index)).toThrow(`CONTRACT_SCRIPT_SIZE_EXCEEDED: Generated contract test script exceeded ${CONTRACT_SIZE_LIMITS.maxTestScriptBytes} bytes`);

    expect(() => instrumentContractCollection({
      item: [{ request: { method: 'GET', url: { path: ['pets'] } }, description: 'x'.repeat(CONTRACT_SIZE_LIMITS.maxCollectionUpdateBytes) }]
    }, indexFrom(BASE_SPEC))).toThrow(`CONTRACT_COLLECTION_SIZE_EXCEEDED: Instrumented contract collection exceeded ${CONTRACT_SIZE_LIMITS.maxCollectionUpdateBytes} bytes`);
  });

  it('does not suffix-match paths and reports ambiguous operations', () => {
    const suffixIndex = indexFrom(BASE_SPEC);
    expect(matchOperation(suffixIndex, { method: 'GET', url: { path: ['v1', 'pets'] } }).operation).toBeUndefined();

    const ambiguous = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets/{id}:
    get: { responses: { '200': { description: OK } } }
  /pets/{name}:
    get: { responses: { '200': { description: OK } } }
`);
    expect(matchOperation(ambiguous, { method: 'GET', url: { path: ['pets', '123'] } }).ambiguous?.map((op) => op.id)).toEqual(['GET /pets/{id}', 'GET /pets/{name}']);
  });

  it('prefers exact literal matches over server-prefixed template matches when both have the same segment length', () => {
    // Regression for CONTRACT_DUPLICATE_OPERATION_REQUEST hit by Fox's spec:
    // both `/login` and `/otp/login` exist, and the server has a basePath
    // template, so the contract index produces a `/{serverVariable}/login`
    // candidate for `POST /login`. A request to `/otp/login` matches both
    // that template candidate and the literal `/otp/login`; the matcher must
    // pick the literal one rather than the template (otherwise two distinct
    // requests both resolve to `POST /login` and bootstrap throws
    // CONTRACT_DUPLICATE_OPERATION_REQUEST).
    const index = indexFrom(`openapi: 3.0.3
info: { title: account, version: '1' }
servers:
  - url: 'https://example.com/{basePath}'
    variables:
      basePath: { default: account }
paths:
  /login:
    post: { responses: { '200': { description: OK } } }
  /otp/login:
    post: { responses: { '200': { description: OK } } }
`);
    expect(matchOperation(index, { method: 'POST', url: { path: ['otp', 'login'] } }).operation?.id).toBe('POST /otp/login');
    expect(matchOperation(index, { method: 'POST', url: { path: ['login'] } }).operation?.id).toBe('POST /login');
    expect(matchOperation(index, { method: 'POST', url: { path: ['account', 'login'] } }).operation?.id).toBe('POST /login');
    expect(matchOperation(index, { method: 'POST', url: { path: ['account', 'otp', 'login'] } }).operation?.id).toBe('POST /otp/login');
  });

  it('fails closed for missing eligible operations and warns about callbacks and webhooks', () => {
    expect(() => indexFrom('openapi: 3.1.0\ninfo: { title: T, version: 1 }\npaths: {}\n')).toThrow('CONTRACT_NO_ELIGIBLE_OPERATIONS');
    expect(() => indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets:
    get:
      summary: List pets
`)).toThrow('CONTRACT_OPERATION_NO_RESPONSES');

    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
webhooks:
  petCreated:
    post:
      responses:
        '202': { description: Accepted }
paths:
  /pets:
    get:
      callbacks:
        petEvent:
          '{$request.body#/url}':
            post:
              responses:
                '202': { description: Accepted }
      responses:
        '200': { description: OK }
`);
    expect(index.warnings).toContain('CONTRACT_WEBHOOKS_NOT_VALIDATED: OpenAPI webhooks are not validated by dynamic contract tests');
    expect(index.warnings).toContain('CONTRACT_CALLBACKS_NOT_VALIDATED: callbacks are not validated for GET /pets');
    expect(index.operations).toHaveLength(1);
  });

  it('warns that configured security schemes are residual and not runtime-proven', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
security:
  - headerKey: []
  - queryKey: []
  - cookieKey: []
  - bearerAuth: []
  - basicAuth: []
  - oauthAuth: [read:pets]
  - oidcAuth: []
  - mtlsAuth: []
paths:
  /pets:
    get:
      security:
        - headerKey: []
        - bearerAuth: []
      parameters:
        - name: X-API-Key
          in: header
          required: true
          schema: { type: string }
      responses:
        '200': { description: OK }
  /users:
    get:
      responses:
        '200': { description: OK }
components:
  securitySchemes:
    headerKey: { type: apiKey, in: header, name: X-API-Key }
    queryKey: { type: apiKey, in: query, name: api_key }
    cookieKey: { type: apiKey, in: cookie, name: sid }
    bearerAuth: { type: http, scheme: bearer }
    basicAuth: { type: http, scheme: basic }
    oauthAuth: { type: oauth2, flows: { clientCredentials: { tokenUrl: https://auth.example.test/token, scopes: { read:pets: Read pets } } } }
    oidcAuth: { type: openIdConnect, openIdConnectUrl: https://auth.example.test/.well-known/openid-configuration }
    mtlsAuth: { type: mutualTLS }
`);

    expect(index.operations.find((operation) => operation.id === 'GET /pets')?.warnings).toEqual(expect.arrayContaining([
      'CONTRACT_SECURITY_NOT_VALIDATED: security scheme headerKey (apiKey:header) is not runtime-proven beyond credential presence by dynamic contract tests',
      'CONTRACT_SECURITY_NOT_VALIDATED: security scheme bearerAuth (http:bearer) is not runtime-proven beyond credential presence by dynamic contract tests',
      'CONTRACT_SECURITY_NOT_VALIDATED: security parameter header:X-API-Key is not statically required in generated requests'
    ]));
    expect(index.operations.find((operation) => operation.id === 'GET /users')?.warnings).toEqual(expect.arrayContaining([
      'CONTRACT_SECURITY_NOT_VALIDATED: security scheme queryKey (apiKey:query) is not runtime-proven beyond credential presence by dynamic contract tests',
      'CONTRACT_SECURITY_NOT_VALIDATED: security scheme cookieKey (apiKey:cookie) is not runtime-proven beyond credential presence by dynamic contract tests',
      'CONTRACT_SECURITY_NOT_VALIDATED: security scheme basicAuth (http:basic) is not runtime-proven beyond credential presence by dynamic contract tests',
      'CONTRACT_SECURITY_NOT_VALIDATED: security scheme oauthAuth (oauth2) is not runtime-proven beyond credential presence by dynamic contract tests',
      'CONTRACT_SECURITY_NOT_VALIDATED: security scheme oidcAuth (openIdConnect) is not runtime-proven beyond credential presence by dynamic contract tests',
      'CONTRACT_SECURITY_NOT_VALIDATED: security scheme mtlsAuth (mutualTLS) is not runtime-proven beyond credential presence by dynamic contract tests'
    ]));
  });

  it('asserts supported schema formats, bounds int32 integers, and treats unknown formats and content keywords as annotations', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  ref: { type: string, format: uuid }
                  id: { type: integer, format: int64 }
                  count: { type: integer, format: int32, maximum: 100 }
                  size: { type: integer, format: int32 }
                  blob: { type: string, format: binary, contentEncoding: base64, contentMediaType: application/octet-stream }
`);
    const media = index.operations[0]!.responses['200']!.content['application/json']!;
    expect(media.unsupported).toBeUndefined();
    const properties = (media.schema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(properties.ref!.format).toBe('uuid');
    expect(properties.id!.format).toBeUndefined();
    expect(properties.id!.minimum).toBeUndefined();
    expect(properties.count!.format).toBeUndefined();
    expect(properties.count!.minimum).toBe(-2147483648);
    expect(properties.count!.maximum).toBe(100);
    expect(properties.size!.minimum).toBe(-2147483648);
    expect(properties.size!.maximum).toBe(2147483647);
    expect(properties.blob!.format).toBeUndefined();
    expect(properties.blob!.contentEncoding).toBeUndefined();
    expect(properties.blob!.contentMediaType).toBeUndefined();
    expect(() => instrumentContractCollection({ item: [{ request: { method: 'GET', url: { path: ['pets'] } } }] }, index)).not.toThrow();
  });

  it('embeds runtime security credential checks only for enforceable security requirements', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets:
    get:
      security:
        - headerKey: []
        - bearerAuth: []
        - queryKey: []
          cookieKey: []
      responses:
        '200': { description: OK }
  /open:
    get:
      security: []
      responses:
        '200': { description: OK }
  /optional:
    get:
      security:
        - headerKey: []
        - {}
      responses:
        '200': { description: OK }
  /mtls:
    get:
      security:
        - mtlsAuth: []
      responses:
        '200': { description: OK }
components:
  securitySchemes:
    headerKey: { type: apiKey, in: header, name: X-API-Key }
    queryKey: { type: apiKey, in: query, name: api_key }
    cookieKey: { type: apiKey, in: cookie, name: sid }
    bearerAuth: { type: http, scheme: bearer }
    mtlsAuth: { type: mutualTLS }
`);
    const byId = (id: string) => index.operations.find((operation) => operation.id === id)!;
    expect(byId('GET /pets').security).toEqual([
      [{ scheme: 'headerKey', kind: 'apiKey:header', checkable: true, in: 'header', name: 'X-API-Key' }],
      [{ scheme: 'bearerAuth', kind: 'http:bearer', checkable: true, prefix: 'Bearer ' }],
      [
        { scheme: 'queryKey', kind: 'apiKey:query', checkable: true, in: 'query', name: 'api_key' },
        { scheme: 'cookieKey', kind: 'apiKey:cookie', checkable: true, in: 'cookie', name: 'sid' }
      ]
    ]);
    expect(byId('GET /open').security).toBeUndefined();
    expect(byId('GET /optional').security).toBeUndefined();
    expect(byId('GET /mtls').security).toBeUndefined();

    const collection = { item: ['pets', 'open', 'optional', 'mtls'].map((path) => ({ name: path, request: { method: 'GET', url: { path: [path] } } })) };
    const { collection: instrumented } = instrumentContractCollection(collection, index);
    const scriptFor = (name: string) => {
      const item = (instrumented.item as Array<Record<string, unknown>>).find((entry) => entry.name === name)!;
      const event = (item.event as Array<{ script: { exec: string[] } }>)[0]!;
      return event.script.exec.join('\n');
    };
    expect(scriptFor('pets')).toContain('Request carries credentials required by OpenAPI security');
    expect(scriptFor('mtls')).not.toContain('Request carries credentials required by OpenAPI security');
    expect(scriptFor('open')).not.toContain('Request carries credentials required by OpenAPI security');
    expect(scriptFor('optional')).not.toContain('Request carries credentials required by OpenAPI security');
    expect(scriptFor('pets')).toContain('Content-Length is consistent with OpenAPI body expectations');
  });

  it('indexes required cookie parameters with warnings, marks deprecated operations, and keeps static checks passing', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets:
    get:
      deprecated: true
      security:
        - cookieKey: []
      parameters:
        - name: session
          in: cookie
          required: true
          schema: { type: string }
        - name: sid
          in: cookie
          required: true
          schema: { type: string }
      responses:
        '200': { description: OK }
components:
  securitySchemes:
    cookieKey: { type: apiKey, in: cookie, name: sid }
`);
    const operation = index.operations[0]!;
    expect(operation.requiredParameters).toEqual(expect.arrayContaining([
      { in: 'cookie', name: 'session', securityDerived: false },
      { in: 'cookie', name: 'sid', securityDerived: true }
    ]));
    expect(operation.warnings).toContain('CONTRACT_COOKIE_PARAM_NOT_VALIDATED: required cookie parameter session is not statically required in generated requests');
    expect(operation.warnings).toContain('CONTRACT_SECURITY_NOT_VALIDATED: security parameter cookie:sid is not statically required in generated requests');
    expect(operation.warnings).toContain('CONTRACT_OPERATION_DEPRECATED: GET /pets is marked deprecated in the OpenAPI document');
    expect(() => instrumentContractCollection({ item: [{ request: { method: 'GET', url: { path: ['pets'] } } }] }, index)).not.toThrow();
  });

  it('statically verifies top-level required properties of parseable generated JSON request bodies', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets:
    post:
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name, tag, audit]
              properties:
                name: { type: string }
                tag: { type: string }
                audit: { type: string, readOnly: true }
      responses:
        '201': { description: Created }
`);
    expect(index.operations[0]!.requestBody?.fieldRules).toEqual({ 'application/json': { required: ['name', 'tag'], readOnly: ['audit'] } });
    const item = (raw: string) => ({ item: [{ request: { method: 'POST', url: { path: ['pets'] }, header: [{ key: 'Content-Type', value: 'application/json' }], body: { mode: 'raw', raw } } }] });
    expect(instrumentContractCollection(item('{"name":"a"}'), index).warnings).toContain('CONTRACT_REQUEST_BODY_INCOMPLETE: POST /pets generated request body is missing required properties: tag');
    expect(instrumentContractCollection(item('{"name":"a","tag":"b","audit":"x"}'), index).warnings).toContain('CONTRACT_READONLY_PROPERTY_IN_REQUEST: POST /pets generated request body includes readOnly properties: audit');
    expect(instrumentContractCollection(item('{"name":"a","tag":"b"}'), index).warnings.filter((entry) => entry.includes('REQUEST_BODY') || entry.includes('READONLY'))).toEqual([]);
    expect(instrumentContractCollection(item('{"name": {{payload}}'), index).warnings.filter((entry) => entry.includes('REQUEST_BODY'))).toEqual([]);
  });

  it('merges allOf request schemas, checks form bodies, and warns on undocumented query parameters', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets:
    post:
      requestBody:
        required: true
        content:
          application/x-www-form-urlencoded:
            schema:
              allOf:
                - $ref: '#/components/schemas/Base'
                - type: object
                  required: [tag]
                  properties:
                    tag: { type: string }
      responses:
        '201': { description: Created }
components:
  schemas:
    Base:
      type: object
      required: [name]
      properties:
        name: { type: string }
`);
    expect(index.operations[0]!.requestBody?.fieldRules).toEqual({ 'application/x-www-form-urlencoded': { required: ['name', 'tag'], readOnly: [] } });
    const collection = {
      item: [{
        request: {
          method: 'POST',
          url: { path: ['pets'], query: [{ key: 'verbose', value: '1' }] },
          header: [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
          body: { mode: 'urlencoded', urlencoded: [{ key: 'name', value: 'a' }] }
        }
      }]
    };
    const { warnings } = instrumentContractCollection(collection, index);
    expect(warnings).toContain('CONTRACT_REQUEST_BODY_INCOMPLETE: POST /pets generated request body is missing required properties: tag');
    expect(warnings).toContain('CONTRACT_UNDOCUMENTED_QUERY_PARAM: POST /pets generated request sends query parameter verbose that the OpenAPI operation does not declare');
  });

  it('checks multipart encoding objects against the generated artifact and warns on non-default urlencoded field serialization', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /upload:
    post:
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              required: [meta, file]
              properties:
                meta: { type: object }
                file: { type: string, format: binary }
            encoding:
              meta: { contentType: application/json }
      responses:
        '201': { description: Created }
`);
    const upload = index.operations.find((operation) => operation.path === '/upload')!;
    expect(upload.requestBody?.fieldRules?.['multipart/form-data']?.encodings).toEqual({
      meta: { contentType: 'application/json' },
      file: { binary: true }
    });
    const urlencodedIndex = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /search:
    post:
      requestBody:
        required: true
        content:
          application/x-www-form-urlencoded:
            schema:
              type: object
              properties:
                tags: { type: array, items: { type: string } }
            encoding:
              tags: { style: spaceDelimited }
              label: { style: form, explode: true }
      responses:
        '200': { description: OK }
`);
    const search = urlencodedIndex.operations.find((operation) => operation.path === '/search')!;
    expect(search.warnings).toContain(
      'CONTRACT_PARAM_SERIALIZATION_NOT_VALIDATED: application/x-www-form-urlencoded request body field tags on POST /search declares non-default encoding style, explode, or allowReserved and its serialization is not validated'
    );
    expect(search.warnings.filter((entry) => entry.includes('field label'))).toEqual([]);
    const item = (formdata: unknown[]) => ({
      item: [{
        request: {
          method: 'POST',
          url: { path: ['upload'] },
          header: [{ key: 'Content-Type', value: 'multipart/form-data' }],
          body: { mode: 'formdata', formdata }
        }
      }]
    });
    const mismatched = instrumentContractCollection(item([
      { key: 'meta', type: 'text', value: '{}' },
      { key: 'file', type: 'text', value: 'x' }
    ]), index).warnings;
    expect(mismatched).toContain('CONTRACT_ENCODING_MISMATCH: POST /upload generated multipart field meta does not declare Content-Type application/json from its encoding object');
    expect(mismatched).toContain('CONTRACT_ENCODING_MISMATCH: POST /upload generated multipart field file should be a file part per its binary schema');
    const conforming = instrumentContractCollection(item([
      { key: 'meta', type: 'text', contentType: 'application/json; charset=utf-8', value: '{}' },
      { key: 'file', type: 'file', src: '/tmp/upload.bin' }
    ]), index).warnings;
    expect(conforming.filter((entry) => entry.includes('CONTRACT_ENCODING_MISMATCH'))).toEqual([]);
    const wrongType = instrumentContractCollection(item([
      { key: 'meta', type: 'text', contentType: 'text/plain', value: 'x' },
      { key: 'file', type: 'file', src: '/tmp/upload.bin' }
    ]), index).warnings;
    expect(wrongType).toContain('CONTRACT_ENCODING_MISMATCH: POST /upload generated multipart field meta Content-Type text/plain does not match declared encoding application/json');

    const patternIndex = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /docs:
    post:
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              properties:
                note: { type: string }
                image: { type: string }
            encoding:
              note: { contentType: 'text/plain; charset=utf-8' }
              image: { contentType: 'image/*' }
      responses:
        '201': { description: Created }
`);
    const patternItem = (formdata: unknown[]) => ({
      item: [{
        request: {
          method: 'POST',
          url: { path: ['docs'] },
          header: [{ key: 'Content-Type', value: 'multipart/form-data' }],
          body: { mode: 'formdata', formdata }
        }
      }]
    });
    const patternMatched = instrumentContractCollection(patternItem([
      { key: 'note', type: 'text', contentType: 'text/plain; charset=utf-8', value: 'x' },
      { key: 'image', type: 'file', contentType: 'image/png', src: '/tmp/a.png' }
    ]), patternIndex).warnings;
    expect(patternMatched.filter((entry) => entry.includes('CONTRACT_ENCODING_MISMATCH'))).toEqual([]);
    const patternMismatched = instrumentContractCollection(patternItem([
      { key: 'note', type: 'text', contentType: 'text/plain', value: 'x' },
      { key: 'image', type: 'file', contentType: 'video/mp4', src: '/tmp/a.mp4' }
    ]), patternIndex).warnings;
    expect(patternMismatched.filter((entry) => entry.includes('CONTRACT_ENCODING_MISMATCH'))).toEqual([
      `CONTRACT_ENCODING_MISMATCH: POST /docs generated multipart field image Content-Type video/mp4 does not match declared encoding image/*`
    ]);
  });

  it('attaches the JSON Schema dialect when a media schema is a top-level $ref', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Pet'
components:
  schemas:
    Pet:
      type: object
      required: [id]
      properties:
        id: { type: string, format: uuid }
`);
    const media = index.operations[0]!.responses['200']!.content['application/json']!;
    expect(media.unsupported).toBeUndefined();
    expect((media.schema as { $schema: string }).$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(() => instrumentContractCollection({ item: [{ request: { method: 'GET', url: { path: ['pets'] } } }] }, index)).not.toThrow();
  });

  it('enforces OR/AND security semantics when generated scripts execute against a sent request', async () => {
    const { createContext, runInContext } = await import('node:vm');
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets:
    get:
      security:
        - headerKey: []
        - bearerAuth: []
        - queryKey: []
          cookieKey: []
      responses:
        '200': { description: OK }
components:
  securitySchemes:
    headerKey: { type: apiKey, in: header, name: X-API-Key }
    queryKey: { type: apiKey, in: query, name: api_key }
    cookieKey: { type: apiKey, in: cookie, name: sid }
    bearerAuth: { type: http, scheme: bearer }
`);
    const script = createContractScript(index.operations[0]!).join('\n');
    const mixedUncheckable = createContractScript({
      ...index.operations[0]!,
      security: [[
        { scheme: 'mtlsAuth', kind: 'mutualTLS', checkable: false },
        { scheme: 'headerKey', kind: 'apiKey:header', checkable: true, in: 'header', name: 'X-API-Key' }
      ]]
    }).join('\n');

    const run = (script: string, request: { headers: Record<string, string>; query: Array<{ key: string; value: string }> }) => {
      const failures: string[] = [];
      const results: Record<string, string> = {};
      const permissive: unknown = new Proxy(function () {}, {
        get: (_target, property) => (property === 'fail' ? (message: string) => { throw new Error(message); } : permissive),
        apply: () => permissive
      });
      const headerEntries = Object.entries(request.headers).map(([key, value]) => ({ key, value }));
      const pm = {
        test: (name: string, callback: () => void) => {
          try { callback(); results[name] = 'pass'; } catch (error) { results[name] = 'fail'; failures.push(name + ': ' + (error instanceof Error ? error.message : String(error))); }
        },
        expect: permissive,
        response: { code: 200, headers: { get: () => null }, text: () => '', json: () => ({}) },
        request: {
          headers: { each: (callback: (header: { key: string; value: string; disabled?: boolean }) => void) => headerEntries.forEach(callback) },
          url: { query: { each: (callback: (param: { key: string; value: string; disabled?: boolean }) => void) => request.query.forEach(callback) } }
        }
      };
      runInContext(script, createContext({ pm }));
      return { failures, verdict: results['Request carries credentials required by OpenAPI security'] };
    };

    expect(run(script, { headers: { 'x-api-key': 'k' }, query: [] }).verdict).toBe('pass');
    expect(run(script, { headers: { authorization: 'Bearer token-1' }, query: [] }).verdict).toBe('pass');
    expect(run(script, { headers: { authorization: 'Basic dXNlcg==' }, query: [] }).verdict).toBe('fail');
    expect(run(script, { headers: {}, query: [] }).verdict).toBe('fail');
    expect(run(script, { headers: {}, query: [{ key: 'api_key', value: 'k' }] }).verdict).toBe('fail');
    expect(run(script, { headers: { cookie: 'theme=dark; sid=abc' }, query: [{ key: 'api_key', value: 'k' }] }).verdict).toBe('pass');
    expect(run(mixedUncheckable, { headers: { 'x-api-key': 'k' }, query: [] }).verdict).toBe('pass');
    expect(run(mixedUncheckable, { headers: {}, query: [] }).verdict).toBe('fail');
  });

  it('compiles int32 schemas with exclusive bounds and draft-07 formats through instrumentation', () => {
    const spec31 = `openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  count: { type: integer, format: int32, exclusiveMinimum: 5 }
                  cap: { type: integer, format: int32, exclusiveMaximum: 100 }
`;
    const spec30 = `openapi: 3.0.3
info: { title: T, version: '1' }
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  count: { type: integer, format: int32, minimum: 0, exclusiveMinimum: true }
                  ref: { type: string, format: uuid }
`;
    for (const spec of [spec31, spec30]) {
      const index = indexFrom(spec);
      const media = index.operations[0]!.responses['200']!.content['application/json']!;
      expect(media.unsupported).toBeUndefined();
      expect(() => instrumentContractCollection({ item: [{ request: { method: 'GET', url: { path: ['pets'] } } }] }, index)).not.toThrow();
    }
    const packed31 = indexFrom(spec31).operations[0]!.responses['200']!.content['application/json']!.schema as { properties: Record<string, Record<string, unknown>> };
    expect(packed31.properties.count!.exclusiveMinimum).toBe(5);
    expect(packed31.properties.count!.minimum).toBeUndefined();
    expect(packed31.properties.count!.maximum).toBe(2147483647);
    expect(packed31.properties.cap!.exclusiveMaximum).toBe(100);
    expect(packed31.properties.cap!.maximum).toBeUndefined();
    expect(packed31.properties.cap!.minimum).toBe(-2147483648);
  });

  it('warns on links, non-default parameter serialization, and non-JSON object response schemas', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets:
    get:
      parameters:
        - name: tags
          in: query
          style: pipeDelimited
          schema: { type: array, items: { type: string } }
        - name: plain
          in: query
          schema: { type: string }
      responses:
        '200':
          description: OK
          links:
            next: { operationId: getPets }
          content:
            application/xml:
              schema: { type: object }
            text/csv:
              schema: { type: string }
`);
    const warnings = index.operations[0]!.warnings;
    expect(warnings).toContain('CONTRACT_LINKS_NOT_VALIDATED: response links are not validated for GET /pets');
    expect(warnings).toContain('CONTRACT_PARAM_SERIALIZATION_NOT_VALIDATED: parameter query:tags declares non-default style, explode, allowReserved, or content and its serialization is not validated');
    expect(warnings.filter((entry) => entry.includes('query:plain'))).toEqual([]);
    expect(warnings).toContain('CONTRACT_NONJSON_SCHEMA_NOT_VALIDATED: response schema for application/xml on GET /pets status 200 is not validated at runtime');
    expect(warnings.filter((entry) => entry.includes('text/csv'))).toEqual([]);
    const script = createContractScript(index.operations[0]!).join('\n');
    expect(script).not.toContain('Non-JSON response schema validation unsupported');
  });

  it('validates Content-Length expectations when generated scripts execute', async () => {
    const { createContext, runInContext } = await import('node:vm');
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets:
    delete:
      responses:
        '202': { description: Accepted }
`);
    const script = createContractScript(index.operations[0]!).join('\n');
    const run = (code: number, headers: Record<string, string>) => {
      const results: Record<string, string> = {};
      const permissive: unknown = new Proxy(function () {}, {
        get: (_target, property) => (property === 'fail' ? (message: string) => { throw new Error(message); } : permissive),
        apply: () => permissive
      });
      const pm = {
        test: (name: string, callback: () => void) => {
          try { callback(); results[name] = 'pass'; } catch { results[name] = 'fail'; }
        },
        expect: permissive,
        response: { code, headers: { get: (name: string) => headers[String(name).toLowerCase()] ?? null }, text: () => '', json: () => ({}) },
        request: { headers: { each: () => undefined }, url: { query: { each: () => undefined } } }
      };
      runInContext(script, createContext({ pm }));
      return results['Content-Length is consistent with OpenAPI body expectations'];
    };
    expect(run(202, {})).toBe('pass');
    expect(run(202, { 'content-length': '0' })).toBe('pass');
    expect(run(202, { 'content-length': '12' })).toBe('fail');
    expect(run(202, { 'content-length': 'abc' })).toBe('fail');
    expect(run(202, { 'content-length': '20', 'content-encoding': 'gzip' })).toBe('pass');
    expect(run(304, { 'content-length': '12' })).toBe('pass');
  });

  it('builds runtime parameter checks and request-side body validators with direction-aware packing', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets:
    post:
      security:
        - queryKey: []
      parameters:
        - name: limit
          in: query
          required: true
          schema: { type: integer, maximum: 50 }
        - name: X-Trace-Id
          in: header
          schema: { type: string, format: uuid }
        - name: tags
          in: query
          schema: { type: array, items: { type: string } }
        - name: filter
          in: query
          style: deepObject
          schema: { type: string }
        - name: api_key
          in: query
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name, id]
              properties:
                name: { type: string }
                id: { type: string, readOnly: true }
                secret: { type: string, writeOnly: true }
      responses:
        '201': { description: Created }
components:
  securitySchemes:
    queryKey: { type: apiKey, in: query, name: api_key }
`);
    const operation = index.operations[0]!;
    expect(operation.parameterChecks?.map((check) => `${check.in}:${check.name}`)).toEqual(['query:limit', 'header:X-Trace-Id']);
    const bodySchema = operation.requestBody?.jsonSchemas?.['application/json'] as { required?: string[]; properties: Record<string, unknown> };
    expect(bodySchema.required).toEqual(['name']);
    expect(bodySchema.properties.id).toBeUndefined();
    expect(bodySchema.properties.secret).toBeDefined();
  });

  it('warns when a JSON request body schema cannot be compiled into a request validator', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets:
    post:
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              customKeyword: true
      responses:
        '201': { description: Created }
`);
    expect(index.operations[0]!.warnings.some((entry) => entry.startsWith('CONTRACT_REQUEST_SCHEMA_NOT_VALIDATED: request body schema for application/json on POST /pets'))).toBe(true);
  });

  it('validates concrete parameter values and request bodies at runtime while skipping placeholders', async () => {
    const { createContext, runInContext } = await import('node:vm');
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets:
    post:
      parameters:
        - name: limit
          in: query
          required: true
          schema: { type: integer, maximum: 50 }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name]
              properties:
                name: { type: string }
                count: { type: integer }
      responses:
        '201': { description: Created }
`);
    const script = createContractScript(index.operations[0]!).join('\n');
    const run = (query: Array<{ key: string; value: string }>, rawBody: string | null) => {
      const results: Record<string, string> = {};
      const messages: string[] = [];
      const permissive: unknown = new Proxy(function () {}, {
        get: (_target, property) => (property === 'fail' ? (message: string) => { throw new Error(message); } : permissive),
        apply: () => permissive
      });
      const pm = {
        test: (name: string, callback: () => void) => {
          try { callback(); results[name] = 'pass'; } catch (error) { results[name] = 'fail'; messages.push(error instanceof Error ? error.message : String(error)); }
        },
        expect: permissive,
        response: { code: 201, headers: { get: () => null }, text: () => '', json: () => ({}) },
        request: {
          headers: { each: (callback: (header: { key: string; value: string }) => void) => callback({ key: 'Content-Type', value: 'application/json' }) },
          url: { query: { each: (callback: (param: { key: string; value: string }) => void) => query.forEach(callback) } },
          body: rawBody === null ? undefined : { mode: 'raw', raw: rawBody }
        }
      };
      runInContext(script, createContext({ pm }));
      return { params: results['Request parameters match OpenAPI schemas'], body: results['Request body matches OpenAPI request schema'], messages };
    };

    expect(run([{ key: 'limit', value: '10' }], '{"name":"a"}')).toMatchObject({ params: 'pass', body: 'pass' });
    expect(run([{ key: 'limit', value: '99' }], '{"name":"a"}').params).toBe('fail');
    expect(run([{ key: 'limit', value: 'abc' }], '{"name":"a"}').params).toBe('fail');
    expect(run([{ key: 'limit', value: '<integer>' }], '{"name":"a"}').params).toBe('pass');
    expect(run([], '{"name":"a"}').params).toBe('fail');
    expect(run([{ key: 'limit', value: '10' }], '{"count":"not-a-number","name":"a"}').body).toBe('fail');
    expect(run([{ key: 'limit', value: '10' }], '{"name":"<string>"}').body).toBe('pass');
    expect(run([{ key: 'limit', value: '10' }], '{"name": {{payload}}}').body).toBe('pass');
    expect(run([{ key: 'limit', value: '10' }], 'not json at all').body).toBe('fail');
    expect(run([{ key: 'limit', value: '10' }], null).body).toBe('pass');
  });

  it('dedupes dual numeric bound pairs key-order-immune and clamps exclusive int32 bounds', () => {
    const dual31 = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  a: { type: integer, minimum: 0, exclusiveMinimum: 5 }
                  b: { type: integer, minimum: 7, exclusiveMinimum: 5 }
                  c: { type: integer, maximum: 10, exclusiveMaximum: 8 }
                  loose: { type: integer, format: int32, exclusiveMinimum: -9999999999, exclusiveMaximum: 9999999999 }
`);
    const props = (dual31.operations[0]!.responses['200']!.content['application/json']!.schema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props.a).toMatchObject({ exclusiveMinimum: 5 });
    expect(props.a!.minimum).toBeUndefined();
    expect(props.b).toMatchObject({ minimum: 7 });
    expect(props.b!.exclusiveMinimum).toBeUndefined();
    expect(props.c).toMatchObject({ exclusiveMaximum: 8 });
    expect(props.c!.maximum).toBeUndefined();
    expect(props.loose).toMatchObject({ minimum: -2147483648, maximum: 2147483647 });
    expect(props.loose!.exclusiveMinimum).toBeUndefined();
    expect(props.loose!.exclusiveMaximum).toBeUndefined();
    expect(() => instrumentContractCollection({ item: [{ request: { method: 'GET', url: { path: ['pets'] } } }] }, dual31)).not.toThrow();

    const boolFirst30 = indexFrom([
      'openapi: 3.0.3',
      'info: { title: T, version: "1" }',
      'paths:',
      '  /pets:',
      '    get:',
      '      responses:',
      "        '200':",
      '          description: OK',
      '          content:',
      '            application/json:',
      '              schema: { type: integer, exclusiveMinimum: true, minimum: 0 }',
      ''
    ].join('\n'));
    const packed = boolFirst30.operations[0]!.responses['200']!.content['application/json']!.schema as Record<string, unknown>;
    expect(packed.exclusiveMinimum).toBe(0);
    expect(packed.minimum).toBeUndefined();
    expect(() => instrumentContractCollection({ item: [{ request: { method: 'GET', url: { path: ['pets'] } } }] }, boolFirst30)).not.toThrow();
  });

  it('ignores SHALL-ignore header parameters and Content-Type response headers per the OAS spec', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets:
    get:
      parameters:
        - name: Authorization
          in: header
          required: true
          schema: { type: string }
        - name: Content-Type
          in: header
          required: true
          style: deepObject
          schema: { type: string }
        - name: Accept
          in: header
          required: true
          schema: { type: string }
      responses:
        '200':
          description: OK
          headers:
            Content-Type:
              required: true
              schema: { type: string, enum: [application/json] }
            X-Items:
              schema: { type: array, items: { type: string } }
          content:
            application/json:
              schema: { type: object }
`);
    const operation = index.operations[0]!;
    expect(operation.requiredParameters).toEqual([]);
    expect(operation.parameterChecks).toBeUndefined();
    expect(operation.warnings.filter((entry) => entry.includes('SERIALIZATION'))).toEqual([]);
    expect(operation.responses['200']!.headers.map((header) => header.name)).toEqual(['X-Items']);
    expect(operation.responses['200']!.headers[0]!.schema).toBeUndefined();
    expect(operation.warnings).toContain('CONTRACT_HEADER_SCHEMA_NOT_VALIDATED: response header X-Items on GET /pets status 200 declares a non-scalar schema and its value is not validated');
    expect(() => instrumentContractCollection({ item: [{ request: { method: 'GET', url: { path: ['pets'] } } }] }, index)).not.toThrow();
  });

  it('strips $comment, packs boolean schemas, and validates spec examples against their schemas', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets:
    post:
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              $comment: internal note
              required: [name]
              properties:
                name: { type: string }
            example: { name: 123 }
          application/xml:
            schema: { type: object }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: string, format: uuid }
              examples:
                good: { value: { id: 11111111-2222-4333-8444-555555555555 } }
                bad: { value: { id: not-a-uuid } }
            application/octet-stream:
              schema: true
`);
    const operation = index.operations[0]!;
    expect(operation.responses['200']!.content['application/json']!.unsupported).toBeUndefined();
    expect(operation.responses['200']!.content['application/octet-stream']!.unsupported).toBeUndefined();
    expect(operation.warnings).toContain('CONTRACT_EXAMPLE_SCHEMA_MISMATCH: examples.bad for application/json on POST /pets status 200 does not match its schema');
    expect(operation.warnings.filter((entry) => entry.includes('examples.good'))).toEqual([]);
    expect(operation.warnings).toContain('CONTRACT_EXAMPLE_SCHEMA_MISMATCH: example for application/json on POST /pets does not match its schema');
    expect(operation.warnings).toContain('CONTRACT_NONJSON_SCHEMA_NOT_VALIDATED: request body schema for application/xml on POST /pets is not validated at runtime');
  });

  it('warns that path parameter values are not validated at runtime', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets/{petId}:
    get:
      parameters:
        - name: petId
          in: path
          required: true
          schema: { type: string }
      responses:
        '200': { description: OK }
`);
    expect(index.operations[0]!.warnings).toContain('CONTRACT_PATH_PARAM_NOT_VALIDATED: path parameter petId value is not validated at runtime');
  });

  it('covers pm.cookies credentials, header coercion, empty header values, and unquoted placeholder bodies at runtime', async () => {
    const { createContext, runInContext } = await import('node:vm');
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets:
    post:
      security:
        - cookieKey: []
      parameters:
        - name: X-Trace-Id
          in: header
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                count: { type: integer }
      responses:
        '201':
          description: Created
          headers:
            X-Remaining:
              schema: { type: integer }
          content:
            application/json:
              schema: { type: object }
components:
  securitySchemes:
    cookieKey: { type: apiKey, in: cookie, name: sid }
`);
    const script = createContractScript(index.operations[0]!).join('\n');
    const run = (options: { cookies?: { has: (name: string) => boolean }; headers?: Record<string, string>; responseHeaders?: Record<string, string>; rawBody?: string }) => {
      const results: Record<string, string> = {};
      const permissive: unknown = new Proxy(function () {}, {
        get: (_target, property) => (property === 'fail' ? (message: string) => { throw new Error(message); } : permissive),
        apply: () => permissive
      });
      const headerEntries = Object.entries(options.headers ?? {}).map(([key, value]) => ({ key, value }));
      const pm = {
        test: (name: string, callback: () => void) => {
          try { callback(); results[name] = 'pass'; } catch { results[name] = 'fail'; }
        },
        expect: permissive,
        cookies: options.cookies,
        response: {
          code: 201,
          headers: { get: (name: string) => (options.responseHeaders ?? {})[String(name).toLowerCase()] ?? null },
          text: () => '{}',
          json: () => ({})
        },
        request: {
          headers: { each: (callback: (header: { key: string; value: string }) => void) => headerEntries.forEach(callback) },
          url: { query: { each: () => undefined } },
          body: options.rawBody === undefined ? undefined : { mode: 'raw', raw: options.rawBody }
        }
      };
      runInContext(script, createContext({ pm }));
      return results;
    };

    const base = { headers: { 'x-trace-id': 'abc', 'content-type': 'application/json' } };
    expect(run({ ...base, cookies: { has: (name) => name === 'sid' } })['Request carries credentials required by OpenAPI security']).toBe('pass');
    expect(run({ ...base, cookies: { has: () => false } })['Request carries credentials required by OpenAPI security']).toBe('fail');
    expect(run({ ...base, headers: { ...base.headers, cookie: 'sid=jar' }, cookies: { has: () => false } })['Request carries credentials required by OpenAPI security']).toBe('pass');
    expect(run({ ...base, responseHeaders: { 'content-type': 'application/json', 'x-remaining': '41' } })['Response headers match OpenAPI']).toBe('pass');
    expect(run({ ...base, responseHeaders: { 'content-type': 'application/json', 'x-remaining': 'soon' } })['Response headers match OpenAPI']).toBe('fail');
    expect(run({ headers: { 'x-trace-id': '', 'content-type': 'application/json' } })['Request parameters match OpenAPI schemas']).toBe('pass');
    expect(run({ headers: { 'content-type': 'application/json' } })['Request parameters match OpenAPI schemas']).toBe('fail');
    expect(run({ ...base, rawBody: '{"count": <long>}' })['Request body matches OpenAPI request schema']).toBe('pass');
    expect(run({ ...base, rawBody: 'definitely not json' })['Request body matches OpenAPI request schema']).toBe('fail');
  });

  it('packs recursive $refs through a $defs registry and degrades uncompilable schemas to skip warnings', async () => {
    const { createContext, runInContext } = await import('node:vm');
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /tree:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Node'
            application/problem+json:
              schema:
                type: [string, 'null']
                properties:
                  inner: { type: string }
components:
  schemas:
    Node:
      type: object
      required: [name]
      properties:
        name: { type: string }
        children:
          type: array
          items:
            $ref: '#/components/schemas/Node'
`);
    const media = index.operations[0]!.responses['200']!.content['application/json']!;
    expect(media.unsupported).toBeUndefined();
    const packed = media.schema as { properties: Record<string, unknown>; $defs: Record<string, unknown> };
    expect(packed.properties.children).toMatchObject({ items: { $ref: '#/$defs/d0' } });
    expect(packed.$defs.d0).toBeDefined();

    const warnings: string[] = [];
    const script = createContractScript(index.operations[0]!, warnings).join('\n');
    expect(warnings.some((entry) => entry.startsWith('CONTRACT_SCHEMA_NOT_COMPILED: response schema for application/problem+json on GET /tree status 200'))).toBe(true);
    expect(script).toContain('validators["200"]["application/problem+json"] = { skip: true };');

    const run = (body: unknown, contentType: string) => {
      const results: Record<string, string> = {};
      const permissive: unknown = new Proxy(function () {}, {
        get: (_target, property) => (property === 'fail' ? (message: string) => { throw new Error(message); } : permissive),
        apply: () => permissive
      });
      const pm = {
        test: (name: string, callback: () => void) => {
          try { callback(); results[name] = 'pass'; } catch { results[name] = 'fail'; }
        },
        expect: permissive,
        response: { code: 200, headers: { get: (name: string) => (String(name).toLowerCase() === 'content-type' ? contentType : null) }, text: () => JSON.stringify(body), json: () => body },
        request: { headers: { each: () => undefined }, url: { query: { each: () => undefined } } }
      };
      runInContext(script, createContext({ pm }));
      return results['Response body matches OpenAPI schema'];
    };
    expect(run({ name: 'root', children: [{ name: 'leaf' }] }, 'application/json')).toBe('pass');
    expect(run({ name: 'root', children: [{ title: 'broken' }] }, 'application/json')).toBe('fail');
    expect(run('anything', 'application/problem+json')).toBe('pass');
  });

  it('degrades reference graphs past the embed cap to presence-only checks with warnings', () => {
    const schemas: Record<string, unknown> = {};
    const properties: Record<string, unknown> = {};
    for (let index = 0; index < 401; index += 1) {
      schemas[`S${index}`] = { type: 'string' };
      properties[`p${index}`] = { $ref: `#/components/schemas/S${index}` };
    }
    schemas.Big = { type: 'object', properties };
    const document = {
      openapi: '3.1.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/big': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                headers: { 'X-Big': { schema: { $ref: '#/components/schemas/Big' } } },
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Big' } } }
              }
            }
          }
        }
      },
      components: { schemas }
    };
    const index = buildContractIndex(document as Record<string, unknown>);
    const operation = index.operations[0]!;
    const media = operation.responses['200']!.content['application/json']!;
    expect(media.unsupported).toBeUndefined();
    expect(media.schema).toBeUndefined();
    const header = operation.responses['200']!.headers[0]!;
    expect(header.schema).toBeUndefined();
    expect(header.unsupported).toBeUndefined();
    const graphWarnings = operation.warnings.filter((entry) => entry.startsWith('CONTRACT_SCHEMA_NOT_COMPILED') && entry.includes('reference graph exceeded'));
    expect(graphWarnings.length).toBe(2);
    const script = createContractScript(operation).join('\n');
    expect(script).not.toContain('$defs/overflow');
    expect(() => instrumentContractCollection({ item: [{ request: { method: 'GET', url: { path: ['big'] } } }] }, index)).not.toThrow();
  });

  it('packs map-valued keywords, gates dialect-specific keywords, and fails self-referential aliases closed', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /maps:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                patternProperties:
                  '^x-': { type: string }
                dependentRequired:
                  name: [tag]
                dependentSchemas:
                  kind:
                    type: object
                    required: [variant]
                properties:
                  name: { type: string }
`);
    const media = index.operations[0]!.responses['200']!.content['application/json']!;
    expect(media.unsupported).toBeUndefined();
    const packed = media.schema as Record<string, Record<string, unknown>>;
    expect(packed.patternProperties!['^x-']).toEqual({ type: 'string' });
    expect(packed.dependentRequired).toEqual({ name: ['tag'] });
    expect(packed.dependentSchemas!.kind).toEqual({ type: 'object', required: ['variant'] });
    expect(() => instrumentContractCollection({ item: [{ request: { method: 'GET', url: { path: ['maps'] } } }] }, index)).not.toThrow();

    const draft07Gate = indexFrom(`openapi: 3.0.3
info: { title: T, version: '1' }
paths:
  /tuple:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: array
                prefixItems:
                  - { type: string }
`);
    expect(draft07Gate.operations[0]!.responses['200']!.content['application/json']!.unsupported).toContain('prefixItems requires the JSON Schema 2020-12 dialect');

    const dependenciesGate = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /dep:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                dependencies:
                  name: [tag]
`);
    expect(dependenciesGate.operations[0]!.responses['200']!.content['application/json']!.unsupported).toContain('dependencies is a draft-07 keyword');

    const alias = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /alias:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  self: { $ref: '#/components/schemas/A' }
components:
  schemas:
    A: { $ref: '#/components/schemas/A' }
`);
    expect(alias.operations[0]!.responses['200']!.content['application/json']!.unsupported).toContain('Self-referential alias schema is unsupported');

    const mutualAlias = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /alias:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  self: { $ref: '#/components/schemas/A' }
components:
  schemas:
    A: { $ref: '#/components/schemas/B' }
    B: { $ref: '#/components/schemas/A' }
`);
    expect(mutualAlias.operations[0]!.responses['200']!.content['application/json']!.unsupported).toContain('Self-referential alias schema is unsupported');

    const terminatingAlias = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /alias:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  self: { $ref: '#/components/schemas/A' }
components:
  schemas:
    A: { $ref: '#/components/schemas/B' }
    B: { type: string }
`);
    const terminatingMedia = terminatingAlias.operations[0]!.responses['200']!.content['application/json']!;
    expect(terminatingMedia.unsupported).toBeUndefined();
    expect(terminatingMedia.schema).toBeDefined();
  });

  it('warns on uncompilable parameter schemas and honors allowEmptyValue at runtime', async () => {
    const { createContext, runInContext } = await import('node:vm');
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /pets:
    get:
      parameters:
        - name: filter
          in: query
          schema:
            type: string
            customKeyword: true
        - name: tag
          in: query
          allowEmptyValue: true
          schema: { type: string, minLength: 2 }
      responses:
        '200': { description: OK }
`);
    const operation = index.operations[0]!;
    expect(operation.warnings.some((entry) => entry.startsWith('CONTRACT_SCHEMA_NOT_COMPILED: parameter query:filter schema on GET /pets skipped'))).toBe(true);
    expect(operation.parameterChecks?.map((check) => check.name)).toEqual(['tag']);
    expect(operation.parameterChecks?.[0]?.allowEmptyValue).toBe(true);

    const script = createContractScript(operation).join('\n');
    const run = (query: Array<{ key: string; value: string }>) => {
      const results: Record<string, string> = {};
      const permissive: unknown = new Proxy(function () {}, {
        get: (_target, property) => (property === 'fail' ? (message: string) => { throw new Error(message); } : permissive),
        apply: () => permissive
      });
      const pm = {
        test: (name: string, callback: () => void) => {
          try { callback(); results[name] = 'pass'; } catch { results[name] = 'fail'; }
        },
        expect: permissive,
        response: { code: 200, headers: { get: () => null }, text: () => '', json: () => ({}) },
        request: { headers: { each: () => undefined }, url: { query: { each: (callback: (param: { key: string; value: string }) => void) => query.forEach(callback) } } }
      };
      runInContext(script, createContext({ pm }));
      return results['Request parameters match OpenAPI schemas'];
    };
    expect(run([{ key: 'tag', value: 'ok' }])).toBe('pass');
    expect(run([{ key: 'tag', value: 'x' }])).toBe('fail');
    expect(run([{ key: 'tag', value: '' }])).toBe('pass');
  });

  it('documents dynamic contract tests and every emitted CONTRACT code in the README', () => {
    const readme = readFileSync(resolve(import.meta.dirname, '..', 'README.md'), 'utf8');
    expect(readme).toContain('## Dynamic contract tests');
    expect(readme).toContain('| Error code | Meaning | Remediation |');
    const source = sourceFiles(resolve(import.meta.dirname, '..', 'src'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    const emittedCodes = [...new Set([...source.matchAll(/['"`](CONTRACT_[A-Z0-9_]+)(?::|['"`])/g)].map((match) => match[1]))].sort();
    const documentedCodes = [...new Set([...readme.matchAll(/`(CONTRACT_[A-Z0-9_]+)`/g)].map((match) => match[1]))].sort();
    expect(documentedCodes).toEqual(expect.arrayContaining(emittedCodes));
  });
});

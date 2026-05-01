import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { CONTRACT_SIZE_LIMITS, instrumentContractCollection, matchOperation } from '../src/lib/spec/collection-contracts.js';
import { buildContractIndex } from '../src/lib/spec/contract-index.js';
import { loadOpenApiContractSpec, parseOpenApiDocument, detectOpenApiVersion, normalizeSpecTypeFromContent } from '../src/lib/spec/openapi-loader.js';
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
      'CONTRACT_SECURITY_NOT_VALIDATED: security scheme headerKey (apiKey:header) is not runtime-proven by dynamic contract tests',
      'CONTRACT_SECURITY_NOT_VALIDATED: security scheme bearerAuth (http:bearer) is not runtime-proven by dynamic contract tests',
      'CONTRACT_SECURITY_NOT_VALIDATED: security parameter header:X-API-Key is not statically required in generated requests'
    ]));
    expect(index.operations.find((operation) => operation.id === 'GET /users')?.warnings).toEqual(expect.arrayContaining([
      'CONTRACT_SECURITY_NOT_VALIDATED: security scheme queryKey (apiKey:query) is not runtime-proven by dynamic contract tests',
      'CONTRACT_SECURITY_NOT_VALIDATED: security scheme cookieKey (apiKey:cookie) is not runtime-proven by dynamic contract tests',
      'CONTRACT_SECURITY_NOT_VALIDATED: security scheme basicAuth (http:basic) is not runtime-proven by dynamic contract tests',
      'CONTRACT_SECURITY_NOT_VALIDATED: security scheme oauthAuth (oauth2) is not runtime-proven by dynamic contract tests',
      'CONTRACT_SECURITY_NOT_VALIDATED: security scheme oidcAuth (openIdConnect) is not runtime-proven by dynamic contract tests',
      'CONTRACT_SECURITY_NOT_VALIDATED: security scheme mtlsAuth (mutualTLS) is not runtime-proven by dynamic contract tests'
    ]));
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

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';

import { convertV2WithTypes } from 'openapi-to-postmanv2';
import { describe, expect, it, vi } from 'vitest';

import { buildContractIndex } from '../src/lib/spec/contract-index.js';
import {
  LOCAL_OPENAPI_CONVERSION_FAILED,
  LocalOpenApiConversionError,
  buildLocalOpenApiConversionOptions,
  computePayloadDigest,
  generateLocalOpenApiRolePayloads,
  rekeyStructuralCollectionIds,
  type LocalOpenApiConverter
} from '../src/lib/spec/local-openapi-collection-generation.js';
import { parseOpenApiDocument } from '../src/lib/spec/openapi-loader.js';
import { createSmokeTestExec, instrumentSmokeCollection } from '../src/lib/spec/smoke-tests.js';

type JsonRecord = Record<string, unknown>;

const require = createRequire(import.meta.url);

function record(value: unknown): JsonRecord {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
  return value as JsonRecord;
}

function array(value: unknown): unknown[] {
  expect(Array.isArray(value)).toBe(true);
  return value as unknown[];
}

function collectV2Scripts(node: unknown, out: Array<{ label: string; source: string }>, path = 'root'): void {
  if (!node || typeof node !== 'object') return;
  const current = node as JsonRecord;
  const name = typeof current.name === 'string' ? current.name : path;
  for (const raw of Array.isArray(current.event) ? current.event : []) {
    const event = raw as JsonRecord;
    const script = event?.script as JsonRecord | undefined;
    const exec = script?.exec;
    const source = Array.isArray(exec) ? exec.map(String).join('\n') : typeof exec === 'string' ? exec : '';
    if (source.trim().length > 0) out.push({ label: `${name}#${String(event.listen)}`, source });
  }
  for (const child of Array.isArray(current.item) ? current.item : []) {
    collectV2Scripts(child, out, name);
  }
}

function countV2Requests(node: unknown): number {
  if (!node || typeof node !== 'object') return 0;
  const current = node as JsonRecord;
  if (current.name === '00 - Resolve Secrets') return 0;
  return (isRecord(current.request) ? 1 : 0) +
    (Array.isArray(current.item) ? current.item.reduce((total, child) => total + countV2Requests(child), 0) : 0);
}

function assertParses(label: string, source: string): void {
  const wrapped = `;(async () => {;\n${source}\n;})();`;
  expect(() => new Script(wrapped, { filename: label })).not.toThrow();
}

const oas30 = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Pet API', version: '1.0.0' },
  servers: [{ url: 'https://api.example.test/v1' }],
  paths: {
    '/owners/{ownerId}/pets': {
      post: {
        summary: 'Create pet',
        operationId: 'createPet',
        tags: ['Owners', 'Pets'],
        parameters: [
          {
            name: 'ownerId',
            in: 'path',
            required: true,
            schema: { type: 'string', example: 'owner-1' }
          },
          {
            name: 'trace',
            in: 'query',
            schema: { type: 'string', example: 'trace-example' }
          }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { name: { type: 'string', example: 'Fido' } },
                required: ['name']
              },
              example: { name: 'Spot' }
            }
          }
        },
        responses: {
          '201': {
            description: 'created',
            content: { 'application/json': { example: { id: 'pet-1', name: 'Spot' } } }
          }
        }
      }
    }
  }
});

const oas31WithWebhook = JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'Webhook API', version: '1.0.0' },
  paths: {
    '/health': {
      get: {
        operationId: 'health',
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } }
          }
        }
      }
    }
  },
  webhooks: {
    petCreated: {
      post: {
        operationId: 'receivePet',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { id: { type: 'string', example: 'pet-webhook-1' } }
              }
            }
          }
        },
        responses: { '200': { description: 'accepted' } }
      }
    }
  }
});

const names = {
  baseline: 'Pet API',
  smoke: '[Smoke] Pet API',
  contract: '[Contract] Pet API'
};

function indexFor(content: string) {
  return buildContractIndex(parseOpenApiDocument(content));
}

/** Collection v2 structural identities Sync treats as cloud entity IDs. */
function collectStructuralSyncIds(collection: JsonRecord): string[] {
  const ids: string[] = [];
  const info = isRecord(collection.info) ? collection.info : null;
  if (typeof info?._postman_id === 'string' && info._postman_id.trim()) {
    ids.push(info._postman_id);
  }
  const walk = (items: unknown): void => {
    if (!Array.isArray(items)) return;
    for (const raw of items) {
      if (!isRecord(raw)) continue;
      if (typeof raw.id === 'string' && raw.id.trim()) ids.push(raw.id);
      walk(raw.item);
      if (Array.isArray(raw.response)) {
        for (const resp of raw.response) {
          if (isRecord(resp) && typeof resp.id === 'string' && resp.id.trim()) {
            ids.push(resp.id);
          }
        }
      }
    }
  };
  walk(collection.item);
  return ids;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

describe('local OpenAPI role payload generation', () => {
  it('pins the typed converter package and callback API', () => {
    const packageJson = require('openapi-to-postmanv2/package.json') as { version: string };
    expect(packageJson.version).toBe('6.3.0');
    expect(typeof convertV2WithTypes).toBe('function');
  });

  it('converts OAS 3.0 Paths once into three complete pre-write role payloads', async () => {
    const converter = vi.fn(convertV2WithTypes);
    const result = await generateLocalOpenApiRolePayloads(
      oas30,
      {
        openApiVersion: '3.0',
        requestNameSource: 'Fallback',
        folderStrategy: 'Paths',
        nestedFolderHierarchy: true,
        names,
        description: 'branch-marker',
        contractIndex: indexFor(oas30)
      },
      { converter }
    );

    expect(converter).toHaveBeenCalledOnce();
    expect(result.roles.baseline.collection.info).toMatchObject({ name: 'Pet API', description: 'branch-marker' });
    expect(result.roles.smoke.collection.info).toMatchObject({ name: '[Smoke] Pet API', description: 'branch-marker' });
    expect(result.roles.contract.collection.info).toMatchObject({
      name: '[Contract] Pet API',
      description: 'branch-marker'
    });

    const smokeRoot = array(result.roles.smoke.collection.item).map(record);
    expect(smokeRoot[0]?.name).toBe('00 - Resolve Secrets');
    const smokeScripts: Array<{ label: string; source: string }> = [];
    collectV2Scripts(result.roles.smoke.collection, smokeScripts);
    expect(smokeScripts.some((entry) => entry.source.includes('Status code is not an error'))).toBe(true);
    for (const { label, source } of smokeScripts) assertParses(`smoke:${label}`, source);

    const contractRoot = array(result.roles.contract.collection.item).map(record);
    expect(contractRoot[0]?.name).toBe('00 - Resolve Secrets');
    const contractScripts: Array<{ label: string; source: string }> = [];
    collectV2Scripts(result.roles.contract.collection, contractScripts);
    expect(contractScripts.some((entry) => entry.source.includes('OpenAPI') || entry.source.includes('pm.test'))).toBe(
      true
    );
    for (const { label, source } of contractScripts) assertParses(`contract:${label}`, source);

    expect(result.roles.baseline.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.roles.smoke.payloadDigest).not.toBe(result.roles.baseline.payloadDigest);
    expect(result.roles.contract.payloadDigest).not.toBe(result.roles.smoke.payloadDigest);

    const owners = record(array(result.roles.baseline.collection.item)[0]);
    const ownerId = record(array(owners.item)[0]);
    const pets = record(array(ownerId.item)[0]);
    expect([owners.name, ownerId.name, pets.name]).toEqual(['owners', '{ownerId}', 'pets']);
  });

  it('converts 101 operations once into complete roles without inventing a whole-import byte cap', async () => {
    const operationCount = 101;
    const paths = Object.fromEntries(Array.from({ length: operationCount }, (_value, index) => [
      `/operation-${index}`,
      { get: { operationId: `operation${index}`, responses: { '200': { description: 'ok' } } } }
    ]));
    const bundled = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Large API', version: '1.0.0' },
      paths
    });
    const converter = vi.fn(convertV2WithTypes);

    const result = await generateLocalOpenApiRolePayloads(bundled, {
      openApiVersion: '3.0',
      requestNameSource: 'Fallback',
      folderStrategy: 'Paths',
      names: { baseline: 'Large API', smoke: '[Smoke] Large API', contract: '[Contract] Large API' },
      contractIndex: indexFor(bundled)
    }, { converter });

    expect(converter).toHaveBeenCalledOnce();
    expect(countV2Requests(result.roles.baseline.collection)).toBe(operationCount);
    expect(countV2Requests(result.roles.smoke.collection)).toBe(operationCount);
    expect(countV2Requests(result.roles.contract.collection)).toBe(operationCount);
    const baselineScripts: Array<{ label: string; source: string }> = [];
    const smokeScripts: Array<{ label: string; source: string }> = [];
    const contractScripts: Array<{ label: string; source: string }> = [];
    collectV2Scripts(result.roles.baseline.collection, baselineScripts);
    collectV2Scripts(result.roles.smoke.collection, smokeScripts);
    collectV2Scripts(result.roles.contract.collection, contractScripts);
    expect(baselineScripts).toHaveLength(0);
    expect(smokeScripts.some((entry) => entry.source.includes('Status code is not an error'))).toBe(true);
    expect(contractScripts.some((entry) => entry.source.includes('pm.test'))).toBe(true);
    const contractBytes = Buffer.byteLength(JSON.stringify(result.roles.contract.collection), 'utf8');
    // Local whole-import opts out of the unrelated 4 MiB update guard; large
    // valid contract payloads must succeed without an invented whole-import cap.
    expect(contractBytes).toBeGreaterThan(4_000_000);
  });

  it('assigns disjoint structural Sync IDs across role clones from one conversion (Q12)', async () => {
    const converter = vi.fn(convertV2WithTypes);
    const result = await generateLocalOpenApiRolePayloads(
      oas30,
      {
        openApiVersion: '3.0',
        requestNameSource: 'Fallback',
        folderStrategy: 'Paths',
        nestedFolderHierarchy: true,
        names,
        description: 'branch-marker',
        contractIndex: indexFor(oas30)
      },
      { converter }
    );

    expect(converter).toHaveBeenCalledOnce();

    const baselineIds = collectStructuralSyncIds(result.roles.baseline.collection);
    const smokeIds = collectStructuralSyncIds(result.roles.smoke.collection);
    const contractIds = collectStructuralSyncIds(result.roles.contract.collection);

    expect(baselineIds.length).toBeGreaterThan(0);
    expect(smokeIds.length).toBeGreaterThan(0);
    expect(contractIds.length).toBeGreaterThan(0);

    const all = [...baselineIds, ...smokeIds, ...contractIds];
    expect(new Set(all).size).toBe(all.length);

    // Non-structural example/schema/body `id` values must survive rekeying.
    const serialized = JSON.stringify(result.roles.baseline.collection);
    expect(serialized).toContain('pet-1');

    // Volatile structural ids are ignored by the semantic payload digest.
    const rekeyedAgain = rekeyStructuralCollectionIds(result.roles.baseline.collection);
    expect(computePayloadDigest(rekeyedAgain)).toBe(result.roles.baseline.payloadDigest);
    expect(collectStructuralSyncIds(rekeyedAgain)).not.toEqual(baselineIds);
  });

  it('ignores only structural IDs while preserving semantic id properties in the digest', () => {
    const original: JsonRecord = {
      info: { name: 'IDs', _postman_id: 'root-a' },
      item: [{
        id: 'item-a',
        name: 'request',
        request: {
          id: 'request-a',
          method: 'POST',
          body: { mode: 'raw', raw: '{"id":"body-a"}' },
          auth: { id: 'user-auth-a' }
        },
        response: [{ id: 'response-a', body: '{"id":"example-a"}', originalRequest: { body: { id: 'semantic-a' } } }]
      }]
    };
    const structuralChange = structuredClone(original);
    const item = record(array(structuralChange.item)[0]);
    record(structuralChange.info)._postman_id = 'root-b';
    item.id = 'item-b';
    record(item.request).id = 'request-b';
    record(array(item.response)[0]).id = 'response-b';
    expect(computePayloadDigest(structuralChange)).toBe(computePayloadDigest(original));

    const semanticChange = structuredClone(original);
    record(record(array(semanticChange.item)[0]).request).auth = { id: 'user-auth-b' };
    expect(computePayloadDigest(semanticChange)).not.toBe(computePayloadDigest(original));
  });

  it('uses nested Tags folders and includes OAS 3.1 webhooks', async () => {
    const tagged = await generateLocalOpenApiRolePayloads(oas30, {
      openApiVersion: '3.0',
      requestNameSource: 'Fallback',
      folderStrategy: 'Tags',
      nestedFolderHierarchy: true,
      names,
      contractIndex: indexFor(oas30)
    });
    const owners = record(array(tagged.roles.baseline.collection.item)[0]);
    const pets = record(array(owners.item)[0]);
    expect([owners.name, pets.name, record(array(pets.item)[0]).name]).toEqual(['Owners', 'Pets', 'Create pet']);

    const withWebhook = await generateLocalOpenApiRolePayloads(oas31WithWebhook, {
      openApiVersion: '3.1',
      requestNameSource: 'Fallback',
      folderStrategy: 'Tags',
      nestedFolderHierarchy: false,
      names: {
        baseline: 'Webhook API',
        smoke: '[Smoke] Webhook API',
        contract: '[Contract] Webhook API'
      },
      contractIndex: indexFor(oas31WithWebhook)
    });
    const webhookFolder = array(withWebhook.roles.baseline.collection.item)
      .map(record)
      .find((item) => item.name === 'Webhooks');
    expect(webhookFolder).toBeDefined();
    expect(buildLocalOpenApiConversionOptions({
      openApiVersion: '3.1',
      requestNameSource: 'Fallback',
      folderStrategy: 'Tags',
      nestedFolderHierarchy: true,
      names,
      contractIndex: indexFor(oas31WithWebhook)
    })).toEqual({
      parametersResolution: 'Example',
      requestNameSource: 'Fallback',
      folderStrategy: 'Tags',
      nestedFolderHierarchy: true,
      includeWebhooks: true
    });
  });

  it('accepts already-bundled multifile content and never writes the filesystem', async () => {
    const bundled = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Bundled API', version: '1.0.0' },
      paths: {
        '/pets': {
          post: {
            operationId: 'createBundledPet',
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Pet' } }
              }
            },
            responses: {
              '201': {
                description: 'created',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } }
              }
            }
          }
        }
      },
      components: {
        schemas: {
          Pet: {
            type: 'object',
            properties: { name: { type: 'string', example: 'Bundled Fido' } },
            required: ['name']
          }
        }
      }
    });
    const source = readFileSync(
      new URL('../src/lib/spec/local-openapi-collection-generation.ts', import.meta.url),
      'utf8'
    );
    expect(source).not.toMatch(/node:(?:fs|os)|mkdtemp|tmpdir|writeFile|mkdir/i);

    const generated = await generateLocalOpenApiRolePayloads(bundled, {
      openApiVersion: '3.0',
      requestNameSource: 'Fallback',
      folderStrategy: 'Paths',
      names: {
        baseline: 'Bundled API',
        smoke: '[Smoke] Bundled API',
        contract: '[Contract] Bundled API'
      },
      contractIndex: indexFor(bundled)
    });
    expect(record(generated.roles.baseline.collection.info).name).toBe('Bundled API');
    expect(array(generated.roles.smoke.collection.item)[0]).toMatchObject({ name: '00 - Resolve Secrets' });
  });

  it('throws a typed conversion error with sanitized stage/cause and no secret leakage', async () => {
    await expect(
      generateLocalOpenApiRolePayloads('', {
        openApiVersion: '3.0',
        requestNameSource: 'Fallback',
        folderStrategy: 'Paths',
        names,
        contractIndex: indexFor(oas30)
      })
    ).rejects.toMatchObject({
      name: 'LocalOpenApiConversionError',
      code: LOCAL_OPENAPI_CONVERSION_FAILED,
      stage: 'validate-input'
    });

    const secretMarker = 'private-spec-marker-that-must-not-leak';
    const converter: LocalOpenApiConverter = (_input, _options, callback) => {
      callback(Object.assign(new Error(`${secretMarker} boom`), { message: `${secretMarker} boom` }));
    };
    const error = await generateLocalOpenApiRolePayloads(
      oas30.replace('Pet API', secretMarker),
      {
        openApiVersion: '3.0',
        requestNameSource: 'Fallback',
        folderStrategy: 'Paths',
        names,
        contractIndex: indexFor(oas30)
      },
      { converter }
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(LocalOpenApiConversionError);
    expect(error).toMatchObject({ stage: 'convert', code: LOCAL_OPENAPI_CONVERSION_FAILED });
    expect(String((error as Error).message)).toContain('converter callback failed');
  });

  it('keeps smoke helper scripts syntactically valid and digest-stable for identical payloads', () => {
    const exec = createSmokeTestExec().join('\n');
    assertParses('smoke-helper', exec);
    const instrumented = instrumentSmokeCollection({
      info: { name: 'x' },
      item: [{ name: 'GET /pets', request: { method: 'GET', url: 'https://example.test/pets' } }]
    });
    const again = instrumentSmokeCollection({
      info: { name: 'x' },
      item: [{ name: 'GET /pets', request: { method: 'GET', url: 'https://example.test/pets' } }]
    });
    expect(computePayloadDigest(instrumented)).toBe(computePayloadDigest(again));
  });

  it('passes only exact-parity converter options and omits nestedFolderHierarchy for Paths', async () => {
    const converter = vi.fn<LocalOpenApiConverter>((_input, options, callback) => {
      expect(options).toEqual({
        parametersResolution: 'Example',
        requestNameSource: 'URL',
        folderStrategy: 'Paths'
      });
      callback(null, {
        result: true,
        output: [
          {
            type: 'collection',
            data: {
              info: { name: 'tmp' },
              item: [
                {
                  name: 'pets',
                  item: [
                    {
                      name: 'create Bundled Pet',
                      request: {
                        method: 'POST',
                        url: { raw: 'https://example.test/pets', path: ['pets'] },
                        body: { mode: 'raw', raw: '{"name":"Bundled Fido"}' },
                        header: [{ key: 'Content-Type', value: 'application/json' }]
                      }
                    }
                  ]
                }
              ]
            }
          }
        ]
      });
    });

    const bundled = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Bundled API', version: '1.0.0' },
      paths: {
        '/pets': {
          post: {
            operationId: 'createBundledPet',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { name: { type: 'string' } },
                    required: ['name']
                  }
                }
              }
            },
            responses: {
              '201': {
                description: 'created',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { name: { type: 'string' } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    await generateLocalOpenApiRolePayloads(
      bundled,
      {
        openApiVersion: '3.0',
        requestNameSource: 'URL',
        folderStrategy: 'Paths',
        nestedFolderHierarchy: true,
        names: {
          baseline: 'Bundled API',
          smoke: '[Smoke] Bundled API',
          contract: '[Contract] Bundled API'
        },
        contractIndex: indexFor(bundled)
      },
      { converter }
    );
    expect(converter).toHaveBeenCalledOnce();
  });
});

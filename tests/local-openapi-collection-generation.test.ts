import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';

import { convertV2WithTypes } from 'openapi-to-postmanv2';
import converterSchemaFaker from 'openapi-to-postmanv2/assets/json-schema-faker.js';
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
import { compileSchemaValidator } from '../src/lib/spec/schema-validator-code.js';
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

function firstJsonRequestBody(collection: JsonRecord): unknown {
  const visit = (items: unknown): unknown => {
    if (!Array.isArray(items)) return undefined;
    for (const raw of items) {
      if (!isRecord(raw)) continue;
      if (raw.name === '00 - Resolve Secrets') continue;
      const request = isRecord(raw.request) ? raw.request : null;
      const body = request && isRecord(request.body) ? request.body : null;
      if (body?.mode === 'raw' && typeof body.raw === 'string') return JSON.parse(body.raw);
      const nested = visit(raw.item);
      if (nested !== undefined) return nested;
    }
    return undefined;
  };
  return visit(collection.item);
}

function firstRequestItem(collection: JsonRecord): JsonRecord {
  const visit = (items: unknown): JsonRecord | undefined => {
    if (!Array.isArray(items)) return undefined;
    for (const raw of items) {
      if (!isRecord(raw) || raw.name === '00 - Resolve Secrets') continue;
      if (isRecord(raw.request)) return raw;
      const nested = visit(raw.item);
      if (nested) return nested;
    }
    return undefined;
  };
  const item = visit(collection.item);
  expect(item).toBeDefined();
  return item!;
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

  it('repairs every replay of the converter nullable maxLength branches before role derivation', async () => {
    const bundled = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Units', version: '1.0.0' },
      servers: [{ url: 'https://example.test' }],
      paths: {
        '/units': {
          post: {
            operationId: 'createUnit',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { UomCode: { type: ['string', 'null'], maxLength: 4 } }
                  }
                }
              }
            },
            responses: { '200': { description: 'ok' } }
          }
        }
      }
    });
    const contractIndex = indexFor(bundled);
    const schema = contractIndex.operations[0]?.requestBody?.jsonSchemas?.['application/json'];
    const validate = compileSchemaValidator(schema);
    expect(validate).not.toBeNull();
    const converter = vi.fn(convertV2WithTypes);
    const baselineBodies: string[] = [];
    const digests: Record<'baseline' | 'smoke' | 'contract', string[]> = {
      baseline: [],
      smoke: [],
      contract: []
    };

    for (let run = 0; run < 30; run += 1) {
      const generated = await generateLocalOpenApiRolePayloads(bundled, {
        openApiVersion: '3.1',
        requestNameSource: 'Fallback',
        folderStrategy: 'Paths',
        names: { baseline: 'Units', smoke: '[Smoke] Units', contract: '[Contract] Units' },
        contractIndex
      }, { converter });
      for (const role of ['baseline', 'smoke', 'contract'] as const) {
        const body = firstJsonRequestBody(generated.roles[role].collection);
        expect(validate!(body)).toBe(true);
        if (role === 'baseline') baselineBodies.push(JSON.stringify(body));
        digests[role].push(generated.roles[role].payloadDigest);
      }
    }
    expect(converter).toHaveBeenCalledTimes(30);
    expect(new Set(baselineBodies).size).toBe(1);
    for (const role of ['baseline', 'smoke', 'contract'] as const) {
      expect(new Set(digests[role]).size).toBe(1);
    }
  });

  it('canonicalizes both raw nullable converter branches to one semantic body and digest', async () => {
    const bundled = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Branches', version: '1.0.0' },
      servers: [{ url: 'https://example.test' }],
      paths: {
        '/branches': {
          post: {
            operationId: 'createBranch',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { code: { type: ['string', 'null'], maxLength: 4 } }
                  }
                }
              }
            },
            responses: { '200': { description: 'ok' } }
          }
        }
      }
    });
    let conversion = 0;
    const converter: LocalOpenApiConverter = (_input, _options, callback) => {
      const code = conversion++ % 2 === 0 ? null : 'string';
      callback(null, {
        result: true,
        output: [{
          type: 'collection',
          data: {
            info: { name: 'Branches' },
            item: [{
              name: 'createBranch',
              request: {
                method: 'POST',
                url: { raw: 'https://example.test/branches', path: ['branches'] },
                header: [{ key: 'Content-Type', value: 'application/json' }],
                body: { mode: 'raw', raw: JSON.stringify({ code }) }
              }
            }]
          }
        }]
      });
    };
    const contractIndex = indexFor(bundled);
    const outputs = [];
    for (let run = 0; run < 4; run += 1) {
      outputs.push(await generateLocalOpenApiRolePayloads(bundled, {
        openApiVersion: '3.1',
        requestNameSource: 'Fallback',
        folderStrategy: 'Paths',
        names: { baseline: 'Branches', smoke: '[Smoke] Branches', contract: '[Contract] Branches' },
        contractIndex
      }, { converter }));
    }
    expect(new Set(outputs.map((output) => JSON.stringify(firstJsonRequestBody(output.roles.baseline.collection)))).size).toBe(1);
    for (const role of ['baseline', 'smoke', 'contract'] as const) {
      expect(new Set(outputs.map((output) => output.roles[role].payloadDigest)).size).toBe(1);
    }
  });

  it('repairs serialized path, query, and header parameters in requests and saved originalRequest copies', async () => {
    const bundled = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Parameters', version: '1.0.0' },
      servers: [{ url: 'https://example.test' }],
      paths: {
        '/things/{id}': {
          get: {
            operationId: 'getThing',
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'string', const: 'ok' } },
              { name: 'unit', in: 'query', schema: { type: ['string', 'null'], maxLength: 4 } },
              { name: 'count', in: 'query', schema: { type: 'number', minimum: 1, maximum: 5, multipleOf: 2 } },
              {
                name: 'tags',
                in: 'query',
                style: 'pipeDelimited',
                explode: false,
                schema: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string', pattern: '^[A-Z]$' } }
              },
              { name: 'X-Mode', in: 'header', schema: { type: 'string', const: 'safe' } }
            ],
            responses: { '200': { description: 'ok' } }
          }
        }
      }
    });
    const request = {
      method: 'GET',
      url: {
        raw: 'https://example.test/things/:id?unit=string&count=7&tags=bad|bad',
        path: ['things', ':id'],
        variable: [{ key: 'id', value: 'wrong' }],
        query: [
          { key: 'unit', value: 'string' },
          { key: 'count', value: '7' },
          { key: 'tags', value: 'bad|bad' }
        ]
      },
      header: [{ key: 'X-Mode', value: 'wrong' }]
    };
    const converter: LocalOpenApiConverter = (_input, _options, callback) => callback(null, {
      result: true,
      output: [{
        type: 'collection',
        data: {
          info: { name: 'Parameters' },
          item: [{
            name: 'getThing',
            request: structuredClone(request),
            response: [{
              name: 'ok',
              code: 200,
              status: 'OK',
              originalRequest: structuredClone(request),
              header: [],
              body: ''
            }]
          }]
        }
      }]
    });

    const generated = await generateLocalOpenApiRolePayloads(bundled, {
      openApiVersion: '3.1',
      requestNameSource: 'Fallback',
      folderStrategy: 'Paths',
      names: { baseline: 'Parameters', smoke: '[Smoke] Parameters', contract: '[Contract] Parameters' },
      contractIndex: indexFor(bundled)
    }, { converter });

    for (const role of ['baseline', 'smoke', 'contract'] as const) {
      const item = firstRequestItem(generated.roles[role].collection);
      const live = record(item.request);
      const saved = record(record(array(item.response)[0]).originalRequest);
      for (const repaired of [live, saved]) {
        const url = record(repaired.url);
        expect(record(array(url.variable)[0])).toMatchObject({ key: 'id', value: 'ok' });
        const query = array(url.query).map(record);
        expect(String(query.find((entry) => entry.key === 'unit')?.value ?? '').length).toBeLessThanOrEqual(4);
        expect(query.find((entry) => entry.key === 'count')?.value).toBe('4');
        expect(query.find((entry) => entry.key === 'tags')?.value).toMatch(/^[A-Z]\|[A-Z](?:\|[A-Z])?$/);
        expect(array(repaired.header).map(record).find((entry) => entry.key === 'X-Mode')?.value).toBe('safe');
      }
      expect(saved.url).toEqual(live.url);
      expect(saved.header).toEqual(live.header);
    }
  });

  it('keeps real converter parameters, saved requests, response bodies, and role digests stable', async () => {
    const bundled = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Real Examples', version: '1.0.0' },
      servers: [{ url: 'https://example.test' }],
      paths: {
        '/samples/{id}': {
          get: {
            operationId: 'getSample',
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Z]{2}$', minLength: 2, maxLength: 2 } },
              {
                name: 'tags',
                in: 'query',
                style: 'pipeDelimited',
                explode: false,
                schema: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string', pattern: '^[A-Z]$' } }
              },
              { name: 'X-Count', in: 'header', schema: { type: 'number', minimum: 1, maximum: 5, multipleOf: 2 } }
            ],
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['result'],
                      properties: { result: { type: ['string', 'null'], maxLength: 4 } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });
    const contractIndex = indexFor(bundled);
    const operation = contractIndex.operations[0]!;
    const checks = new Map((operation.parameterChecks ?? []).map((check) => [check.name, check]));
    const responseSchema = operation.responses['200']!.content['application/json']!.schema;
    const responseValidate = compileSchemaValidator(responseSchema);
    const digests: Record<'baseline' | 'smoke' | 'contract', string[]> = { baseline: [], smoke: [], contract: [] };

    for (let run = 0; run < 6; run += 1) {
      const generated = await generateLocalOpenApiRolePayloads(bundled, {
        openApiVersion: '3.1',
        requestNameSource: 'Fallback',
        folderStrategy: 'Paths',
        names: { baseline: 'Real Examples', smoke: '[Smoke] Real Examples', contract: '[Contract] Real Examples' },
        contractIndex
      });
      for (const role of ['baseline', 'smoke', 'contract'] as const) {
        digests[role].push(generated.roles[role].payloadDigest);
        const item = firstRequestItem(generated.roles[role].collection);
        const live = record(item.request);
        const savedResponse = record(array(item.response)[0]);
        const saved = record(savedResponse.originalRequest);
        for (const repaired of [live, saved]) {
          const url = record(repaired.url);
          const id = String(record(array(url.variable)[0]).value);
          expect(compileSchemaValidator(checks.get('id')!.schema)!(id)).toBe(true);
          const tags = String(array(url.query).map(record).find((entry) => entry.key === 'tags')?.value ?? '').split('|');
          expect(compileSchemaValidator(checks.get('tags')!.schema)!(tags)).toBe(true);
          const count = Number(array(repaired.header).map(record).find((entry) => entry.key === 'X-Count')?.value);
          expect(compileSchemaValidator(checks.get('X-Count')!.schema)!(count)).toBe(true);
        }
        expect(saved.url).toEqual(live.url);
        expect(saved.header).toEqual(live.header);
        expect(responseValidate!(JSON.parse(String(savedResponse.body)))).toBe(true);
      }
    }
    for (const role of ['baseline', 'smoke', 'contract'] as const) {
      expect(new Set(digests[role]).size).toBe(1);
    }
  });

  it('repairs saved JSON response bodies with response-direction schemas', async () => {
    const bundled = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Responses', version: '1.0.0' },
      servers: [{ url: 'https://example.test' }],
      paths: {
        '/responses': {
          get: {
            operationId: 'getResponse',
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['result', 'nested'],
                      properties: {
                        result: { type: ['string', 'null'], maxLength: 4 },
                        nested: { $ref: '#/components/schemas/SavedNested' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      components: {
        schemas: {
          SavedNested: {
            type: 'object',
            required: ['visible'],
            properties: {
              visible: { type: 'string' },
              secret: { type: 'string', writeOnly: true }
            }
          }
        }
      }
    });
    const request = { method: 'GET', url: { raw: 'https://example.test/responses', path: ['responses'] }, header: [] };
    const converter: LocalOpenApiConverter = (_input, _options, callback) => callback(null, {
      result: true,
      output: [{
        type: 'collection',
        data: {
          info: { name: 'Responses' },
          item: [{
            name: 'getResponse',
            request,
            response: [{
              name: 'ok',
              code: 200,
              status: 'OK',
              originalRequest: structuredClone(request),
              header: [{ key: 'Content-Type', value: 'application/json' }],
              body: JSON.stringify({ result: 'string', nested: { visible: 'yes', secret: 'remove-me' } })
            }]
          }]
        }
      }]
    });
    const contractIndex = indexFor(bundled);
    const generated = await generateLocalOpenApiRolePayloads(bundled, {
      openApiVersion: '3.1',
      requestNameSource: 'Fallback',
      folderStrategy: 'Paths',
      names: { baseline: 'Responses', smoke: '[Smoke] Responses', contract: '[Contract] Responses' },
      contractIndex
    }, { converter });
    const schema = contractIndex.operations[0]!.responses['200']!.content['application/json']!.schema;
    const validate = compileSchemaValidator(schema);
    expect(validate).not.toBeNull();
    for (const role of ['baseline', 'smoke', 'contract'] as const) {
      const saved = record(array(firstRequestItem(generated.roles[role].collection).response)[0]);
      const body = JSON.parse(String(saved.body)) as JsonRecord;
      expect(validate!(body)).toBe(true);
      expect(record(body.nested)).toEqual({ visible: 'yes' });
    }
  });

  it('removes nested and referenced readOnly request properties while preserving writeOnly values', async () => {
    const explicit = { nested: { visible: 'yes', readId: 'remove-me', writeSecret: 'keep-me' } };
    const bundled = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Direction', version: '1.0.0' },
      servers: [{ url: 'https://example.test' }],
      paths: {
        '/direction': {
          post: {
            operationId: 'createDirection',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['nested'],
                    properties: { nested: { $ref: '#/components/schemas/RequestNested' } }
                  },
                  example: explicit
                }
              }
            },
            responses: { '200': { description: 'ok' } }
          }
        }
      },
      components: {
        schemas: {
          RequestNested: {
            type: 'object',
            required: ['visible', 'readId', 'writeSecret'],
            properties: {
              visible: { type: 'string' },
              readId: { type: 'string', readOnly: true },
              writeSecret: { type: 'string', writeOnly: true }
            }
          }
        }
      }
    });
    const request = {
      method: 'POST',
      url: { raw: 'https://example.test/direction', path: ['direction'] },
      header: [{ key: 'Content-Type', value: 'application/json' }],
      body: { mode: 'raw', raw: JSON.stringify(explicit) }
    };
    const converter: LocalOpenApiConverter = (_input, _options, callback) => callback(null, {
      result: true,
      output: [{
        type: 'collection',
        data: {
          info: { name: 'Direction' },
          item: [{
            name: 'createDirection',
            request: structuredClone(request),
            response: [0, 1].map((index) => ({
              name: `ok-${index}`,
              code: 200,
              status: 'OK',
              originalRequest: structuredClone(request),
              header: [],
              body: ''
            }))
          }]
        }
      }]
    });
    const generated = await generateLocalOpenApiRolePayloads(bundled, {
      openApiVersion: '3.1',
      requestNameSource: 'Fallback',
      folderStrategy: 'Paths',
      names: { baseline: 'Direction', smoke: '[Smoke] Direction', contract: '[Contract] Direction' },
      contractIndex: indexFor(bundled)
    }, { converter });
    for (const role of ['baseline', 'smoke', 'contract'] as const) {
      const expected = {
        nested: { visible: 'yes', writeSecret: 'keep-me' }
      };
      const item = firstRequestItem(generated.roles[role].collection);
      expect(firstJsonRequestBody(generated.roles[role].collection)).toEqual(expected);
      for (const saved of array(item.response).map(record)) {
        const originalRequest = record(saved.originalRequest);
        expect(JSON.parse(String(record(originalRequest.body).raw))).toEqual(expected);
      }
    }
  });

  it('proves satisfiable pattern, format, uniqueItems, oneOf, and allOf repairs and omits optional impossibilities', async () => {
    const bundled = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Candidates', version: '1.0.0' },
      servers: [{ url: 'https://example.test' }],
      paths: {
        '/candidates': {
          post: {
            operationId: 'createCandidates',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['explicit', 'patterned', 'formatted', 'unique', 'overlap', 'intersection'],
                    properties: {
                      explicit: { type: 'string', example: 'kept' },
                      patterned: { type: 'string', pattern: '^[A-Z]{4}$', minLength: 4, maxLength: 4 },
                      formatted: { type: 'string', format: 'email', minLength: 6, maxLength: 12 },
                      unique: {
                        type: 'array',
                        minItems: 3,
                        maxItems: 3,
                        uniqueItems: true,
                        items: { type: 'string', pattern: '^[A-C]$' }
                      },
                      overlap: {
                        oneOf: [
                          { type: 'string', enum: ['a', 'b'] },
                          { type: 'string', enum: ['b', 'c'] }
                        ]
                      },
                      intersection: {
                        allOf: [
                          { type: 'string', enum: ['a', 'b'] },
                          { type: 'string', enum: ['b', 'c'] }
                        ]
                      },
                      optionalImpossible: { type: 'string', pattern: '^A$', minLength: 2 }
                    }
                  }
                }
              }
            },
            responses: { '200': { description: 'ok' } }
          }
        }
      }
    });
    const converter: LocalOpenApiConverter = (_input, _options, callback) => callback(null, {
      result: true,
      output: [{
        type: 'collection',
        data: {
          info: { name: 'Candidates' },
          item: [{
            name: 'createCandidates',
            request: {
              method: 'POST',
              url: { raw: 'https://example.test/candidates', path: ['candidates'] },
              header: [{ key: 'Content-Type', value: 'application/json' }],
              body: {
                mode: 'raw',
                raw: JSON.stringify({
                  explicit: 'kept',
                  patterned: 'bad',
                  formatted: 'bad',
                  unique: ['A', 'A'],
                  overlap: false,
                  intersection: 'a',
                  optionalImpossible: 'bad'
                })
              }
            }
          }]
        }
      }]
    });
    const contractIndex = indexFor(bundled);
    const generated = await generateLocalOpenApiRolePayloads(bundled, {
      openApiVersion: '3.1',
      requestNameSource: 'Fallback',
      folderStrategy: 'Paths',
      names: { baseline: 'Candidates', smoke: '[Smoke] Candidates', contract: '[Contract] Candidates' },
      contractIndex
    }, { converter });
    const body = firstJsonRequestBody(generated.roles.baseline.collection) as JsonRecord;
    const validate = compileSchemaValidator(contractIndex.operations[0]!.requestBody!.jsonSchemas!['application/json']);
    expect(validate!(body)).toBe(true);
    expect(body.explicit).toBe('kept');
    expect(body).not.toHaveProperty('optionalImpossible');
  });

  it('reports an invalid source-authored media example distinctly instead of rewriting it', async () => {
    const authored = { code: 'bbb' };
    const bundled = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Authored', version: '1.0.0' },
      servers: [{ url: 'https://example.test' }],
      paths: {
        '/authored': {
          post: {
            operationId: 'createAuthored',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['code'],
                    properties: { code: { type: 'string', pattern: '^A+$' } }
                  },
                  example: authored
                }
              }
            },
            responses: { '200': { description: 'ok' } }
          }
        }
      }
    });
    const converter: LocalOpenApiConverter = (_input, _options, callback) => callback(null, {
      result: true,
      output: [{
        type: 'collection',
        data: {
          info: { name: 'Authored' },
          item: [{
            name: 'createAuthored',
            request: {
              method: 'POST',
              url: { raw: 'https://example.test/authored', path: ['authored'] },
              header: [{ key: 'Content-Type', value: 'application/json' }],
              body: { mode: 'raw', raw: JSON.stringify(authored) }
            }
          }]
        }
      }]
    });
    await expect(generateLocalOpenApiRolePayloads(bundled, {
      openApiVersion: '3.1',
      requestNameSource: 'Fallback',
      folderStrategy: 'Paths',
      names: { baseline: 'Authored', smoke: '[Smoke] Authored', contract: '[Contract] Authored' },
      contractIndex: indexFor(bundled)
    }, { converter })).rejects.toMatchObject({
      stage: 'repair-request-examples',
      sanitizedCause: expect.stringContaining('SOURCE_AUTHORED_EXAMPLE_SCHEMA_MISMATCH')
    });
  });

  it('serializes concurrent faker access and restores the prior random source after async failures', async () => {
    const bundled = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Concurrency', version: '1.0.0' },
      paths: { '/health': { get: { operationId: 'health', responses: { '200': { description: 'ok' } } } } }
    });
    const contractIndex = indexFor(bundled);
    const sentinel = () => 0.125;
    const originalRandom = converterSchemaFaker.option('random');
    converterSchemaFaker.option({ random: sentinel });
    let active = 0;
    let maxActive = 0;
    let invocation = 0;
    const converter: LocalOpenApiConverter = (_input, _options, callback) => {
      const current = invocation++;
      active += 1;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        active -= 1;
        if (current === 0) {
          callback(new Error('async conversion failure'));
          return;
        }
        callback(null, {
          result: true,
          output: [{
            type: 'collection',
            data: {
              info: { name: 'Concurrency' },
              item: [{ name: 'health', request: { method: 'GET', url: { path: ['health'] } } }]
            }
          }]
        });
      }, current === 0 ? 5 : 20);
    };
    const options = {
      openApiVersion: '3.1' as const,
      requestNameSource: 'Fallback' as const,
      folderStrategy: 'Paths' as const,
      names: { baseline: 'Concurrency', smoke: '[Smoke] Concurrency', contract: '[Contract] Concurrency' },
      contractIndex
    };
    try {
      const results = await Promise.allSettled([
        generateLocalOpenApiRolePayloads(bundled, options, { converter }),
        generateLocalOpenApiRolePayloads(bundled, options, { converter })
      ]);
      expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
      expect(maxActive).toBe(1);
      expect(converterSchemaFaker.option('random')).toBe(sentinel);

      const throwingConverter: LocalOpenApiConverter = () => {
        throw new Error('synchronous conversion failure');
      };
      await expect(generateLocalOpenApiRolePayloads(bundled, options, {
        converter: throwingConverter
      })).rejects.toMatchObject({ stage: 'convert' });
      expect(converterSchemaFaker.option('random')).toBe(sentinel);
    } finally {
      converterSchemaFaker.option({ random: originalRandom });
    }
  });

  it('repairs safely constrained generated JSON values and preserves valid examples and defaults', async () => {
    const bundled = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Constraints', version: '1.0.0' },
      servers: [{ url: 'https://example.test' }],
      paths: {
        '/constraints': {
          post: {
            operationId: 'createConstraints',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['explicit', 'defaulted', 'requiredObject', 'secret', 'merged'],
                    properties: {
                      explicit: { type: 'string', minLength: 4, example: 'kept' },
                      defaulted: { type: 'integer', minimum: 0, default: 8 },
                      short: { type: 'string', minLength: 4 },
                      long: { type: 'string', maxLength: 4 },
                      patterned: { type: 'string', pattern: '^[A-Z]{2}[0-9]{2}$', enum: ['AB12'] },
                      formatted: { type: 'string', format: 'email' },
                      bounded: { type: 'number', minimum: 1, exclusiveMaximum: 5, multipleOf: 0.5 },
                      whole: { type: 'integer', exclusiveMinimum: 2, maximum: 4 },
                      few: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'integer', minimum: 1 } },
                      many: { type: 'array', maxItems: 2, items: { type: 'string' } },
                      requiredObject: {
                        type: 'object',
                        required: ['needed'],
                        properties: { needed: { type: 'string', enum: ['present'] } }
                      },
                      readOnlyValue: { type: 'string', readOnly: true },
                      secret: { type: 'string', writeOnly: true, minLength: 3 },
                      nullable: { type: ['string', 'null'], maxLength: 4, example: null },
                      nullableLong: { type: ['string', 'null'], maxLength: 4 },
                      choice: { oneOf: [{ type: 'string', enum: ['choice'] }, { type: 'integer', minimum: 10 }] },
                      flexible: { anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['flex'] }] },
                      merged: {
                        allOf: [
                          { type: 'object', required: ['a'], properties: { a: { type: 'string', enum: ['A'] } } },
                          { type: 'object', required: ['b'], properties: { b: { type: 'string', minLength: 2 } } }
                        ]
                      }
                    }
                  }
                }
              }
            },
            responses: { '200': { description: 'ok' } }
          }
        }
      }
    });
    const contractIndex = indexFor(bundled);
    const invalidBody = {
      explicit: 'kept',
      defaulted: 8,
      short: 'x',
      long: 'string',
      patterned: 'bad',
      formatted: 'bad',
      bounded: 7.3,
      whole: 2,
      few: [0],
      many: ['a', 'b', 'c'],
      readOnlyValue: 'remove-me',
      secret: 'keep-me',
      nullable: null,
      nullableLong: 'string',
      choice: false,
      flexible: 42,
      merged: {}
    };
    const converter: LocalOpenApiConverter = (_input, _options, callback) => callback(null, {
      result: true,
      output: [{
        type: 'collection',
        data: {
          info: { name: 'Constraints' },
          item: [{
            name: 'constraints',
            item: [{
              name: 'createConstraints',
              request: {
                method: 'POST',
                url: { raw: 'https://example.test/constraints', path: ['constraints'] },
                header: [{ key: 'Content-Type', value: 'application/json' }],
                body: { mode: 'raw', raw: JSON.stringify(invalidBody) }
              }
            }]
          }]
        }
      }]
    });

    const generated = await generateLocalOpenApiRolePayloads(bundled, {
      openApiVersion: '3.1',
      requestNameSource: 'Fallback',
      folderStrategy: 'Paths',
      names: { baseline: 'Constraints', smoke: '[Smoke] Constraints', contract: '[Contract] Constraints' },
      contractIndex
    }, { converter });
    const schema = contractIndex.operations[0]?.requestBody?.jsonSchemas?.['application/json'];
    const validate = compileSchemaValidator(schema);
    expect(validate).not.toBeNull();
    const bodies = (['baseline', 'smoke', 'contract'] as const)
      .map((role) => firstJsonRequestBody(generated.roles[role].collection));
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    for (const body of bodies) expect(validate!(body)).toBe(true);
    expect(bodies[0]).toMatchObject({ explicit: 'kept', defaulted: 8, secret: 'keep-me', nullable: null });
    expect(bodies[0]).not.toHaveProperty('readOnlyValue');
  });

  it('fails explicitly before role materialization when a required schema is unsatisfiable', async () => {
    const bundled = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Pattern', version: '1.0.0' },
      servers: [{ url: 'https://example.test' }],
      paths: {
        '/pattern': {
          post: {
            operationId: 'createPattern',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['code'],
                    properties: { code: { type: 'string', pattern: '^A$', minLength: 2 } }
                  }
                }
              }
            },
            responses: { '200': { description: 'ok' } }
          }
        }
      }
    });
    const converter: LocalOpenApiConverter = (_input, _options, callback) => callback(null, {
      result: true,
      output: [{
        type: 'collection',
        data: {
          info: { name: 'Pattern' },
          item: [{
            name: 'createPattern',
            request: {
              method: 'POST',
              url: { raw: 'https://example.test/pattern', path: ['pattern'] },
              header: [{ key: 'Content-Type', value: 'application/json' }],
              body: { mode: 'raw', raw: JSON.stringify({ code: 'bbb' }) }
            }
          }]
        }
      }]
    });

    await expect(generateLocalOpenApiRolePayloads(bundled, {
      openApiVersion: '3.0',
      requestNameSource: 'Fallback',
      folderStrategy: 'Paths',
      names: { baseline: 'Pattern', smoke: '[Smoke] Pattern', contract: '[Contract] Pattern' },
      contractIndex: indexFor(bundled)
    }, { converter })).rejects.toMatchObject({
      code: LOCAL_OPENAPI_CONVERSION_FAILED,
      stage: 'repair-request-examples',
      sanitizedCause: expect.stringContaining('could not be safely repaired')
    });
  });
});

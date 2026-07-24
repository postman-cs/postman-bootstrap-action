import { validator } from '@exodus/schemasafe';
import { describe, expect, it } from 'vitest';

import { buildContractIndex } from '../src/lib/spec/contract-index.js';
import { generateLocalOpenApiRolePayloads } from '../src/lib/spec/local-openapi-collection-generation.js';
import { parseOpenApiDocument } from '../src/lib/spec/openapi-loader.js';

type JsonRecord = Record<string, unknown>;

const names = { baseline: 'API', smoke: '[Smoke] API', contract: '[Contract] API' };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Independent oracle. isJSON is deliberately false and the value is round-tripped
// through JSON so the assertion sees the bytes the collection actually ships:
// an in-memory `undefined` array hole serializes to `null`, which most schemas reject.
function assertShippedValueValid(schema: unknown, value: unknown, label: string): void {
  const dialected = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    ...(schema as Record<string, unknown>)
  };
  const validate = validator(dialected as Parameters<typeof validator>[0], {
    includeErrors: true,
    allErrors: true,
    allowUnusedKeywords: true,
    formatAssertion: true,
    isJSON: false,
    mode: 'default',
    requireSchema: true,
    requireStringValidation: false
  });
  const shipped = JSON.parse(JSON.stringify(value)) as unknown;
  const ok = validate(shipped as Parameters<typeof validate>[0]);
  expect(
    ok,
    `${label} must satisfy its own OpenAPI schema; shipped ${JSON.stringify(shipped)} errors ${JSON.stringify(validate.errors ?? [])}`
  ).toBe(true);
}

async function generate(spec: JsonRecord, openApiVersion: '3.0' | '3.1'): Promise<JsonRecord> {
  const bundled = JSON.stringify(spec);
  const result = await generateLocalOpenApiRolePayloads(bundled, {
    openApiVersion,
    requestNameSource: 'Fallback',
    folderStrategy: 'Paths',
    names,
    contractIndex: buildContractIndex(parseOpenApiDocument(bundled))
  });
  return result.roles.baseline.collection;
}

function collectRequests(node: unknown, out: JsonRecord[] = []): JsonRecord[] {
  if (!isRecord(node)) return out;
  if (isRecord(node.request)) out.push(node.request);
  for (const child of Array.isArray(node.item) ? node.item : []) collectRequests(child, out);
  return out;
}

function requestsOf(collection: JsonRecord): JsonRecord[] {
  return collectRequests({ item: collection.item });
}

function rawBody(request: JsonRecord): unknown {
  const body = isRecord(request.body) ? request.body : {};
  expect(typeof body.raw, `request ${JSON.stringify(request.url)} must carry a raw body`).toBe('string');
  return JSON.parse(body.raw as string);
}

function formPairs(request: JsonRecord, mode: 'urlencoded' | 'formdata'): JsonRecord {
  const body = isRecord(request.body) ? request.body : {};
  const entries = Array.isArray(body[mode]) ? (body[mode] as unknown[]).filter(isRecord) : [];
  expect(entries.length, `request must carry ${mode} entries`).toBeGreaterThan(0);
  return Object.fromEntries(entries.map((entry) => [String(entry.key), entry.value]));
}

function queryValue(request: JsonRecord, key: string): unknown {
  const url = isRecord(request.url) ? request.url : {};
  const query = Array.isArray(url.query) ? url.query.filter(isRecord) : [];
  const hit = query.find((entry) => String(entry.key).toLowerCase() === key.toLowerCase());
  expect(hit, `query parameter ${key} must be emitted`).toBeDefined();
  return hit?.value;
}

function headerValue(request: JsonRecord, key: string): unknown {
  const headers = Array.isArray(request.header) ? request.header.filter(isRecord) : [];
  const hit = headers.find((entry) => String(entry.key).toLowerCase() === key.toLowerCase());
  expect(hit, `header ${key} must be emitted`).toBeDefined();
  return hit?.value;
}

describe('generated request examples satisfy their own OpenAPI schemas', () => {
  it('repairs OpenAPI 3.1 webhook request bodies', async () => {
    const webhookSchema = {
      type: 'object',
      required: ['code', 'kind'],
      properties: {
        code: { type: 'string', minLength: 12, maxLength: 24 },
        kind: { const: 'ping-event' },
        ratio: { type: 'number', exclusiveMinimum: 10, maximum: 20 }
      }
    };
    const collection = await generate(
      {
        openapi: '3.1.0',
        info: { title: 'Hook API', version: '1.0.0' },
        paths: {
          '/ping': {
            get: { operationId: 'ping', responses: { '200': { description: 'ok' } } }
          }
        },
        webhooks: {
          pinged: {
            post: {
              operationId: 'pinged',
              requestBody: { required: true, content: { 'application/json': { schema: webhookSchema } } },
              responses: { '200': { description: 'ok' } }
            }
          }
        }
      },
      '3.1'
    );

    const webhook = requestsOf(collection).find((request) => String(request.method).toUpperCase() === 'POST');
    expect(webhook, 'converter must emit the webhook request item').toBeDefined();
    assertShippedValueValid(webhookSchema, rawBody(webhook as JsonRecord), 'webhook request body');
  });

  it('repairs urlencoded form request bodies', async () => {
    const schema = {
      type: 'object',
      required: ['kind', 'code'],
      properties: {
        kind: { const: 'fixed-kind' },
        code: { type: 'string', minLength: 12, maxLength: 20 }
      }
    };
    const collection = await generate(
      {
        openapi: '3.1.0',
        info: { title: 'Form API', version: '1.0.0' },
        paths: {
          '/form': {
            post: {
              operationId: 'submitForm',
              requestBody: {
                required: true,
                content: { 'application/x-www-form-urlencoded': { schema } }
              },
              responses: { '200': { description: 'ok' } }
            }
          }
        }
      },
      '3.1'
    );

    const request = requestsOf(collection)[0] as JsonRecord;
    assertShippedValueValid(schema, formPairs(request, 'urlencoded'), 'urlencoded request body');
  });

  it('repairs multipart form request bodies', async () => {
    const schema = {
      type: 'object',
      required: ['kind', 'code'],
      properties: {
        kind: { const: 'fixed-part' },
        code: { type: 'string', minLength: 12, maxLength: 20 }
      }
    };
    const collection = await generate(
      {
        openapi: '3.1.0',
        info: { title: 'Multipart API', version: '1.0.0' },
        paths: {
          '/parts': {
            post: {
              operationId: 'submitParts',
              requestBody: { required: true, content: { 'multipart/form-data': { schema } } },
              responses: { '200': { description: 'ok' } }
            }
          }
        }
      },
      '3.1'
    );

    const request = requestsOf(collection)[0] as JsonRecord;
    assertShippedValueValid(schema, formPairs(request, 'formdata'), 'multipart request body');
  });

  it('repairs typeless const and enum parameters', async () => {
    const kindSchema = { const: 'only-this' };
    const gradeSchema = { enum: ['alpha', 'beta'] };
    const tokenSchema = { const: 'fixed-token' };
    const collection = await generate(
      {
        openapi: '3.1.0',
        info: { title: 'Param API', version: '1.0.0' },
        paths: {
          '/things': {
            get: {
              operationId: 'listThings',
              parameters: [
                { name: 'kind', in: 'query', required: true, schema: kindSchema },
                { name: 'grade', in: 'query', required: true, schema: gradeSchema },
                { name: 'X-Token', in: 'header', required: true, schema: tokenSchema }
              ],
              responses: { '200': { description: 'ok' } }
            }
          }
        }
      },
      '3.1'
    );

    const request = requestsOf(collection)[0] as JsonRecord;
    assertShippedValueValid(kindSchema, queryValue(request, 'kind'), 'query parameter kind');
    assertShippedValueValid(gradeSchema, queryValue(request, 'grade'), 'query parameter grade');
    assertShippedValueValid(tokenSchema, headerValue(request, 'X-Token'), 'header parameter X-Token');
  });

  it('repairs arrays constrained by contains and minContains', async () => {
    const schema = {
      type: 'object',
      required: ['xs'],
      properties: {
        xs: {
          type: 'array',
          minItems: 2,
          contains: { type: 'integer', minimum: 5 },
          minContains: 2
        }
      }
    };
    const collection = await generate(
      {
        openapi: '3.1.0',
        info: { title: 'Contains API', version: '1.0.0' },
        paths: {
          '/things': {
            post: {
              operationId: 'createThing',
              requestBody: { required: true, content: { 'application/json': { schema } } },
              responses: { '200': { description: 'ok' } }
            }
          }
        }
      },
      '3.1'
    );

    const request = requestsOf(collection)[0] as JsonRecord;
    assertShippedValueValid(schema, rawBody(request), 'contains request body');
  });

  it('repairs nested arrays constrained only by contains', async () => {
    const schema = {
      type: 'object',
      required: ['matrix'],
      properties: {
        matrix: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'array',
            minItems: 1,
            contains: { type: 'string', pattern: '^ok-[a-z]{3}$' }
          }
        }
      }
    };
    const collection = await generate(
      {
        openapi: '3.1.0',
        info: { title: 'Nested Contains API', version: '1.0.0' },
        paths: {
          '/matrix': {
            post: {
              operationId: 'createMatrix',
              requestBody: { required: true, content: { 'application/json': { schema } } },
              responses: { '200': { description: 'ok' } }
            }
          }
        }
      },
      '3.1'
    );

    const request = requestsOf(collection)[0] as JsonRecord;
    assertShippedValueValid(schema, rawBody(request), 'nested contains request body');
  });
});

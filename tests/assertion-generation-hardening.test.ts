import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { instrumentContractCollection, matchOperation } from '../src/lib/spec/collection-contracts.js';
import { buildContractIndex } from '../src/lib/spec/contract-index.js';
import { parseOpenApiDocument } from '../src/lib/spec/openapi-loader.js';
import { parseGraphQLSchema } from '../src/lib/protocols/graphql/parser.js';
import { buildGraphQLCollection } from '../src/lib/protocols/graphql/builder.js';
import { instrumentGraphQLCollection } from '../src/lib/protocols/graphql/instrumenter.js';
import { parseWsdl } from '../src/lib/protocols/soap/parser.js';
import { buildSoapCollection } from '../src/lib/protocols/soap/builder.js';
import { instrumentSoapCollection } from '../src/lib/protocols/soap/instrumenter.js';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';
import type { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';

type JsonRecord = Record<string, unknown>;

const fixture = (rel: string): string =>
  readFileSync(resolve(import.meta.dirname, '../fixtures', rel), 'utf8');

// Regression coverage for the unifusion-panel audit defects (2026-06-30):
// the generated pm.test assertions must never false-fail, false-pass, or mismatch.

describe('assertion generation hardening (panel defects)', () => {
  // Defect #2: validateScript over-broad /\beval\b/ hard-failed any spec that
  // merely carried the token "eval" as data. It must now allow eval-as-data and
  // only reject an executable eval( / new Function( call.
  it('does not false-fail when a spec path carries the token "eval" as data', () => {
    const spec = [
      'openapi: 3.0.3',
      "info: { title: t, version: '1.0.0' }",
      'paths:',
      '  /eval:',
      '    get:',
      '      responses:',
      "        '200': { description: ok }"
    ].join('\n');
    const index = buildContractIndex(parseOpenApiDocument(spec));
    const collection = { item: [{ name: 'GET eval', request: { method: 'GET', url: { path: ['eval'] } } }] };
    let result: ReturnType<typeof instrumentContractCollection> | undefined;
    expect(() => {
      result = instrumentContractCollection(collection, index);
    }).not.toThrow();
    // instrumentContractCollection unshifts a "00 - Resolve Secrets" item at index 0,
    // so select the actual request item (not the injected resolver).
    const items = result!.collection.item as Array<{ name?: string; event?: Array<{ listen: string; script: { exec: string[] } }> }>;
    const target = items.find((it) => it.name !== '00 - Resolve Secrets')!;
    const script = target.event!.find((e) => e.listen === 'test')!.script.exec.join('\n');
    expect(script).toContain('/eval');
    expect(/\beval\s*\(/.test(script)).toBe(false);
  });

  // Defect #3: a path segment mixing a template with literal text
  // (e.g. /reports/{id}.json) failed to match a concrete request path, so a valid
  // request wrongly got the fail-closed mapping error instead of its contract.
  it('matches a compound path-template segment against a concrete request path', () => {
    const spec = [
      'openapi: 3.0.3',
      "info: { title: t, version: '1.0.0' }",
      'paths:',
      '  /reports/{id}.json:',
      '    get:',
      '      parameters:',
      '        - { name: id, in: path, required: true, schema: { type: string } }',
      '      responses:',
      "        '200': { description: ok }"
    ].join('\n');
    const index = buildContractIndex(parseOpenApiDocument(spec));
    const match = matchOperation(index, { method: 'GET', url: { path: ['reports', '42.json'] } });
    expect(match.operation, 'compound segment should match the concrete path').toBeDefined();
    expect(match.operation?.path).toBe('/reports/{id}.json');
  });

  // Defect #1: the smoke "Response body is not empty" assertion only skipped 204,
  // so a legitimate bodyless response (205, 304, or any HEAD) falsely failed.
  it('smoke body assertion skips all bodyless responses (204/205/304/HEAD)', async () => {
    const captured: string[] = [];
    const fakeGateway = {
      requestJson: async (request: JsonRecord) => {
        const method = String(request.method ?? '');
        const path = String(request.path ?? '');
        if (method === 'get' && path.includes('/items/')) {
          return {
            data: [
              { $kind: 'http-request', id: 'i1', name: 'HEAD /ping' },
              { $kind: 'http-request', id: 'i2', name: '00 - Resolve Secrets' }
            ]
          };
        }
        if (method === 'patch') {
          const patch = Array.isArray(request.body) ? (request.body[0] as JsonRecord) : undefined;
          if (patch && patch.path === '/scripts' && Array.isArray(patch.value)) {
            for (const script of patch.value as JsonRecord[]) {
              if (typeof script.code === 'string') captured.push(script.code);
            }
          }
          return { data: {} };
        }
        return { data: {} };
      }
    };
    const client = new PostmanGatewayAssetsClient({
      gateway: fakeGateway as unknown as AccessTokenGatewayClient
    });
    await client.injectTests('owner-abc123def456', 'smoke');
    const smoke = captured.join('\n');
    expect(smoke).toContain('pm.response.code === 205');
    expect(smoke).toContain('pm.response.code === 304');
    expect(smoke).toContain("pm.request.method === 'HEAD'");
    // Status check accepts 2xx AND 3xx (a redirect is not an error), and an
    // explicit Content-Length: 0 exempts the not-empty check - neither false-fails.
    expect(smoke).toContain('to.be.below(400)');
    expect(smoke).toContain("pm.response.headers.get('Content-Length')");
  });

  // Defect #4: an unmatched GraphQL item was left silently uninstrumented (a
  // zero-assertion pass in Newman). It must now carry a fail-closed pm.expect.fail.
  it('attaches a fail-closed assertion to an unmatched GraphQL item', () => {
    const index = parseGraphQLSchema(fixture('graphql/telecom.graphql'), { service: 'Telecom' });
    const collection = buildGraphQLCollection(index, { url: '{{baseUrl}}/graphql' }) as unknown as {
      item: Array<Record<string, unknown>>;
    };
    collection.item.push({
      id: 'query.bogus',
      name: 'query bogus',
      request: { method: 'POST', body: { mode: 'graphql', graphql: { query: '', variables: '' } } },
      event: []
    });
    const { collection: out, warnings } = instrumentGraphQLCollection(collection as Record<string, unknown>, index);
    expect(warnings.some((w) => w.startsWith('PROTO_ITEM_UNMATCHED'))).toBe(true);
    const bogus = (out.item as Array<Record<string, unknown>>).find((i) => i.id === 'query.bogus')!;
    const test = (bogus.event as Array<{ listen: string; script: { exec: string[] } }>).find((e) => e.listen === 'test')!;
    expect(test.script.exec.join('\n')).toContain('pm.expect.fail');
  });

  // Defect #4 (SOAP): an unmatched SOAP request was left without assertions (a
  // silent pass). It must now carry a fail-closed pm.expect.fail.
  it('attaches a fail-closed assertion to an unmatched SOAP item', () => {
    const index = parseWsdl(fixture('soap/stockquote.wsdl'));
    const built = buildSoapCollection(index) as unknown as { item: Array<Record<string, unknown>> };
    const folder = built.item[0]!;
    (folder.item as Array<Record<string, unknown>>).push({
      name: 'Ghost',
      request: { method: 'POST', body: { mode: 'raw', raw: '' } },
      event: []
    });
    const { collection: out, warnings } = instrumentSoapCollection(built as unknown as Record<string, unknown>, index);
    expect(warnings.join('\n')).toMatch(/SOAP_ITEM_UNMATCHED: request "Ghost"/);
    const outFolder = (out.item as Array<Record<string, unknown>>)[0]!;
    const ghost = (outFolder.item as Array<Record<string, unknown>>).find((i) => i.name === 'Ghost')!;
    const test = (ghost.event as Array<{ listen: string; script: { exec: string[] } }>).find((e) => e.listen === 'test')!;
    expect(test.script.exec.join('\n')).toContain('pm.expect.fail');
  });
});

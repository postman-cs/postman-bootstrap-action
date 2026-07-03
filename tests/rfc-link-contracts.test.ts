import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import { createContractScript } from '../src/lib/spec/collection-contracts.js';
import { buildContractIndex } from '../src/lib/spec/contract-index.js';
import { parseOpenApiDocument } from '../src/lib/spec/openapi-loader.js';

function indexFrom(spec: string) {
  return buildContractIndex(parseOpenApiDocument(spec));
}

interface StubResponse {
  code: number;
  headers?: Record<string, string>;
  rawHeaders?: Array<[string, string]>;
  body?: string;
}

function runScript(script: string, response: StubResponse): Record<string, string> {
  const results: Record<string, string> = {};
  const permissive: unknown = new Proxy(function () {}, {
    get: (_target, property) => (property === 'fail' ? (message: string) => { throw new Error(message); } : permissive),
    apply: () => permissive
  });
  const headerEntries = response.rawHeaders ?? Object.entries(response.headers ?? {});
  const headerMap = new Map(headerEntries.map(([key, value]) => [key.toLowerCase(), value] as const));
  const body = response.body ?? '';
  const pm = {
    test: (name: string, callback: () => void) => {
      try { callback(); results[name] = 'pass'; } catch (error) { results[name] = 'fail'; results[name + ' :: error'] = String(error); }
    },
    expect: permissive,
    response: {
      code: response.code,
      to: permissive,
      headers: {
        get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
        each: (callback: (header: { key: string; value: string }) => void) => headerEntries.forEach(([key, value]) => callback({ key, value }))
      },
      text: () => body,
      json: () => JSON.parse(body)
    },
    request: {
      headers: { each: () => {} },
      body: undefined,
      url: { raw: '/things', path: ['things'], getPath: () => '/things', toString: () => '/things', query: { each: () => {} } }
    }
  };
  runInContext(script, createContext({ pm, URL }));
  return results;
}

const LINK_TEST = 'OpenAPI link expressions resolve against the response';
const WRITEONLY_TEST = 'Response body does not leak writeOnly properties';

const SPEC = [
  'openapi: 3.1.0',
  'info: { title: T, version: 1.0.0 }',
  'paths:',
  '  /things:',
  '    get:',
  '      responses:',
  "        '200':",
  '          description: OK',
  '          headers:',
  '            X-Next: { schema: { type: string } }',
  '          content:',
  '            application/json:',
  '              schema:',
  '                type: object',
  '                properties:',
  '                  id: { type: string }',
  '                  password: { type: string, writeOnly: true }',
  '          links:',
  '            next:',
  '              operationId: getThing',
  '              parameters:',
  "                thingId: '$response.header.X-Next'",
  '  /things/{thingId}:',
  '    get:',
  '      operationId: getThing',
  '      parameters:',
  '        - { name: thingId, in: path, required: true, schema: { type: string } }',
  '      responses:',
  "        '200': { description: OK }",
  ''
].join('\n');

describe('OpenAPI link + writeOnly runtime assertions', () => {
  const index = indexFrom(SPEC);
  const op = index.operations.find((o) => o.path === '/things')!;
  const script = createContractScript(op).join('\n');

  it('captures the header link expression and the response writeOnly property', () => {
    expect(op.responses['200']!.links).toEqual([{ link: 'next', kind: 'header', header: 'X-Next', param: 'thingId', targetKey: 'next:thingId' }]);
    expect(op.linkTargetSchemas).toEqual({ 'next:thingId': { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string' } });
    expect(op.responses['200']!.writeOnlyProperties).toEqual(['password']);
  });

  it('passes the link header check when exactly one matching header is present', () => {
    expect(runScript(script, { code: 200, headers: { 'X-Next': '/things/42' }, body: '{"id":"1"}' })[LINK_TEST]).toBe('pass');
  });

  it('fails the link header check when the referenced response header is absent', () => {
    expect(runScript(script, { code: 200, body: '{"id":"1"}' })[LINK_TEST]).toBe('fail');
  });

  it('fails the link header check when the response carries duplicate header fields', () => {
    expect(runScript(script, { code: 200, rawHeaders: [['X-Next', '/things/1'], ['X-Next', '/things/2']], body: '{"id":"1"}' })[LINK_TEST]).toBe('fail');
  });

  it('passes writeOnly leakage when the response omits the writeOnly property', () => {
    expect(runScript(script, { code: 200, headers: { 'X-Next': '/things/42' }, body: '{"id":"1"}' })[WRITEONLY_TEST]).toBe('pass');
  });

  it('fails writeOnly leakage when the response includes a writeOnly property', () => {
    expect(runScript(script, { code: 200, headers: { 'X-Next': '/things/42' }, body: '{"id":"1","password":"secret"}' })[WRITEONLY_TEST]).toBe('fail');
  });

  it('validates response-derived link body values against target operation inputs', () => {
    const targetIndex = indexFrom([
      'openapi: 3.1.0',
      'info: { title: T, version: 1.0.0 }',
      'paths:',
      '  /orders:',
      '    get:',
      '      responses:',
      "        '200':",
      '          description: OK',
      '          content:',
      '            application/json:',
      '              schema: { type: object, properties: { id: { type: integer } } }',
      '          links:',
      '            next:',
      '              operationId: getOrder',
      '              parameters:',
      "                id: '$response.body#/id'",
      '  /orders/{id}:',
      '    get:',
      '      operationId: getOrder',
      '      parameters:',
      '        - { name: id, in: path, required: true, schema: { type: integer, minimum: 1 } }',
      '      responses:',
      "        '200': { description: OK }",
      ''
    ].join('\n'));
    const sourceOp = targetIndex.operations.find((operation) => operation.path === '/orders')!;
    expect(sourceOp.responses['200']!.links).toEqual([{ link: 'next', kind: 'body', pointer: '/id', param: 'id', targetKey: 'next:id' }]);
    expect(sourceOp.linkTargetSchemas).toEqual({ 'next:id': { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'integer', minimum: 1 } });
    const targetScript = createContractScript(sourceOp).join('\n');

    expect(runScript(targetScript, { code: 200, body: '{"id":7}' })[LINK_TEST]).toBe('pass');
    expect(runScript(targetScript, { code: 200, body: '{"id":"bad"}' })[LINK_TEST]).toBe('fail');
    expect(runScript(targetScript, { code: 200, body: '{"id":0}' })[LINK_TEST]).toBe('fail');
  });

  it('warns when a link omits required target inputs', () => {
    const targetIndex = indexFrom([
      'openapi: 3.1.0',
      'info: { title: T, version: 1.0.0 }',
      'paths:',
      '  /orders:',
      '    get:',
      '      responses:',
      "        '200':",
      '          description: OK',
      '          links:',
      '            next:',
      '              operationId: getOrder',
      '              parameters:',
      "                id: '$response.body#/id'",
      '  /orders/{id}:',
      '    get:',
      '      operationId: getOrder',
      '      parameters:',
      '        - { name: id, in: path, required: true, schema: { type: integer } }',
      '        - { name: limit, in: query, required: true, schema: { type: integer } }',
      '      responses:',
      "        '200': { description: OK }",
      ''
    ].join('\n'));
    const sourceOp = targetIndex.operations.find((operation) => operation.path === '/orders')!;
    expect(sourceOp.warnings).toContain('CONTRACT_LINK_REQUIRED_INPUT_MISSING: link next on GET /orders does not supply required target input(s) query.limit');
  });
});

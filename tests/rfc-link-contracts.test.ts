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
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  requestPath?: string;
  requestQuery?: Record<string, string>;
}

function runScript(script: string, response: StubResponse): Record<string, string> {
  const results: Record<string, string> = {};
  const permissive: unknown = new Proxy(function () {}, {
    get: (_target, property) => (property === 'fail' ? (message: string) => { throw new Error(message); } : permissive),
    apply: () => permissive
  });
  const headerEntries = response.rawHeaders ?? Object.entries(response.headers ?? {});
  const requestHeaderEntries = Object.entries(response.requestHeaders ?? {});
  const requestQueryEntries = Object.entries(response.requestQuery ?? {});
  const headerMap = new Map(headerEntries.map(([key, value]) => [key.toLowerCase(), value] as const));
  const body = response.body ?? '';
  const requestPath = response.requestPath ?? '/things';
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
      headers: { each: (callback: (header: { key: string; value: string; disabled: boolean }) => void) => requestHeaderEntries.forEach(([key, value]) => callback({ key, value, disabled: false })) },
      body: response.requestBody === undefined ? undefined : { mode: 'raw', raw: response.requestBody },
      url: {
        raw: requestPath,
        path: requestPath.split('?')[0]!.split('/').filter(Boolean),
        getPath: () => requestPath.split('?')[0],
        toString: () => requestPath,
        query: { each: (callback: (param: { key: string; value: string; disabled: boolean }) => void) => requestQueryEntries.forEach(([key, value]) => callback({ key, value, disabled: false })) }
      }
    }
  };
  runInContext(script, createContext({ pm, URL }));
  return results;
}

const LINK_TEST = 'OpenAPI link expressions resolve against the response';
const WRITEONLY_TEST = 'Response body does not leak writeOnly properties';
const SERIALIZATION_TEST = 'Request parameters use the OpenAPI-declared wire serialization';

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

  it('resolves request-derived link parameters and validates target input schemas', () => {
    const targetIndex = indexFrom([
      'openapi: 3.1.0',
      'info: { title: T, version: 1.0.0 }',
      'paths:',
      '  /orders/{id}:',
      '    get:',
      '      parameters:',
      '        - { name: id, in: path, required: true, schema: { type: integer } }',
      '        - { name: limit, in: query, required: true, schema: { type: integer } }',
      '      responses:',
      "        '200':",
      '          description: OK',
      '          links:',
      '            next:',
      '              operationId: getOrderPage',
      '              parameters:',
      "                id: '$request.path.id'",
      "                limit: '$request.query.limit'",
      '  /orders/{id}/page:',
      '    get:',
      '      operationId: getOrderPage',
      '      parameters:',
      '        - { name: id, in: path, required: true, schema: { type: integer, minimum: 1 } }',
      '        - { name: limit, in: query, required: true, schema: { type: integer, minimum: 1 } }',
      '      responses:',
      "        '200': { description: OK }",
      ''
    ].join('\n'));
    const sourceOp = targetIndex.operations.find((operation) => operation.path === '/orders/{id}')!;
    expect(sourceOp.responses['200']!.links).toEqual([
      { link: 'next', kind: 'requestPath', path: 'id', param: 'id', targetKey: 'next:id' },
      { link: 'next', kind: 'requestQuery', query: 'limit', param: 'limit', targetKey: 'next:limit' }
    ]);
    expect(sourceOp.warnings.filter((warning) => warning.startsWith('CONTRACT_LINK_REQUIRED_INPUT_MISSING'))).toEqual([]);
    const targetScript = createContractScript(sourceOp).join('\n');

    expect(runScript(targetScript, { code: 200, requestPath: '/orders/7', requestQuery: { limit: '2' } })[LINK_TEST]).toBe('pass');
    expect(runScript(targetScript, { code: 200, requestPath: '/orders/0', requestQuery: { limit: '2' } })[LINK_TEST]).toBe('fail');
    expect(runScript(targetScript, { code: 200, requestPath: '/orders/7' })[LINK_TEST]).toBe('fail');
  });

  it('resolves request body link expressions and validates target request inputs', () => {
    const targetIndex = indexFrom([
      'openapi: 3.1.0',
      'info: { title: T, version: 1.0.0 }',
      'paths:',
      '  /orders:',
      '    post:',
      '      requestBody:',
      '        required: true',
      '        content:',
      '          application/json:',
      '            schema: { type: object, properties: { id: { type: integer } }, required: [id] }',
      '      responses:',
      "        '201':",
      '          description: Created',
      '          links:',
      '            self:',
      '              operationId: getOrder',
      '              parameters:',
      "                id: '$request.body#/id'",
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
    expect(sourceOp.responses['201']!.links).toEqual([{ link: 'self', kind: 'requestBody', pointer: '/id', param: 'id', targetKey: 'self:id' }]);
    const targetScript = createContractScript(sourceOp).join('\n');

    expect(runScript(targetScript, { code: 201, requestBody: '{"id":7}' })[LINK_TEST]).toBe('pass');
    expect(runScript(targetScript, { code: 201, requestBody: '{"id":0}' })[LINK_TEST]).toBe('fail');
    expect(runScript(targetScript, { code: 201, requestBody: '{}' })[LINK_TEST]).toBe('fail');
  });

  it('validates links against target parameter content schemas and literal target request bodies', () => {
    const targetIndex = indexFrom([
      'openapi: 3.1.0',
      'info: { title: T, version: 1.0.0 }',
      'paths:',
      '  /search:',
      '    post:',
      '      requestBody:',
      '        required: true',
      '        content:',
      '          application/json:',
      '            schema: { type: object, properties: { filter: { type: object, properties: { id: { type: integer } }, required: [id] } }, required: [filter] }',
      '      responses:',
      "        '201':",
      '          description: Created',
      '          links:',
      '            filtered:',
      '              operationId: getSearch',
      '              parameters:',
      "                filter: '$request.body#/filter'",
      '            createBad:',
      '              operationId: createSearch',
      '              requestBody: { filter: { id: bad } }',
      '  /search/results:',
      '    get:',
      '      operationId: getSearch',
      '      parameters:',
      '        - name: filter',
      '          in: query',
      '          required: true',
      '          content:',
      '            application/json:',
      '              schema: { type: object, properties: { id: { type: integer } }, required: [id] }',
      '      responses:',
      "        '200': { description: OK }",
      '  /search/create:',
      '    post:',
      '      operationId: createSearch',
      '      requestBody:',
      '        required: true',
      '        content:',
      '          application/json:',
      '            schema: { type: object, properties: { filter: { type: object, properties: { id: { type: integer } }, required: [id] } }, required: [filter] }',
      '      responses:',
      "        '200': { description: OK }",
      ''
    ].join('\n'));
    const sourceOp = targetIndex.operations.find((operation) => operation.path === '/search')!;
    expect(sourceOp.responses['201']!.links?.find((entry) => entry.link === 'filtered')).toEqual({ link: 'filtered', kind: 'requestBody', pointer: '/filter', param: 'filter', targetKey: 'filtered:filter' });
    expect(sourceOp.warnings).toContain('CONTRACT_LINK_REQUEST_BODY_SCHEMA_MISMATCH: link createBad on POST /search supplies a literal requestBody that does not satisfy the target operation schema');
    const targetScript = createContractScript(sourceOp).join('\n');

    expect(runScript(targetScript, { code: 201, requestBody: '{"filter":{"id":7}}' })[LINK_TEST]).toBe('pass');
    expect(runScript(targetScript, { code: 201, requestBody: '{"filter":{"id":"bad"}}' })[LINK_TEST]).toBe('fail');
  });

  it('checks exact query, deepObject, pipe/space, and header serialization spelling', () => {
    const index = indexFrom([
      'openapi: 3.1.0',
      'info: { title: T, version: 1.0.0 }',
      'paths:',
      '  /search:',
      '    get:',
      '      parameters:',
      '        - { name: ids, in: query, style: form, explode: false, schema: { type: array, items: { type: string } } }',
      '        - { name: tags, in: query, style: spaceDelimited, explode: false, schema: { type: array, items: { type: string } } }',
      '        - { name: pipes, in: query, style: pipeDelimited, explode: false, schema: { type: array, items: { type: string } } }',
      '        - { name: filter, in: query, style: deepObject, explode: true, schema: { type: object, properties: { id: { type: string } } } }',
      '        - { name: X-Ids, in: header, schema: { type: array, items: { type: string } } }',
      '      responses:',
      "        '200': { description: OK }",
      ''
    ].join('\n'));
    const op = index.operations.find((operation) => operation.path === '/search')!;
    const script = createContractScript(op).join('\n');

    expect(runScript(script, { code: 200, requestQuery: { ids: 'a,b', tags: 'a b', pipes: 'a|b' }, requestHeaders: { 'X-Ids': 'a,b' } })[SERIALIZATION_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, requestQuery: { ids: 'a%2Cb' } })[SERIALIZATION_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, requestQuery: { tags: 'a+b' } })[SERIALIZATION_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, requestQuery: { pipes: 'a%7Cb' } })[SERIALIZATION_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, requestQuery: { 'filter%5Bid%5D': '7' } })[SERIALIZATION_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, requestHeaders: { 'X-Ids': '"a,b"' } })[SERIALIZATION_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, requestHeaders: { 'X-Ids': 'a%2Cb' } })[SERIALIZATION_TEST]).toBe('fail');
  });
});

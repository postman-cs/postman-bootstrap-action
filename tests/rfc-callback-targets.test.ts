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
  body?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: { mode: string; raw: string };
  query?: Record<string, string>;
  requestPath?: string[];
  requestUrl?: string;
}

function runScript(script: string, response: StubResponse): Record<string, string> {
  const results: Record<string, string> = {};
  const permissive: unknown = new Proxy(function () {}, {
    get: (_target, property) => (property === 'fail' ? (message: string) => { throw new Error(message); } : permissive),
    apply: () => permissive
  });
  const headerEntries = Object.entries(response.headers ?? {});
  const headerMap = new Map(headerEntries.map(([key, value]) => [key.toLowerCase(), value]));
  const requestHeaderEntries = Object.entries(response.requestHeaders ?? {});
  const queryEntries = Object.entries(response.query ?? {});
  const requestPath = response.requestPath ?? [];
  const requestPathValue = `/${requestPath.join('/')}`;
  const requestUrl = response.requestUrl ?? requestPathValue;
  const body = response.body ?? '';
  const pm = {
    test: (name: string, callback: () => void) => {
      try { callback(); results[name] = 'pass'; } catch (error) { results[name] = 'fail'; results[`${name} :: error`] = String(error); }
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
      body: response.requestBody,
      url: {
        raw: requestUrl,
        path: requestPath,
        getPath: () => requestPathValue,
        toString: () => requestUrl,
        query: { each: (callback: (param: { key: string; value: string; disabled: boolean }) => void) => queryEntries.forEach(([key, value]) => callback({ key, value, disabled: false })) }
      }
    }
  };
  runInContext(script, createContext({ pm, URL }));
  return results;
}

const CALLBACKS_TEST = 'OpenAPI callback targets resolve to concrete URI-references';

const CALLBACK_SPEC = [
  'openapi: 3.1.0',
  'info:',
  '  title: T',
  '  version: 1.0.0',
  'paths:',
  '  /subscriptions/{tenant}:',
  '    post:',
  '      parameters:',
  '        - { name: tenant, in: path, required: true, schema: { type: string } }',
  '        - { name: hook, in: query, schema: { type: string } }',
  '        - { name: X-Callback-Token, in: header, schema: { type: string } }',
  '      callbacks:',
  '        notify:',
  "          '{$request.query.hook}':",
  '            post:',
  '              responses:',
  "                '202': { description: Accepted }",
  '        audit:',
  "          'https://callbacks.example.com/{$request.path.tenant}?token={$request.header.X-Callback-Token}':",
  '            post:',
  '              responses:',
  "                '202': { description: Accepted }",
  '      responses:',
  "        '200': { description: OK }",
  ''
].join('\n');

const MISSING_HEADER_SPEC = [
  'openapi: 3.1.0',
  'info:',
  '  title: T',
  '  version: 1.0.0',
  'paths:',
  '  /subscriptions/{tenant}:',
  '    post:',
  '      parameters:',
  '        - { name: tenant, in: path, required: true, schema: { type: string } }',
  '      callbacks:',
  '        audit:',
  "          'https://callbacks.example.com/{$request.path.tenant}?token={$request.header.X-Callback-Token}':",
  '            post:',
  '              responses:',
  "                '202': { description: Accepted }",
  '      responses:',
  "        '200': { description: OK }",
  ''
].join('\n');

describe('OpenAPI callback runtime assertions', () => {
  const index = indexFrom(CALLBACK_SPEC);
  const script = createContractScript(index.operations[0]!).join('\n');

  it('captures callback expressions while keeping the residual callback warning', () => {
    expect(index.warnings).toContain('CONTRACT_CALLBACKS_NOT_VALIDATED: callbacks are not validated for POST /subscriptions/{tenant}');
    expect(index.operations[0]!.callbacks).toEqual([
      { callback: 'notify', expression: '{$request.query.hook}' },
      { callback: 'audit', expression: 'https://callbacks.example.com/{$request.path.tenant}?token={$request.header.X-Callback-Token}' }
    ]);
    expect(index.operations[0]!.callbackRequestSources).toEqual({
      path: ['tenant'],
      query: ['hook'],
      header: ['x-callback-token']
    });
  });

  it('resolves request-derived callback targets into concrete URI-references', () => {
    expect(runScript(script, {
      code: 200,
      requestPath: ['subscriptions', 'acme'],
      requestHeaders: { 'X-Callback-Token': 'abc123' },
      query: { hook: 'https://consumer.example.com/events' }
    })[CALLBACKS_TEST]).toBe('pass');

    expect(runScript(script, {
      code: 200,
      requestPath: ['subscriptions', 'acme'],
      requestHeaders: { 'X-Callback-Token': 'abc123' },
      query: { hook: 'bad target' }
    })[CALLBACKS_TEST]).toBe('fail');

    expect(runScript(script, {
      code: 200,
      requestPath: ['subscriptions', '{tenant}'],
      requestHeaders: { 'X-Callback-Token': 'abc123' },
      query: { hook: 'https://consumer.example.com/events' }
    })[CALLBACKS_TEST]).toBe('fail');
  });

  it('fails when a callback references an undeclared request header parameter', () => {
    const missingHeaderScript = createContractScript(indexFrom(MISSING_HEADER_SPEC).operations[0]!).join('\n');
    expect(runScript(missingHeaderScript, {
      code: 200,
      requestPath: ['subscriptions', 'acme'],
      requestHeaders: { 'X-Callback-Token': 'abc123' }
    })[CALLBACKS_TEST]).toBe('fail');
  });
});

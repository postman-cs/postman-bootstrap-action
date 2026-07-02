import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import { createSoapScript } from '../src/lib/protocols/soap/instrumenter.js';
import type { SoapOperation } from '../src/lib/protocols/soap/parser.js';
import { createContractScript } from '../src/lib/spec/collection-contracts.js';
import { buildContractIndex } from '../src/lib/spec/contract-index.js';
import { parseOpenApiDocument } from '../src/lib/spec/openapi-loader.js';

const SPEC = [
  'openapi: 3.1.0',
  'info:',
  '  title: T',
  '  version: 1.0.0',
  'paths:',
  '  /pets:',
  '    get:',
  '      security:',
  '        - bearerAuth: []',
  '      responses:',
  "        '200':",
  '          description: OK',
  '          content:',
  '            application/json:',
  '              schema: { type: object }',
  '    delete:',
  '      responses:',
  "        '204':",
  '          description: gone',
  'components:',
  '  securitySchemes:',
  '    bearerAuth: { type: http, scheme: bearer }',
  ''
].join('\n');

function indexFrom(spec: string) {
  return buildContractIndex(parseOpenApiDocument(spec));
}

interface StubResponse {
  code: number;
  headers?: Record<string, string>;
  body?: string;
}

function runScript(script: string, response: StubResponse): Record<string, string> {
  const results: Record<string, string> = {};
  const permissive: unknown = new Proxy(function () {}, {
    get: (_target, property) => (property === 'fail' ? (message: string) => { throw new Error(message); } : permissive),
    apply: () => permissive
  });
  const headerMap = new Map(Object.entries(response.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  const body = response.body ?? '';
  const pm = {
    test: (name: string, callback: () => void) => {
      try { callback(); results[name] = 'pass'; } catch { results[name] = 'fail'; }
    },
    expect: permissive,
    response: {
      code: response.code,
      to: permissive,
      headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
      text: () => body,
      json: () => JSON.parse(body)
    },
    request: {
      headers: { each: () => {} },
      url: { query: { each: () => {} } }
    }
  };
  runInContext(script, createContext({ pm }));
  return results;
}

const RFC9110 = 'Response satisfies RFC 9110 status-code requirements';
const CONVENTIONS = 'Error and encoding conventions match RFC 9457 / RFC 8259 / RFC 8288';
const SOAP_CONSISTENCY = 'SOAP Fault and HTTP status are consistent';

describe('RFC 9110 status-code requirement assertions', () => {
  const index = indexFrom(SPEC);
  const script = createContractScript(index.operations.find((op) => op.method === 'GET')!).join('\n');

  it('embeds the RFC test blocks and the declared path methods', () => {
    expect(script).toContain(RFC9110);
    expect(script).toContain(CONVENTIONS);
    expect(script).toContain('pathMethods');
  });

  it('401 must carry WWW-Authenticate, with a Bearer challenge for bearer-secured operations', () => {
    expect(runScript(script, { code: 401 })[RFC9110]).toBe('fail');
    expect(runScript(script, { code: 401, headers: { 'WWW-Authenticate': 'Bearer realm="api"' } })[RFC9110]).toBe('pass');
    expect(runScript(script, { code: 401, headers: { 'WWW-Authenticate': 'Basic realm="api"' } })[RFC9110]).toBe('fail');
  });

  it('405 must carry Allow listing every declared path method', () => {
    expect(runScript(script, { code: 405 })[RFC9110]).toBe('fail');
    expect(runScript(script, { code: 405, headers: { Allow: 'GET, DELETE' } })[RFC9110]).toBe('pass');
    expect(runScript(script, { code: 405, headers: { Allow: 'DELETE' } })[RFC9110]).toBe('fail');
  });

  it('304 must not carry content', () => {
    expect(runScript(script, { code: 304, body: 'stale' })[RFC9110]).toBe('fail');
    expect(runScript(script, { code: 304 })[RFC9110]).toBe('pass');
  });

  it('206 must carry a well-formed Content-Range', () => {
    expect(runScript(script, { code: 206 })[RFC9110]).toBe('fail');
    expect(runScript(script, { code: 206, headers: { 'Content-Range': 'bytes 0-99/200' } })[RFC9110]).toBe('pass');
    expect(runScript(script, { code: 206, headers: { 'Content-Range': 'banana' } })[RFC9110]).toBe('fail');
  });

  it('Retry-After must be delay-seconds or an HTTP-date', () => {
    expect(runScript(script, { code: 503, headers: { 'Retry-After': 'soon' } })[RFC9110]).toBe('fail');
    expect(runScript(script, { code: 503, headers: { 'Retry-After': '120' } })[RFC9110]).toBe('pass');
    expect(runScript(script, { code: 429, headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' } })[RFC9110]).toBe('pass');
  });

  it('Location on 201/3xx must be a plausible URI-reference', () => {
    expect(runScript(script, { code: 201, headers: { Location: '/pets/1' } })[RFC9110]).toBe('pass');
    expect(runScript(script, { code: 201, headers: { Location: '/pets /1' } })[RFC9110]).toBe('fail');
  });

  it('is silent on a benign 200', () => {
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' })[RFC9110]).toBe('pass');
  });
});

describe('RFC 9457 / 8259 / 8288 convention assertions', () => {
  const index = indexFrom(SPEC);
  const script = createContractScript(index.operations.find((op) => op.method === 'GET')!).join('\n');

  it('validates problem+json member types and status consistency', () => {
    expect(runScript(script, { code: 500, headers: { 'Content-Type': 'application/problem+json' }, body: '{"status":400,"title":"x"}' })[CONVENTIONS]).toBe('fail');
    expect(runScript(script, { code: 400, headers: { 'Content-Type': 'application/problem+json' }, body: '{"status":400,"title":"Bad Request"}' })[CONVENTIONS]).toBe('pass');
    expect(runScript(script, { code: 400, headers: { 'Content-Type': 'application/problem+json' }, body: '{"title":42}' })[CONVENTIONS]).toBe('fail');
    expect(runScript(script, { code: 400, headers: { 'Content-Type': 'application/problem+json' }, body: 'not json' })[CONVENTIONS]).toBe('fail');
  });

  it('rejects non-UTF-8 charsets on JSON media types (RFC 8259)', () => {
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'application/json; charset=iso-8859-1' }, body: '{}' })[CONVENTIONS]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: '{}' })[CONVENTIONS]).toBe('pass');
  });

  it('requires RFC 8288 link-values to carry a URI-reference and rel', () => {
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'application/json', Link: '</page/2>' }, body: '{}' })[CONVENTIONS]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'application/json', Link: '</page/2>; rel="next"' }, body: '{}' })[CONVENTIONS]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'application/json', Link: '</a>; rel="prev", </b>; rel="next"' }, body: '{}' })[CONVENTIONS]).toBe('pass');
  });
});

describe('SOAP Fault / HTTP status consistency', () => {
  const FAULT_BODY = '<soap:Envelope><soap:Body><soap:Fault><faultstring>boom</faultstring></soap:Fault></soap:Body></soap:Envelope>';
  const OK_BODY = '<soap:Envelope><soap:Body><PingResponse/></soap:Body></soap:Envelope>';
  const op = (soapVersion: '1.1' | '1.2') => ({ name: 'Ping', soapVersion } as unknown as SoapOperation);

  it('emits version-specific fault-status rules', () => {
    expect(createSoapScript(op('1.1'))).toContain('WS-I Basic Profile R1126');
    expect(createSoapScript(op('1.2'))).toContain('env:Sender');
  });

  it('fails a Fault on HTTP 200 and a Fault-less 500; passes the bound pairs', () => {
    const script11 = createSoapScript(op('1.1'));
    expect(runScript(script11, { code: 200, body: FAULT_BODY })[SOAP_CONSISTENCY]).toBe('fail');
    expect(runScript(script11, { code: 500, body: FAULT_BODY })[SOAP_CONSISTENCY]).toBe('pass');
    expect(runScript(script11, { code: 500, body: OK_BODY })[SOAP_CONSISTENCY]).toBe('fail');
    expect(runScript(script11, { code: 200, body: OK_BODY })[SOAP_CONSISTENCY]).toBe('pass');
    const script12 = createSoapScript(op('1.2'));
    expect(runScript(script12, { code: 400, body: FAULT_BODY })[SOAP_CONSISTENCY]).toBe('pass');
    expect(runScript(script12, { code: 200, body: FAULT_BODY })[SOAP_CONSISTENCY]).toBe('fail');
  });
});

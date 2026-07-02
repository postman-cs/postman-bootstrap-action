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
  headerList?: Array<[string, string]>;
  body?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: { mode: string; raw: string };
  query?: Record<string, string>;
}

function runScript(script: string, response: StubResponse): Record<string, string> {
  const results: Record<string, string> = {};
  const permissive: unknown = new Proxy(function () {}, {
    get: (_target, property) => (property === 'fail' ? (message: string) => { throw new Error(message); } : permissive),
    apply: () => permissive
  });
  const headerEntries: Array<[string, string]> = [...Object.entries(response.headers ?? {}), ...(response.headerList ?? [])];
  const headerMap = new Map(headerEntries.map(([key, value]) => [key.toLowerCase(), value]));
  const requestHeaderEntries = Object.entries(response.requestHeaders ?? {});
  const queryEntries = Object.entries(response.query ?? {});
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
      url: { query: { each: (callback: (param: { key: string; value: string; disabled: boolean }) => void) => queryEntries.forEach(([key, value]) => callback({ key, value, disabled: false })) } }
    }
  };
  runInContext(script, createContext({ pm }));
  return results;
}

const RFC9110 = 'Response satisfies RFC 9110 status-code requirements';
const CONVENTIONS = 'Error and encoding conventions match RFC 9457 / RFC 8259 / RFC 8288';
const SOAP_CONSISTENCY = 'SOAP Fault and HTTP status are consistent';
const FRAMING = 'Response satisfies RFC 9110 message framing requirements';
const HEADER_SYNTAX = 'Response header fields satisfy RFC 9110 field syntax';
const GRAMMARS = 'Response header values satisfy their RFC grammars';
const ACCEPT_TEST = 'Response media type is acceptable under the request Accept header';
const MEDIA_TEST = 'Response body satisfies its media type RFC conventions';
const SF_TEST = 'Structured field response headers parse per RFC 8941';
const DIGEST_TEST = 'Content-Digest and Repr-Digest match the response body (RFC 9530)';
const AUTH_TEST = 'Request credentials are well-formed per their authentication scheme RFCs';
const PRECOND_TEST = 'Request preconditions, preferences, and patch bodies follow their RFCs';
const ADVISORY_TEST = 'RFC SHOULD-level advisories are documented';

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
    expect(runScript(script, { code: 206 })[FRAMING]).toBe('fail');
    expect(runScript(script, { code: 206, headers: { 'Content-Range': 'bytes 0-99/200' } })[FRAMING]).toBe('pass');
    expect(runScript(script, { code: 206, headers: { 'Content-Range': 'banana' } })[FRAMING]).toBe('fail');
    expect(runScript(script, { code: 206, headers: { 'Content-Range': 'bytes 99-0/200' } })[FRAMING]).toBe('fail');
    expect(runScript(script, { code: 206, headers: { 'Content-Range': 'bytes 0-299/200' } })[FRAMING]).toBe('fail');
    expect(runScript(script, { code: 206, headers: { 'Content-Type': 'multipart/byteranges; boundary=xyz' } })[FRAMING]).toBe('pass');
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


describe('RFC message-mechanics assertions', () => {
  const index = indexFrom(SPEC);
  const script = createContractScript(index.operations.find((op) => op.method === 'GET')!).join('\n');
  const scriptNoAuth = createContractScript(index.operations.find((op) => op.method === 'DELETE')!).join('\n');

  it('framing: 204 Content-Length, redirect Location, 416, 407', () => {
    expect(runScript(script, { code: 204, headers: { 'Content-Length': '0' } })[FRAMING]).toBe('fail');
    expect(runScript(script, { code: 204 })[FRAMING]).toBe('pass');
    expect(runScript(script, { code: 302 })[FRAMING]).toBe('fail');
    expect(runScript(script, { code: 302, headers: { Location: '/next' } })[FRAMING]).toBe('pass');
    expect(runScript(script, { code: 416 })[FRAMING]).toBe('fail');
    expect(runScript(script, { code: 416, headers: { 'Content-Range': 'bytes */200' } })[FRAMING]).toBe('pass');
    expect(runScript(script, { code: 416, headers: { 'Content-Range': 'bytes 0-99/200' } })[FRAMING]).toBe('fail');
    expect(runScript(script, { code: 407 })[FRAMING]).toBe('fail');
    expect(runScript(script, { code: 407, headers: { 'Proxy-Authenticate': 'Basic realm="proxy"' } })[FRAMING]).toBe('pass');
  });

  it('field syntax: names are tokens, values are field-content, singletons do not diverge', () => {
    expect(runScript(script, { code: 200 })[HEADER_SYNTAX]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'X-Bad': 'a\u0000b' } })[HEADER_SYNTAX]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Bad Header': 'x' } })[HEADER_SYNTAX]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { ETag: '"a"' }, headerList: [['ETag', '"b"']] })[HEADER_SYNTAX]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { ETag: '"a"' }, headerList: [['ETag', '"a"']] })[HEADER_SYNTAX]).toBe('pass');
  });

  it('grammars: Date, ETag, Last-Modified ordering, Vary, Age, Cache-Control, lifecycle headers', () => {
    expect(runScript(script, { code: 200, headers: { Date: 'yesterday' } })[GRAMMARS]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { Date: 'Wed, 21 Oct 2026 07:28:00 GMT' } })[GRAMMARS]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { ETag: 'abc' } })[GRAMMARS]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { ETag: 'W/"abc"' } })[GRAMMARS]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { Date: 'Wed, 21 Oct 2026 07:28:00 GMT', 'Last-Modified': 'Thu, 22 Oct 2026 07:28:00 GMT' } })[GRAMMARS]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { Vary: '*, Accept' } })[GRAMMARS]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { Vary: 'Accept, Accept-Encoding' } })[GRAMMARS]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { Age: '-1' } })[GRAMMARS]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Cache-Control': 'no-store, max-age=60' } })[GRAMMARS]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Cache-Control': 'max-age=abc' } })[GRAMMARS]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Cache-Control': 'no-cache, max-age=60, private="set-cookie"' } })[GRAMMARS]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { Deprecation: '@1688169599' } })[GRAMMARS]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { Deprecation: 'true' } })[GRAMMARS]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { Sunset: 'nope' } })[GRAMMARS]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Preference-Applied': 'return=minimal' } })[GRAMMARS]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Preference-Applied': 'return=minimal' }, requestHeaders: { Prefer: 'return=minimal' } })[GRAMMARS]).toBe('pass');
  });

  it('content negotiation: response media must be acceptable under the request Accept', () => {
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'text/html' }, requestHeaders: { Accept: 'application/json' }, body: '<p>' })[ACCEPT_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'application/json' }, requestHeaders: { Accept: 'application/json' }, body: '{}' })[ACCEPT_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'application/hal+json' }, requestHeaders: { Accept: 'application/json' }, body: '{}' })[ACCEPT_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'text/html' }, requestHeaders: { Accept: 'text/*' }, body: '<p>' })[ACCEPT_TEST]).toBe('pass');
  });

  it('media conventions: BOM, NDJSON, SSE, multipart boundary, HAL, JSON:API', () => {
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'application/json' }, body: '\uFEFF{}' })[MEDIA_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'application/x-ndjson' }, body: '{"a":1}\n{"b":2}\n' })[MEDIA_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'application/x-ndjson' }, body: '{"a":1}\nnope\n' })[MEDIA_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'data: {}\n\n: comment\nretry: 100\n' })[MEDIA_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'bogus: x\n' })[MEDIA_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'multipart/mixed' }, body: '--x--' })[MEDIA_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'multipart/mixed; boundary=abc' }, body: '--abc--' })[MEDIA_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'application/hal+json' }, body: '{"_links":{"self":{"href":"/x"}}}' })[MEDIA_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'application/hal+json' }, body: '{"_links":{"self":{}}}' })[MEDIA_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'application/vnd.api+json' }, body: '{"data":[],"errors":[]}' })[MEDIA_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'application/vnd.api+json' }, body: '{"data":[]}' })[MEDIA_TEST]).toBe('pass');
  });

  it('structured fields and digests parse per RFC 8941 / 9530', () => {
    expect(runScript(script, { code: 200, headers: { Priority: 'u=1, i' } })[SF_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { Priority: 'u=&&' } })[SF_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Cache-Status': 'ExampleCache; hit' } })[SF_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Signature-Input': 'sig1=("@method" "@path");created=1618884475;keyid="test-key"' } })[SF_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Content-Digest': 'sha-256=:AbC=:' } })[DIGEST_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Content-Digest': 'sha-256=:!!:' } })[DIGEST_TEST]).toBe('fail');
  });

  it('auth credentials: Basic base64, Bearer b64token, Digest params', () => {
    const basicOk = Buffer.from('user:pass').toString('base64');
    expect(runScript(script, { code: 200, requestHeaders: { Authorization: `Basic ${basicOk}` } })[AUTH_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, requestHeaders: { Authorization: 'Basic ####' } })[AUTH_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, requestHeaders: { Authorization: `Basic ${Buffer.from('nocolon').toString('base64')}` } })[AUTH_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, requestHeaders: { Authorization: 'Bearer abc.def-123' } })[AUTH_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, requestHeaders: { Authorization: 'Bearer not a token!!' } })[AUTH_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, requestHeaders: { Authorization: 'Digest username="u", response=abc123, nonce="n"' } })[AUTH_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, requestHeaders: { Authorization: 'Digest response="zz-not-hex"' } })[AUTH_TEST]).toBe('fail');
  });

  it('challenges: Basic realm, Digest nonce, Bearer error codes on 401/403', () => {
    expect(runScript(scriptNoAuth, { code: 401, headers: { 'WWW-Authenticate': 'Basic' } })[RFC9110]).toBe('fail');
    expect(runScript(scriptNoAuth, { code: 401, headers: { 'WWW-Authenticate': 'Basic realm="api"' } })[RFC9110]).toBe('pass');
    expect(runScript(scriptNoAuth, { code: 401, headers: { 'WWW-Authenticate': 'Digest realm="r"' } })[RFC9110]).toBe('fail');
    expect(runScript(scriptNoAuth, { code: 401, headers: { 'WWW-Authenticate': 'Digest realm="r", nonce="n"' } })[RFC9110]).toBe('pass');
    expect(runScript(script, { code: 403, headers: { 'WWW-Authenticate': 'Bearer error="expired"' } })[RFC9110]).toBe('fail');
    expect(runScript(script, { code: 403, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } })[RFC9110]).toBe('pass');
  });

  it('preconditions, preferences, and patch bodies', () => {
    expect(runScript(script, { code: 200, requestHeaders: { 'If-Match': 'abc' } })[PRECOND_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, requestHeaders: { 'If-Match': '"abc", W/"def"' } })[PRECOND_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, requestHeaders: { 'If-None-Match': '*' } })[PRECOND_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, requestHeaders: { Prefer: 'return=minimal, wait=10' } })[PRECOND_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, requestHeaders: { Prefer: 'bad prefer!' } })[PRECOND_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, requestHeaders: { 'Content-Type': 'application/json-patch+json' }, requestBody: { mode: 'raw', raw: '[{"op":"add","path":"/a","value":1}]' } })[PRECOND_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, requestHeaders: { 'Content-Type': 'application/json-patch+json' }, requestBody: { mode: 'raw', raw: '[{"op":"nope","path":"/a"}]' } })[PRECOND_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, requestHeaders: { 'Content-Type': 'application/json-patch+json' }, requestBody: { mode: 'raw', raw: '[{"op":"move","path":"/a"}]' } })[PRECOND_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, requestHeaders: { 'Content-Type': 'application/json-patch+json' }, requestBody: { mode: 'raw', raw: '{"not":"an array"}' } })[PRECOND_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, requestHeaders: { 'Content-Type': 'application/merge-patch+json' }, requestBody: { mode: 'raw', raw: '{bad' } })[PRECOND_TEST]).toBe('fail');
  });

  it('advisory channel always passes', () => {
    expect(runScript(script, { code: 200 })[ADVISORY_TEST]).toBe('pass');
  });
});


describe('RFC phase-B assertions: JWT, links, lifecycle, servers', () => {
  const SPEC_B = [
    'openapi: 3.1.0',
    'info:',
    '  title: T',
    '  version: 1.0.0',
    'servers:',
    "  - url: 'https://api.example.com/v1'",
    'paths:',
    '  /things/{id}:',
    '    get:',
    '      deprecated: true',
    '      security:',
    '        - jwtAuth: []',
    '      parameters:',
    '        - { name: id, in: path, required: true, schema: { type: string } }',
    '      responses:',
    "        '200':",
    '          description: OK',
    '          content:',
    '            application/json:',
    '              schema: { type: object }',
    '          links:',
    '            NextThing:',
    '              operationId: getThing',
    "              parameters: { id: '$response.body#/id' }",
    '            Loc:',
    '              operationId: getThing',
    "              parameters: { loc: '$response.header.Location' }",
    'components:',
    '  securitySchemes:',
    '    jwtAuth: { type: http, scheme: bearer, bearerFormat: JWT }',
    ''
  ].join('\n');
  const index = indexFrom(SPEC_B);
  const script = createContractScript(index.operations[0]!).join('\n');
  const LINKS_TEST = 'OpenAPI link expressions resolve against the response';
  const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

  it('captures bearerFormat, deprecation, servers, and link expressions in the contract', () => {
    expect(script).toContain('bearerFormat');
    expect(script).toContain('deprecated');
    expect(index.operations[0]!.servers).toEqual(['^https://api\\.example\\.com/v1']);
    expect(index.operations[0]!.responses['200']!.links).toHaveLength(2);
    expect(index.operations[0]!.deprecated).toBe(true);
  });

  it('validates JWT structure for bearerFormat JWT credentials', () => {
    const okJwt = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: 'u', exp: 4102444800 })}.c2ln`;
    const base = { code: 200, headers: { 'Content-Type': 'application/json' }, body: '{"id":1}' };
    expect(runScript(script, { ...base, requestHeaders: { Authorization: `Bearer ${okJwt}` } })[AUTH_TEST]).toBe('pass');
    expect(runScript(script, { ...base, requestHeaders: { Authorization: 'Bearer only.two' } })[AUTH_TEST]).toBe('fail');
    const noAlg = `${b64url({ typ: 'JWT' })}.${b64url({ sub: 'u' })}.c2ln`;
    expect(runScript(script, { ...base, requestHeaders: { Authorization: `Bearer ${noAlg}` } })[AUTH_TEST]).toBe('fail');
    const badClaims = `${b64url({ alg: 'HS256' })}.${b64url({ exp: 'soon' })}.c2ln`;
    expect(runScript(script, { ...base, requestHeaders: { Authorization: `Bearer ${badClaims}` } })[AUTH_TEST]).toBe('fail');
  });

  it('resolves link body pointers and header references against the response', () => {
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'application/json', Location: '/things/2' }, body: '{"id":1}' })[LINKS_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'application/json', Location: '/things/2' }, body: '{}' })[LINKS_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'application/json' }, body: '{"id":1}' })[LINKS_TEST]).toBe('fail');
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

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
const SF_TEST = 'Structured field response headers parse per RFC 9651';
const PROXY_STATUS_TEST = 'Proxy-Status members are typed per RFC 9209';
const SIGNATURE_TEST = 'HTTP message signatures are structurally valid (RFC 9421)';
const RATELIMIT_TEST = 'RateLimit headers follow the IETF ratelimit-headers draft (advisory)';
const COOKIE_TEST = 'Set-Cookie response headers satisfy RFC 6265';
const SECURITY_TEST = 'Security response headers satisfy their specifications';
const CORS_TEST = 'CORS response headers satisfy the WHATWG Fetch standard';
const MULTIPART_TEST = 'Request multipart bodies and Idempotency-Key follow their specifications';
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

  it('maps oauth2 and openIdConnect security schemes to Bearer 401 challenges', () => {
    const oauthSpec = [
      'openapi: 3.1.0',
      'info: { title: T, version: 1 }',
      'paths:',
      '  /secure:',
      '    get:',
      '      security:',
      '        - oauth: []',
      '      responses:',
      "        '200': { description: OK }",
      'components:',
      '  securitySchemes:',
      '    oauth:',
      '      type: oauth2',
      '      flows:',
      '        clientCredentials:',
      "          tokenUrl: 'https://auth.example.com/token'",
      '          scopes: {}',
      ''
    ].join('\n');
    const oauthScript = createContractScript(indexFrom(oauthSpec).operations[0]!).join('\n');
    expect(runScript(oauthScript, { code: 401, headers: { 'WWW-Authenticate': 'Bearer realm="api"' } })[RFC9110]).toBe('pass');
    expect(runScript(oauthScript, { code: 401, headers: { 'WWW-Authenticate': 'Basic realm="api"' } })[RFC9110]).toBe('fail');
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
    expect(runScript(script, { code: 206, headers: { 'Content-Range': 'bytes 0-99/200', 'Content-Length': '100' } })[FRAMING]).toBe('pass');
    expect(runScript(script, { code: 206, headers: { 'Content-Range': 'bytes 0-99/200', 'Content-Length': '99' } })[FRAMING]).toBe('fail');
    expect(runScript(script, { code: 206, headers: { 'Content-Range': 'bytes 0-99/200', 'Accept-Ranges': 'none' } })[FRAMING]).toBe('fail');
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
    expect(runScript(script, { code: 400, headers: { 'Content-Type': 'application/problem+json' }, body: '{"type":"/problems/bad","instance":"urn:problem:1"}' })[CONVENTIONS]).toBe('pass');
    expect(runScript(script, { code: 400, headers: { 'Content-Type': 'application/problem+json' }, body: '{"type":"bad uri"}' })[CONVENTIONS]).toBe('fail');
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
    expect(runScript(script, { code: 416, headers: { 'Content-Range': 'items */200' } })[FRAMING]).toBe('fail');
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

  it('structured fields and digests parse per RFC 9651 / 9530', () => {
    expect(runScript(script, { code: 200, headers: { Priority: 'u=1, i' } })[SF_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { Priority: 'u=&&' } })[SF_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Cache-Status': 'ExampleCache; hit' } })[SF_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Signature-Input': 'sig1=("@method" "@path");created=1618884475;keyid="test-key"' } })[SF_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Content-Digest': 'sha-256=:AbC=:' } })[DIGEST_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Content-Digest': 'sha-256=:!!:' } })[DIGEST_TEST]).toBe('fail');
  });

  it('accepts RFC 9651 Date and Display String bare items and enforces digit limits', () => {
    expect(runScript(script, { code: 200, headers: { Priority: 'u=1;at=@1659578233' } })[SF_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Cache-Status': 'cache;msg=%"caf%c3%a9"' } })[SF_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Cache-Status': 'cache;msg=%"bad%ZZescape"' } })[SF_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Cache-Status': 'cache;msg=%"upper%C3%A9"' } })[SF_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { Priority: 'u=1234567890123456' } })[SF_TEST]).toBe('fail');
  });

  it('types Proxy-Status members per RFC 9209', () => {
    expect(runScript(script, { code: 200, headers: { 'Proxy-Status': 'proxy.example.net; error=connection_timeout; received-status=504' } })[PROXY_STATUS_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Proxy-Status': 'proxy.example.net; error="connection_timeout"' } })[PROXY_STATUS_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Proxy-Status': 'proxy.example.net; received-status="504"' } })[PROXY_STATUS_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Proxy-Status': 'proxy.example.net; details=unquoted' } })[PROXY_STATUS_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Proxy-Status': '("inner" "list")' } })[PROXY_STATUS_TEST]).toBe('fail');
    const advisory = runScript(script, { code: 200, headers: { 'Proxy-Status': 'proxy.example.net; error=made_up_error' } });
    expect(advisory[PROXY_STATUS_TEST]).toBe('pass');
    expect(advisory[`${ADVISORY_TEST} :: error`] ?? '').toBe('');
  });

  it('validates RFC 9421 message-signature structure', () => {
    const okInput = 'sig1=("@method" "content-type");created=1618884475;expires=1618884775;keyid="k1"';
    expect(runScript(script, { code: 200, headers: { 'Signature-Input': okInput, Signature: 'sig1=:AbC=:' } })[SIGNATURE_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Signature-Input': okInput, Signature: 'other=:AbC=:' } })[SIGNATURE_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Signature-Input': okInput, Signature: 'sig1="not-bytes"' } })[SIGNATURE_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Signature-Input': 'sig1=("@bogus");created=1', Signature: 'sig1=:AbC=:' } })[SIGNATURE_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Signature-Input': 'sig1=("Content-Type")', Signature: 'sig1=:AbC=:' } })[SIGNATURE_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Signature-Input': 'sig1=("@method");created=2;expires=1', Signature: 'sig1=:AbC=:' } })[SIGNATURE_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Signature-Input': 'sig1="not-a-list"', Signature: 'sig1=:AbC=:' } })[SIGNATURE_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { Signature: 'sig1=:AbC=:' } })[SIGNATURE_TEST]).toBe('fail');
  });

  it('keeps RateLimit draft findings advisory-only', () => {
    expect(runScript(script, { code: 200, headers: { RateLimit: 'not==valid==sf' } })[RATELIMIT_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { RateLimit: '"default";r=50;t=30', 'RateLimit-Policy': '"default";q=100;w=60' } })[RATELIMIT_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { RateLimit: '"default";r=150', 'RateLimit-Policy': '"default";q=100' } })[RATELIMIT_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'X-RateLimit-Remaining': '5' } })[RATELIMIT_TEST]).toBe('pass');
  });

  it('enforces Set-Cookie grammar, attribute rules, and prefixes per RFC 6265', () => {
    expect(runScript(script, { code: 200, headers: { 'Set-Cookie': 'sid=abc123; Path=/; Secure; HttpOnly; SameSite=Lax' } })[COOKIE_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Set-Cookie': 'no-equals-sign' } })[COOKIE_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Set-Cookie': 'bad name=x' } })[COOKIE_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Set-Cookie': 'sid=has space' } })[COOKIE_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Set-Cookie': 'sid=x; Max-Age=abc' } })[COOKIE_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Set-Cookie': 'sid=x; Max-Age=3600; Secure' } })[COOKIE_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Set-Cookie': 'sid=x; Expires=not-a-date' } })[COOKIE_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Set-Cookie': 'sid=x; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure' } })[COOKIE_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Set-Cookie': 'sid=x; Secure; Secure' } })[COOKIE_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Set-Cookie': 'sid=x; Secure=please' } })[COOKIE_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Set-Cookie': 'sid=x; SameSite=None' } })[COOKIE_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Set-Cookie': 'sid=x; SameSite=None; Secure' } })[COOKIE_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Set-Cookie': 'sid=x; SameSite=Sometimes; Secure' } })[COOKIE_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Set-Cookie': '__Host-sid=x; Secure; Path=/' } })[COOKIE_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Set-Cookie': '__Host-sid=x; Secure; Path=/app' } })[COOKIE_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Set-Cookie': '__Host-sid=x; Secure; Path=/; Domain=example.com' } })[COOKIE_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Set-Cookie': '__Secure-sid=x; Path=/' } })[COOKIE_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Set-Cookie': '__Secure-sid=x; Secure' } })[COOKIE_TEST]).toBe('pass');
    const bare = runScript(script, { code: 200, headers: { 'Set-Cookie': 'sid=x' } });
    expect(bare[COOKIE_TEST]).toBe('pass');
    expect(bare[`${ADVISORY_TEST} :: error`] ?? '').toBe('');
  });

  it('enforces HSTS and security-header enums', () => {
    expect(runScript(script, { code: 200, headers: { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload' } })[SECURITY_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Strict-Transport-Security': 'includeSubDomains' } })[SECURITY_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Strict-Transport-Security': 'max-age=abc' } })[SECURITY_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Strict-Transport-Security': 'max-age=60; max-age=60' } })[SECURITY_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Strict-Transport-Security': 'max-age=60; includeSubDomains=yes' } })[SECURITY_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'X-Content-Type-Options': 'nosniff' } })[SECURITY_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'X-Content-Type-Options': 'sniff' } })[SECURITY_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Referrer-Policy': 'strict-origin-when-cross-origin' } })[SECURITY_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Referrer-Policy': 'no-referrer, unsafe-url' } })[SECURITY_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Referrer-Policy': 'sometimes' } })[SECURITY_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Permissions-Policy': 'geolocation=(), camera=(self)' } })[SECURITY_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Permissions-Policy': 'geolocation=&&' } })[SECURITY_TEST]).toBe('fail');
  });

  it('enforces CORS header grammar per WHATWG Fetch', () => {
    expect(runScript(script, { code: 200, headers: { 'Access-Control-Allow-Origin': '*' } })[CORS_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Access-Control-Allow-Origin': 'null' } })[CORS_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Access-Control-Allow-Origin': 'https://app.example.com', Vary: 'Origin' } })[CORS_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Access-Control-Allow-Origin': 'https://app.example.com/' } })[CORS_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Access-Control-Allow-Origin': 'https://a.com https://b.com' } })[CORS_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Credentials': 'true' } })[CORS_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Access-Control-Allow-Credentials': 'True' } })[CORS_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Access-Control-Allow-Origin': 'https://app.example.com', 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' } })[CORS_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } })[CORS_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Access-Control-Allow-Methods': 'GET,, POST' } })[CORS_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Access-Control-Expose-Headers': 'X-Total-Count, ETag' } })[CORS_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Access-Control-Allow-Headers': 'Bad Header Name' } })[CORS_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Access-Control-Max-Age': '86400' } })[CORS_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Access-Control-Max-Age': 'soon' } })[CORS_TEST]).toBe('fail');
    const varyAdvisory = runScript(script, { code: 200, headers: { 'Access-Control-Allow-Origin': 'https://app.example.com' } });
    expect(varyAdvisory[CORS_TEST]).toBe('pass');
  });

  it('extends Cache-Control checks with RFC 8246 immutable and valueless directives', () => {
    expect(runScript(script, { code: 200, headers: { 'Cache-Control': 'max-age=60, immutable' } })[GRAMMARS]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Cache-Control': 'immutable=1' } })[GRAMMARS]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Cache-Control': 'no-store=please' } })[GRAMMARS]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Cache-Control': 'stale-while-revalidate=60, stale-if-error=120' } })[GRAMMARS]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Cache-Control': 'stale-while-revalidate' } })[GRAMMARS]).toBe('fail');
  });

  it('validates Trailer and Alt-Svc grammar', () => {
    expect(runScript(script, { code: 200, headers: { Trailer: 'Server-Timing, X-Checksum' } })[GRAMMARS]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { Trailer: 'Content-Length' } })[GRAMMARS]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { Trailer: 'Authorization' } })[GRAMMARS]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { Trailer: 'Bad Field' } })[GRAMMARS]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Alt-Svc': 'clear' } })[GRAMMARS]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Alt-Svc': 'h3=":443"; ma=2592000; persist=1' } })[GRAMMARS]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Alt-Svc': 'h3=":443", h2="alt.example.com:443"' } })[GRAMMARS]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Alt-Svc': 'h3=:443' } })[GRAMMARS]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Alt-Svc': 'h3=":443"; ma=soon' } })[GRAMMARS]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Alt-Svc': 'h3=":443"; persist=2' } })[GRAMMARS]).toBe('fail');
  });

  it('upgrades SSE checks with the id NUL rule while staying silent on benign streams', () => {
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'id: 7\ndata: {}\n\n' })[MEDIA_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'id: a\u0000b\ndata: {}\n\n' })[MEDIA_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, headers: { 'Content-Type': 'text/event-stream' }, body: '\uFEFFdata: {}\n\n' })[MEDIA_TEST]).toBe('pass');
  });

  it('validates Idempotency-Key and raw multipart request bodies', () => {
    expect(runScript(script, { code: 200, requestHeaders: { 'Idempotency-Key': '"key-123"' } })[MULTIPART_TEST]).toBe('pass');
    expect(runScript(script, { code: 200, requestHeaders: { 'Idempotency-Key': 'bare-token' } })[MULTIPART_TEST]).toBe('fail');
    expect(runScript(script, { code: 200, requestHeaders: { 'Idempotency-Key': '""' } })[MULTIPART_TEST]).toBe('fail');
    const multipartBody = (parts: string) => ({ mode: 'raw', raw: parts });
    expect(runScript(script, {
      code: 200,
      requestHeaders: { 'Content-Type': 'multipart/form-data; boundary=xyz' },
      requestBody: multipartBody('--xyz\r\nContent-Disposition: form-data; name="file"\r\n\r\ndata\r\n--xyz--')
    })[MULTIPART_TEST]).toBe('pass');
    expect(runScript(script, {
      code: 200,
      requestHeaders: { 'Content-Type': 'multipart/form-data' },
      requestBody: multipartBody('--xyz\r\nContent-Disposition: form-data; name="file"\r\n\r\ndata\r\n--xyz--')
    })[MULTIPART_TEST]).toBe('fail');
    expect(runScript(script, {
      code: 200,
      requestHeaders: { 'Content-Type': 'multipart/form-data; boundary=xyz' },
      requestBody: multipartBody('--xyz\r\nContent-Type: text/plain\r\n\r\ndata\r\n--xyz--')
    })[MULTIPART_TEST]).toBe('fail');
    expect(runScript(script, {
      code: 200,
      requestHeaders: { 'Content-Type': 'multipart/form-data; boundary=xyz' },
      requestBody: multipartBody('--xyz\r\nContent-Disposition: attachment; name="file"\r\n\r\ndata\r\n--xyz--')
    })[MULTIPART_TEST]).toBe('fail');
    expect(runScript(script, {
      code: 200,
      requestHeaders: { 'Content-Type': 'multipart/form-data; boundary=xyz' },
      requestBody: multipartBody('--xyz\r\nContent-Disposition: form-data\r\n\r\ndata\r\n--xyz--')
    })[MULTIPART_TEST]).toBe('fail');
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

  it('validates content codings, declared Content-Disposition, Retry-After ordering, and Content-Length bytes', () => {
    const dispositionSpec = [
      'openapi: 3.1.0',
      'info: { title: T, version: 1 }',
      'paths:',
      '  /download:',
      '    get:',
      '      responses:',
      "        '200':",
      '          description: OK',
      '          headers:',
      '            Content-Disposition: { schema: { type: string } }',
      '          content:',
      '            text/plain:',
      '              schema: { type: string }',
      ''
    ].join('\n');
    const dispositionScript = createContractScript(indexFrom(dispositionSpec).operations[0]!).join('\n');
    expect(runScript(script, { code: 200, headers: { 'Content-Encoding': 'gzip' } })[GRAMMARS]).toBe('pass');
    expect(runScript(script, { code: 200, headers: { 'Content-Encoding': 'madeup' } })[GRAMMARS]).toBe('fail');
    expect(runScript(dispositionScript, { code: 200, headers: { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="x.txt"; filename*=UTF-8\'\'x.txt', 'Content-Length': '2' }, body: 'ok' })[GRAMMARS]).toBe('pass');
    expect(runScript(dispositionScript, { code: 200, headers: { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename=x; filename=y', 'Content-Length': '2' }, body: 'ok' })[GRAMMARS]).toBe('fail');
    expect(runScript(script, { code: 503, headers: { Date: 'Wed, 21 Oct 2026 07:28:00 GMT', 'Retry-After': 'Wed, 21 Oct 2025 07:28:00 GMT' } })[RFC9110]).toBe('fail');
    expect(runScript(dispositionScript, { code: 200, headers: { 'Content-Type': 'text/plain', 'Content-Length': '3' }, body: 'ok' })['Content-Length is consistent with OpenAPI body expectations']).toBe('fail');
    expect(runScript(dispositionScript, { code: 200, headers: { 'Content-Type': 'text/plain', 'Content-Length': '3', 'Content-Encoding': 'gzip' }, body: 'ok' })['Content-Length is consistent with OpenAPI body expectations']).toBe('pass');
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


describe('RFC 9110 15.4.5 304 header consistency', () => {
  const SPEC_304 = [
    'openapi: 3.1.0',
    'info:',
    '  title: T',
    '  version: 1.0.0',
    'paths:',
    '  /cached:',
    '    get:',
    '      responses:',
    "        '200':",
    '          description: OK',
    '          headers:',
    '            ETag: { schema: { type: string } }',
    '            Cache-Control: { schema: { type: string } }',
    '          content:',
    '            application/json:',
    '              schema: { type: object }',
    "        '304':",
    '          description: Not Modified',
    ''
  ].join('\n');
  const script = createContractScript(indexFrom(SPEC_304).operations[0]!).join('\n');

  it('requires 304 responses to carry the headers the spec declares on the 200', () => {
    expect(runScript(script, { code: 304 })[RFC9110]).toBe('fail');
    expect(runScript(script, { code: 304, headers: { ETag: '"v1"' } })[RFC9110]).toBe('fail');
    expect(runScript(script, { code: 304, headers: { ETag: '"v1"', 'Cache-Control': 'max-age=60' } })[RFC9110]).toBe('pass');
  });

  it('does not demand undeclared headers on a 304', () => {
    const plain = createContractScript(indexFrom(SPEC).operations.find((op) => op.method === 'GET')!).join('\n');
    expect(runScript(plain, { code: 304 })[RFC9110]).toBe('pass');
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

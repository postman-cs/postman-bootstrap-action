import { describe, expect, it } from 'vitest';
import { createContext, runInContext } from 'node:vm';

import { createContractScript } from '../src/lib/spec/collection-contracts.js';
import { buildContractIndex } from '../src/lib/spec/contract-index.js';
import { parseOpenApiDocument } from '../src/lib/spec/openapi-loader.js';

const BLOCK = 'Response satisfies RFC 9110 range, negotiation, and cache conventions';

interface Stub { code: number; headers?: Record<string, string>; requestHeaders?: Record<string, string>; body?: string; }

function run(script: string, response: Stub): { results: Record<string, string>; messages: string[] } {
  const results: Record<string, string> = {};
  const messages: string[] = [];
  // The Proxy-backed Chai stub is intentionally dynamic in this harness.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const permissive: any = new Proxy(function () {}, {
    get: (_t, p) => (p === 'fail' ? (m: string) => { throw new Error(m); } : permissive),
    apply: () => permissive
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const expectFn: any = function (_value: unknown, message?: unknown) { if (message !== undefined) messages.push(String(message)); return permissive; };
  expectFn.fail = (m: string) => { throw new Error(m); };
  const headerEntries = Object.entries(response.headers ?? {});
  const headerMap = new Map(headerEntries.map(([k, v]) => [k.toLowerCase(), v]));
  const reqEntries = Object.entries(response.requestHeaders ?? {});
  const body = response.body ?? '';
  const pm = {
    test: (name: string, cb: () => void) => { try { cb(); results[name] = 'pass'; } catch (e) { results[name] = 'fail'; results[name + ' :: error'] = String(e); } },
    expect: expectFn,
    response: {
      code: response.code, to: permissive,
      headers: { get: (n: string) => headerMap.get(n.toLowerCase()) ?? null, each: (cb: (h: { key: string; value: string }) => void) => headerEntries.forEach(([key, value]) => cb({ key, value })) },
      text: () => body, json: () => JSON.parse(body)
    },
    request: { headers: { each: (cb: (h: { key: string; value: string; disabled: boolean }) => void) => reqEntries.forEach(([key, value]) => cb({ key, value, disabled: false })) }, body: undefined, url: { query: { each: () => undefined } } }
  };
  runInContext(script, createContext({ pm }));
  return { results, messages };
}
function scriptOf(spec: string, method: string): string {
  return createContractScript(buildContractIndex(parseOpenApiDocument(spec)).operations.find((o) => o.method === method)!).join('\n');
}
function op(method: string, respFlow: string): string {
  return 'openapi: 3.1.0\ninfo: {title: T, version: 1}\npaths:\n  /a:\n    ' + method + ':\n      responses: ' + respFlow;
}
const GET = op('get', '{"200": {description: ok}, "206": {description: p}, "416": {description: r}, "426": {description: u}, "300": {description: c}, "451": {description: l}, "415": {description: e}, "428": {description: q}, "500": {description: s}}');
function failMsg(r: { results: Record<string, string> }): string { return r.results[BLOCK + ' :: error'] || (r.results[BLOCK] || ''); }

describe('rest_runtime_http_core range/negotiation/cache (failing checks)', () => {
  it('5/6 range status on non-GET', () => {
    const r = run(scriptOf(op('post', '{"200": {description: ok}, "206": {description: p}}'), 'POST'), { code: 206, headers: { 'Content-Range': 'bytes 0-1/9' }, requestHeaders: { Range: 'bytes=0-1' } });
    expect(r.results[BLOCK]).toBe('fail'); expect(failMsg(r)).toContain('answer GET range requests');
  });
  it('7 Content-Range on wrong status', () => {
    const r = run(scriptOf(GET, 'GET'), { code: 200, headers: { 'Content-Range': 'bytes 0-1/9' } });
    expect(failMsg(r)).toContain('meaningful only on 206 and 416');
  });
  it('8 range unit mismatch', () => {
    const r = run(scriptOf(GET, 'GET'), { code: 206, headers: { 'Content-Range': 'bytes 0-1/9' }, requestHeaders: { Range: 'items=0-1' } });
    expect(failMsg(r)).toContain('must match the request Range unit');
  });
  it('9 206 metadata parity with 200', () => {
    const spec = op('get', '{"200": {description: ok, headers: {ETag: {schema: {type: string}}}}, "206": {description: p}}');
    const r = run(scriptOf(spec, 'GET'), { code: 206, headers: { 'Content-Range': 'bytes 0-1/9' }, requestHeaders: { Range: 'bytes=0-1' } });
    expect(failMsg(r)).toContain('a 206 must include ETag');
  });
  it('10 single range answered with multipart/byteranges', () => {
    const r = run(scriptOf(GET, 'GET'), { code: 206, headers: { 'Content-Type': 'multipart/byteranges; boundary=x' }, requestHeaders: { Range: 'bytes=0-1' } });
    expect(failMsg(r)).toContain('single requested byte range must not be answered with multipart/byteranges');
  });
  it('11 206 interval not contained in requested range', () => {
    const r = run(scriptOf(GET, 'GET'), { code: 206, headers: { 'Content-Range': 'bytes 5-25/100' }, requestHeaders: { Range: 'bytes=10-20' } });
    expect(failMsg(r)).toContain('before the requested range start');
  });
  it('13 426 without Upgrade', () => {
    const r = run(scriptOf(GET, 'GET'), { code: 426 });
    expect(failMsg(r)).toContain('requires an Upgrade header on 426');
  });
  it('14 invalid response Accept-Encoding coding', () => {
    const r = run(scriptOf(GET, 'GET'), { code: 200, headers: { 'Accept-Encoding': 'boguscoding' } });
    expect(failMsg(r)).toContain('IANA content-coding registry');
  });
  it('16 identity in Content-Encoding', () => {
    const r = run(scriptOf(GET, 'GET'), { code: 200, headers: { 'Content-Encoding': 'identity' } });
    expect(failMsg(r)).toContain('identity must not appear in Content-Encoding');
  });
  it('17 response uses a q=0 coding', () => {
    const r = run(scriptOf(GET, 'GET'), { code: 200, headers: { 'Content-Encoding': 'gzip' }, requestHeaders: { 'Accept-Encoding': 'gzip;q=0' } });
    expect(failMsg(r)).toContain('the request Accept-Encoding set to q=0');
  });
  it('21 Link without rel', () => {
    const r = run(scriptOf(GET, 'GET'), { code: 200, headers: { Link: '<https://x/next>' } });
    expect(failMsg(r)).toContain('must include a rel parameter');
  });
  it('23 Sunset earlier than Deprecation', () => {
    const r = run(scriptOf(GET, 'GET'), { code: 200, headers: { Sunset: 'Wed, 01 Jan 2020 00:00:00 GMT', Deprecation: '@4102444800' } });
    expect(failMsg(r)).toContain('Sunset date must not be earlier than the Deprecation date');
  });
  it('24 quoted max-age', () => {
    const r = run(scriptOf(GET, 'GET'), { code: 200, headers: { 'Cache-Control': 'max-age="60"' } });
    expect(failMsg(r)).toContain('must be an unquoted delta-seconds');
  });
  it('25 no-cache with unquoted field list', () => {
    const r = run(scriptOf(GET, 'GET'), { code: 200, headers: { 'Cache-Control': 'no-cache=field' } });
    expect(failMsg(r)).toContain('must be a quoted field-name list');
  });
});

describe('rest_runtime_http_core range/negotiation/cache (advisories)', () => {
  const msgs = (spec: string, method: string, resp: Stub) => run(scriptOf(spec, method), resp).messages.join(' || ');
  it('12 206 body length mismatch advisory', () => {
    expect(msgs(GET, 'GET', { code: 206, headers: { 'Content-Range': 'bytes 0-9/100' }, requestHeaders: { Range: 'bytes=0-9' }, body: 'abc' })).toContain('206 body length');
  });
  it('15 415 with Accept-Encoding advisory', () => {
    expect(msgs(GET, 'GET', { code: 415, headers: { 'Accept-Encoding': 'gzip' } })).toContain('415 carrying Accept-Encoding');
  });
  it('18 Vary should include Accept-Encoding', () => {
    expect(msgs(GET, 'GET', { code: 200, headers: { 'Content-Encoding': 'gzip', Vary: 'Accept' } })).toContain('SHOULD list Accept-Encoding in Vary');
  });
  it('19 Vary should include Accept-Language', () => {
    expect(msgs(GET, 'GET', { code: 200, headers: { 'Content-Language': 'en', Vary: 'Accept' } })).toContain('SHOULD list Accept-Language in Vary');
  });
  it('20 300 empty body advisory', () => {
    expect(msgs(GET, 'GET', { code: 300, body: '' })).toContain('300 Multiple Choices');
  });
  it('22 451 without blocked-by Link advisory', () => {
    expect(msgs(GET, 'GET', { code: 451 })).toContain('rel=blocked-by');
  });
  it('26 must-understand without no-store advisory', () => {
    expect(msgs(GET, 'GET', { code: 200, headers: { 'Cache-Control': 'must-understand' } })).toContain('must-understand SHOULD be accompanied by no-store');
  });
  it('27 non-storable status with cacheable directives advisory', () => {
    expect(msgs(GET, 'GET', { code: 428, headers: { 'Cache-Control': 'max-age=60' } })).toContain('should not be stored by a shared cache');
  });
  it('28 PATCH Content-Location advisory', () => {
    expect(msgs(op('patch', '{"200": {description: ok}}'), 'PATCH', { code: 200, headers: { 'Content-Location': '/a/1' } })).toContain('PATCH Content-Location');
  });
  it('29 OPTIONS should advertise Accept-Patch', () => {
    const spec = 'openapi: 3.1.0\ninfo: {title: T, version: 1}\npaths:\n  /a:\n    options: {responses: {"200": {description: ok}}}\n    patch: {responses: {"200": {description: ok}}}';
    expect(msgs(spec, 'OPTIONS', { code: 200 })).toContain('supports PATCH SHOULD list Accept-Patch');
  });
});

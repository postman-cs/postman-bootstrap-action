import { describe, expect, it } from 'vitest';

import { buildContractIndex } from '../src/lib/spec/contract-index.js';
import { parseOpenApiDocument } from '../src/lib/spec/openapi-loader.js';

function warns(spec: string): string[] {
  return buildContractIndex(parseOpenApiDocument(spec)).operations[0]!.warnings;
}
function has(spec: string, code: string): boolean {
  return warns(spec).some((w) => w.indexOf(code) === 0);
}
function mk(body: string): string {
  return 'openapi: 3.1.0\ninfo: {title: T, version: 1}\npaths:\n  /a:\n' + body;
}

describe('RFC 9110 HTTP-semantics static lints', () => {
  it('1 flags HEAD responses that declare a body', () => {
    expect(has(mk('    head:\n      responses:\n        "200": {description: ok, content: {application/json: {schema: {type: object}}}}'), 'CONTRACT_HEAD_RESPONSE_BODY')).toBe(true);
  });
  it('2 flags 1xx responses that declare content', () => {
    expect(has(mk('    get:\n      responses:\n        "103": {description: hints, content: {application/json: {schema: {type: object}}}}\n        "200": {description: ok}'), 'CONTRACT_BODYLESS_STATUS_WITH_CONTENT')).toBe(true);
  });
  it('3 flags framing headers on 204', () => {
    expect(has(mk('    delete:\n      responses:\n        "204": {description: nc, headers: {Content-Length: {schema: {type: integer}}}}'), 'CONTRACT_BODYLESS_STATUS_FRAMING_HEADER')).toBe(true);
  });
  it('4 flags 304 on non-GET/HEAD', () => {
    expect(has(mk('    post:\n      responses:\n        "304": {description: nm}\n        "200": {description: ok}'), 'CONTRACT_304_METHOD')).toBe(true);
  });
  it('5 flags 304 that omits required 200 cache headers', () => {
    expect(has(mk('    get:\n      responses:\n        "200": {description: ok, headers: {ETag: {required: true, schema: {type: string}}}}\n        "304": {description: nm}'), 'CONTRACT_304_CACHE_HEADER_MISSING')).toBe(true);
  });
  it('6 flags 304 Content-Length', () => {
    expect(has(mk('    get:\n      responses:\n        "304": {description: nm, headers: {Content-Length: {schema: {type: integer}}}}\n        "200": {description: ok}'), 'CONTRACT_304_CONTENT_LENGTH')).toBe(true);
  });
  it('7 flags Range header on non-GET', () => {
    expect(has(mk('    post:\n      parameters: [{name: Range, in: header, schema: {type: string}}]\n      responses: {"200": {description: ok}}'), 'CONTRACT_RANGE_METHOD')).toBe(true);
  });
  it('8 flags 206 without GET or Range affordance', () => {
    expect(has(mk('    post:\n      responses:\n        "206": {description: partial, headers: {Content-Range: {schema: {type: string}}}}\n        "200": {description: ok}'), 'CONTRACT_206_METHOD')).toBe(true);
    expect(has(mk('    get:\n      responses:\n        "206": {description: partial, headers: {Content-Range: {schema: {type: string}}}}\n        "200": {description: ok}'), 'CONTRACT_206_RANGE_AFFORDANCE')).toBe(true);
  });
  it('9 flags 206 without Content-Range', () => {
    expect(has(mk('    get:\n      parameters: [{name: Range, in: header, schema: {type: string}}]\n      responses:\n        "206": {description: partial}\n        "200": {description: ok}'), 'CONTRACT_206_CONTENT_RANGE')).toBe(true);
  });
  it('10 flags 206 that omits required 200 cache headers', () => {
    expect(has(mk('    get:\n      parameters: [{name: Range, in: header, schema: {type: string}}]\n      responses:\n        "200": {description: ok, headers: {ETag: {required: true, schema: {type: string}}}}\n        "206": {description: partial, headers: {Content-Range: {schema: {type: string}}}}'), 'CONTRACT_206_CACHE_HEADER_MISSING')).toBe(true);
  });
  it('11 flags 416 without Content-Range', () => {
    expect(has(mk('    get:\n      responses:\n        "416": {description: bad range}\n        "200": {description: ok}'), 'CONTRACT_416_CONTENT_RANGE')).toBe(true);
  });
  it('12 flags If-Range without GET+Range', () => {
    expect(has(mk('    post:\n      parameters: [{name: If-Range, in: header, schema: {type: string}}]\n      responses: {"200": {description: ok}}'), 'CONTRACT_IF_RANGE_PRECONDITION')).toBe(true);
  });
  it('13 flags If-Range without a 206 response', () => {
    expect(has(mk('    get:\n      parameters: [{name: If-Range, in: header, schema: {type: string}}, {name: Range, in: header, schema: {type: string}}]\n      responses: {"200": {description: ok}}'), 'CONTRACT_IF_RANGE_RESPONSES')).toBe(true);
  });
  it('14 flags If-Modified-Since without 304', () => {
    expect(has(mk('    get:\n      parameters: [{name: If-Modified-Since, in: header, schema: {type: string}}]\n      responses: {"200": {description: ok}}'), 'CONTRACT_IF_MODIFIED_SINCE')).toBe(true);
  });
  it('15 flags If-None-Match without 304', () => {
    expect(has(mk('    get:\n      parameters: [{name: If-None-Match, in: header, schema: {type: string}}]\n      responses: {"200": {description: ok}}'), 'CONTRACT_IF_NONE_MATCH_STATUS')).toBe(true);
  });
  it('16 flags If-Match without 412', () => {
    expect(has(mk('    put:\n      parameters: [{name: If-Match, in: header, schema: {type: string}}]\n      responses: {"200": {description: ok}}'), 'CONTRACT_PRECONDITION_412')).toBe(true);
  });
  it('17 flags 428 without a conditional affordance', () => {
    expect(has(mk('    put:\n      responses:\n        "428": {description: precondition required}\n        "200": {description: ok}'), 'CONTRACT_428_AFFORDANCE')).toBe(true);
  });
  it('18 flags cache headers on non-storable statuses', () => {
    expect(has(mk('    get:\n      responses:\n        "429": {description: slow down, headers: {Cache-Control: {required: true, schema: {type: string}}}}\n        "200": {description: ok}'), 'CONTRACT_NONCACHEABLE_STATUS_CACHE_HEADER')).toBe(true);
  });
  it('19 flags secured 401 without WWW-Authenticate', () => {
    expect(has(mk('    get:\n      security: [{apiKeyAuth: []}]\n      responses: {"200": {description: ok}, "401": {description: no}}') + '\ncomponents: {securitySchemes: {apiKeyAuth: {type: apiKey, in: header, name: X-Key}}}', 'CONTRACT_401_WWW_AUTHENTICATE')).toBe(true);
  });
  it('20 flags Bearer 401 challenge as not literal-validated', () => {
    expect(has(mk('    get:\n      security: [{bearerAuth: []}]\n      responses: {"200": {description: ok}, "401": {description: no, headers: {WWW-Authenticate: {schema: {type: string}}}}}') + '\ncomponents: {securitySchemes: {bearerAuth: {type: http, scheme: bearer}}}', 'CONTRACT_BEARER_CHALLENGE_NOT_VALIDATED')).toBe(true);
  });
  it('21 flags 407 without Proxy-Authenticate', () => {
    expect(has(mk('    get:\n      responses:\n        "407": {description: proxy}\n        "200": {description: ok}'), 'CONTRACT_407_PROXY_AUTHENTICATE')).toBe(true);
  });
  it('22 flags 405 without Allow', () => {
    expect(has(mk('    get:\n      responses:\n        "405": {description: nope}\n        "200": {description: ok}'), 'CONTRACT_405_ALLOW')).toBe(true);
  });
  it('23 flags 426 without Upgrade', () => {
    expect(has(mk('    get:\n      responses:\n        "426": {description: upgrade}\n        "200": {description: ok}'), 'CONTRACT_426_UPGRADE')).toBe(true);
  });
  it('24 flags redirect without Location', () => {
    expect(has(mk('    get:\n      responses:\n        "301": {description: moved}\n        "200": {description: ok}'), 'CONTRACT_REDIRECT_LOCATION')).toBe(true);
  });
  it('25 flags 202 without a monitor affordance', () => {
    expect(has(mk('    post:\n      responses:\n        "202": {description: accepted}\n        "200": {description: ok}'), 'CONTRACT_202_MONITOR')).toBe(true);
  });
  it('26/27/28 flags problem+json members as not validated', () => {
    const spec = mk('    get:\n      responses:\n        "400": {description: bad, content: {application/problem+json: {schema: {type: object}}}}\n        "200": {description: ok}');
    expect(has(spec, 'CONTRACT_PROBLEM_JSON_SHAPE_NOT_VALIDATED')).toBe(true);
    expect(has(spec, 'CONTRACT_PROBLEM_STATUS_NOT_VALIDATED')).toBe(true);
    expect(has(spec, 'CONTRACT_PROBLEM_EXTENSION_NOT_VALIDATED')).toBe(true);
  });
  it('29 flags problem+xml as not validated', () => {
    expect(has(mk('    get:\n      responses:\n        "400": {description: bad, content: {application/problem+xml: {schema: {type: object}}}}\n        "200": {description: ok}'), 'CONTRACT_PROBLEM_XML_NOT_VALIDATED')).toBe(true);
  });
  it('30/31/32 flags OpenAPI Link objects', () => {
    const spec = mk('    get:\n      responses:\n        "200": {description: ok, links: {L: {operationRef: "#/paths/~1b/get", parameters: {id: "$request.path.id"}}}}');
    expect(has(spec, 'CONTRACT_LINK_OPERATION_REF_NOT_VALIDATED')).toBe(true);
    expect(has(spec, 'CONTRACT_LINK_PARAMETERS_NOT_VALIDATED')).toBe(true);
    expect(has(spec, 'CONTRACT_LINK_REQUEST_EXPRESSION_NOT_VALIDATED')).toBe(true);
  });
  it('33 flags Link response header', () => {
    expect(has(mk('    get:\n      responses:\n        "200": {description: ok, headers: {Link: {schema: {type: string}}}}'), 'CONTRACT_LINK_HEADER_NOT_VALIDATED')).toBe(true);
  });
  it('34 flags unbound server template variables', () => {
    expect(has('openapi: 3.1.0\ninfo: {title: T, version: 1}\nservers: [{url: "https://{host}/v1"}]\npaths:\n  /a:\n    get:\n      responses: {"200": {description: ok}}', 'CONTRACT_SERVER_URL_UNBOUND_VARIABLE')).toBe(true);
  });
  it('35 flags cleartext server on a secured op', () => {
    expect(has('openapi: 3.1.0\ninfo: {title: T, version: 1}\nservers: [{url: "http://api.example.com"}]\nsecurity: [{apiKeyAuth: []}]\npaths:\n  /a:\n    get:\n      responses: {"200": {description: ok}, "401": {description: no, headers: {WWW-Authenticate: {schema: {type: string}}}}}\ncomponents: {securitySchemes: {apiKeyAuth: {type: apiKey, in: header, name: X-Key}}}', 'CONTRACT_INSECURE_SERVER_FOR_SECURED_OP')).toBe(true);
  });
  it('36 flags access_token query parameter', () => {
    expect(has(mk('    get:\n      parameters: [{name: access_token, in: query, schema: {type: string}}]\n      responses: {"200": {description: ok}}'), 'CONTRACT_OAUTH_TOKEN_IN_QUERY')).toBe(true);
  });
  it('37 flags structured standard headers as not literal-validated', () => {
    expect(has(mk('    get:\n      responses:\n        "503": {description: down, headers: {Retry-After: {schema: {type: string}}}}\n        "200": {description: ok}'), 'CONTRACT_STANDARD_HEADER_GRAMMAR_NOT_VALIDATED')).toBe(true);
  });
  it('38 flags 451 without a blocking Link', () => {
    expect(has(mk('    get:\n      responses:\n        "451": {description: legal}\n        "200": {description: ok}'), 'CONTRACT_451_BLOCKED_BY_LINK')).toBe(true);
  });
  it('does not fire on a clean minimal GET', () => {
    const w = warns(mk('    get:\n      responses: {"200": {description: ok}}'));
    expect(w.some((x) => x.startsWith('CONTRACT_HEAD_RESPONSE_BODY') || x.startsWith('CONTRACT_304_') || x.startsWith('CONTRACT_206_') || x.startsWith('CONTRACT_REDIRECT_LOCATION') || x.startsWith('CONTRACT_405_ALLOW'))).toBe(false);
  });
});


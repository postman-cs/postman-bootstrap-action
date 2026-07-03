import { asRecord, asArray, resolveInternalRef } from './contract-index.js';

type Rec = NonNullable<ReturnType<typeof asRecord>>;

const CACHE_HEADERS_304 = ['etag', 'content-location', 'date', 'vary', 'cache-control', 'expires'];
const CACHE_HEADERS_206 = ['date', 'etag', 'content-location', 'cache-control', 'expires', 'vary'];
const REDIRECT_STATUSES = ['301', '302', '303', '307', '308'];
const NONCACHEABLE_STATUSES = ['428', '429', '431', '511'];
const STRUCTURED_HEADERS = ['retry-after', 'content-range', 'www-authenticate', 'proxy-authenticate', 'allow', 'accept-ranges', 'upgrade'];

interface RInfo { headers: Set<string>; requiredHeaders: Set<string>; content: Set<string>; links: Rec[]; }

function mergedParams(root: Rec, pathItem: Rec, operation: Rec): Rec[] {
  const seen = new Map<string, Rec>();
  const collect = (arr: unknown): void => {
    for (const raw of asArray(arr)) {
      const p = resolveInternalRef(root, raw) ?? asRecord(raw);
      if (!p) continue;
      const key = String((p as Rec).in ?? '').toLowerCase() + ':' + String((p as Rec).name ?? '').toLowerCase();
      seen.set(key, p as Rec);
    }
  };
  collect(pathItem.parameters);
  collect(operation.parameters);
  return [...seen.values()];
}

function isSecured(root: Rec, operation: Rec): boolean {
  if (operation.security !== undefined) return asArray(operation.security).length > 0;
  return asArray(root.security).length > 0;
}

function effectiveSecurity(root: Rec, operation: Rec): unknown[] {
  return operation.security !== undefined ? asArray(operation.security) : asArray(root.security);
}

function usesBearerScheme(root: Rec, operation: Rec): boolean {
  const schemes = asRecord(asRecord(root.components)?.securitySchemes) ?? {};
  return effectiveSecurity(root, operation).some((req) => {
    const names = Object.keys(asRecord(req) ?? {});
    return names.some((name) => {
      const s = resolveInternalRef(root, (schemes as Rec)[name]) ?? asRecord((schemes as Rec)[name]);
      return !!s && String((s as Rec).type ?? '').toLowerCase() === 'http' && String((s as Rec).scheme ?? '').toLowerCase() === 'bearer';
    });
  });
}

function substituteServerUrl(root: Rec, server: Rec): string {
  let url = typeof server.url === 'string' ? server.url : '';
  const vars = asRecord(server.variables) ?? {};
  for (const [name, rawVar] of Object.entries(vars)) {
    const v = asRecord(rawVar);
    const def = v && typeof v.default === 'string' ? v.default : '';
    url = url.split('{' + name + '}').join(def);
  }
  return url;
}

export function collectHttpSemanticStaticLints(root: Rec, method: string, path: string, pathItem: Rec, operation: Rec, responses: Rec): string[] {
  const out: string[] = [];
  const where = method.toUpperCase() + ' ' + path;
  const params = mergedParams(root, pathItem, operation);
  const reqHeaders = new Set(params.filter((p) => String(p.in ?? '').toLowerCase() === 'header').map((p) => String(p.name ?? '').toLowerCase()));
  const queryParams = params.filter((p) => String(p.in ?? '').toLowerCase() === 'query').map((p) => String(p.name ?? ''));

  const byStatus = new Map<string, RInfo>();
  for (const [status, rawResp] of Object.entries(responses)) {
    const resp = resolveInternalRef(root, rawResp) ?? asRecord(rawResp);
    if (!resp) continue;
    const headersRec = asRecord((resp as Rec).headers) ?? {};
    const headers = new Set<string>();
    const requiredHeaders = new Set<string>();
    for (const [hn, rawH] of Object.entries(headersRec)) {
      const h = hn.toLowerCase();
      headers.add(h);
      const hr = resolveInternalRef(root, rawH) ?? asRecord(rawH);
      if (hr && (hr as Rec).required === true) requiredHeaders.add(h);
    }
    const contentRec = asRecord((resp as Rec).content) ?? {};
    const content = new Set<string>(Object.keys(contentRec).map((c) => (c.toLowerCase().split(';')[0] ?? '').trim()));
    const linksRec = asRecord((resp as Rec).links) ?? {};
    const links: Rec[] = [];
    for (const rawLink of Object.values(linksRec)) {
      const link = resolveInternalRef(root, rawLink) ?? asRecord(rawLink);
      if (link) links.push(link as Rec);
    }
    byStatus.set(status, { headers, requiredHeaders, content, links });
  }

  const statuses = [...byStatus.keys()];
  const declared = (code: string): boolean => statuses.includes(code);
  const info = (code: string): RInfo | undefined => byStatus.get(code);
  const hasSuccess = statuses.some((s) => /^2/.test(s) || s === '2XX' || s === 'default');
  const is1xx = (s: string): boolean => /^1[0-9][0-9]$/.test(s) || s === '1XX';

  // 1. HEAD responses carry no body
  if (method === 'head') {
    for (const [status, ri] of byStatus) {
      if (ri.content.size > 0 && (/^2/.test(status) || status === '2XX' || status === 'default')) {
        out.push('CONTRACT_HEAD_RESPONSE_BODY: ' + where + ' declares response content for status ' + status + '; HEAD responses carry no message body (RFC 9110 section 9.3.2)');
      }
    }
  }
  // 2. 1xx responses are bodyless
  for (const [status, ri] of byStatus) {
    if (is1xx(status) && ri.content.size > 0) {
      out.push('CONTRACT_BODYLESS_STATUS_WITH_CONTENT: ' + where + ' declares content for status ' + status + ', which RFC 9110 forbids on the wire');
    }
  }
  // 3. framing headers forbidden on 1xx and 204
  for (const [status, ri] of byStatus) {
    if (is1xx(status) || status === '204') {
      for (const framing of ['content-length', 'transfer-encoding']) {
        if (ri.headers.has(framing)) out.push('CONTRACT_BODYLESS_STATUS_FRAMING_HEADER: ' + where + ' status ' + status + ' declares a ' + framing + ' header; RFC 9110 forbids a message body and its framing for this status');
      }
    }
  }
  // 4. 304 only for GET/HEAD
  if (declared('304') && !['get', 'head'].includes(method)) out.push('CONTRACT_304_METHOD: ' + where + ' declares a 304 response, which RFC 9110 permits only for GET and HEAD');
  // 5. 304 mirrors required 200 cache headers
  if (declared('304')) {
    const r200 = info('200') ?? info('2XX');
    const r304 = info('304');
    if (r200 && r304) for (const h of CACHE_HEADERS_304) {
      if (r200.requiredHeaders.has(h) && !r304.headers.has(h)) out.push('CONTRACT_304_CACHE_HEADER_MISSING: ' + where + ' status 304 omits the ' + h + ' header required on its 200 representation (RFC 9110 section 15.4.5)');
    }
  }
  // 6. 304 Content-Length must mirror the selected representation
  if (declared('304') && info('304')?.headers.has('content-length')) out.push('CONTRACT_304_CONTENT_LENGTH: ' + where + ' status 304 declares a Content-Length header; a 304 carries no body and its Content-Length must equal the selected 200 representation (RFC 9110 section 15.4.5)');
  // 7. Range only on GET
  if (reqHeaders.has('range') && method !== 'get') out.push('CONTRACT_RANGE_METHOD: ' + where + ' declares a Range request header; RFC 9110 defines range requests only for GET');
  // 8. 206 pairs with GET range requests
  if (declared('206')) {
    if (method !== 'get') out.push('CONTRACT_206_METHOD: ' + where + ' declares a 206 response, which RFC 9110 pairs with GET range requests');
    else if (!reqHeaders.has('range')) out.push('CONTRACT_206_RANGE_AFFORDANCE: ' + where + ' declares a 206 response but no Range request header parameter to trigger it (RFC 9110 section 15.3.7)');
  }
  // 9. 206 needs Content-Range or multipart/byteranges
  if (declared('206')) {
    const r = info('206');
    const multipart = !!r && [...r.content].some((c) => c === 'multipart/byteranges');
    if (r && !r.headers.has('content-range') && !multipart) out.push('CONTRACT_206_CONTENT_RANGE: ' + where + ' status 206 declares neither a Content-Range header nor a multipart/byteranges body (RFC 9110 section 15.3.7)');
  }
  // 10. 206 mirrors required 200 cache headers
  if (declared('206')) {
    const r200 = info('200') ?? info('2XX');
    const r206 = info('206');
    if (r200 && r206) for (const h of CACHE_HEADERS_206) {
      if (r200.requiredHeaders.has(h) && !r206.headers.has(h)) out.push('CONTRACT_206_CACHE_HEADER_MISSING: ' + where + ' status 206 omits the ' + h + ' header required on its 200 representation (RFC 9110 section 15.3.7)');
    }
  }
  // 11. 416 needs Content-Range
  if (declared('416') && !info('416')?.headers.has('content-range')) out.push('CONTRACT_416_CONTENT_RANGE: ' + where + ' status 416 omits the Content-Range header (RFC 9110 section 15.5.17)');
  // 12. If-Range requires GET + Range
  if (reqHeaders.has('if-range') && (method !== 'get' || !reqHeaders.has('range'))) out.push('CONTRACT_IF_RANGE_PRECONDITION: ' + where + ' declares an If-Range request header without a GET Range request (RFC 9110 section 13.1.5)');
  // 13. If-Range response coverage
  if (reqHeaders.has('if-range')) {
    if (!declared('206')) out.push('CONTRACT_IF_RANGE_RESPONSES: ' + where + ' declares an If-Range request header but documents no 206 response (RFC 9110 section 13.1.5)');
    if (!hasSuccess) out.push('CONTRACT_IF_RANGE_RESPONSES: ' + where + ' declares an If-Range request header but documents no 200/2XX/default success response');
  }
  // 14. If-Modified-Since method/status
  if (reqHeaders.has('if-modified-since')) {
    if (!['get', 'head'].includes(method)) out.push('CONTRACT_IF_MODIFIED_SINCE: ' + where + ' declares an If-Modified-Since header; RFC 9110 evaluates it only for GET and HEAD');
    else if (!declared('304')) out.push('CONTRACT_IF_MODIFIED_SINCE: ' + where + ' declares an If-Modified-Since header but documents no 304 response (RFC 9110 section 13.1.3)');
  }
  // 15. If-None-Match status coverage
  if (reqHeaders.has('if-none-match')) {
    if (['get', 'head'].includes(method)) { if (!declared('304')) out.push('CONTRACT_IF_NONE_MATCH_STATUS: ' + where + ' declares an If-None-Match header but documents no 304 response (RFC 9110 section 13.1.2)'); }
    else if (!declared('412')) out.push('CONTRACT_IF_NONE_MATCH_STATUS: ' + where + ' declares an If-None-Match header on an unsafe method but documents no 412 response (RFC 9110 section 13.1.2)');
  }
  // 16. If-Match / If-Unmodified-Since need 412
  if ((reqHeaders.has('if-match') || reqHeaders.has('if-unmodified-since')) && !declared('412')) out.push('CONTRACT_PRECONDITION_412: ' + where + ' declares a precondition request header but documents no 412 response (RFC 9110 section 13.1)');
  // 17. 428 requires a conditional affordance
  if (declared('428')) {
    const conditional = ['if-match', 'if-none-match', 'if-unmodified-since', 'if-modified-since'].some((h) => reqHeaders.has(h));
    if (!conditional) out.push('CONTRACT_428_AFFORDANCE: ' + where + ' declares a 428 Precondition Required response but accepts no conditional request header (RFC 6585 section 3)');
  }
  // 18. non-storable statuses must not carry cache-storage headers
  for (const code of NONCACHEABLE_STATUSES) {
    const r = info(code);
    if (r && (r.requiredHeaders.has('cache-control') || r.requiredHeaders.has('expires') || r.headers.has('expires'))) out.push('CONTRACT_NONCACHEABLE_STATUS_CACHE_HEADER: ' + where + ' status ' + code + ' declares cache-storage headers, but this status must not be stored by a shared cache (RFC 6585)');
  }
  const secured = isSecured(root, operation);
  // 19. secured 401 needs WWW-Authenticate
  if (secured && declared('401') && !info('401')?.headers.has('www-authenticate')) out.push('CONTRACT_401_WWW_AUTHENTICATE: ' + where + ' is secured and declares a 401 response without a WWW-Authenticate header (RFC 9110 section 11.6.1)');
  // 20. Bearer challenge parameters are not literal-validated
  if (usesBearerScheme(root, operation) && declared('401')) out.push('CONTRACT_BEARER_CHALLENGE_NOT_VALIDATED: ' + where + ' uses Bearer authentication; the 401 WWW-Authenticate Bearer error and scope parameters (RFC 6750 section 3) are not statically literal-validated');
  // 21. 407 needs Proxy-Authenticate
  if (declared('407') && !info('407')?.headers.has('proxy-authenticate')) out.push('CONTRACT_407_PROXY_AUTHENTICATE: ' + where + ' status 407 omits the Proxy-Authenticate header (RFC 9110 section 11.7.1)');
  // 22. 405 needs Allow
  if (declared('405') && !info('405')?.headers.has('allow')) out.push('CONTRACT_405_ALLOW: ' + where + ' status 405 omits the Allow header (RFC 9110 section 15.5.6)');
  // 23. 426 needs Upgrade
  if (declared('426') && !info('426')?.headers.has('upgrade')) out.push('CONTRACT_426_UPGRADE: ' + where + ' status 426 omits the Upgrade header (RFC 9110 section 15.5.22)');
  // 24. redirects need Location
  for (const code of REDIRECT_STATUSES) {
    if (declared(code) && !info(code)?.headers.has('location')) out.push('CONTRACT_REDIRECT_LOCATION: ' + where + ' status ' + code + ' omits the Location header (RFC 9110 section 15.4)');
  }
  // 25. 202 needs a status-monitor affordance
  if (declared('202')) {
    const r = info('202');
    if (r && !r.headers.has('location') && !r.headers.has('link') && r.content.size === 0) out.push('CONTRACT_202_MONITOR: ' + where + ' status 202 provides no status-monitor affordance (Location/Link header or response body) (RFC 9110 section 15.3.3)');
  }
  // 26/27/28. problem+json members are not statically validated
  for (const [status, r] of byStatus) {
    if ([...r.content].some((c) => c === 'application/problem+json')) {
      out.push('CONTRACT_PROBLEM_JSON_SHAPE_NOT_VALIDATED: ' + where + ' status ' + status + ' returns application/problem+json; the RFC 9457 members (type, title, status, detail, instance) are not statically validated');
      out.push('CONTRACT_PROBLEM_STATUS_NOT_VALIDATED: ' + where + ' status ' + status + ' problem+json status member is not statically checked against HTTP status ' + status);
      out.push('CONTRACT_PROBLEM_EXTENSION_NOT_VALIDATED: ' + where + ' status ' + status + ' problem+json extension member names are not statically validated (RFC 9457 section 3.2)');
    }
    if ([...r.content].some((c) => c === 'application/problem+xml')) out.push('CONTRACT_PROBLEM_XML_NOT_VALIDATED: ' + where + ' status ' + status + ' returns application/problem+xml; its schema and examples are not statically validated (RFC 9457 appendix)');
  }
  // 30/31/32. OpenAPI Link objects are not statically resolved
  for (const [status, r] of byStatus) {
    for (const link of r.links) {
      if (typeof link.operationRef === 'string') out.push('CONTRACT_LINK_OPERATION_REF_NOT_VALIDATED: ' + where + ' status ' + status + ' link uses operationRef ' + String(link.operationRef) + '; its resolution to a single Operation Object is not statically proven');
      const lp = asRecord(link.parameters);
      if (lp && Object.keys(lp).length > 0) {
        out.push('CONTRACT_LINK_PARAMETERS_NOT_VALIDATED: ' + where + ' status ' + status + ' link parameters are not statically matched against the target operation parameters (OpenAPI Link Object)');
        for (const v of Object.values(lp)) { if (typeof v === 'string' && v.indexOf('$request.') >= 0) { out.push('CONTRACT_LINK_REQUEST_EXPRESSION_NOT_VALIDATED: ' + where + ' status ' + status + ' link uses a $request runtime expression whose ABNF and declared request parameter name are not statically validated'); break; } }
      }
    }
  }
  // 33. Link response header grammar not literal-validated
  for (const [status, r] of byStatus) {
    if (r.headers.has('link')) out.push('CONTRACT_LINK_HEADER_NOT_VALIDATED: ' + where + ' status ' + status + ' declares a Link response header; its RFC 8288 field grammar is not statically literal-validated');
  }
  // 34/35. server URLs parse and secured ops avoid cleartext
  const servers = [...asArray(root.servers), ...asArray(pathItem.servers), ...asArray(operation.servers)];
  const seenServer = new Set<string>();
  for (const rawServer of servers) {
    const s = asRecord(rawServer);
    if (!s) continue;
    const rawUrl = typeof s.url === 'string' ? s.url : '';
    if (seenServer.has(rawUrl)) continue;
    seenServer.add(rawUrl);
    const sub = substituteServerUrl(root, s as Rec);
    if (/[{}]/.test(sub)) { out.push('CONTRACT_SERVER_URL_UNBOUND_VARIABLE: ' + where + ' server URL ' + rawUrl + ' retains unresolved template braces after applying variable defaults'); }
    else { try { new URL(sub, sub.startsWith('/') ? 'https://placeholder.invalid' : undefined); } catch { out.push('CONTRACT_SERVER_URL_UNPARSEABLE: ' + where + ' server URL ' + rawUrl + ' does not parse as a URI reference after default substitution'); } }
    if (secured && /^http:\/\//i.test(sub)) out.push('CONTRACT_INSECURE_SERVER_FOR_SECURED_OP: ' + where + ' is secured but its server ' + rawUrl + ' uses cleartext http:// (RFC 9110 section 17)');
  }
  // 36. bearer/OAuth token must not travel in the query string
  for (const q of queryParams) {
    if (q.toLowerCase() === 'access_token') out.push('CONTRACT_OAUTH_TOKEN_IN_QUERY: ' + where + ' declares a query parameter ' + q + ' that carries a bearer/OAuth token in the URI, which RFC 6750 section 5.3 discourages');
  }
  // 37. structured standard headers are not literal-validated
  for (const [status, r] of byStatus) {
    for (const h of STRUCTURED_HEADERS) if (r.headers.has(h)) out.push('CONTRACT_STANDARD_HEADER_GRAMMAR_NOT_VALIDATED: ' + where + ' status ' + status + ' declares the ' + h + ' header, whose RFC field grammar is not statically literal-validated');
  }
  // 38. 451 should link the blocking authority
  if (declared('451') && !info('451')?.headers.has('link')) out.push('CONTRACT_451_BLOCKED_BY_LINK: ' + where + ' status 451 omits a Link header (rel=blocked-by) identifying the blocking authority (RFC 7725 section 3)');

  return out;
}


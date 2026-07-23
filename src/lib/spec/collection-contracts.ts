import { normalizePath, type ContractBodyFieldRules, type ContractHeader, type ContractIndex, type ContractMedia, type ContractOperation } from './contract-index.js';
import { FORBIDDEN_TRAILER_FIELDS, HTTP_CONTENT_CODINGS, PROXY_STATUS_ERROR_TYPES, REFERRER_POLICY_VALUES } from './iana-registries.js';
import { compileSchemaValidator, compileSchemaValidatorCode } from './schema-validator-code.js';
import { createSecretsResolverItem } from './smoke-tests.js';

export { createSecretsResolverItem } from './smoke-tests.js';

type JsonRecord = Record<string, unknown>;

export interface ContractInstrumentationResult {
  collection: JsonRecord;
  warnings: string[];
}

export interface ContractInstrumentationLimits {
  maxCollectionUpdateBytes?: number;
}

export const CONTRACT_SIZE_LIMITS = {
  warnTestScriptBytes: 256_000,
  maxTestScriptBytes: 900_000,
  maxCollectionUpdateBytes: 4_000_000
} as const;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringifyPathSegment(segment: unknown): string {
  if (typeof segment === 'string') return segment;
  const record = asRecord(segment);
  if (!record) return String(segment ?? '');
  for (const key of ['value', 'key', 'name']) {
    if (typeof record[key] === 'string' && record[key]) return String(record[key]);
  }
  return '';
}

function pathFromRaw(raw: string): string {
  let value = String(raw || '').trim();
  value = value.replace(/^\{\{[^}]+\}\}/, '');
  try {
    return normalizePath(new URL(value).pathname);
  } catch {
    value = value.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
    return normalizePath(value || '/');
  }
}

export function requestPath(request: unknown): string {
  const record = asRecord(request);
  const url = record?.url ?? request;
  if (typeof url === 'string') return pathFromRaw(url);
  const urlRecord = asRecord(url);
  if (!urlRecord) return '/';
  if (Array.isArray(urlRecord.path)) return normalizePath(`/${urlRecord.path.map(stringifyPathSegment).filter(Boolean).join('/')}`);
  if (typeof urlRecord.path === 'string') return normalizePath(urlRecord.path);
  if (typeof urlRecord.raw === 'string') return pathFromRaw(urlRecord.raw);
  return '/';
}

function segments(path: string): string[] {
  return normalizePath(path).split('/').filter(Boolean);
}

function isTemplateSegment(segment: string): boolean {
  return /^\{[^}]+\}$/.test(segment) || /^:[^/]+$/.test(segment) || /^\{\{[^}]+\}\}$/.test(segment) || /^<[^>]+>$/.test(segment);
}

function compoundSegmentMatches(candidateSegment: string, requestSegment: string): boolean {
  // A segment like `{name}.{ext}` matches a concrete segment like `report.pdf`:
  // literal chunks must appear in order and each `{param}` consumes >=1 non-slash
  // char (OAS templating marks "a section of a URL path" replaceable, not only a
  // whole segment). Adjacent `{a}{b}` params are treated as non-matching (ambiguous).
  const parts = candidateSegment.split(/(\{[^}]+\})/).filter((part) => part.length > 0);
  let pos = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (/^\{[^}]+\}$/.test(part)) {
      const next = parts[i + 1];
      if (next === undefined) {
        return pos < requestSegment.length && !requestSegment.slice(pos).includes('/');
      }
      if (/^\{[^}]+\}$/.test(next)) return false;
      const idx = requestSegment.indexOf(next, pos + 1);
      if (idx === -1) return false;
      pos = idx;
    } else if (requestSegment.startsWith(part, pos)) {
      pos += part.length;
    } else {
      return false;
    }
  }
  return pos === requestSegment.length;
}

function matchCandidate(candidate: string, request: string): { matched: boolean; staticCount: number; templateCount: number } {
  const candidateSegments = segments(candidate);
  const requestSegments = segments(request);
  if (candidateSegments.length !== requestSegments.length) return { matched: false, staticCount: 0, templateCount: 0 };
  let staticCount = 0;
  let templateCount = 0;
  for (let index = 0; index < candidateSegments.length; index += 1) {
    const candidateSegment = candidateSegments[index] ?? '';
    const requestSegment = requestSegments[index] ?? '';
    if (isTemplateSegment(candidateSegment) || candidateSegment === '{serverVariable}') {
      templateCount += 1;
      continue;
    }
    if (candidateSegment.includes('{') && compoundSegmentMatches(candidateSegment, requestSegment)) {
      templateCount += 1;
      continue;
    }
    if (candidateSegment !== requestSegment) return { matched: false, staticCount: 0, templateCount: 0 };
    staticCount += 1;
  }
  return { matched: true, staticCount, templateCount };
}

export function matchOperation(
  index: ContractIndex,
  request: unknown
): { operation?: ContractOperation; ambiguous?: ContractOperation[]; path: string; method: string } {
  const record = asRecord(request);
  const method = String(record?.method || '').toUpperCase();
  const path = requestPath(request);
  const candidates = index.operations
    .filter((operation) => operation.method === method)
    .flatMap((operation) => operation.candidates.map((candidate) => ({ operation, score: matchCandidate(candidate, path), serverFull: candidate !== normalizePath(operation.path) })))
    .filter((entry) => entry.score.matched)
    // Rank exact literal matches above server-prefixed template matches: a
    // candidate that matches more path segments verbatim is always a stronger
    // signal than one that relies on a {serverVariable} placeholder. The old
    // order (serverFull first) caused /otp/login to match `POST /login` via
    // `/{serverVariable}/login` instead of the exact `/otp/login` candidate
    // of `POST /otp/login`, surfacing as CONTRACT_DUPLICATE_OPERATION_REQUEST
    // whenever a spec had both `/foo` and `/bar/foo` for the same HTTP method.
    .map((entry) => ({ operation: entry.operation, score: [entry.score.staticCount, entry.serverFull ? 2 : 1, -entry.score.templateCount] as const }))
    .sort((a, b) => {
      for (let index = 0; index < a.score.length; index += 1) {
        const delta = b.score[index] - a.score[index];
        if (delta !== 0) return delta;
      }
      return a.operation.id.localeCompare(b.operation.id);
    });
  const best = candidates[0];
  if (!best) return { path, method };
  const tied = candidates.filter((entry) => entry.score.every((value, index) => value === best.score[index]));
  const uniqueTied = [...new Map(tied.map((entry) => [entry.operation.id, entry.operation])).values()];
  if (uniqueTied.length > 1) return { path, method, ambiguous: uniqueTied };
  return { path, method, operation: best.operation };
}

function assignValidator(lines: string[], target: string, source: string): void {
  lines.push(`${target} = ${source};`);
}

// schemasafe refuses some structurally legal schemas even with tolerance
// flags ("Unexpected rules in type", "some checks are never reachable", "No
// valid types possible" - all observed in GitHub/DigitalOcean/Spotify public
// specs). A compile failure degrades that one validator to a runtime skip
// with an instrumentation warning instead of killing the whole bootstrap.
function tryCompile(target: string, schema: unknown, lines: string[], warnings: string[], context: string, skipped: string[]): void {
  try {
    assignValidator(lines, target, compileSchemaValidatorCode(schema));
  } catch (error) {
    lines.push(`${target} = { skip: true };`);
    warnings.push(`CONTRACT_SCHEMA_NOT_COMPILED: ${context} could not be compiled into a runtime validator (${error instanceof Error ? error.message.slice(0, 160) : String(error)})`);
    skipped.push(context);
  }
}

function buildValidatorAssignments(operation: ContractOperation, warnings: string[], skipped: string[]): string[] {
  const lines = ['var validators = {};', 'var linkTargetValidators = {};'];
  const parameterChecks = operation.parameterChecks ?? [];
  if (parameterChecks.length > 0) {
    lines.push('var paramValidators = {};');
    for (const check of parameterChecks) {
      tryCompile(`paramValidators[${JSON.stringify(`${check.in}:${check.name.toLowerCase()}`)}]`, check.schema, lines, warnings, `parameter ${check.in}:${check.name} schema on ${operation.id}`, skipped);
    }
  }
  const bodySchemas = Object.entries(operation.requestBody?.jsonSchemas ?? {});
  if (bodySchemas.length > 0) {
    lines.push('var requestBodyValidators = {};');
    for (const [base, schema] of bodySchemas) {
      tryCompile(`requestBodyValidators[${JSON.stringify(base)}]`, schema, lines, warnings, `request body schema for ${base} on ${operation.id}`, skipped);
    }
  }
  for (const [status, response] of Object.entries(operation.responses)) {
    lines.push(`validators[${JSON.stringify(status)}] = validators[${JSON.stringify(status)}] || {};`);
    for (const [mediaType, media] of Object.entries(response.content)) {
      if (media.schema !== undefined && !media.unsupported) {
        tryCompile(`validators[${JSON.stringify(status)}][${JSON.stringify(mediaType)}]`, media.schema, lines, warnings, `response schema for ${mediaType} on ${operation.id} status ${status}`, skipped);
      }
    }
    for (const header of response.headers) {
      if (header.schema !== undefined && !header.unsupported) {
        lines.push(`validators[${JSON.stringify(status)}].__headers = validators[${JSON.stringify(status)}].__headers || {};`);
        tryCompile(`validators[${JSON.stringify(status)}].__headers[${JSON.stringify(header.name.toLowerCase())}]`, header.schema, lines, warnings, `response header ${header.name} schema on ${operation.id} status ${status}`, skipped);
      }
    }
  }
  const linkTargetSchemas = Object.entries(operation.linkTargetSchemas ?? {});
  for (const [key, schema] of linkTargetSchemas) {
    tryCompile(`linkTargetValidators[${JSON.stringify(key)}]`, schema, lines, warnings, `link target schema ${key} on ${operation.id}`, skipped);
  }
  return lines;
}

export function createContractScript(operation: ContractOperation, warnings: string[] = []): string[] {
  const multipartRule = operation.requestBody?.fieldRules?.['multipart/form-data'];
  const multipartFields = multipartRule
    ? {
        required: multipartRule.required,
        declared: [...new Set([...multipartRule.required, ...Object.keys(multipartRule.fieldSchemas ?? {}), ...Object.keys(multipartRule.encodings ?? {})])]
      }
    : undefined;
  const contract = {
    method: operation.method,
    path: operation.path,
    responses: operation.responses,
    security: operation.security,
    parameters: operation.parameterChecks,
    pathMethods: operation.pathMethods,
    deprecated: operation.deprecated,
    servers: operation.servers,
    callbacks: operation.callbacks,
    callbackRequestSources: operation.callbackRequestSources,
    linkTargetSchemas: operation.linkTargetSchemas,
    multipartFields
  };
  const skipped: string[] = [];
  const validatorLines = buildValidatorAssignments(operation, warnings, skipped);
  const registries = { proxyStatusErrors: PROXY_STATUS_ERROR_TYPES, referrerPolicies: REFERRER_POLICY_VALUES, forbiddenTrailers: FORBIDDEN_TRAILER_FIELDS, contentCodings: HTTP_CONTENT_CODINGS };
  return [
    `var contract = JSON.parse(${JSON.stringify(JSON.stringify(contract))});`,
    `var rfcRegistries = JSON.parse(${JSON.stringify(JSON.stringify(registries))});`,
    ...validatorLines,
    'function selectedResponseContract() {',
    '  var status = String(pm.response.code);',
    '  if (contract.responses[status]) return { key: status, value: contract.responses[status] };',
    "  var range = String(Math.floor(pm.response.code / 100)) + 'XX';",
    '  if (contract.responses[range]) return { key: range, value: contract.responses[range] };',
    "  if (contract.responses.default) return { key: 'default', value: contract.responses.default };",
    '  return null;',
    '}',
    'function responseText() { return pm.response.text() || ""; }',
    'function isBodyless() { return pm.response.code < 200 || pm.response.code === 204 || pm.response.code === 205 || pm.response.code === 304 || contract.method === "HEAD"; }',
    'function selectedBodyExpectation() {',
    '  if (isBodyless()) return "forbidden";',
    '  if (!selected) return "unknown";',
    '  return selected.value.bodyExpectation || "unknown";',
    '}',
    'function mediaBase(value) { return String(value || "").toLowerCase().split(";")[0].trim(); }',
    'function mediaParts(value) { var base = mediaBase(value); var parts = base.split("/"); return { raw: base, type: parts[0] || "", subtype: parts[1] || "" }; }',
    'function isJsonSubtype(subtype) { return subtype === "json" || /\\+json$/.test(subtype); }',
    'function coerceBySchema(value, schema) {',
    '  var type = schema && schema.type;',
    '  var types = Array.isArray(type) ? type : [type];',
    '  if ((types.indexOf("integer") !== -1 || types.indexOf("number") !== -1) && /^-?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$/.test(String(value).trim())) return Number(value);',
    '  if (types.indexOf("boolean") !== -1 && (value === "true" || value === "false")) return value === "true";',
    '  return value;',
    '}',
    'function decodeComponent(value) { try { return decodeURIComponent(value); } catch (ignored) { return value; } }',
    'function isPlaceholderValue(value) { var text = String(value).trim(); return /^<[^<>]*>$/.test(text) || text.indexOf("{{") !== -1; }',
    'function requestHeader(name) { var value = ""; pm.request.headers.each(function (header) { if (header && header.disabled !== true && String(header.key).toLowerCase() === String(name).toLowerCase()) value = String(header.value); }); return value; }',
    'function visibleRequestHeader(name) { var value = requestHeader(name); if (!value) return ""; value = String(value); return value.indexOf("{{") === -1 && value.trim() ? value : ""; }',
    'function hasQueryParam(name) { var found = false; pm.request.url.query.each(function (param) { if (param && param.disabled !== true && String(param.key).toLowerCase() === String(name).toLowerCase()) found = true; }); return found; }',
    'function requestQueryValues(name) { var values = []; pm.request.url.query.each(function (param) { if (param && param.disabled !== true && String(param.key).toLowerCase() === String(name).toLowerCase()) values.push(param.value === null || param.value === undefined ? "" : String(param.value)); }); return values; }',
    'function requestQueryValue(name) { var values = requestQueryValues(name); return values.length > 0 ? values[values.length - 1] : undefined; }',
    'function requestPathSegments() { var raw = ""; try { raw = typeof pm.request.url.getPath === "function" ? String(pm.request.url.getPath() || "") : ""; } catch (ignored) {} if (!raw) { var path = pm.request.url.path; raw = Array.isArray(path) ? "/" + path.join("/") : String(path || ""); } return raw.split("?")[0].split("#")[0].split("/").filter(function (segment) { return segment.length > 0; }); }',
    'function pathRawSegment(name) { var template = String(contract.path).split("/").filter(function (segment) { return segment.length > 0; }); var actual = requestPathSegments(); var offset = actual.length - template.length; if (offset < 0) return undefined; var token = "{" + name + "}"; for (var i = 0; i < template.length; i += 1) { if (template[i] === token) return actual[offset + i]; } return undefined; }',
    'function requestPathParamValue(name) { var template = String(contract.path).split("/").filter(function (segment) { return segment.length > 0; }); var actual = requestPathSegments(); var offset = actual.length - template.length; if (offset < 0) return undefined; var token = "{" + name + "}"; for (var i = 0; i < template.length; i += 1) { var seg = template[i]; var actualSeg = actual[offset + i]; if (actualSeg === undefined) continue; if (seg === token) return decodeComponent(actualSeg); if (seg.indexOf(token) === -1) continue; var chunks = [], j = 0, bad = false; while (j < seg.length) { if (seg.charAt(j) === "{") { var close = seg.indexOf("}", j); if (close === -1) { bad = true; break; } chunks.push({ p: seg.slice(j + 1, close) }); j = close + 1; } else { var nb = seg.indexOf("{", j); var lit = nb === -1 ? seg.slice(j) : seg.slice(j, nb); chunks.push({ l: lit }); j = nb === -1 ? seg.length : nb; } } if (bad) return undefined; var pos = 0, found, ok = true; for (var c = 0; c < chunks.length; c += 1) { var ch = chunks[c]; if (ch.l !== undefined) { if (actualSeg.indexOf(ch.l, pos) === pos) pos += ch.l.length; else { ok = false; break; } } else { var nextLit = (chunks[c + 1] && chunks[c + 1].l !== undefined) ? chunks[c + 1].l : undefined; var isLast = c === chunks.length - 1; var end; if (isLast) { end = actualSeg.length; } else if (nextLit === undefined) { ok = false; break; } else { var idx = actualSeg.indexOf(nextLit, pos + 1); if (idx === -1) { ok = false; break; } end = idx; } if (end <= pos) { ok = false; break; } if (ch.p === name) found = actualSeg.slice(pos, end); pos = end; } } if (ok && pos === actualSeg.length && found !== undefined) return decodeComponent(found); } return undefined; }',
    'function mediaScore(expected, actual) {',
    '  var e = mediaParts(expected); var a = mediaParts(actual);',
    '  if (!e.raw || !a.raw) return 0;',
    '  if (e.raw === a.raw) return 4;',
    '  if (e.type === a.type && e.subtype === "json" && isJsonSubtype(a.subtype)) return 3;',
    '  if (e.type === a.type && e.subtype === "*+json" && /\\+json$/.test(a.subtype)) return 3;',
    '  if (e.type === a.type && e.subtype === "*") return 2;',
    '  if (e.type === "*" && e.subtype === "*") return 1;',
    '  return 0;',
    '}',
    'function selectMedia(responseContract) {',
    '  var actual = pm.response.headers.get("Content-Type") || "";',
    '  var content = responseContract.content || {};',
    '  var matches = Object.keys(content).map(function (expected) { return { expected: expected, score: mediaScore(expected, actual), media: content[expected] }; }).filter(function (entry) { return entry.score > 0; }).sort(function (a, b) { return b.score - a.score; });',
    '  if (matches.length === 0) return { error: "Content-Type " + actual + " does not match OpenAPI content for " + contract.method + " " + contract.path + " status " + pm.response.code + "; expected " + Object.keys(content).join(", ") };',
    '  if (matches.length > 1 && matches[0].score === matches[1].score) return { error: "Content-Type " + actual + " ambiguously matches OpenAPI content for " + contract.method + " " + contract.path + " status " + pm.response.code + "; expected " + Object.keys(content).join(", ") };',
    '  return matches[0];',
    '}',
    'var selected = selectedResponseContract();',
    'var bodyExpectation = selectedBodyExpectation();',
    ...(skipped.length > 0 ? [
      // A schema schemasafe could not compile is NOT silently ignored: it is
      // surfaced here (and as a CONTRACT_SCHEMA_NOT_COMPILED warning at generation
      // time). This test passes - the RESPONSE is legitimate; only the local
      // validator could not be built - but it documents the un-validated schemas
      // in the run report so the skip is never invisible.
      `var contractSkippedValidators = JSON.parse(${JSON.stringify(JSON.stringify(skipped))});`,
      "pm.test('OpenAPI schemas without a compilable runtime validator are documented', function () {",
      '  pm.expect(contractSkippedValidators, "these OpenAPI schemas were not runtime-validated (schemasafe could not compile): " + contractSkippedValidators.join("; ")).to.be.an("array");',
      '});'
    ] : []),
    "pm.test('OpenAPI operation mapping exists', function () { pm.expect(contract.path).to.be.a('string').and.not.empty; });",
    "pm.test('Status code is defined by OpenAPI', function () { pm.expect(selected, 'No OpenAPI response defined for ' + contract.method + ' ' + contract.path + ' status ' + pm.response.code).to.exist; });",
    "pm.test('Response headers match OpenAPI', function () {",
    '  if (!selected) return;',
    '  var headers = selected.value.headers || [];',
    '  headers.forEach(function (header) {',
    '    var actual = pm.response.headers.get(header.name);',
    '    if (!actual && header.required) pm.expect.fail("OpenAPI response header missing for " + contract.method + " " + contract.path + ": " + header.name);',
    '    if (!actual) return;',
    '    if (header.unsupported) pm.expect.fail("OpenAPI response header unsupported for " + contract.method + " " + contract.path + ": " + header.unsupported);',
    '    var headerValidator = validators[selected.key] && validators[selected.key].__headers && validators[selected.key].__headers[String(header.name).toLowerCase()];',
    '    if (!headerValidator || headerValidator.skip) return;',
    '    var expected;',
    '    if (header.items) { var joined = String(actual).trim(); expected = joined === "" ? [] : joined.split(",").map(function (entry) { return coerceBySchema(entry.trim(), header.items); }); }',
    '    else expected = coerceBySchema(actual, header.schema);',
    '    if (!headerValidator(expected)) pm.expect.fail("OpenAPI response header validation failed for " + header.name + ": " + JSON.stringify(headerValidator.errors || []));',
    '  });',
    '});',
    "pm.test('Response body matches OpenAPI body contract', function () {",
    '  if (!selected) return;',
    '  if (bodyExpectation === "forbidden") { pm.expect(responseText().length, "HTTP semantics forbid a response body for " + contract.method + " " + contract.path + " status " + pm.response.code).to.equal(0); return; }',
    '  if (bodyExpectation === "declared") { pm.expect(responseText().length, "OpenAPI response declares content but response body was empty").to.be.above(0); }',
    '});',
    "pm.test('Content-Type matches OpenAPI response content', function () {",
    '  if (!selected || isBodyless()) return;',
    '  var content = selected.value.content || {};',
    '  if (Object.keys(content).length === 0) return;',
    '  var actual = pm.response.headers.get("Content-Type");',
    '  if (!actual) pm.expect.fail("Content-Type <missing> does not match OpenAPI content for " + contract.method + " " + contract.path + " status " + pm.response.code + "; expected " + Object.keys(content).join(", "));',
    '  var media = selectMedia(selected.value);',
    '  if (media.error) pm.expect.fail(media.error);',
    '});',
    "pm.test('Response body matches OpenAPI schema', function () {",
    '  if (!selected || isBodyless()) return;',
    '  var content = selected.value.content || {};',
    '  if (Object.keys(content).length === 0) return;',
    '  var media = selectMedia(selected.value);',
    '  if (media.error) return;',
    '  if (media.media.unsupported) pm.expect.fail("OpenAPI schema unsupported for " + contract.method + " " + contract.path + " status " + pm.response.code + ": " + media.media.unsupported);',
    '  if (!media.media.schema) { return; }',
    '  var validate = validators[selected.key] && validators[selected.key][media.expected];',
    '  if (validate && validate.skip) return;',
    '  if (!validate) pm.expect.fail("OpenAPI schema validator was not generated for " + media.expected);',
    '  var actual = mediaParts(pm.response.headers.get("Content-Type") || "");',
    '  var value = isJsonSubtype(actual.subtype) ? pm.response.json() : responseText();',
    // Non-JSON object-schema bodies skip schema validation instead of
    // failing; the index emits CONTRACT_NONJSON_SCHEMA_NOT_VALIDATED so the
    // skip is visible at instrumentation time.
    '  if (!isJsonSubtype(actual.subtype) && media.media.schema && media.media.schema.type !== "string") { return; }',
    '  if (!validate(value)) pm.expect.fail("OpenAPI schema validation failed for " + contract.method + " " + contract.path + " status " + pm.response.code + ": " + JSON.stringify(validate.errors || []));',
    '});',
    "pm.test('Response satisfies RFC 9110 status-code requirements', function () {",
    '  var code = pm.response.code;',
    '  function respHeader(name) { return pm.response.headers.get(name) || ""; }',
    '  var visibleIfMatch = visibleRequestHeader("If-Match");',
    '  var visibleIfNoneMatch = visibleRequestHeader("If-None-Match");',
    '  var visibleIfModifiedSince = visibleRequestHeader("If-Modified-Since");',
    '  var visibleIfUnmodifiedSince = visibleRequestHeader("If-Unmodified-Since");',
    '  if (code === 401) {',
    '    var challenge = respHeader("WWW-Authenticate");',
    '    if (!challenge) pm.expect.fail("RFC 9110 requires WWW-Authenticate on 401 responses");',
    '    var expectedSchemes = [];',
    '    (contract.security || []).forEach(function (alternative) { alternative.forEach(function (check) { if (check.prefix) { var scheme = String(check.prefix).trim().split(/\\s+/)[0]; if (scheme && expectedSchemes.indexOf(scheme) === -1) expectedSchemes.push(scheme); } }); });',
    '    expectedSchemes.forEach(function (scheme) { if (challenge && !new RegExp("(^|,)\\\\s*" + scheme + "\\\\b", "i").test(challenge)) pm.expect.fail("RFC 9110 15.5.2 and OAS 4.8.27 require a WWW-Authenticate " + scheme + " challenge for the declared security scheme; got: " + challenge); });',
    '    if (challenge && /\\bbasic\\b/i.test(challenge) && !/realm\\s*=/i.test(challenge)) pm.expect.fail("RFC 7617 requires a realm parameter on Basic challenges: " + challenge);',
    '    if (challenge && /\\bdigest\\b/i.test(challenge) && (!/realm\\s*=/i.test(challenge) || !/nonce\\s*=/i.test(challenge))) pm.expect.fail("RFC 7616 requires realm and nonce on Digest challenges: " + challenge);',
    '  }',
    '  if (code === 401 || code === 403) {',
    '    var authChallenge = respHeader("WWW-Authenticate");',
    '    var bearerError = authChallenge && /\\bbearer\\b/i.test(authChallenge) ? authChallenge.match(/\\berror\\s*=\\s*"?([A-Za-z0-9_]+)"?/i) : null;',
    '    if (bearerError && ["invalid_request", "invalid_token", "insufficient_scope"].indexOf(bearerError[1]) === -1) pm.expect.fail("RFC 6750 Bearer error code must be invalid_request, invalid_token, or insufficient_scope; got " + bearerError[1]);',
    '  }',
    '  if (code === 405) {',
    '    var allow = respHeader("Allow");',
    '    if (!allow) pm.expect.fail("RFC 9110 requires Allow on 405 responses");',
    '    var allowed = allow.split(",").map(function (entry) { return entry.trim().toUpperCase(); });',
    '    (contract.pathMethods || []).forEach(function (method) { if (allowed.indexOf(method) === -1) pm.expect.fail("Allow on 405 must list every method the OpenAPI path declares (RFC 9110); missing " + method + " in: " + allow); });',
    '  }',
    '  if (code === 304 && responseText().trim().length > 0) pm.expect.fail("RFC 9110 forbids content in a 304 response");',
    '  if (code === 304) {',
    '    if (contract.method !== "GET" && contract.method !== "HEAD") pm.expect.fail("RFC 9110 permits 304 only on conditional GET or HEAD requests");',
    '    if (!visibleIfNoneMatch && !visibleIfModifiedSince) pm.expect.fail("RFC 9110 permits 304 only when a visible If-None-Match or If-Modified-Since precondition is present");',
    '  }',
    '  if (code === 412 && !visibleIfMatch && !visibleIfNoneMatch && !visibleIfUnmodifiedSince) pm.expect.fail("RFC 9110 permits 412 only when a visible If-Match, If-None-Match, or If-Unmodified-Since precondition is present");',
    '  if (visibleIfNoneMatch && !visibleIfMatch && !visibleIfUnmodifiedSince) {',
    '    if ((contract.method === "GET" || contract.method === "HEAD") && code === 412) pm.expect.fail("RFC 9110 13.1.2 uses 304 rather than 412 when a GET or HEAD If-None-Match precondition fails");',
    '    if (contract.method !== "GET" && contract.method !== "HEAD" && code === 304) pm.expect.fail("RFC 9110 13.1.2 uses 412 rather than 304 when a non-GET/HEAD If-None-Match precondition fails");',
    '  }',
    // RFC 9110 15.4.5: a 304 MUST carry these fields when they would have
    // been sent on the 200; enforce for fields the spec declares on the 200.
    '  if (code === 304 && contract.responses["200"] && contract.responses["304"]) {',
    '    var okDeclared = (contract.responses["200"] && contract.responses["200"].headers) || [];',
    '    ["Cache-Control", "Content-Location", "Date", "ETag", "Expires", "Vary"].forEach(function (name) {',
    '      var declared = okDeclared.some(function (header) { return String(header.name).toLowerCase() === name.toLowerCase(); });',
    '      if (declared && !respHeader(name)) pm.expect.fail("RFC 9110 15.4.5: a 304 must include " + name + " because the OpenAPI 200 response declares it");',
    '    });',
    '  }',
    '  var retryAfter = respHeader("Retry-After");',
    '  if (retryAfter && (code === 429 || code === 503 || (code >= 300 && code < 400))) {',
    '    if (!/^\\d+$/.test(retryAfter.trim()) && isNaN(Date.parse(retryAfter))) pm.expect.fail("Retry-After must be delay-seconds or an HTTP-date (RFC 9110 10.2.3): " + retryAfter);',
    '    var retryDate = Date.parse(retryAfter); var responseDate = Date.parse(respHeader("Date"));',
    '    if (!isNaN(retryDate) && !isNaN(responseDate) && retryDate < responseDate) pm.expect.fail("Retry-After HTTP-date must not be earlier than Date (RFC 9110 10.2.3 and 6.6.1): " + retryAfter + " < " + respHeader("Date"));',
    '  }',
    '  var location = respHeader("Location");',
    '  if (location && (code === 201 || (code >= 300 && code < 400))) {',
    '    if (/\\s/.test(location.trim()) || location.trim().length === 0) pm.expect.fail("Location must be a valid URI-reference (RFC 9110 / RFC 3986): " + location);',
    '  }',
    '});',
    "pm.test('Error and encoding conventions match RFC 9457 / RFC 8259 / RFC 8288', function () {",
    '  var contentTypeRaw = pm.response.headers.get("Content-Type") || "";',
    '  var ct = mediaParts(contentTypeRaw);',
    '  if (ct.type === "application" && ct.subtype === "problem+json") {',
    '    var problem;',
    '    try { problem = pm.response.json(); } catch (error) { pm.expect.fail("application/problem+json body is not valid JSON (RFC 9457): " + error); }',
    '    if (!problem || typeof problem !== "object" || Array.isArray(problem)) pm.expect.fail("problem details must be a JSON object (RFC 9457)");',
    '    ["type", "title", "detail", "instance"].forEach(function (member) { if (problem[member] !== undefined && typeof problem[member] !== "string") pm.expect.fail("RFC 9457 " + member + " member must be a string; got " + typeof problem[member]); });',
    '    ["type", "instance"].forEach(function (member) {',
    '      if (typeof problem[member] !== "string") return;',
    '      var uriRef = problem[member];',
    '      if (/[\\s\\x00-\\x1f\\x7f]/.test(uriRef)) pm.expect.fail("RFC 9457 3.1.1/3.1.5 " + member + " member must be a URI-reference without whitespace/control characters (RFC 3986): " + uriRef);',
    '      if (!/^(?:[A-Za-z][A-Za-z0-9+.-]*:[^\\s<>"]*|\\/[^\\s<>"]*|\\.\\.?\\/[^\\s<>"]*|#[^\\s<>"]*|[^\\s<>"]*)$/.test(uriRef)) pm.expect.fail("RFC 9457 3.1.1/3.1.5 " + member + " member must be a parseable URI-reference (RFC 3986): " + uriRef);',
    '    });',
    '    if (problem.status !== undefined) {',
    '      if (typeof problem.status !== "number") pm.expect.fail("RFC 9457 status member must be a number; got " + typeof problem.status);',
    '      else if (problem.status !== pm.response.code) pm.expect.fail("RFC 9457 status member (" + problem.status + ") must match the HTTP status code (" + pm.response.code + ")");',
    '    }',
    '  }',
    '  if (isJsonSubtype(ct.subtype)) {',
    '    var charsetMatch = contentTypeRaw.match(/charset\\s*=\\s*"?([^";\\s]+)"?/i);',
    '    if (charsetMatch && charsetMatch[1].toLowerCase() !== "utf-8") pm.expect.fail("JSON interchange must be UTF-8 (RFC 8259); got charset=" + charsetMatch[1]);',
    '  }',
    '  var link = pm.response.headers.get("Link");',
    '  if (link) {',
    '    link.split(/,(?=\\s*<)/).forEach(function (value) {',
    '      if (!/^\\s*<[^>]*>/.test(value)) pm.expect.fail("RFC 8288 link-value must start with a <URI-Reference>: " + value);',
    '      if (!/;\\s*rel\\s*=/i.test(value)) pm.expect.fail("RFC 8288 link-value must carry a rel parameter: " + value);',
    '    });',
    '  }',
    '});',
    'var rfcAdvisories = [];',
    'function rfcAdvise(message) { if (rfcAdvisories.indexOf(message) === -1) rfcAdvisories.push(message); }',
    'function rfcRespHeader(name) { return pm.response.headers.get(name) || ""; }',
    'function rfcHeaderAll(name) { var out = []; pm.response.headers.each(function (header) { if (header && String(header.key).toLowerCase() === String(name).toLowerCase()) out.push(String(header.value)); }); return out; }',
    'function rfcIsHttpDate(value) { return /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-3][0-9] (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-2][0-9]:[0-5][0-9]:[0-5][0-9] GMT$/.test(String(value).trim()) && !isNaN(Date.parse(value)); }',
    'function rfcIsToken(value) { return /^[!#$%&\'*+.^_`|~0-9A-Za-z-]+$/.test(String(value)); }',
    'function rfcResponseDeclaresHeader(name) { if (!selected) return false; return ((selected.value && selected.value.headers) || []).some(function (header) { return String(header.name).toLowerCase() === String(name).toLowerCase(); }); }',
    'function rfcIsEntityTag(value) { return /^(W\\/)?"[\\x21\\x23-\\x7e\\x80-\\xff]*"$/.test(String(value).trim()); }',
    'function rfcIsFieldContent(value) { return /^[\\t \\x21-\\x7e\\x80-\\xff]*$/.test(String(value)); }',
    'function rfcTokenList(value) { var parts = String(value).split(","); for (var i = 0; i < parts.length; i += 1) { if (!rfcIsToken(parts[i].trim())) return false; } return true; }',
    'function rfcSplitList(value) { var out = []; var current = ""; var inQuote = false; for (var i = 0; i < value.length; i += 1) { var ch = value.charAt(i); if (ch === "\\\\" && inQuote) { current += ch + (value.charAt(i + 1) || ""); i += 1; continue; } if (ch === \'"\') inQuote = !inQuote; if (ch === "," && !inQuote) { out.push(current); current = ""; continue; } current += ch; } out.push(current); return out; }',
    'function rfcBase64Decode(value) { var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; var clean = String(value).replace(/=+$/, ""); if (clean.length === 0 || /[^A-Za-z0-9+\\/]/.test(clean)) return null; var bits = 0, buffer = 0, out = ""; for (var i = 0; i < clean.length; i += 1) { buffer = (buffer << 6) | alphabet.indexOf(clean.charAt(i)); bits += 6; if (bits >= 8) { bits -= 8; out += String.fromCharCode((buffer >> bits) & 255); } } return out; }',
    // RFC 9651 structured-field parser (superset of RFC 8941: adds Date and
    // Display String bare items plus the 9651 numeric digit limits). Returns
    // null on a parse failure, otherwise a truthy AST: { item } / { list } /
    // { dict, keys }. Members are { v: { t, v }, p: { key: { t, v } } } and
    // inner lists are { t: "innerlist", v: [members], p: params }.
    'function rfcSfParse(input, kind) {',
    '  var s = String(input), i = 0;',
    '  function ws() { while (i < s.length && (s.charAt(i) === " " || s.charAt(i) === "\\t")) i += 1; }',
    '  function key() { if (!/[a-z*]/.test(s.charAt(i))) return null; var start = i; i += 1; while (i < s.length && /[a-z0-9_.*-]/.test(s.charAt(i))) i += 1; return s.slice(start, i); }',
    '  function bareItem() {',
    '    var ch = s.charAt(i);',
    '    if (ch === \'"\') { i += 1; var str = ""; while (i < s.length) { var c = s.charAt(i); if (c === "\\\\") { var esc = s.charAt(i + 1); if (esc !== \'"\' && esc !== "\\\\") return null; str += esc; i += 2; continue; } if (c === \'"\') { i += 1; return { t: "str", v: str }; } if (c < " " || c > "~") return null; str += c; i += 1; } return null; }',
    '    if (ch === "%" && s.charAt(i + 1) === \'"\') { i += 2; var disp = ""; while (i < s.length) { var dc = s.charAt(i); if (dc === \'"\') { i += 1; return { t: "dispstr", v: disp }; } if (dc === "\\\\" || dc < " " || dc > "~") return null; if (dc === "%") { if (!/^[0-9a-f]{2}$/.test(s.slice(i + 1, i + 3))) return null; disp += s.slice(i, i + 3); i += 3; continue; } disp += dc; i += 1; } return null; }',
    '    if (ch === ":") { i += 1; var bstart = i; while (i < s.length && s.charAt(i) !== ":") i += 1; if (s.charAt(i) !== ":") return null; var body = s.slice(bstart, i); i += 1; return /^[A-Za-z0-9+\\/=]*$/.test(body) ? { t: "bytes", v: body } : null; }',
    '    if (ch === "?") { i += 1; var flag = s.charAt(i); if (flag !== "0" && flag !== "1") return null; i += 1; return { t: "bool", v: flag === "1" }; }',
    '    if (ch === "@") { i += 1; var dneg = s.charAt(i) === "-"; if (dneg) i += 1; var dstart = i; if (!/[0-9]/.test(s.charAt(i))) return null; while (i < s.length && /[0-9]/.test(s.charAt(i))) i += 1; if (i - dstart > 15) return null; return { t: "date", v: (dneg ? -1 : 1) * Number(s.slice(dstart, i)) }; }',
    '    if (/[-0-9]/.test(ch)) { var nstart = i; if (ch === "-") i += 1; var istart = i; if (!/[0-9]/.test(s.charAt(i))) return null; while (i < s.length && /[0-9]/.test(s.charAt(i))) i += 1; var intDigits = i - istart; if (s.charAt(i) === ".") { if (intDigits > 12) return null; i += 1; var fstart = i; if (!/[0-9]/.test(s.charAt(i))) return null; while (i < s.length && /[0-9]/.test(s.charAt(i))) i += 1; if (i - fstart > 3) return null; return { t: "dec", v: Number(s.slice(nstart, i)) }; } if (intDigits > 15) return null; return { t: "int", v: Number(s.slice(nstart, i)) }; }',
    '    if (/[A-Za-z*]/.test(ch)) { var tstart = i; i += 1; while (i < s.length && /[!#$%&\'*+.^_`|~:\\/0-9A-Za-z-]/.test(s.charAt(i))) i += 1; return { t: "tok", v: s.slice(tstart, i) }; }',
    '    return null;',
    '  }',
    '  function params() { var out = {}; while (s.charAt(i) === ";") { i += 1; ws(); var pk = key(); if (pk === null) return null; if (s.charAt(i) === "=") { i += 1; var pv = bareItem(); if (pv === null) return null; out[pk] = pv; } else out[pk] = { t: "bool", v: true }; } return out; }',
    '  function item() {',
    '    if (s.charAt(i) === "(") { i += 1; ws(); var inner = []; while (s.charAt(i) !== ")") { if (i >= s.length) return null; var entry = bareItem(); if (entry === null) return null; var entryParams = params(); if (entryParams === null) return null; inner.push({ v: entry, p: entryParams }); if (s.charAt(i) !== ")" && s.charAt(i) !== " ") return null; ws(); } i += 1; var listParams = params(); if (listParams === null) return null; return { t: "innerlist", v: inner, p: listParams }; }',
    '    var bare = bareItem(); if (bare === null) return null; var itemParams = params(); if (itemParams === null) return null; return { v: bare, p: itemParams };',
    '  }',
    '  ws();',
    '  if (kind === "item") { var single = item(); if (single === null) return null; ws(); return i === s.length ? { item: single } : null; }',
    '  if (kind === "dict") {',
    '    var dict = {}; var keys = [];',
    '    if (i === s.length) return { dict: dict, keys: keys };',
    '    while (i < s.length) {',
    '      var dk = key(); if (dk === null) return null;',
    '      var member;',
    '      if (s.charAt(i) === "=") { i += 1; member = item(); if (member === null) return null; }',
    '      else { var bareParams = params(); if (bareParams === null) return null; member = { v: { t: "bool", v: true }, p: bareParams }; }',
    '      if (dict[dk] === undefined) keys.push(dk);',
    '      dict[dk] = member;',
    '      ws();',
    '      if (i === s.length) return { dict: dict, keys: keys };',
    '      if (s.charAt(i) !== ",") return null;',
    '      i += 1; ws();',
    '      if (i === s.length) return null;',
    '    }',
    '    return { dict: dict, keys: keys };',
    '  }',
    '  var list = [];',
    '  if (i === s.length) return { list: list };',
    '  while (i < s.length) {',
    '    var listMember = item(); if (listMember === null) return null;',
    '    list.push(listMember);',
    '    ws();',
    '    if (i === s.length) return { list: list };',
    '    if (s.charAt(i) !== ",") return null;',
    '    i += 1; ws();',
    '    if (i === s.length) return null;',
    '  }',
    '  return { list: list };',
    '}',
    'pm.test(\'Response header fields satisfy RFC 9110 field syntax\', function () {',
    '  pm.response.headers.each(function (header) {',
    '    if (!header) return;',
    '    if (!rfcIsToken(String(header.key))) pm.expect.fail("Response header name is not a valid RFC 9110 token: " + header.key);',
    '    if (!rfcIsFieldContent(String(header.value))) pm.expect.fail("Response header value contains characters forbidden by RFC 9110 field-content: " + header.key);',
    '  });',
    '  ["content-type", "content-length", "etag", "location", "date", "age", "expires", "last-modified", "retry-after"].forEach(function (name) {',
    '    var values = rfcHeaderAll(name);',
    '    for (var i = 1; i < values.length; i += 1) { if (values[i] !== values[0]) pm.expect.fail("Singleton response header " + name + " appears " + values.length + " times with differing values (RFC 9110)"); }',
    '  });',
    '});',
    'pm.test(\'Response header values satisfy their RFC grammars\', function () {',
    '  var date = rfcRespHeader("Date");',
    '  if (date && !rfcIsHttpDate(date)) pm.expect.fail("Date must be an IMF-fixdate (RFC 9110): " + date);',
    '  if (!date) rfcAdvise("RFC 9110: origin servers SHOULD send a Date header");',
    '  var etag = rfcRespHeader("ETag");',
    '  if (etag && !rfcIsEntityTag(etag)) pm.expect.fail("ETag is not a valid entity-tag (RFC 9110): " + etag);',
    '  var lastModified = rfcRespHeader("Last-Modified");',
    '  if (lastModified) {',
    '    if (!rfcIsHttpDate(lastModified)) pm.expect.fail("Last-Modified must be a valid HTTP-date (RFC 9110): " + lastModified);',
    '    else if (date && rfcIsHttpDate(date) && Date.parse(lastModified) > Date.parse(date)) pm.expect.fail("Last-Modified must not be later than Date (RFC 9110): " + lastModified + " > " + date);',
    '  }',
    '  var vary = rfcRespHeader("Vary");',
    '  if (vary) {',
    '    var varyMembers = vary.split(",").map(function (entry) { return entry.trim(); });',
    '    if (varyMembers.indexOf("*") !== -1 && varyMembers.length > 1) pm.expect.fail("Vary: * must not be combined with other members (RFC 9110): " + vary);',
    '    varyMembers.forEach(function (member) { if (member !== "*" && !rfcIsToken(member)) pm.expect.fail("Vary member is not a field-name token (RFC 9110): " + member); });',
    '    if (varyMembers.indexOf("*") !== -1 && /\\b(max-age|s-maxage|public)\\b/i.test(rfcRespHeader("Cache-Control"))) rfcAdvise("RFC 9110 12.5.5: Vary: * conflicts with cacheable response directives");',
    '  }',
    '  var contentLocation = rfcRespHeader("Content-Location");',
    '  if (contentLocation && (/\\s/.test(contentLocation.trim()) || contentLocation.trim().length === 0)) pm.expect.fail("Content-Location must be a valid URI-reference (RFC 9110): " + contentLocation);',
    '  var acceptRanges = rfcRespHeader("Accept-Ranges");',
    '  if (acceptRanges && !rfcTokenList(acceptRanges)) pm.expect.fail("Accept-Ranges must be a list of range-unit tokens (RFC 9110): " + acceptRanges);',
    '  var contentLanguage = rfcRespHeader("Content-Language");',
    '  if (contentLanguage) contentLanguage.split(",").forEach(function (tag) { if (!/^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(tag.trim())) pm.expect.fail("Content-Language carries a malformed BCP 47 language-tag (RFC 5646): " + tag.trim()); });',
    '  var allow = rfcRespHeader("Allow");',
    '  if (allow && allow.trim() && !rfcTokenList(allow)) pm.expect.fail("Allow must be a comma-separated list of method tokens (RFC 9110): " + allow);',
    '  if (allow && contract.method === "OPTIONS" && pm.response.code >= 200 && pm.response.code < 300) {',
    '    var optionsAllowed = allow.split(",").map(function (entry) { return entry.trim().toUpperCase(); });',
    '    (contract.pathMethods || []).forEach(function (method) { if (optionsAllowed.indexOf(method) === -1) pm.expect.fail("Allow on an OPTIONS response must list every method the OpenAPI path declares (RFC 9110); missing " + method + " in: " + allow); });',
    '  }',
    '  var age = rfcRespHeader("Age");',
    '  if (age && !/^[0-9]+$/.test(age.trim())) pm.expect.fail("Age must be a non-negative integer of delta-seconds (RFC 9111): " + age);',
    '  var expires = rfcRespHeader("Expires");',
    '  if (expires && !rfcIsHttpDate(expires)) rfcAdvise("RFC 9111: Expires is not a valid HTTP-date and will be treated as already expired: " + expires);',
    '  if (expires && rfcIsHttpDate(expires) && date && rfcIsHttpDate(date) && Date.parse(expires) < Date.parse(date) && !/\\b(max-age|s-maxage|no-cache|no-store)\\b/i.test(rfcRespHeader("Cache-Control"))) rfcAdvise("RFC 9111 5.3: Expires is earlier than Date without an explicit staleness directive");',
    '  if (rfcHeaderAll("warning").length > 0) rfcAdvise("RFC 9111 obsoleted the Warning header; the server still emits it");',
    '  var cacheControl = rfcRespHeader("Cache-Control");',
    '  if (cacheControl) {',
    '    var seenDirectives = {};',
    '    rfcSplitList(cacheControl).forEach(function (entry) {',
    '      var directive = entry.trim();',
    '      if (!directive) { pm.expect.fail("Cache-Control contains an empty directive (RFC 9111): " + cacheControl); return; }',
    '      var eq = directive.indexOf("=");',
    '      var name = (eq === -1 ? directive : directive.slice(0, eq)).trim().toLowerCase();',
    '      var argument = eq === -1 ? undefined : directive.slice(eq + 1).trim();',
    '      if (!rfcIsToken(name)) pm.expect.fail("Cache-Control directive name is not a token (RFC 9111): " + directive);',
    '      if (Object.prototype.hasOwnProperty.call(seenDirectives, name)) rfcAdvise("RFC 9111: Cache-Control repeats the " + name + " directive: " + cacheControl);',
    '      seenDirectives[name] = argument === undefined ? true : argument;',
    '      if (["max-age", "s-maxage", "stale-while-revalidate", "stale-if-error"].indexOf(name) !== -1 && (argument === undefined || !/^"?[0-9]+"?$/.test(argument))) pm.expect.fail("Cache-Control " + name + " requires a delta-seconds argument (RFC 9111/5861): " + directive);',
    '      if (["immutable", "no-store", "public", "must-revalidate", "proxy-revalidate", "must-understand", "no-transform", "only-if-cached"].indexOf(name) !== -1 && argument !== undefined) pm.expect.fail("Cache-Control " + name + " takes no argument (RFC 9111/8246): " + directive);',
    '    });',
    '    if (seenDirectives["no-store"] && seenDirectives["max-age"] !== undefined) pm.expect.fail("Cache-Control combines no-store with max-age; the directives contradict (RFC 9111): " + cacheControl);',
    '    if (seenDirectives["s-maxage"] !== undefined && seenDirectives.private !== undefined) rfcAdvise("RFC 9111 5.2.2: Cache-Control combines s-maxage with private directives");',
    '  }',
    '  var contentEncoding = rfcRespHeader("Content-Encoding");',
    '  if (contentEncoding) rfcSplitList(contentEncoding).forEach(function (entry) { var coding = entry.trim().toLowerCase(); if (!coding || rfcRegistries.contentCodings.indexOf(coding) === -1) pm.expect.fail("Content-Encoding member is not in the vendored IANA HTTP content-coding registry snapshot (RFC 9110 8.4): " + entry.trim()); });',
    '  var contentDisposition = rfcRespHeader("Content-Disposition");',
    '  if (contentDisposition && rfcResponseDeclaresHeader("Content-Disposition")) {',
    '    var cdParts = contentDisposition.split(";");',
    '    var dispositionType = cdParts.shift().trim();',
    '    var cdParams = {};',
    '    if (!rfcIsToken(dispositionType)) pm.expect.fail("Content-Disposition disposition-type must be a token (RFC 6266 4.1): " + dispositionType);',
    '    cdParts.forEach(function (entry) {',
    '      var param = entry.trim(); if (!param) return;',
    '      var eq = param.indexOf("=");',
    '      if (eq <= 0) { pm.expect.fail("Content-Disposition parameters must use name=value syntax (RFC 6266 4.1): " + param); return; }',
    '      var paramName = param.slice(0, eq).trim().toLowerCase();',
    '      var paramValue = param.slice(eq + 1).trim();',
    '      if (!rfcIsToken(paramName)) pm.expect.fail("Content-Disposition parameter name must be a token (RFC 6266 4.1): " + param);',
    '      if (Object.prototype.hasOwnProperty.call(cdParams, paramName)) pm.expect.fail("Content-Disposition must not repeat parameter " + paramName + " (RFC 6266 4.1): " + contentDisposition);',
    '      cdParams[paramName] = true;',
    '      if (!/^"(?:[^"\\\\]|\\\\.)*"$|^[!#$%&\'*+.^_`|~0-9A-Za-z-]+$/.test(paramValue)) pm.expect.fail("Content-Disposition parameter value is malformed (RFC 6266 4.1): " + param);',
    "      if (paramName === \"filename*\" && !/^[A-Za-z0-9!#$&+.^_`{}~-]+'[A-Za-z0-9!#$&+.^_`{}~-]*'[^\\s]*$/.test(paramValue)) pm.expect.fail(\"Content-Disposition filename* must use RFC 5987 charset''value syntax (RFC 6266 4.1): \" + param);",
    '    });',
    '  }',
    '  var acceptPatch = rfcRespHeader("Accept-Patch");',
    '  if (acceptPatch) acceptPatch.split(",").forEach(function (entry) { var parts = mediaParts(entry); if (!parts.type || !parts.subtype) pm.expect.fail("Accept-Patch must be a list of media types (RFC 5789): " + entry.trim()); });',
    '  var deprecation = rfcRespHeader("Deprecation");',
    '  if (deprecation && !/^@-?[0-9]+$/.test(deprecation.trim())) pm.expect.fail("Deprecation must be an RFC 9745 Date structured field (@unix-timestamp): " + deprecation);',
    '  var sunset = rfcRespHeader("Sunset");',
    '  if (sunset) {',
    '    if (!rfcIsHttpDate(sunset)) pm.expect.fail("Sunset must be a valid HTTP-date (RFC 8594): " + sunset);',
    '    else if (Date.parse(sunset) < Date.now()) rfcAdvise("RFC 8594: Sunset date is already in the past: " + sunset);',
    '  }',
    '  var preferenceApplied = rfcRespHeader("Preference-Applied");',
    '  if (preferenceApplied) {',
    '    var requestPrefer = requestHeader("Prefer").toLowerCase();',
    '    rfcSplitList(preferenceApplied).forEach(function (entry) {',
    '      var token = entry.split("=")[0].trim().toLowerCase();',
    '      if (token && requestPrefer.indexOf(token) === -1) pm.expect.fail("Preference-Applied echoes a preference the request never sent (RFC 7240): " + entry.trim());',
    '    });',
    '  }',
    '  var trailerValue = rfcRespHeader("Trailer");',
    '  if (trailerValue) {',
    '    trailerValue.split(",").forEach(function (entry) {',
    '      var trailerField = entry.trim();',
    '      if (!trailerField) return;',
    '      if (!rfcIsToken(trailerField)) pm.expect.fail("Trailer members must be field-name tokens (RFC 9110): " + trailerField);',
    '      else if (rfcRegistries.forbiddenTrailers.indexOf(trailerField.toLowerCase()) !== -1) pm.expect.fail("Trailer must not name " + trailerField + "; RFC 9110 forbids framing, routing, modifier, authentication, and content-processing fields in trailers");',
    '    });',
    '  }',
    '  var altSvc = rfcRespHeader("Alt-Svc");',
    '  if (altSvc && altSvc.trim() !== "clear") {',
    '    rfcSplitList(altSvc).forEach(function (entry) {',
    '      var alt = entry.trim();',
    '      if (!alt) { pm.expect.fail("Alt-Svc contains an empty alternative (RFC 7838): " + altSvc); return; }',
    '      var altMatch = alt.match(/^([!#$%&\'*+.^_`|~0-9A-Za-z%-]+)=("(?:[^"\\\\]|\\\\.)*")(\\s*;[\\s\\S]*)?$/);',
    '      if (!altMatch) { pm.expect.fail("Alt-Svc alternative must be protocol-id=<quoted alt-authority> (RFC 7838): " + alt); return; }',
    '      (altMatch[3] || "").split(";").forEach(function (paramEntry) {',
    '        var param = paramEntry.trim();',
    '        if (!param) return;',
    '        var paramEq = param.indexOf("=");',
    '        if (paramEq === -1) { pm.expect.fail("Alt-Svc parameters must be token=value (RFC 7838): " + param); return; }',
    '        var paramName = param.slice(0, paramEq).trim();',
    '        var paramValue = param.slice(paramEq + 1).trim();',
    '        if (!rfcIsToken(paramName)) pm.expect.fail("Alt-Svc parameter name must be a token (RFC 7838): " + param);',
    '        if (paramName === "ma" && !/^"?[0-9]+"?$/.test(paramValue)) pm.expect.fail("Alt-Svc ma parameter must be delta-seconds (RFC 7838): " + param);',
    '        if (paramName === "persist" && paramValue !== "1" && paramValue !== \'"1"\') pm.expect.fail("Alt-Svc persist parameter must be 1 (RFC 7838): " + param);',
    '      });',
    '    });',
    '  }',
    '});',
    'pm.test(\'Set-Cookie response headers satisfy RFC 6265\', function () {',
    '  rfcHeaderAll("Set-Cookie").forEach(function (setCookie) {',
    '    if (setCookie.indexOf("{{") !== -1) return;',
    '    var segments = setCookie.split(";");',
    '    var pair = segments[0];',
    '    var pairEq = pair.indexOf("=");',
    '    if (pairEq <= 0) { pm.expect.fail("Set-Cookie must start with cookie-name=cookie-value (RFC 6265): " + setCookie); return; }',
    '    var cookieName = pair.slice(0, pairEq).trim();',
    '    var cookieValue = pair.slice(pairEq + 1).trim();',
    '    if (!rfcIsToken(cookieName)) pm.expect.fail("Set-Cookie cookie-name must be a token (RFC 6265): " + cookieName);',
    '    if (!/^"[\\x21\\x23-\\x2b\\x2d-\\x3a\\x3c-\\x5b\\x5d-\\x7e]*"$|^[\\x21\\x23-\\x2b\\x2d-\\x3a\\x3c-\\x5b\\x5d-\\x7e]*$/.test(cookieValue)) pm.expect.fail("Set-Cookie cookie-value contains characters outside cookie-octet (RFC 6265): " + setCookie);',
    '    var attrs = {};',
    '    for (var a = 1; a < segments.length; a += 1) {',
    '      var attr = segments[a].trim();',
    '      if (!attr) { pm.expect.fail("Set-Cookie contains an empty attribute (RFC 6265): " + setCookie); continue; }',
    '      var attrEq = attr.indexOf("=");',
    '      var attrName = (attrEq === -1 ? attr : attr.slice(0, attrEq)).trim().toLowerCase();',
    '      var attrValue = attrEq === -1 ? undefined : attr.slice(attrEq + 1).trim();',
    '      if (Object.prototype.hasOwnProperty.call(attrs, attrName)) pm.expect.fail("Set-Cookie repeats the " + attrName + " attribute (RFC 6265): " + setCookie);',
    '      attrs[attrName] = attrValue === undefined ? true : attrValue;',
    '      if (attrName === "max-age" && !/^-?[0-9]+$/.test(String(attrValue || ""))) pm.expect.fail("Set-Cookie Max-Age must be an integer (RFC 6265): " + attr);',
    '      if (attrName === "expires") {',
    '        if (!attrValue || isNaN(Date.parse(attrValue))) pm.expect.fail("Set-Cookie Expires is not a parseable cookie-date (RFC 6265): " + attr);',
    '        else if (!rfcIsHttpDate(attrValue)) rfcAdvise("RFC 6265: Set-Cookie Expires is not the preferred IMF-fixdate form: " + attrValue);',
    '      }',
    '      if ((attrName === "secure" || attrName === "httponly") && attrValue !== undefined) pm.expect.fail("Set-Cookie " + attrName + " attribute takes no value (RFC 6265): " + attr);',
    '      if (attrName === "samesite" && ["strict", "lax", "none"].indexOf(String(attrValue || "").toLowerCase()) === -1) pm.expect.fail("Set-Cookie SameSite must be Strict, Lax, or None (RFC 6265bis): " + attr);',
    '    }',
    '    if (String(attrs.samesite || "").toLowerCase() === "none" && attrs.secure === undefined) pm.expect.fail("Set-Cookie SameSite=None requires Secure (RFC 6265bis): " + setCookie);',
    '    if (cookieName.indexOf("__Host-") === 0 && (attrs.secure === undefined || attrs.domain !== undefined || attrs.path !== "/")) pm.expect.fail("Set-Cookie __Host- prefix requires Secure, no Domain, and Path=/ (RFC 6265bis): " + setCookie);',
    '    if (cookieName.indexOf("__Secure-") === 0 && attrs.secure === undefined) pm.expect.fail("Set-Cookie __Secure- prefix requires Secure (RFC 6265bis): " + setCookie);',
    '    if (attrs.secure === undefined && attrs.httponly === undefined && attrs.samesite === undefined) rfcAdvise("Set-Cookie " + cookieName + " carries none of Secure, HttpOnly, or SameSite");',
    '  });',
    '});',
    'pm.test(\'Security response headers satisfy their specifications\', function () {',
    '  var hsts = rfcRespHeader("Strict-Transport-Security");',
    '  if (hsts) {',
    '    var hstsSeen = {};',
    '    hsts.split(";").forEach(function (entry) {',
    '      var directive = entry.trim();',
    '      if (!directive) { pm.expect.fail("Strict-Transport-Security contains an empty directive (RFC 6797): " + hsts); return; }',
    '      var directiveEq = directive.indexOf("=");',
    '      var directiveName = (directiveEq === -1 ? directive : directive.slice(0, directiveEq)).trim().toLowerCase();',
    '      var directiveValue = directiveEq === -1 ? undefined : directive.slice(directiveEq + 1).trim();',
    '      if (!rfcIsToken(directiveName)) pm.expect.fail("Strict-Transport-Security directive name must be a token (RFC 6797): " + directive);',
    '      if (Object.prototype.hasOwnProperty.call(hstsSeen, directiveName)) pm.expect.fail("Strict-Transport-Security must not repeat the " + directiveName + " directive (RFC 6797): " + hsts);',
    '      hstsSeen[directiveName] = true;',
    '      if (directiveName === "max-age" && !/^"?[0-9]+"?$/.test(String(directiveValue || ""))) pm.expect.fail("Strict-Transport-Security max-age requires a delta-seconds value (RFC 6797): " + directive);',
    '      if ((directiveName === "includesubdomains" || directiveName === "preload") && directiveValue !== undefined) pm.expect.fail("Strict-Transport-Security " + directiveName + " is valueless (RFC 6797): " + directive);',
    '    });',
    '    if (hstsSeen["max-age"] === undefined) pm.expect.fail("Strict-Transport-Security requires a max-age directive (RFC 6797): " + hsts);',
    '  }',
    '  var xcto = rfcRespHeader("X-Content-Type-Options");',
    '  if (xcto && xcto.split(",")[0].trim().toLowerCase() !== "nosniff") pm.expect.fail("X-Content-Type-Options must be nosniff (WHATWG Fetch): " + xcto);',
    '  var referrerPolicy = rfcRespHeader("Referrer-Policy");',
    '  if (referrerPolicy) referrerPolicy.split(",").forEach(function (entry) { var member = entry.trim().toLowerCase(); if (rfcRegistries.referrerPolicies.indexOf(member) === -1) pm.expect.fail("Referrer-Policy member is not a registered policy (W3C Referrer Policy): " + entry.trim()); });',
    '  var permissionsPolicy = rfcRespHeader("Permissions-Policy");',
    '  if (permissionsPolicy && !rfcSfParse(permissionsPolicy, "dict")) pm.expect.fail("Permissions-Policy must be a Structured Field Dictionary (W3C Permissions Policy): " + permissionsPolicy);',
    '});',
    'pm.test(\'CORS response headers satisfy the WHATWG Fetch standard\', function () {',
    '  var acaoValues = rfcHeaderAll("Access-Control-Allow-Origin");',
    '  var acao = acaoValues.length > 0 ? acaoValues[0].trim() : "";',
    '  if (acaoValues.length > 1) pm.expect.fail("Access-Control-Allow-Origin must appear at most once (WHATWG Fetch): " + acaoValues.join(" / "));',
    '  if (acao && acao !== "*" && acao !== "null" && !/^[A-Za-z][A-Za-z0-9+.-]*:\\/\\/[^\\/\\s?#]+$/.test(acao)) pm.expect.fail("Access-Control-Allow-Origin must be *, null, or a single serialized origin (WHATWG Fetch): " + acao);',
    '  var corsCredentials = rfcRespHeader("Access-Control-Allow-Credentials");',
    '  if (corsCredentials) {',
    '    if (corsCredentials.trim() !== "true") pm.expect.fail("Access-Control-Allow-Credentials must be exactly true (WHATWG Fetch): " + corsCredentials);',
    '    if (acao === "*") pm.expect.fail("Access-Control-Allow-Origin * is illegal alongside Access-Control-Allow-Credentials: true (WHATWG Fetch)");',
    '  }',
    '  ["Access-Control-Expose-Headers", "Access-Control-Allow-Headers", "Access-Control-Allow-Methods"].forEach(function (name) {',
    '    var value = rfcRespHeader(name);',
    '    if (!value) return;',
    '    value.split(",").forEach(function (entry) {',
    '      var member = entry.trim();',
    '      if (!member) { pm.expect.fail(name + " contains an empty member (WHATWG Fetch): " + value); return; }',
    '      if (member !== "*" && !rfcIsToken(member)) pm.expect.fail(name + " members must be tokens (WHATWG Fetch): " + member);',
    '      if (member === "*" && corsCredentials && corsCredentials.trim() === "true") rfcAdvise("WHATWG Fetch: the * wildcard in " + name + " is treated as a literal name when credentials are allowed");',
    '    });',
    '  });',
    '  var corsMaxAge = rfcRespHeader("Access-Control-Max-Age");',
    '  if (corsMaxAge && !/^-?[0-9]+$/.test(corsMaxAge.trim())) pm.expect.fail("Access-Control-Max-Age must be an integer (WHATWG Fetch): " + corsMaxAge);',
    '  if (acao && acao !== "*" && acao !== "null") {',
    '    var varyForCors = rfcRespHeader("Vary").toLowerCase().split(",").map(function (entry) { return entry.trim(); });',
    '    if (varyForCors.indexOf("origin") === -1 && varyForCors.indexOf("*") === -1) rfcAdvise("CORS: Access-Control-Allow-Origin varies by origin but the response lacks Vary: Origin");',
    '  }',
    '});',
    'pm.test(\'Response satisfies RFC 9110 message framing requirements\', function () {',
    '  var code = pm.response.code;',
    '  if ((code === 204 || code < 200) && rfcRespHeader("Content-Length")) pm.expect.fail("RFC 9110 forbids Content-Length on 1xx and 204 responses");',
    '  if ([301, 302, 303, 307, 308].indexOf(code) !== -1 && !rfcRespHeader("Location")) pm.expect.fail("RFC 9110 expects Location on a " + code + " redirect response");',
    '  if (code === 416) {',
    '    var unsatisfiedRange = rfcRespHeader("Content-Range");',
    '    if (!unsatisfiedRange) pm.expect.fail("RFC 9110 requires Content-Range (unsatisfied-range form) on 416 responses");',
    '    else if (!/^bytes \\*\\/[0-9]+$/.test(unsatisfiedRange.trim())) pm.expect.fail("Content-Range on 416 must use the unsatisfied-range form bytes */<complete-length> (RFC 9110 15.5.17): " + unsatisfiedRange);',
    '  }',
    '  if (code === 206) {',
    '    var contentRange = rfcRespHeader("Content-Range");',
    '    var responseMedia = mediaParts(rfcRespHeader("Content-Type"));',
    '    var isByteranges = responseMedia.type === "multipart" && responseMedia.subtype === "byteranges";',
    '    if (!contentRange && !isByteranges) pm.expect.fail("RFC 9110 requires Content-Range on a single-part 206 response (or multipart/byteranges for multi-range)");',
    '    if (contentRange && isByteranges) pm.expect.fail("RFC 9110 forbids Content-Range on a multipart/byteranges 206 response");',
    '    if (rfcRespHeader("Accept-Ranges").trim().toLowerCase() === "none") pm.expect.fail("206 responses must not carry Accept-Ranges: none (RFC 9110 14.3)");',
    '    if (contentRange) {',
    '      var rangeParts = contentRange.trim().match(/^(\\S+) (?:([0-9]+)-([0-9]+)|\\*)\\/([0-9]+|\\*)$/);',
    '      if (!rangeParts) pm.expect.fail("Content-Range is not a valid RFC 9110 range: " + contentRange);',
    '      else {',
    '        if (rangeParts[1] !== "bytes") rfcAdvise("RFC 9110: 206 Content-Range uses a non-bytes range unit: " + rangeParts[1]);',
    '        if (rangeParts[2] !== undefined) {',
    '          if (Number(rangeParts[2]) > Number(rangeParts[3])) pm.expect.fail("Content-Range first-byte-pos must be <= last-byte-pos (RFC 9110): " + contentRange);',
    '          if (rangeParts[4] !== "*" && Number(rangeParts[3]) >= Number(rangeParts[4])) pm.expect.fail("Content-Range last-byte-pos must be < complete-length (RFC 9110): " + contentRange);',
    '          var rangeLength = Number(rangeParts[3]) - Number(rangeParts[2]) + 1;',
    '          var contentLength = rfcRespHeader("Content-Length");',
    '          if (contentLength && /^[0-9]+$/.test(contentLength.trim()) && Number(contentLength.trim()) !== rangeLength) pm.expect.fail("Content-Length must equal the selected byte-range length (RFC 9110 14.4): " + contentLength + " !== " + rangeLength);',
    '        }',
    '      }',
    '    }',
    '  }',
    '  if (code === 407 && !rfcRespHeader("Proxy-Authenticate")) pm.expect.fail("RFC 9110 requires Proxy-Authenticate on 407 responses");',
    '  if (code === 415 && contract.method === "PATCH" && !rfcRespHeader("Accept-Patch")) rfcAdvise("RFC 5789: a 415 response to PATCH SHOULD carry Accept-Patch");',
    '});',
    "pm.test('Response satisfies RFC 9110 range, negotiation, and cache conventions', function () {",
    '  var code = pm.response.code;',
    '  var method = contract.method;',
    '  var visibleRange = visibleRequestHeader("Range");',
    '  var reqRange = visibleRange.trim();',
    '  if (code === 206 || code === 416) {',
    '    if (method !== "GET") pm.expect.fail("RFC 9110 14.2: range responses (" + code + ") answer GET range requests");',
    '    if (!reqRange) rfcAdvise("RFC 9110 14: a " + code + " range response without a visible Range request header may be proxy-injected");',
    '  }',
    '  if (rfcRespHeader("Content-Range") && code !== 206 && code !== 416) pm.expect.fail("RFC 9110 14.4: Content-Range is meaningful only on 206 and 416 responses; unexpected on " + code);',
    '  if (code === 206 && reqRange) {',
    '    var crUnit = (rfcRespHeader("Content-Range").trim().split(" ")[0] || "").toLowerCase();',
    '    var reqUnit = (reqRange.split("=")[0] || "").toLowerCase();',
    '    if (crUnit && reqUnit && crUnit !== reqUnit) pm.expect.fail("RFC 9110 14.4: 206 Content-Range unit (" + crUnit + ") must match the request Range unit (" + reqUnit + ")");',
    '    var rangeSpec = reqRange.split("=")[1] || "";',
    '    var rangeCount = rangeSpec.split(",").filter(function (x) { return x.trim(); }).length;',
    '    var rmedia = mediaParts(rfcRespHeader("Content-Type"));',
    '    if (rangeCount === 1 && rmedia.type === "multipart" && rmedia.subtype === "byteranges") pm.expect.fail("RFC 9110 15.3.7: a single requested byte range must not be answered with multipart/byteranges");',
    '    if (reqRange.toLowerCase().indexOf("bytes=") === 0) {',
    '      var crb = rfcRespHeader("Content-Range").trim().match(/^bytes ([0-9]+)-([0-9]+)\\/([0-9]+|\\*)$/);',
    '      var singles = rangeSpec.split(",");',
    '      if (crb && singles.length === 1) {',
    '        var mm = singles[0].trim().match(/^([0-9]*)-([0-9]*)$/);',
    '        if (mm) {',
    '          var respStart = Number(crb[1]); var respEnd = Number(crb[2]);',
    '          if (mm[1] !== "" && respStart < Number(mm[1])) pm.expect.fail("RFC 9110 14.4: 206 first-byte-pos " + respStart + " is before the requested range start " + mm[1]);',
    '          if (mm[2] !== "" && respEnd > Number(mm[2])) pm.expect.fail("RFC 9110 14.4: 206 last-byte-pos " + respEnd + " is beyond the requested range end " + mm[2]);',
    '        }',
    '      }',
    '    }',
    '  }',
    '  if (code === 206) {',
    '    var crlen = rfcRespHeader("Content-Range").trim().match(/^bytes ([0-9]+)-([0-9]+)\\/([0-9]+|\\*)$/);',
    '    if (crlen && !rfcRespHeader("Content-Length")) { var expectLen = Number(crlen[2]) - Number(crlen[1]) + 1; var bodyLen = responseText().length; if (bodyLen > 0 && bodyLen !== expectLen) rfcAdvise("RFC 9110 14.4: 206 body length (" + bodyLen + ") does not match the Content-Range interval (" + expectLen + ")"); }',
    '    if (contract.responses["200"] && contract.responses["206"]) {',
    '      var ok200 = (contract.responses["200"].headers) || [];',
    '      ["ETag", "Content-Location", "Date", "Vary", "Cache-Control", "Expires"].forEach(function (name) {',
    '        var decl = ok200.some(function (h) { return String(h.name).toLowerCase() === name.toLowerCase(); });',
    '        if (decl && !rfcRespHeader(name)) pm.expect.fail("RFC 9110 15.3.7: a 206 must include " + name + " because the OpenAPI 200 response declares it");',
    '      });',
    '    }',
    '  }',
    '  if (code === 426 && !rfcRespHeader("Upgrade")) pm.expect.fail("RFC 9110 15.5.22 requires an Upgrade header on 426 responses");',
    '  var respAcceptEnc = rfcRespHeader("Accept-Encoding");',
    '  if (respAcceptEnc) rfcSplitList(respAcceptEnc).forEach(function (entry) { var e = entry.trim(); var coding = e.split(";")[0].trim().toLowerCase(); if (coding && coding !== "*" && coding !== "identity" && rfcRegistries.contentCodings.indexOf(coding) === -1) pm.expect.fail("Accept-Encoding lists a coding absent from the IANA content-coding registry (RFC 9110 12.5.3): " + e); var qm = e.match(/;\\s*q=([0-9.]+)/i); if (qm && Number(qm[1]) > 1) pm.expect.fail("Accept-Encoding qvalue must be <= 1 (RFC 9110): " + e); });',
    '  if (code === 415 && respAcceptEnc && !visibleRequestHeader("Content-Encoding")) rfcAdvise("RFC 9110: a 415 carrying Accept-Encoding implies an unsupported request Content-Encoding, but none is visible");',
    '  var ce = rfcRespHeader("Content-Encoding");',
    '  if (ce && rfcSplitList(ce).some(function (x) { return x.trim().toLowerCase() === "identity"; })) pm.expect.fail("RFC 9110 8.4.1: identity must not appear in Content-Encoding");',
    '  var reqAcceptEnc = visibleRequestHeader("Accept-Encoding");',
    '  if (ce && reqAcceptEnc) { var usedCodings = ce.split(",").map(function (x) { return x.trim().toLowerCase(); }); rfcSplitList(reqAcceptEnc).forEach(function (entry) { if (/;\\s*q=0(\\.0+)?\\s*$/i.test(entry.trim())) { var nm = entry.trim().split(";")[0].trim().toLowerCase(); if (usedCodings.indexOf(nm) !== -1) pm.expect.fail("Response Content-Encoding uses " + nm + " which the request Accept-Encoding set to q=0 (RFC 9110 12.5.3)"); } }); }',
    '  var vary = rfcRespHeader("Vary");',
    '  if (ce && vary && vary.indexOf("*") === -1 && !/\\baccept-encoding\\b/i.test(vary)) rfcAdvise("RFC 9110 12.5.5: a response with Content-Encoding SHOULD list Accept-Encoding in Vary");',
    '  if (rfcRespHeader("Content-Language") && vary && vary.indexOf("*") === -1 && !/\\baccept-language\\b/i.test(vary)) rfcAdvise("RFC 9110 12.5.5: a response with Content-Language SHOULD list Accept-Language in Vary");',
    '  if (code === 300 && responseText().trim().length === 0) rfcAdvise("RFC 9110 15.4.1: a 300 Multiple Choices response SHOULD include a body listing the alternatives");',
    '  if (code === 451) { var l451 = rfcRespHeader("Link"); if (!l451 || !/rel\\s*=\\s*"?blocked-by"?/i.test(l451)) rfcAdvise("RFC 7725 3: a 451 response SHOULD include a Link header with rel=blocked-by"); }',
    '  var sunsetH = rfcRespHeader("Sunset"); var deprH = rfcRespHeader("Deprecation");',
    '  if (sunsetH && deprH) { var depM = deprH.trim().match(/^@(-?[0-9]+)$/); var sunMs = Date.parse(sunsetH); if (depM && !isNaN(sunMs) && sunMs < Number(depM[1]) * 1000) pm.expect.fail("RFC 9745: Sunset date must not be earlier than the Deprecation date"); }',
    '  var cc = rfcRespHeader("Cache-Control");',
    '  if (cc) { rfcSplitList(cc).forEach(function (d) { var t = d.trim(); var dm = t.match(/^(max-age|s-maxage)\\s*=\\s*(.*)$/i); if (dm && /^".*"$/.test(dm[2].trim())) pm.expect.fail("RFC 9111 5.2.2: " + dm[1].toLowerCase() + " must be an unquoted delta-seconds: " + t); var fm = t.match(/^(no-cache|private)\\s*=\\s*(.*)$/i); if (fm) { var arg = fm[2].trim(); if (!/^".*"$/.test(arg)) pm.expect.fail("RFC 9111 5.2.2: " + fm[1].toLowerCase() + " argument must be a quoted field-name list: " + t); else if (arg.slice(1, -1).split(",").some(function (f) { return f.trim() && !/^[!#$%&*+.^_|~0-9A-Za-z-]+$/.test(f.trim()); })) pm.expect.fail("RFC 9111 5.2.2: " + fm[1].toLowerCase() + " field list must contain valid field-names: " + t); } }); if (/\\bmust-understand\\b/i.test(cc) && !/\\bno-store\\b/i.test(cc)) rfcAdvise("RFC 8246: must-understand SHOULD be accompanied by no-store"); }',
    '  if ([428, 429, 431, 511].indexOf(code) !== -1 && cc && /\\b(public|max-age|s-maxage)\\b/i.test(cc) && !/\\bno-store\\b/i.test(cc)) rfcAdvise("RFC 6585/9111: a " + code + " response should not be stored by a shared cache; avoid public/max-age without no-store");',
    '  if (method === "PATCH" && code >= 200 && code < 300 && rfcRespHeader("Content-Location")) rfcAdvise("RFC 5789 3.1: a PATCH Content-Location equal to the request target marks the response as the new representation; verify it matches the target URI");',
    '  if (method === "OPTIONS" && code >= 200 && code < 300 && (contract.pathMethods || []).indexOf("PATCH") !== -1 && !rfcRespHeader("Accept-Patch")) rfcAdvise("RFC 5789 3.1: an OPTIONS response for a resource that supports PATCH SHOULD list Accept-Patch");',
    '  var linkH = rfcRespHeader("Link");',
    '  if (linkH) { linkH.split(/,(?=\\s*<)/).forEach(function (lv) { var lm = lv.trim().match(/^<([^>]*)>(.*)$/); if (!lm) { pm.expect.fail("RFC 8288: link-value must be a <URI-Reference> followed by parameters: " + lv.trim()); return; } var params = lm[2]; var re = /;\\s*([A-Za-z0-9!#$%&*+.^_|~-]+)(\\s*=\\s*("(([^"\\\\]|\\\\.)*)"|[^;,\\s]+))?/g; var consumed = 0; var pm2; var sawRel = false; while ((pm2 = re.exec(params)) !== null) { consumed = re.lastIndex; if (pm2[1].toLowerCase() === "rel") sawRel = true; } if (params.replace(/\\s+$/, "").length > consumed) pm.expect.fail("RFC 8288: unparseable Link parameters: " + lv.trim()); if (!sawRel) pm.expect.fail("RFC 8288: link-value must include a rel parameter: " + lv.trim()); }); }',
    '});',
    'pm.test(\'Response media type is acceptable under the request Accept header\', function () {',
    '  if (pm.response.code < 200 || pm.response.code >= 300 || isBodyless()) return;',
    '  var accept = requestHeader("Accept");',
    '  if (!accept || accept.indexOf("{{") !== -1) return;',
    '  var actual = mediaParts(rfcRespHeader("Content-Type"));',
    '  if (!actual.type) return;',
    '  var acceptable = false;',
    '  var jsonSoftened = false;',
    '  rfcSplitList(accept).forEach(function (entry) {',
    '    var range = mediaParts(entry);',
    '    var qMatch = entry.match(/;\\s*q\\s*=\\s*"?([0-9.]+)"?/i);',
    '    if (qMatch && Number(qMatch[1]) <= 0) return;',
    '    if ((range.type === "*" && range.subtype === "*") || (range.type === actual.type && (range.subtype === "*" || range.subtype === actual.subtype))) acceptable = true;',
    '    if (range.type === actual.type && range.subtype === "json" && isJsonSubtype(actual.subtype)) jsonSoftened = true;',
    '  });',
    '  if (!acceptable && jsonSoftened) { rfcAdvise("Content negotiation: response " + actual.raw + " is a +json type while the request only accepted application/json"); return; }',
    '  if (!acceptable) pm.expect.fail("Response Content-Type " + actual.raw + " is not acceptable under the request Accept header (RFC 9110): " + accept);',
    '});',
    'pm.test(\'Response body satisfies its media type RFC conventions\', function () {',
    '  var contentTypeValue = rfcRespHeader("Content-Type");',
    '  var media = mediaParts(contentTypeValue);',
    '  var text = responseText();',
    '  if (pm.response.code === 406 && !text.trim()) rfcAdvise("RFC 9110: a 406 response SHOULD include a list of available representations");',
    '  if (!text) return;',
    '  if (isJsonSubtype(media.subtype)) {',
    '    if (text.charCodeAt(0) === 65279) pm.expect.fail("RFC 8259 forbids a byte order mark at the start of JSON text");',
    '    var charsetParam = contentTypeValue.match(/charset\\s*=\\s*"?([^";\\s]+)"?/i);',
    '    if (charsetParam) rfcAdvise("RFC 8259 defines no charset parameter for JSON media types; got charset=" + charsetParam[1]);',
    '  }',
    '  if (media.raw === "application/x-ndjson" || media.raw === "application/jsonl" || media.raw === "application/x-jsonlines") {',
    '    text.split(/\\r?\\n/).forEach(function (line, lineNumber) { if (!line.trim()) return; try { JSON.parse(line); } catch (error) { pm.expect.fail("NDJSON line " + (lineNumber + 1) + " is not valid JSON: " + error); } });',
    '  }',
    '  if (media.raw === "text/event-stream") {',
    '    var sseText = text.charCodeAt(0) === 65279 ? text.slice(1) : text;',
    '    var sseHasField = false;',
    '    sseText.split(/\\r?\\n/).forEach(function (line) { if (!line || line.charAt(0) === ":") return; var field = line.split(":")[0]; if (["data", "event", "id", "retry"].indexOf(field) === -1) pm.expect.fail("SSE line does not start with a known field or comment: " + line); else sseHasField = true; if (field === "retry" && !/^retry:\\s*[0-9]+\\s*$/.test(line)) pm.expect.fail("SSE retry field must be an integer: " + line); if (field === "id" && line.indexOf("\\u0000") !== -1) pm.expect.fail("SSE id field must not contain NUL (WHATWG HTML): " + line); });',
    '    if (sseHasField && !/\\r?\\n\\r?\\n$/.test(sseText)) rfcAdvise("SSE: the final event is not terminated by a blank line and would be discarded (WHATWG HTML)");',
    '  }',
    '  if (media.type === "multipart") {',
    '    var boundary = contentTypeValue.match(/;\\s*boundary=(?:"([^"]*)"|([^;]*))/i);',
    '    var boundaryValue = boundary ? (boundary[1] !== undefined ? boundary[1] : boundary[2].trim()) : "";',
    '    if (!boundaryValue) pm.expect.fail("multipart responses must carry a boundary parameter (RFC 2046): " + contentTypeValue);',
    '    else {',
    '      if (boundaryValue.length > 70) pm.expect.fail("multipart boundary must be 1-70 characters (RFC 2046): " + boundaryValue);',
    '      if (!/^[0-9A-Za-z\'()+_,\\-.\\/:=? ]*[0-9A-Za-z\'()+_,\\-.\\/:=?]$/.test(boundaryValue)) pm.expect.fail("multipart boundary contains characters outside RFC 2046 bchars or ends with a space: " + boundaryValue);',
    '    }',
    '  }',
    '  if (media.raw === "application/hal+json") {',
    '    var hal; try { hal = JSON.parse(text); } catch (error) { hal = null; }',
    '    if (hal && typeof hal === "object" && !Array.isArray(hal)) {',
    '      var halLinks = hal._links;',
    '      if (halLinks !== undefined && (typeof halLinks !== "object" || Array.isArray(halLinks) || halLinks === null)) pm.expect.fail("HAL _links must be an object of link relations");',
    '      if (halLinks) Object.keys(halLinks).forEach(function (rel) { var linkValue = halLinks[rel]; (Array.isArray(linkValue) ? linkValue : [linkValue]).forEach(function (linkObject) { if (!linkObject || typeof linkObject !== "object" || typeof linkObject.href !== "string") pm.expect.fail("HAL link relation " + rel + " must be a Link Object (or array of them) with a string href"); }); });',
    '      var halEmbedded = hal._embedded;',
    '      if (halEmbedded !== undefined && (typeof halEmbedded !== "object" || Array.isArray(halEmbedded) || halEmbedded === null)) pm.expect.fail("HAL _embedded must be an object of resource names");',
    '    }',
    '  }',
    '  if (media.raw === "application/vnd.api+json") {',
    '    var jsonApi; try { jsonApi = JSON.parse(text); } catch (error) { jsonApi = null; }',
    '    if (jsonApi && typeof jsonApi === "object" && !Array.isArray(jsonApi)) {',
    '      if (jsonApi.data === undefined && jsonApi.errors === undefined && jsonApi.meta === undefined) pm.expect.fail("JSON:API documents must contain at least one of data, errors, meta");',
    '      if (jsonApi.data !== undefined && jsonApi.errors !== undefined) pm.expect.fail("JSON:API forbids data and errors in the same document");',
    '    }',
    '  }',
    '  if (media.subtype === "problem+xml") {',
    '    if (text.indexOf("urn:ietf:rfc:7807") === -1) rfcAdvise("application/problem+xml body does not reference the urn:ietf:rfc:7807 namespace");',
    '    var xmlStatus = text.match(/<status[^>]*>\\s*([0-9]+)\\s*<\\/status>/);',
    '    if (xmlStatus && Number(xmlStatus[1]) !== pm.response.code) pm.expect.fail("RFC 9457 status member (" + xmlStatus[1] + ") must match the HTTP status code (" + pm.response.code + ")");',
    '  }',
    '});',
    // RateLimit / RateLimit-Policy are still an Internet-Draft, so their
    // checks live in the advisory block below rather than this hard-fail list.
    'pm.test(\'Structured field response headers parse per RFC 9651\', function () {',
    '  [["Cache-Status", "list"], ["Proxy-Status", "list"], ["Priority", "dict"], ["Signature", "dict"], ["Signature-Input", "dict"]].forEach(function (pair) {',
    '    var value = rfcHeaderAll(pair[0]).join(", ");',
    '    if (!value) return;',
    '    if (!rfcSfParse(value, pair[1])) pm.expect.fail(pair[0] + " is not a valid RFC 9651 structured field (" + pair[1] + "): " + value);',
    '  });',
    '});',
    'pm.test(\'Proxy-Status members are typed per RFC 9209\', function () {',
    '  var value = rfcHeaderAll("Proxy-Status").join(", ");',
    '  if (!value) return;',
    '  var parsed = rfcSfParse(value, "list");',
    '  if (!parsed) return;',
    '  parsed.list.forEach(function (member) {',
    '    if (member.t === "innerlist") { pm.expect.fail("Proxy-Status members must be Items, not Inner Lists (RFC 9209): " + value); return; }',
    '    if (member.v.t !== "tok" && member.v.t !== "str") pm.expect.fail("Proxy-Status member names must be Tokens or Strings (RFC 9209): " + value);',
    '    var p = member.p;',
    '    if (p.error !== undefined) {',
    '      if (p.error.t !== "tok") pm.expect.fail("Proxy-Status error parameter must be a Token (RFC 9209): " + value);',
    '      else if (rfcRegistries.proxyStatusErrors.indexOf(p.error.v) === -1) rfcAdvise("RFC 9209: Proxy-Status error type is not in the IANA registry snapshot: " + p.error.v);',
    '    }',
    '    if (p["next-hop"] !== undefined && p["next-hop"].t !== "tok" && p["next-hop"].t !== "str") pm.expect.fail("Proxy-Status next-hop parameter must be a Token or String (RFC 9209): " + value);',
    '    if (p["received-status"] !== undefined && p["received-status"].t !== "int") pm.expect.fail("Proxy-Status received-status parameter must be an Integer (RFC 9209): " + value);',
    '    if (p.details !== undefined && p.details.t !== "str") pm.expect.fail("Proxy-Status details parameter must be a String (RFC 9209): " + value);',
    '  });',
    '});',
    'pm.test(\'HTTP message signatures are structurally valid (RFC 9421)\', function () {',
    '  var sigInputRaw = rfcHeaderAll("Signature-Input").join(", ");',
    '  var sigRaw = rfcHeaderAll("Signature").join(", ");',
    '  if (!sigInputRaw && !sigRaw) return;',
    '  var sigInput = sigInputRaw ? rfcSfParse(sigInputRaw, "dict") : { dict: {}, keys: [] };',
    '  var sig = sigRaw ? rfcSfParse(sigRaw, "dict") : { dict: {}, keys: [] };',
    '  if (!sigInput || !sig) return;',
    '  if (sigRaw && !sigInputRaw) pm.expect.fail("Signature without a Signature-Input field cannot be verified (RFC 9421)");',
    '  sig.keys.forEach(function (label) { if (sigInput.dict[label] === undefined) pm.expect.fail("Signature label " + label + " has no matching Signature-Input member (RFC 9421)"); });',
    '  if (sigRaw) sigInput.keys.forEach(function (label) { if (sig.dict[label] === undefined) pm.expect.fail("Signature-Input label " + label + " has no matching Signature member (RFC 9421)"); });',
    '  sig.keys.forEach(function (label) { var member = sig.dict[label]; if (member.t === "innerlist" || member.v.t !== "bytes") pm.expect.fail("Signature " + label + " must be a Byte Sequence (RFC 9421)"); });',
    '  var derivedComponents = ["@method", "@target-uri", "@authority", "@scheme", "@request-target", "@path", "@query", "@query-param", "@status"];',
    '  sigInput.keys.forEach(function (label) {',
    '    var member = sigInput.dict[label];',
    '    if (member.t !== "innerlist") { pm.expect.fail("Signature-Input " + label + " must be an Inner List of covered components (RFC 9421)"); return; }',
    '    member.v.forEach(function (component) {',
    '      if (component.v.t !== "str") { pm.expect.fail("Signature-Input " + label + " covered components must be Strings (RFC 9421)"); return; }',
    '      var componentName = component.v.v;',
    '      if (componentName.charAt(0) === "@") { if (derivedComponents.indexOf(componentName) === -1) pm.expect.fail("Signature-Input " + label + " uses an unknown derived component (RFC 9421): " + componentName); }',
    '      else if (!/^[a-z0-9!#$%&\'*+.^_`|~-]+$/.test(componentName)) pm.expect.fail("Signature-Input " + label + " component names must be lowercase field names (RFC 9421): " + componentName);',
    '    });',
    '    var p = member.p;',
    '    if (p.created !== undefined && p.created.t !== "int") pm.expect.fail("Signature-Input " + label + " created parameter must be an Integer (RFC 9421)");',
    '    if (p.expires !== undefined && p.expires.t !== "int") pm.expect.fail("Signature-Input " + label + " expires parameter must be an Integer (RFC 9421)");',
    '    if (p.created !== undefined && p.created.t === "int" && p.expires !== undefined && p.expires.t === "int" && p.created.v > p.expires.v) pm.expect.fail("Signature-Input " + label + " created must not be later than expires (RFC 9421)");',
    '    ["keyid", "alg", "nonce", "tag"].forEach(function (paramName) { if (p[paramName] !== undefined && p[paramName].t !== "str") pm.expect.fail("Signature-Input " + label + " " + paramName + " parameter must be a String (RFC 9421)"); });',
    '  });',
    '});',
    // draft-ietf-httpapi-ratelimit-headers is not yet an RFC, so every finding
    // here is advisory via rfcAdvise; this test never fails on its own.
    'pm.test(\'RateLimit headers follow the IETF ratelimit-headers draft (advisory)\', function () {',
    '  var rl = rfcHeaderAll("RateLimit").join(", ");',
    '  var rlp = rfcHeaderAll("RateLimit-Policy").join(", ");',
    '  var legacyLimit = rfcRespHeader("X-RateLimit-Limit").trim();',
    '  var legacyRemaining = rfcRespHeader("X-RateLimit-Remaining").trim();',
    '  var legacyReset = rfcRespHeader("X-RateLimit-Reset").trim();',
    '  var policyQuotas = {};',
    '  if (rlp) {',
    '    var policyList = rfcSfParse(rlp, "list");',
    '    if (!policyList) rfcAdvise("RateLimit-Policy does not parse as a Structured Field List (draft-ietf-httpapi-ratelimit-headers): " + rlp);',
    '    else policyList.list.forEach(function (member) {',
    '      if (member.t === "innerlist" || member.v.t !== "str") { rfcAdvise("RateLimit-Policy members should be String policy names (draft-ietf-httpapi-ratelimit-headers): " + rlp); return; }',
    '      ["q", "w"].forEach(function (paramName) { if (member.p[paramName] !== undefined && member.p[paramName].t !== "int") rfcAdvise("RateLimit-Policy " + paramName + " parameter should be an Integer (draft-ietf-httpapi-ratelimit-headers): " + rlp); });',
    '      if (member.p.q !== undefined && member.p.q.t === "int") policyQuotas[member.v.v] = member.p.q.v;',
    '    });',
    '  }',
    '  if (rl) {',
    '    var limitList = rfcSfParse(rl, "list");',
    '    if (!limitList) rfcAdvise("RateLimit does not parse as a Structured Field List (draft-ietf-httpapi-ratelimit-headers): " + rl);',
    '    else limitList.list.forEach(function (member) {',
    '      if (member.t === "innerlist" || member.v.t !== "str") { rfcAdvise("RateLimit members should be String policy names (draft-ietf-httpapi-ratelimit-headers): " + rl); return; }',
    '      ["r", "t"].forEach(function (paramName) { if (member.p[paramName] !== undefined && member.p[paramName].t !== "int") rfcAdvise("RateLimit " + paramName + " parameter should be an Integer (draft-ietf-httpapi-ratelimit-headers): " + rl); });',
    '      var remaining = member.p.r !== undefined && member.p.r.t === "int" ? member.p.r.v : undefined;',
    '      if (remaining !== undefined && remaining < 0) rfcAdvise("RateLimit r (remaining) should not be negative (draft-ietf-httpapi-ratelimit-headers): " + rl);',
    '      var quota = policyQuotas[member.v.v];',
    '      if (remaining !== undefined && quota !== undefined && remaining > quota) rfcAdvise("RateLimit remaining (" + remaining + ") exceeds the RateLimit-Policy quota (" + quota + ") for policy " + member.v.v);',
    '      if (remaining !== undefined && /^[0-9]+$/.test(legacyRemaining) && Number(legacyRemaining) !== remaining) rfcAdvise("RateLimit and legacy X-RateLimit-Remaining disagree: " + remaining + " vs " + legacyRemaining);',
    '    });',
    '  }',
    '  if (/^[0-9]+$/.test(legacyLimit) && /^[0-9]+$/.test(legacyRemaining) && Number(legacyRemaining) > Number(legacyLimit)) rfcAdvise("X-RateLimit-Remaining exceeds X-RateLimit-Limit: " + legacyRemaining + " > " + legacyLimit);',
    '  if ((legacyLimit || legacyRemaining || legacyReset) && !(legacyLimit && legacyRemaining && legacyReset)) rfcAdvise("Legacy X-RateLimit-* headers are partial; Limit/Remaining/Reset should travel together");',
    '});',
    'pm.test(\'Content-Digest and Repr-Digest match the response body (RFC 9530)\', function () {',
    '  var cryptoLib = null;',
    '  try { cryptoLib = require("crypto-js"); } catch (error) { cryptoLib = null; }',
    '  ["Content-Digest", "Repr-Digest"].forEach(function (name) {',
    '    var value = rfcRespHeader(name);',
    '    if (!value) return;',
    '    if (!rfcSfParse(value, "dict")) { pm.expect.fail(name + " is not a valid RFC 8941 dictionary (RFC 9530): " + value); return; }',
    '    if (!cryptoLib || rfcRespHeader("Content-Encoding")) return;',
    '    var media = mediaParts(rfcRespHeader("Content-Type"));',
    '    if (media.type !== "text" && !isJsonSubtype(media.subtype) && !/xml$/.test(media.subtype)) return;',
    '    rfcSplitList(value).forEach(function (entry) {',
    '      var match = entry.trim().match(/^(sha-256|sha-512)=:([A-Za-z0-9+\\/=]+):$/);',
    '      if (!match) return;',
    '      var computed = match[1] === "sha-256" ? cryptoLib.SHA256(responseText()) : cryptoLib.SHA512(responseText());',
    '      var encoded = cryptoLib.enc.Base64.stringify(computed);',
    '      if (encoded !== match[2]) pm.expect.fail(name + " " + match[1] + " does not match the response body (RFC 9530): computed " + encoded + " but header carries " + match[2]);',
    '    });',
    '  });',
    '});',
    'pm.test(\'Request credentials are well-formed per their authentication scheme RFCs\', function () {',
    '  var authorization = requestHeader("Authorization");',
    '  if (authorization && authorization.indexOf("{{") === -1) {',
    '    var schemeMatch = authorization.match(/^(\\S+)(?:\\s+([\\s\\S]*))?$/);',
    '    var authScheme = schemeMatch ? schemeMatch[1].toLowerCase() : "";',
    '    var authParams = schemeMatch && schemeMatch[2] !== undefined ? schemeMatch[2].trim() : "";',
    '    if (authScheme === "basic") {',
    '      var decoded = rfcBase64Decode(authParams);',
    '      if (decoded === null) pm.expect.fail("Basic credentials must be base64 (RFC 7617)");',
    '      else if (decoded.indexOf(":") === -1) pm.expect.fail("Basic credentials must decode to user-id:password (RFC 7617)");',
    '    }',
    '    if (authScheme === "bearer" && !/^[A-Za-z0-9\\-._~+\\/]+=*$/.test(authParams)) pm.expect.fail("Bearer token does not match the b64token grammar (RFC 6750)");',
    '    if (authScheme === "digest") {',
    '      rfcSplitList(authParams).forEach(function (entry) { var param = entry.trim(); if (param && !/^[!#$%&\'*+.^_`|~0-9A-Za-z-]+\\s*=\\s*("([^"\\\\]|\\\\.)*"|[!#$%&\'*+.^_`|~0-9A-Za-z-]+)$/.test(param)) pm.expect.fail("Digest auth-param is malformed (RFC 7616): " + param); });',
    '      var digestResponse = authParams.match(/\\bresponse\\s*=\\s*"?([^",\\s]+)"?/i);',
    '      if (digestResponse && !/^[0-9a-fA-F]+$/.test(digestResponse[1])) pm.expect.fail("Digest response parameter must be hex (RFC 7616): " + digestResponse[1]);',
    '    }',
    '  }',
    '  var wantsJwt = (contract.security || []).some(function (alternative) { return alternative.some(function (check) { return check.prefix === "Bearer " && String(check.bearerFormat || "").toUpperCase() === "JWT"; }); });',
    '  if (wantsJwt && authorization && authorization.indexOf("{{") === -1 && authorization.toLowerCase().indexOf("bearer ") === 0) {',
    '    var jwtToken = authorization.slice(7).trim();',
    '    var jwtSegments = jwtToken.split(".");',
    '    if (jwtSegments.length !== 3) pm.expect.fail("bearerFormat JWT tokens must have three base64url segments (RFC 7519); got " + jwtSegments.length);',
    '    else if (!jwtSegments.every(function (segment) { return /^[A-Za-z0-9_-]+$/.test(segment); })) pm.expect.fail("JWT segments must be base64url (RFC 7515)");',
    '    else {',
    '      var jwtDecode = function (segment) { var padded = segment.replace(/-/g, "+").replace(/_/g, "/"); while (padded.length % 4 !== 0) padded += "="; return rfcBase64Decode(padded); };',
    '      var jwtHeader = null; var jwtPayload = null;',
    '      try { jwtHeader = JSON.parse(jwtDecode(jwtSegments[0])); } catch (error) { pm.expect.fail("JWT header segment does not decode to JSON (RFC 7515)"); }',
    '      try { jwtPayload = JSON.parse(jwtDecode(jwtSegments[1])); } catch (error) { pm.expect.fail("JWT payload segment does not decode to JSON (RFC 7519)"); }',
    '      if (jwtHeader && typeof jwtHeader.alg !== "string") pm.expect.fail("JWT header must carry a string alg member (RFC 7515)");',
    '      if (jwtPayload) {',
    '        ["exp", "nbf", "iat"].forEach(function (claim) { if (jwtPayload[claim] !== undefined && typeof jwtPayload[claim] !== "number") pm.expect.fail("JWT " + claim + " claim must be numeric (RFC 7519)"); });',
    '        if (typeof jwtPayload.exp === "number" && jwtPayload.exp * 1000 < Date.now()) rfcAdvise("RFC 7519: the outgoing JWT exp claim is already in the past");',
    '      }',
    '    }',
    '  }',
    '  if (hasQueryParam("access_token")) rfcAdvise("RFC 6750: bearer tokens SHOULD NOT travel in the query string");',
    '  (contract.security || []).forEach(function (alternative) {',
    '    alternative.forEach(function (check) {',
    '      if (!check.checkable || !check.name) return;',
    '      if (check.in === "query") { if (hasQueryParam(check.name)) rfcAdvise("Security scheme " + check.scheme + " sends credentials in the query string"); return; }',
    '      if (check.in !== "header" || String(check.name).toLowerCase() === "authorization") return;',
    '      var apiKeyValue = requestHeader(check.name);',
    '      if (!apiKeyValue || apiKeyValue.indexOf("{{") !== -1) return;',
    '      if (apiKeyValue !== apiKeyValue.trim()) pm.expect.fail("API key header " + check.name + " carries leading or trailing whitespace");',
    '      if (!rfcIsFieldContent(apiKeyValue)) pm.expect.fail("API key header " + check.name + " contains characters forbidden by RFC 9110 field-content");',
    '    });',
    '  });',
    '});',
    'pm.test(\'Request preconditions, preferences, and patch bodies follow their RFCs\', function () {',
    '  ["If-Match", "If-None-Match"].forEach(function (name) {',
    '    var value = requestHeader(name);',
    '    if (!value || value.indexOf("{{") !== -1 || value.trim() === "*") return;',
    '    rfcSplitList(value).forEach(function (entry) { if (entry.trim() && !rfcIsEntityTag(entry.trim())) pm.expect.fail(name + " must be * or a list of entity-tags (RFC 9110): " + entry.trim()); });',
    '  });',
    '  var ifModifiedSince = visibleRequestHeader("If-Modified-Since");',
    '  if (ifModifiedSince) {',
    '    if (!rfcIsHttpDate(ifModifiedSince)) pm.expect.fail("If-Modified-Since must be an IMF-fixdate (RFC 9110): " + ifModifiedSince);',
    '    if (contract.method !== "GET" && contract.method !== "HEAD") pm.expect.fail("RFC 9110 requires recipients to ignore If-Modified-Since on non-GET/HEAD requests");',
    '  }',
    '  var ifUnmodifiedSince = visibleRequestHeader("If-Unmodified-Since");',
    '  if (ifUnmodifiedSince && !rfcIsHttpDate(ifUnmodifiedSince)) pm.expect.fail("If-Unmodified-Since must be an IMF-fixdate (RFC 9110): " + ifUnmodifiedSince);',
    '  var prefer = requestHeader("Prefer");',
    '  if (prefer && prefer.indexOf("{{") === -1) {',
    '    rfcSplitList(prefer).forEach(function (entry) { var token = entry.split("=")[0].split(";")[0].trim(); if (token && !rfcIsToken(token)) pm.expect.fail("Prefer preference name must be a token (RFC 7240): " + entry.trim()); });',
    '  }',
    '  var requestContentType = mediaBase(requestHeader("Content-Type"));',
    '  var body = pm.request.body;',
    '  var raw = body && body.mode === "raw" && typeof body.raw === "string" ? body.raw : "";',
    '  if (!raw.trim() || raw.indexOf("{{") !== -1 || /"<[^"<>]*>"/.test(raw)) return;',
    '  if (requestContentType === "application/json-patch+json") {',
    '    var patch; try { patch = JSON.parse(raw); } catch (error) { if (/<[A-Za-z][A-Za-z0-9_ -]*>/.test(raw)) return; pm.expect.fail("application/json-patch+json request body is not valid JSON (RFC 6902): " + error); return; }',
    '    if (!Array.isArray(patch)) { pm.expect.fail("A JSON Patch document must be an array of operations (RFC 6902)"); return; }',
    '    patch.forEach(function (operation, operationIndex) {',
    '      if (!operation || typeof operation !== "object" || Array.isArray(operation)) { pm.expect.fail("JSON Patch operation " + operationIndex + " must be an object (RFC 6902)"); return; }',
    '      if (["add", "remove", "replace", "move", "copy", "test"].indexOf(operation.op) === -1) pm.expect.fail("JSON Patch operation " + operationIndex + " has an invalid op (RFC 6902): " + operation.op);',
    '      var pointerPattern = /^(\\/([^\\/~]|~[01])*)*$/;',
    '      if (typeof operation.path !== "string" || !pointerPattern.test(operation.path)) pm.expect.fail("JSON Patch operation " + operationIndex + " path must be an RFC 6901 JSON Pointer");',
    '      if (["add", "replace", "test"].indexOf(operation.op) !== -1 && operation.value === undefined) pm.expect.fail("JSON Patch " + operation.op + " operation " + operationIndex + " requires a value member (RFC 6902)");',
    '      if (["move", "copy"].indexOf(operation.op) !== -1 && (typeof operation.from !== "string" || !pointerPattern.test(operation.from))) pm.expect.fail("JSON Patch " + operation.op + " operation " + operationIndex + " requires an RFC 6901 from pointer (RFC 6902)");',
    '    });',
    '  }',
    '  if (requestContentType === "application/merge-patch+json") {',
    '    try { JSON.parse(raw); } catch (error) { if (/<[A-Za-z][A-Za-z0-9_ -]*>/.test(raw)) return; pm.expect.fail("application/merge-patch+json request body must be valid JSON (RFC 7386): " + error); }',
    '  }',
    '});',
    'pm.test(\'Request multipart bodies and Idempotency-Key follow their specifications\', function () {',
    '  var idempotencyKey = requestHeader("Idempotency-Key");',
    '  if (idempotencyKey && idempotencyKey.indexOf("{{") === -1) {',
    '    var idemParsed = rfcSfParse(idempotencyKey, "item");',
    '    if (!idemParsed || idemParsed.item.v.t !== "str") pm.expect.fail("Idempotency-Key must be a Structured Field String (draft-ietf-httpapi-idempotency-key-header): " + idempotencyKey);',
    '    else if (!idemParsed.item.v.v) pm.expect.fail("Idempotency-Key must not be empty (draft-ietf-httpapi-idempotency-key-header)");',
    '  }',
    '  var reqContentType = requestHeader("Content-Type");',
    '  if (mediaBase(reqContentType) !== "multipart/form-data") return;',
    '  var declaredFields = (contract.multipartFields && contract.multipartFields.declared) || [];',
    '  var multipartBody = pm.request.body;',
    '  if (multipartBody && multipartBody.mode === "raw" && typeof multipartBody.raw === "string" && multipartBody.raw.trim()) {',
    '    if (reqContentType.indexOf("{{") !== -1) return;',
    '    var reqBoundary = reqContentType.match(/;\\s*boundary=(?:"([^"]*)"|([^;]*))/i);',
    '    var reqBoundaryValue = reqBoundary ? (reqBoundary[1] !== undefined ? reqBoundary[1] : reqBoundary[2].trim()) : "";',
    '    if (!reqBoundaryValue) { pm.expect.fail("multipart/form-data requests must carry a boundary parameter (RFC 7578): " + reqContentType); return; }',
    '    if (reqBoundaryValue.length > 70 || !/^[0-9A-Za-z\'()+_,\\-.\\/:=? ]*[0-9A-Za-z\'()+_,\\-.\\/:=?]$/.test(reqBoundaryValue)) { pm.expect.fail("multipart boundary is not a valid RFC 2046 boundary: " + reqBoundaryValue); return; }',
    '    if (multipartBody.raw.indexOf("{{") !== -1) return;',
    '    var multipartParts = multipartBody.raw.split("--" + reqBoundaryValue);',
    '    for (var partIndex = 1; partIndex < multipartParts.length; partIndex += 1) {',
    '      var part = multipartParts[partIndex];',
    '      if (part.slice(0, 2) === "--") break;',
    '      var headerSection = part.split(/\\r?\\n\\r?\\n/)[0] || "";',
    '      var disposition = "";',
    '      headerSection.split(/\\r?\\n/).forEach(function (headerLine) { if (/^content-disposition\\s*:/i.test(headerLine.trim())) disposition = headerLine.trim(); });',
    '      if (!disposition) { pm.expect.fail("Each multipart/form-data part must carry a Content-Disposition header (RFC 7578)"); continue; }',
    '      if (!/^content-disposition\\s*:\\s*form-data\\b/i.test(disposition)) { pm.expect.fail("multipart/form-data parts must use Content-Disposition: form-data (RFC 7578): " + disposition); continue; }',
    '      var nameMatch = disposition.match(/;\\s*name=(?:"([^"]*)"|([^";\\s]+))/i);',
    '      if (!nameMatch) { pm.expect.fail("multipart/form-data Content-Disposition must carry a name parameter (RFC 7578): " + disposition); continue; }',
    '      var partName = nameMatch[1] !== undefined ? nameMatch[1] : nameMatch[2];',
    '      if (declaredFields.length > 0 && declaredFields.indexOf(partName) === -1) rfcAdvise("RFC 7578: multipart part " + partName + " is not a property the OpenAPI multipart schema declares");',
    '    }',
    '  } else if (multipartBody && multipartBody.mode === "formdata" && multipartBody.formdata && typeof multipartBody.formdata.each === "function") {',
    '    multipartBody.formdata.each(function (entry) {',
    '      if (!entry || entry.disabled === true) return;',
    '      var partName = String(entry.key || "");',
    '      if (partName && declaredFields.length > 0 && declaredFields.indexOf(partName) === -1) rfcAdvise("RFC 7578: multipart part " + partName + " is not a property the OpenAPI multipart schema declares");',
    '    });',
    '  }',
    '});',
    'pm.test(\'Deprecated operation signals deprecation in the response\', function () {',
    '  if (!contract.deprecated) return;',
    '  if (!rfcRespHeader("Deprecation") && !rfcRespHeader("Sunset")) rfcAdvise("RFC 9745: the OpenAPI document deprecates this operation but the response carries neither Deprecation nor Sunset");',
    '});',
    'pm.test(\'OpenAPI link expressions resolve against the response\', function () {',
    '  if (!selected || !selected.value.links || selected.value.links.length === 0) return;',
    '  var linkBody = null; var linkBodyParsed = false; var requestBody = null; var requestBodyParsed = false;',
    '  function linkPointer(root, pointer) { var target = root; var tokens = String(pointer).split("/").slice(1).map(function (token) { return token.replace(/~1/g, "/").replace(/~0/g, "~"); }); for (var t = 0; t < tokens.length; t += 1) { if (target !== null && typeof target === "object") target = Array.isArray(target) ? target[Number(tokens[t])] : target[tokens[t]]; else return undefined; } return target; }',
    '  function assertLinkTarget(expression, value, sourceLabel, coerce) { if (value === undefined) { pm.expect.fail("OpenAPI link " + expression.link + " expression " + sourceLabel + " does not resolve"); return; } if (expression.targetKey && linkTargetValidators[expression.targetKey] && !linkTargetValidators[expression.targetKey].skip) { var schema = (contract.linkTargetSchemas || {})[expression.targetKey] || {}; var candidate = coerce ? coerceBySchema(value, schema) : value; if (!linkTargetValidators[expression.targetKey](candidate)) pm.expect.fail("OpenAPI link " + expression.link + " supplies " + sourceLabel + " to target input " + expression.param + ", but the value does not satisfy the target operation schema (OAS Link Object): " + JSON.stringify(linkTargetValidators[expression.targetKey].errors || [])); } }',
    '  selected.value.links.forEach(function (expression) {',
    '    if (expression.kind === "header") {',
    '      var linkHeaderMatches = 0; var linkHeaderValue = null;',
    '      if (typeof pm.response.headers.each === "function") pm.response.headers.each(function (headerField) { if (headerField && headerField.key && String(headerField.key).toLowerCase() === String(expression.header).toLowerCase()) { linkHeaderMatches += 1; linkHeaderValue = String(headerField.value); } });',
    '      else if (pm.response.headers.get(expression.header)) { linkHeaderMatches = 1; linkHeaderValue = pm.response.headers.get(expression.header); }',
    '      if (linkHeaderMatches === 0) pm.expect.fail("OpenAPI link " + expression.link + " references response header " + expression.header + " which is absent");',
    '      else if (linkHeaderMatches > 1) pm.expect.fail("OpenAPI link " + expression.link + " expression $response.header." + expression.header + " is ambiguous because the response carries " + linkHeaderMatches + " " + expression.header + " header fields (OAS Runtime Expressions)");',
    '      if (linkHeaderMatches === 1) assertLinkTarget(expression, linkHeaderValue, "$response.header." + expression.header, true);',
    '      return;',
    '    }',
    '    if (expression.kind === "body") { if (!linkBodyParsed) { linkBodyParsed = true; try { linkBody = JSON.parse(responseText()); } catch (error) { linkBody = null; } } if (linkBody === null) { pm.expect.fail("OpenAPI link " + expression.link + " references the response body but the body is not JSON"); return; } assertLinkTarget(expression, linkPointer(linkBody, expression.pointer), "$response.body#" + expression.pointer, false); return; }',
    '    if (expression.kind === "requestBody") { if (!requestBodyParsed) { requestBodyParsed = true; try { requestBody = pm.request.body && typeof pm.request.body.raw === "string" ? JSON.parse(pm.request.body.raw) : null; } catch (error) { requestBody = null; } } if (requestBody === null) { pm.expect.fail("OpenAPI link " + expression.link + " references the request body but the body is not JSON"); return; } assertLinkTarget(expression, linkPointer(requestBody, expression.pointer), "$request.body#" + expression.pointer, false); return; }',
    '    if (expression.kind === "requestHeader") { var requestHeaderMatches = 0; var requestHeaderValue = null; pm.request.headers.each(function (headerField) { if (headerField && headerField.disabled !== true && String(headerField.key).toLowerCase() === String(expression.header).toLowerCase()) { requestHeaderMatches += 1; requestHeaderValue = String(headerField.value); } }); if (requestHeaderMatches === 0) pm.expect.fail("OpenAPI link " + expression.link + " references request header " + expression.header + " which is absent"); else if (requestHeaderMatches > 1) pm.expect.fail("OpenAPI link " + expression.link + " expression $request.header." + expression.header + " is ambiguous because the request carries " + requestHeaderMatches + " " + expression.header + " header fields (OAS Runtime Expressions)"); else assertLinkTarget(expression, requestHeaderValue, "$request.header." + expression.header, true); return; }',
    '    if (expression.kind === "requestQuery") { var queryMatches = 0; var queryValue = null; pm.request.url.query.each(function (queryParam) { if (queryParam && queryParam.disabled !== true && String(queryParam.key) === String(expression.query)) { queryMatches += 1; queryValue = queryParam.value === null || queryParam.value === undefined ? "" : String(queryParam.value); } }); if (queryMatches === 0) pm.expect.fail("OpenAPI link " + expression.link + " references request query parameter " + expression.query + " which is absent"); else if (queryMatches > 1) pm.expect.fail("OpenAPI link " + expression.link + " expression $request.query." + expression.query + " is ambiguous because the request carries " + queryMatches + " " + expression.query + " query values (OAS Runtime Expressions)"); else assertLinkTarget(expression, decodeComponent(queryValue), "$request.query." + expression.query, true); return; }',
    '    if (expression.kind === "requestPath") assertLinkTarget(expression, requestPathParamValue(expression.path), "$request.path." + expression.path, true);',
    '  });',
    '});',
    'pm.test(\'Response body does not leak writeOnly properties\', function () {',
    '  if (!selected || !selected.value || !selected.value.writeOnlyProperties || selected.value.writeOnlyProperties.length === 0) return;',
    '  var writeOnlyBody = null;',
    '  try { writeOnlyBody = JSON.parse(responseText()); } catch (error) { return; }',
    '  if (!writeOnlyBody || typeof writeOnlyBody !== "object" || Array.isArray(writeOnlyBody)) return;',
    '  selected.value.writeOnlyProperties.forEach(function (property) {',
    '    if (Object.prototype.hasOwnProperty.call(writeOnlyBody, property)) pm.expect.fail("OpenAPI marks response property " + property + " as writeOnly, but the response body includes it (OAS Schema Object writeOnly)");',
    '  });',
    '});',
    'pm.test(\'OpenAPI callback targets resolve to concrete URI-references\', function () {',
    '  if (!contract.callbacks || contract.callbacks.length === 0) return;',
    '  var declared = contract.callbackRequestSources || { path: [], query: [], header: [] };',
    '  var callbackRequestBodyParsed = false;',
    '  var callbackRequestBodyInvalid = false;',
    '  var callbackRequestBody = null;',
    '  var callbackResponseBodyParsed = false;',
    '  var callbackResponseBody = null;',
    '  function resolveJsonPointer(target, pointer) { var value = target; var tokens = String(pointer || "").split("/").slice(1).map(function (token) { return token.replace(/~1/g, "/").replace(/~0/g, "~"); }); for (var i = 0; i < tokens.length; i += 1) { if (value !== null && typeof value === "object") value = Array.isArray(value) ? value[Number(tokens[i])] : value[tokens[i]]; else return undefined; } return value; }',
    '  function requestBodyJson() { if (!callbackRequestBodyParsed) { callbackRequestBodyParsed = true; var body = pm.request.body; var raw = body && body.mode === "raw" && typeof body.raw === "string" ? body.raw : ""; if (!raw.trim()) { callbackRequestBody = null; callbackRequestBodyInvalid = false; } else { try { callbackRequestBody = JSON.parse(raw); } catch (error) { callbackRequestBody = null; callbackRequestBodyInvalid = true; } } } return callbackRequestBody; }',
    '  function responseBodyJson() { if (!callbackResponseBodyParsed) { callbackResponseBodyParsed = true; try { callbackResponseBody = JSON.parse(responseText()); } catch (error) { callbackResponseBody = null; } } return callbackResponseBody; }',
    '  function scalarCallbackValue(value, label) { if (value === undefined || value === null) pm.expect.fail("OpenAPI callback " + label + " did not resolve to a concrete value"); if (typeof value === "object") return JSON.stringify(value); var text = String(value); if (!text || isPlaceholderValue(text) || text.charAt(0) === ":" || text.charAt(0) === "{") pm.expect.fail("OpenAPI callback " + label + " did not resolve to a concrete value"); return text; }',
    '  function resolveCallbackExpression(expression, label) {',
    '    if (expression === "$method") return { supported: true, value: contract.method };',
    '    if (expression === "$statusCode") return { supported: true, value: String(pm.response.code) };',
    '    if (expression === "$url") { var requestUrl = ""; try { requestUrl = typeof pm.request.url.toString === "function" ? String(pm.request.url.toString() || "") : ""; } catch (ignored) {} if (!requestUrl && typeof pm.request.url.raw === "string") requestUrl = String(pm.request.url.raw); if (!requestUrl) { var path = pm.request.url.path; requestUrl = Array.isArray(path) ? "/" + path.join("/") : String(path || ""); } return { supported: true, value: scalarCallbackValue(requestUrl, label) }; }',
    '    var requestPath = expression.match(/^\\$request\\.path\\.(.+)$/);',
    '    if (requestPath) { if (declared.path.indexOf(requestPath[1]) === -1) pm.expect.fail("OpenAPI callback " + label + " references undeclared request path parameter " + requestPath[1]); return { supported: true, value: scalarCallbackValue(requestPathParamValue(requestPath[1]), label) }; }',
    '    var requestQuery = expression.match(/^\\$request\\.query\\.(.+)$/);',
    '    if (requestQuery) { var queryName = requestQuery[1].toLowerCase(); if (declared.query.indexOf(queryName) === -1) pm.expect.fail("OpenAPI callback " + label + " references undeclared request query parameter " + requestQuery[1]); return { supported: true, value: scalarCallbackValue(requestQueryValue(queryName), label) }; }',
    '    var requestHeaderMatch = expression.match(/^\\$request\\.header\\.(.+)$/);',
    '    if (requestHeaderMatch) { var headerName = requestHeaderMatch[1]; if (declared.header.indexOf(headerName.toLowerCase()) === -1) pm.expect.fail("OpenAPI callback " + label + " references undeclared request header parameter " + headerName); return { supported: true, value: scalarCallbackValue(visibleRequestHeader(headerName), label) }; }',
    '    var requestBodyMatch = expression.match(/^\\$request\\.body#(\\/.*)$/);',
    '    if (requestBodyMatch) { var requestBody = requestBodyJson(); if (callbackRequestBodyInvalid || requestBody === null) pm.expect.fail("OpenAPI callback " + label + " references the request body but the request body is not JSON"); return { supported: true, value: scalarCallbackValue(resolveJsonPointer(requestBody, requestBodyMatch[1]), label) }; }',
    '    var responseHeaderMatch = expression.match(/^\\$response\\.header\\.([!#$%&\'*+.^_`|~0-9A-Za-z-]+)$/);',
    '    if (responseHeaderMatch) return { supported: true, value: scalarCallbackValue(pm.response.headers.get(responseHeaderMatch[1]), label) };',
    '    var responseBodyMatch = expression.match(/^\\$response\\.body#(\\/.*)$/);',
    '    if (responseBodyMatch) { var responseBody = responseBodyJson(); if (responseBody === null) pm.expect.fail("OpenAPI callback " + label + " references the response body but the body is not JSON"); return { supported: true, value: scalarCallbackValue(resolveJsonPointer(responseBody, responseBodyMatch[1]), label) }; }',
    '    return { supported: false };',
    '  }',
    '  function expandCallbackTarget(rawExpression, callbackName) { var source = String(rawExpression || ""); if (!source) return { supported: false }; if (source.indexOf("{{") !== -1) return { supported: false }; if (source.charAt(0) === "$") return resolveCallbackExpression(source, callbackName + " (" + source + ")"); var pieces = []; var lastIndex = 0; var supported = false; var match; var placeholders = /\\{([^{}]+)\\}/g; while ((match = placeholders.exec(source))) { pieces.push(source.slice(lastIndex, match.index)); var resolved = resolveCallbackExpression(match[1], callbackName + " (" + source + ")"); if (!resolved.supported) return { supported: false }; pieces.push(resolved.value); supported = true; lastIndex = match.index + match[0].length; } if (!supported && lastIndex === 0) return { supported: true, value: source }; pieces.push(source.slice(lastIndex)); return supported ? { supported: true, value: pieces.join("") } : { supported: false }; }',
    '  function isUriReference(value) { var text = String(value || ""); if (!text.trim() || /\\s/.test(text) || text.indexOf("{{") !== -1) return false; try { new URL(text, "https://callback.invalid"); return true; } catch (error) { return false; } }',
    '  contract.callbacks.forEach(function (callbackExpression) {',
    '    var resolved = expandCallbackTarget(callbackExpression.expression, callbackExpression.callback);',
    '    if (!resolved.supported) return;',
    '    if (!isUriReference(resolved.value)) pm.expect.fail("OpenAPI callback " + callbackExpression.callback + " expression " + callbackExpression.expression + " did not resolve to a valid URI-reference: " + resolved.value);',
    '  });',
    '});',
    'pm.test(\'Request URL conforms to an OpenAPI servers entry\', function () {',
    '  if (!contract.servers || contract.servers.length === 0) return;',
    '  var requestUrl = "";',
    '  try { requestUrl = String(pm.request.url.toString()); } catch (ignored) { requestUrl = ""; }',
    '  if (!requestUrl || requestUrl.indexOf("{{") !== -1) return;',
    '  var pathOnly = requestUrl.replace(/^[a-z][a-z0-9+.-]*:\\/\\/[^\\/]+/i, "");',
    '  var matched = contract.servers.some(function (pattern) { try { var serverPattern = new RegExp(pattern, "i"); return serverPattern.test(requestUrl) || serverPattern.test(pathOnly); } catch (ignored) { return true; } });',
    '  if (!matched) rfcAdvise("Request URL does not match any OpenAPI servers entry: " + requestUrl);',
    '});',
    ...(operation.security ? [
      "pm.test('Request carries credentials required by OpenAPI security', function () {",
      '  function satisfied(check) {',
      '    if (!check.checkable) return true;',
      '    if (check.in === "query") return hasQueryParam(check.name);',
      '    if (check.in === "cookie") { if (pm.cookies && pm.cookies.has && pm.cookies.has(String(check.name))) return true; return requestHeader("Cookie").split(";").some(function (part) { return part.split("=")[0].trim() === String(check.name); }); }',
      '    if (check.prefix) { return requestHeader("Authorization").toLowerCase().indexOf(check.prefix.toLowerCase()) === 0; }',
      '    if (check.kind === "oauth2" || check.kind === "openIdConnect") { return Boolean(requestHeader("Authorization")) || hasQueryParam("access_token"); }',
      '    return Boolean(requestHeader(check.name));',
      '  }',
      '  var alternatives = contract.security || [];',
      '  var ok = alternatives.some(function (alternative) { return alternative.every(function (check) { return satisfied(check); }); });',
      '  if (!ok) pm.expect.fail("Request did not carry credentials for any OpenAPI security requirement of " + contract.method + " " + contract.path + ": " + alternatives.map(function (alternative) { return alternative.map(function (check) { return check.scheme + " (" + check.kind + ")"; }).join(" + "); }).join(" | "));',
      '});'
    ] : []),
    ...(operation.parameterChecks && operation.parameterChecks.length > 0 ? [
      "pm.test('Request parameters match OpenAPI schemas', function () {",
      '  function queryValue(name) { var value; pm.request.url.query.each(function (param) { if (param && param.disabled !== true && String(param.key).toLowerCase() === name) value = param.value === null || param.value === undefined ? "" : String(param.value); }); return value; }',
      '  function queryValues(name) { var values = []; pm.request.url.query.each(function (param) { if (param && param.disabled !== true && String(param.key).toLowerCase() === name) values.push(param.value === null || param.value === undefined ? "" : String(param.value)); }); return values; }',
      '  function headerValue(name) { var value; pm.request.headers.each(function (header) { if (header && header.disabled !== true && String(header.key).toLowerCase() === String(name).toLowerCase()) value = header.value === null || header.value === undefined ? "" : String(header.value); }); return value; }',
      '  function cookieValue(name) { try { if (pm.cookies && pm.cookies.get) { var jar = pm.cookies.get(String(name)); if (jar !== null && jar !== undefined) return String(jar); } } catch (ignored) {} var raw = requestHeader("Cookie"); if (!raw) return undefined; var found; raw.split(";").forEach(function (part) { var split = part.indexOf("="); if (split === -1) return; if (part.slice(0, split).trim() === String(name)) found = part.slice(split + 1).trim(); }); return found; }',
      '  function requestPathSegments() { var raw = ""; try { raw = typeof pm.request.url.getPath === "function" ? String(pm.request.url.getPath() || "") : ""; } catch (ignored) {} if (!raw) { var path = pm.request.url.path; raw = Array.isArray(path) ? "/" + path.join("/") : String(path || ""); } return raw.split("?")[0].split("#")[0].split("/").filter(function (segment) { return segment.length > 0; }); }',
      // Server path prefixes sit ahead of the template segments, so the
      // template aligns against the trailing request segments.
      '  function pathParamValue(name) { var template = String(contract.path).split("/").filter(function (segment) { return segment.length > 0; }); var actual = requestPathSegments(); var offset = actual.length - template.length; if (offset < 0) return undefined; var token = "{" + name + "}"; for (var i = 0; i < template.length; i += 1) { var seg = template[i]; var actualSeg = actual[offset + i]; if (actualSeg === undefined) continue; if (seg === token) { try { return decodeURIComponent(actualSeg); } catch (ignored) { return actualSeg; } } if (seg.indexOf(token) === -1) continue; var chunks = [], j = 0, bad = false; while (j < seg.length) { if (seg.charAt(j) === "{") { var close = seg.indexOf("}", j); if (close === -1) { bad = true; break; } chunks.push({ p: seg.slice(j + 1, close) }); j = close + 1; } else { var nb = seg.indexOf("{", j); var lit = nb === -1 ? seg.slice(j) : seg.slice(j, nb); chunks.push({ l: lit }); j = nb === -1 ? seg.length : nb; } } if (bad) return undefined; var pos = 0, found, ok = true; for (var c = 0; c < chunks.length; c += 1) { var ch = chunks[c]; if (ch.l !== undefined) { if (actualSeg.indexOf(ch.l, pos) === pos) pos += ch.l.length; else { ok = false; break; } } else { var nextLit = (chunks[c + 1] && chunks[c + 1].l !== undefined) ? chunks[c + 1].l : undefined; var isLast = c === chunks.length - 1; var end; if (isLast) { end = actualSeg.length; } else if (nextLit === undefined) { ok = false; break; } else { var idx = actualSeg.indexOf(nextLit, pos + 1); if (idx === -1) { ok = false; break; } end = idx; } if (end <= pos) { ok = false; break; } if (ch.p === name) found = actualSeg.slice(pos, end); pos = end; } } if (ok && pos === actualSeg.length && found !== undefined) { try { return decodeURIComponent(found); } catch (ignored) { return found; } } } return undefined; }',
      '  function isPlaceholder(value) { var text = String(value).trim(); return /^<[^<>]*>$/.test(text) || text.indexOf("{{") !== -1; }',
      '  function splitDelimited(value, decode) { if (decode === "csv") return value.split(","); if (decode === "ssv") return value.split(/%20| /); return value.split(/%7C|\\|/i); }',
      '  function decodeComponent(value) { try { return decodeURIComponent(value); } catch (ignored) { return value; } }',
      '  (contract.parameters || []).forEach(function (param) {',
      '    var key = param.in + ":" + String(param.name).toLowerCase();',
      '    var validate = paramValidators[key];',
      '    if (!validate || validate.skip) return;',
      '    var value;',
      '    if (param.decode === "multi") {',
      '      var entries = queryValues(String(param.name).toLowerCase());',
      '      if (entries.length === 0) { if (param.required) pm.expect.fail("Required parameter " + param.in + ":" + param.name + " was not sent for " + contract.method + " " + contract.path); return; }',
      '      if (param.allowEmptyValue && entries.length === 1 && entries[0] === "") return;',
      '      if (entries.some(isPlaceholder)) return;',
      '      value = entries.map(function (entry) { return coerceBySchema(decodeComponent(entry), param.items); });',
      '    } else if (param.decode === "deepObject") {',
      '      var deepValue = {}; var deepFound = false; var deepPlaceholder = false;',
      '      pm.request.url.query.each(function (queryParam) { if (!queryParam || queryParam.disabled === true) return; var deepMatch = String(queryParam.key).match(/^([^\\[]+)\\[([^\\]]+)\\]$/); if (!deepMatch || deepMatch[1].toLowerCase() !== String(param.name).toLowerCase()) return; deepFound = true; var deepRaw = queryParam.value === null || queryParam.value === undefined ? "" : String(queryParam.value); if (isPlaceholder(deepRaw)) { deepPlaceholder = true; return; } deepValue[deepMatch[2]] = coerceBySchema(decodeComponent(deepRaw), (param.schema && param.schema.properties && param.schema.properties[deepMatch[2]]) || {}); });',
      '      if (!deepFound) { if (param.required) pm.expect.fail("Required parameter " + param.in + ":" + param.name + " was not sent for " + contract.method + " " + contract.path); return; }',
      '      if (deepPlaceholder) return;',
      '      value = deepValue;',
      '    } else if (param.decode) {',
      '      var joined = param.in === "query" ? queryValue(String(param.name).toLowerCase()) : headerValue(param.name);',
      '      if (joined === undefined) { if (param.required) pm.expect.fail("Required parameter " + param.in + ":" + param.name + " was not sent for " + contract.method + " " + contract.path); return; }',
      '      if (joined === "" && param.allowEmptyValue) return;',
      '      if (isPlaceholder(joined)) return;',
      '      var parts = joined === "" ? [] : splitDelimited(String(joined), param.decode);',
      // HTTP header lists allow optional whitespace after the comma, so
      // header-sourced items are trimmed; query values stay literal.
      '      if (param.in === "header") parts = parts.map(function (entry) { return entry.trim(); });',
      '      if (parts.some(isPlaceholder)) return;',
      // Query values arrive percent-encoded while the server validates the
      // decoded form; header values are never percent-encoded.
      '      value = parts.map(function (entry) { return coerceBySchema(param.in === "query" ? decodeComponent(entry) : entry, param.items); });',
      '    } else if (param.in === "path") {',
      '      value = pathParamValue(param.name);',
      '      if (value === undefined) return;',
      '      if (param.pathStyle === "label") { if (String(value).charAt(0) !== ".") return; value = String(value).slice(1); }',
      '      if (param.pathStyle === "matrix") { var matrixPrefix = ";" + param.name + "="; if (String(value).indexOf(matrixPrefix) !== 0) return; value = String(value).slice(matrixPrefix.length); }',
      '      if (isPlaceholder(value) || value.charAt(0) === ":" || value.charAt(0) === "{") return;',
      '      value = coerceBySchema(value, param.schema);',
      '    } else if (param.in === "cookie") {',
      '      value = cookieValue(param.name);',
      '      if (value === undefined) { if (param.required) pm.expect.fail("Required cookie parameter " + param.name + " was not sent for " + contract.method + " " + contract.path); return; }',
      '      if (isPlaceholder(value)) return;',
      '      value = coerceBySchema(value, param.schema);',
      '    } else {',
      '      value = param.in === "query" ? queryValue(String(param.name).toLowerCase()) : headerValue(param.name);',
      '      if (value === undefined) { if (param.required) pm.expect.fail("Required parameter " + param.in + ":" + param.name + " was not sent for " + contract.method + " " + contract.path); return; }',
      '      if (value === "" && param.allowEmptyValue) return;',
      '      if (isPlaceholder(value)) return;',
      '      if (param.content) {',
      '        var parsed;',
      '        try { parsed = JSON.parse(value); } catch (parseError) { pm.expect.fail("Parameter " + param.in + ":" + param.name + " declares JSON content but its value is not parseable JSON for " + contract.method + " " + contract.path); return; }',
      '        if (!validate(parsed)) pm.expect.fail("Parameter " + param.in + ":" + param.name + " failed OpenAPI schema validation for " + contract.method + " " + contract.path + ": " + JSON.stringify(validate.errors || []));',
      '        return;',
      '      }',
      '      value = coerceBySchema(value, param.schema);',
      '    }',
      '    if (!validate(value)) pm.expect.fail("Parameter " + param.in + ":" + param.name + " failed OpenAPI schema validation for " + contract.method + " " + contract.path + ": " + JSON.stringify(validate.errors || []));',
      '  });',
      '});'
    ] : []),
    ...(operation.parameterChecks && operation.parameterChecks.length > 0 ? [
      "pm.test('Request parameters use the OpenAPI-declared wire serialization', function () {",
      '  function isPh(v) { var t = String(v).trim(); return /^<[^<>]*>$/.test(t) || t.indexOf("{{") !== -1; }',
      '  var allMembers = []; pm.request.url.query.each(function (p) { if (!p || p.disabled === true) return; allMembers.push({ key: String(p.key), value: p.value === null || p.value === undefined ? "" : String(p.value) }); });',
      '  (contract.parameters || []).forEach(function (param) {',
      '    if (param.in === "query") {',
      '      var lname = String(param.name).toLowerCase();',
      '      var encodedBracketMembers = allMembers.filter(function (m) { return m.key.toLowerCase().indexOf(lname + "%5b") === 0 || m.key.toLowerCase().indexOf(lname + "%5B") === 0; });',
      '      var members = allMembers.filter(function (m) { var rawKey = m.key.replace(/%5B/ig, "[").replace(/%5D/ig, "]"); return rawKey.replace(/\\[[^\\]]*\\]$/, "").toLowerCase() === lname; });',
      '      if (members.length === 0) return;',
      '      if (members.some(function (m) { return isPh(m.value); })) return;',
      '      if (encodedBracketMembers.length > 0) pm.expect.fail("OpenAPI query parameter " + param.name + " serialized brackets must appear as raw [ and ], not percent-encoded %5B/%5D (OAS Parameter serialization): " + encodedBracketMembers[0].key);',
      '      if (param.decode === "deepObject") { members.forEach(function (m) { if (!/^[^\\[]+\\[[^\\]]+\\]$/.test(m.key)) pm.expect.fail("OpenAPI query parameter " + param.name + " declares deepObject style, so each member must be spelled " + param.name + "[property]=value (OAS Parameter serialization), but a member arrived as " + m.key); }); return; }',
      '      var bracketed = members.filter(function (m) { return /\\[[^\\]]*\\]$/.test(m.key); });',
      '      if (bracketed.length > 0) pm.expect.fail("OpenAPI query parameter " + param.name + " does not declare deepObject style but was serialized with bracket notation " + bracketed[0].key + " (OAS Parameter serialization)");',
      '      if (param.decode === "multi") { if (members.length === 1 && members[0].value.indexOf(",") !== -1) pm.expect.fail("OpenAPI query parameter " + param.name + " declares exploded form style (explode=true), so each array item must be its own " + param.name + "= pair, but the items were comma-joined into one value: " + members[0].value); return; }',
      '      if (param.decode === "csv") { if (members.length > 1) pm.expect.fail("OpenAPI query parameter " + param.name + " declares non-exploded form style (explode=false), so array items must be comma-joined into a single " + param.name + "= pair, but " + members.length + " pairs were sent"); if (/%2c/i.test(members[0].value)) pm.expect.fail("OpenAPI query parameter " + param.name + " declares comma-delimited form style, so delimiters must be literal commas, not %2C: " + members[0].value); return; }',
      '      if (param.decode === "ssv" || param.decode === "pipes") { var styleName = param.decode === "ssv" ? "spaceDelimited" : "pipeDelimited"; if (members.length > 1) pm.expect.fail("OpenAPI query parameter " + param.name + " declares " + styleName + " style, so array items must join into a single " + param.name + "= pair, but " + members.length + " pairs were sent"); var jv = members[0].value; if (jv.indexOf(",") !== -1) pm.expect.fail("OpenAPI query parameter " + param.name + " declares " + styleName + " style, so array items must be delimited by " + (param.decode === "ssv" ? "spaces" : "pipes (|)") + ", not commas: " + jv); if (param.decode === "ssv" && (jv.indexOf("+") !== -1 || /%20/i.test(jv))) pm.expect.fail("OpenAPI query parameter " + param.name + " declares spaceDelimited style, so array delimiters must be literal spaces, not + or %20: " + jv); if (param.decode === "pipes" && /%7c/i.test(jv)) pm.expect.fail("OpenAPI query parameter " + param.name + " declares pipeDelimited style, so delimiters must be literal |, not %7C: " + jv); if (param.decode === "pipes" && /\\s/.test(jv) && jv.indexOf("|") === -1) pm.expect.fail("OpenAPI query parameter " + param.name + " declares pipeDelimited style, so array items must be joined with |, but the value uses spaces: " + jv); return; }',
      '      return;',
      '    }',
      '    if (param.in === "header") {',
      '      var hv = requestHeader(param.name);',
      '      if (!hv || isPh(hv)) return;',
      '      if (/%[0-9A-Fa-f]{2}/.test(hv)) pm.expect.fail("OpenAPI header parameter " + param.name + " uses simple serialization, so values must not be URI percent-encoded: " + hv);',
      '      if (/^".*"$/.test(hv.trim())) pm.expect.fail("OpenAPI header parameter " + param.name + " uses simple serialization, so the serialized value must not be wrapped in quotes: " + hv);',
      '      return;',
      '    }',
      '    if (param.in === "path") {',
      '      var seg; try { seg = pathRawSegment(param.name); } catch (ignored) { seg = undefined; }',
      '      if (seg === undefined || seg === null || isPh(seg)) return;',
      '      if (param.pathStyle === "label") { if (String(seg).charAt(0) !== ".") pm.expect.fail("OpenAPI path parameter " + param.name + " declares label style, so its segment must begin with \'.\' (OAS Parameter serialization), but arrived as " + seg); return; }',
      '      if (param.pathStyle === "matrix") { if (String(seg).indexOf(";" + param.name + "=") !== 0) pm.expect.fail("OpenAPI path parameter " + param.name + " declares matrix style, so its segment must begin with \';" + param.name + "=\' (OAS Parameter serialization), but arrived as " + seg); return; }',
      '      return;',
      '    }',
      '  });',
      '});'
    ] : []),
    ...(operation.requestBody?.jsonSchemas && Object.keys(operation.requestBody.jsonSchemas).length > 0 ? [
      "pm.test('Request body matches OpenAPI request schema', function () {",
      '  var body = pm.request.body;',
      '  var raw = body && body.mode === "raw" && typeof body.raw === "string" ? body.raw : "";',
      '  if (!raw.trim()) return;',
      '  if (/"<[^"<>]*>"/.test(raw) || raw.indexOf("{{") !== -1) return;',
      '  var validate = requestBodyValidators[mediaBase(requestHeader("Content-Type"))];',
      '  if (!validate || validate.skip) return;',
      '  var parsed;',
      // Unquoted generator placeholders such as {"count": <long>} break
      // JSON.parse; a parse failure alongside an angle-bracket token is
      // treated as a placeholder body rather than drift.
      '  try { parsed = JSON.parse(raw); } catch (error) { if (/<[A-Za-z][A-Za-z0-9_ -]*>/.test(raw)) return; pm.expect.fail("Request body for " + contract.method + " " + contract.path + " is not valid JSON: " + error); return; }',
      '  if (!validate(parsed)) pm.expect.fail("Request body failed OpenAPI request schema validation for " + contract.method + " " + contract.path + ": " + JSON.stringify(validate.errors || []));',
      '});'
    ] : []),
    "pm.test('Content-Length is consistent with OpenAPI body expectations', function () {",
    '  var raw = pm.response.headers.get("Content-Length");',
    '  if (raw === null || raw === undefined) return;',
    // Combined duplicate Content-Length values ("5, 5") fail the integer
    // syntax check on purpose: RFC 9110 tolerates identical repeats, but a
    // contract test surfacing them is strict by design.
    '  if (!/^[0-9]+$/.test(String(raw).trim())) pm.expect.fail("Content-Length header is not a non-negative integer: " + raw);',
    '  if (pm.response.headers.get("Content-Encoding") || pm.response.headers.get("Transfer-Encoding")) return;',
    '  if (contract.method === "HEAD" || pm.response.code === 304) return;',
    '  var actualBytes = unescape(encodeURIComponent(responseText())).length;',
    '  if (Number(String(raw).trim()) !== actualBytes) pm.expect.fail("Content-Length must equal the response body byte length when Content-Encoding and Transfer-Encoding are absent (RFC 9110 8.6): " + raw + " !== " + actualBytes);',
    '  if (bodyExpectation === "forbidden" && Number(String(raw).trim()) !== 0) pm.expect.fail("HTTP semantics forbid a carried response body for " + contract.method + " " + contract.path + " status " + pm.response.code + " but Content-Length was " + raw);',
    '});',
    'pm.test(\'RFC SHOULD-level advisories are documented\', function () {',
    '  pm.expect(rfcAdvisories, "SHOULD-level findings (advisory, non-failing): " + rfcAdvisories.join("; ")).to.be.an("array");',
    '});'
  ];
}

export function createMappingFailureScript(message: string): string[] {
  return [`var contractMappingError = ${JSON.stringify(message)};`, "pm.test('OpenAPI operation mapping exists', function () {", '  pm.expect.fail(contractMappingError);', '});'];
}

function isResolverItem(item: JsonRecord): boolean {
  if (item.name !== '00 - Resolve Secrets') return false;
  const request = asRecord(item.request);
  if (String(request?.method || '').toUpperCase() !== 'POST') return false;
  const headers = asArray(request?.header).map((entry) => asRecord(entry));
  const target = headers.find((entry) => entry?.key === 'X-Amz-Target');
  return String(target?.value || '') === 'secretsmanager.GetSecretValue' && !requestPath(request).includes('secretsmanager');
}

function requestQueryNames(request: JsonRecord): Set<string> {
  const url = asRecord(request.url);
  const names = new Set<string>();
  if (Array.isArray(url?.query)) {
    for (const entry of url.query.map((item) => asRecord(item)).filter(Boolean)) {
      if (entry!.disabled !== true && typeof entry!.key === 'string') names.add(entry!.key.toLowerCase());
    }
  }
  if (typeof url?.raw === 'string') {
    try {
      const parsed = new URL(url.raw.replace(/^\{\{[^}]+\}\}/, 'https://placeholder.test'));
      parsed.searchParams.forEach((_value, key) => names.add(key.toLowerCase()));
    } catch {
      // ignore non-URL raw values
    }
  }
  return names;
}

function requestHeaderNames(request: JsonRecord): Set<string> {
  const names = new Set<string>();
  for (const entry of asArray(request.header).map((item) => asRecord(item)).filter(Boolean)) {
    if (entry!.disabled !== true && typeof entry!.key === 'string') names.add(entry!.key.toLowerCase());
  }
  return names;
}

function requestHeaderValue(request: JsonRecord, name: string): string | undefined {
  const match = asArray(request.header)
    .map((item) => asRecord(item))
    .filter(Boolean)
    .find((entry) => String(entry!.key || '').toLowerCase() === name.toLowerCase() && entry!.disabled !== true);
  return typeof match?.value === 'string' ? match.value : undefined;
}

function hasRequestBody(request: JsonRecord): boolean {
  const body = asRecord(request.body);
  if (!body) return false;
  if (typeof body.raw === 'string' && body.raw.trim()) return true;
  return ['urlencoded', 'formdata', 'graphql'].some((key) => Array.isArray(body[key]) ? (body[key] as unknown[]).length > 0 : Boolean(body[key]));
}

function assertStaticRequestShape(operation: ContractOperation, request: JsonRecord): string[] {
  const queryNames = requestQueryNames(request);
  const headerNames = requestHeaderNames(request);
  for (const parameter of operation.requiredParameters) {
    if (parameter.securityDerived) continue;
    if (parameter.in === 'query' && !queryNames.has(parameter.name.toLowerCase())) {
      throw new Error(`CONTRACT_STATIC_REQUEST_CHECK_FAILED: ${operation.id} missing required query parameter ${parameter.name}`);
    }
    if (parameter.in === 'header' && !headerNames.has(parameter.name.toLowerCase())) {
      throw new Error(`CONTRACT_STATIC_REQUEST_CHECK_FAILED: ${operation.id} missing required header ${parameter.name}`);
    }
  }
  if (operation.requestBody?.required && !hasRequestBody(request)) {
    throw new Error(`CONTRACT_STATIC_REQUEST_CHECK_FAILED: ${operation.id} missing required requestBody`);
  }
  const contentType = requestHeaderValue(request, 'Content-Type');
  if (operation.requestBody?.required && operation.requestBody.contentTypes.length > 0) {
    if (!contentType) {
      throw new Error(`CONTRACT_STATIC_REQUEST_CHECK_FAILED: ${operation.id} missing required request Content-Type`);
    }
    // Spec content keys are media types or ranges and may carry parameters,
    // so the comparison strips parameters on both sides and honors wildcards.
    const actual = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
    const matches = operation.requestBody.contentTypes.some((expected) => mediaTypeMatchesPattern(expected.toLowerCase(), actual));
    if (!matches) {
      throw new Error(
        `CONTRACT_STATIC_REQUEST_CHECK_FAILED: ${operation.id} request Content-Type ${contentType} does not match ${operation.requestBody.contentTypes.join(', ')}`
      );
    }
  }
  const warnings = collectStaticBodyWarnings(operation, request, contentType);
  // RFC 9110 defines no semantics for content on GET/HEAD/DELETE, so a
  // generator-attached body is flagged rather than silently exercised.
  if (['GET', 'HEAD', 'DELETE'].includes(operation.method) && hasRequestBody(request)) {
    warnings.push(`CONTRACT_METHOD_BODY_SEMANTICS: ${operation.id} sends a request body with ${operation.method}; RFC 9110 defines no request-body semantics for this method`);
  }
  // An optional request body still constrains the Content-Type of a body the
  // generator chose to send; a mismatch is a warning rather than a failure
  // because omitting the body entirely would have been legal.
  if (operation.requestBody && !operation.requestBody.required && operation.requestBody.contentTypes.length > 0 && hasRequestBody(request) && contentType) {
    const actual = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
    const matches = operation.requestBody.contentTypes.some((expected) => mediaTypeMatchesPattern(expected.toLowerCase(), actual));
    if (!matches) {
      warnings.push(
        `CONTRACT_STATIC_REQUEST_CHECK_FAILED: ${operation.id} optional request body Content-Type ${contentType} does not match ${operation.requestBody.contentTypes.join(', ')}`
      );
    }
  }
  return warnings;
}

function requestBodyFieldNames(request: JsonRecord, base: string): string[] | undefined {
  const body = asRecord(request.body);
  if (!body) return undefined;
  if (base === 'application/json' || /\+json$/.test(base)) {
    if (body.mode !== 'raw' || typeof body.raw !== 'string') return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.raw);
    } catch {
      // Generated bodies may carry Postman template variables that are not
      // valid JSON; structural checks are only possible for parseable bodies.
      return undefined;
    }
    const record = asRecord(parsed);
    return record ? Object.keys(record) : undefined;
  }
  const mode = base === 'application/x-www-form-urlencoded' ? 'urlencoded' : base === 'multipart/form-data' ? 'formdata' : '';
  if (!mode || !Array.isArray(body[mode])) return undefined;
  return (body[mode] as unknown[])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonRecord => Boolean(entry))
    .filter((entry) => entry.disabled !== true)
    .map((entry) => String(entry.key || ''))
    .filter(Boolean);
}

function requestBodyEntries(request: JsonRecord, base: string): JsonRecord[] | undefined {
  const body = asRecord(request.body);
  const mode = base === 'application/x-www-form-urlencoded' ? 'urlencoded' : base === 'multipart/form-data' ? 'formdata' : '';
  if (!body || !mode || !Array.isArray(body[mode])) return undefined;
  return (body[mode] as unknown[])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonRecord => Boolean(entry))
    .filter((entry) => entry.disabled !== true);
}

// Encoding contentType values may be comma-separated lists, may use type/*
// or */* wildcards, and may carry media-type parameters that the comparison
// strips on both sides.
function mediaTypeMatchesPattern(pattern: string, actual: string): boolean {
  return pattern.split(',').some((candidate) => {
    const entry = (candidate.split(';')[0] ?? '').trim();
    if (!entry) return false;
    if (entry === '*/*' || entry === actual) return true;
    if (entry.endsWith('/*')) return actual.startsWith(entry.slice(0, -1));
    return false;
  });
}

function isJsonEncodingContentType(declared: string): boolean {
  return declared.split(',').some((candidate) => {
    const entry = (candidate.split(';')[0] ?? '').trim();
    return entry === 'application/json' || entry.endsWith('+json');
  });
}

function isPlaceholderValue(value: string): boolean {
  return /^<[^>]*>$/.test(value.trim()) || value.includes('{{');
}

// Encoding Objects are checked against the generated artifact: a declared
// per-part contentType must appear on every matching multipart entry
// (duplicate keys are all checked), binary-typed fields must be generated as
// file parts, and fields declaring a JSON contentType must carry parseable
// JSON values in both multipart text parts and urlencoded entries.
// Wire-level multipart framing is owned by the Postman runtime and is not
// reconstructed here.
function collectStaticEncodingWarnings(operation: ContractOperation, request: JsonRecord, base: string, rule: ContractBodyFieldRules): string[] {
  const encodings = rule.encodings;
  if (!encodings) return [];
  const multipart = base === 'multipart/form-data';
  const entries = requestBodyEntries(request, base);
  if (!entries) return [];
  const warnings: string[] = [];
  const part = multipart ? 'multipart' : 'urlencoded';
  for (const [field, encoding] of Object.entries(encodings)) {
    for (const entry of entries.filter((candidate) => String(candidate.key || '') === field)) {
      if (multipart && encoding.binary && String(entry.type || '') !== 'file') {
        warnings.push(`CONTRACT_ENCODING_MISMATCH: ${operation.id} generated multipart field ${field} should be a file part per its binary schema`);
      }
      if (multipart && encoding.contentType) {
        const actual = typeof entry.contentType === 'string' ? (entry.contentType.toLowerCase().split(';')[0] ?? '').trim() : '';
        if (!actual) {
          warnings.push(
            `CONTRACT_ENCODING_MISMATCH: ${operation.id} generated multipart field ${field} does not declare Content-Type ${encoding.contentType} from its encoding object`
          );
        } else if (!mediaTypeMatchesPattern(encoding.contentType, actual)) {
          warnings.push(
            `CONTRACT_ENCODING_MISMATCH: ${operation.id} generated multipart field ${field} Content-Type ${actual} does not match declared encoding ${encoding.contentType}`
          );
        }
      }
      if (encoding.contentType && isJsonEncodingContentType(encoding.contentType) && String(entry.type || 'text') !== 'file') {
        const value = typeof entry.value === 'string' ? entry.value : '';
        if (value.trim() && !isPlaceholderValue(value)) {
          try {
            JSON.parse(value);
          } catch {
            warnings.push(
              `CONTRACT_ENCODING_MISMATCH: ${operation.id} generated ${part} field ${field} declares JSON encoding ${encoding.contentType} but its value is not parseable JSON`
            );
          }
        }
      }
    }
  }
  return warnings;
}

// Mirrors the runtime coerceBySchema semantics exactly, including type
// arrays from nullable schemas and the strict numeric form (no Infinity or
// hex), so static form-field findings match what the sandbox would compute.
function coerceFormValue(value: string, schema: unknown): unknown {
  const record = asRecord(schema);
  const type = record?.type;
  const types = Array.isArray(type) ? type : [type];
  if ((types.includes('integer') || types.includes('number')) && /^-?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$/.test(value.trim())) return Number(value);
  if (types.includes('boolean') && (value === 'true' || value === 'false')) return value === 'true';
  return value;
}

// Generated urlencoded and multipart text values are validated statically
// against their scalar property schemas; placeholder and file entries skip.
function collectStaticFieldSchemaWarnings(operation: ContractOperation, request: JsonRecord, base: string, rule: ContractBodyFieldRules): string[] {
  const fieldSchemas = rule.fieldSchemas;
  if (!fieldSchemas) return [];
  const entries = requestBodyEntries(request, base);
  if (!entries) return [];
  const part = base === 'multipart/form-data' ? 'multipart' : 'urlencoded';
  const warnings: string[] = [];
  for (const [field, schema] of Object.entries(fieldSchemas)) {
    const validate = compileSchemaValidator(schema);
    if (!validate) continue;
    for (const entry of entries.filter((candidate) => String(candidate.key || '') === field)) {
      if (String(entry.type || 'text') === 'file') continue;
      const value = typeof entry.value === 'string' ? entry.value : '';
      if (!value.trim() || isPlaceholderValue(value)) continue;
      if (!validate(coerceFormValue(value, schema))) {
        warnings.push(`CONTRACT_FORM_FIELD_SCHEMA_MISMATCH: ${operation.id} generated ${part} field ${field} value does not match its schema`);
      }
    }
  }
  return warnings;
}

// Body field findings are warnings rather than failures because generated
// bodies originate from spec example objects that are legally partial; a
// throw here would turn spec-legal partial examples into run-fatal errors.
function collectStaticBodyWarnings(operation: ContractOperation, request: JsonRecord, contentType: string | undefined): string[] {
  const rules = operation.requestBody?.fieldRules;
  if (!rules) return [];
  const base = (contentType || '').toLowerCase().split(';')[0]?.trim() ?? '';
  const rule = rules[base];
  if (!rule) return [];
  const warnings: string[] = [
    ...collectStaticEncodingWarnings(operation, request, base, rule),
    ...collectStaticFieldSchemaWarnings(operation, request, base, rule)
  ];
  const names = requestBodyFieldNames(request, base);
  if (!names) return warnings;
  const present = new Set(names);
  const missing = rule.required.filter((name) => !present.has(name));
  if (missing.length > 0) {
    warnings.push(`CONTRACT_REQUEST_BODY_INCOMPLETE: ${operation.id} generated request body is missing required properties: ${missing.join(', ')}`);
  }
  const readOnlySent = rule.readOnly.filter((name) => present.has(name));
  if (readOnlySent.length > 0) {
    warnings.push(`CONTRACT_READONLY_PROPERTY_IN_REQUEST: ${operation.id} generated request body includes readOnly properties: ${readOnlySent.join(', ')}`);
  }
  return warnings;
}

function validateScript(script: string[]): string | undefined {
  const source = script.join('\n');
  // Match executable call contexts only (`eval(` / `new Function(`), consistent
  // with the sibling guard in schema-validator-code.ts, so an OpenAPI spec that
  // carries the token `eval` as DATA (an enum value, path, or description embedded
  // via JSON.stringify) no longer trips a false CONTRACT_FORBIDDEN_SCRIPT_CONSTRUCT.
  if (source.includes('pm.response.to.have.jsonSchema') || /\beval\s*\(/.test(source) || /\bnew\s+Function\s*\(/.test(source)) {
    throw new Error('CONTRACT_FORBIDDEN_SCRIPT_CONSTRUCT: Generated contract script contains forbidden validation construct');
  }
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > CONTRACT_SIZE_LIMITS.maxTestScriptBytes) {
    throw new Error(
      `CONTRACT_SCRIPT_SIZE_EXCEEDED: Generated contract test script exceeded ${CONTRACT_SIZE_LIMITS.maxTestScriptBytes} bytes`
    );
  }
  if (bytes > CONTRACT_SIZE_LIMITS.warnTestScriptBytes) {
    return `Generated contract test script exceeded soft size limit ${CONTRACT_SIZE_LIMITS.warnTestScriptBytes} bytes (${bytes} bytes)`;
  }
  return undefined;
}

function scriptExecLines(script: unknown): string[] {
  const record = asRecord(script);
  if (!record) return [];
  if (Array.isArray(record.exec)) return record.exec.map((line) => String(line));
  if (typeof record.exec === 'string') return [record.exec];
  return [];
}

function scanExecutableScripts(node: JsonRecord, warnings: string[]): void {
  for (const event of asArray(node.event).map((entry) => asRecord(entry)).filter(Boolean)) {
    const lines = scriptExecLines(event!.script);
    if (lines.length === 0) continue;
    const warning = validateScript(lines);
    if (warning) warnings.push(warning);
  }
  for (const child of asArray(node.item)) {
    const childRecord = asRecord(child);
    if (childRecord) scanExecutableScripts(childRecord, warnings);
  }
}

export function instrumentContractCollection(
  collection: JsonRecord,
  index: ContractIndex,
  limits: ContractInstrumentationLimits = {}
): ContractInstrumentationResult {
  const maxCollectionUpdateBytes = limits.maxCollectionUpdateBytes ?? CONTRACT_SIZE_LIMITS.maxCollectionUpdateBytes;
  if (!Number.isSafeInteger(maxCollectionUpdateBytes) || maxCollectionUpdateBytes <= 0) {
    throw new Error('CONTRACT_COLLECTION_SIZE_EXCEEDED: Contract collection size limit must be a finite positive bounded integer');
  }
  const warnings = [...index.warnings, ...index.operations.flatMap((operation) => operation.warnings)];
  const covered = new Map<string, string>();

  const inject = (item: JsonRecord) => {
    if (isResolverItem(item)) return;
    if (item.request) {
      const request = asRecord(item.request) ?? {};
      const result = matchOperation(index, request);
      let script: string[];
      if (result.operation) {
        const previous = covered.get(result.operation.id);
        if (previous) throw new Error(`CONTRACT_DUPLICATE_OPERATION_REQUEST: ${result.operation.id} matched more than one generated request (${previous}, ${String(item.name || '<unnamed>')})`);
        warnings.push(...assertStaticRequestShape(result.operation, request));
        for (const name of [...requestQueryNames(request)].filter((entry) => !result.operation!.declaredQueryParameters.includes(entry))) {
          warnings.push(`CONTRACT_UNDOCUMENTED_QUERY_PARAM: ${result.operation.id} generated request sends query parameter ${name} that the OpenAPI operation does not declare`);
        }
        covered.set(result.operation.id, String(item.name || '<unnamed>'));
        script = createContractScript(result.operation, warnings);
      } else if (result.ambiguous && result.ambiguous.length > 0) {
        script = createMappingFailureScript(`Ambiguous OpenAPI operation match for request ${result.method} ${result.path}: ${result.ambiguous.map((entry) => entry.id).join(', ')}`);
      } else {
        script = createMappingFailureScript(`No OpenAPI operation matched request ${result.method} ${result.path}`);
      }
      const events = asArray(item.event).filter((entry) => asRecord(entry)?.listen !== 'test');
      item.event = [...events, { listen: 'test', script: { type: 'text/javascript', exec: script } }];
    }
    for (const child of asArray(item.item)) {
      const childRecord = asRecord(child);
      if (childRecord) inject(childRecord);
    }
  };

  const items = asArray(collection.item).map((entry) => asRecord(entry)).filter((entry): entry is JsonRecord => Boolean(entry)).filter((entry) => !isResolverItem(entry));
  collection.item = items;
  for (const item of items) inject(item);

  const missing = index.operations.filter((operation) => !covered.has(operation.id));
  if (missing.length > 0) {
    throw new Error(`CONTRACT_OPERATION_COVERAGE_FAILED: Contract collection is missing generated request coverage for ${missing.map((operation) => `${operation.id} (${operation.pointer})`).join(', ')}`);
  }
  (collection.item as JsonRecord[]).unshift(createSecretsResolverItem());
  scanExecutableScripts(collection, warnings);

  const bytes = Buffer.byteLength(JSON.stringify(collection), 'utf8');
  if (bytes > maxCollectionUpdateBytes) {
    throw new Error(`CONTRACT_COLLECTION_SIZE_EXCEEDED: Instrumented contract collection exceeded ${maxCollectionUpdateBytes} bytes`);
  }
  return { collection, warnings };
}

export interface ContractItemScript {
  itemId: string;
  exec: string[];
}

export interface ContractItemScriptPlan {
  scripts: ContractItemScript[];
  warnings: string[];
}

/**
 * Adapt a v3 IR `http-request` item (method/url/headers/body at the root) into
 * the request shape the contract matcher and static-shape checks read (v2-style
 * `method`, `url:{raw,query}`, `header:[{key,value}]`, `body:{mode,raw}`). No v2
 * collection is produced — this is an in-memory read adapter for a single item so
 * `matchOperation`/`assertStaticRequestShape` can run against the v3 surface.
 */
function v3ItemToContractRequest(item: JsonRecord): JsonRecord {
  const method = String(item.method ?? '');
  const urlRecord = asRecord(item.url);
  const rawUrl =
    typeof item.url === 'string'
      ? item.url
      : typeof urlRecord?.raw === 'string'
        ? String(urlRecord.raw)
        : '';
  const query: JsonRecord[] = [];
  const queryStart = rawUrl.indexOf('?');
  if (queryStart >= 0) {
    for (const pair of rawUrl.slice(queryStart + 1).split('&')) {
      if (!pair) continue;
      const rawKey = pair.split('=')[0] ?? '';
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey);
      } catch {
        // keep the raw key when it is not valid percent-encoding
      }
      if (key) query.push({ key });
    }
  }
  const header = asArray(item.headers)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonRecord => Boolean(entry))
    .map((entry) => ({
      key: entry.key,
      value: entry.value,
      ...(entry.disabled != null ? { disabled: entry.disabled } : {})
    }));
  const request: JsonRecord = { method, url: { raw: rawUrl, query }, header };
  const bodyRecord = asRecord(item.body);
  if (bodyRecord && typeof bodyRecord.content === 'string') {
    request.body = { mode: 'raw', raw: bodyRecord.content };
  }
  return request;
}

/**
 * v3-native contract instrumentation planner. Given the flat list of v3
 * `http-request` items (each paired with its item id) plus the contract index,
 * produce the per-item `afterResponse` test exec lines — the SAME assertions
 * {@link instrumentContractCollection} writes into a v2 `item.event`, but returned
 * for the caller to PATCH onto the v3 `/scripts` surface. Enforces the same
 * duplicate + coverage guarantees; no collection is read or written as v2.
 */
export function planContractItemScripts(
  items: Array<{ itemId: string; item: JsonRecord }>,
  index: ContractIndex
): ContractItemScriptPlan {
  const warnings = [...index.warnings, ...index.operations.flatMap((operation) => operation.warnings)];
  const covered = new Map<string, string>();
  const scripts: ContractItemScript[] = [];

  for (const { itemId, item } of items) {
    const name = String(item.name ?? item.title ?? '<unnamed>');
    const request = v3ItemToContractRequest(item);
    const result = matchOperation(index, request);
    let script: string[];
    if (result.operation) {
      const previous = covered.get(result.operation.id);
      if (previous) {
        throw new Error(
          `CONTRACT_DUPLICATE_OPERATION_REQUEST: ${result.operation.id} matched more than one generated request (${previous}, ${name})`
        );
      }
      // Static request-shape checks validate the generated request against the
      // spec. Over the v3 surface the request is reconstructed from the item IR,
      // so a check that cannot be evaluated degrades to a warning rather than a
      // hard failure (the runtime contract script remains the real validation).
      try {
        warnings.push(...assertStaticRequestShape(result.operation, request));
      } catch (error) {
        warnings.push(
          `CONTRACT_STATIC_REQUEST_CHECK_SKIPPED: ${result.operation.id} static request-shape check could not be evaluated over the v3 collection surface (${error instanceof Error ? error.message : String(error)})`
        );
      }
      for (const queryName of [...requestQueryNames(request)].filter(
        (entry) => !result.operation!.declaredQueryParameters.includes(entry)
      )) {
        warnings.push(
          `CONTRACT_UNDOCUMENTED_QUERY_PARAM: ${result.operation.id} generated request sends query parameter ${queryName} that the OpenAPI operation does not declare`
        );
      }
      covered.set(result.operation.id, name);
      script = createContractScript(result.operation, warnings);
    } else if (result.ambiguous && result.ambiguous.length > 0) {
      script = createMappingFailureScript(
        `Ambiguous OpenAPI operation match for request ${result.method} ${result.path}: ${result.ambiguous.map((entry) => entry.id).join(', ')}`
      );
    } else {
      script = createMappingFailureScript(`No OpenAPI operation matched request ${result.method} ${result.path}`);
    }
    const sizeWarning = validateScript(script);
    if (sizeWarning) warnings.push(sizeWarning);
    scripts.push({ itemId, exec: script });
  }

  const missing = index.operations.filter((operation) => !covered.has(operation.id));
  if (missing.length > 0) {
    throw new Error(
      `CONTRACT_OPERATION_COVERAGE_FAILED: Contract collection is missing generated request coverage for ${missing.map((operation) => `${operation.id} (${operation.pointer})`).join(', ')}`
    );
  }

  return { scripts, warnings };
}

export function contractMediaUsesSchema(media: ContractMedia): boolean {
  return media.schema !== undefined && !media.unsupported;
}

export function contractHeaderUsesSchema(header: ContractHeader): boolean {
  return header.schema !== undefined && !header.unsupported;
}

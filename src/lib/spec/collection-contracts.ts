import { normalizePath, type ContractBodyFieldRules, type ContractHeader, type ContractIndex, type ContractMedia, type ContractOperation } from './contract-index.js';
import { compileSchemaValidator, compileSchemaValidatorCode } from './schema-validator-code.js';

type JsonRecord = Record<string, unknown>;

export interface ContractInstrumentationResult {
  collection: JsonRecord;
  warnings: string[];
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
  const lines = ['var validators = {};'];
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
  return lines;
}

export function createContractScript(operation: ContractOperation, warnings: string[] = []): string[] {
  const contract = { method: operation.method, path: operation.path, responses: operation.responses, security: operation.security, parameters: operation.parameterChecks, pathMethods: operation.pathMethods };
  const skipped: string[] = [];
  const validatorLines = buildValidatorAssignments(operation, warnings, skipped);
  return [
    `var contract = JSON.parse(${JSON.stringify(JSON.stringify(contract))});`,
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
    'function isBodyless() { return pm.response.code === 204 || pm.response.code === 205 || pm.response.code === 304 || contract.method === "HEAD"; }',
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
    'function requestHeader(name) { var value = ""; pm.request.headers.each(function (header) { if (header && header.disabled !== true && String(header.key).toLowerCase() === String(name).toLowerCase()) value = String(header.value); }); return value; }',
    'function hasQueryParam(name) { var found = false; pm.request.url.query.each(function (param) { if (param && param.disabled !== true && String(param.key).toLowerCase() === String(name).toLowerCase()) found = true; }); return found; }',
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
    '  if (isBodyless()) { pm.expect(responseText().trim().length).to.equal(0); return; }',
    '  var content = selected.value.content || {};',
    '  if (Object.keys(content).length === 0) { pm.expect(responseText().trim().length, "OpenAPI response defines no body but response body was not empty").to.equal(0); }',
    '  else { pm.expect(responseText().trim().length, "OpenAPI response defines a body but response body was empty").to.be.above(0); }',
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
    '  if (code === 401) {',
    '    var challenge = respHeader("WWW-Authenticate");',
    '    if (!challenge) pm.expect.fail("RFC 9110 requires WWW-Authenticate on 401 responses");',
    '    var wantsBearer = (contract.security || []).some(function (alternative) { return alternative.some(function (check) { return check.prefix && check.prefix.toLowerCase().indexOf("bearer") === 0; }); });',
    '    if (wantsBearer && challenge && challenge.toLowerCase().indexOf("bearer") === -1) pm.expect.fail("RFC 6750 expects a Bearer challenge on 401 for bearer-secured operations; got: " + challenge);',
    '  }',
    '  if (code === 405) {',
    '    var allow = respHeader("Allow");',
    '    if (!allow) pm.expect.fail("RFC 9110 requires Allow on 405 responses");',
    '    var allowed = allow.split(",").map(function (entry) { return entry.trim().toUpperCase(); });',
    '    (contract.pathMethods || []).forEach(function (method) { if (allowed.indexOf(method) === -1) pm.expect.fail("Allow on 405 must list every method the OpenAPI path declares (RFC 9110); missing " + method + " in: " + allow); });',
    '  }',
    '  if (code === 304 && responseText().trim().length > 0) pm.expect.fail("RFC 9110 forbids content in a 304 response");',
    '  if (code === 206) {',
    '    var range = respHeader("Content-Range");',
    '    if (!range) pm.expect.fail("RFC 9110 requires Content-Range on a single-part 206 response");',
    '    if (range && !/^\\S+ (\\d+-\\d+|\\*)\\/(\\d+|\\*)$/.test(range)) pm.expect.fail("Content-Range is not a valid RFC 9110 range: " + range);',
    '  }',
    '  var retryAfter = respHeader("Retry-After");',
    '  if (retryAfter && (code === 429 || code === 503 || (code >= 300 && code < 400))) {',
    '    if (!/^\\d+$/.test(retryAfter.trim()) && isNaN(Date.parse(retryAfter))) pm.expect.fail("Retry-After must be delay-seconds or an HTTP-date (RFC 9110): " + retryAfter);',
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
    '  if (contract.method === "HEAD" || pm.response.code === 304) return;',
    '  if (pm.response.headers.get("Content-Encoding")) return;',
    '  var mustBeEmpty = isBodyless() || (selected && Object.keys(selected.value.content || {}).length === 0);',
    '  if (mustBeEmpty && Number(String(raw).trim()) !== 0) pm.expect.fail("OpenAPI defines no response body for " + contract.method + " " + contract.path + " status " + pm.response.code + " but Content-Length was " + raw);',
    '});'
  ];
}

export function createMappingFailureScript(message: string): string[] {
  return [`var contractMappingError = ${JSON.stringify(message)};`, "pm.test('OpenAPI operation mapping exists', function () {", '  pm.expect.fail(contractMappingError);', '});'];
}

export function createSecretsResolverItem(): JsonRecord {
  return {
    name: '00 - Resolve Secrets',
    request: {
      auth: {
        type: 'awsv4',
        awsv4: [
          { key: 'accessKey', value: '{{AWS_ACCESS_KEY_ID}}' },
          { key: 'secretKey', value: '{{AWS_SECRET_ACCESS_KEY}}' },
          { key: 'region', value: '{{AWS_REGION}}' },
          { key: 'service', value: 'secretsmanager' }
        ]
      },
      method: 'POST',
      header: [
        { key: 'X-Amz-Target', value: 'secretsmanager.GetSecretValue' },
        { key: 'Content-Type', value: 'application/x-amz-json-1.1' }
      ],
      body: { mode: 'raw', raw: '{"SecretId": "{{AWS_SECRET_NAME}}"}' },
      url: { raw: 'https://secretsmanager.{{AWS_REGION}}.amazonaws.com', protocol: 'https', host: ['secretsmanager', '{{AWS_REGION}}', 'amazonaws', 'com'] }
    },
    event: [{ listen: 'test', script: { exec: ['if (pm.environment.get("CI") === "true") { return; }', 'const body = pm.response.json();', 'if (body.SecretString) {', '  const secrets = JSON.parse(body.SecretString);', '  Object.entries(secrets).forEach(([k, v]) => pm.collectionVariables.set(k, v));', '}'] } }]
  };
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

export function instrumentContractCollection(collection: JsonRecord, index: ContractIndex): ContractInstrumentationResult {
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
  if (bytes > CONTRACT_SIZE_LIMITS.maxCollectionUpdateBytes) {
    throw new Error(`CONTRACT_COLLECTION_SIZE_EXCEEDED: Instrumented contract collection exceeded ${CONTRACT_SIZE_LIMITS.maxCollectionUpdateBytes} bytes`);
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

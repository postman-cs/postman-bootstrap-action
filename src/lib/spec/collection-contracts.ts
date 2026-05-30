import { normalizePath, type ContractHeader, type ContractIndex, type ContractMedia, type ContractOperation } from './contract-index.js';
import { compileSchemaValidatorCode } from './schema-validator-code.js';

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

function buildValidatorAssignments(operation: ContractOperation): string[] {
  const lines = ['var validators = {};'];
  for (const [status, response] of Object.entries(operation.responses)) {
    lines.push(`validators[${JSON.stringify(status)}] = validators[${JSON.stringify(status)}] || {};`);
    for (const [mediaType, media] of Object.entries(response.content)) {
      if (media.schema !== undefined && !media.unsupported) {
        assignValidator(lines, `validators[${JSON.stringify(status)}][${JSON.stringify(mediaType)}]`, compileSchemaValidatorCode(media.schema));
      }
    }
    for (const header of response.headers) {
      if (header.schema !== undefined && !header.unsupported) {
        lines.push(`validators[${JSON.stringify(status)}].__headers = validators[${JSON.stringify(status)}].__headers || {};`);
        assignValidator(lines, `validators[${JSON.stringify(status)}].__headers[${JSON.stringify(header.name.toLowerCase())}]`, compileSchemaValidatorCode(header.schema));
      }
    }
  }
  return lines;
}

export function createContractScript(operation: ContractOperation): string[] {
  const contract = { method: operation.method, path: operation.path, responses: operation.responses };
  return [
    `var contract = JSON.parse(${JSON.stringify(JSON.stringify(contract))});`,
    ...buildValidatorAssignments(operation),
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
    '    if (headerValidator && !headerValidator(actual)) pm.expect.fail("OpenAPI response header validation failed for " + header.name + ": " + JSON.stringify(headerValidator.errors || []));',
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
    '  if (!validate) pm.expect.fail("OpenAPI schema validator was not generated for " + media.expected);',
    '  var actual = mediaParts(pm.response.headers.get("Content-Type") || "");',
    '  var value = isJsonSubtype(actual.subtype) ? pm.response.json() : responseText();',
    '  if (!isJsonSubtype(actual.subtype) && media.media.schema && media.media.schema.type !== "string") pm.expect.fail("Non-JSON response schema validation unsupported for " + contract.method + " " + contract.path);',
    '  if (!validate(value)) pm.expect.fail("OpenAPI schema validation failed for " + contract.method + " " + contract.path + " status " + pm.response.code + ": " + JSON.stringify(validate.errors || []));',
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

function assertStaticRequestShape(operation: ContractOperation, request: JsonRecord): void {
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
    const actual = contentType.toLowerCase().split(';')[0]?.trim();
    const matches = operation.requestBody.contentTypes.some((expected) => expected.toLowerCase() === actual);
    if (!matches) {
      throw new Error(
        `CONTRACT_STATIC_REQUEST_CHECK_FAILED: ${operation.id} request Content-Type ${contentType} does not match ${operation.requestBody.contentTypes.join(', ')}`
      );
    }
  }
}

function validateScript(script: string[]): string | undefined {
  const source = script.join('\n');
  if (source.includes('pm.response.to.have.jsonSchema') || /\beval\b/.test(source) || /new\s+Function/.test(source)) {
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
        assertStaticRequestShape(result.operation, request);
        covered.set(result.operation.id, String(item.name || '<unnamed>'));
        script = createContractScript(result.operation);
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

export function contractMediaUsesSchema(media: ContractMedia): boolean {
  return media.schema !== undefined && !media.unsupported;
}

export function contractHeaderUsesSchema(header: ContractHeader): boolean {
  return header.schema !== undefined && !header.unsupported;
}

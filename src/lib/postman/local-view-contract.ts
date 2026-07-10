type JsonRecord = Record<string, unknown>;

const ROOT_FIELDS = new Set([
  '$kind',
  '$schema',
  'id',
  'name',
  'description',
  'auth',
  'variables',
  'scripts',
  'items'
]);
const FOLDER_FIELDS = new Set([
  '$kind',
  '$schema',
  'id',
  'name',
  'description',
  'order',
  'items'
]);
const HTTP_FIELDS = new Set([
  '$kind',
  '$schema',
  'id',
  'name',
  'description',
  'order',
  'method',
  'url',
  'headers',
  'queryParams',
  'pathVariables',
  'body',
  'auth',
  'settings',
  'scripts'
]);
const GRAPHQL_FIELDS = new Set([
  '$kind',
  '$schema',
  'id',
  'name',
  'description',
  'order',
  'query',
  'variables',
  'scripts'
]);
const SCRIPT_FIELDS = new Set(['type', 'code', 'language']);
const SCRIPT_TYPES = new Set(['beforeRequest', 'afterResponse']);

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function unsupported(label: string, message: string): never {
  throw new Error(`ADDITIONAL_COLLECTION_UNSUPPORTED: ${label} ${message}`);
}

function assertOptionalString(node: JsonRecord, field: string, label: string): void {
  if (node[field] !== undefined && typeof node[field] !== 'string') {
    unsupported(label, `${field} must be a string`);
  }
}

function assertOptionalArray(node: JsonRecord, field: string, label: string): void {
  if (node[field] !== undefined && !Array.isArray(node[field])) {
    unsupported(label, `${field} must be an array`);
  }
}

function assertOptionalRecord(node: JsonRecord, field: string, label: string): void {
  if (node[field] !== undefined && !asRecord(node[field])) {
    unsupported(label, `${field} must be an object`);
  }
}

function assertScripts(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    unsupported(label, 'scripts must contain inline script objects; path-valued scripts cannot be preserved');
  }
  value.forEach((entry, index) => {
    const script = asRecord(entry);
    if (!script) unsupported(label, `scripts[${index}] must be an inline script object`);
    for (const field of Object.keys(script)) {
      if (!SCRIPT_FIELDS.has(field)) unsupported(label, `script field ${field} cannot be preserved`);
    }
    if (!SCRIPT_TYPES.has(String(script.type ?? ''))) {
      unsupported(label, `script type ${String(script.type ?? '<missing>')} is unsupported`);
    }
    if (typeof script.code !== 'string') unsupported(label, `scripts[${index}].code must be a string`);
    assertOptionalString(script, 'language', `${label} scripts[${index}]`);
  });
}

function assertKnownFields(node: JsonRecord, allowed: Set<string>, label: string): void {
  for (const field of Object.keys(node)) {
    if (!allowed.has(field)) unsupported(label, `field ${field} cannot be preserved`);
  }
}

export function normalizeLocalViewScriptType(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.startsWith('http:') ? value.slice('http:'.length) : value;
}

export function assertSupportedLocalViewContract(
  node: JsonRecord,
  options: { isRoot?: boolean; displayPath: string }
): void {
  const label = options.displayPath;
  const isRoot = options.isRoot === true;
  const kind = String(node.$kind ?? '');

  if (isRoot && kind !== 'collection') unsupported(label, 'root $kind must be collection');
  if (!isRoot && kind !== 'collection' && kind !== 'http-request' && kind !== 'graphql-request') {
    unsupported(label, `$kind ${kind || '<missing>'} is unsupported`);
  }
  if (typeof node.name !== 'string' || !node.name.trim()) unsupported(label, 'name must be a non-empty string');
  assertOptionalString(node, '$schema', label);
  assertOptionalString(node, 'id', label);
  assertOptionalString(node, 'description', label);
  if (node.order !== undefined && (typeof node.order !== 'number' || !Number.isFinite(node.order))) {
    unsupported(label, 'order must be a finite number');
  }

  if (kind === 'collection') {
    assertKnownFields(node, isRoot ? ROOT_FIELDS : FOLDER_FIELDS, label);
    if (node.items !== undefined && !Array.isArray(node.items)) unsupported(label, 'items must be an array');
    if (isRoot) {
      assertOptionalRecord(node, 'auth', label);
      assertOptionalArray(node, 'variables', label);
      assertScripts(node.scripts, label);
    }
  } else if (kind === 'http-request') {
    assertKnownFields(node, HTTP_FIELDS, label);
    if (node.items !== undefined) unsupported(label, 'request leaves cannot contain items');
    if (typeof node.method !== 'string' || !node.method) unsupported(label, 'method must be a non-empty string');
    if (typeof node.url !== 'string' || !node.url) unsupported(label, 'url must be a non-empty string');
    assertOptionalArray(node, 'headers', label);
    assertOptionalArray(node, 'queryParams', label);
    assertOptionalArray(node, 'pathVariables', label);
    assertOptionalRecord(node, 'body', label);
    assertOptionalRecord(node, 'auth', label);
    assertOptionalRecord(node, 'settings', label);
    assertScripts(node.scripts, label);
  } else if (kind === 'graphql-request') {
    assertKnownFields(node, GRAPHQL_FIELDS, label);
    if (node.items !== undefined) unsupported(label, 'request leaves cannot contain items');
    if (typeof node.query !== 'string' || !node.query) unsupported(label, 'query must be a non-empty string');
    assertOptionalString(node, 'variables', label);
    assertScripts(node.scripts, label);
  }

  const children = Array.isArray(node.items) ? node.items : [];
  children.forEach((child, index) => {
    const childRecord = asRecord(child);
    if (!childRecord) unsupported(label, `items[${index}] must be an object`);
    const childName = typeof childRecord.name === 'string' ? childRecord.name : `items[${index}]`;
    assertSupportedLocalViewContract(childRecord, {
      isRoot: false,
      displayPath: `${label}/${childName}`
    });
  });
}

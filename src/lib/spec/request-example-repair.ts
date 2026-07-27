import { matchOperation } from './collection-contracts.js';
import type {
  ContractIndex,
  ContractOperation,
  ContractParameterCheck,
  ContractResponse
} from './contract-index.js';
import type { SchemaCandidateGenerator } from './deterministic-schema-faker.js';
import { parseOpenApiDocument } from './openapi-loader.js';
import { packSchema, resolvePointer, type OpenApiVersion, type SchemaDirection } from './schema-pack.js';
import { compileSchemaValidator } from './schema-validator-code.js';

type JsonRecord = Record<string, unknown>;
type SourcePath = Array<string | '*'>;

interface AuthoredValue {
  label: string;
  path: SourcePath;
  valid: boolean | null;
  value: unknown;
}

const FORMAT_EXAMPLES: Record<string, string[]> = {
  'date-time': ['2000-01-01T00:00:00Z'],
  date: ['2000-01-01'],
  duration: ['P1D'],
  email: ['a@b.co', 'user@example.com'],
  hostname: ['a.co', 'example.com'],
  ipv4: ['192.0.2.1'],
  ipv6: ['::1', '2001:db8::1'],
  'json-pointer': ['', '/'],
  regex: ['^$', 'a'],
  'relative-json-pointer': ['0'],
  time: ['00:00:00Z'],
  uri: ['https://a.co', 'https://example.com'],
  'uri-reference': ['', '/'],
  'uri-template': ['{id}'],
  uuid: ['00000000-0000-4000-8000-000000000000']
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone<T>(value: T): T {
  if (value === undefined) return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function restoreRecord(target: JsonRecord, snapshot: JsonRecord): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, snapshot);
}

function repairCause(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .trim();
}

function isInvalidAuthoredExample(error: unknown): boolean {
  return repairCause(error).includes('SOURCE_AUTHORED_EXAMPLE_SCHEMA_MISMATCH');
}

function repairExampleOrWarn(
  target: JsonRecord,
  context: string,
  warnings: string[],
  repair: () => void
): void {
  const snapshot = clone(target);
  try {
    repair();
  } catch (error) {
    if (isInvalidAuthoredExample(error)) throw error;
    restoreRecord(target, snapshot);
    warnings.push(
      `LOCAL_OPENAPI_EXAMPLE_REPAIR_SKIPPED: Preserved converter-generated ${context} ` +
        `without repair because repair could not be completed: ${repairCause(error)}`
    );
  }
}

function stableValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  return `{${Object.keys(value as JsonRecord).sort().map((key) => `${JSON.stringify(key)}:${stableValue((value as JsonRecord)[key])}`).join(',')}}`;
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableValue(left) === stableValue(right);
}

// The shipped bytes, not the live object. compileSchemaValidator runs with
// isJSON, which accepts in-memory undefined array holes; JSON.stringify then
// rewrites those holes to null, so only the serialized form is proof.
function serializedForm(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value === undefined ? null : value)) as unknown;
}

// True when serializing would change the value: undefined array holes become
// null on the wire. Such a value must go through repair even when the
// in-memory validator accepts it.
function hasSerializationHoles(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => entry === undefined || hasSerializationHoles(entry));
  if (isRecord(value)) return Object.values(value).some((entry) => hasSerializationHoles(entry));
  return false;
}

function schemaWithRootContext(schema: unknown, root: JsonRecord): unknown {
  if (!isRecord(schema)) return schema;
  const contextual: JsonRecord = { ...schema };
  if (typeof root.$schema === 'string' && contextual.$schema === undefined) contextual.$schema = root.$schema;
  if (isRecord(root.$defs) && contextual.$defs === undefined) contextual.$defs = root.$defs;
  return contextual;
}

function validates(schema: unknown, value: unknown, root: JsonRecord): boolean | null {
  const validate = compileSchemaValidator(schemaWithRootContext(schema, root));
  return validate ? validate(value) : null;
}

function resolvePackedRef(root: JsonRecord, ref: string): unknown {
  if (!ref.startsWith('#/$defs/')) return undefined;
  const name = ref.slice('#/$defs/'.length).replace(/~1/g, '/').replace(/~0/g, '~');
  return isRecord(root.$defs) ? root.$defs[name] : undefined;
}

function resolveSourceRecord(root: JsonRecord, raw: unknown): JsonRecord | null {
  const record = isRecord(raw) ? raw : null;
  if (!record) return null;
  if (typeof record.$ref !== 'string' || !record.$ref.startsWith('#/')) return record;
  return isRecord(resolvePointer(root, record.$ref)) ? resolvePointer(root, record.$ref) as JsonRecord : null;
}

function valueMatchesType(value: unknown, type: string): boolean {
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'null') return value === null;
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'object') return isRecord(value);
  return typeof value === type;
}

function inferredType(schema: JsonRecord, value: unknown, canonical: boolean): string | undefined {
  const declared = Array.isArray(schema.type)
    ? schema.type.filter((entry): entry is string => typeof entry === 'string')
    : typeof schema.type === 'string'
      ? [schema.type]
      : [];
  if (!canonical) {
    const matching = declared.find((type) => valueMatchesType(value, type));
    if (matching) return matching;
  }
  const nonNull = declared.find((type) => type !== 'null');
  if (nonNull) return nonNull;
  if (declared.includes('null')) return 'null';
  if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) return 'object';
  if (schema.items !== undefined || schema.prefixItems !== undefined || schema.minItems !== undefined || schema.maxItems !== undefined) return 'array';
  if (schema.minLength !== undefined || schema.maxLength !== undefined || schema.pattern !== undefined || schema.format !== undefined) return 'string';
  if (schema.minimum !== undefined || schema.maximum !== undefined || schema.exclusiveMinimum !== undefined || schema.exclusiveMaximum !== undefined || schema.multipleOf !== undefined) return 'number';
  return undefined;
}

function hasAlternativeShape(schema: unknown): boolean {
  const record = isRecord(schema) ? schema : null;
  return Boolean(
    record
    && ((Array.isArray(record.type) && record.type.length > 1) || Array.isArray(record.oneOf) || Array.isArray(record.anyOf))
  );
}

function containsAlternativeShape(schema: unknown, seen = new Set<unknown>(), depth = 0): boolean {
  if (depth > 30 || !isRecord(schema) || seen.has(schema)) return false;
  if (hasAlternativeShape(schema)) return true;
  seen.add(schema);
  const properties = isRecord(schema.properties) ? Object.values(schema.properties) : [];
  const children = [
    ...properties,
    schema.items,
    ...(Array.isArray(schema.allOf) ? schema.allOf : [])
  ];
  const found = children.some((child) => containsAlternativeShape(child, seen, depth + 1));
  seen.delete(schema);
  return found;
}

function pathMatches(pattern: SourcePath, actual: SourcePath): boolean {
  return pattern.length === actual.length && pattern.every((part, index) => part === '*' || part === actual[index]);
}

function valuesAtPath(value: unknown, path: SourcePath): unknown[] {
  if (path.length === 0) return [value];
  const [head, ...rest] = path;
  if (head === '*') {
    return Array.isArray(value) ? value.flatMap((entry) => valuesAtPath(entry, rest)) : [];
  }
  return isRecord(value) ? valuesAtPath(value[head], rest) : [];
}

class SourcePolicy {
  readonly #entries: AuthoredValue[];
  readonly #preserveAll: boolean;

  constructor(entries: AuthoredValue[], original: unknown, context: string) {
    this.#entries = entries;
    const invalid = entries.find((entry) => entry.valid === false && valuesAtPath(original, entry.path).some((value) => sameValue(value, entry.value)));
    if (invalid) {
      throw new Error(`SOURCE_AUTHORED_EXAMPLE_SCHEMA_MISMATCH: ${context} uses invalid ${invalid.label}`);
    }
    this.#preserveAll = entries.some((entry) => entry.path.length === 0 && entry.valid === true && sameValue(original, entry.value));
  }

  preserve(path: SourcePath, value: unknown): boolean {
    if (this.#preserveAll) return true;
    return this.#entries.some((entry) => entry.valid === true && pathMatches(entry.path, path) && sameValue(value, entry.value));
  }
}

function annotationValidity(
  root: JsonRecord,
  rawSchema: unknown,
  version: OpenApiVersion,
  direction: SchemaDirection,
  value: unknown
): boolean | null {
  const packed = packSchema(root, rawSchema, version, direction);
  if (packed.unsupported || packed.schema === undefined) return null;
  const validate = compileSchemaValidator(packed.schema);
  return validate ? validate(value) : null;
}

function collectSchemaAuthoredValues(
  root: JsonRecord,
  rawSchema: unknown,
  version: OpenApiVersion,
  direction: SchemaDirection,
  entries: AuthoredValue[],
  path: SourcePath,
  stack: Set<unknown>,
  depth: number
): void {
  if (depth > 30) return;
  const rawRecord = isRecord(rawSchema) ? rawSchema : null;
  const schema = resolveSourceRecord(root, rawSchema);
  if (!schema || stack.has(schema)) return;
  stack.add(schema);
  for (const [label, value] of [
    ['schema.example', schema.example],
    ['schema.default', schema.default]
  ] as const) {
    if (value !== undefined) entries.push({ label, path, value, valid: annotationValidity(root, schema, version, direction, value) });
  }
  if (Array.isArray(schema.examples)) {
    schema.examples.forEach((value, index) => {
      entries.push({ label: `schema.examples[${index}]`, path, value, valid: annotationValidity(root, schema, version, direction, value) });
    });
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [name, propertySchema] of Object.entries(properties)) {
    collectSchemaAuthoredValues(root, propertySchema, version, direction, entries, [...path, name], stack, depth + 1);
  }
  if (schema.items !== undefined && !Array.isArray(schema.items)) {
    collectSchemaAuthoredValues(root, schema.items, version, direction, entries, [...path, '*'], stack, depth + 1);
  }
  for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
    for (const member of Array.isArray(schema[key]) ? schema[key] : []) {
      collectSchemaAuthoredValues(root, member, version, direction, entries, path, stack, depth + 1);
    }
  }
  stack.delete(schema);
  if (rawRecord && rawRecord !== schema && Object.keys(rawRecord).some((key) => key !== '$ref')) {
    collectSchemaAuthoredValues(root, Object.fromEntries(Object.entries(rawRecord).filter(([key]) => key !== '$ref')), version, direction, entries, path, stack, depth + 1);
  }
}

function mediaAuthoredValues(
  root: JsonRecord,
  media: JsonRecord | null,
  rawSchema: unknown,
  packedSchema: unknown,
  version: OpenApiVersion,
  direction: SchemaDirection
): AuthoredValue[] {
  const entries: AuthoredValue[] = [];
  if (media && 'example' in media) {
    entries.push({
      label: 'media example',
      path: [],
      value: media.example,
      valid: validates(packedSchema, media.example, isRecord(packedSchema) ? packedSchema : {})
    });
  }
  const examples = isRecord(media?.examples) ? media.examples : {};
  for (const [name, rawExample] of Object.entries(examples)) {
    const example = resolveSourceRecord(root, rawExample);
    if (!example || !('value' in example)) continue;
    entries.push({
      label: `media examples.${name}`,
      path: [],
      value: example.value,
      valid: validates(packedSchema, example.value, isRecord(packedSchema) ? packedSchema : {})
    });
  }
  collectSchemaAuthoredValues(root, rawSchema, version, direction, entries, [], new Set(), 0);
  return entries;
}

function pruneDirectionalProperties(
  value: unknown,
  rawSchema: unknown,
  root: JsonRecord,
  direction: SchemaDirection,
  stack = new Set<unknown>(),
  depth = 0
): unknown {
  if (depth > 40) return value;
  const schema = resolveSourceRecord(root, rawSchema);
  if (!schema || stack.has(schema)) return value;
  stack.add(schema);
  let candidate = clone(value);
  if (isRecord(candidate)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(candidate, name)) continue;
      const property = resolveSourceRecord(root, propertySchema);
      const stripped = direction === 'request' ? property?.readOnly === true : property?.writeOnly === true;
      if (stripped) delete candidate[name];
      else candidate[name] = pruneDirectionalProperties(candidate[name], propertySchema, root, direction, stack, depth + 1);
    }
    if (isRecord(schema.additionalProperties)) {
      for (const name of Object.keys(candidate)) {
        if (!Object.prototype.hasOwnProperty.call(properties, name)) {
          candidate[name] = pruneDirectionalProperties(candidate[name], schema.additionalProperties, root, direction, stack, depth + 1);
        }
      }
    }
  } else if (Array.isArray(candidate) && schema.items !== undefined && !Array.isArray(schema.items)) {
    candidate = candidate.map((entry) => pruneDirectionalProperties(entry, schema.items, root, direction, stack, depth + 1));
  }
  for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
    for (const member of Array.isArray(schema[key]) ? schema[key] : []) {
      candidate = pruneDirectionalProperties(candidate, member, root, direction, stack, depth + 1);
    }
  }
  stack.delete(schema);
  return candidate;
}

class SchemaRepairer {
  readonly #candidate: SchemaCandidateGenerator;
  readonly #policy: SourcePolicy;

  constructor(candidate: SchemaCandidateGenerator, policy: SourcePolicy) {
    this.#candidate = candidate;
    this.#policy = policy;
  }

  repair(value: unknown, schema: unknown, root: JsonRecord, path: SourcePath = []): unknown {
    if (!isRecord(schema)) return value === undefined ? null : value;
    const canonical = hasAlternativeShape(schema) && !this.#policy.preserve(path, value);
    if (!canonical && !containsAlternativeShape(schema) && !hasSerializationHoles(value) && validates(schema, value, root) === true) return value;

    const repaired = this.#repairLocal(value, schema, root, path, canonical);
    if (validates(schema, repaired, root) === true) return repaired;

    const contextual = schemaWithRootContext(schema, root);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const generated = this.#candidate(clone(contextual), attempt);
        if (validates(schema, generated, root) === true) return generated;
      } catch {
        // A candidate failure is not terminal; bounded retries end in the
        // caller's full-schema fail-closed check.
      }
    }
    return repaired;
  }

  #repairLocal(value: unknown, schema: JsonRecord, root: JsonRecord, path: SourcePath, canonical: boolean): unknown {
    if (typeof schema.$ref === 'string') {
      const resolved = resolvePackedRef(root, schema.$ref);
      if (resolved !== undefined) return this.repair(value, resolved, root, path);
    }
    if (Object.prototype.hasOwnProperty.call(schema, 'const')) return clone(schema.const);
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      const valid = schema.enum.find((candidate) => validates(schema, candidate, root) === true);
      return clone(valid ?? schema.enum[0]);
    }

    if (Array.isArray(schema.allOf)) {
      let candidate = clone(value);
      for (const branch of schema.allOf) candidate = this.repair(candidate, branch, root, path);
      const siblings = Object.fromEntries(Object.entries(schema).filter(([key]) => !['allOf', '$schema', '$defs'].includes(key)));
      return Object.keys(siblings).length > 0 ? this.repair(candidate, siblings, root, path) : candidate;
    }
    const alternatives = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : null;
    if (alternatives) {
      const key = Array.isArray(schema.oneOf) ? 'oneOf' : 'anyOf';
      const siblings = Object.fromEntries(Object.entries(schema).filter(([name]) => ![key, '$schema', '$defs'].includes(name)));
      for (const branch of alternatives) {
        let candidate = this.repair(canonical ? undefined : clone(value), branch, root, path);
        if (Object.keys(siblings).length > 0) candidate = this.repair(candidate, siblings, root, path);
        if (validates(schema, candidate, root) === true) return candidate;
      }
    }

    const sourceValue = canonical ? undefined : value;
    const type = inferredType(schema, sourceValue, canonical);
    if (type === 'null') return null;
    if (type === 'string') return this.#repairString(sourceValue, schema, root);
    if (type === 'integer') return repairNumber(sourceValue, schema, true);
    if (type === 'number') return repairNumber(sourceValue, schema, false);
    if (type === 'boolean') return typeof sourceValue === 'boolean' ? sourceValue : false;
    if (type === 'array') return this.#repairArray(sourceValue, schema, root, path);
    if (type === 'object') return this.#repairObject(sourceValue, schema, root, path);
    return sourceValue === undefined ? null : sourceValue;
  }

  #repairString(value: unknown, schema: JsonRecord, root: JsonRecord): string {
    const formatCandidates = typeof schema.format === 'string' ? FORMAT_EXAMPLES[schema.format] ?? [] : [];
    for (const candidate of formatCandidates) {
      if (validates(schema, candidate, root) === true) return candidate;
    }
    let candidate = typeof value === 'string' ? value : '';
    const chars = [...candidate];
    if (typeof schema.maxLength === 'number' && chars.length > schema.maxLength) candidate = chars.slice(0, schema.maxLength).join('');
    if (typeof schema.minLength === 'number' && [...candidate].length < schema.minLength) {
      const fill = [...candidate].at(-1) ?? 'x';
      candidate += fill.repeat(schema.minLength - [...candidate].length);
    }
    return candidate;
  }

  #repairArray(value: unknown, schema: JsonRecord, root: JsonRecord, path: SourcePath): unknown[] {
    const candidate = Array.isArray(value) ? [...value] : [];
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    const itemSchema = schema.items;
    // contains/minContains are 2020-12-only. Without reading them the filler
    // schema degrades to {}, repair() returns undefined for an absent value,
    // and JSON.stringify later rewrites that hole to null - shipping a body the
    // source schema rejects. The contains schema is the correct filler.
    const containsSchema = isRecord(schema.contains) ? schema.contains : undefined;
    const minContains = containsSchema === undefined
      ? 0
      : typeof schema.minContains === 'number' ? schema.minContains : 1;
    if (typeof schema.maxItems === 'number' && candidate.length > schema.maxItems) candidate.length = schema.maxItems;
    const minItems = typeof schema.minItems === 'number' ? schema.minItems : 0;
    while (candidate.length < Math.max(minItems, minContains)) {
      const schemaForItem = prefix[candidate.length] ?? itemSchema ?? containsSchema ?? {};
      candidate.push(this.repair(undefined, schemaForItem, root, [...path, '*']));
    }
    for (let index = 0; index < candidate.length; index += 1) {
      const schemaForItem = prefix[index] ?? itemSchema;
      if (schemaForItem !== undefined) candidate[index] = this.repair(candidate[index], schemaForItem, root, [...path, '*']);
    }
    // Satisfy contains by repairing members against it until enough match.
    if (containsSchema !== undefined) {
      let matching = candidate.filter((entry) => validates(containsSchema, entry, root) === true).length;
      for (let index = 0; index < candidate.length && matching < minContains; index += 1) {
        if (validates(containsSchema, candidate[index], root) === true) continue;
        candidate[index] = this.repair(candidate[index], containsSchema, root, [...path, '*']);
        if (validates(containsSchema, candidate[index], root) === true) matching += 1;
      }
    }
    // No undefined may survive: JSON.stringify turns array holes into null.
    for (let index = 0; index < candidate.length; index += 1) {
      if (candidate[index] !== undefined) continue;
      const filler = prefix[index] ?? itemSchema ?? containsSchema ?? {};
      const repaired = this.repair(undefined, filler, root, [...path, '*']);
      candidate[index] = repaired === undefined ? null : repaired;
    }
    return candidate;
  }

  #repairObject(value: unknown, schema: JsonRecord, root: JsonRecord, path: SourcePath): JsonRecord {
    const candidate: JsonRecord = isRecord(value) ? clone(value) : {};
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === 'string')
      : [];
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(candidate, name) && !required.includes(name)) continue;
      const repaired = this.repair(candidate[name], propertySchema, root, [...path, name]);
      if (validates(propertySchema, repaired, root) === true) candidate[name] = repaired;
      else if (required.includes(name)) candidate[name] = repaired;
      else delete candidate[name];
    }
    for (const name of required) {
      if (!Object.prototype.hasOwnProperty.call(candidate, name) && !Object.prototype.hasOwnProperty.call(properties, name)) {
        candidate[name] = null;
      }
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(candidate)) {
        if (!Object.prototype.hasOwnProperty.call(properties, name)) delete candidate[name];
      }
    } else if (isRecord(schema.additionalProperties)) {
      for (const name of Object.keys(candidate)) {
        if (!Object.prototype.hasOwnProperty.call(properties, name)) {
          const repaired = this.repair(candidate[name], schema.additionalProperties, root, [...path, name]);
          if (validates(schema.additionalProperties, repaired, root) === true) candidate[name] = repaired;
          else delete candidate[name];
        }
      }
    }
    return candidate;
  }
}

function normalizedNumber(value: number): number {
  return Number(value.toPrecision(15));
}

function repairNumber(value: unknown, schema: JsonRecord, integer: boolean): number {
  const current = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const minimum = typeof schema.minimum === 'number' ? schema.minimum : undefined;
  const exclusiveMinimum = typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum : undefined;
  const maximum = typeof schema.maximum === 'number' ? schema.maximum : undefined;
  const exclusiveMaximum = typeof schema.exclusiveMaximum === 'number' ? schema.exclusiveMaximum : undefined;
  const multipleOf = typeof schema.multipleOf === 'number' && schema.multipleOf > 0 ? schema.multipleOf : undefined;
  if (multipleOf !== undefined) {
    const low = exclusiveMinimum !== undefined ? Math.floor(exclusiveMinimum / multipleOf) + 1
      : minimum !== undefined ? Math.ceil(minimum / multipleOf) : Number.NEGATIVE_INFINITY;
    const high = exclusiveMaximum !== undefined ? Math.ceil(exclusiveMaximum / multipleOf) - 1
      : maximum !== undefined ? Math.floor(maximum / multipleOf) : Number.POSITIVE_INFINITY;
    let multiplier = Math.round(current / multipleOf);
    if (Number.isFinite(low)) multiplier = Math.max(multiplier, low);
    if (Number.isFinite(high)) multiplier = Math.min(multiplier, high);
    const candidate = normalizedNumber(multiplier * multipleOf);
    return integer ? Math.trunc(candidate) : candidate;
  }
  let candidate = integer ? Math.trunc(current) : current;
  const lower = exclusiveMinimum ?? minimum;
  const upper = exclusiveMaximum ?? maximum;
  const lowBad = lower !== undefined && (exclusiveMinimum !== undefined ? candidate <= lower : candidate < lower);
  const highBad = upper !== undefined && (exclusiveMaximum !== undefined ? candidate >= upper : candidate > upper);
  if (lowBad || highBad) {
    if (integer) {
      const low = exclusiveMinimum !== undefined ? Math.floor(exclusiveMinimum) + 1
        : minimum !== undefined ? Math.ceil(minimum) : Number.NEGATIVE_INFINITY;
      const high = exclusiveMaximum !== undefined ? Math.ceil(exclusiveMaximum) - 1
        : maximum !== undefined ? Math.floor(maximum) : Number.POSITIVE_INFINITY;
      candidate = Number.isFinite(low) ? low : Number.isFinite(high) ? high : 0;
      if (Number.isFinite(high)) candidate = Math.min(candidate, high);
    } else if (lower !== undefined && upper !== undefined) candidate = normalizedNumber(lower + ((upper - lower) / 2));
    else if (lower !== undefined) candidate = exclusiveMinimum !== undefined ? lower + Math.max(1, Math.abs(lower) * 0.1) : lower;
    else if (upper !== undefined) candidate = exclusiveMaximum !== undefined ? upper - Math.max(1, Math.abs(upper) * 0.1) : upper;
  }
  return normalizedNumber(candidate);
}

function sourceOperation(root: JsonRecord, operation: ContractOperation): { operation: JsonRecord | null; pathItem: JsonRecord | null } {
  const rawOperation = resolvePointer(root, `#${operation.pointer}`);
  const pathPointer = operation.pointer.replace(/\/[^/]+$/, '');
  return {
    operation: resolveSourceRecord(root, rawOperation),
    pathItem: resolveSourceRecord(root, resolvePointer(root, `#${pathPointer}`))
  };
}

function requestContentType(request: JsonRecord): string {
  return headerValue(request.header, 'content-type').toLowerCase().split(';')[0]?.trim() ?? '';
}

function headerValue(headers: unknown, name: string): string {
  for (const raw of Array.isArray(headers) ? headers : []) {
    if (!isRecord(raw) || raw.disabled === true || String(raw.key || '').toLowerCase() !== name.toLowerCase()) continue;
    if (typeof raw.value === 'string') return raw.value;
  }
  return '';
}

function sourceRequestMedia(root: JsonRecord, operation: ContractOperation, base: string): { media: JsonRecord | null; schema: unknown } {
  const source = sourceOperation(root, operation).operation;
  const body = resolveSourceRecord(root, source?.requestBody);
  const content = isRecord(body?.content) ? body.content : {};
  for (const [contentType, rawMedia] of Object.entries(content)) {
    if ((contentType.toLowerCase().split(';')[0]?.trim() ?? '') !== base) continue;
    const media = isRecord(rawMedia) ? rawMedia : null;
    return { media, schema: media?.schema };
  }
  return { media: null, schema: undefined };
}

function repairJsonValue(
  value: unknown,
  packedSchema: unknown,
  rawSchema: unknown,
  media: JsonRecord | null,
  sourceRoot: JsonRecord,
  version: OpenApiVersion,
  direction: SchemaDirection,
  context: string,
  candidate: SchemaCandidateGenerator
): unknown {
  const packedRoot = isRecord(packedSchema) ? packedSchema : {};
  const policy = new SourcePolicy(
    mediaAuthoredValues(sourceRoot, media, rawSchema, packedSchema, version, direction),
    value,
    context
  );
  const pruned = pruneDirectionalProperties(value, rawSchema, sourceRoot, direction);
  const repaired = new SchemaRepairer(candidate, policy).repair(pruned, packedSchema, packedRoot);
  const validate = compileSchemaValidator(packedSchema);
  if (!validate) throw new Error(`generated ${context} could not be checked because its packed schema validator did not compile`);
  // Validate the SERIALIZED form. compileSchemaValidator runs with isJSON,
  // which accepts in-memory undefined array holes that JSON.stringify then
  // rewrites to null, so checking the live object let invalid bytes ship.
  if (!validate(serializedForm(repaired))) {
    throw new Error(`generated ${context} could not be safely repaired to satisfy its OpenAPI schema`);
  }
  return repaired;
}

// urlencoded and multipart fields are string-serialized scalars, repaired
// against the per-field scalar schemas the contract index packs for form
// bodies. Without this, form fields never reached repair: only body.mode ===
// 'raw' was handled, so a const or minLength field shipped the converter's
// empty or too-short string.
function repairFormBody(
  operation: ContractOperation,
  body: JsonRecord,
  index: ContractIndex,
  candidate: SchemaCandidateGenerator
): void {
  const mode = typeof body.mode === 'string' ? body.mode : '';
  const base = mode === 'urlencoded'
    ? 'application/x-www-form-urlencoded'
    : mode === 'formdata' ? 'multipart/form-data' : '';
  if (!base) return;
  const fieldSchemas = operation.requestBody?.fieldRules?.[base]?.fieldSchemas;
  if (!fieldSchemas) return;
  const entries = Array.isArray(body[mode]) ? body[mode].filter(isRecord) : [];
  for (const entry of entries) {
    if (entry.disabled === true) continue;
    // File parts carry no text value and binary parts are not schema-shaped.
    if (entry.type === 'file' || typeof entry.value !== 'string') continue;
    if (entry.value.includes('{{')) continue;
    const schema = fieldSchemas[String(entry.key ?? '')];
    if (schema === undefined) continue;
    const label = `${base} field ${String(entry.key ?? '')} for ${operation.id}`;
    const root = isRecord(schema) ? schema : {};
    const policy = new SourcePolicy([], entry.value, label);
    const repaired = new SchemaRepairer(candidate, policy).repair(coerceScalar(entry.value, schema), schema, root);
    const validate = compileSchemaValidator(schema);
    if (!validate || !validate(serializedForm(repaired))) {
      throw new Error(`generated ${label} could not be safely repaired to satisfy its OpenAPI schema`);
    }
    entry.value = scalarString(repaired);
  }
}

function repairRequestBody(
  operation: ContractOperation,
  request: JsonRecord,
  sourceRoot: JsonRecord,
  index: ContractIndex,
  candidate: SchemaCandidateGenerator
): void {
  const base = requestContentType(request);
  const schema = operation.requestBody?.jsonSchemas?.[base];
  const body = isRecord(request.body) ? request.body : null;
  if (body && body.mode !== 'raw') {
    repairFormBody(operation, body, index, candidate);
    return;
  }
  if (schema === undefined || body?.mode !== 'raw' || typeof body.raw !== 'string' || !body.raw.trim()) return;
  if (body.raw.includes('{{') || /<[^<>]+>/.test(body.raw)) return;
  let value: unknown;
  try {
    value = JSON.parse(body.raw);
  } catch (error) {
    throw new Error(`generated JSON request body for ${operation.id} is not parseable`, { cause: error });
  }
  const source = sourceRequestMedia(sourceRoot, operation, base);
  const repaired = repairJsonValue(
    value,
    schema,
    source.schema,
    source.media,
    sourceRoot,
    index.version,
    'request',
    `${base} request body for ${operation.id}`,
    candidate
  );
  if (!sameValue(value, repaired)) body.raw = JSON.stringify(repaired, null, 2);
}

function coerceScalar(value: string, schema: unknown): unknown {
  const record = isRecord(schema) ? schema : null;
  const declared = Array.isArray(record?.type) ? record.type : [record?.type];
  // A typeless const/enum schema pins the JSON type without declaring it, so
  // the decoded string is coerced from the pinned values instead.
  const pinned = !record
    ? []
    : Object.prototype.hasOwnProperty.call(record, 'const')
      ? [record.const]
      : Array.isArray(record.enum) ? record.enum : [];
  const types = record?.type === undefined && pinned.length > 0
    ? [...new Set(pinned.map((entry) => (entry === null ? 'null' : typeof entry === 'number' && Number.isInteger(entry) ? 'integer' : typeof entry)))]
    : declared;
  if ((types.includes('integer') || types.includes('number')) && /^-?[0-9]+(?:[.][0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value.trim())) return Number(value);
  if (types.includes('boolean') && (value === 'true' || value === 'false')) return value === 'true';
  return value;
}

function scalarString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function sourceParameter(root: JsonRecord, operation: ContractOperation, check: ContractParameterCheck): JsonRecord | null {
  const source = sourceOperation(root, operation);
  const params = [
    ...(Array.isArray(source.operation?.parameters) ? source.operation.parameters : []),
    ...(Array.isArray(source.pathItem?.parameters) ? source.pathItem.parameters : [])
  ];
  for (const raw of params) {
    const param = resolveSourceRecord(root, raw);
    if (String(param?.in || '').toLowerCase() === check.in && String(param?.name || '').toLowerCase() === check.name.toLowerCase()) return param;
  }
  return null;
}

function parameterPolicy(
  root: JsonRecord,
  operation: ContractOperation,
  check: ContractParameterCheck,
  value: unknown,
  version: OpenApiVersion
): SourcePolicy {
  const param = sourceParameter(root, operation, check);
  const content = isRecord(param?.content) ? Object.values(param.content) : [];
  const rawSchema = param?.schema ?? (content.length === 1 && isRecord(content[0]) ? content[0].schema : undefined);
  return new SourcePolicy(
    mediaAuthoredValues(root, param, rawSchema, check.schema, version, 'request'),
    value,
    `parameter ${check.in}:${check.name} on ${operation.id}`
  );
}

function repairParameterValue(
  operation: ContractOperation,
  check: ContractParameterCheck,
  value: unknown,
  sourceRoot: JsonRecord,
  index: ContractIndex,
  candidate: SchemaCandidateGenerator
): unknown {
  const param = sourceParameter(sourceRoot, operation, check);
  const content = isRecord(param?.content) ? Object.values(param.content) : [];
  const rawSchema = param?.schema ?? (content.length === 1 && isRecord(content[0]) ? content[0].schema : undefined);
  const policy = parameterPolicy(sourceRoot, operation, check, value, index.version);
  const root = isRecord(check.schema) ? check.schema : {};
  const pruned = pruneDirectionalProperties(value, rawSchema, sourceRoot, 'request');
  const repaired = new SchemaRepairer(candidate, policy).repair(pruned, check.schema, root);
  const validate = compileSchemaValidator(check.schema);
  if (!validate || !validate(repaired)) {
    throw new Error(`generated parameter ${check.in}:${check.name} on ${operation.id} could not be safely repaired to satisfy its OpenAPI schema`);
  }
  return repaired;
}

function replaceQueryEntries(url: JsonRecord, name: string, values: string[]): void {
  const query = Array.isArray(url.query) ? url.query.filter(isRecord) : [];
  const matching = query.filter((entry) => entry.disabled !== true && String(entry.key || '').toLowerCase() === name.toLowerCase());
  const template = matching[0] ?? { key: name };
  const others = query.filter((entry) => String(entry.key || '').toLowerCase() !== name.toLowerCase());
  url.query = [...others, ...values.map((value) => ({ ...template, key: name, value }))];
}

function repairParameters(
  operation: ContractOperation,
  request: JsonRecord,
  sourceRoot: JsonRecord,
  index: ContractIndex,
  candidate: SchemaCandidateGenerator
): void {
  const url = isRecord(request.url) ? request.url : null;
  for (const check of operation.parameterChecks ?? []) {
    if (check.in === 'cookie') continue;
    if (check.in === 'path') {
      const variables = Array.isArray(url?.variable) ? url.variable.filter(isRecord) : [];
      const variable = variables.find((entry) => String(entry.key || '').toLowerCase() === check.name.toLowerCase());
      if (!variable || typeof variable.value !== 'string' || variable.value.includes('{{')) continue;
      const prefix = check.pathStyle === 'label' ? '.' : check.pathStyle === 'matrix' ? `;${check.name}=` : '';
      const raw = prefix && variable.value.startsWith(prefix) ? variable.value.slice(prefix.length) : variable.value;
      const repaired = repairParameterValue(operation, check, coerceScalar(raw, check.schema), sourceRoot, index, candidate);
      variable.value = `${prefix}${scalarString(repaired)}`;
      continue;
    }
    if (check.in === 'header') {
      const headers = Array.isArray(request.header) ? request.header.filter(isRecord) : [];
      const header = headers.find((entry) => entry.disabled !== true && String(entry.key || '').toLowerCase() === check.name.toLowerCase());
      if (!header || typeof header.value !== 'string' || header.value.includes('{{')) continue;
      const decoded = check.decode === 'csv'
        ? header.value.split(',').map((entry) => coerceScalar(entry.trim(), check.items))
        : check.content
          ? JSON.parse(header.value)
          : coerceScalar(header.value, check.schema);
      const repaired = repairParameterValue(operation, check, decoded, sourceRoot, index, candidate);
      header.value = check.decode === 'csv' && Array.isArray(repaired)
        ? repaired.map(scalarString).join(',')
        : check.content
          ? JSON.stringify(repaired)
          : scalarString(repaired);
      continue;
    }
    if (!url) continue;
    const query = Array.isArray(url.query) ? url.query.filter(isRecord) : [];
    if (check.decode === 'deepObject') {
      const prefix = `${check.name.toLowerCase()}[`;
      const entries = query.filter((entry) => entry.disabled !== true && String(entry.key || '').toLowerCase().startsWith(prefix));
      if (entries.length === 0) continue;
      const properties = isRecord(check.schema) && isRecord(check.schema.properties) ? check.schema.properties : {};
      const decoded: JsonRecord = {};
      for (const entry of entries) {
        const match = String(entry.key || '').match(/^[^[]+\[([^\]]+)]$/);
        if (!match?.[1]) continue;
        decoded[match[1]] = coerceScalar(String(entry.value ?? ''), properties[match[1]]);
      }
      const repaired = repairParameterValue(operation, check, decoded, sourceRoot, index, candidate);
      if (!isRecord(repaired)) continue;
      const others = query.filter((entry) => !String(entry.key || '').toLowerCase().startsWith(prefix));
      url.query = [
        ...others,
        ...Object.entries(repaired).map(([name, value]) => ({ key: `${check.name}[${name}]`, value: scalarString(value) }))
      ];
      continue;
    }
    const entries = query.filter((entry) => entry.disabled !== true && String(entry.key || '').toLowerCase() === check.name.toLowerCase());
    if (entries.length === 0 || entries.some((entry) => String(entry.value ?? '').includes('{{'))) continue;
    let decoded: unknown;
    if (check.decode === 'multi') decoded = entries.map((entry) => coerceScalar(String(entry.value ?? ''), check.items));
    else if (check.decode) {
      const delimiter = check.decode === 'ssv' ? ' ' : check.decode === 'pipes' ? '|' : ',';
      decoded = String(entries[0]!.value ?? '').split(delimiter).map((entry) => coerceScalar(entry.trim(), check.items));
    } else if (check.content) decoded = JSON.parse(String(entries[0]!.value ?? ''));
    else decoded = coerceScalar(String(entries[0]!.value ?? ''), check.schema);
    const repaired = repairParameterValue(operation, check, decoded, sourceRoot, index, candidate);
    if (check.decode === 'multi' && Array.isArray(repaired)) replaceQueryEntries(url, check.name, repaired.map(scalarString));
    else if (check.decode && Array.isArray(repaired)) {
      const delimiter = check.decode === 'ssv' ? ' ' : check.decode === 'pipes' ? '|' : ',';
      replaceQueryEntries(url, check.name, [repaired.map(scalarString).join(delimiter)]);
    } else replaceQueryEntries(url, check.name, [check.content ? JSON.stringify(repaired) : scalarString(repaired)]);
  }
}

// Webhook items carry no callable URL, so matchOperation cannot place them.
// The converter names each webhook item after its webhooks key, which is the
// only stable link back to the indexed webhook operation.
function matchWebhookOperation(index: ContractIndex, item: JsonRecord): ContractOperation | undefined {
  const webhooks = index.webhookOperations ?? [];
  if (webhooks.length === 0) return undefined;
  const request = isRecord(item.request) ? item.request : {};
  const method = String(request.method || '').toUpperCase();
  const name = String(item.name || '').trim().toLowerCase();
  if (!name) return undefined;
  const collapsed = name.replace(/[\s_-]+/g, '');
  const matches = webhooks.filter((operation) => {
    if (operation.method !== method) return false;
    const key = operation.path.replace(/^\//, '').toLowerCase();
    return key === name || key.replace(/[\s_-]+/g, '') === collapsed;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function repairRequest(
  operation: ContractOperation,
  request: JsonRecord,
  sourceRoot: JsonRecord,
  index: ContractIndex,
  candidate: SchemaCandidateGenerator
): void {
  repairParameters(operation, request, sourceRoot, index, candidate);
  repairRequestBody(operation, request, sourceRoot, index, candidate);
}

function responseContract(operation: ContractOperation, code: number): { key: string; value: ContractResponse } | null {
  const exact = String(code);
  if (operation.responses[exact]) return { key: exact, value: operation.responses[exact] };
  const range = `${Math.floor(code / 100)}XX`;
  if (operation.responses[range]) return { key: range, value: operation.responses[range] };
  return operation.responses.default ? { key: 'default', value: operation.responses.default } : null;
}

function sourceResponseMedia(
  root: JsonRecord,
  operation: ContractOperation,
  status: string,
  base: string
): { media: JsonRecord | null; schema: unknown } {
  const source = sourceOperation(root, operation).operation;
  const responses = isRecord(source?.responses) ? source.responses : {};
  const response = resolveSourceRecord(root, responses[status]);
  const content = isRecord(response?.content) ? response.content : {};
  for (const [contentType, rawMedia] of Object.entries(content)) {
    if ((contentType.toLowerCase().split(';')[0]?.trim() ?? '') !== base) continue;
    const media = isRecord(rawMedia) ? rawMedia : null;
    return { media, schema: media?.schema };
  }
  return { media: null, schema: undefined };
}

function repairSavedResponse(
  operation: ContractOperation,
  response: JsonRecord,
  sourceRoot: JsonRecord,
  index: ContractIndex,
  candidate: SchemaCandidateGenerator
): void {
  const code = typeof response.code === 'number' ? response.code : Number(response.code);
  if (!Number.isFinite(code)) return;
  const contract = responseContract(operation, code);
  if (!contract) return;
  const base = headerValue(response.header, 'content-type').toLowerCase().split(';')[0]?.trim() ?? '';
  const mediaEntry = Object.entries(contract.value.content).find(([contentType]) => (contentType.toLowerCase().split(';')[0]?.trim() ?? '') === base);
  const packedSchema = mediaEntry?.[1].schema;
  if (packedSchema !== undefined && typeof response.body === 'string' && response.body.trim() && (base === 'application/json' || /\+json$/.test(base))) {
    let value: unknown;
    try {
      value = JSON.parse(response.body);
    } catch (error) {
      throw new Error(`generated saved response body for ${operation.id} status ${code} is not parseable JSON`, { cause: error });
    }
    const source = sourceResponseMedia(sourceRoot, operation, contract.key, base);
    const repaired = repairJsonValue(
      value,
      packedSchema,
      source.schema,
      source.media,
      sourceRoot,
      index.version,
      'response',
      `${base} saved response body for ${operation.id} status ${code}`,
      candidate
    );
    if (!sameValue(value, repaired)) response.body = JSON.stringify(repaired, null, 2);
  }
  for (const headerContract of contract.value.headers) {
    if (headerContract.schema === undefined || headerContract.unsupported) continue;
    const headers = Array.isArray(response.header) ? response.header.filter(isRecord) : [];
    const header = headers.find((entry) => String(entry.key || '').toLowerCase() === headerContract.name.toLowerCase());
    if (!header || typeof header.value !== 'string') continue;
    const root = isRecord(headerContract.schema) ? headerContract.schema : {};
    const policy = new SourcePolicy([], header.value, `saved response header ${headerContract.name}`);
    const repaired = new SchemaRepairer(candidate, policy).repair(coerceScalar(header.value, headerContract.schema), headerContract.schema, root);
    if (validates(headerContract.schema, repaired, root) === true) header.value = scalarString(repaired);
  }
}

export function repairGeneratedCollectionExamples(
  collection: JsonRecord,
  index: ContractIndex,
  bundledOpenApi: string,
  candidate: SchemaCandidateGenerator
): string[] {
  const warnings: string[] = [];
  const sourceRoot = parseOpenApiDocument(bundledOpenApi);
  const visit = (items: unknown): void => {
    if (!Array.isArray(items)) return;
    for (const raw of items) {
      if (!isRecord(raw)) continue;
      if (isRecord(raw.request)) {
        const matched = matchOperation(index, raw.request);
        const operation = matched.operation ?? matchWebhookOperation(index, raw);
        if (operation) {
          repairExampleOrWarn(
            raw.request,
            `request example for ${operation.id}`,
            warnings,
            () => repairRequest(operation, raw.request as JsonRecord, sourceRoot, index, candidate)
          );
          for (const saved of Array.isArray(raw.response) ? raw.response.filter(isRecord) : []) {
            if (isRecord(saved.originalRequest)) {
              repairExampleOrWarn(
                saved.originalRequest,
                `saved original request example for ${operation.id}`,
                warnings,
                () => repairRequest(
                  operation,
                  saved.originalRequest as JsonRecord,
                  sourceRoot,
                  index,
                  candidate
                )
              );
            }
            repairExampleOrWarn(
              saved,
              `saved response example for ${operation.id}`,
              warnings,
              () => repairSavedResponse(operation, saved, sourceRoot, index, candidate)
            );
          }
        }
      }
      visit(raw.item);
    }
  };
  visit(collection.item);
  return warnings;
}

type JsonRecord = Record<string, unknown>;

export type OpenApiVersion = '3.0' | '3.1';

export interface PackedSchema {
  schema?: unknown;
  unsupported?: string;
}

const DRAFT_07_SCHEMA_URI = 'http://json-schema.org/draft-07/schema#';
const DRAFT_2020_12_SCHEMA_URI = 'https://json-schema.org/draft/2020-12/schema';

const COMPATIBLE_SCHEMA_URIS = new Set([
  DRAFT_07_SCHEMA_URI,
  'https://json-schema.org/draft-07/schema',
  'https://json-schema.org/draft-07/schema#',
  DRAFT_2020_12_SCHEMA_URI,
  `${DRAFT_2020_12_SCHEMA_URI}#`
]);

const ASSERTION_KEYS = new Set([
  '$ref',
  '$schema',
  'additionalItems',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'contains',
  'dependentRequired',
  'dependentSchemas',
  'dependencies',
  'else',
  'enum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'if',
  'items',
  'maxContains',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minContains',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'multipleOf',
  'not',
  'oneOf',
  'pattern',
  'patternProperties',
  'prefixItems',
  'properties',
  'propertyNames',
  'required',
  'then',
  'type',
  'unevaluatedItems',
  'unevaluatedProperties',
  'uniqueItems'
]);

// Source $defs and $id are stripped rather than asserted: every $ref in a
// bundled OpenAPI document is document-absolute and is resolved against the
// original document, the packed output rebuilds its own #/$defs/dN registry,
// and a source $id would re-base relative resolution underneath those
// rewritten refs.
const STRIP_KEYS = new Set([
  'title',
  '$comment',
  '$defs',
  'definitions',
  '$id',
  'description',
  'default',
  'example',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
  'xml',
  'externalDocs',
  'discriminator',
  'contentEncoding',
  'contentMediaType',
  'contentSchema'
]);

// Formats schemasafe enforces under formatAssertion. Anything else (int32,
// int64, byte, binary, password, vendor formats) would throw at validator
// compile time, so unknown formats are stripped, matching OpenAPI semantics
// where an unrecognized format is an annotation rather than an assertion.
const ASSERTED_FORMATS = new Set([
  'date-time',
  'date',
  'time',
  'duration',
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'uri',
  'uri-reference',
  'uri-template',
  'uuid',
  'json-pointer',
  'relative-json-pointer',
  'regex'
]);

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const MAX_REFERENCED_SCHEMAS = 400;

// Keywords that exist in only one supported dialect: asserting them under the
// other dialect would silently validate nothing once schemasafe ignores them
// via allowUnusedKeywords, so the mismatch fails closed instead.
const DRAFT_2020_12_ONLY_KEYS = new Set(['prefixItems', 'dependentRequired', 'dependentSchemas', 'minContains', 'maxContains', 'unevaluatedItems', 'unevaluatedProperties']);
const DRAFT_07_ONLY_KEYS = new Set(['dependencies', 'additionalItems']);

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function resolvePointer(root: JsonRecord, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  return ref
    .slice(2)
    .split('/')
    .map(decodePointerSegment)
    .reduce<unknown>((node, segment) => asRecord(node)?.[segment], root);
}

function unsupported(message: string): PackedSchema {
  return { unsupported: message };
}

function mergeRequiredWithoutStripped(required: unknown, strippedProperties: Set<string>): string[] | undefined {
  const values = asArray(required)
    .map((entry) => String(entry))
    .filter((entry) => !strippedProperties.has(entry));
  return values.length > 0 ? values : undefined;
}

function hasUnsupported(child: unknown): string | undefined {
  return asRecord(child)?.unsupported as string | undefined;
}

function rootDialect(root: JsonRecord, version: OpenApiVersion, schemaRecord?: JsonRecord): string {
  if (version === '3.0') return DRAFT_07_SCHEMA_URI;
  const declared = schemaRecord?.$schema ?? root.jsonSchemaDialect;
  if (declared === undefined) return DRAFT_2020_12_SCHEMA_URI;
  if (typeof declared !== 'string' || !COMPATIBLE_SCHEMA_URIS.has(declared)) {
    throw new Error(`CONTRACT_UNSUPPORTED_SCHEMA_DIALECT: Unsupported JSON Schema dialect: ${String(declared)}`);
  }
  if (declared.includes('draft-07')) return DRAFT_07_SCHEMA_URI;
  return DRAFT_2020_12_SCHEMA_URI;
}

export type SchemaDirection = 'request' | 'response';

interface DefEntry {
  name: string;
  schema?: unknown;
  unsupported?: string;
}

interface PackContext {
  root: JsonRecord;
  version: OpenApiVersion;
  direction: SchemaDirection;
  dialect: string;
  defs: Map<string, DefEntry>;
}

// Referenced schemas are packed once into a #/$defs/dN registry instead of
// being inlined at every use site. This keeps generated validator modules
// near-linear in unique schema count rather than exponential in reference
// fan-out, and makes recursive $refs (Stripe-style) representable instead of
// fail-closed.
function registerDef(ctx: PackContext, ref: string): DefEntry {
  const existing = ctx.defs.get(ref);
  if (existing) return existing;
  if (ctx.defs.size >= MAX_REFERENCED_SCHEMAS) {
    const entry: DefEntry = { name: 'overflow', unsupported: `OpenAPI schema reference graph exceeded ${MAX_REFERENCED_SCHEMAS} referenced schemas` };
    return entry;
  }
  const entry: DefEntry = { name: `d${ctx.defs.size}` };
  ctx.defs.set(ref, entry);
  const resolved = resolvePointer(ctx.root, ref);
  if (resolved === undefined) {
    entry.unsupported = `Unresolved OpenAPI $ref: ${ref}`;
    return entry;
  }
  const normalized = normalizeSchema(ctx, resolved, { depth: 0, rootSchema: false });
  const bad = hasUnsupported(normalized);
  if (bad) entry.unsupported = bad;
  else entry.schema = normalized;
  return entry;
}

function normalizeSchema(
  ctx: PackContext,
  schema: unknown,
  options: {
    depth: number;
    rootSchema: boolean;
    inlineStack?: string[];
  }
): unknown {
  const depth = options.depth;
  if (depth > 50) return unsupported('OpenAPI schema nesting depth exceeded 50');

  if (Array.isArray(schema)) {
    const normalized = schema.map((entry) => normalizeSchema(ctx, entry, { depth: depth + 1, rootSchema: false }));
    const bad = normalized.map(hasUnsupported).find(Boolean);
    return bad ? unsupported(bad) : normalized;
  }

  const record = asRecord(schema);
  if (!record) return schema;

  const ref = typeof record.$ref === 'string' ? record.$ref : '';
  if (ref) {
    if (!ref.startsWith('#/')) return unsupported(`External OpenAPI $ref remained unresolved: ${ref}`);
    const siblingEntries = ctx.version === '3.1' ? Object.entries(record).filter(([key]) => key !== '$ref') : [];
    // A root-level $ref is inlined one hop so the packed root keeps a visible
    // `type` (scalar parameter/header detection reads it); deeper refs go
    // through the $defs registry. The inline stack stops a self-referential
    // root from inlining forever.
    const inlineStack = options.inlineStack ?? [];
    if (options.rootSchema && siblingEntries.length === 0 && !inlineStack.includes(ref)) {
      const resolved = resolvePointer(ctx.root, ref);
      if (resolved === undefined) return unsupported(`Unresolved OpenAPI $ref: ${ref}`);
      const inlined = normalizeSchema(ctx, resolved, { depth, rootSchema: true, inlineStack: [...inlineStack, ref] });
      const bad = hasUnsupported(inlined);
      return bad ? unsupported(bad) : inlined;
    }
    const entry = registerDef(ctx, ref);
    if (entry.unsupported) return unsupported(entry.unsupported);
    const refNode: JsonRecord = { $ref: `#/$defs/${entry.name}` };
    if (siblingEntries.length === 0) {
      if (options.rootSchema) refNode.$schema = ctx.dialect;
      return refNode;
    }
    const siblingSchema = normalizeSchema(ctx, Object.fromEntries(siblingEntries), { depth: depth + 1, rootSchema: false });
    const siblingUnsupported = hasUnsupported(siblingSchema);
    if (siblingUnsupported) return unsupported(siblingUnsupported);
    const wrapper: JsonRecord = { allOf: [refNode, siblingSchema] };
    if (options.rootSchema) wrapper.$schema = ctx.dialect;
    return wrapper;
  }

  const sourceSchema = { ...record };
  const nullable = sourceSchema.nullable === true && ctx.version === '3.0';
  delete sourceSchema.nullable;

  // Response validators drop writeOnly properties (request-only fields);
  // request validators drop readOnly properties (response-only fields). The
  // flag is read through one internal $ref hop so reusable schemas such as a
  // shared writeOnly Password component are stripped too.
  const directionStrippedFlag = ctx.direction === 'request' ? 'readOnly' : 'writeOnly';
  const strippedProperties = new Set<string>();
  const rawProperties = asRecord(sourceSchema.properties);
  if (rawProperties) {
    for (const [propertyName, propertySchema] of Object.entries(rawProperties)) {
      let flagSource = asRecord(propertySchema);
      if (typeof flagSource?.$ref === 'string' && flagSource.$ref.startsWith('#/')) {
        flagSource = asRecord(resolvePointer(ctx.root, flagSource.$ref)) ?? flagSource;
      }
      if (flagSource?.[directionStrippedFlag] === true) strippedProperties.add(propertyName);
    }
  }

  const normalized: JsonRecord = {};

  for (const [key, value] of Object.entries(sourceSchema)) {
    if (key.startsWith('x-') || STRIP_KEYS.has(key)) continue;

    if (key === '$schema') {
      if (typeof value !== 'string' || !COMPATIBLE_SCHEMA_URIS.has(value)) {
        return unsupported(`Unsupported JSON Schema dialect: ${String(value)}`);
      }
      if (options.rootSchema) normalized.$schema = value.includes('draft-07') ? DRAFT_07_SCHEMA_URI : DRAFT_2020_12_SCHEMA_URI;
      continue;
    }

    if (key === 'exclusiveMinimum' && typeof value === 'boolean') {
      if (value === false) continue;
      if (typeof sourceSchema.minimum !== 'number') return unsupported('exclusiveMinimum true requires minimum');
      normalized.exclusiveMinimum = sourceSchema.minimum;
      delete normalized.minimum;
      continue;
    }

    if (key === 'exclusiveMaximum' && typeof value === 'boolean') {
      if (value === false) continue;
      if (typeof sourceSchema.maximum !== 'number') return unsupported('exclusiveMaximum true requires maximum');
      normalized.exclusiveMaximum = sourceSchema.maximum;
      delete normalized.maximum;
      continue;
    }

    if (key === 'format') {
      if (typeof value === 'string' && ASSERTED_FORMATS.has(value)) normalized.format = value;
      continue;
    }

    if (!ASSERTION_KEYS.has(key)) return unsupported(`Unsupported OpenAPI schema keyword: ${key}`);

    if (ctx.dialect === DRAFT_07_SCHEMA_URI && DRAFT_2020_12_ONLY_KEYS.has(key)) {
      return unsupported(`${key} requires the JSON Schema 2020-12 dialect`);
    }
    if (ctx.dialect === DRAFT_2020_12_SCHEMA_URI && DRAFT_07_ONLY_KEYS.has(key)) {
      return unsupported(`${key} is a draft-07 keyword and is unsupported under JSON Schema 2020-12`);
    }

    if (key === 'items' && Array.isArray(value) && ctx.version === '3.0') {
      return unsupported('Tuple array items are unsupported in OpenAPI 3.0');
    }

    // Map-valued keywords carry schema (or name-list) VALUES under free-form
    // KEYS; the generic recursion below would misread those keys as schema
    // keywords, so they get dedicated handling.
    if (key === 'patternProperties' || key === 'dependentSchemas') {
      const map = asRecord(value);
      if (!map) continue;
      const next: JsonRecord = {};
      for (const [mapKey, mapSchema] of Object.entries(map)) {
        const child = normalizeSchema(ctx, mapSchema, { depth: depth + 1, rootSchema: false });
        const bad = hasUnsupported(child);
        if (bad) return unsupported(bad);
        next[mapKey] = child;
      }
      normalized[key] = next;
      continue;
    }
    if (key === 'dependentRequired') {
      const map = asRecord(value);
      if (!map) continue;
      for (const names of Object.values(map)) {
        if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
          return unsupported('dependentRequired requires string array values');
        }
      }
      normalized.dependentRequired = value;
      continue;
    }
    if (key === 'dependencies') {
      const map = asRecord(value);
      if (!map) continue;
      const next: JsonRecord = {};
      for (const [mapKey, dependency] of Object.entries(map)) {
        if (Array.isArray(dependency)) {
          if (dependency.some((name) => typeof name !== 'string')) return unsupported('dependencies requires string array or schema values');
          next[mapKey] = dependency;
          continue;
        }
        const child = normalizeSchema(ctx, dependency, { depth: depth + 1, rootSchema: false });
        const bad = hasUnsupported(child);
        if (bad) return unsupported(bad);
        next[mapKey] = child;
      }
      normalized.dependencies = next;
      continue;
    }

    if (key === 'properties') {
      const properties = asRecord(value);
      if (!properties) continue;
      const nextProperties: JsonRecord = {};
      for (const [propertyName, propertySchema] of Object.entries(properties)) {
        if (strippedProperties.has(propertyName)) continue;
        const child = normalizeSchema(ctx, propertySchema, { depth: depth + 1, rootSchema: false });
        const bad = hasUnsupported(child);
        if (bad) return unsupported(bad);
        nextProperties[propertyName] = child;
      }
      normalized.properties = nextProperties;
      continue;
    }

    if (key === 'required') {
      const required = mergeRequiredWithoutStripped(value, strippedProperties);
      if (required) normalized.required = required;
      continue;
    }

    const child = normalizeSchema(ctx, value, { depth: depth + 1, rootSchema: false });
    const bad = hasUnsupported(child);
    if (bad) return unsupported(bad);
    normalized[key] = child;
  }

  // schemasafe's default mode refuses an inclusive bound alongside a numeric
  // exclusive bound on the same side ('Unprocessed keywords'). Dual pairs are
  // legal JSON Schema 2020-12 and can also be produced by the 3.0 boolean
  // conversion above when exclusiveMinimum precedes minimum in key order, so
  // this post-pass keeps the stricter single assertion per side regardless of
  // source key order.
  if (typeof normalized.minimum === 'number' && typeof normalized.exclusiveMinimum === 'number') {
    if (normalized.exclusiveMinimum >= normalized.minimum) delete normalized.minimum;
    else delete normalized.exclusiveMinimum;
  }
  if (typeof normalized.maximum === 'number' && typeof normalized.exclusiveMaximum === 'number') {
    if (normalized.exclusiveMaximum <= normalized.maximum) delete normalized.maximum;
    else delete normalized.exclusiveMaximum;
  }

  if (sourceSchema.format === 'int32') {
    const type = normalized.type;
    const isInteger = type === 'integer' || (Array.isArray(type) && type.includes('integer'));
    if (isInteger) {
      if (typeof normalized.exclusiveMinimum === 'number') {
        // An exclusive bound looser than the int32 floor is replaced by the
        // tighter inclusive floor; the dedup above guarantees one keyword.
        if (normalized.exclusiveMinimum < INT32_MIN) {
          delete normalized.exclusiveMinimum;
          normalized.minimum = INT32_MIN;
        }
      } else if (typeof normalized.minimum !== 'number' || normalized.minimum < INT32_MIN) {
        normalized.minimum = INT32_MIN;
      }
      if (typeof normalized.exclusiveMaximum === 'number') {
        if (normalized.exclusiveMaximum > INT32_MAX) {
          delete normalized.exclusiveMaximum;
          normalized.maximum = INT32_MAX;
        }
      } else if (typeof normalized.maximum !== 'number' || normalized.maximum > INT32_MAX) {
        normalized.maximum = INT32_MAX;
      }
    }
  }

  if (options.rootSchema) normalized.$schema = ctx.dialect;

  if (nullable) {
    if (typeof normalized.type === 'string') {
      normalized.type = [normalized.type, 'null'];
    } else if (Array.isArray(normalized.type)) {
      normalized.type = [...new Set([...normalized.type, 'null'])];
    } else if (Array.isArray(normalized.enum)) {
      if (!normalized.enum.includes(null)) normalized.enum = [...normalized.enum, null];
    } else {
      const wrappedSchema = { ...normalized };
      delete wrappedSchema.$schema;
      const wrapper: JsonRecord = { anyOf: [{ type: 'null' }, wrappedSchema] };
      if (options.rootSchema) wrapper.$schema = ctx.dialect;
      return wrapper;
    }
  }

  return normalized;
}

export function isSchemaGraphOverflow(packed: PackedSchema): boolean {
  return typeof packed.unsupported === 'string' && packed.unsupported.startsWith('OpenAPI schema reference graph exceeded');
}

export function packSchema(root: JsonRecord, schema: unknown, version: OpenApiVersion, direction: SchemaDirection = 'response'): PackedSchema {
  try {
    // Boolean schemas are legal JSON Schema: true accepts every instance and
    // packs as an unconstrained schema; false rejects every instance, which a
    // generated test cannot meaningfully assert, so it fails closed.
    if (schema === true) return { schema: { $schema: rootDialect(root, version) } };
    if (schema === false) return unsupported('Boolean false JSON Schema rejects every instance and is unsupported');
    const dialect = rootDialect(root, version, asRecord(schema) ?? undefined);
    const ctx: PackContext = { root, version, direction, dialect, defs: new Map() };
    const normalized = normalizeSchema(ctx, schema, { depth: 0, rootSchema: true });
    const message = hasUnsupported(normalized);
    if (message) return unsupported(message);
    // A def that is purely a $ref alias compiles, but a chain of pure aliases
    // that loops back on itself recurses forever at validation time, so any
    // alias cycle fails closed here. Aliases that terminate at a def carrying
    // real keywords are fine.
    const aliasTargets = new Map<string, string>();
    for (const entry of ctx.defs.values()) {
      if (entry.unsupported) return unsupported(entry.unsupported);
      const entrySchema = asRecord(entry.schema);
      const ref = entrySchema && Object.keys(entrySchema).length === 1 && typeof entrySchema.$ref === 'string' ? entrySchema.$ref : '';
      if (ref.startsWith('#/$defs/')) aliasTargets.set(entry.name, ref.slice('#/$defs/'.length));
    }
    for (const start of aliasTargets.keys()) {
      const seen = new Set<string>();
      let current: string | undefined = start;
      while (current !== undefined && aliasTargets.has(current)) {
        if (seen.has(current)) return unsupported('Self-referential alias schema is unsupported');
        seen.add(current);
        current = aliasTargets.get(current);
      }
    }
    if (ctx.defs.size > 0) {
      const normalizedRecord = asRecord(normalized);
      if (!normalizedRecord) return unsupported('Referenced schemas require an object root schema');
      normalizedRecord.$defs = Object.fromEntries([...ctx.defs.values()].map((entry) => [entry.name, entry.schema]));
    }
    return { schema: normalized };
  } catch (error) {
    return unsupported(error instanceof Error ? error.message : String(error));
  }
}

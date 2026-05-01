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
  '$defs',
  '$id',
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

const STRIP_KEYS = new Set([
  'title',
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
  'format'
]);

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

function mergeRequiredWithoutWriteOnly(required: unknown, writeOnlyProperties: Set<string>): string[] | undefined {
  const values = asArray(required)
    .map((entry) => String(entry))
    .filter((entry) => !writeOnlyProperties.has(entry));
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

function normalizeSchema(
  root: JsonRecord,
  schema: unknown,
  options: {
    version: OpenApiVersion;
    depth?: number;
    rootSchema?: boolean;
    stack?: string[];
    dialect?: string;
  }
): unknown {
  const depth = options.depth ?? 0;
  if (depth > 50) return unsupported('OpenAPI schema reference depth exceeded 50');

  if (Array.isArray(schema)) {
    const normalized = schema.map((entry) => normalizeSchema(root, entry, { ...options, depth: depth + 1, rootSchema: false }));
    const bad = normalized.map(hasUnsupported).find(Boolean);
    return bad ? unsupported(bad) : normalized;
  }

  const record = asRecord(schema);
  if (!record) return schema;

  const ref = typeof record.$ref === 'string' ? record.$ref : '';
  if (ref) {
    if (!ref.startsWith('#/')) return unsupported(`External OpenAPI $ref remained unresolved: ${ref}`);
    const stack = options.stack ?? [];
    if (stack.includes(ref)) return unsupported(`Recursive OpenAPI $ref is unsupported: ${ref}`);
    const resolved = resolvePointer(root, ref);
    if (resolved === undefined) return unsupported(`Unresolved OpenAPI $ref: ${ref}`);
    const siblingEntries = Object.entries(record).filter(([key]) => key !== '$ref');
    const resolvedSchema = normalizeSchema(root, resolved, {
      ...options,
      depth: depth + 1,
      rootSchema: false,
      stack: [...stack, ref]
    });
    const resolvedUnsupported = hasUnsupported(resolvedSchema);
    if (resolvedUnsupported) return unsupported(resolvedUnsupported);
    if (options.version === '3.0' || siblingEntries.length === 0) return resolvedSchema;
    const siblingSchema = normalizeSchema(root, Object.fromEntries(siblingEntries), {
      ...options,
      depth: depth + 1,
      rootSchema: false,
      stack: [...stack, ref]
    });
    const siblingUnsupported = hasUnsupported(siblingSchema);
    if (siblingUnsupported) return unsupported(siblingUnsupported);
    const wrapper: JsonRecord = { allOf: [resolvedSchema, siblingSchema] };
    if (options.rootSchema) wrapper.$schema = options.dialect ?? rootDialect(root, options.version, record);
    return wrapper;
  }

  const sourceSchema = { ...record };
  const nullable = sourceSchema.nullable === true && options.version === '3.0';
  delete sourceSchema.nullable;

  const writeOnlyProperties = new Set<string>();
  const rawProperties = asRecord(sourceSchema.properties);
  if (rawProperties) {
    for (const [propertyName, propertySchema] of Object.entries(rawProperties)) {
      if (asRecord(propertySchema)?.writeOnly === true) writeOnlyProperties.add(propertyName);
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

    if (!ASSERTION_KEYS.has(key)) return unsupported(`Unsupported OpenAPI schema keyword: ${key}`);

    if (key === 'items' && Array.isArray(value) && options.version === '3.0') {
      return unsupported('Tuple array items are unsupported in OpenAPI 3.0');
    }

    if (key === 'properties') {
      const properties = asRecord(value);
      if (!properties) continue;
      const nextProperties: JsonRecord = {};
      for (const [propertyName, propertySchema] of Object.entries(properties)) {
        if (writeOnlyProperties.has(propertyName)) continue;
        const child = normalizeSchema(root, propertySchema, { ...options, depth: depth + 1, rootSchema: false });
        const bad = hasUnsupported(child);
        if (bad) return unsupported(bad);
        nextProperties[propertyName] = child;
      }
      normalized.properties = nextProperties;
      continue;
    }

    if (key === 'required') {
      const required = mergeRequiredWithoutWriteOnly(value, writeOnlyProperties);
      if (required) normalized.required = required;
      continue;
    }

    const child = normalizeSchema(root, value, { ...options, depth: depth + 1, rootSchema: false });
    const bad = hasUnsupported(child);
    if (bad) return unsupported(bad);
    normalized[key] = child;
  }

  if (options.rootSchema) normalized.$schema = options.dialect ?? rootDialect(root, options.version, record);

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
      if (options.rootSchema) wrapper.$schema = options.dialect ?? rootDialect(root, options.version, record);
      return wrapper;
    }
  }

  return normalized;
}

export function packSchema(root: JsonRecord, schema: unknown, version: OpenApiVersion): PackedSchema {
  try {
    const dialect = rootDialect(root, version, asRecord(schema) ?? undefined);
    const normalized = normalizeSchema(root, schema, { version, rootSchema: true, dialect });
    const message = hasUnsupported(normalized);
    return message ? unsupported(message) : { schema: normalized };
  } catch (error) {
    return unsupported(error instanceof Error ? error.message : String(error));
  }
}

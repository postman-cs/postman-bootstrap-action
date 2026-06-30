import {
  buildClientSchema,
  buildSchema,
  getNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  type GraphQLArgument,
  type GraphQLField,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLOutputType,
  type GraphQLSchema,
  type GraphQLType
} from 'graphql';

type JsonRecord = Record<string, unknown>;

export type GraphQLOperationKind = 'query' | 'mutation' | 'subscription';

export type GraphQLTypeShapeKind = 'scalar' | 'enum' | 'object' | 'interface' | 'union' | 'input' | 'unknown';

/**
 * Structural description of a GraphQL type reference, flattened so the
 * instrumenter can emit deterministic shape assertions without re-walking the
 * `graphql` AST at instrumentation time. NonNull/list wrappers are recorded so
 * the instrumenter can assert null-ness, list-ness, and item null-ness.
 */
export interface GraphQLTypeRef {
  /** Wrapper-stripped named type, e.g. `User`, `String`, `ID`. */
  name: string;
  /** Classification of the named type. */
  kind: GraphQLTypeShapeKind;
  /** True when the outermost wrapper is NonNull (the value may not be null). */
  nonNull: boolean;
  /** True when, after the outer NonNull is stripped, the type is a list. */
  list: boolean;
  /** True when list items are themselves NonNull. */
  listItemNonNull: boolean;
}

export interface GraphQLArgumentDef {
  name: string;
  type: GraphQLTypeRef;
  required: boolean;
}

export interface GraphQLFieldDef {
  name: string;
  type: GraphQLTypeRef;
}

/**
 * One executable root field (an "operation" in this index): a top-level field
 * of the Query, Mutation, or Subscription root type.
 */
export interface GraphQLOperationDef {
  /** Stable operation id, e.g. `query.users`. */
  id: string;
  kind: GraphQLOperationKind;
  /** Root field name, e.g. `users`. */
  field: string;
  /** Return type of the root field. */
  returns: GraphQLTypeRef;
  /** Arguments declared on the root field, deterministically ordered. */
  args: GraphQLArgumentDef[];
  warnings: string[];
}

/**
 * Object/interface return type whose selectable fields are known, so the
 * instrumenter can assert presence of object sub-fields in the response.
 */
export interface GraphQLObjectShape {
  name: string;
  kind: 'object' | 'interface';
  fields: GraphQLFieldDef[];
}

export interface GraphQLContractIndex {
  /** Synthetic service name (the schema has no service concept). */
  service: string;
  operations: GraphQLOperationDef[];
  /** Selectable object/interface shapes keyed by type name, for field-presence assertions. */
  objectShapes: Record<string, GraphQLObjectShape>;
  warnings: string[];
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function classifyNamedType(named: GraphQLNamedType): GraphQLTypeShapeKind {
  if (isScalarType(named)) return 'scalar';
  if (isEnumType(named)) return 'enum';
  if (isObjectType(named)) return 'object';
  if (isInterfaceType(named)) return 'interface';
  if (isUnionType(named)) return 'union';
  if (isInputObjectType(named)) return 'input';
  return 'unknown';
}

function describeType(type: GraphQLType): GraphQLTypeRef {
  let current: GraphQLType = type;
  let nonNull = false;
  let list = false;
  let listItemNonNull = false;

  if (isNonNullType(current)) {
    nonNull = true;
    current = current.ofType;
  }
  if (isListType(current)) {
    list = true;
    current = current.ofType;
    if (isNonNullType(current)) {
      listItemNonNull = true;
      current = current.ofType;
    }
  }
  const named = getNamedType(current);
  return {
    name: named.name,
    kind: classifyNamedType(named),
    nonNull,
    list,
    listItemNonNull
  };
}

function describeArgument(arg: GraphQLArgument): GraphQLArgumentDef {
  const type = describeType(arg.type);
  return { name: arg.name, type, required: type.nonNull && arg.defaultValue === undefined };
}

function describeField(field: GraphQLField<unknown, unknown>): GraphQLFieldDef {
  return { name: field.name, type: describeType(field.type) };
}

function collectObjectShape(returns: GraphQLTypeRef, schema: GraphQLSchema, shapes: Record<string, GraphQLObjectShape>): void {
  if (shapes[returns.name]) return;
  if (returns.kind !== 'object' && returns.kind !== 'interface') return;
  const named = schema.getType(returns.name);
  if (!named || (!isObjectType(named) && !isInterfaceType(named))) return;
  const fieldMap = (named as GraphQLObjectType).getFields();
  shapes[returns.name] = {
    name: returns.name,
    kind: returns.kind,
    fields: Object.keys(fieldMap)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => describeField(fieldMap[key] as GraphQLField<unknown, unknown>))
  };
}

function collectRootOperations(
  rootType: GraphQLObjectType | null | undefined,
  kind: GraphQLOperationKind,
  schema: GraphQLSchema,
  shapes: Record<string, GraphQLObjectShape>
): GraphQLOperationDef[] {
  if (!rootType) return [];
  const fields = rootType.getFields();
  return Object.keys(fields)
    .sort((a, b) => a.localeCompare(b))
    .map((fieldName) => {
      const field = fields[fieldName] as GraphQLField<unknown, unknown>;
      const returns = describeType(field.type as GraphQLOutputType);
      collectObjectShape(returns, schema, shapes);
      const opWarnings: string[] = [];
      if (kind === 'subscription') {
        opWarnings.push(
          `GQL_SUBSCRIPTION_NOT_EXECUTABLE: subscription root field ${fieldName} is emitted as a graphql-request item but the Postman CLI cannot execute subscriptions; live assertions will not run`
        );
      }
      if (returns.kind === 'union') {
        opWarnings.push(
          `GQL_UNION_RETURN_NOT_SHAPE_ASSERTED: ${kind}.${fieldName} returns union ${returns.name}; only data.${fieldName} presence is asserted, not member-type fields`
        );
      }
      if (returns.kind === 'unknown') {
        opWarnings.push(
          `GQL_UNKNOWN_RETURN_TYPE: ${kind}.${fieldName} return type ${returns.name} could not be classified; only data.${fieldName} presence is asserted`
        );
      }
      return {
        id: `${kind}.${fieldName}`,
        kind,
        field: fieldName,
        returns,
        args: field.args.map(describeArgument).sort((a, b) => a.name.localeCompare(b.name)),
        warnings: opWarnings
      } satisfies GraphQLOperationDef;
    });
}

function looksLikeIntrospection(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  if (asRecord(record.__schema)) return true;
  const data = asRecord(record.data);
  return Boolean(data && asRecord(data.__schema));
}

function buildSchemaFromIntrospection(value: JsonRecord): GraphQLSchema {
  const introspection = asRecord(value.__schema)
    ? (value as unknown as { __schema: unknown })
    : (asRecord(value.data) as { __schema: unknown });
  // buildClientSchema validates the introspection shape and throws on malformed input.
  return buildClientSchema(introspection as Parameters<typeof buildClientSchema>[0]);
}

/**
 * Parse a GraphQL contract from either SDL text or an introspection JSON
 * document into a flat, deterministic contract index. SDL is parsed with
 * `buildSchema`; introspection JSON (raw `{ __schema }` or a `{ data: { __schema } }`
 * envelope) is parsed with `buildClientSchema`. Throws `GQL_PARSE_FAILED` /
 * `GQL_NO_EXECUTABLE_OPERATIONS` on unusable input.
 */
export function parseGraphQLSchema(content: string, opts: { service?: string } = {}): GraphQLContractIndex {
  const trimmed = String(content ?? '').trim();
  if (!trimmed) throw new Error('GQL_PARSE_FAILED: GraphQL schema content is empty');

  let schema: GraphQLSchema;
  let parsedJson: unknown;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      parsedJson = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`GQL_PARSE_FAILED: content looked like JSON but did not parse (${error instanceof Error ? error.message : String(error)})`, { cause: error });
    }
  }
  try {
    if (parsedJson !== undefined && looksLikeIntrospection(parsedJson)) {
      schema = buildSchemaFromIntrospection(asRecord(parsedJson) as JsonRecord);
    } else if (parsedJson !== undefined) {
      throw new Error('JSON content is not a GraphQL introspection document (missing __schema)');
    } else {
      schema = buildSchema(trimmed, { assumeValidSDL: false });
    }
  } catch (error) {
    throw new Error(`GQL_PARSE_FAILED: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  const warnings: string[] = [];
  const objectShapes: Record<string, GraphQLObjectShape> = {};
  const operations: GraphQLOperationDef[] = [
    ...collectRootOperations(schema.getQueryType(), 'query', schema, objectShapes),
    ...collectRootOperations(schema.getMutationType(), 'mutation', schema, objectShapes),
    ...collectRootOperations(schema.getSubscriptionType(), 'subscription', schema, objectShapes)
  ];

  if (operations.length === 0) {
    throw new Error('GQL_NO_EXECUTABLE_OPERATIONS: schema defines no Query, Mutation, or Subscription root fields');
  }

  for (const operation of operations) warnings.push(...operation.warnings);

  return {
    service: opts.service?.trim() || 'GraphQL',
    operations,
    objectShapes,
    warnings
  };
}

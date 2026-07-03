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
import { buildOperationDocument } from './builder.js';
import { lintGeneratedDocument, lintGraphQLSchema, lintIntrospectionJson, lintSdlDocument } from './schema-lints.js';
import { selectFields, type SelectedField } from './selection.js';

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
  /** True when the OUTERMOST list's items are themselves NonNull. */
  listItemNonNull: boolean;
  /**
   * Ordered list wrappers from OUTER to INNER, one entry per list dimension, so
   * nested lists (`[[Int]]`, `[[T!]!]`) are asserted at every depth. Each entry's
   * `itemNonNull` says whether the item at that dimension is NonNull. Empty when
   * the type is not a list; `list`/`listItemNonNull` mirror the outermost entry
   * for backward compatibility.
   */
  lists: Array<{ itemNonNull: boolean }>;
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
  /** Enum value sets keyed by enum type name, for runtime membership assertions. */
  enumValues: Record<string, string[]>;
  /** Union member object-type names keyed by union type name, for runtime __typename membership assertions. */
  unionMembers: Record<string, string[]>;
  /** Implementing object-type names keyed by interface type name, for runtime __typename membership assertions. */
  interfacePossibleTypes: Record<string, string[]>;
  /** Named type -> kind for every non-introspection schema type (introspection drift probe). */
  typeKinds: Record<string, GraphQLTypeShapeKind>;
  /** Sorted field names per object/interface type (introspection drift probe). */
  typeFields: Record<string, string[]>;
  /** SDL-rendered field type signature per object/interface type field (introspection drift probe). */
  typeFieldTypeSignatures: Record<string, Record<string, string>>;
  /** Declared root operation type names (introspection drift probe). */
  rootTypes: { query?: string; mutation?: string; subscription?: string };
  /** Deprecated field names per object/interface type (introspection drift probe). */
  deprecatedFields: Record<string, string[]>;
  /** Deprecated value names per enum type (introspection drift probe). */
  deprecatedEnumValues: Record<string, string[]>;
  /** True when the schema carries Apollo Federation subgraph directives (_service probe gate). */
  federated: boolean;
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

  if (isNonNullType(current)) {
    nonNull = true;
    current = current.ofType;
  }
  // Peel EVERY list dimension (not just the outermost) so nested lists like
  // `[[Int]]` / `[[T!]!]` are recorded and asserted at every depth. Each list's
  // item may carry its own NonNull wrapper.
  const lists: Array<{ itemNonNull: boolean }> = [];
  while (isListType(current)) {
    current = current.ofType;
    let itemNonNull = false;
    if (isNonNullType(current)) {
      itemNonNull = true;
      current = current.ofType;
    }
    lists.push({ itemNonNull });
  }
  const named = getNamedType(current);
  return {
    name: named.name,
    kind: classifyNamedType(named),
    nonNull,
    list: lists.length > 0,
    listItemNonNull: lists.length > 0 ? lists[0].itemNonNull : false,
    lists
  };
}

function describeArgument(arg: GraphQLArgument): GraphQLArgumentDef {
  const type = describeType(arg.type);
  return { name: arg.name, type, required: type.nonNull && arg.defaultValue === undefined };
}

function describeField(field: GraphQLField<unknown, unknown>): GraphQLFieldDef {
  return { name: field.name, type: describeType(field.type) };
}

/**
 * Render a GraphQLTypeRef back to SDL type notation (e.g. `[User!]!`). The
 * introspection drift probe compares live field type wrapper chains against
 * this schema-of-record rendering.
 */
export function renderTypeRefSdl(ref: GraphQLTypeRef): string {
  let inner = ref.name;
  for (let i = ref.lists.length - 1; i >= 0; i -= 1) {
    inner = ref.lists[i].itemNonNull ? `[${inner}!]` : `[${inner}]`;
  }
  return ref.nonNull ? `${inner}!` : inner;
}

function collectObjectShape(returns: GraphQLTypeRef, schema: GraphQLSchema, shapes: Record<string, GraphQLObjectShape>): void {
  if (shapes[returns.name]) return;
  if (returns.kind !== 'object' && returns.kind !== 'interface') return;
  const named = schema.getType(returns.name);
  if (!named || (!isObjectType(named) && !isInterfaceType(named))) return;
  const fieldMap = (named as GraphQLObjectType).getFields();
  const shape: GraphQLObjectShape = {
    name: returns.name,
    kind: returns.kind,
    fields: Object.keys(fieldMap)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => describeField(fieldMap[key] as GraphQLField<unknown, unknown>))
  };
  shapes[returns.name] = shape;
  // Relay connections are expanded past the selection depth cap, so the
  // shapes their expansion selects into (the connection itself when it is a
  // field, plus pageInfo and edge types) must be indexed too. Registering
  // before recursing keeps cyclic schemas terminating.
  for (const field of shape.fields) {
    const isConnectionMember = returns.name.endsWith('Connection') && (field.name === 'pageInfo' || field.name === 'edges');
    const isConnectionField = field.type.kind === 'object' && field.type.name.endsWith('Connection');
    if (isConnectionMember || isConnectionField) collectObjectShape(field.type, schema, shapes);
  }
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
          `GQL_UNION_MEMBER_FIELDS_NOT_EXPANDED: ${kind}.${fieldName} returns union ${returns.name}; its __typename is validated (object + declared member name) but member-specific fields are not expanded or asserted`
        );
      }
      if (field.deprecationReason !== undefined && field.deprecationReason !== null) {
        opWarnings.push(
          'GQL_DEPRECATED_FIELD_SELECTED: ' + kind + '.' + fieldName + ' is deprecated (' + (field.deprecationReason || 'no reason given') + '); the generated operation still exercises it'
        );
      }
      if (returns.kind === 'unknown') {
        opWarnings.push(
          `GQL_UNKNOWN_RETURN_TYPE: ${kind}.${fieldName} return type ${returns.name} could not be classified; only data.${fieldName} presence is asserted`
        );
      }
      // Deprecated arguments the generated document actually passes: required
      // args are declared as variables and forwarded, so a deprecated required
      // arg is exercised by every run (GraphQL spec 4.2.3 deprecation).
      for (const arg of field.args) {
        if (arg.deprecationReason == null) continue;
        if (!describeArgument(arg).required) continue;
        opWarnings.push(
          'GQL_DEPRECATED_ARGUMENT_USED: ' + kind + '.' + fieldName + ' argument ' + arg.name + ' is deprecated (' + (arg.deprecationReason || 'no reason given') + '); the generated operation still passes it'
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

function selectIntrospectionRootWarnings(warnings: string[]): string[] {
  return warnings.filter((warning) => warning.startsWith('GQL_INTROSPECTION_ROOT_INVALID:') || warning.startsWith('GQL_INTROSPECTION_ROOTS_NOT_DISTINCT:'));
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
  let introspectionWarnings: string[] | null = null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      parsedJson = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`GQL_PARSE_FAILED: content looked like JSON but did not parse (${error instanceof Error ? error.message : String(error)})`, { cause: error });
    }
  }
  try {
    if (parsedJson !== undefined && looksLikeIntrospection(parsedJson)) {
      introspectionWarnings = lintIntrospectionJson(parsedJson);
      try {
        schema = buildSchemaFromIntrospection(asRecord(parsedJson) as JsonRecord);
      } catch (error) {
        const rootWarnings = selectIntrospectionRootWarnings(introspectionWarnings);
        const rootDiagnostics = rootWarnings.length > 0 ? ' ' + rootWarnings.join(' ') : '';
        throw new Error(`GQL_PARSE_FAILED: ${error instanceof Error ? error.message : String(error)}${rootDiagnostics}`, { cause: error });
      }
    } else if (parsedJson !== undefined) {
      throw new Error('JSON content is not a GraphQL introspection document (missing __schema)');
    } else {
      schema = buildSchema(trimmed, { assumeValidSDL: false });
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('GQL_PARSE_FAILED:')) throw error;
    throw new Error(`GQL_PARSE_FAILED: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  const warnings: string[] = [];
  // Full type-system validation (graphql-js validateSchema) plus input-format
  // lints beyond what buildSchema/buildClientSchema enforce during construction.
  warnings.push(...lintGraphQLSchema(schema));
  if (parsedJson !== undefined) {
    warnings.push(...(introspectionWarnings ?? lintIntrospectionJson(parsedJson)));
  } else {
    warnings.push(...lintSdlDocument(trimmed));
  }
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

  const enumValues: Record<string, string[]> = {};
  const unionMembers: Record<string, string[]> = {};
  const interfacePossibleTypes: Record<string, string[]> = {};
  const typeKinds: Record<string, GraphQLTypeShapeKind> = {};
  const typeFields: Record<string, string[]> = {};
  const typeFieldTypeSignatures: Record<string, Record<string, string>> = {};
  const deprecatedFields: Record<string, string[]> = {};
  const deprecatedEnumValues: Record<string, string[]> = {};
  for (const namedType of Object.values(schema.getTypeMap())) {
    if (namedType.name.startsWith('__')) continue;
    typeKinds[namedType.name] = classifyNamedType(namedType);
    if (isEnumType(namedType)) {
      enumValues[namedType.name] = namedType.getValues().map((value) => value.name);
      const deprecatedValues = namedType.getValues().filter((value) => value.deprecationReason != null).map((value) => value.name).sort((x, y) => x.localeCompare(y));
      if (deprecatedValues.length > 0) deprecatedEnumValues[namedType.name] = deprecatedValues;
    } else if (isUnionType(namedType)) {
      unionMembers[namedType.name] = namedType.getTypes().map((member) => member.name).sort((x, y) => x.localeCompare(y));
    } else if (isObjectType(namedType) || isInterfaceType(namedType)) {
      typeFields[namedType.name] = Object.keys(namedType.getFields()).sort((x, y) => x.localeCompare(y));
      const signatures: Record<string, string> = {};
      for (const fieldName of typeFields[namedType.name]) {
        signatures[fieldName] = renderTypeRefSdl(describeType(namedType.getFields()[fieldName]!.type));
      }
      typeFieldTypeSignatures[namedType.name] = signatures;
      if (isInterfaceType(namedType)) {
        interfacePossibleTypes[namedType.name] = schema.getPossibleTypes(namedType).map((member) => member.name).sort((x, y) => x.localeCompare(y));
      }
      const fieldNames = Object.values(namedType.getFields()).filter((fieldDef) => fieldDef.deprecationReason != null).map((fieldDef) => fieldDef.name).sort((x, y) => x.localeCompare(y));
      if (fieldNames.length > 0) deprecatedFields[namedType.name] = fieldNames;
    }
  }
  const rootTypes: GraphQLContractIndex['rootTypes'] = {};
  if (schema.getQueryType()) rootTypes.query = schema.getQueryType()!.name;
  if (schema.getMutationType()) rootTypes.mutation = schema.getMutationType()!.name;
  if (schema.getSubscriptionType()) rootTypes.subscription = schema.getSubscriptionType()!.name;
  // Apollo subgraph gate: federation directives on the schema or the _Service
  // SDL type mean the endpoint must answer `query { _service { sdl } }`.
  const federationDirectives = new Set(['key', 'external', 'requires', 'provides', 'shareable', 'override', 'interfaceObject']);
  const federated = schema.getDirectives().some((directive) => federationDirectives.has(directive.name)) || '_Service' in schema.getTypeMap();

  const index: GraphQLContractIndex = {
    service: opts.service?.trim() || 'GraphQL',
    operations,
    objectShapes,
    enumValues,
    unionMembers,
    interfacePossibleTypes,
    typeKinds,
    typeFields,
    typeFieldTypeSignatures,
    rootTypes,
    deprecatedFields,
    deprecatedEnumValues,
    federated,
    warnings
  };
  // Deprecated members exercised by the generated documents beyond the root
  // field: nested selected fields (Relay expansion and depth>1 composites) are
  // checked against the schema's deprecation metadata (GraphQL spec 4.2.3).
  for (const operation of operations) {
    warnings.push(...collectDeprecatedSelectionWarnings(schema, operation, index));
  }
  // Self-check (GraphQL spec 5): every generated operation document must pass
  // validation against the schema it was derived from; a failure here is a
  // generator defect surfaced as a warning, never silently shipped.
  for (const operation of operations) {
    warnings.push(...lintGeneratedDocument(schema, operation.id, buildOperationDocument(operation, index)));
  }
  return index;
}

/**
 * Walk the operation's generated selection tree (the SAME selection the builder
 * renders) and warn for every deprecated nested field it selects. The root
 * field's own deprecation is reported by collectRootOperations.
 */
function collectDeprecatedSelectionWarnings(
  schema: GraphQLSchema,
  operation: GraphQLOperationDef,
  index: GraphQLContractIndex
): string[] {
  const warnings: string[] = [];
  const visit = (typeName: string, selection: SelectedField[] | null): void => {
    if (!selection) return;
    const named = schema.getType(typeName);
    if (!named || (!isObjectType(named) && !isInterfaceType(named))) return;
    const fieldMap = (named as GraphQLObjectType).getFields();
    for (const selected of selection) {
      if (selected.name === '__typename') continue;
      const fieldDef = fieldMap[selected.name];
      if (!fieldDef) continue;
      if (fieldDef.deprecationReason != null) {
        warnings.push(
          'GQL_DEPRECATED_FIELD_SELECTED: ' + operation.id + ' selects deprecated field ' + typeName + '.' + selected.name + ' (' + (fieldDef.deprecationReason || 'no reason given') + '); the generated operation still exercises it'
        );
      }
      visit(selected.type.name, selected.selection);
    }
  };
  visit(operation.returns.name, selectFields(operation.returns, index, 1));
  return warnings;
}

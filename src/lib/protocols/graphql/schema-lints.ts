// Generation-time (static) lints for GraphQL schema input, beyond what
// buildSchema/buildClientSchema enforce while constructing the schema object.
//
// buildSchema validates SDL syntax and SDL-only rules; buildClientSchema
// validates introspection structure just far enough to construct a schema.
// Neither runs full type-system validation (root operation object-ness,
// interface implementation completeness, input-object cycle nullability,
// reserved __ names, union member object-ness) - that is graphql-js's
// validateSchema, surfaced here as GQL_SCHEMA_INVALID warnings. Introspection
// JSON additionally gets raw-shape lints for violations buildClientSchema
// silently tolerates (duplicate type names, NON_NULL directly wrapping
// NON_NULL, non-boolean isDeprecated, non-OBJECT possibleTypes, unknown
// directive locations, and built-in directive shape drift).
import {
  DirectiveLocation,
  Kind,
  buildSchema,
  getNamedType,
  introspectionFromSchema,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isNonNullType,
  isObjectType,
  isScalarType,
  parse,
  specifiedDirectives,
  specifiedScalarTypes,
  validate,
  validateSchema,
  type DocumentNode,
  type GraphQLSchema
} from 'graphql';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const BUILT_IN_SCALAR_NAMES = new Set(specifiedScalarTypes.map((scalar) => scalar.name));
const VALID_TYPE_KINDS = new Set(['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL']);
const VALID_DIRECTIVE_LOCATIONS = new Set<string>(Object.values(DirectiveLocation));

interface IntrospectionDirectiveArgShape {
  name: string;
  type: string | null;
  defaultValue: unknown;
}

interface IntrospectionDirectiveShape {
  isRepeatable: boolean;
  locations: string[];
  args: IntrospectionDirectiveArgShape[];
}

function renderIntrospectionTypeRef(ref: unknown, depth = 0): string | null {
  const current = asRecord(ref);
  if (!current || depth > 32 || typeof current.kind !== 'string') return null;
  if (current.kind === 'NON_NULL') {
    const inner = renderIntrospectionTypeRef(current.ofType, depth + 1);
    return inner ? inner + '!' : null;
  }
  if (current.kind === 'LIST') {
    const inner = renderIntrospectionTypeRef(current.ofType, depth + 1);
    return inner ? '[' + inner + ']' : null;
  }
  return typeof current.name === 'string' && current.name.length > 0 ? current.name : null;
}

function readIntrospectionDirectiveShape(value: unknown): IntrospectionDirectiveShape | null {
  const directive = asRecord(value);
  if (!directive || typeof directive.isRepeatable !== 'boolean') return null;
  return {
    isRepeatable: directive.isRepeatable,
    locations: asArray(directive.locations).filter((entry): entry is string => typeof entry === 'string'),
    args: asArray(directive.args)
      .map(asRecord)
      .filter((entry): entry is JsonRecord => entry !== null && typeof entry.name === 'string')
      .map((arg) => ({
        name: arg.name as string,
        type: renderIntrospectionTypeRef(arg.type),
        defaultValue: Object.prototype.hasOwnProperty.call(arg, 'defaultValue') ? arg.defaultValue : undefined
      }))
  };
}

const BUILT_IN_INTROSPECTION_DIRECTIVE_SHAPES = (() => {
  const shapes = new Map<string, IntrospectionDirectiveShape>();
  const reference = introspectionFromSchema(buildSchema('type Query { _: Boolean }')) as unknown;
  const schemaRecord = asRecord(asRecord(reference)?.__schema);
  if (!schemaRecord) return shapes;
  for (const entry of asArray(schemaRecord.directives)) {
    const directive = asRecord(entry);
    if (!directive || typeof directive.name !== 'string') continue;
    const shape = readIntrospectionDirectiveShape(directive);
    if (shape) shapes.set(directive.name, shape);
  }
  return shapes;
})();

/**
 * Full type-system validation of a constructed schema (GraphQL spec 3: Type
 * System). Every violation graphql-js validateSchema reports becomes a
 * GQL_SCHEMA_INVALID warning; @specifiedBy URLs are additionally checked for
 * URL validity (GraphQL spec 3.5.1: the argument must be a URL).
 */
export function lintGraphQLSchema(schema: GraphQLSchema): string[] {
  const warnings: string[] = [];
  for (const error of validateSchema(schema)) {
    warnings.push('GQL_SCHEMA_INVALID: ' + error.message);
  }
  for (const named of Object.values(schema.getTypeMap())) {
    if (!isScalarType(named) || named.name.startsWith('__')) continue;
    const url = named.specifiedByURL;
    if (url === undefined || url === null) continue;
    if (BUILT_IN_SCALAR_NAMES.has(named.name)) {
      warnings.push('GQL_SPECIFIED_BY_ON_BUILT_IN: built-in scalar ' + named.name + ' must not carry @specifiedBy (GraphQL spec 3.5.1)');
      continue;
    }
    try {
      new URL(url);
    } catch {
      warnings.push('GQL_SPECIFIED_BY_URL_INVALID: scalar ' + named.name + ' @specifiedBy argument is not a valid URL: ' + url);
    }
  }
  warnings.push(...lintRelayConnections(schema));
  warnings.push(...lintDeprecatedArguments(schema));
  warnings.push(...lintRootOperationTypes(schema));
  warnings.push(...lintBuiltInDirectiveShapes(schema));
  warnings.push(...lintDirectiveDefinitions(schema));
  warnings.push(...lintOneOfInputObjects(schema));
  return warnings;
}

/**
 * Root operation types must be Object types (validateSchema enforces that) and
 * must be distinct from one another (GraphQL September 2025 edition 3.3); the
 * warning carries the full root map as a diagnostic.
 */
function lintRootOperationTypes(schema: GraphQLSchema): string[] {
  const warnings: string[] = [];
  const roots: Array<[string, string]> = [];
  if (schema.getQueryType()) roots.push(['query', schema.getQueryType()!.name]);
  if (schema.getMutationType()) roots.push(['mutation', schema.getMutationType()!.name]);
  if (schema.getSubscriptionType()) roots.push(['subscription', schema.getSubscriptionType()!.name]);
  const rootMap = roots.map(([kind, name]) => kind + '=' + name).join(', ');
  const seen = new Map<string, string>();
  for (const [kind, name] of roots) {
    const prior = seen.get(name);
    if (prior) {
      warnings.push('GQL_ROOT_TYPES_NOT_DISTINCT: the ' + prior + ' and ' + kind + ' root operation types are both ' + name + '; root operation types must be distinct (GraphQL September 2025 edition 3.3). Root map: ' + rootMap);
    } else {
      seen.set(name, kind);
    }
  }
  return warnings;
}

// Core locations each built-in directive must keep; @deprecated's location set
// grew in the September 2025 edition, so only the October 2021 pair is required
// while the newer locations are accepted as valid extras.
const BUILT_IN_DIRECTIVE_REQUIRED_LOCATIONS: Record<string, string[]> = {
  skip: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'],
  include: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'],
  deprecated: ['FIELD_DEFINITION', 'ENUM_VALUE'],
  specifiedBy: ['SCALAR']
};

/**
 * A schema (SDL or introspection) that redefines @skip, @include, @deprecated,
 * or @specifiedBy must keep the spec-defined argument and location shape
 * (GraphQL spec 3.13); graphql-js silently adopts the redefinition.
 */
function lintBuiltInDirectiveShapes(schema: GraphQLSchema): string[] {
  const warnings: string[] = [];
  for (const spec of specifiedDirectives) {
    const actual = schema.getDirective(spec.name);
    if (!actual || actual === spec) continue;
    const specLocations = new Set<string>(spec.locations);
    for (const location of BUILT_IN_DIRECTIVE_REQUIRED_LOCATIONS[spec.name] ?? [...spec.locations]) {
      if (!(actual.locations as readonly string[]).includes(location)) {
        warnings.push('GQL_BUILT_IN_DIRECTIVE_SHAPE_DRIFT: @' + spec.name + ' must be valid on ' + location + ' (GraphQL spec 3.13); the schema definition omits it');
      }
    }
    for (const location of actual.locations) {
      if (!specLocations.has(location)) {
        warnings.push('GQL_BUILT_IN_DIRECTIVE_SHAPE_DRIFT: @' + spec.name + ' declares location ' + location + ' beyond its spec definition (GraphQL spec 3.13)');
      }
    }
    const specArgs = new Map(spec.args.map((arg) => [arg.name, String(arg.type)]));
    const actualArgs = new Map(actual.args.map((arg) => [arg.name, String(arg.type)]));
    for (const [name, type] of specArgs) {
      const actualType = actualArgs.get(name);
      if (actualType === undefined) {
        warnings.push('GQL_BUILT_IN_DIRECTIVE_SHAPE_DRIFT: @' + spec.name + ' must declare argument ' + name + ': ' + type + ' (GraphQL spec 3.13)');
      } else if (actualType !== type) {
        warnings.push('GQL_BUILT_IN_DIRECTIVE_SHAPE_DRIFT: @' + spec.name + ' argument ' + name + ' must be ' + type + ' (GraphQL spec 3.13); got ' + actualType);
      }
    }
    for (const name of actualArgs.keys()) {
      if (!specArgs.has(name)) {
        warnings.push('GQL_BUILT_IN_DIRECTIVE_SHAPE_DRIFT: @' + spec.name + ' declares argument ' + name + ' beyond its spec definition (GraphQL spec 3.13)');
      }
    }
  }
  return warnings;
}

/**
 * Explicit directive-definition diagnostics beyond validateSchema: reserved
 * names, and self-reference (a directive used within its own definition,
 * directly on its arguments or indirectly through its argument input-type
 * closure), which the type system forbids (GraphQL spec 3.13).
 */
function lintDirectiveDefinitions(schema: GraphQLSchema): string[] {
  const warnings: string[] = [];
  const builtIn = new Set(specifiedDirectives.map((directive) => directive.name));
  const usesDirective = (astNode: unknown, name: string): boolean => {
    const record = asRecord(astNode);
    if (!record) return false;
    return asArray(record.directives).some((entry) => {
      const applied = asRecord(entry);
      const appliedName = applied ? asRecord(applied.name) : null;
      return Boolean(appliedName && appliedName.value === name);
    });
  };
  for (const directive of schema.getDirectives()) {
    if (builtIn.has(directive.name)) continue;
    if (directive.name.startsWith('__')) {
      warnings.push('GQL_DIRECTIVE_NAME_RESERVED: directive @' + directive.name + ' must not begin with "__" (GraphQL spec 3.13)');
    }
    let selfReferenced = false;
    const ownAst = asRecord(directive.astNode as unknown);
    if (ownAst) {
      for (const argNode of asArray(ownAst.arguments)) {
        if (usesDirective(argNode, directive.name)) selfReferenced = true;
      }
    }
    const visited = new Set<string>();
    const queue = directive.args.map((arg) => getNamedType(arg.type));
    while (queue.length > 0 && !selfReferenced) {
      const named = queue.pop()!;
      if (visited.has(named.name)) continue;
      visited.add(named.name);
      if (usesDirective(named.astNode as unknown, directive.name)) {
        selfReferenced = true;
        break;
      }
      if (isInputObjectType(named)) {
        for (const field of Object.values(named.getFields())) {
          if (usesDirective(field.astNode as unknown, directive.name)) {
            selfReferenced = true;
            break;
          }
          queue.push(getNamedType(field.type));
        }
      } else if (isEnumType(named)) {
        for (const value of named.getValues()) {
          if (usesDirective(value.astNode as unknown, directive.name)) {
            selfReferenced = true;
            break;
          }
        }
      }
    }
    if (selfReferenced) {
      warnings.push('GQL_DIRECTIVE_SELF_REFERENCED: directive @' + directive.name + ' is referenced within its own definition (directly or through its argument types), which the type system forbids (GraphQL spec 3.13)');
    }
  }
  return warnings;
}

/**
 * OneOf input objects (September 2025 edition 3.10): every field of a @oneOf
 * input object must be nullable and must not declare a default value. Literal
 * and default value type-compatibility itself is validated by validateSchema
 * (surfaced as GQL_SCHEMA_INVALID "has invalid default value").
 */
function lintOneOfInputObjects(schema: GraphQLSchema): string[] {
  const warnings: string[] = [];
  for (const named of Object.values(schema.getTypeMap())) {
    if (!isInputObjectType(named) || named.name.startsWith('__')) continue;
    if (!(named as { isOneOf?: boolean }).isOneOf) continue;
    for (const field of Object.values(named.getFields())) {
      if (isNonNullType(field.type)) {
        warnings.push('GQL_ONE_OF_FIELD_NON_NULL: @oneOf input object ' + named.name + ' field ' + field.name + ' must be nullable (GraphQL September 2025 edition 3.10: OneOf Input Objects)');
      }
      if (field.defaultValue !== undefined) {
        warnings.push('GQL_ONE_OF_FIELD_DEFAULT: @oneOf input object ' + named.name + ' field ' + field.name + ' must not declare a default value (GraphQL September 2025 edition 3.10: OneOf Input Objects)');
      }
    }
  }
  return warnings;
}

/**
 * @deprecated on arguments and input fields is defined by the September 2025
 * edition (3.13.3), not October 2021, so its use is flagged as edition drift;
 * the newer edition also forbids it outright on REQUIRED arguments and input
 * fields, which is reported as its own violation.
 */
function lintDeprecatedArguments(schema: GraphQLSchema): string[] {
  const warnings: string[] = [];
  const flag = (kind: string, owner: string, name: string, type: unknown, hasDefault: boolean): void => {
    warnings.push('GQL_DEPRECATED_INPUT_EDITION_DRIFT: ' + kind + ' ' + owner + '.' + name + ' uses @deprecated, which the October 2021 edition does not define for ' + kind + 's (September 2025 edition 3.13.3); October-2021 introspection clients will not see it');
    if (isNonNullType(type) && !hasDefault) {
      warnings.push('GQL_DEPRECATED_REQUIRED_INPUT: ' + kind + ' ' + owner + '.' + name + ' is required (non-null without default) and must not be @deprecated (GraphQL September 2025 edition 3.13.3)');
    }
  };
  for (const named of Object.values(schema.getTypeMap())) {
    if (named.name.startsWith('__')) continue;
    if (isObjectType(named) || isInterfaceType(named)) {
      for (const field of Object.values(named.getFields())) {
        for (const arg of field.args) {
          if (arg.deprecationReason == null) continue;
          flag('argument', named.name + '.' + field.name, arg.name, arg.type, arg.defaultValue !== undefined);
        }
      }
    } else if (isInputObjectType(named)) {
      for (const inputField of Object.values(named.getFields())) {
        if (inputField.deprecationReason == null) continue;
        flag('input field', named.name, inputField.name, inputField.type, inputField.defaultValue !== undefined);
      }
    }
  }
  return warnings;
}

/**
 * Relay Cursor Connections conformance for schemas that opt into the pattern
 * (types named *Connection / the PageInfo type). Convention-gated: schemas
 * without the naming pattern emit nothing. Relay spec sections 2 (connection
 * types), 3 (edge types), and 5.1 (PageInfo) drive the shape requirements.
 */
function lintRelayConnections(schema: GraphQLSchema): string[] {
  const warnings: string[] = [];
  const typeMap = schema.getTypeMap();
  for (const named of Object.values(typeMap)) {
    if (named.name.startsWith('__') || !named.name.endsWith('Connection')) continue;
    if (!isObjectType(named)) {
      warnings.push('GQL_RELAY_CONNECTION_INVALID: ' + named.name + ' follows the *Connection naming pattern but is not an Object type (Relay Cursor Connections spec section 2)');
      continue;
    }
    const fields = named.getFields();
    if (!fields.edges) {
      warnings.push('GQL_RELAY_CONNECTION_INVALID: connection type ' + named.name + ' must expose an edges field (Relay Cursor Connections spec section 2)');
    } else {
      const edgeType = getNamedType(fields.edges.type);
      if (isObjectType(edgeType)) {
        const edgeFields = edgeType.getFields();
        if (!edgeFields.node) warnings.push('GQL_RELAY_EDGE_INVALID: edge type ' + edgeType.name + ' must expose a node field (Relay Cursor Connections spec section 3)');
        if (!edgeFields.cursor) warnings.push('GQL_RELAY_EDGE_INVALID: edge type ' + edgeType.name + ' must expose a cursor field (Relay Cursor Connections spec section 3)');
      }
    }
    if (!fields.pageInfo) {
      warnings.push('GQL_RELAY_CONNECTION_INVALID: connection type ' + named.name + ' must expose a pageInfo field (Relay Cursor Connections spec section 2)');
    } else {
      if (!isNonNullType(fields.pageInfo.type)) {
        warnings.push('GQL_RELAY_CONNECTION_INVALID: ' + named.name + '.pageInfo must be non-null (Relay Cursor Connections spec section 2)');
      }
      if (getNamedType(fields.pageInfo.type).name !== 'PageInfo') {
        warnings.push('GQL_RELAY_CONNECTION_INVALID: ' + named.name + '.pageInfo must be the PageInfo type (Relay Cursor Connections spec section 2); got ' + getNamedType(fields.pageInfo.type).name);
      }
    }
  }
  const pageInfo = typeMap.PageInfo;
  if (pageInfo && isObjectType(pageInfo)) {
    const fields = pageInfo.getFields();
    for (const required of ['hasNextPage', 'hasPreviousPage']) {
      const field = fields[required];
      if (!field) {
        warnings.push('GQL_RELAY_PAGEINFO_INVALID: PageInfo must expose ' + required + ' (Relay Cursor Connections spec section 5.1)');
        continue;
      }
      if (!isNonNullType(field.type) || getNamedType(field.type).name !== 'Boolean') {
        warnings.push('GQL_RELAY_PAGEINFO_INVALID: PageInfo.' + required + ' must be a non-null Boolean (Relay Cursor Connections spec section 5.1)');
      }
    }
  }
  return warnings;
}

/**
 * SDL-source lints for rules buildSchema tolerates: built-in scalars must be
 * omitted from type-system definition language (GraphQL spec 3.5), but
 * graphql-js accepts an explicit redefinition and silently shadows the
 * built-in.
 */
export function lintSdlDocument(sdl: string): string[] {
  let document: DocumentNode;
  try {
    document = parse(sdl);
  } catch {
    // buildSchema already parsed this text; a failure here means the caller
    // passed different content, which parseGraphQLSchema has already rejected.
    return [];
  }
  const warnings: string[] = [];
  for (const definition of document.definitions) {
    if (definition.kind === Kind.SCALAR_TYPE_DEFINITION && BUILT_IN_SCALAR_NAMES.has(definition.name.value)) {
      warnings.push('GQL_BUILT_IN_SCALAR_REDEFINED: SDL must omit built-in scalar ' + definition.name.value + ' (GraphQL spec 3.5); the explicit definition shadows the built-in');
    }
  }
  return warnings;
}

// One warning per type reference: NON_NULL directly wrapping NON_NULL is
// forbidden by the type system (GraphQL spec 3.12) but buildClientSchema
// constructs it without complaint.
function lintTypeRefChain(ref: unknown, context: string, warnings: string[]): void {
  let current = asRecord(ref);
  let depth = 0;
  while (current && depth < 32) {
    const ofType = asRecord(current.ofType);
    if (current.kind === 'NON_NULL' && ofType && ofType.kind === 'NON_NULL') {
      warnings.push('GQL_INTROSPECTION_NONNULL_NESTED: ' + context + ' wraps NON_NULL directly inside NON_NULL, which the type system forbids (GraphQL spec 3.12)');
      return;
    }
    current = ofType;
    depth += 1;
  }
}

function lintDeprecationFlags(entries: unknown[], context: string, warnings: string[]): void {
  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) continue;
    const label = context + '.' + (typeof record.name === 'string' ? record.name : '<unnamed>');
    if (record.isDeprecated !== undefined && typeof record.isDeprecated !== 'boolean') {
      warnings.push('GQL_INTROSPECTION_DEPRECATION_INVALID: ' + label + ' isDeprecated must be a boolean (introspection __Field/__EnumValue contract)');
    }
    if (record.deprecationReason !== undefined && record.deprecationReason !== null && typeof record.deprecationReason !== 'string') {
      warnings.push('GQL_INTROSPECTION_DEPRECATION_INVALID: ' + label + ' deprecationReason must be a string or null');
    }
    if (record.isDeprecated === false && typeof record.deprecationReason === 'string' && record.deprecationReason.length > 0) {
      warnings.push('GQL_INTROSPECTION_DEPRECATION_INVALID: ' + label + ' carries a deprecationReason while isDeprecated is false');
    }
  }
}

function formatIntrospectionValue(value: unknown): string {
  return value === undefined ? '<missing>' : JSON.stringify(value);
}

function lintIntrospectionBuiltInDirectiveShapes(schemaRecord: JsonRecord): string[] {
  const warnings: string[] = [];
  const directives = new Map<string, JsonRecord>();
  for (const entry of asArray(schemaRecord.directives)) {
    const directive = asRecord(entry);
    if (directive && typeof directive.name === 'string' && !directives.has(directive.name)) {
      directives.set(directive.name, directive);
    }
  }

  for (const [name, expected] of BUILT_IN_INTROSPECTION_DIRECTIVE_SHAPES) {
    const actual = directives.get(name);
    if (!actual) {
      warnings.push('GQL_INTROSPECTION_DIRECTIVE_MISSING_BUILTIN: @' + name + ' is missing from __schema.directives; implementations must support @' + name + ' (GraphQL spec 3.13)');
      continue;
    }
    if (typeof actual.isRepeatable === 'boolean' && actual.isRepeatable !== expected.isRepeatable) {
      warnings.push('GQL_INTROSPECTION_BUILTIN_DIRECTIVE_SHAPE_DRIFT: @' + name + ' isRepeatable must be ' + String(expected.isRepeatable) + ' (GraphQL spec 3.13); got ' + String(actual.isRepeatable));
    }

    const actualLocations = new Set(asArray(actual.locations).filter((entry): entry is string => typeof entry === 'string'));
    for (const location of BUILT_IN_DIRECTIVE_REQUIRED_LOCATIONS[name] ?? expected.locations) {
      if (!actualLocations.has(location)) {
        warnings.push('GQL_INTROSPECTION_BUILTIN_DIRECTIVE_SHAPE_DRIFT: @' + name + ' must be valid on ' + location + ' (GraphQL spec 3.13); the introspection definition omits it');
      }
    }
    const expectedLocations = new Set(expected.locations);
    for (const location of actualLocations) {
      if (!expectedLocations.has(location)) {
        warnings.push('GQL_INTROSPECTION_BUILTIN_DIRECTIVE_SHAPE_DRIFT: @' + name + ' declares location ' + location + ' beyond its spec definition (GraphQL spec 3.13)');
      }
    }

    const actualShape = readIntrospectionDirectiveShape(actual);
    const actualArgs = new Map((actualShape?.args ?? []).map((arg) => [arg.name, arg]));
    const expectedArgs = new Map(expected.args.map((arg) => [arg.name, arg]));
    for (const [argName, argShape] of expectedArgs) {
      const actualArg = actualArgs.get(argName);
      if (!actualArg) {
        warnings.push('GQL_INTROSPECTION_BUILTIN_DIRECTIVE_SHAPE_DRIFT: @' + name + ' must declare argument ' + argName + ': ' + (argShape.type ?? '<invalid>') + ' (GraphQL spec 3.13)');
        continue;
      }
      if (actualArg.type !== argShape.type) {
        warnings.push('GQL_INTROSPECTION_BUILTIN_DIRECTIVE_SHAPE_DRIFT: @' + name + ' argument ' + argName + ' must be ' + (argShape.type ?? '<invalid>') + ' (GraphQL spec 3.13); got ' + (actualArg.type ?? '<invalid>'));
      }
      if (actualArg.defaultValue !== undefined && actualArg.defaultValue !== argShape.defaultValue) {
        warnings.push(
          'GQL_INTROSPECTION_BUILTIN_DIRECTIVE_SHAPE_DRIFT: @' +
            name +
            ' argument ' +
            argName +
            ' defaultValue must be ' +
            formatIntrospectionValue(argShape.defaultValue) +
            ' (GraphQL spec 3.13); got ' +
            formatIntrospectionValue(actualArg.defaultValue)
        );
      }
    }
    for (const argName of actualArgs.keys()) {
      if (!expectedArgs.has(argName)) {
        warnings.push('GQL_INTROSPECTION_BUILTIN_DIRECTIVE_SHAPE_DRIFT: @' + name + ' declares argument ' + argName + ' beyond its spec definition (GraphQL spec 3.13)');
      }
    }
  }

  return warnings;
}

/**
 * Raw-shape lints over an introspection JSON document, covering introspection
 * contract violations that buildClientSchema tolerates: duplicate type names
 * (last-one-wins in the constructed schema), unknown __TypeKind values,
 * non-OBJECT possibleTypes members, NON_NULL-in-NON_NULL wrappers, malformed
 * deprecation flags, unknown directive locations, and built-in directive
 * shape drift.
 */
export function lintIntrospectionJson(introspection: unknown): string[] {
  const warnings: string[] = [];
  const root = asRecord(introspection);
  const dataRecord = root ? asRecord(root.data) : null;
  const schemaRecord = root ? (asRecord(root.__schema) ?? (dataRecord ? asRecord(dataRecord.__schema) : null)) : null;
  if (!schemaRecord) return warnings;

  const typeCounts = new Map<string, number>();
  for (const entry of asArray(schemaRecord.types)) {
    const type = asRecord(entry);
    if (!type) continue;
    const name = typeof type.name === 'string' ? type.name : '<unnamed>';
    typeCounts.set(name, (typeCounts.get(name) ?? 0) + 1);
    if (typeof type.kind === 'string' && !VALID_TYPE_KINDS.has(type.kind)) {
      warnings.push('GQL_INTROSPECTION_KIND_INVALID: type ' + name + " declares unknown __TypeKind '" + type.kind + "'");
    }
    for (const memberEntry of asArray(type.possibleTypes)) {
      const member = asRecord(memberEntry);
      if (member && member.kind !== undefined && member.kind !== 'OBJECT') {
        warnings.push('GQL_INTROSPECTION_POSSIBLE_TYPE_NOT_OBJECT: ' + name + '.possibleTypes entry ' + String(member.name ?? '<unnamed>') + ' has kind ' + String(member.kind) + '; union/interface possible types must be OBJECT types (GraphQL spec 3.7/3.8)');
      }
    }
    lintDeprecationFlags(asArray(type.fields), name + '.fields', warnings);
    lintDeprecationFlags(asArray(type.enumValues), name + '.enumValues', warnings);
    for (const fieldEntry of asArray(type.fields)) {
      const field = asRecord(fieldEntry);
      if (!field) continue;
      const fieldLabel = name + '.' + String(field.name ?? '<unnamed>');
      lintTypeRefChain(field.type, fieldLabel, warnings);
      for (const argEntry of asArray(field.args)) {
        const arg = asRecord(argEntry);
        if (arg) lintTypeRefChain(arg.type, fieldLabel + '(' + String(arg.name ?? '<unnamed>') + ':)', warnings);
      }
      // September 2025 edition 3.13.3: __InputValue carries deprecation flags too.
      lintDeprecationFlags(asArray(field.args), fieldLabel + '.args', warnings);
    }
    for (const inputEntry of asArray(type.inputFields)) {
      const input = asRecord(inputEntry);
      if (input) lintTypeRefChain(input.type, name + '.' + String(input.name ?? '<unnamed>'), warnings);
    }
    lintDeprecationFlags(asArray(type.inputFields), name + '.inputFields', warnings);
  }
  for (const [name, count] of typeCounts) {
    if (count > 1) {
      warnings.push('GQL_INTROSPECTION_DUPLICATE_TYPE: type name ' + name + ' appears ' + count + ' times in __schema.types; type names must be unique (GraphQL spec 3.3)');
    }
  }
  const directiveNameCounts = new Map<string, number>();
  for (const directiveEntry of asArray(schemaRecord.directives)) {
    const directive = asRecord(directiveEntry);
    if (!directive) continue;
    if (typeof directive.name !== 'string' || directive.name.length === 0) {
      warnings.push('GQL_INTROSPECTION_DIRECTIVE_INVALID: a __schema.directives entry is missing its name');
      continue;
    }
    directiveNameCounts.set(directive.name, (directiveNameCounts.get(directive.name) ?? 0) + 1);
    for (const locationEntry of asArray(directive.locations)) {
      if (typeof locationEntry !== 'string' || !VALID_DIRECTIVE_LOCATIONS.has(locationEntry)) {
        warnings.push('GQL_INTROSPECTION_DIRECTIVE_INVALID: directive @' + directive.name + ' declares unknown location ' + String(locationEntry));
      }
    }
    if (directive.isRepeatable !== undefined && typeof directive.isRepeatable !== 'boolean') {
      warnings.push('GQL_INTROSPECTION_DIRECTIVE_INVALID: directive @' + directive.name + ' isRepeatable must be a boolean (__Directive contract)');
    }
    for (const argEntry of asArray(directive.args)) {
      const arg = asRecord(argEntry);
      if (arg) lintTypeRefChain(arg.type, '@' + directive.name + '(' + String(arg.name ?? '<unnamed>') + ':)', warnings);
    }
    lintDeprecationFlags(asArray(directive.args), '@' + directive.name + '.args', warnings);
  }
  for (const [name, count] of directiveNameCounts) {
    if (count > 1) {
      warnings.push('GQL_INTROSPECTION_DIRECTIVE_DUPLICATE: directive @' + name + ' appears ' + count + ' times in __schema.directives; directive names must be unique (GraphQL spec 3.13)');
    }
  }
  warnings.push(...lintIntrospectionBuiltInDirectiveShapes(schemaRecord));
  warnings.push(...lintIntrospectionRootMap(schemaRecord));
  warnings.push(...lintIntrospectionTypeMatrix(schemaRecord));
  warnings.push(...lintIntrospectionReferenceGraph(schemaRecord));
  warnings.push(...lintIntrospectionAbstractConsistency(schemaRecord));
  warnings.push(...lintIntrospectionDeprecationProvenance(schemaRecord));
  return warnings;
}

function introspectionTypeEntries(schemaRecord: JsonRecord): JsonRecord[] {
  return asArray(schemaRecord.types).map(asRecord).filter((entry): entry is JsonRecord => entry !== null);
}

function introspectionTypesByName(entries: JsonRecord[]): Map<string, JsonRecord> {
  const byName = new Map<string, JsonRecord>();
  for (const entry of entries) {
    if (typeof entry.name === 'string' && !byName.has(entry.name)) byName.set(entry.name, entry);
  }
  return byName;
}

function describeIntrospectionRootRecord(value: unknown): string {
  if (value === undefined || value === null) return '<missing>';
  const record = asRecord(value);
  if (!record) return '<invalid>';
  return typeof record.name === 'string' && record.name.length > 0 ? record.name : '<unnamed>';
}

function formatIntrospectionRootMap(schemaRecord: JsonRecord): string {
  return ['query', 'mutation', 'subscription']
    .map((rootKind) => rootKind + '=' + describeIntrospectionRootRecord(schemaRecord[rootKind + 'Type']))
    .join(', ');
}

/**
 * Raw pre-build checks over the __schema root operation records: queryType must
 * name a type, every present root must name an OBJECT type, and the roots must
 * be distinct (GraphQL spec 3.3) - buildClientSchema tolerates all three.
 */
function lintIntrospectionRootMap(schemaRecord: JsonRecord): string[] {
  const warnings: string[] = [];
  const byName = introspectionTypesByName(introspectionTypeEntries(schemaRecord));
  const seen = new Map<string, string>();
  const rootMap = formatIntrospectionRootMap(schemaRecord);
  for (const rootKind of ['query', 'mutation', 'subscription']) {
    const value = schemaRecord[rootKind + 'Type'];
    if (value === undefined || value === null) {
      if (rootKind === 'query') {
        warnings.push('GQL_INTROSPECTION_ROOT_INVALID: __schema.queryType must record the query root operation type (GraphQL spec 3.3). Root map: ' + rootMap);
      }
      continue;
    }
    const record = asRecord(value);
    if (!record || typeof record.name !== 'string' || record.name.length === 0) {
      warnings.push('GQL_INTROSPECTION_ROOT_INVALID: __schema.' + rootKind + 'Type must name the ' + rootKind + ' root operation type (GraphQL spec 3.3). Root map: ' + rootMap);
      continue;
    }
    const target = byName.get(record.name);
    if (!target) {
      warnings.push(
        'GQL_INTROSPECTION_ROOT_INVALID: ' +
          rootKind +
          ' root operation type ' +
          record.name +
          ' must name a type present in __schema.types (GraphQL spec 3.3). Root map: ' +
          rootMap
      );
      continue;
    }
    if (target && typeof target.kind === 'string' && target.kind !== 'OBJECT') {
      warnings.push(
        'GQL_INTROSPECTION_ROOT_INVALID: ' +
          rootKind +
          ' root operation type ' +
          record.name +
          ' must be an OBJECT type (GraphQL spec 3.3); got ' +
          target.kind +
          '. Root map: ' +
          rootMap
      );
    }
    const prior = seen.get(record.name);
    if (prior) {
      warnings.push(
        'GQL_INTROSPECTION_ROOTS_NOT_DISTINCT: the ' +
          prior +
          ' and ' +
          rootKind +
          ' root operation types are both ' +
          record.name +
          '; root operation types must be distinct (GraphQL September 2025 edition 3.3). Root map: ' +
          rootMap
      );
    } else {
      seen.set(record.name, rootKind);
    }
  }
  return warnings;
}

// __Type member matrix (GraphQL spec 4: introspection): which member lists must
// be a list vs null per kind. Members the introspection query did not request
// (undefined) are skipped; 'array' tolerates empty lists because deprecated
// members may be filtered out of fields/enumValues/inputFields.
const INTROSPECTION_TYPE_MATRIX: Record<string, Record<string, 'array' | 'nonEmptyArray' | 'null'>> = {
  SCALAR: { fields: 'null', inputFields: 'null', enumValues: 'null', possibleTypes: 'null' },
  OBJECT: { fields: 'array', inputFields: 'null', enumValues: 'null', possibleTypes: 'null' },
  INTERFACE: { fields: 'array', inputFields: 'null', enumValues: 'null', possibleTypes: 'array' },
  UNION: { fields: 'null', inputFields: 'null', enumValues: 'null', possibleTypes: 'nonEmptyArray' },
  ENUM: { fields: 'null', inputFields: 'null', enumValues: 'array', possibleTypes: 'null' },
  INPUT_OBJECT: { fields: 'null', inputFields: 'array', enumValues: 'null', possibleTypes: 'null' }
};

function lintIntrospectionTypeMatrix(schemaRecord: JsonRecord): string[] {
  const warnings: string[] = [];
  for (const type of introspectionTypeEntries(schemaRecord)) {
    const kind = typeof type.kind === 'string' ? type.kind : '';
    const matrix = INTROSPECTION_TYPE_MATRIX[kind];
    if (!matrix) continue;
    const name = typeof type.name === 'string' ? type.name : '<unnamed>';
    for (const [key, requirement] of Object.entries(matrix)) {
      const value = type[key];
      if (value === undefined) continue;
      if (requirement === 'null' && value !== null) {
        warnings.push('GQL_INTROSPECTION_TYPE_MATRIX_INVALID: ' + name + '.' + key + ' must be null for ' + kind + ' types (GraphQL spec 4: __Type)');
      }
      if (requirement !== 'null' && !Array.isArray(value)) {
        warnings.push('GQL_INTROSPECTION_TYPE_MATRIX_INVALID: ' + name + '.' + key + ' must be a list for ' + kind + ' types (GraphQL spec 4: __Type)');
      }
      if (requirement === 'nonEmptyArray' && Array.isArray(value) && value.length === 0) {
        warnings.push('GQL_INTROSPECTION_TYPE_MATRIX_INVALID: ' + name + ' (' + kind + ') must declare at least one entry in ' + key + ' (GraphQL spec 3.8)');
      }
    }
  }
  return warnings;
}

function namedTypeRefName(ref: unknown): string | null {
  let current = asRecord(ref);
  let depth = 0;
  while (current && depth < 32) {
    if (current.kind !== 'LIST' && current.kind !== 'NON_NULL') {
      return typeof current.name === 'string' ? current.name : null;
    }
    current = asRecord(current.ofType);
    depth += 1;
  }
  return null;
}

/**
 * Reference closure over the raw introspection document: every named type
 * referenced from roots, fields, arguments, input fields, interfaces,
 * possibleTypes, or directive arguments must appear in __schema.types (GraphQL
 * spec 3.3; exactly-once is covered by the duplicate-name check), and built-in
 * scalars must only appear when referenced (GraphQL spec 3.5).
 */
function lintIntrospectionReferenceGraph(schemaRecord: JsonRecord): string[] {
  const warnings: string[] = [];
  const entries = introspectionTypeEntries(schemaRecord);
  const byName = introspectionTypesByName(entries);
  const referenced = new Set<string>();
  const addRef = (name: string | null): void => {
    if (name) referenced.add(name);
  };
  for (const rootKind of ['query', 'mutation', 'subscription']) {
    const record = asRecord(schemaRecord[rootKind + 'Type']);
    if (record && typeof record.name === 'string') referenced.add(record.name);
  }
  for (const type of entries) {
    for (const entry of asArray(type.interfaces)) addRef(namedTypeRefName(entry));
    for (const entry of asArray(type.possibleTypes)) addRef(namedTypeRefName(entry));
    for (const fieldEntry of asArray(type.fields)) {
      const field = asRecord(fieldEntry);
      if (!field) continue;
      addRef(namedTypeRefName(field.type));
      for (const argEntry of asArray(field.args)) {
        const arg = asRecord(argEntry);
        if (arg) addRef(namedTypeRefName(arg.type));
      }
    }
    for (const inputEntry of asArray(type.inputFields)) {
      const input = asRecord(inputEntry);
      if (input) addRef(namedTypeRefName(input.type));
    }
  }
  for (const directiveEntry of asArray(schemaRecord.directives)) {
    const directive = asRecord(directiveEntry);
    if (!directive) continue;
    for (const argEntry of asArray(directive.args)) {
      const arg = asRecord(argEntry);
      if (arg) addRef(namedTypeRefName(arg.type));
    }
  }
  for (const name of [...referenced].sort((a, b) => a.localeCompare(b))) {
    if (!byName.has(name)) {
      warnings.push('GQL_INTROSPECTION_REFERENCED_TYPE_MISSING: type ' + name + ' is referenced but missing from __schema.types; every reachable named type must be listed (GraphQL spec 3.3)');
    }
  }
  for (const scalar of BUILT_IN_SCALAR_NAMES) {
    if (byName.has(scalar) && !referenced.has(scalar)) {
      warnings.push('GQL_INTROSPECTION_BUILTIN_SCALAR_UNREFERENCED: built-in scalar ' + scalar + ' appears in __schema.types but nothing references it; introspection must only include referenced built-in scalars (GraphQL spec 3.5)');
    }
  }
  return warnings;
}

/**
 * Bidirectional object/interface agreement (GraphQL spec 3.8): an object
 * listing interface I must appear in I.possibleTypes, and every OBJECT member
 * of an interface's possibleTypes must list that interface back. Applies only
 * when both sides are present in the document.
 */
function lintIntrospectionAbstractConsistency(schemaRecord: JsonRecord): string[] {
  const warnings: string[] = [];
  const entries = introspectionTypeEntries(schemaRecord);
  const byName = introspectionTypesByName(entries);
  const names = (value: unknown): string[] =>
    asArray(value)
      .map((entry) => {
        const record = asRecord(entry);
        return record && typeof record.name === 'string' ? record.name : '';
      })
      .filter((name) => name.length > 0);
  for (const type of entries) {
    const typeName = typeof type.name === 'string' ? type.name : '<unnamed>';
    if (type.kind === 'OBJECT' && Array.isArray(type.interfaces)) {
      for (const ifaceName of names(type.interfaces)) {
        const iface = byName.get(ifaceName);
        if (iface && iface.kind === 'INTERFACE' && Array.isArray(iface.possibleTypes) && !names(iface.possibleTypes).includes(typeName)) {
          warnings.push('GQL_INTROSPECTION_ABSTRACT_INCONSISTENT: ' + typeName + ' implements ' + ifaceName + ' but ' + ifaceName + '.possibleTypes does not list it (GraphQL spec 3.8)');
        }
      }
    }
    if (type.kind === 'INTERFACE' && Array.isArray(type.possibleTypes)) {
      for (const memberName of names(type.possibleTypes)) {
        const member = byName.get(memberName);
        if (member && member.kind === 'OBJECT' && Array.isArray(member.interfaces) && !names(member.interfaces).includes(typeName)) {
          warnings.push('GQL_INTROSPECTION_ABSTRACT_INCONSISTENT: ' + typeName + '.possibleTypes lists ' + memberName + ' but ' + memberName + ' does not declare the interface (GraphQL spec 3.8)');
        }
      }
    }
  }
  return warnings;
}

/**
 * Deprecation provenance: when no field or enum value in the whole document
 * carries an isDeprecated flag, the introspection query did not request
 * deprecation metadata, so deprecated members cannot be verified as included
 * (GraphQL spec 4.2.3).
 */
function lintIntrospectionDeprecationProvenance(schemaRecord: JsonRecord): string[] {
  let entries = 0;
  let flagged = 0;
  for (const type of introspectionTypeEntries(schemaRecord)) {
    for (const entry of [...asArray(type.fields), ...asArray(type.enumValues)]) {
      const record = asRecord(entry);
      if (!record) continue;
      entries += 1;
      if (record.isDeprecated !== undefined) flagged += 1;
    }
  }
  if (entries > 0 && flagged === 0) {
    return ['GQL_INTROSPECTION_DEPRECATION_UNVERIFIABLE: no field or enum value carries an isDeprecated flag; the introspection was likely produced without deprecation metadata (includeDeprecated), so deprecated members cannot be verified as included (GraphQL spec 4.2.3)'];
  }
  return [];
}

/**
 * Self-check for a generated operation document (GraphQL spec 5: request
 * documents must pass validation). validate() throws when the schema itself is
 * invalid, so an invalid schema degrades to a NOT_VALIDATED warning rather
 * than masking the schema problem with a crash.
 */
export function lintGeneratedDocument(schema: GraphQLSchema, operationId: string, documentText: string): string[] {
  let document: DocumentNode;
  try {
    document = parse(documentText);
  } catch (error) {
    return ['GQL_GENERATED_DOCUMENT_INVALID: ' + operationId + ': generated document failed to parse (' + (error instanceof Error ? error.message : String(error)) + ')'];
  }
  try {
    return validate(schema, document).map((error) => 'GQL_GENERATED_DOCUMENT_INVALID: ' + operationId + ': ' + error.message);
  } catch (error) {
    return ['GQL_GENERATED_DOCUMENT_NOT_VALIDATED: ' + operationId + ': ' + (error instanceof Error ? error.message : String(error))];
  }
}

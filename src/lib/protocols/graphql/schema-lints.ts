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
// directive locations).
import {
  DirectiveLocation,
  Kind,
  isScalarType,
  parse,
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

/**
 * Raw-shape lints over an introspection JSON document, covering introspection
 * contract violations that buildClientSchema tolerates: duplicate type names
 * (last-one-wins in the constructed schema), unknown __TypeKind values,
 * non-OBJECT possibleTypes members, NON_NULL-in-NON_NULL wrappers, malformed
 * deprecation flags, and unknown directive locations.
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
    }
    for (const inputEntry of asArray(type.inputFields)) {
      const input = asRecord(inputEntry);
      if (input) lintTypeRefChain(input.type, name + '.' + String(input.name ?? '<unnamed>'), warnings);
    }
  }
  for (const [name, count] of typeCounts) {
    if (count > 1) {
      warnings.push('GQL_INTROSPECTION_DUPLICATE_TYPE: type name ' + name + ' appears ' + count + ' times in __schema.types; type names must be unique (GraphQL spec 3.3)');
    }
  }
  for (const directiveEntry of asArray(schemaRecord.directives)) {
    const directive = asRecord(directiveEntry);
    if (!directive) continue;
    if (typeof directive.name !== 'string' || directive.name.length === 0) {
      warnings.push('GQL_INTROSPECTION_DIRECTIVE_INVALID: a __schema.directives entry is missing its name');
      continue;
    }
    for (const locationEntry of asArray(directive.locations)) {
      if (typeof locationEntry !== 'string' || !VALID_DIRECTIVE_LOCATIONS.has(locationEntry)) {
        warnings.push('GQL_INTROSPECTION_DIRECTIVE_INVALID: directive @' + directive.name + ' declares unknown location ' + String(locationEntry));
      }
    }
  }
  return warnings;
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

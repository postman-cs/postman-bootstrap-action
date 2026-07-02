import type { GraphQLContractIndex, GraphQLOperationDef, GraphQLTypeRef } from './parser.js';
import { selectFields, type SelectedField } from './selection.js';

type JsonRecord = Record<string, unknown>;

export interface GraphQLInstrumentationResult {
  collection: JsonRecord;
  warnings: string[];
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// Hard cap on a single generated GraphQL test script, mirroring the OpenAPI
// (CONTRACT_SIZE_LIMITS) and gRPC (GRPC_INSTRUMENT_LIMITS) guards so a pathological
// schema (e.g. tens of thousands of non-null scalar fields) cannot emit an oversized
// script that the gateway would reject downstream.
const GRAPHQL_INSTRUMENT_LIMITS = {
  maxTestScriptBytes: 900_000
};

// Signed 32-bit bounds for the GraphQL `Int` scalar (the spec defines Int as a
// signed 32-bit integer; a value outside this range is a serialization error).
const GRAPHQL_INT_MIN = -2147483648;
const GRAPHQL_INT_MAX = 2147483647;

/**
 * Runtime assertions for a built-in GraphQL scalar leaf at `accessor`. `Int` is
 * validated as a signed 32-bit integer (not merely a JS number), `Float` as a
 * finite number, `String`/`ID` as strings, `Boolean` as a boolean. Custom
 * scalars have no portable runtime type, so only a warning is emitted.
 */
function scalarAssertions(accessor: string, typeName: string, ctx: string, warnings: string[]): string[] {
  switch (typeName) {
    case 'Int':
      return [
        `pm.expect(${accessor}, ${JSON.stringify(`${ctx}: expected Int scalar`)}).to.be.a("number");`,
        `pm.expect(Number.isInteger(${accessor}) && ${accessor} >= ${GRAPHQL_INT_MIN} && ${accessor} <= ${GRAPHQL_INT_MAX}, ${JSON.stringify(`${ctx}: Int must be a signed 32-bit integer`)}).to.equal(true);`
      ];
    case 'Float':
      return [
        `pm.expect(${accessor}, ${JSON.stringify(`${ctx}: expected Float scalar`)}).to.be.a("number");`,
        `pm.expect(Number.isFinite(${accessor}), ${JSON.stringify(`${ctx}: Float must be a finite number`)}).to.equal(true);`
      ];
    case 'String':
    case 'ID':
      return [`pm.expect(${accessor}, ${JSON.stringify(`${ctx}: expected ${typeName} scalar (serialized as a string)`)}).to.be.a("string");`];
    case 'Boolean':
      return [`pm.expect(${accessor}, ${JSON.stringify(`${ctx}: expected Boolean scalar`)}).to.be.a("boolean");`];
    default:
      warnings.push(`GQL_CUSTOM_SCALAR_NOT_TYPE_ASSERTED: ${ctx} custom scalar ${typeName} has no portable runtime type; only presence is asserted`);
      return [];
  }
}

/**
 * Runtime assertions for an enum leaf at `accessor`: it must be a string that is
 * a member of the enum's declared value set. When the value set is unresolved,
 * only string-ness is asserted and a warning is emitted.
 */
function enumAssertions(accessor: string, typeName: string, ctx: string, index: GraphQLContractIndex, warnings: string[]): string[] {
  const values = index.enumValues[typeName];
  if (!values || values.length === 0) {
    warnings.push(`GQL_ENUM_VALUES_UNKNOWN: ${ctx} enum ${typeName} value set was not resolved; only string-ness is asserted`);
    return [`pm.expect(${accessor}, ${JSON.stringify(`${ctx}: expected enum ${typeName} as string`)}).to.be.a("string");`];
  }
  return [
    `pm.expect(${accessor}, ${JSON.stringify(`${ctx}: expected enum ${typeName} as string`)}).to.be.a("string");`,
    `pm.expect(${accessor}, ${JSON.stringify(`${ctx}: value is not a member of enum ${typeName}`)}).to.be.oneOf(${JSON.stringify(values)});`
  ];
}

/**
 * Build the afterResponse assertion script lines for one GraphQL operation.
 * Assertions are deterministic and reference the parsed HTTP JSON body
 * (`pm.response.json().data` / `.errors`), the GraphQL-over-HTTP response
 * surface in the Postman CLI / Newman HTTP execution path. Each assertion that
 * cannot be made deterministically pushes a GQL_ / PROTO_ prefixed warning
 * instead of emitting a weaker check silently.
 */
function buildOperationScript(operation: GraphQLOperationDef, index: GraphQLContractIndex, warnings: string[]): string[] {
  const field = operation.field;
  const returns = operation.returns;
  const lines: string[] = [];
  const label = `${operation.kind} ${field}`;

  // Parse the GraphQL-over-HTTP JSON body once; reused by every assertion below.
  lines.push(
    'var gqlBody = (function () { try { return pm.response.json() || {}; } catch (e) { return {}; } })();'
  );

  // 1. Transport: GraphQL-over-HTTP is POST returning HTTP 200 even with errors.
  lines.push(
    `pm.test(${JSON.stringify(`[${label}] HTTP transport is ok`)}, function () {`,
    '    pm.expect(pm.response.code, "GraphQL responses are HTTP 200 even when the data field carries errors").to.be.below(500);',
    '});'
  );
  // GraphQL-over-HTTP media type and per-media-type status discipline. The
  // GraphQL-over-HTTP specification defines two response media types:
  // application/graphql-response+json (a server MUST NOT use a 2xx status for
  // a response that is not a well-formed GraphQL response) and legacy
  // application/json (a well-formed response carrying non-null data rides 200).
  // Content-Type-conditional: a response without a Content-Type is skipped.
  lines.push(
    'pm.test(' + JSON.stringify('[' + label + '] GraphQL-over-HTTP media type and status are consistent') + ', function () {',
    '    var contentType = ((pm.response.headers && pm.response.headers.get && pm.response.headers.get("Content-Type")) || "").toLowerCase();',
    '    var mediaType = contentType.split(";")[0].trim();',
    '    if (!mediaType) return;',
    '    if (mediaType !== "application/graphql-response+json" && mediaType !== "application/json") { pm.expect.fail("GraphQL-over-HTTP responses use application/graphql-response+json or application/json; got: " + (mediaType || "<missing>")); }',
    '    var wellFormed = gqlBody.data !== undefined || Array.isArray(gqlBody.errors);',
    '    if (mediaType === "application/graphql-response+json" && pm.response.code >= 200 && pm.response.code < 300 && !wellFormed) { pm.expect.fail("application/graphql-response+json forbids a 2xx status when the body is not a well-formed GraphQL response"); }',
    '    if (mediaType === "application/json" && gqlBody.data !== undefined && gqlBody.data !== null && pm.response.code !== 200) { pm.expect.fail("a GraphQL response carrying data over application/json must be HTTP 200; got " + pm.response.code); }',
    '});'
  );

  // 2. Errors. GraphQL-over-HTTP returns 200 even for partial success, where a
  // response may legitimately carry BOTH `data` and field-level `errors`. Validate
  // the errors are well-formed when present and fail closed only on a TOTAL failure
  // (errors present with no data at all) - never merely because `errors` is
  // non-empty, which would false-fail a legitimate partial response.
  //
  // Intentional CONTRACT policy (not a raw protocol-legality assertion): a total
  // failure (data:null with errors) is legal GraphQL wire-format but represents a
  // FAILED operation, so a contract/smoke run fails it - the same way an OpenAPI
  // contract test fails a spec-legal 5xx. Successful-operation assertion by design;
  // partial success (data + errors) still passes.
  lines.push(
    `pm.test(${JSON.stringify(`[${label}] GraphQL errors are well-formed and not a total failure`)}, function () {`,
    '    var errors = gqlBody.errors;',
    '    if (errors === undefined || errors === null) return;',
    '    pm.expect(errors, "GraphQL \'errors\' must be an array when present").to.be.an("array");',
    '    errors.forEach(function (err) { pm.expect(err, "each GraphQL error must carry a message").to.be.an("object").that.has.property("message"); });',
    '    var hasData = gqlBody.data !== undefined && gqlBody.data !== null;',
    '    if (!hasData && errors.length > 0) { pm.expect.fail("GraphQL request returned errors and no data: " + JSON.stringify(errors)); }',
    '});'
  );

  if (operation.kind === 'subscription') {
    warnings.push(
      `GQL_SUBSCRIPTION_LIVE_ASSERTIONS_SKIPPED: ${operation.id} is a subscription; data-shape assertions are emitted but the Postman CLI cannot execute subscriptions, so they will not run live`
    );
  }

  // 3. data.<rootField> present (unless the field is nullable and could legitimately be null).
  lines.push(
    `pm.test(${JSON.stringify(`[${label}] data.${field} is present`)}, function () {`,
    '    pm.expect(gqlBody.data, "response has no data object").to.exist;',
    `    pm.expect(gqlBody.data, "data is missing field '${field}'").to.have.property(${JSON.stringify(field)});`
  );
  if (returns.nonNull) {
    lines.push(`    pm.expect(gqlBody.data[${JSON.stringify(field)}], "${field} is declared non-null but was null").to.not.be.null;`);
  }
  lines.push('});');

  // 4. Shape vs return type (only when the value is non-null at runtime).
  const shapeLines = buildShapeAssertions(operation, index, warnings);
  if (shapeLines.length > 0) {
    lines.push(
      `pm.test(${JSON.stringify(`[${label}] data.${field} matches schema return type`)}, function () {`,
      `    var value = gqlBody.data && gqlBody.data[${JSON.stringify(field)}];`,
      '    if (value === undefined || value === null) return;',
      ...shapeLines.map((line) => `    ${line}`),
      '});'
    );
  }

  return lines;
}

/**
 * Build the response-shape assertions for an operation's return value (bound to
 * the local `value`). Assertions are generated from the SAME selection set the
 * builder renders into the query (see selection.ts), so a non-null field the
 * query does not select is never asserted (which would false-fail a legitimate
 * response). Lists validate EVERY element; scalars, enums, and selected object
 * sub-fields are type-checked, not merely presence-checked.
 */
function buildShapeAssertions(operation: GraphQLOperationDef, index: GraphQLContractIndex, warnings: string[]): string[] {
  const selection = selectFields(operation.returns, index, 1);
  return emitValueAssertions('value', operation.returns, selection, operation.id, index, warnings);
}

/**
 * Emit assertions for a value of type `ref`. `selection` carries the selected
 * sub-fields when `ref` is an expanded object/interface (null for scalars,
 * enums, and unexpanded composites). A list wrapper is handled here by asserting
 * array-ness and validating EVERY element against the element type; for a `[T!]`
 * list each element is also asserted non-null, while for a nullable `[T]` list a
 * null element is skipped (it is GraphQL-legal).
 */
function emitValueAssertions(
  accessor: string,
  ref: GraphQLTypeRef,
  selection: SelectedField[] | null,
  ctx: string,
  index: GraphQLContractIndex,
  warnings: string[]
): string[] {
  if (ref.lists.length > 0) {
    // Peel ONE list dimension (outer -> inner). Nested lists (`[[Int]]`) recurse
    // through this branch once per dimension, so every level is asserted as an
    // array and its item null-ness enforced per that level's own wrapper.
    const [outer, ...rest] = ref.lists;
    const innerRef: GraphQLTypeRef = {
      ...ref,
      lists: rest,
      list: rest.length > 0,
      listItemNonNull: rest.length > 0 ? rest[0].itemNonNull : false
    };
    const elementLines = emitValueAssertions('__el', innerRef, selection, `${ctx} (list element)`, index, warnings);
    const lines = [`pm.expect(${accessor}, ${JSON.stringify(`${ctx}: expected a list`)}).to.be.an("array");`];
    const body: string[] = [];
    if (outer.itemNonNull) {
      // `[T!]`: a null element is a contract violation, so fail closed on it and
      // then validate the (non-null) element (which may itself be a list).
      body.push(`pm.expect(__el, ${JSON.stringify(`${ctx} (list element): a non-null list item ([T!]) was null`)}).to.not.be.null;`);
      body.push(...elementLines);
    } else if (elementLines.length > 0) {
      // `[T]`: a null element is GraphQL-legal, so skip it before validating
      // (asserting the element type against null would false-fail a valid list).
      body.push('if (__el === null || __el === undefined) return;', ...elementLines);
    }
    if (body.length > 0) {
      lines.push(`${accessor}.forEach(function (__el) {`, ...body.map((line) => `    ${line}`), '});');
    }
    return lines;
  }

  if (ref.kind === 'scalar') return scalarAssertions(accessor, ref.name, ctx, warnings);
  if (ref.kind === 'enum') return enumAssertions(accessor, ref.name, ctx, index, warnings);

  if (ref.kind === 'object' || ref.kind === 'interface') {
    const lines = [`pm.expect(${accessor}, ${JSON.stringify(`${ctx}: expected ${ref.name} object`)}).to.be.an("object");`];
    const fields = selection ?? [];
    if (fields.length === 0) {
      warnings.push(`GQL_NO_SELECTED_FIELDS_TO_ASSERT: ${ctx} object ${ref.name} exposes no selected scalar/enum fields; only object-ness is asserted`);
    }
    for (const field of fields) {
      lines.push(...emitFieldAssertions(accessor, ref.name, field, ctx, index, warnings));
    }
    return lines;
  }

  if (ref.kind === 'union') {
    // A union value in the response corresponds to the query's `{ __typename }`
    // selection: it must be an object carrying a string `__typename`, and (when the
    // member set is known) that `__typename` must name a declared union member.
    // Member-specific fields are not expanded, so they are not asserted.
    const members = index.unionMembers[ref.name];
    const objMsg = JSON.stringify(ctx + ': expected union ' + ref.name + ' value as an object');
    const presentMsg = JSON.stringify(ctx + ': union ' + ref.name + ' value must carry __typename');
    const stringMsg = JSON.stringify(ctx + ': union ' + ref.name + ' __typename must be a string');
    const lines = [
      'pm.expect(' + accessor + ', ' + objMsg + ').to.be.an("object");',
      'pm.expect(' + accessor + ', ' + presentMsg + ').to.have.property("__typename");',
      'pm.expect(' + accessor + ' && ' + accessor + '.__typename, ' + stringMsg + ').to.be.a("string");'
    ];
    if (members && members.length > 0) {
      const memberMsg = JSON.stringify(ctx + ': __typename is not a declared member of union ' + ref.name);
      lines.push('pm.expect(' + accessor + ' && ' + accessor + '.__typename, ' + memberMsg + ').to.be.oneOf(' + JSON.stringify(members) + ');');
    } else {
      warnings.push('GQL_UNION_MEMBERS_UNKNOWN: ' + ctx + ' union ' + ref.name + ' member set was not resolved; only object + string __typename is asserted');
    }
    return lines;
  }
  warnings.push(`GQL_UNKNOWN_RETURN_TYPE: ${ctx} return type ${ref.name} could not be classified; only presence is asserted`);
  return [];
}

/**
 * Emit assertions for one SELECTED field of an object: a non-null field must be
 * present, and (when present and non-null) its value is type-checked against the
 * field type. Nullable fields are only checked when present and non-null, so a
 * legitimately absent/null nullable field never false-fails.
 */
function emitFieldAssertions(
  objectAccessor: string,
  parentTypeName: string,
  field: SelectedField,
  ctx: string,
  index: GraphQLContractIndex,
  warnings: string[]
): string[] {
  const propName = JSON.stringify(field.name);
  const prop = `${objectAccessor}[${propName}]`;
  const lines: string[] = [];
  if (field.type.nonNull) {
    lines.push(`pm.expect(${objectAccessor}, ${JSON.stringify(`${parentTypeName} is missing non-null field '${field.name}'`)}).to.have.property(${propName});`);
    // A non-null field may be present but explicitly null, which the property
    // check alone would accept; fail closed on it before the shape check (which
    // legitimately skips null for nullable fields).
    lines.push(`pm.expect(${prop}, ${JSON.stringify(`${parentTypeName}.${field.name} is declared non-null but was null`)}).to.not.be.null;`);
  }
  const valueLines = emitValueAssertions(prop, field.type, field.selection, `${ctx}.${field.name}`, index, warnings);
  if (valueLines.length > 0) {
    lines.push(`if (${prop} !== undefined && ${prop} !== null) {`, ...valueLines.map((line) => `    ${line}`), '}');
  }
  return lines;
}

/**
 * Build the request-side variable-presence assertion. GraphQL variables are
 * sent in the request body (`body.graphql.variables`), so this validates the
 * operator supplied each declared required variable.
 */
function buildVariableScript(operation: GraphQLOperationDef): string[] {
  const required = operation.args.filter((arg) => arg.required);
  if (required.length === 0) return [];
  const label = `${operation.kind} ${operation.field}`;
  const names = required.map((arg) => arg.name);
  return [
    `pm.test(${JSON.stringify(`[${label}] required variables are supplied`)}, function () {`,
    '    var body = (pm.request && pm.request.body) || {};',
    '    var raw = (body.graphql && body.graphql.variables) || body.raw || {};',
    '    var vars = {};',
    '    try { vars = typeof raw === "string" ? (raw ? JSON.parse(raw) : {}) : raw; }',
    '    catch (e) { vars = {}; }',
    '    if (vars && vars.variables !== undefined) { vars = vars.variables; }',
    '    if (typeof vars === "string") { try { vars = JSON.parse(vars); } catch (e2) { vars = {}; } }',
    `    var required = ${JSON.stringify(names)};`,
    '    required.forEach(function (name) {',
    '        pm.expect(vars, "required GraphQL variable \'" + name + "\' was not supplied in the request").to.have.property(name);',
    '    });',
    '});'
  ];
}

function isGraphQLHttpRequest(item: JsonRecord): boolean {
  const request = asRecord(item.request);
  if (!request) return false;
  const body = asRecord(request.body);
  return body?.mode === 'graphql';
}

function injectItem(item: JsonRecord, index: GraphQLContractIndex, covered: Set<string>, warnings: string[]): void {
  const children = asArray(item.item);
  if (children.length > 0) {
    for (const child of children) {
      const childRecord = asRecord(child);
      if (childRecord) injectItem(childRecord, index, covered, warnings);
    }
    return;
  }

  if (isGraphQLHttpRequest(item)) {
    const id = String(item.id ?? '');
    const operation = index.operations.find((op) => op.id === id);
    if (!operation) {
      const mappingError = `graphql request item '${id || item.name || '<unnamed>'}' did not match any indexed GraphQL operation`;
      warnings.push(`PROTO_ITEM_UNMATCHED: ${mappingError}; attached fail-closed assertion`);
      const failExec = [
        `var contractMappingError = ${JSON.stringify(mappingError)};`,
        "pm.test('GraphQL operation mapping exists', function () {",
        '  pm.expect.fail(contractMappingError);',
        '});'
      ];
      const priorEvents = asArray(item.event).filter((entry) => asRecord(entry)?.listen !== 'test');
      item.event = [...priorEvents, { listen: 'test', script: { type: 'text/javascript', exec: failExec } }];
      return;
    }
    covered.add(operation.id);
    warnings.push(...operation.warnings);
    const exec = [
      ...buildOperationScript(operation, index, warnings),
      ...buildVariableScript(operation)
    ];
    const scriptBytes = Buffer.byteLength(exec.join('\n'), 'utf8');
    if (scriptBytes > GRAPHQL_INSTRUMENT_LIMITS.maxTestScriptBytes) {
      throw new Error(
        `GQL_SCRIPT_SIZE_EXCEEDED: generated test script for '${operation.id}' exceeded ${GRAPHQL_INSTRUMENT_LIMITS.maxTestScriptBytes} bytes`
      );
    }
    const events = asArray(item.event).filter((entry) => asRecord(entry)?.listen !== 'test');
    item.event = [
      ...events,
      { listen: 'test', script: { type: 'text/javascript', exec } }
    ];
  }
}

/**
 * Inject `test` (afterResponse) pm.test assertion scripts into every GraphQL
 * HTTP item (`body.mode: graphql`) of a v2.1.0 collection built from `index`.
 * Mirrors the OAS module's no-silent-drop discipline: any construct that cannot
 * be deterministically asserted emits a GQL_ / PROTO_ prefixed warning. Throws
 * when an indexed operation has no corresponding item (coverage failure).
 */
export function instrumentGraphQLCollection(collection: JsonRecord, index: GraphQLContractIndex): GraphQLInstrumentationResult {
  const warnings: string[] = [...index.warnings];
  const covered = new Set<string>();
  for (const child of asArray(collection.item)) {
    const childRecord = asRecord(child);
    if (childRecord) injectItem(childRecord, index, covered, warnings);
  }

  const missing = index.operations.filter((operation) => !covered.has(operation.id));
  if (missing.length > 0) {
    throw new Error(
      `GQL_OPERATION_COVERAGE_FAILED: collection is missing GraphQL item coverage for ${missing.map((operation) => operation.id).join(', ')}`
    );
  }

  // Dedup warnings while preserving first-seen order.
  return { collection, warnings: [...new Set(warnings)] };
}

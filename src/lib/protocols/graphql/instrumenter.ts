import type { GraphQLContractIndex, GraphQLOperationDef, GraphQLTypeRef } from './parser.js';

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

/** The Chai-friendly type token for a scalar leaf, used in `to.be.a(...)` assertions. */
function chaiScalarType(typeName: string): 'number' | 'string' | 'boolean' | null {
  switch (typeName) {
    case 'Int':
    case 'Float':
      return 'number';
    case 'String':
    case 'ID':
      return 'string';
    case 'Boolean':
      return 'boolean';
    default:
      // Custom scalars (DateTime, JSON, ...) have no portable runtime type.
      return null;
  }
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

  // 2. Errors. GraphQL-over-HTTP returns 200 even for partial success, where a
  // response may legitimately carry BOTH `data` and field-level `errors`. Validate
  // the errors are well-formed when present and fail closed only on a TOTAL failure
  // (errors present with no data at all) - never merely because `errors` is
  // non-empty, which would false-fail a legitimate partial response.
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

function buildShapeAssertions(operation: GraphQLOperationDef, index: GraphQLContractIndex, warnings: string[]): string[] {
  const returns = operation.returns;
  const lines: string[] = [];

  if (returns.list) {
    lines.push('pm.expect(value, "expected a list").to.be.an("array");');
    // Assert element shape against the unwrapped element type. Only the first
    // element is sampled to bound script size; flag that later elements are not
    // individually shape-checked (no-silent-skip discipline).
    const elementLines = buildValueShapeAssertions('value[0]', returns, index, operation, warnings, true);
    if (elementLines.length > 0) {
      warnings.push(`GQL_LIST_ELEMENT_SAMPLING: ${operation.id} list return is shape-asserted on the first element only; elements beyond index 0 are not individually validated`);
      lines.push('if (value.length > 0) {');
      lines.push(...elementLines.map((line) => `    ${line}`));
      lines.push('}');
    }
    return lines;
  }

  return buildValueShapeAssertions('value', returns, index, operation, warnings, false);
}

function buildValueShapeAssertions(
  accessor: string,
  returns: GraphQLTypeRef,
  index: GraphQLContractIndex,
  operation: GraphQLOperationDef,
  warnings: string[],
  isElement: boolean
): string[] {
  const lines: string[] = [];
  const ctx = `${operation.id}${isElement ? ' (list element)' : ''}`;

  if (returns.kind === 'scalar') {
    const chai = chaiScalarType(returns.name);
    if (chai) {
      lines.push(`pm.expect(${accessor}, "expected ${returns.name} scalar").to.be.a(${JSON.stringify(chai)});`);
    } else {
      warnings.push(`GQL_CUSTOM_SCALAR_NOT_TYPE_ASSERTED: ${ctx} returns custom scalar ${returns.name}; only presence is asserted, not its runtime type`);
    }
    return lines;
  }

  if (returns.kind === 'enum') {
    lines.push(`pm.expect(${accessor}, "expected enum ${returns.name} as string").to.be.a("string");`);
    return lines;
  }

  if (returns.kind === 'object' || returns.kind === 'interface') {
    lines.push(`pm.expect(${accessor}, "expected ${returns.name} object").to.be.an("object");`);
    const shape = index.objectShapes[returns.name];
    if (shape) {
      // Presence-assert EVERY non-null field (scalar, enum, object, interface,
      // list). A missing non-null object/interface/list field is as much a
      // contract violation as a missing scalar, so it must not be filtered out.
      const requiredFields = shape.fields.filter((f) => f.type.nonNull);
      for (const f of requiredFields) {
        lines.push(`pm.expect(${accessor}, "${returns.name} is missing non-null field '${f.name}'").to.have.property(${JSON.stringify(f.name)});`);
      }
      if (requiredFields.length === 0) {
        warnings.push(`GQL_NO_REQUIRED_FIELDS_TO_ASSERT: ${ctx} object ${returns.name} declares no non-null fields; only object-ness is asserted`);
      }
    } else {
      warnings.push(`GQL_OBJECT_SHAPE_UNKNOWN: ${ctx} object ${returns.name} shape was not resolved; only object-ness is asserted`);
    }
    return lines;
  }

  if (returns.kind === 'union') {
    warnings.push(`GQL_UNION_RETURN_NOT_SHAPE_ASSERTED: ${ctx} returns union ${returns.name}; only presence is asserted`);
    return lines;
  }

  warnings.push(`GQL_UNKNOWN_RETURN_TYPE: ${ctx} return type ${returns.name} could not be classified; only presence is asserted`);
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

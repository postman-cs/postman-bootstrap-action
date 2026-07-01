import type {
  GraphQLArgumentDef,
  GraphQLContractIndex,
  GraphQLObjectShape,
  GraphQLOperationDef,
  GraphQLTypeRef
} from './parser.js';

type JsonRecord = Record<string, unknown>;

/**
 * v2.1.0 Collection schema URL. GraphQL-over-HTTP is represented as an ordinary
 * HTTP request with `body.mode: "graphql"`, which the published v2.1.0 schema
 * lists in its body-mode enum (raw | urlencoded | formdata | file | graphql).
 * This runs in the legacy Postman CLI / Newman HTTP path with no feature flag,
 * unlike the EC `graphql-request` item type which is server-flag gated.
 */
export const COLLECTION_V210_SCHEMA =
  'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' as const;

export interface BuildGraphQLCollectionOptions {
  /** Endpoint URL (supports Postman variable interpolation, e.g. `{{baseUrl}}/graphql`). */
  url?: string;
  /** Collection display title. Defaults to `<service> Contract`. */
  name?: string;
  /** Variable entries added to the collection payload (e.g. baseUrl). */
  variables?: Array<{ key: string; value?: string }>;
  /** Default request headers attached to every item. */
  headers?: Array<{ key: string; value: string; disabled?: boolean; description?: string }>;
}

const DEFAULT_URL = '{{baseUrl}}/graphql';
const SELECTION_DEPTH = 1;

function indent(depth: number): string {
  return '  '.repeat(depth);
}

/**
 * Build a leaf-or-shallow selection set for an object/interface return type:
 * scalar/enum sub-fields are selected directly; one level of nested object
 * fields is expanded to their scalar leaves so the query is valid GraphQL.
 */
function selectionSet(typeRef: GraphQLTypeRef, index: GraphQLContractIndex, depth: number): string {
  if (typeRef.kind !== 'object' && typeRef.kind !== 'interface') return '';
  const shape = index.objectShapes[typeRef.name];
  if (!shape || shape.fields.length === 0) return ' { __typename }';
  const lines: string[] = [];
  for (const field of shape.fields) {
    if (field.type.kind === 'scalar' || field.type.kind === 'enum') {
      lines.push(`${indent(depth + 1)}${field.name}`);
    } else if ((field.type.kind === 'object' || field.type.kind === 'interface') && depth < SELECTION_DEPTH) {
      const nested = selectionSet(field.type, index, depth + 1);
      lines.push(`${indent(depth + 1)}${field.name}${nested || ' { __typename }'}`);
    }
  }
  if (lines.length === 0) return ' { __typename }';
  return ` {\n${lines.join('\n')}\n${indent(depth)}}`;
}

function argTypeSdl(arg: GraphQLArgumentDef): string {
  const ref = arg.type;
  let inner = ref.name;
  if (ref.list) {
    inner = ref.listItemNonNull ? `[${ref.name}!]` : `[${ref.name}]`;
  }
  return ref.nonNull ? `${inner}!` : inner;
}

/**
 * Build a deterministic GraphQL operation document for one root field, naming
 * the operation and declaring required arguments as GraphQL variables and
 * passing them through to the root field. Output is stable for a given index.
 */
export function buildOperationDocument(operation: GraphQLOperationDef, index: GraphQLContractIndex): string {
  const opName = `${operation.field.charAt(0).toUpperCase()}${operation.field.slice(1)}`;
  const declaredVars = operation.args.filter((arg) => arg.required);
  const varDecls = declaredVars.length
    ? `(${declaredVars.map((arg) => `$${arg.name}: ${argTypeSdl(arg)}`).join(', ')})`
    : '';
  const fieldArgs = declaredVars.length
    ? `(${declaredVars.map((arg) => `${arg.name}: $${arg.name}`).join(', ')})`
    : '';
  const selection = selectionSet(operation.returns, index, 1);
  return `${operation.kind} ${opName}${varDecls} {\n  ${operation.field}${fieldArgs}${selection}\n}`;
}

/**
 * Build the `variables` JSON string for an operation document: a placeholder
 * object keyed by each required argument, using a Postman variable reference so
 * the operator can fill values without editing the query. Empty string when the
 * operation has no required arguments.
 */
export function buildVariablesJson(operation: GraphQLOperationDef): string {
  const declaredVars = operation.args.filter((arg) => arg.required);
  if (declaredVars.length === 0) return '';
  const obj: JsonRecord = {};
  for (const arg of declaredVars) obj[arg.name] = `{{${operation.field}_${arg.name}}}`;
  return JSON.stringify(obj);
}

/**
 * Split a (possibly variable-interpolated) URL string into the v2.1.0 url
 * descriptor. The raw form is always preserved so Newman resolves it verbatim;
 * host/path are a best-effort structured split for the Postman UI.
 */
function buildUrlDescriptor(raw: string): JsonRecord {
  const descriptor: JsonRecord = { raw };
  const withoutProtocol = raw.replace(/^[a-zA-Z][\w+.-]*:\/\//, '');
  const [hostAndPath] = withoutProtocol.split('?');
  const slash = hostAndPath.indexOf('/');
  const hostPart = slash === -1 ? hostAndPath : hostAndPath.slice(0, slash);
  const pathPart = slash === -1 ? '' : hostAndPath.slice(slash + 1);
  if (hostPart) descriptor.host = [hostPart];
  const segments = pathPart.split('/').filter((segment) => segment.length > 0);
  if (segments.length > 0) descriptor.path = segments;
  return descriptor;
}

function buildItem(
  operation: GraphQLOperationDef,
  index: GraphQLContractIndex,
  opts: BuildGraphQLCollectionOptions
): JsonRecord {
  const header = [
    { key: 'Content-Type', value: 'application/json' },
    ...(opts.headers ?? []).map((entry) => ({ ...entry }))
  ];
  return {
    id: operation.id,
    name: `${operation.kind} ${operation.field}`,
    request: {
      method: 'POST',
      header,
      body: {
        mode: 'graphql',
        graphql: {
          query: buildOperationDocument(operation, index),
          variables: buildVariablesJson(operation)
        }
      },
      url: buildUrlDescriptor(opts.url?.trim() || DEFAULT_URL)
    },
    event: [] as JsonRecord[]
  };
}

/**
 * Build a v2.1.0 collection JSON object with one `http` (`body.mode: graphql`)
 * item per operation, in deterministic order (operations are already sorted in
 * the index). Each item carries an empty `event` array that the instrumenter
 * fills with an `afterResponse` (test) assertion script. The collection runs in
 * the Postman CLI / Newman HTTP path without any feature flag.
 */
export function buildGraphQLCollection(index: GraphQLContractIndex, opts: BuildGraphQLCollectionOptions = {}): JsonRecord {
  const variables = opts.variables ?? [{ key: 'baseUrl', value: '' }];
  return {
    info: {
      name: opts.name?.trim() || `${index.service} Contract`,
      description: `GraphQL contract assertions generated from ${index.service} schema (${index.operations.length} operations).`,
      schema: COLLECTION_V210_SCHEMA
    },
    item: index.operations.map((operation) => buildItem(operation, index, opts)),
    variable: variables.map((entry) => ({ key: entry.key, value: entry.value ?? '' }))
  };
}

export type { GraphQLObjectShape };

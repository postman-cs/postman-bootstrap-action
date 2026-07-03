import type {
  GraphQLArgumentDef,
  GraphQLContractIndex,
  GraphQLObjectShape,
  GraphQLOperationDef,
  GraphQLTypeRef
} from './parser.js';
import { renderSelection, selectFields } from './selection.js';

type JsonRecord = Record<string, unknown>;

/**
 * v2.1.0 Collection schema URL. GraphQL-over-HTTP is represented as an ordinary
 * HTTP request with `body.mode: "graphql"`, which the published v2.1.0 schema
 * lists in its body-mode enum (raw | urlencoded | formdata | file | graphql).
 * This runs in the legacy Postman CLI / Newman HTTP path.
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

/**
 * Stable ids for the negative/consistency probe items appended after the
 * operation items. The instrumenter recognizes these ids and attaches the
 * matching probe assertion script instead of operation assertions.
 */
export const GRAPHQL_PROBE_IDS = {
  /** GET must not execute mutations (GraphQL-over-HTTP). */
  getMutation: '__gql_probe_get_mutation',
  /** Malformed JSON body must be rejected as a client error. */
  malformedJson: '__gql_probe_malformed_json',
  /** Document validation failure status discipline (422/400, never 2xx under graphql-response+json). */
  invalidDocument: '__gql_probe_invalid_document',
  /** Live introspection vs schema-of-record drift. */
  introspectionDrift: '__gql_probe_introspection_drift',
  /** Apollo Federation subgraph `_service { sdl }`. */
  federationService: '__gql_probe_federation_service'
} as const;

/**
 * Bounded introspection document for the drift probe: root operation type
 * names, every named type with kind, field/enum-value names with deprecation
 * flags (GraphQL spec section 4: servers with introspection enabled answer
 * this without arguments beyond includeDeprecated).
 */
export const INTROSPECTION_DRIFT_QUERY =
  'query PostmanContractIntrospectionProbe { __schema { queryType { name } mutationType { name } subscriptionType { name } types { name kind possibleTypes { name } fields(includeDeprecated: true) { name isDeprecated type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } } } } enumValues(includeDeprecated: true) { name isDeprecated } } } }';

const PROBE_HEADERS = [
  { key: 'Content-Type', value: 'application/json' },
  { key: 'Accept', value: 'application/graphql-response+json, application/json;q=0.9' }
];

function rawJsonProbeItem(id: string, name: string, rawBody: string, url: string): JsonRecord {
  return {
    id,
    name,
    request: {
      method: 'POST',
      header: PROBE_HEADERS.map((entry) => ({ ...entry })),
      body: { mode: 'raw', raw: rawBody, options: { raw: { language: 'json' } } },
      url: buildUrlDescriptor(url)
    },
    event: [] as JsonRecord[]
  };
}

function buildProbeItems(index: GraphQLContractIndex, opts: BuildGraphQLCollectionOptions): JsonRecord[] {
  const url = opts.url?.trim() || DEFAULT_URL;
  const probes: JsonRecord[] = [];

  probes.push(rawJsonProbeItem(
    GRAPHQL_PROBE_IDS.introspectionDrift,
    'probe: introspection matches the schema of record',
    JSON.stringify({ query: INTROSPECTION_DRIFT_QUERY }),
    url
  ));
  probes.push(rawJsonProbeItem(
    GRAPHQL_PROBE_IDS.invalidDocument,
    'probe: validation failure uses request-error status rules',
    JSON.stringify({ query: 'query PostmanContractInvalidDocumentProbe { __postmanContractUndefinedFieldProbe }' }),
    url
  ));
  // Body is intentionally NOT valid JSON: the probe asserts parse-failure handling.
  probes.push(rawJsonProbeItem(
    GRAPHQL_PROBE_IDS.malformedJson,
    'probe: malformed JSON body is rejected',
    '{"query": "quer',
    url
  ));
  if (index.operations.some((operation) => operation.kind === 'mutation')) {
    const getUrl = buildUrlDescriptor(url);
    getUrl.query = [{ key: 'query', value: 'mutation PostmanContractGetMutationProbe { __typename }' }];
    getUrl.raw = `${String(getUrl.raw)}?query=${encodeURIComponent('mutation PostmanContractGetMutationProbe { __typename }')}`;
    probes.push({
      id: GRAPHQL_PROBE_IDS.getMutation,
      name: 'probe: GET must not execute mutations',
      request: {
        method: 'GET',
        header: [{ key: 'Accept', value: 'application/graphql-response+json, application/json;q=0.9' }],
        url: getUrl
      },
      event: [] as JsonRecord[]
    });
  }
  if (index.federated) {
    probes.push(rawJsonProbeItem(
      GRAPHQL_PROBE_IDS.federationService,
      'probe: federation subgraph exposes _service.sdl',
      JSON.stringify({ query: 'query PostmanContractFederationProbe { _service { sdl } }' }),
      url
    ));
  }
  return probes;
}

function argTypeSdl(arg: GraphQLArgumentDef): string {
  const ref = arg.type;
  // Wrap the named type by every list dimension (inner -> outer) so nested-list
  // argument types (`[[Int]]`, `[[Int!]!]`) render faithfully.
  let inner = ref.name;
  for (let i = ref.lists.length - 1; i >= 0; i -= 1) {
    inner = ref.lists[i].itemNonNull ? `[${inner}!]` : `[${inner}]`;
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
  const selection = renderSelection(selectFields(operation.returns, index, 1), 1);
  return `${operation.kind} ${opName}${varDecls} {\n  ${operation.field}${fieldArgs}${selection}\n}`;
}

/**
 * Built-in scalars whose JSON representation is NOT a string, so the Postman
 * placeholder must be emitted unquoted to survive substitution as valid JSON.
 * `String` and `ID` stay quoted; custom scalars default to quoted (safe fallback).
 */
const UNQUOTED_SCALARS = new Set(['Int', 'Float', 'Boolean']);

/**
 * Whether a variable placeholder for the given type ref should be emitted
 * unquoted in the variables JSON template. Non-scalar types (input objects,
 * lists) and numeric/boolean scalars produce non-string JSON values; quoting
 * them would yield malformed JSON after Postman substitution.
 */
function shouldEmitUnquoted(ref: GraphQLTypeRef): boolean {
  if (ref.lists.length > 0) return true;
  if (ref.kind === 'input' || ref.kind === 'object') return true;
  if (ref.kind === 'scalar' && UNQUOTED_SCALARS.has(ref.name)) return true;
  return false;
}

/**
 * Build the `variables` JSON string for an operation document: a placeholder
 * object keyed by each required argument, using a Postman variable reference so
 * the operator can fill values without editing the query. Non-scalar and
 * numeric/boolean scalars are emitted unquoted so a JSON-object or JSON-number
 * variable value substitutes cleanly. Empty string when the operation has no
 * required arguments.
 */
export function buildVariablesJson(operation: GraphQLOperationDef): string {
  const declaredVars = operation.args.filter((arg) => arg.required);
  if (declaredVars.length === 0) return '';
  const placeholder = (arg: GraphQLArgumentDef): string => `{{${operation.field}_${arg.name}}}`;
  const entries = declaredVars.map((arg) => {
    const key = JSON.stringify(arg.name);
    const val = shouldEmitUnquoted(arg.type) ? placeholder(arg) : JSON.stringify(placeholder(arg));
    return `${key}:${val}`;
  });
  return `{${entries.join(',')}}`;
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
    // GraphQL-over-HTTP: clients MUST include Accept; prefer the modern media
    // type while keeping legacy application/json acceptable.
    { key: 'Accept', value: 'application/graphql-response+json, application/json;q=0.9' },
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
 * the Postman CLI / Newman HTTP path.
 */
export function buildGraphQLCollection(index: GraphQLContractIndex, opts: BuildGraphQLCollectionOptions = {}): JsonRecord {
  const variables = opts.variables ?? [{ key: 'baseUrl', value: '' }];
  return {
    info: {
      name: opts.name?.trim() || `${index.service} Contract`,
      description: `GraphQL contract assertions generated from ${index.service} schema (${index.operations.length} operations).`,
      schema: COLLECTION_V210_SCHEMA
    },
    item: [
      ...index.operations.map((operation) => buildItem(operation, index, opts)),
      ...buildProbeItems(index, opts)
    ],
    variable: variables.map((entry) => ({ key: entry.key, value: entry.value ?? '' }))
  };
}

export type { GraphQLObjectShape };

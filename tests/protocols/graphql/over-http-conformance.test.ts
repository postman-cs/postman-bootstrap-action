import { describe, expect, it } from 'vitest';

import { buildGraphQLCollection } from '../../../src/lib/protocols/graphql/builder.js';
import { instrumentGraphQLCollection } from '../../../src/lib/protocols/graphql/instrumenter.js';
import { parseGraphQLSchema } from '../../../src/lib/protocols/graphql/parser.js';

const SDL = [
  'type Query { user(id: ID!): User plans: [Plan!]! }',
  'type Mutation { addPlan(name: String!): Plan }',
  'type User { id: ID! name: String }',
  'type Plan { id: ID! name: String! }'
].join('\n');

function instrumentedScript(): string {
  const index = parseGraphQLSchema(SDL);
  const collection = buildGraphQLCollection(index);
  const { collection: instrumented } = instrumentGraphQLCollection(collection, index);
  return JSON.stringify(instrumented);
}

describe('GraphQL-over-HTTP request/response conformance (graphql_runtime_over_http)', () => {
  const scripts = instrumentedScript();
  const cases: Array<[string, string]> = [
    ['row 5 POST media type', 'GraphQL POST requests must use Content-Type application/json'],
    ['row 5 POST charset', 'GraphQL POST requests must use UTF-8 when a charset is declared'],
    ['row 7 POST query string', 'GraphQL POST request JSON must contain a non-empty string query'],
    ['row 8 operationName type', 'GraphQL request operationName must be a string when present'],
    ['row 8 variables type', 'GraphQL request variables must be a JSON object map when present'],
    ['row 8 extensions type', 'GraphQL request extensions must be a JSON object map when present'],
    ['row 9 reserved top-level keys', 'GraphQL POST request JSON may only contain query, operationName, variables, and extensions'],
    ['row 17 response charset UTF-8', 'GraphQL-over-HTTP responses must be encoded in UTF-8'],
    ['row 17 response charset absent warn', 'omits an explicit charset'],
    ['row 18 Accept negotiation', 'was not offered in the request Accept header'],
    ['row 19 non-null data 2xx', 'response with non-null data must use a 2xx status'],
    ['row 20 clean success 200', 'a fully successful GraphQL response should use HTTP 200'],
    ['row 21 partial success 294', 'partial-success GraphQL response (data with field errors) may use draft status 294'],
    ['row 22 no data 4xx/5xx', 'request-error results (no data entry) must use a 4xx or 5xx status'],
    ['row 23 legacy json 200', 'carrying data over application/json must be HTTP 200'],
    ['row 23 legacy json should 200', 'over legacy application/json should use HTTP 200'],
    ['row 24 legacy non-200 trust boundary', 'is not a GraphQL response the client may rely on']
  ];
  for (const [name, needle] of cases) {
    it('emits: ' + name, () => {
      expect(scripts).toContain(needle);
    });
  }
});

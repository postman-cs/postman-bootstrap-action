import { describe, expect, it } from 'vitest';

import { buildGraphQLCollection } from '../../../src/lib/protocols/graphql/builder.js';
import { instrumentGraphQLCollection } from '../../../src/lib/protocols/graphql/instrumenter.js';
import { parseGraphQLSchema } from '../../../src/lib/protocols/graphql/parser.js';

const SDL = [
  'type Query { node: Node! things: [Thing!]! }',
  'interface Node { id: ID! }',
  'type Thing implements Node { id: ID! name: String! }'
].join('\n');

function script(): string {
  const index = parseGraphQLSchema(SDL);
  const collection = buildGraphQLCollection(index);
  const { collection: instrumented } = instrumentGraphQLCollection(collection, index);
  return JSON.stringify(instrumented);
}

describe('GraphQL runtime execution assertions (graphql_runtime_execution)', () => {
  const s = script();
  const cases: Array<[string, string]> = [
    ['row 3 exact single root key', 'must contain exactly the single requested root field'],
    ['row 4 exact selected key set', 'response object must contain exactly the selected fields'],
    ['row 5 field-order advisory', 'response field order should follow the selection set order'],
    ['row 6 error path begins with field name', 'must begin with a response field name'],
    ['row 6 error path uniqueness', 'at most one entry per unique response path'],
    ['row 7 non-null propagation to data map', 'must propagate the null to the enclosing data map'],
    ['row 9 null propagation with field error', 'null propagation from a non-null field must be accompanied'],
    ['row 9 non-null list item', 'a non-null list item'],
    ['row 10 interface __typename implementor', 'is not a declared implementor of interface'],
    ['row 11 introspection drift parity', 'drift']
  ];
  for (const [name, needle] of cases) {
    it('emits: ' + name, () => {
      expect(s.toLowerCase()).toContain(needle.toLowerCase());
    });
  }
});

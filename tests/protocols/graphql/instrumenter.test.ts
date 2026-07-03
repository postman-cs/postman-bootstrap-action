import { Script, createContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSchema, introspectionFromSchema } from 'graphql';
import { describe, expect, it } from 'vitest';

import { parseGraphQLSchema } from '../../../src/lib/protocols/graphql/parser.js';
import { buildGraphQLCollection } from '../../../src/lib/protocols/graphql/builder.js';
import { instrumentGraphQLCollection } from '../../../src/lib/protocols/graphql/instrumenter.js';

const fixtureSdl = readFileSync(
  resolve(import.meta.dirname, '../../../fixtures/graphql/telecom.graphql'),
  'utf8'
);

type Item = {
  id: string;
  request: {
    method: string;
    header: Array<{ key: string; value: string }>;
    body: Record<string, unknown>;
  };
  event: Array<{ listen: string; script: { exec: string[] } }>;
};

type TestResult = { name: string; passed: boolean; error?: string };

function buildInstrumented() {
  const index = parseGraphQLSchema(fixtureSdl, { service: 'Telecom' });
  const collection = buildGraphQLCollection(index, { url: '{{baseUrl}}/graphql' });
  return { index, ...instrumentGraphQLCollection(collection, index) };
}

function execFor(collection: { item: Item[] }, id: string): string {
  const item = collection.item.find((c) => c.id === id)!;
  const event = item.event.find((e) => e.listen === 'test')!;
  return event.script.exec.join('\n');
}

function headerList(entries: Array<{ key: string; value: string }>) {
  return {
    get(key: string): string {
      const match = [...entries].reverse().find((entry) => entry.key.toLowerCase() === key.toLowerCase());
      return match?.value ?? '';
    }
  };
}

function createExpect() {
  const expectFn = ((actual: unknown, msg?: string) => {
    const fail = (fallback: string): never => {
      throw new Error(msg ?? fallback);
    };
    const checkType = (type: string): void => {
      const ok = type === 'array'
        ? Array.isArray(actual)
        : type === 'object'
          ? actual !== null && typeof actual === 'object' && !Array.isArray(actual)
          : typeof actual === type;
      if (!ok) fail(`expected ${type}`);
    };
    const to: Record<string, unknown> = {};
    const be: Record<string, unknown> = {
      a: checkType,
      an: checkType,
      below(limit: number): void {
        if (typeof actual !== 'number' || !(actual < limit)) fail(`expected ${String(actual)} to be below ${limit}`);
      },
      oneOf(values: unknown[]): void {
        if (!values.includes(actual)) fail(`expected ${String(actual)} to be one of ${JSON.stringify(values)}`);
      }
    };
    const notBe: Record<string, unknown> = {};
    Object.defineProperty(notBe, 'null', {
      get() {
        if (actual === null) fail('expected value not to be null');
        return true;
      }
    });
    Object.defineProperty(to, 'exist', {
      get() {
        if (actual === null || actual === undefined) fail('expected value to exist');
        return true;
      }
    });
    Object.assign(to, {
      be,
      equal(expected: unknown): void {
        if (actual !== expected) fail(`expected ${String(actual)} to equal ${String(expected)}`);
      },
      eql(expected: unknown): void {
        if (actual !== expected) fail(`expected ${String(actual)} to equal ${String(expected)}`);
      },
      have: {
        property(name: string): void {
          if (!actual || typeof actual !== 'object' || !Object.prototype.hasOwnProperty.call(actual, name)) {
            fail(`expected property ${name}`);
          }
        }
      },
      not: { be: notBe }
    });
    return { to };
  }) as ((actual: unknown, msg?: string) => { to: Record<string, unknown> }) & { fail: (message?: string) => never };
  expectFn.fail = (message?: string): never => {
    throw new Error(message ?? 'pm.expect.fail');
  };
  return expectFn;
}

function runGraphQLScript(
  item: Item,
  responseJson: unknown,
  overrides: {
    requestMethod?: string;
    requestHeaders?: Array<{ key: string; value: string }>;
    requestBody?: Record<string, unknown>;
    responseCode?: number;
    responseHeaders?: Array<{ key: string; value: string }>;
  } = {}
): TestResult[] {
  const results: TestResult[] = [];
  const script = execFor({ item: [item] }, item.id);
  const pm = {
    request: {
      method: overrides.requestMethod ?? item.request.method,
      headers: headerList(overrides.requestHeaders ?? item.request.header),
      body: overrides.requestBody ?? item.request.body
    },
    response: {
      code: overrides.responseCode ?? 200,
      headers: headerList(overrides.responseHeaders ?? [{ key: 'Content-Type', value: 'application/graphql-response+json; charset=utf-8' }]),
      json: (): unknown => responseJson
    },
    expect: createExpect(),
    test(name: string, fn: () => void): void {
      try {
        fn();
        results.push({ name, passed: true });
      } catch (error) {
        results.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  new Script(script).runInContext(createContext({ pm, console: { warn() {} }, JSON, Array, Object, Number, String, RegExp }));
  return results;
}

function testResult(results: TestResult[], name: string): TestResult | undefined {
  return results.find((entry) => entry.name === name);
}

describe('instrumentGraphQLCollection', () => {
  it('injects one test script per graphql http item', () => {
    const { collection } = buildInstrumented();
    for (const item of (collection as unknown as { item: Item[] }).item) {
      const after = item.event.filter((e) => e.listen === 'test');
      expect(after).toHaveLength(1);
      expect(after[0]!.script.exec.join('\n')).toContain('pm.test(');
    }
  });

  it('asserts errors absent and data.<rootField> presence via parsed JSON body', () => {
    const { collection } = buildInstrumented();
    const exec = execFor(collection as unknown as { item: Item[] }, 'query.subscribers');
    expect(exec).toContain('GraphQL errors are well-formed and not a total failure');
    expect(exec).toContain('pm.response.json()');
    expect(exec).toContain('gqlBody.errors');
    expect(exec).toContain('data.subscribers is present');
    expect(exec).toContain('to.have.property("subscribers")');
  });

  it('asserts non-null return cannot be null', () => {
    const { collection } = buildInstrumented();
    const exec = execFor(collection as unknown as { item: Item[] }, 'query.subscribers');
    expect(exec).toContain('declared non-null but was null');
  });

  it('asserts list-ness and element object shape with required scalar fields', () => {
    const { collection } = buildInstrumented();
    const exec = execFor(collection as unknown as { item: Item[] }, 'query.plans');
    expect(exec).toContain('expected a list');
    expect(exec).toContain('to.be.an("array")');
    // Plan has non-null scalar fields id, monthlyPriceCents, name.
    expect(exec).toContain("is missing non-null field 'id'");
    expect(exec).toContain("is missing non-null field 'name'");
  });

  it('fails when data contains any root key other than the requested field', () => {
    const { collection } = buildInstrumented();
    const subscriber = (collection as unknown as { item: Item[] }).item.find((entry) => entry.id === 'query.subscriber')!;
    const results = runGraphQLScript(subscriber, {
      data: {
        subscriber: { id: 'sub_1', displayName: 'Alice', email: null },
        debug: true
      }
    });
    expect(testResult(results, '[query subscriber] data.subscriber is present')?.passed).toBe(false);
  });

  it('fails when an object payload omits or adds keys beyond the generated selection', () => {
    const { collection } = buildInstrumented();
    const subscriber = (collection as unknown as { item: Item[] }).item.find((entry) => entry.id === 'query.subscriber')!;

    const missingNullableField = runGraphQLScript(subscriber, {
      data: { subscriber: { id: 'sub_1', displayName: 'Alice' } }
    });
    expect(testResult(missingNullableField, '[query subscriber] data.subscriber matches schema return type')?.passed).toBe(false);

    const extraField = runGraphQLScript(subscriber, {
      data: {
        subscriber: { id: 'sub_1', displayName: 'Alice', email: null, extra: 'unexpected' }
      }
    });
    expect(testResult(extraField, '[query subscriber] data.subscriber matches schema return type')?.passed).toBe(false);
  });

  it('asserts required variables were supplied for operations with required args', () => {
    const { collection } = buildInstrumented();
    const exec = execFor(collection as unknown as { item: Item[] }, 'query.subscriber');
    expect(exec).toContain('required variables are supplied');
    expect(exec).toContain('["id"]');
    // plans has no required args -> no variable assertion.
    const plansExec = execFor(collection as unknown as { item: Item[] }, 'query.plans');
    expect(plansExec).not.toContain('required variables are supplied');
  });

  it('emits request-side GraphQL-over-HTTP body and content-type assertions', () => {
    const { collection } = buildInstrumented();
    const exec = execFor(collection as unknown as { item: Item[] }, 'query.subscriber');
    expect(exec).toContain('GraphQL POST request uses application/json');
    expect(exec).toContain('GraphQL POST request body matches the JSON request shape');
    expect(exec).toContain('may only contain query, operationName, variables, and extensions');
    expect(exec).toContain('request variables must be a JSON object map when present');
  });

  it('accepts generated graphql-mode requests and normalizes empty variables strings', () => {
    const { collection } = buildInstrumented();
    const subscriber = (collection as unknown as { item: Item[] }).item.find((entry) => entry.id === 'query.subscriber')!;
    const subscriberResults = runGraphQLScript(subscriber, {
      data: { subscriber: { id: 'sub_1', displayName: 'Alice', email: 'alice@example.com' } }
    });
    expect(testResult(subscriberResults, '[query subscriber] GraphQL POST request uses application/json')?.passed).toBe(true);
    expect(testResult(subscriberResults, '[query subscriber] GraphQL POST request body matches the JSON request shape')?.passed).toBe(true);
    expect(testResult(subscriberResults, '[query subscriber] required variables are supplied')?.passed).toBe(true);

    const plans = (collection as unknown as { item: Item[] }).item.find((entry) => entry.id === 'query.plans')!;
    const plansResults = runGraphQLScript(plans, {
      data: { plans: [{ id: 'plan_1', name: 'Starter', monthlyPriceCents: 2500, dataCapGb: 10 }] }
    });
    expect(testResult(plansResults, '[query plans] GraphQL POST request body matches the JSON request shape')?.passed).toBe(true);
  });

  it('rejects edited request content types and malformed GraphQL JSON payloads', () => {
    const { collection } = buildInstrumented();
    const subscriber = (collection as unknown as { item: Item[] }).item.find((entry) => entry.id === 'query.subscriber')!;
    const responseJson = {
      data: { subscriber: { id: 'sub_1', displayName: 'Alice', email: 'alice@example.com' } }
    };

    const wrongContentType = runGraphQLScript(subscriber, responseJson, {
      requestHeaders: [
        { key: 'Content-Type', value: 'text/plain; charset=utf-16' },
        { key: 'Accept', value: 'application/graphql-response+json, application/json;q=0.9' }
      ]
    });
    expect(testResult(wrongContentType, '[query subscriber] GraphQL POST request uses application/json')?.passed).toBe(false);

    const extraKey = runGraphQLScript(subscriber, responseJson, {
      requestBody: {
        mode: 'raw',
        raw: JSON.stringify({
          query: 'query Subscriber($id: ID!) { subscriber(id: $id) { id displayName email } }',
          variables: { id: '{{subscriber_id}}' },
          persistedQuery: { sha256Hash: 'abc' }
        })
      }
    });
    expect(testResult(extraKey, '[query subscriber] GraphQL POST request body matches the JSON request shape')?.passed).toBe(false);

    const badVariables = runGraphQLScript(subscriber, responseJson, {
      requestBody: {
        mode: 'raw',
        raw: JSON.stringify({
          query: 'query Subscriber($id: ID!) { subscriber(id: $id) { id displayName email } }',
          variables: 'not-json'
        })
      }
    });
    expect(testResult(badVariables, '[query subscriber] GraphQL POST request body matches the JSON request shape')?.passed).toBe(false);
  });

  it('warns on subscriptions (non-executable) and custom scalars', () => {
    const { warnings } = buildInstrumented();
    expect(warnings.some((w) => w.startsWith('GQL_SUBSCRIPTION'))).toBe(true);
  });

  it('throws GQL_OPERATION_COVERAGE_FAILED when an item is missing', () => {
    const index = parseGraphQLSchema(fixtureSdl);
    const collection = buildGraphQLCollection(index, { url: '{{baseUrl}}/graphql' }) as unknown as { item: unknown[] };
    collection.item = collection.item.slice(0, 1);
    expect(() => instrumentGraphQLCollection(collection as Record<string, unknown>, index)).toThrow(/GQL_OPERATION_COVERAGE_FAILED/);
  });

  it('warns PROTO_ITEM_UNMATCHED for an extra graphql http item', () => {
    const index = parseGraphQLSchema(fixtureSdl);
    const collection = buildGraphQLCollection(index, { url: '{{baseUrl}}/graphql' }) as unknown as { item: Array<Record<string, unknown>> };
    collection.item.push({ id: 'query.bogus', name: 'query bogus', request: { method: 'POST', body: { mode: 'graphql', graphql: { query: '', variables: '' } } }, event: [] });
    const { warnings } = instrumentGraphQLCollection(collection as Record<string, unknown>, index);
    expect(warnings.some((w) => w.startsWith('PROTO_ITEM_UNMATCHED'))).toBe(true);
  });

  it('matches the golden snapshot of generated assertions', () => {
    const { collection } = buildInstrumented();
    const scripts = (collection as unknown as { item: Item[] }).item.map((item) => ({
      id: item.id,
      exec: item.event.find((e) => e.listen === 'test')!.script.exec.join('\n')
    }));
    expect(scripts).toMatchSnapshot();
  });

  it('produces a fully deterministic instrumented collection', () => {
    const a = JSON.stringify(buildInstrumented().collection);
    const b = JSON.stringify(buildInstrumented().collection);
    expect(a).toBe(b);
  });
});

describe('interface selection exact-key assertions', () => {
  const interfaceSdl = "interface Node { id: ID! }\ntype User implements Node { id: ID! name: String! }\ntype Query { node: Node! }\n";

  function interfaceCollection() {
    const index = parseGraphQLSchema(interfaceSdl, { service: 'Interface' });
    const collection = buildGraphQLCollection(index, { url: '{{baseUrl}}/graphql' });
    instrumentGraphQLCollection(collection, index);
    return collection as unknown as { item: Item[] };
  }

  it('treats __typename as part of the exact selected key set for interfaces', () => {
    const collection = interfaceCollection();
    const item = collection.item.find((entry) => entry.id === 'query.node')!;
    const exec = execFor(collection, 'query.node');
    expect(exec).toContain('__typename');
    expect(exec).toContain('exactly the selected fields');
    expect(exec).toContain('declared implementor of interface Node');

    const valid = runGraphQLScript(item, {
      data: { node: { __typename: 'User', id: 'user_1' } }
    });
    expect(testResult(valid, '[query node] data.node matches schema return type')?.passed).toBe(true);

    const missingTypename = runGraphQLScript(item, {
      data: { node: { id: 'user_1' } }
    });
    expect(testResult(missingTypename, '[query node] data.node matches schema return type')?.passed).toBe(false);

    const extraImplementorField = runGraphQLScript(item, {
      data: { node: { __typename: 'User', id: 'user_1', name: 'Alice' } }
    });
    expect(testResult(extraImplementorField, '[query node] data.node matches schema return type')?.passed).toBe(false);

    const invalidImplementor = runGraphQLScript(item, {
      data: { node: { __typename: 'Robot', id: 'user_1' } }
    });
    expect(testResult(invalidImplementor, '[query node] data.node matches schema return type')?.passed).toBe(false);
  });
});

describe('Relay connection selection expansion and runtime assertions', () => {
  const relaySdl = "type Query {\n  users(first: Int, after: String): UserConnection!\n}\ntype UserConnection { edges: [UserEdge!]! pageInfo: PageInfo! totalCount: Int }\ntype UserEdge { node: User! cursor: String! }\ntype User { id: ID! name: String! }\ntype PageInfo { hasNextPage: Boolean! hasPreviousPage: Boolean! startCursor: String endCursor: String }\n";

  function relayCollection() {
    const index = parseGraphQLSchema(relaySdl, { service: 'Relay' });
    const collection = buildGraphQLCollection(index, { url: '{{baseUrl}}/graphql' });
    instrumentGraphQLCollection(collection, index);
    return collection as unknown as { item: Item[] };
  }

  it('expands connection fields past the depth cap: pageInfo leaves and edges { cursor }', () => {
    const item = relayCollection().item.find((entry) => entry.id === 'query.users')!;
    const body = (item.request.body as unknown as { graphql: { query: string } }).graphql;
    expect(body.query).toContain('pageInfo');
    expect(body.query).toContain('hasNextPage');
    expect(body.query).toContain('hasPreviousPage');
    expect(body.query).toContain('endCursor');
    expect(body.query).toContain('edges');
    expect(body.query).toContain('cursor');
    // node is intentionally not selected: the Relay expansion is bounded.
    expect(body.query).not.toContain('node');
  });

  it('asserts the selected Relay contract at runtime through the shared selection', () => {
    const collection = relayCollection();
    const exec = execFor(collection, 'query.users');
    expect(exec).toContain('pageInfo');
    expect(exec).toContain('hasNextPage');
    expect(exec).toContain('cursor');
    // pageInfo is non-null in this schema, so its absence must fail closed.
    expect(exec).toContain("missing non-null field 'pageInfo'");
  });
});

describe('introspection drift probe parity', () => {
  const paritySdl = [
    'interface Node { id: ID! }',
    'type User implements Node { id: ID! friends: [User!]! }',
    'type Org implements Node { id: ID! }',
    'union SearchResult = User | Org',
    'type Query { node: Node! search: SearchResult }'
  ].join('\n');

  function introspectionProbeCollection() {
    const index = parseGraphQLSchema(paritySdl, { service: 'Parity' });
    const collection = buildGraphQLCollection(index, { url: '{{baseUrl}}/graphql' });
    instrumentGraphQLCollection(collection, index);
    return collection as unknown as { item: Item[] };
  }

  it('checks possibleTypes and field wrapper signatures against live introspection', () => {
    const collection = introspectionProbeCollection();
    const probe = collection.item.find((entry) => entry.id === '__gql_probe_introspection_drift')!;
    const exec = execFor(collection, '__gql_probe_introspection_drift');
    expect(exec).toContain('possibleTypes');
    expect(exec).toContain('fieldTypeSignatures');
    expect(exec).toContain('renderLiveType');

    const schema = buildSchema(paritySdl);
    const matching = runGraphQLScript(probe, { data: introspectionFromSchema(schema) });
    expect(testResult(matching, '[probe] deployed schema matches the schema of record (GraphQL spec section 4: introspection)')?.passed).toBe(true);

    const wrapperDrift = JSON.parse(JSON.stringify(introspectionFromSchema(schema))) as {
      __schema: { types: Array<{ name?: string; fields?: Array<{ name?: string; type?: Record<string, unknown> }> }> };
    };
    const liveQuery = wrapperDrift.__schema.types.find((type) => type.name === 'Query')!;
    const liveNode = liveQuery.fields!.find((field) => field.name === 'node')!;
    liveNode.type = { kind: 'INTERFACE', name: 'Node', ofType: null } as unknown as Record<string, unknown>;
    const wrapperResults = runGraphQLScript(probe, { data: wrapperDrift });
    expect(testResult(wrapperResults, '[probe] deployed schema matches the schema of record (GraphQL spec section 4: introspection)')?.passed).toBe(false);

    const possibleTypesDrift = JSON.parse(JSON.stringify(introspectionFromSchema(schema))) as {
      __schema: { types: Array<{ name?: string; possibleTypes?: Array<{ name?: string }> }> };
    };
    const liveNodeType = possibleTypesDrift.__schema.types.find((type) => type.name === 'Node')!;
    liveNodeType.possibleTypes = [{ name: 'User' }];
    const possibleTypesResults = runGraphQLScript(probe, { data: possibleTypesDrift });
    expect(testResult(possibleTypesResults, '[probe] deployed schema matches the schema of record (GraphQL spec section 4: introspection)')?.passed).toBe(false);
  });
});

describe('deprecated argument/input-field edition-drift lint', () => {
  const deprecatedSdl = "type Query {\n  search(term: String @deprecated(reason: \"use query\"), query: String! @deprecated(reason: \"bad idea\"), limit: Int): [String!]\n}\ninput Filter { legacy: String @deprecated(reason: \"old\"), mode: String! @deprecated(reason: \"required but deprecated\") }\ntype Mutation { run(filter: Filter): Boolean }\n";

  it('flags @deprecated on arguments and input fields as edition drift, and required ones as violations', () => {
    const index = parseGraphQLSchema(deprecatedSdl, { service: 'Drift' });
    const drift = index.warnings.filter((warning) => warning.startsWith('GQL_DEPRECATED_INPUT_EDITION_DRIFT'));
    const required = index.warnings.filter((warning) => warning.startsWith('GQL_DEPRECATED_REQUIRED_INPUT'));
    expect(drift.some((warning) => warning.includes('Query.search.term'))).toBe(true);
    expect(drift.some((warning) => warning.includes('Filter.legacy'))).toBe(true);
    expect(required.some((warning) => warning.includes('Query.search.query'))).toBe(true);
    expect(required.some((warning) => warning.includes('Filter.mode'))).toBe(true);
    expect(required.some((warning) => warning.includes('.term'))).toBe(false);
    expect(required.some((warning) => warning.includes('legacy'))).toBe(false);
  });
});

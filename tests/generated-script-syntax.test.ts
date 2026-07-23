import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script } from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  createContractScript,
  createMappingFailureScript,
  createSecretsResolverItem
} from '../src/lib/spec/collection-contracts.js';
import { buildContractIndex } from '../src/lib/spec/contract-index.js';
import { parseOpenApiDocument } from '../src/lib/spec/openapi-loader.js';
import { createSmokeTestExec, instrumentSmokeCollection } from '../src/lib/spec/smoke-tests.js';
import { parseGraphQLSchema } from '../src/lib/protocols/graphql/parser.js';
import { buildGraphQLCollection } from '../src/lib/protocols/graphql/builder.js';
import { instrumentGraphQLCollection } from '../src/lib/protocols/graphql/instrumenter.js';
import { parseWsdl } from '../src/lib/protocols/soap/parser.js';
import { buildSoapCollection } from '../src/lib/protocols/soap/builder.js';
import { instrumentSoapCollection } from '../src/lib/protocols/soap/instrumenter.js';
import { parseProtoSchema } from '../src/lib/protocols/grpc/proto-parser.js';
import { buildGrpcCollection } from '../src/lib/protocols/grpc/grpc-collection-builder.js';
import { instrumentGrpcCollection } from '../src/lib/protocols/grpc/grpc-instrumenter.js';
import { parseMcpServerSpec } from '../src/lib/protocols/mcp/mcp-parser.js';
import { buildMcpCollection } from '../src/lib/protocols/mcp/mcp-collection-builder.js';
import { instrumentMcpCollection } from '../src/lib/protocols/mcp/mcp-instrumenter.js';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';
import type { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { HAS_PROTOBUF, PROTOBUF, readFixture } from './protocols/grpc/helpers.js';

// Syntactic-validity ground truth for the assertion generators the executing
// contract suite (dynamic-contract-hardening.test.ts, which runs OpenAPI contract
// scripts under createContext/runInContext) does NOT cover: the protocol
// instrumenters (gRPC / SOAP / GraphQL) and the smoke injector. Per the Node docs
// (https://nodejs.org/api/vm.html): "new vm.Script(code) ... compiles code but does
// not run it." Construction is therefore a pure parse with no execution, so an
// invalid script fails at construction and a valid one constructs without ever
// touching the runtime sandbox globals (`pm`, ...). This test asserts syntactic
// validity only; the contract suite covers runtime behavior separately.

type JsonRecord = Record<string, unknown>;

const fixture = (rel: string): string =>
  readFileSync(resolve(import.meta.dirname, '../fixtures', rel), 'utf8');

function assertParses(label: string, source: string): void {
  expect(source.trim().length, `${label}: generated script is empty`).toBeGreaterThan(0);
  // postman-sandbox executes each script wrapped in an async IIFE
  // (";(async()=>{;" ... ";})()" -- lib/sandbox/execute.js), so a top-level `return`
  // early-exit (and `await`) is legal in a script body. Compile the source wrapped
  // the same way so the parse target matches how Postman/Newman actually run it.
  // `new Script` compiles (parses) without running it, so an unparsable generated
  // script throws here while the sandbox globals (`pm`, ...) are never touched.
  const wrapped = `;(async () => {;\n${source}\n;})();`;
  expect(() => new Script(wrapped, { filename: label }), `${label}: did not compile as JavaScript`).not.toThrow();
}

/** Every v2.1 `item.event[].script.exec` (test + prerequest) joined to a source string. */
function collectV2Scripts(node: unknown, out: Array<{ label: string; source: string }>, path = 'root'): void {
  if (!node || typeof node !== 'object') return;
  const record = node as JsonRecord;
  const name = typeof record.name === 'string' ? record.name : path;
  for (const raw of Array.isArray(record.event) ? record.event : []) {
    const event = raw as JsonRecord;
    const script = event?.script as JsonRecord | undefined;
    const exec = script?.exec;
    const source = Array.isArray(exec) ? exec.map(String).join('\n') : typeof exec === 'string' ? exec : '';
    if (source.trim().length > 0) out.push({ label: `${name}#${String(event.listen)}`, source });
  }
  for (const child of Array.isArray(record.item) ? record.item : []) {
    collectV2Scripts(child, out, name);
  }
}

function collectEcScripts(node: unknown, out: Array<{ label: string; source: string }>, path = 'root'): void {
  if (!node || typeof node !== 'object') return;
  const record = node as JsonRecord;
  const name = typeof record.title === 'string' ? record.title : path;
  const events = (record.extensions as JsonRecord | undefined)?.events;
  for (const raw of Array.isArray(events) ? events : []) {
    const event = raw as JsonRecord;
    const script = event.script as JsonRecord | undefined;
    const source = typeof script?.exec === 'string' ? script.exec : '';
    if (source.trim().length > 0) out.push({ label: `${name}#${String(event.listen)}`, source });
  }
  for (const child of Array.isArray(record.children) ? record.children : []) collectEcScripts(child, out, name);
  for (const child of Array.isArray(record.item) ? record.item : []) collectEcScripts(child, out, name);
}

const OPENAPI_SPEC = `openapi: 3.0.3
info: { title: Syntax Fixture API, version: '1.0.0' }
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { type: array, items: { type: object, properties: { id: { type: integer }, name: { type: string } } } }
    post:
      operationId: createPet
      requestBody:
        required: true
        content:
          application/json:
            schema: { type: object, required: [name], properties: { name: { type: string }, tag: { type: string } } }
      responses:
        '201': { description: created, content: { application/json: { schema: { type: object, properties: { id: { type: integer } } } } } }
        '400': { description: bad }
  /pets/{petId}:
    get:
      operationId: getPet
      parameters:
        - { name: petId, in: path, required: true, schema: { type: string } }
        - { name: expand, in: query, required: false, schema: { type: boolean } }
      responses:
        '200': { description: ok, content: { application/json: { schema: { type: object, properties: { id: { type: integer } } } } } }
        '404': { description: missing }
        default: { description: error }
`;

describe('generated assertion scripts are syntactically valid JavaScript', () => {
  it('OpenAPI per-operation contract scripts, mapping-failure, and secrets resolver parse', () => {
    const index = buildContractIndex(parseOpenApiDocument(OPENAPI_SPEC));
    expect(index.operations.length).toBeGreaterThan(0);
    for (const operation of index.operations) {
      assertParses(
        `contract:${operation.method} ${operation.path}`,
        createContractScript(operation).join('\n')
      );
    }
    assertParses(
      'contract:mapping-failure',
      createMappingFailureScript('No OpenAPI operation matched request GET /nope').join('\n')
    );
    const resolver: Array<{ label: string; source: string }> = [];
    collectV2Scripts(createSecretsResolverItem(), resolver);
    for (const { label, source } of resolver) assertParses(`smoke-resolver:${label}`, source);
  });

  it('pure smoke-tests helpers embed parsable v2 item.event scripts', () => {
    assertParses('smoke-helper:createSmokeTestExec', createSmokeTestExec().join('\n'));
    const instrumented = instrumentSmokeCollection({
      info: { name: 'Syntax Smoke' },
      item: [
        {
          name: 'GET /pets',
          request: { method: 'GET', url: 'https://example.test/pets' }
        }
      ]
    });
    const scripts: Array<{ label: string; source: string }> = [];
    collectV2Scripts(instrumented, scripts);
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.some((entry) => entry.label.startsWith('00 - Resolve Secrets'))).toBe(true);
    for (const { label, source } of scripts) assertParses(`smoke-helper:${label}`, source);
  });

  it('smoke injectTests afterResponse scripts parse', async () => {
    const captured: string[] = [];
    const fakeGateway = {
      requestJson: async (request: JsonRecord) => {
        const method = String(request.method ?? '');
        const path = String(request.path ?? '');
        if (method === 'get' && path.includes('/items/')) {
          return {
            data: [
              { $kind: 'http-request', id: 'i1', name: 'GET /pets' },
              { $kind: 'http-request', id: 'i2', name: '00 - Resolve Secrets' }
            ]
          };
        }
        if (method === 'patch') {
          const patch = Array.isArray(request.body) ? (request.body[0] as JsonRecord) : undefined;
          if (patch && patch.path === '/scripts' && Array.isArray(patch.value)) {
            for (const script of patch.value as JsonRecord[]) {
              if (typeof script.code === 'string') captured.push(script.code);
            }
          }
          return { data: {} };
        }
        return { data: {} };
      }
    };
    const client = new PostmanGatewayAssetsClient({
      gateway: fakeGateway as unknown as AccessTokenGatewayClient
    });
    await client.injectTests('owner-abc123def456', 'smoke');
    expect(captured.length).toBeGreaterThan(0);
    captured.forEach((source, i) => assertParses(`smoke:item-${i}`, source));
  });

  it('SOAP contract scripts parse', () => {
    const index = parseWsdl(fixture('soap/stockquote.wsdl'));
    const { collection } = instrumentSoapCollection(buildSoapCollection(index), index);
    const scripts: Array<{ label: string; source: string }> = [];
    collectV2Scripts(collection, scripts);
    expect(scripts.length).toBeGreaterThan(0);
    for (const { label, source } of scripts) assertParses(`soap:${label}`, source);
  });

  it('GraphQL contract scripts parse', () => {
    const index = parseGraphQLSchema(fixture('graphql/telecom.graphql'), { service: 'Telecom' });
    const collection = buildGraphQLCollection(index, { url: '{{baseUrl}}/graphql' });
    const { collection: instrumented } = instrumentGraphQLCollection(collection as Record<string, unknown>, index);
    const scripts: Array<{ label: string; source: string }> = [];
    collectV2Scripts(instrumented, scripts);
    expect(scripts.length).toBeGreaterThan(0);
    for (const { label, source } of scripts) assertParses(`graphql:${label}`, source);
  });

  describe.skipIf(!HAS_PROTOBUF)('gRPC contract scripts', () => {
    it('parse', () => {
      const deps = PROTOBUF ? { protobuf: PROTOBUF } : undefined;
      const index = parseProtoSchema(readFixture(), deps);
      const { collection } = buildGrpcCollection(index, {
        baseUrl: 'grpcs://telecom.example.com:443',
        idSeed: 'syntax',
        schemaLocation: 'fixtures/grpc/routeguide.proto'
      });
      const { collection: instrumented } = instrumentGrpcCollection(collection, index);
      const scripts: Array<{ label: string; source: string }> = [];
      collectV2Scripts(instrumented, scripts);
      expect(scripts.length).toBeGreaterThan(0);
      for (const { label, source } of scripts) assertParses(`grpc:${label}`, source);
    });
  });

  it('MCP HTTP runtime contract scripts parse', () => {
    const index = parseMcpServerSpec(fixture('mcp/server.json'));
    const { collection } = instrumentMcpCollection(buildMcpCollection(index), index);
    const scripts: Array<{ label: string; source: string }> = [];
    collectEcScripts(collection, scripts);
    expect(scripts.length).toBeGreaterThan(0);
    for (const { label, source } of scripts) assertParses(`mcp:${label}`, source);
  });
});

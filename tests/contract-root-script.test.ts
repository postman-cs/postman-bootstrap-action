import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildConsolidatedContractScript, concreteRequestPath } from '../src/lib/spec/contract-root-script.js';
import {
  buildDispatcherRuntime,
  ambiguousMappingMessage,
  unmatchedMappingMessage,
  buildDispatchRoutes,
  CONTRACT_RESOLVER_ITEM_NAME
} from '../src/lib/spec/contract-dispatch.js';
import {
  buildOperationContractEntry,
  buildSharedContractRuntime,
  contractSegmentApplies,
  createContractScript,
  matchOperation
} from '../src/lib/spec/collection-contracts.js';
import { buildContractIndex } from '../src/lib/spec/contract-index.js';
import { parseOpenApiDocument } from '../src/lib/spec/openapi-loader.js';

const FIXTURES = [
  '../../onboarding-e2e/fixtures/local-openapi-large/openapi.yaml',
  '../../onboarding-e2e/fixtures/telecom/openapi.yaml',
  '../integration/fixtures/rest/openapi.yaml'
];

function loadIndex(rel: string) {
  const text = readFileSync(resolve(import.meta.dirname, rel), 'utf8');
  return buildContractIndex(parseOpenApiDocument(text));
}

/** Run the emitted dispatcher against a stubbed request and return its verdict. */
function runDispatch(routes: unknown, method: string, path: string, requestName = 'req') {
  const source = [
    `var __routes = ${JSON.stringify(routes)};`,
    ...buildDispatcherRuntime(),
    'globalThis.__verdict = __contractDispatch(__routes);'
  ].join('\n');
  const context: Record<string, unknown> = {
    pm: {
      info: { requestName },
      request: {
        method,
        url: { getPath: () => path, path: path.split('/').filter(Boolean) }
      }
    }
  };
  vm.createContext(context);
  new vm.Script(source).runInContext(context);
  return (context as { __verdict: { skip?: boolean; opKey?: string; error?: string } }).__verdict;
}

describe('consolidated contract root script', () => {
  for (const fixture of FIXTURES) {
    describe(fixture, () => {
      const index = loadIndex(fixture);

      it('has operations to consolidate', () => {
        expect(index.operations.length).toBeGreaterThan(0);
      });

      it('emits shards that compile and use no eval or Function constructor', () => {
        const result = buildConsolidatedContractScript(index, []);
        expect(result.shards.length).toBeGreaterThan(0);
        for (const shard of result.shards) {
          const code = shard.exec.join('\n');
          expect(() => new vm.Script(code)).not.toThrow();
          // Strip string/template literals before scanning: generated assertion
          // text legitimately mentions these words.
          const stripped = code
            .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
            .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
          expect(stripped).not.toMatch(/\beval\s*\(/);
          expect(stripped).not.toMatch(/new\s+Function\s*\(/);
        }
      });

      it('covers every operation exactly once across shards', () => {
        const result = buildConsolidatedContractScript(index, []);
        const keys = result.shards.flatMap((shard) => shard.operationKeys);
        expect(new Set(keys).size).toBe(keys.length);
        expect([...keys].sort()).toEqual(index.operations.map((op) => op.id).sort());
      });

      it('keeps exactly one primary shard for mapping-failure reporting', () => {
        const result = buildConsolidatedContractScript(index, []);
        const primaries = result.shards.filter((shard) =>
          shard.exec.includes('var __contractPrimaryShard = true;')
        );
        expect(primaries).toHaveLength(1);
      });

      it('preserves each operation assertion inventory and guard set', () => {
        const result = buildConsolidatedContractScript(index, []);
        const shardFor = new Map<string, string[]>();
        for (const shard of result.shards) {
          for (const key of shard.operationKeys) shardFor.set(key, shard.exec);
        }
        const segments = buildSharedContractRuntime();
        const testNames = (lines: string[]) =>
          (lines.join('\n').match(/pm\.test\((['"])(?:[^'"\\]|\\.)*?\1/g) ?? []).sort();

        for (const operation of index.operations) {
          const legacy = createContractScript(operation, []);
          const entry = buildOperationContractEntry(operation, []);
          const applicable = segments.filter((segment) => contractSegmentApplies(segment, entry));

          // Guard flags emitted into the entry factory must agree with the
          // build-time segment selection the legacy path used.
          const shard = shardFor.get(operation.id);
          expect(shard, operation.id).toBeDefined();
          const factoryStart = shard!.findIndex((line) =>
            line.startsWith(`__contractEntries[${JSON.stringify(operation.id)}]`)
          );
          expect(factoryStart, operation.id).toBeGreaterThanOrEqual(0);
          const factoryEnd = shard!.indexOf('};', factoryStart);
          const factory = shard!.slice(factoryStart, factoryEnd + 1).join('\n');

          for (const guard of ['skipped', 'security', 'parameters', 'requestBodySchemas'] as const) {
            const expected = segments.some(
              (segment) => segment.guard === guard && contractSegmentApplies(segment, entry)
            );
            const hasGuard = segments.some((segment) => segment.guard === guard);
            if (hasGuard) {
              expect(factory, `${operation.id} ${guard}`).toContain(`${guard}: ${expected}`);
            }
          }

          // Every assertion the legacy script would have run is reachable: the
          // per-op prologue is carried verbatim and the applicable segments are
          // the ones the runtime guards will enter.
          const reachable = [...entry.prologue, ...applicable.flatMap((segment) => segment.lines)];
          expect(testNames(reachable)).toEqual(testNames(legacy));
          for (const line of entry.prologue) {
            expect(factory).toContain(line);
          }
        }
      });

      it('dispatches every request the same way the generation-time matcher does', () => {
        const routes = buildDispatchRoutes(index.operations);
        for (const operation of index.operations) {
          const path = concreteRequestPath(operation);
          const request = { method: operation.method, url: { raw: path } };
          const expected = matchOperation(index, request);
          const verdict = runDispatch(routes, operation.method, path);

          if (expected.operation) {
            expect(verdict.opKey, `${operation.id} -> ${path}`).toBe(expected.operation.id);
            expect(verdict.error).toBeUndefined();
          } else if (expected.ambiguous && expected.ambiguous.length > 0) {
            expect(verdict.error, `${operation.id} -> ${path}`).toBe(
              ambiguousMappingMessage(
                expected.method,
                expected.path,
                expected.ambiguous.map((entry) => entry.id)
              )
            );
          } else {
            expect(verdict.error, `${operation.id} -> ${path}`).toBe(
              unmatchedMappingMessage(expected.method, expected.path)
            );
          }
        }
      });

      it('skips the secrets resolver item instead of failing it', () => {
        const routes = buildDispatchRoutes(index.operations);
        const verdict = runDispatch(routes, 'GET', '/anything', CONTRACT_RESOLVER_ITEM_NAME);
        expect(verdict.skip).toBe(true);
        expect(verdict.error).toBeUndefined();
      });

      it('reports an unmatched request through the primary shard text', () => {
        const routes = buildDispatchRoutes(index.operations);
        const verdict = runDispatch(routes, 'TRACE', '/definitely/not/mapped');
        expect(verdict.error).toBe(unmatchedMappingMessage('TRACE', '/definitely/not/mapped'));
      });

      it('collapses the duplicated runtime', () => {
        const result = buildConsolidatedContractScript(index, []);
        expect(result.consolidatedBytes).toBeLessThan(result.legacyBytes);
        for (const shard of result.shards) {
          expect(shard.bytes).toBeLessThanOrEqual(900_000);
        }
      });
    });
  }

  it('fails closed when a single operation cannot fit the hard byte limit', () => {
    const index = loadIndex(FIXTURES[0]);
    // `path` is provably embedded in each operation's contract JSON, so an
    // absurd path inflates one entry factory past the hard gate. The builder
    // must throw instead of emitting a silently truncated script.
    const huge = `/${'x'.repeat(1_000_000)}`;
    const oversized = {
      ...index,
      operations: index.operations.slice(0, 1).map((operation) => ({ ...operation, path: huge }))
    };
    expect(() => buildConsolidatedContractScript(oversized as typeof index, [])).toThrow(
      /CONTRACT_ROOT_SCRIPT_SIZE_EXCEEDED/
    );
  });

  it('shards rather than exceeding the hard byte limit', () => {
    const index = loadIndex(FIXTURES[0]);
    // Replicate real operations under distinct paths until the emitted runtime
    // must split. Thresholds stay untouched; only the input grows.
    const template = index.operations[0];
    const operations = [];
    for (let i = 0; i < 4000; i += 1) {
      const path = `/shard-probe-${i}`;
      operations.push({ ...template, id: `GET ${path}`, method: 'GET', path, candidates: [path] });
    }
    const result = buildConsolidatedContractScript({ ...index, operations } as typeof index, []);
    expect(result.shards.length).toBeGreaterThan(1);
    for (const shard of result.shards) {
      expect(shard.bytes).toBeLessThanOrEqual(900_000);
    }
    const keys = result.shards.flatMap((shard) => shard.operationKeys);
    expect(new Set(keys).size).toBe(operations.length);
    expect(
      result.shards.filter((shard) => shard.exec.includes('var __contractPrimaryShard = true;'))
    ).toHaveLength(1);
  });
});
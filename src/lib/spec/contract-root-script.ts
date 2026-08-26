import { type ContractIndex, type ContractOperation } from './contract-index.js';
import {
  buildDispatchRoutes,
  buildDispatcherRuntime,
  contractOperationKey,
  type ContractDispatchRoute
} from './contract-dispatch.js';
import {
  buildOperationContractEntry,
  buildSharedContractRuntime,
  CONTRACT_SIZE_LIMITS,
  skippedValidatorsDataLine,
  type ContractOperationEntry,
  type ContractRuntimeSegment
} from './collection-contracts.js';


/**
 * Per-operation bindings the shared runtime reads. The generated shared runtime
 * is one function; these are the only names it needs rebound per request, so
 * they become its parameter surface instead of 101 duplicated top-level `var`s.
 */
const BINDING_NAMES = [
  'contract',
  'rfcRegistries',
  'validators',
  'linkTargetValidators',
  'requestBodyValidators',
  'paramValidators',
  'contractSkippedValidators'
] as const;

/** Neutral seeds so an operation that declares no params/body/skips still binds every name. */
const BINDING_SEEDS: Record<(typeof BINDING_NAMES)[number], string> = {
  contract: 'null',
  rfcRegistries: '{}',
  validators: '{}',
  linkTargetValidators: '{}',
  requestBodyValidators: '{}',
  paramValidators: '{}',
  contractSkippedValidators: '[]'
};

export interface ConsolidatedContractScript {
  /** Exec lines of one collection-root `test` event. */
  exec: string[];
  /** Operation keys whose entry factories live in this shard. */
  operationKeys: string[];
  bytes: number;
}

export interface ConsolidatedContractResult {
  shards: ConsolidatedContractScript[];
  warnings: string[];
  /** Sum of per-request script bytes the retired per-item path would have emitted. */
  legacyBytes: number;
  /** Sum of emitted root-event bytes. */
  consolidatedBytes: number;
}

function jsonParseLine(name: string, value: unknown): string {
  return `var ${name} = JSON.parse(${JSON.stringify(JSON.stringify(value))});`;
}

/**
 * Wrap the shared runtime segments in a single function. Unguarded segments sit
 * directly in the body so their ~32 top-level function declarations hoist
 * exactly as they did at script top level; guarded segments (which declare no
 * functions or vars at all) become runtime `if` blocks instead of build-time
 * omissions, which is what lets one copy serve every operation.
 */
function sharedRuntimeFunctionLines(segments: readonly ContractRuntimeSegment[]): string[] {
  const out: string[] = ['function __contractRunShared(__contractBindings) {'];
  for (const name of BINDING_NAMES) {
    out.push(`var ${name} = __contractBindings.${name};`);
  }
  for (const segment of segments) {
    if (!segment.guard) {
      out.push(...segment.lines);
      continue;
    }
    out.push(`if (__contractBindings.guards.${segment.guard}) {`);
    out.push(...segment.lines);
    out.push('}');
  }
  out.push('}');
  return out;
}

function entryFactoryLines(key: string, entry: ContractOperationEntry): string[] {
  const prologue = entry.prologue.join('\n');
  if (!/\bvar contract\b/.test(prologue)) {
    throw new Error(`CONTRACT_ROOT_SCRIPT_PROLOGUE_INVALID: ${key} prologue does not declare its contract binding`);
  }
  const lines: string[] = [`__contractEntries[${JSON.stringify(key)}] = function () {`];
  for (const name of BINDING_NAMES) {
    lines.push(`var ${name} = ${BINDING_SEEDS[name]};`);
  }
  lines.push(...entry.prologue);
  if (entry.skipped.length > 0 && !prologue.includes('contractSkippedValidators')) {
    lines.push(skippedValidatorsDataLine(entry.skipped));
  }
  lines.push('return {');
  for (const name of BINDING_NAMES) {
    lines.push(`${name}: ${name},`);
  }
  lines.push(
    `guards: { skipped: ${entry.skipped.length > 0}, security: ${entry.hasSecurity}, parameters: ${entry.hasParameters}, requestBodySchemas: ${entry.hasRequestBodySchemas} }`
  );
  lines.push('};');
  lines.push('};');
  return lines;
}

/**
 * Trailer that runs the dispatch. Every shard sees every request, so a shard
 * silently stands down for operations it does not own, and only the primary
 * shard reports a mapping failure — reusing the exact text and test name the
 * per-request `createMappingFailureScript` path emitted.
 */
function trailerLines(): string[] {
  return [
    'var __contractResult = __contractDispatch(__contractRoutes);',
    'if (!__contractResult.skip) {',
    '  if (__contractResult.error) {',
    '    if (__contractPrimaryShard) {',
    '      var contractMappingError = __contractResult.error;',
    "      pm.test('OpenAPI operation mapping exists', function () {",
    '        pm.expect.fail(contractMappingError);',
    '      });',
    '    }',
    '  } else if (Object.prototype.hasOwnProperty.call(__contractEntries, __contractResult.opKey)) {',
    '    __contractRunShared(__contractEntries[__contractResult.opKey]());',
    '  }',
    '}'
  ];
}

function byteLength(lines: readonly string[]): number {
  return Buffer.byteLength(lines.join('\n'), 'utf8');
}

/**
 * Collapse the duplicated per-request contract runtime into collection-root
 * `test` event(s): one shared runtime copy, one dispatch table, and one small
 * entry factory per operation. Sharding is the only escape hatch when the
 * emitted script would cross the hard byte gate; an operation that cannot fit
 * even alone fails closed rather than shipping a silently truncated script.
 */
export function buildConsolidatedContractScript(
  index: ContractIndex,
  warnings: string[] = []
): ConsolidatedContractResult {
  const HARD_LIMIT_BYTES = CONTRACT_SIZE_LIMITS.maxTestScriptBytes;
  const WARN_LIMIT_BYTES = CONTRACT_SIZE_LIMITS.warnTestScriptBytes;
  const segments = buildSharedContractRuntime();
  const routes: ContractDispatchRoute[] = buildDispatchRoutes(index.operations);
  const header = (primary: boolean): string[] => [
    ...buildDispatcherRuntime(),
    jsonParseLine('__contractRoutes', routes),
    `var __contractPrimaryShard = ${primary};`,
    'var __contractEntries = {};',
    ...sharedRuntimeFunctionLines(segments)
  ];
  const trailer = trailerLines();

  const sharedRuntimeBytes = byteLength(segments.flatMap((segment) => segment.lines));
  let legacyBytes = 0;
  const payloads: Array<{ key: string; lines: string[] }> = [];
  for (const operation of index.operations) {
    const entry = buildOperationContractEntry(operation, warnings);
    const key = contractOperationKey(operation);
    // The shared runtime is byte-identical for every operation, so its length is
    // measured once; per-operation cost is the prologue plus the joining newline.
    legacyBytes += byteLength(entry.prologue) + 1 + sharedRuntimeBytes;
    payloads.push({ key, lines: entryFactoryLines(key, entry) });
  }

  const fixedBytes = byteLength(header(true)) + byteLength(trailer) + 2;
  const shards: ConsolidatedContractScript[] = [];
  let current: Array<{ key: string; lines: string[] }> = [];
  let currentBytes = fixedBytes;

  const flush = (): void => {
    if (current.length === 0) return;
    const primary = shards.length === 0;
    const exec = [...header(primary), ...current.flatMap((entry) => entry.lines), ...trailer];
    shards.push({ exec, operationKeys: current.map((entry) => entry.key), bytes: byteLength(exec) });
    current = [];
    currentBytes = fixedBytes;
  };

  for (const payload of payloads) {
    const payloadBytes = byteLength(payload.lines) + 1;
    if (fixedBytes + payloadBytes > HARD_LIMIT_BYTES) {
      throw new Error(
        `CONTRACT_ROOT_SCRIPT_SIZE_EXCEEDED: ${payload.key} contract runtime needs ${fixedBytes + payloadBytes} bytes, over the ${HARD_LIMIT_BYTES} byte limit`
      );
    }
    if (currentBytes + payloadBytes > HARD_LIMIT_BYTES) flush();
    current.push(payload);
    currentBytes += payloadBytes;
  }
  flush();

  if (shards.length === 0) {
    const exec = [...header(true), ...trailer];
    shards.push({ exec, operationKeys: [], bytes: byteLength(exec) });
  }

  const consolidatedBytes = shards.reduce((total, shard) => total + shard.bytes, 0);
  for (const shard of shards) {
    if (shard.bytes > WARN_LIMIT_BYTES) {
      warnings.push(
        `CONTRACT_ROOT_SCRIPT_LARGE: consolidated contract root script is ${shard.bytes} bytes, over the ${WARN_LIMIT_BYTES} byte advisory threshold`
      );
    }
  }
  return { shards, warnings, legacyBytes, consolidatedBytes };
}

/** Concrete request path for an operation template, used by dispatch parity checks. */
export function concreteRequestPath(operation: ContractOperation): string {
  return operation.path.replace(/\{[^}]+\}/g, '1');
}
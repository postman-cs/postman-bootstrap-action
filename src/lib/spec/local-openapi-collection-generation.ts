import { createHash, randomUUID } from 'node:crypto';

import {
  convertV2WithTypes,
  type Callback,
  type CollectionResult,
  type Options
} from 'openapi-to-postmanv2';

import { instrumentContractCollection } from './collection-contracts.js';
import type { ContractIndex } from './contract-index.js';
import { instrumentSmokeCollection } from './smoke-tests.js';

export type JsonRecord = Record<string, unknown>;
export type CollectionRole = 'baseline' | 'smoke' | 'contract';

export const LOCAL_OPENAPI_CONVERSION_FAILED = 'LOCAL_OPENAPI_CONVERSION_FAILED' as const;
export const LOCAL_OPENAPI_WHOLE_IMPORT_MAX_BYTES = 16_000_000;

export type LocalOpenApiConversionStage =
  | 'validate-input'
  | 'convert'
  | 'materialize-roles'
  | 'instrument-smoke'
  | 'instrument-contract';

export class LocalOpenApiConversionError extends Error {
  readonly code = LOCAL_OPENAPI_CONVERSION_FAILED;
  readonly stage: LocalOpenApiConversionStage;
  readonly sanitizedCause: string | undefined;

  constructor(stage: LocalOpenApiConversionStage, detail: string, cause?: unknown) {
    const sanitizedCause = sanitizeCause(cause);
    super(
      sanitizedCause
        ? `${LOCAL_OPENAPI_CONVERSION_FAILED}: ${stage}: ${detail}: ${sanitizedCause}`
        : `${LOCAL_OPENAPI_CONVERSION_FAILED}: ${stage}: ${detail}`
    );
    this.name = 'LocalOpenApiConversionError';
    this.stage = stage;
    this.sanitizedCause = sanitizedCause;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export interface LocalOpenApiConversionOptions {
  openApiVersion: '3.0' | '3.1';
  requestNameSource: 'URL' | 'Fallback';
  folderStrategy: 'Paths' | 'Tags';
  nestedFolderHierarchy?: boolean;
  /** Final collection display names already including role/channel prefixes. */
  names: Record<CollectionRole, string>;
  /** Optional branch-scoped description applied to every role payload. */
  description?: string;
  /** Required when producing the contract role payload. */
  contractIndex: ContractIndex;
}

export interface LocalOpenApiStringInput {
  type: 'string';
  data: string;
}

export type LocalOpenApiConverter = (
  input: LocalOpenApiStringInput,
  options: Options,
  callback: Callback
) => void;

export interface LocalOpenApiConversionDependencies {
  converter?: LocalOpenApiConverter;
}

export interface LocalRolePayload {
  role: CollectionRole;
  collection: JsonRecord;
  payloadDigest: string;
  warnings: string[];
}

export interface LocalOpenApiRolePayloads {
  roles: Record<CollectionRole, LocalRolePayload>;
  warnings: string[];
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function sanitizeCause(cause: unknown): string | undefined {
  if (cause === undefined || cause === null) return undefined;
  if (cause instanceof Error) {
    return cause.message.replace(/\s+/g, ' ').trim().slice(0, 240);
  }
  if (typeof cause === 'string') {
    return cause.replace(/\s+/g, ' ').trim().slice(0, 240);
  }
  if (isRecord(cause) && typeof cause.message === 'string') {
    return cause.message.replace(/\s+/g, ' ').trim().slice(0, 240);
  }
  return 'non-error failure';
}

function assertValidOptions(options: LocalOpenApiConversionOptions): void {
  if (
    !isRecord(options) ||
    (options.openApiVersion !== '3.0' && options.openApiVersion !== '3.1') ||
    (options.requestNameSource !== 'URL' && options.requestNameSource !== 'Fallback') ||
    (options.folderStrategy !== 'Paths' && options.folderStrategy !== 'Tags') ||
    (options.nestedFolderHierarchy !== undefined && typeof options.nestedFolderHierarchy !== 'boolean') ||
    !isRecord(options.names) ||
    typeof options.names.baseline !== 'string' ||
    !options.names.baseline.trim() ||
    typeof options.names.smoke !== 'string' ||
    !options.names.smoke.trim() ||
    typeof options.names.contract !== 'string' ||
    !options.names.contract.trim() ||
    (options.description !== undefined && typeof options.description !== 'string') ||
    !options.contractIndex ||
    typeof options.contractIndex !== 'object'
  ) {
    throw new LocalOpenApiConversionError('validate-input', 'local OpenAPI conversion options are invalid');
  }
}

export function buildLocalOpenApiConversionOptions(options: LocalOpenApiConversionOptions): Options {
  return {
    parametersResolution: 'Example',
    requestNameSource: options.requestNameSource,
    folderStrategy: options.folderStrategy,
    ...(options.folderStrategy === 'Tags'
      ? { nestedFolderHierarchy: options.nestedFolderHierarchy ?? false }
      : {}),
    ...(options.openApiVersion === '3.1' ? { includeWebhooks: true } : {})
  };
}

function withoutStructuralIds(collection: JsonRecord): JsonRecord {
  const clone = deepClone(collection);
  if (isRecord(clone.info)) delete clone.info._postman_id;
  stripStructuralItemIds(clone.item);
  return clone;
}

function stripStructuralItemIds(items: unknown): void {
  if (!Array.isArray(items)) return;
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    delete raw.id;
    if (isRecord(raw.request)) delete raw.request.id;
    stripStructuralItemIds(raw.item);
    if (Array.isArray(raw.response)) {
      for (const response of raw.response) {
        if (isRecord(response)) delete response.id;
      }
    }
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const record = value as JsonRecord;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

/** Deterministic semantic digest of a completed role payload (volatile ids ignored). */
export function computePayloadDigest(collection: JsonRecord): string {
  return createHash('sha256').update(stableStringify(withoutStructuralIds(collection))).digest('hex');
}

export function applyCollectionIdentity(
  source: JsonRecord,
  name: string,
  description?: string
): JsonRecord {
  const clone = deepClone(source);
  const info = isRecord(clone.info) ? clone.info : {};
  const nextInfo: JsonRecord = { ...info, name };
  if (description !== undefined) {
    nextInfo.description = description;
  }
  clone.info = nextInfo;
  return clone;
}

/**
 * Assign fresh UUIDs to Collection v2 structural identities only: root
 * `info._postman_id`, each folder/request item `id`, and each saved response
 * `id` (recursive). Does not rewrite arbitrary example/schema/body properties
 * named `id` — Sync treats these structural IDs as cloud identities.
 */
export function rekeyStructuralCollectionIds(collection: JsonRecord): JsonRecord {
  const clone = deepClone(collection);
  const info = isRecord(clone.info) ? clone.info : {};
  info._postman_id = randomUUID();
  clone.info = info;
  rekeyStructuralItems(clone.item);
  return clone;
}

function rekeyStructuralItems(items: unknown): void {
  if (!Array.isArray(items)) return;
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    raw.id = randomUUID();
    if (isRecord(raw.request)) raw.request.id = randomUUID();
    if (Array.isArray(raw.item)) rekeyStructuralItems(raw.item);
    if (Array.isArray(raw.response)) {
      for (const resp of raw.response) {
        if (isRecord(resp)) resp.id = randomUUID();
      }
    }
  }
}

async function convertOnce(
  bundledOpenApi: string,
  options: LocalOpenApiConversionOptions,
  converter: LocalOpenApiConverter
): Promise<JsonRecord> {
  const result = await new Promise<CollectionResult>((resolve, reject) => {
    const callback: Callback = (error, conversionResult) => {
      if (error) {
        reject(new LocalOpenApiConversionError('convert', 'converter callback failed', error));
        return;
      }
      if (!conversionResult) {
        reject(new LocalOpenApiConversionError('convert', 'converter returned no result'));
        return;
      }
      resolve(conversionResult);
    };

    try {
      converter({ type: 'string', data: bundledOpenApi }, buildLocalOpenApiConversionOptions(options), callback);
    } catch (error) {
      reject(new LocalOpenApiConversionError('convert', 'converter invocation failed', error));
    }
  });

  if (!result.result) {
    throw new LocalOpenApiConversionError('convert', 'converter reported an unsuccessful result', result.error);
  }

  const output = result.output?.[0];
  const collection = output?.data;
  if (output?.type !== 'collection' || !isRecord(collection)) {
    throw new LocalOpenApiConversionError('convert', 'converter returned no collection data');
  }
  return collection;
}

/**
 * Convert validated/bundled OpenAPI content exactly once, then deep-clone into
 * complete pre-write baseline/smoke/contract v2 role payloads (final names,
 * optional branch description, smoke helpers, contract instrumentation).
 */
export async function generateLocalOpenApiRolePayloads(
  bundledOpenApi: string,
  options: LocalOpenApiConversionOptions,
  dependencies: LocalOpenApiConversionDependencies = {}
): Promise<LocalOpenApiRolePayloads> {
  if (typeof bundledOpenApi !== 'string' || bundledOpenApi.trim() === '') {
    throw new LocalOpenApiConversionError('validate-input', 'bundled OpenAPI content is required');
  }
  assertValidOptions(options);

  const converter = dependencies.converter ?? convertV2WithTypes;
  let converted: JsonRecord;
  try {
    converted = await convertOnce(bundledOpenApi, options, converter);
  } catch (error) {
    if (error instanceof LocalOpenApiConversionError) throw error;
    throw new LocalOpenApiConversionError('convert', 'converter failed', error);
  }

  const warnings: string[] = [];
  const description = options.description;

  let baseline: JsonRecord;
  let smoke: JsonRecord;
  let contract: JsonRecord;
  try {
    baseline = applyCollectionIdentity(converted, options.names.baseline, description);
    smoke = applyCollectionIdentity(converted, options.names.smoke, description);
    contract = applyCollectionIdentity(converted, options.names.contract, description);
  } catch (error) {
    throw new LocalOpenApiConversionError('materialize-roles', 'failed to materialize role clones', error);
  }

  try {
    smoke = instrumentSmokeCollection(smoke);
  } catch (error) {
    throw new LocalOpenApiConversionError('instrument-smoke', 'failed to embed smoke helpers', error);
  }

  try {
    const instrumented = instrumentContractCollection(contract, options.contractIndex, {
      maxCollectionUpdateBytes: LOCAL_OPENAPI_WHOLE_IMPORT_MAX_BYTES
    });
    contract = instrumented.collection;
    warnings.push(...instrumented.warnings);
  } catch (error) {
    throw new LocalOpenApiConversionError('instrument-contract', 'failed to instrument contract collection', error);
  }

  // After names/instrumentation/secrets-resolver insertion — before digests —
  // give each role disjoint structural Sync identities. Role clones otherwise
  // reuse converter nested request/response IDs and concurrent imports collide.
  try {
    baseline = rekeyStructuralCollectionIds(baseline);
    smoke = rekeyStructuralCollectionIds(smoke);
    contract = rekeyStructuralCollectionIds(contract);
  } catch (error) {
    throw new LocalOpenApiConversionError('materialize-roles', 'failed to rekey structural collection ids', error);
  }

  const roles: Record<CollectionRole, LocalRolePayload> = {
    baseline: {
      role: 'baseline',
      collection: baseline,
      payloadDigest: computePayloadDigest(baseline),
      warnings: []
    },
    smoke: {
      role: 'smoke',
      collection: smoke,
      payloadDigest: computePayloadDigest(smoke),
      warnings: []
    },
    contract: {
      role: 'contract',
      collection: contract,
      payloadDigest: computePayloadDigest(contract),
      warnings: [...warnings]
    }
  };

  return { roles, warnings };
}

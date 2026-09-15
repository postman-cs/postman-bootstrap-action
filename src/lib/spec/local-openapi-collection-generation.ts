import { createHash, randomUUID } from 'node:crypto';

import {
  convertV2WithTypes,
  type Callback,
  type CollectionResult,
  type Options
} from 'openapi-to-postmanv2';

import { canonicalizeV2CollectionForSync } from '../postman/collection-model-conversion.js';
import { stripCollectionSemanticReceipt } from '../postman/collection-semantic-receipt.js';
import { applyCollectionRootContent, type CollectionRootContent } from './collection-root-content.js';
import { instrumentContractCollection } from './collection-contracts.js';
import type { ContractIndex } from './contract-index.js';
import { withDeterministicSchemaFaker } from './deterministic-schema-faker.js';
import { repairGeneratedCollectionExamples } from './request-example-repair.js';
import { instrumentSmokeCollection } from './smoke-tests.js';
import {
  SECRETS_RESOLVER_PROVIDERS,
  type SecretsResolverProvider
} from '@postman-cs/automation-core';

export type JsonRecord = Record<string, unknown>;
export type CollectionRole = 'baseline' | 'smoke' | 'contract';
/** Controls whether generated examples are repaired after local conversion. */
export type ExampleRepairMode = 'strict' | 'lenient' | 'off';

export const LOCAL_OPENAPI_CONVERSION_FAILED = 'LOCAL_OPENAPI_CONVERSION_FAILED' as const;

export type LocalOpenApiConversionStage =
  | 'validate-input'
  | 'convert'
  | 'repair-request-examples'
  | 'materialize-roles'
  | 'instrument-smoke'
  | 'instrument-contract'
  | 'apply-collection-root-content';

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
  /** Defaults to lenient so best-effort example repair cannot abort conversion. */
  exampleRepair?: ExampleRepairMode;
  /**
   * Cloud secret store backing the optional `00 - Resolve Secrets` helper item.
   * Defaults to `none`: no helper request is embedded in any role payload.
   */
  secretsResolverProvider?: SecretsResolverProvider;
  /** Final collection display names already including role/channel prefixes. */
  names: Record<CollectionRole, string>;
  /** Optional branch-scoped description applied to every role payload. */
  description?: string;
  /**
   * Optional customer-supplied collection-root scripts and variable
   * declarations. Omitted by every caller that sets neither
   * `collection-scripts-json` nor `collection-variables-json`, in which case
   * role payloads are byte-identical to those produced without this option.
   */
  collectionRootContent?: CollectionRootContent;
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
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const append = (message: string): void => {
    const normalized = message.replace(/\s+/g, ' ').trim();
    if (normalized && !parts.some((part) => part.includes(normalized))) parts.push(normalized);
  };
  let current: unknown = cause;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof Error) {
      append(current.message);
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }
    if (typeof current === 'string') {
      append(current);
      break;
    }
    if (isRecord(current) && typeof current.message === 'string') {
      append(current.message);
      current = current.cause;
      continue;
    }
    parts.push('non-error failure');
    break;
  }
  if (parts.length === 0) return undefined;
  return parts.join(': ');
}

function assertValidOptions(options: LocalOpenApiConversionOptions): void {
  if (
    !isRecord(options) ||
    (options.openApiVersion !== '3.0' && options.openApiVersion !== '3.1') ||
    (options.requestNameSource !== 'URL' && options.requestNameSource !== 'Fallback') ||
    (options.folderStrategy !== 'Paths' && options.folderStrategy !== 'Tags') ||
    (options.nestedFolderHierarchy !== undefined && typeof options.nestedFolderHierarchy !== 'boolean') ||
    (options.exampleRepair !== undefined && !['strict', 'lenient', 'off'].includes(options.exampleRepair)) ||
    (options.secretsResolverProvider !== undefined &&
      !(SECRETS_RESOLVER_PROVIDERS as readonly string[]).includes(String(options.secretsResolverProvider))) ||
    !isRecord(options.names) ||
    typeof options.names.baseline !== 'string' ||
    !options.names.baseline.trim() ||
    typeof options.names.smoke !== 'string' ||
    !options.names.smoke.trim() ||
    typeof options.names.contract !== 'string' ||
    !options.names.contract.trim() ||
    (options.description !== undefined && typeof options.description !== 'string') ||
    (options.collectionRootContent !== undefined && !isRecord(options.collectionRootContent)) ||
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
  // Digest the JSON wire representation. `structuredClone` preserves object
  // properties whose value is undefined, but JSON transport omits them; hashing
  // those non-serializable properties makes an import/export round trip appear
  // different even when the transmitted collection is exact.
  const clone = JSON.parse(JSON.stringify(collection)) as JsonRecord;
  stripSyncDefaults(clone);
  if (isRecord(clone.info)) {
    delete clone.info._postman_id;
    const description = stripCollectionSemanticReceipt(clone.info.description);
    if (description === undefined || description === null || description === '') {
      delete clone.info.description;
    } else clone.info.description = description;
  }
  normalizeSyncAuth(clone.auth);
  if (Array.isArray(clone.event) && clone.event.length === 0) delete clone.event;
  else normalizeEventScriptExec(clone.event);
  stripStructuralItemIds(clone.item);
  return clone;
}

function stripStructuralItemIds(items: unknown): void {
  if (!Array.isArray(items)) return;
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    delete raw.id;
    if (raw.description === '') delete raw.description;
    if (Array.isArray(raw.event) && raw.event.length === 0) delete raw.event;
    else normalizeEventScriptExec(raw.event);
    normalizeProtocolProfileBehavior(raw);
    if (isRecord(raw.request)) {
      delete raw.request.id;
      if (raw.request.auth === null) delete raw.request.auth;
      else normalizeSyncAuth(raw.request.auth);
      normalizeSyncRequest(raw.request);
    }
    stripStructuralItemIds(raw.item);
    if (Array.isArray(raw.response)) {
      for (const response of raw.response) {
        if (isRecord(response)) {
          delete response.id;
          if (isRecord(response.originalRequest)) {
            delete response.originalRequest.id;
            normalizeSyncAuth(response.originalRequest.auth);
            normalizeSyncRequest(response.originalRequest);
          }
        }
      }
      if (raw.response.length === 0) delete raw.response;
    }
  }
  const folders = items.filter((item) => isRecord(item) && Array.isArray(item.item));
  const requests = items.filter((item) => !(isRecord(item) && Array.isArray(item.item)));
  items.splice(0, items.length, ...folders, ...requests);
}

function normalizeSyncRequest(request: JsonRecord): void {
  if (Array.isArray(request.header) && request.header.length === 0) delete request.header;
  const url = isRecord(request.url) ? request.url : null;
  if (!url) return;
  for (const field of ['query', 'variable'] as const) {
    if (!Array.isArray(url[field])) continue;
    for (const parameter of url[field]) {
      if (!isRecord(parameter)) continue;
      if (parameter.description === '') delete parameter.description;
      if (parameter.disabled === false) delete parameter.disabled;
    }
    if (url[field].length === 0) delete url[field];
  }
  if (typeof url.raw === 'string') request.url = url.raw;
}

function stripSyncDefaults(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) stripSyncDefaults(entry);
    return;
  }
  if (!isRecord(value)) return;
  if (value.description === '') delete value.description;
  if (value.disabled === false) delete value.disabled;
  for (const entry of Object.values(value)) stripSyncDefaults(entry);
}

function normalizeSyncAuth(auth: unknown): void {
  if (!isRecord(auth) || auth.type !== 'bearer' || !Array.isArray(auth.bearer)) return;
  for (const credential of auth.bearer) {
    if (
      isRecord(credential) &&
      credential.key === 'token' &&
      credential.type === 'string'
    ) {
      // Sync preserves the bearer token itself but omits this converter-only UI hint.
      delete credential.type;
    }
  }
}

function normalizeProtocolProfileBehavior(item: JsonRecord): void {
  const behavior = isRecord(item.protocolProfileBehavior) ? item.protocolProfileBehavior : null;
  if (!behavior) return;
  if (typeof behavior.disableBodyPruning === 'boolean') {
    // Collection v3 has no representation for this legacy v2 converter field,
    // so Sync import drops it before the authoritative export is produced.
    delete behavior.disableBodyPruning;
  }
  if (Object.keys(behavior).length === 0) delete item.protocolProfileBehavior;
}

function normalizeEventScriptExec(events: unknown): void {
  if (!Array.isArray(events)) return;
  for (const event of events) {
    if (!isRecord(event) || !isRecord(event.script) || !Array.isArray(event.script.exec)) continue;
    if (event.script.type === 'text/javascript') delete event.script.type;
    if (event.script.exec.every((line) => typeof line === 'string')) {
      event.script.exec = [event.script.exec.join('\n')];
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

function semanticDifferenceValue(value: unknown): string {
  const serialized = stableStringify(value);
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  return `${kind}:bytes=${Buffer.byteLength(serialized)}:sha256=${createHash('sha256').update(serialized).digest('hex').slice(0, 12)}`;
}

/** Content-free first semantic difference for live import/export diagnostics. */
export function describePayloadDigestDifference(expected: JsonRecord, observed: JsonRecord): string {
  const visit = (left: unknown, right: unknown, path: string): string | null => {
    if (stableStringify(left) === stableStringify(right)) return null;
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) return `${path}.length expected=${left.length} observed=${right.length}`;
      for (let index = 0; index < left.length; index += 1) {
        const difference = visit(left[index], right[index], `${path}[${index}]`);
        if (difference) return difference;
      }
    } else if (
      left !== null && right !== null && typeof left === 'object' && typeof right === 'object'
    ) {
      const leftRecord = left as JsonRecord;
      const rightRecord = right as JsonRecord;
      const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
      for (const key of keys) {
        if (!(key in leftRecord)) return `${path}.${key} expected=missing observed=${semanticDifferenceValue(rightRecord[key])}`;
        if (!(key in rightRecord)) return `${path}.${key} expected=${semanticDifferenceValue(leftRecord[key])} observed=missing`;
        const difference = visit(leftRecord[key], rightRecord[key], `${path}.${key}`);
        if (difference) return difference;
      }
    }
    return `${path} expected=${semanticDifferenceValue(left)} observed=${semanticDifferenceValue(right)}`;
  };
  return visit(withoutStructuralIds(expected), withoutStructuralIds(observed), '$') ?? 'none';
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
  } else if (isRecord(nextInfo.description) && typeof nextInfo.description.content === 'string') {
    // Sync import persists the SDK Description object's content as a string.
    // Canonicalize before digesting so generated and exported wire bytes agree.
    nextInfo.description = nextInfo.description.content;
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
  const generated = await withDeterministicSchemaFaker(bundledOpenApi, async (candidate) => {
    let converted: JsonRecord;
    try {
      converted = await convertOnce(bundledOpenApi, options, converter);
    } catch (error) {
      if (error instanceof LocalOpenApiConversionError) throw error;
      throw new LocalOpenApiConversionError('convert', 'converter failed', error);
    }

    try {
      const repairWarnings = repairGeneratedCollectionExamples(
        converted,
        options.contractIndex,
        bundledOpenApi,
        candidate,
        options.exampleRepair ?? 'lenient'
      );
      return { converted, repairWarnings };
    } catch (error) {
      throw new LocalOpenApiConversionError(
        'repair-request-examples',
        'failed to make generated request examples conform to their OpenAPI schemas',
        error
      );
    }
  });

  const converted = generated.converted;
  const warnings: string[] = [...generated.repairWarnings];
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
    smoke = instrumentSmokeCollection(smoke, options.secretsResolverProvider ?? 'none');
  } catch (error) {
    throw new LocalOpenApiConversionError('instrument-smoke', 'failed to embed smoke helpers', error);
  }

  try {
    // Local whole-import has no documented Postman whole-payload byte ceiling.
    // Pass the explicit no-limit sentinel so instrumentation does not fall back
    // to the unrelated default 4 MiB collection-update guard.
    const instrumented = instrumentContractCollection(contract, options.contractIndex, {
      maxCollectionUpdateBytes: false,
      secretsResolverProvider: options.secretsResolverProvider ?? 'none'
    });
    contract = instrumented.collection;
    warnings.push(...instrumented.warnings);
  } catch (error) {
    throw new LocalOpenApiConversionError('instrument-contract', 'failed to instrument contract collection', error);
  }

  // Deliberately after contract instrumentation and before canonicalization.
  // After, because `instrumentContractCollection` runs a forbidden-construct
  // scan that throws on `eval(` — correct for our generated contract runtime,
  // wrong for a customer signer that evals a pinned crypto library. Before,
  // because the digest is computed over the canonicalized payload, so injecting
  // here is what makes the script and its variables survive regeneration
  // instead of needing a post-create PATCH.
  if (options.collectionRootContent) {
    try {
      baseline = applyCollectionRootContent(baseline, 'baseline', options.collectionRootContent);
      smoke = applyCollectionRootContent(smoke, 'smoke', options.collectionRootContent);
      contract = applyCollectionRootContent(contract, 'contract', options.collectionRootContent);
    } catch (error) {
      throw new LocalOpenApiConversionError(
        'apply-collection-root-content',
        'failed to apply collection-root scripts or variables',
        error
      );
    }
  }

  // Sync persists the Collection v3 model, not every legacy converter v2 field.
  // Canonicalize fully instrumented roles through that model before assigning
  // final structural identities and computing semantic digests.
  try {
    baseline = rekeyStructuralCollectionIds(canonicalizeV2CollectionForSync(baseline));
    smoke = rekeyStructuralCollectionIds(canonicalizeV2CollectionForSync(smoke));
    contract = rekeyStructuralCollectionIds(canonicalizeV2CollectionForSync(contract));
  } catch (error) {
    throw new LocalOpenApiConversionError('materialize-roles', 'failed to canonicalize role collections for Sync', error);
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

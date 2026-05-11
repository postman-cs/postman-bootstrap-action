import { realpathSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import $RefParser from '@apidevtools/json-schema-ref-parser';
import { compileErrors, validate as validateOpenApi } from '@readme/openapi-parser';
import { parse } from 'yaml';

import { retry } from '../retry.js';
import { buildContractIndex, type ContractIndex } from './contract-index.js';
import {
  SAFE_FETCH_LIMITS,
  classifySafeFetchRetryability,
  safeFetchText,
  type SafeFetchBudget,
  type SafeFetchOptions
} from './safe-spec-fetch.js';
import type { OpenApiVersion } from './schema-pack.js';

type JsonRecord = Record<string, unknown>;

export interface LoadedOpenApiContractSpec {
  bundledContent: string;
  bundledDocument: JsonRecord;
  contractIndex: ContractIndex;
  content: string;
  version: OpenApiVersion;
}

export interface OpenApiLoaderOptions extends SafeFetchOptions {
  fetchText?: (url: string, options: SafeFetchOptions) => Promise<string>;
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

export function parseOpenApiDocument(content: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    try {
      parsed = parse(content) as unknown;
    } catch {
      throw new Error('CONTRACT_SPEC_PARSE_FAILED: Spec content is not valid JSON or YAML');
    }
  }
  const doc = asRecord(parsed);
  if (!doc) throw new Error('CONTRACT_SPEC_PARSE_FAILED: Spec content must be a JSON or YAML object');
  return doc;
}

function parseAnyDocument(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return parse(content) as unknown;
  }
}

function parseReferencedDocument(content: string, url: string): unknown {
  try {
    return parseAnyDocument(content);
  } catch {
    throw new Error(`CONTRACT_SPEC_PARSE_FAILED: Referenced OpenAPI document ${url} is not valid JSON or YAML`);
  }
}

function resourceUrl(input: string, baseUrl?: string): string {
  const url = baseUrl ? new URL(input, baseUrl) : new URL(input);
  url.hash = '';
  return url.toString();
}

function collectExternalRefs(node: unknown, baseUrl: string, refs: Set<string>): void {
  if (Array.isArray(node)) {
    node.forEach((entry) => collectExternalRefs(entry, baseUrl, refs));
    return;
  }
  const record = asRecord(node);
  if (!record) return;
  const ref = typeof record.$ref === 'string' ? record.$ref : '';
  if (ref && !ref.startsWith('#')) {
    refs.add(resourceUrl(ref, baseUrl));
  }
  for (const value of Object.values(record)) {
    collectExternalRefs(value, baseUrl, refs);
  }
}

async function prefetchExternalRefs(
  content: string,
  baseUrl: string,
  fetchText: (url: string, options: SafeFetchOptions) => Promise<string>,
  options: OpenApiLoaderOptions,
  budget: SafeFetchBudget,
  visited: Set<string>,
  depth: number,
  httpsOnly = false
): Promise<void> {
  const maxDepth = options.maxDepth ?? SAFE_FETCH_LIMITS.maxDepth;
  if (depth > maxDepth) {
    throw new Error(`CONTRACT_REF_DEPTH_EXCEEDED: OpenAPI ref depth exceeded ${maxDepth}`);
  }
  const refs = new Set<string>();
  collectExternalRefs(parseReferencedDocument(content, baseUrl), baseUrl, refs);
  for (const refUrl of refs) {
    if (httpsOnly && !refUrl.startsWith('https://')) continue;
    if (visited.has(refUrl)) continue;
    if (depth + 1 > maxDepth) {
      throw new Error(`CONTRACT_REF_DEPTH_EXCEEDED: OpenAPI ref depth exceeded ${maxDepth}`);
    }
    visited.add(refUrl);
    const refContent = await fetchText(refUrl, { ...options, budget, depth: depth + 1 });
    await prefetchExternalRefs(refContent, refUrl, fetchText, options, budget, visited, depth + 1, httpsOnly);
  }
}

export function detectOpenApiVersion(doc: JsonRecord): OpenApiVersion {
  if (doc.swagger === '2.0') {
    throw new Error('CONTRACT_UNSUPPORTED_OPENAPI_VERSION: Dynamic contract tests require OpenAPI 3.0 or 3.1 (found swagger 2.0)');
  }
  if (!('openapi' in doc)) {
    throw new Error('CONTRACT_UNSUPPORTED_OPENAPI_VERSION: Dynamic contract tests require OpenAPI 3.0 or 3.1 (missing openapi)');
  }
  const raw = doc.openapi;
  if (typeof raw !== 'string') {
    throw new Error(`CONTRACT_UNSUPPORTED_OPENAPI_VERSION: Dynamic contract tests require OpenAPI 3.0 or 3.1 (found openapi ${String(raw)})`);
  }
  const match = raw.trim().match(/^3\.(0|1)(?:\.\d+)?$/);
  if (!match?.[1]) {
    throw new Error(`CONTRACT_UNSUPPORTED_OPENAPI_VERSION: Dynamic contract tests require OpenAPI 3.0 or 3.1 (found openapi ${raw})`);
  }
  return match[1] === '1' ? '3.1' : '3.0';
}

export function normalizeSpecTypeFromContent(content: string): `OPENAPI:${OpenApiVersion}` {
  return `OPENAPI:${detectOpenApiVersion(parseOpenApiDocument(content))}`;
}

export function serializeOpenApiDocument(document: JsonRecord): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

async function bundleSpec(baseUrl: string, document: JsonRecord, options: OpenApiLoaderOptions): Promise<JsonRecord> {
  const budget: SafeFetchBudget = options.budget ?? { refs: 0, totalBytes: Buffer.byteLength(JSON.stringify(document), 'utf8') };
  const fetchText = options.fetchText ?? safeFetchText;
  const parser = new $RefParser<JsonRecord>();
  const bundled = await parser.bundle(baseUrl, document, {
    resolve: {
      external: true,
      file: false,
      http: false,
      https: {
        order: 1,
        canRead: (file: { url: string }) => file.url.startsWith('https://'),
        read: async (file: { url: string }) => fetchText(file.url, { ...options, budget, depth: (options.depth ?? 0) + 1 })
      }
    },
    dereference: {
      circular: 'ignore'
    },
    timeoutMs: 30000
  });
  return bundled;
}

function createCachedFetchText(
  options: OpenApiLoaderOptions
): (url: string, fetchOptions: SafeFetchOptions) => Promise<string> {
  const baseFetchText = options.fetchText ?? safeFetchText;
  const cache = new Map<string, string>();
  return async (url, fetchOptions) => {
    const key = resourceUrl(url);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const text = await retry(() => baseFetchText(key, fetchOptions), {
      maxAttempts: 3,
      delayMs: 3000,
      shouldRetry: (error) => classifySafeFetchRetryability(error) === 'retryable'
    });
    cache.set(key, text);
    return text;
  };
}

async function buildLoadedSpec(
  content: string,
  baseRef: string,
  options: OpenApiLoaderOptions,
  fetchText: (url: string, fetchOptions: SafeFetchOptions) => Promise<string>,
  budget: SafeFetchBudget
): Promise<LoadedOpenApiContractSpec> {
  const document = parseOpenApiDocument(content);
  const version = detectOpenApiVersion(document);
  const bundledDocument = await bundleSpec(baseRef, document, { ...options, budget, fetchText });
  const validation = await validateOpenApi(bundledDocument as never, {
    resolve: { external: false, file: false },
    dereference: { circular: 'ignore' },
    validate: { errors: { colorize: false } }
  });
  if (!validation.valid) {
    throw new Error(`CONTRACT_SPEC_VALIDATION_FAILED: ${compileErrors(validation)}`);
  }
  return {
    bundledContent: serializeOpenApiDocument(bundledDocument),
    bundledDocument,
    contractIndex: buildContractIndex(bundledDocument),
    content,
    version
  };
}

export async function loadOpenApiContractSpec(
  specUrl: string,
  options: OpenApiLoaderOptions = {}
): Promise<LoadedOpenApiContractSpec> {
  const budget = options.budget ?? { refs: 0, totalBytes: 0 };
  const fetchText = createCachedFetchText(options);
  const content = await fetchText(specUrl, { ...options, budget, depth: 0 });
  await prefetchExternalRefs(content, resourceUrl(specUrl), fetchText, options, budget, new Set([resourceUrl(specUrl)]), 0);
  return buildLoadedSpec(content, specUrl, options, fetchText, budget);
}

// spec-path is just "spec-url, but the bytes are already on disk in the
// checked-out workspace". The on-the-wire safety machinery (DNS pinning,
// SSRF guards, redirect caps) is unnecessary for a trusted local file; we
// only need to (a) keep the read inside the workspace and (b) cap its
// size. Any HTTPS $refs inside the spec still flow through the URL
// hardening via prefetchExternalRefs + bundleSpec.
export async function loadOpenApiContractSpecFromPath(
  specPath: string,
  options: OpenApiLoaderOptions = {}
): Promise<LoadedOpenApiContractSpec> {
  if (!specPath) throw new Error('CONTRACT_SPEC_READ_FAILED: spec-path must not be empty');

  const workspaceRoot = (() => {
    const root = path.resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
    try { return realpathSync(root); } catch { return root; }
  })();
  const resolved = path.resolve(workspaceRoot, specPath);
  let absolutePath: string;
  try {
    absolutePath = realpathSync(resolved);
  } catch (error) {
    throw new Error(`CONTRACT_SPEC_READ_FAILED: Unable to read spec at ${specPath}`, { cause: error });
  }
  const rel = path.relative(workspaceRoot, absolutePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`CONTRACT_SPEC_READ_FAILED: spec-path must resolve inside ${workspaceRoot}, got: ${specPath}`);
  }

  // Gate on stat() before readFile so a 1GB checked-in file can't OOM us
  // between the read and the limit check.
  const maxBytes = options.maxBytesPerResource ?? SAFE_FETCH_LIMITS.maxBytesPerResource;
  const maxTotalBytes = options.maxTotalBytes ?? SAFE_FETCH_LIMITS.maxTotalBytes;
  const onDiskBytes = (await stat(absolutePath)).size;
  if (onDiskBytes > maxBytes) {
    throw new Error(`CONTRACT_REF_SIZE_EXCEEDED: OpenAPI resource exceeded ${maxBytes} bytes`);
  }
  const budget: SafeFetchBudget = options.budget ?? { refs: 0, totalBytes: 0 };
  if (budget.totalBytes + onDiskBytes > maxTotalBytes) {
    throw new Error(`CONTRACT_REF_SIZE_EXCEEDED: OpenAPI resources exceeded ${maxTotalBytes} total bytes`);
  }

  const content = await readFile(absolutePath, 'utf8');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > maxBytes) {
    throw new Error(`CONTRACT_REF_SIZE_EXCEEDED: OpenAPI resource exceeded ${maxBytes} bytes`);
  }
  budget.refs += 1;
  budget.totalBytes += bytes;

  const fetchText = createCachedFetchText(options);
  const baseRef = pathToFileURL(absolutePath).toString();
  await prefetchExternalRefs(content, baseRef, fetchText, options, budget, new Set([baseRef]), 0, true);
  return buildLoadedSpec(content, baseRef, options, fetchText, budget);
}

import { randomUUID } from 'node:crypto';

import type { DefinitionBundle } from '../spec/definition-bundle.js';
import { retry } from '../retry.js';

export type CollectionGenerationRoleName = 'baseline' | 'smoke' | 'contract';

export interface CollectionGenerationRole {
  role: CollectionGenerationRoleName;
  prefix: string;
}

export type CollectionGenerationFanoutSource =
  | { kind: 'single'; content: string }
  | { kind: 'bundle'; bundle: DefinitionBundle };

export interface CollectionGenerationFanoutPostman {
  generateCollection(
    specId: string,
    projectName: string,
    prefix: string,
    folderStrategy: string,
    nestedFolderHierarchy: boolean,
    requestNameSource: string
  ): Promise<string>;
  uploadSpecWithOutcome?(
    workspaceId: string,
    projectName: string,
    specContent: string,
    openapiVersion?: string
  ): Promise<{ specId: string; created: boolean }>;
  uploadSpecBundle?(
    workspaceId: string,
    projectName: string,
    bundle: DefinitionBundle,
    openapiVersion?: string
  ): Promise<{
    specId: string;
    created: boolean;
    outcome: { status: string; reason?: string };
  }>;
  deleteSpec?(specId: string): Promise<void>;
  deleteCollection?(collectionId: string): Promise<void>;
}

export interface CollectionGenerationFanoutIntegration {
  linkCollectionsToSpecification(
    specId: string,
    collections: Array<{ collectionId: string }>
  ): Promise<void>;
}

export interface GenerateCollectionsWithSpecFanoutOptions {
  assetName: string;
  canonicalSpecId: string;
  workspaceId: string;
  openapiVersion: '3.0' | '3.1';
  source: CollectionGenerationFanoutSource;
  roles: CollectionGenerationRole[];
  reservedCollectionIds?: Partial<Record<CollectionGenerationRoleName, string>>;
  folderStrategy: string;
  nestedFolderHierarchy: boolean;
  requestNameSource: string;
  postman: CollectionGenerationFanoutPostman;
  integration?: CollectionGenerationFanoutIntegration;
  env?: Record<string, string | undefined>;
  identity?: () => string;
  now?: () => number;
  info?: (message: string) => void;
  cleanupDelayMs?: number;
}

export interface CollectionGenerationFanoutResult {
  collections: Partial<Record<CollectionGenerationRoleName, string>>;
  diagnostic: {
    strategy: 'fanout' | 'serial';
    freshRoles: number;
    temporarySpecs: number;
    durationMs: number;
  };
}

interface TemporarySpec {
  role: CollectionGenerationRoleName;
  specId: string;
  owned: true;
}

interface GeneratedCollection {
  role: CollectionGenerationRoleName;
  collectionId: string;
  temporarySpec?: TemporarySpec;
}

const MAX_SPEC_NAME_LENGTH = 255;
const RUN_TOKEN_MAX_LENGTH = 64;

function sanitizeRunToken(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, RUN_TOKEN_MAX_LENGTH);
  return sanitized || randomUUID();
}

export function buildTemporarySpecName(
  assetName: string,
  canonicalSpecId: string,
  role: CollectionGenerationRoleName,
  runToken: string
): string {
  const suffix = ` [bootstrap-fanout:${canonicalSpecId}:${role}:${sanitizeRunToken(runToken)}]`;
  if (suffix.length >= MAX_SPEC_NAME_LENGTH) {
    throw new Error(
      'CONTRACT_COLLECTION_FANOUT_NAME_INVALID: temporary spec ownership suffix exceeds 255 characters'
    );
  }
  const prefix = assetName.trim() || 'OpenAPI';
  return `${prefix.slice(0, MAX_SPEC_NAME_LENGTH - suffix.length)}${suffix}`;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 404;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertDistinctCollectionIds(
  generated: GeneratedCollection[],
  reserved: Partial<Record<CollectionGenerationRoleName, string>>
): void {
  const seen = new Map<string, CollectionGenerationRoleName>();
  for (const [role, collectionId] of Object.entries(reserved) as Array<[
    CollectionGenerationRoleName,
    string | undefined
  ]>) {
    if (collectionId) seen.set(collectionId, role);
  }
  for (const entry of generated) {
    const previous = seen.get(entry.collectionId);
    if (previous) {
      throw new Error(
        `CONTRACT_COLLECTION_ID_COLLISION: ${previous} and ${entry.role} collection IDs both resolve to ${entry.collectionId}`
      );
    }
    seen.set(entry.collectionId, entry.role);
  }
}

function cleanupError(resourceIds: string[], error: unknown, cause?: unknown): Error {
  const details = [...new Set(resourceIds)].join(', ') || '<unknown>';
  return new Error(
    `CONTRACT_COLLECTION_FANOUT_CLEANUP_FAILED: failed to delete temporary fan-out resources ${details}: ${errorMessage(error)}`,
    { cause: cause ?? error }
  );
}

async function deleteTemporarySpecs(
  specs: TemporarySpec[],
  postman: CollectionGenerationFanoutPostman,
  cleanupDelayMs: number
): Promise<void> {
  if (!postman.deleteSpec || specs.length === 0) return;
  const unique = [...new Map(specs.map((spec) => [spec.specId, spec])).values()];
  const settled = await Promise.allSettled(
    unique.map((spec) =>
      retry(
        async () => {
          try {
            await postman.deleteSpec!(spec.specId);
          } catch (error) {
            if (isNotFound(error)) return;
            throw error;
          }
        },
        { maxAttempts: 3, delayMs: cleanupDelayMs }
      )
    )
  );
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw cleanupError(unique.map((spec) => spec.specId), failed.reason);
}

async function compensateBeforeLink(
  original: unknown,
  generated: GeneratedCollection[],
  specs: TemporarySpec[],
  postman: CollectionGenerationFanoutPostman,
  cleanupDelayMs: number
): Promise<never> {
  const temporaryCollectionIds = [
    ...new Set(
      generated.filter((entry) => entry.temporarySpec).map((entry) => entry.collectionId)
    )
  ];
  try {
    if (postman.deleteCollection) {
      const collectionCleanup = await Promise.allSettled(
        temporaryCollectionIds.map((collectionId) =>
          retry(
            async () => {
              try {
                await postman.deleteCollection!(collectionId);
              } catch (error) {
                if (isNotFound(error)) return;
                throw error;
              }
            },
            { maxAttempts: 3, delayMs: cleanupDelayMs }
          )
        )
      );
      const failed = collectionCleanup.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      );
      if (failed) throw cleanupError(temporaryCollectionIds, failed.reason, original);
    }
    await deleteTemporarySpecs(specs, postman, cleanupDelayMs);
  } catch (error) {
    throw cleanupError(
      [...temporaryCollectionIds, ...specs.map((spec) => spec.specId)],
      error,
      original
    );
  }
  throw original;
}

function canFanOut(options: GenerateCollectionsWithSpecFanoutOptions): boolean {
  if (
    String((options.env ?? process.env).POSTMAN_COLLECTION_GENERATION_FANOUT ?? '')
      .trim()
      .toLowerCase() === 'off'
  ) return false;
  if (options.roles.length < 2) return false;
  if (!options.integration || !options.postman.deleteSpec || !options.postman.deleteCollection) return false;
  return options.source.kind === 'single'
    ? Boolean(options.postman.uploadSpecWithOutcome)
    : Boolean(options.postman.uploadSpecBundle);
}

async function generateRole(
  options: GenerateCollectionsWithSpecFanoutOptions,
  role: CollectionGenerationRole,
  specId: string
): Promise<string> {
  return options.postman.generateCollection(
    specId,
    options.assetName,
    role.prefix,
    options.folderStrategy,
    options.nestedFolderHierarchy,
    options.requestNameSource
  );
}

async function createTemporarySpec(
  options: GenerateCollectionsWithSpecFanoutOptions,
  role: CollectionGenerationRole,
  runToken: string,
  register: (spec: TemporarySpec) => void
): Promise<TemporarySpec> {
  const name = buildTemporarySpecName(
    options.assetName,
    options.canonicalSpecId,
    role.role,
    runToken
  );
  // A created:false outcome is exact-name reconciliation after an ambiguous
  // create. The random run token in this name keeps that adopted spec run-owned.
  if (options.source.kind === 'single') {
    const uploaded = await options.postman.uploadSpecWithOutcome!(
      options.workspaceId,
      name,
      options.source.content,
      options.openapiVersion
    );
    if (!uploaded.specId) throw new Error(`Temporary ${role.role} spec upload did not return an ID`);
    const spec = { role: role.role, specId: uploaded.specId, owned: true as const };
    register(spec);
    return spec;
  }
  const uploaded = await options.postman.uploadSpecBundle!(
    options.workspaceId,
    name,
    options.source.bundle,
    options.openapiVersion
  );
  if (!uploaded.specId) {
    throw new Error(`Temporary ${role.role} spec bundle upload did not return an ID`);
  }
  const spec = { role: role.role, specId: uploaded.specId, owned: true as const };
  register(spec);
  if (uploaded.outcome.status !== 'ok') {
    throw new Error(
      `Temporary ${role.role} spec bundle upload failed verification${uploaded.outcome.reason ? `: ${uploaded.outcome.reason}` : ''}`
    );
  }
  return spec;
}

export async function generateCollectionsWithSpecFanout(
  options: GenerateCollectionsWithSpecFanoutOptions
): Promise<CollectionGenerationFanoutResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const fanout = canFanOut(options);
  const diagnostic = (): CollectionGenerationFanoutResult['diagnostic'] => ({
    strategy: fanout ? 'fanout' : 'serial',
    freshRoles: options.roles.length,
    temporarySpecs: fanout ? Math.max(0, options.roles.length - 1) : 0,
    durationMs: Math.max(0, now() - startedAt)
  });

  if (!fanout) {
    options.info?.(`collection generation strategy=serial freshRoles=${options.roles.length}`);
    const collections: Partial<Record<CollectionGenerationRoleName, string>> = {};
    for (const role of options.roles) {
      collections[role.role] = await generateRole(options, role, options.canonicalSpecId);
    }
    return { collections, diagnostic: diagnostic() };
  }

  const runToken = `${randomUUID()}-${sanitizeRunToken((options.identity ?? randomUUID)())}`;
  const temporarySpecs: TemporarySpec[] = [];
  options.info?.(
    `collection generation strategy=fanout freshRoles=${options.roles.length} temporarySpecs=${options.roles.length - 1}`
  );

  // Start canonical generation immediately. Each additional role uploads its
  // independent spec and chains generation without blocking the other roles.
  const jobs = options.roles.map(async (role, index): Promise<GeneratedCollection> => {
    if (index === 0) {
      return {
        role: role.role,
        collectionId: await generateRole(options, role, options.canonicalSpecId)
      };
    }
    const temporarySpec = await createTemporarySpec(
      options,
      role,
      runToken,
      (spec) => temporarySpecs.push(spec)
    );
    return {
      role: role.role,
      collectionId: await generateRole(options, role, temporarySpec.specId),
      temporarySpec
    };
  });
  const settled = await Promise.allSettled(jobs);
  const generated = settled.flatMap((entry) =>
    entry.status === 'fulfilled' ? [entry.value] : []
  );
  const failed = settled.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
  if (failed) {
    return compensateBeforeLink(
      failed.reason,
      generated,
      temporarySpecs,
      options.postman,
      options.cleanupDelayMs ?? 1000
    );
  }

  try {
    assertDistinctCollectionIds(generated, options.reservedCollectionIds ?? {});
  } catch (error) {
    return compensateBeforeLink(
      error,
      generated,
      temporarySpecs,
      options.postman,
      options.cleanupDelayMs ?? 1000
    );
  }

  const temporaryCollections = generated.filter((entry) => entry.temporarySpec);
  try {
    await options.integration!.linkCollectionsToSpecification(
      options.canonicalSpecId,
      temporaryCollections.map((entry) => ({ collectionId: entry.collectionId }))
    );
  } catch (error) {
    return compensateBeforeLink(
      error,
      generated,
      temporarySpecs,
      options.postman,
      options.cleanupDelayMs ?? 1000
    );
  }

  try {
    await deleteTemporarySpecs(temporarySpecs, options.postman, options.cleanupDelayMs ?? 1000);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('CONTRACT_COLLECTION_FANOUT_CLEANUP_FAILED:')
    ) throw error;
    throw cleanupError(temporarySpecs.map((spec) => spec.specId), error);
  }

  const collections = Object.fromEntries(
    generated.map((entry) => [entry.role, entry.collectionId])
  ) as Partial<Record<CollectionGenerationRoleName, string>>;
  return { collections, diagnostic: diagnostic() };
}

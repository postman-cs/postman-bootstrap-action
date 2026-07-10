import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';

import { parse, stringify } from 'yaml';

import {
  assertSupportedLocalViewContract,
  normalizeLocalViewScriptType
} from './local-view-contract.js';

type JsonRecord = Record<string, unknown>;

export type CloudResourceMap = Record<string, string>;

export type PostmanResourcesState = {
  workspace?: {
    id?: string;
  };
  cloudResources?: {
    additionalCollections?: CloudResourceMap;
    collections?: CloudResourceMap;
    environments?: CloudResourceMap;
    specs?: CloudResourceMap;
  };
};

export interface AdditionalCollectionFile {
  collection: JsonRecord;
  existingCollectionId?: string;
  displayPath: string;
  name: string;
  resourcePath: string;
}

export interface AdditionalCollectionSyncResult {
  collectionId: string;
  displayPath: string;
  name: string;
  operation: 'created' | 'updated';
  resourcePath: string;
}

export interface AdditionalCollectionsLogger {
  info(message: string): void;
  warning(message: string): void;
}

export interface AdditionalCollectionsPostmanClient {
  createCollection?: (workspaceId: string, collection: unknown) => Promise<string>;
  updateCollection?: (collectionUid: string, collection: unknown) => Promise<void>;
}

const ADDITIONAL_COLLECTION_EXTENSIONS = new Set(['.json', '.yaml', '.yml']);
const POSTMAN_COLLECTION_V21_SCHEMA_FRAGMENT = '/collection/v2.1.0/collection.json';
const V3_DEFINITION_PATH = path.join('.resources', 'definition.yaml');
const V3_REQUEST_SUFFIX = '.request.yaml';
const RESOURCES_PATH = '.postman/resources.yaml';

function normalizeInputValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function workspaceRootForLocalInputs(): string {
  const root = path.resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

function normalizedDisplayPath(workspaceRoot: string, filePath: string): string {
  const relative = path.relative(workspaceRoot, filePath);
  return (relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative
    : filePath
  ).replace(/\\/g, '/');
}

function toResourcePath(displayPath: string): string {
  return `../${displayPath.replace(/^\/+/, '')}`;
}

function fileNameWithoutSuffix(filePath: string, suffix: string): string {
  const name = path.basename(filePath);
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertInsideWorkspace(
  workspaceRoot: string,
  candidate: string,
  inputName: string
): void {
  const relative = path.relative(workspaceRoot, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `${inputName} must resolve inside ${workspaceRoot}, got: ${candidate}`
    );
  }
}

/** Resolve a definition/request path and reject symlink escapes outside the workspace. */
function resolveInsideWorkspace(
  workspaceRoot: string,
  candidate: string,
  inputName: string
): string {
  const resolved = realpathSync(candidate);
  assertInsideWorkspace(workspaceRoot, resolved, inputName);
  return resolved;
}

export function readResourcesState(): PostmanResourcesState | null {
  try {
    return parse(readFileSync(RESOURCES_PATH, 'utf8')) as PostmanResourcesState;
  } catch {
    return null;
  }
}

export function writeResourcesState(state: PostmanResourcesState): void {
  mkdirSync(path.dirname(RESOURCES_PATH), { recursive: true });
  writeFileSync(RESOURCES_PATH, stringify(state), 'utf8');
}

export function getFirstCloudResourceId(map: CloudResourceMap | undefined): string | undefined {
  if (!map) {
    return undefined;
  }
  return Object.values(map)[0];
}

export function findCloudResourceId(
  map: CloudResourceMap | undefined,
  matcher: (filePath: string) => boolean
): string | undefined {
  if (!map) {
    return undefined;
  }

  const match = Object.entries(map).find(([filePath]) => matcher(filePath));
  return match?.[1];
}

function findExistingAdditionalCollectionId(
  resourcesState: PostmanResourcesState | null,
  resourcePath: string
): string | undefined {
  return (
    resourcesState?.cloudResources?.additionalCollections?.[resourcePath] ??
    resourcesState?.cloudResources?.collections?.[resourcePath]
  );
}

function resolveAdditionalCollectionsDir(directoryInput: string): {
  directoryPath: string;
  workspaceRoot: string;
} {
  const workspaceRoot = workspaceRootForLocalInputs();
  const resolved = path.isAbsolute(directoryInput)
    ? path.resolve(directoryInput)
    : path.resolve(workspaceRoot, directoryInput);
  let directoryPath: string;
  try {
    directoryPath = realpathSync(resolved);
  } catch (error) {
    throw new Error(
      `ADDITIONAL_COLLECTIONS_DIR_NOT_FOUND: additional-collections-dir does not exist or cannot be read: ${directoryInput}`,
      { cause: error }
    );
  }
  assertInsideWorkspace(workspaceRoot, directoryPath, 'additional-collections-dir');
  if (!statSync(directoryPath).isDirectory()) {
    throw new Error(
      `ADDITIONAL_COLLECTIONS_DIR_NOT_DIRECTORY: additional-collections-dir must be a directory: ${directoryInput}`
    );
  }
  return { directoryPath, workspaceRoot };
}

function parseAdditionalCollectionDocument(
  content: string,
  extension: string,
  displayPath: string
): unknown {
  try {
    if (extension === '.json') {
      return JSON.parse(content) as unknown;
    }
    return parse(content) as unknown;
  } catch (error) {
    const format = extension === '.json' ? 'JSON' : 'YAML';
    throw new Error(
      `ADDITIONAL_COLLECTION_PARSE_FAILED: ${displayPath} is not valid ${format}`,
      { cause: error }
    );
  }
}

function parseYamlDocument(filePath: string, displayPath: string): unknown {
  try {
    return parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `ADDITIONAL_COLLECTION_PARSE_FAILED: ${displayPath} is not valid YAML`,
      { cause: error }
    );
  }
}

function keyValueMapToArray(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return value;
  return Object.entries(record).map(([key, entry]) => {
    const entryRecord = asRecord(entry);
    if (entryRecord) {
      return { key, ...entryRecord };
    }
    return { key, value: entry };
  });
}

function normalizeScripts(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    const script = asRecord(entry);
    if (!script) return entry;
    return {
      ...script,
      type: normalizeLocalViewScriptType(script.type)
    };
  });
}

function normalizeAuth(value: unknown): unknown {
  if (Array.isArray(value) && value.length > 1) {
    throw new Error(
      'ADDITIONAL_COLLECTION_UNSUPPORTED: Local View collections support one auth profile per node'
    );
  }
  const record = Array.isArray(value) ? asRecord(value[0]) : asRecord(value);
  if (!record) return value;
  return {
    ...record,
    credentials: keyValueMapToArray(record.credentials)
  };
}

function normalizeV3LocalNode(node: JsonRecord, fallbackName: string, fallbackKind: string): JsonRecord {
  const normalized = structuredCloneSafe(node);
  normalized.$kind = typeof normalized.$kind === 'string' ? normalized.$kind : fallbackKind;
  if (typeof normalized.name !== 'string' || !normalized.name.trim()) {
    normalized.name = fallbackName;
  }
  if (normalized.auth !== undefined) normalized.auth = normalizeAuth(normalized.auth);
  if (normalized.headers !== undefined) normalized.headers = keyValueMapToArray(normalized.headers);
  if (normalized.pathVariables !== undefined) {
    normalized.pathVariables = keyValueMapToArray(normalized.pathVariables);
  }
  if (normalized.queryParams !== undefined) normalized.queryParams = keyValueMapToArray(normalized.queryParams);
  if (normalized.variables !== undefined) normalized.variables = keyValueMapToArray(normalized.variables);
  if (normalized.scripts !== undefined) normalized.scripts = normalizeScripts(normalized.scripts);
  return normalized;
}

function validateCollectionItems(
  items: unknown[],
  displayPath: string,
  pointer: string
): void {
  items.forEach((entry, index) => {
    const item = asRecord(entry);
    const itemPointer = `${pointer}[${index}]`;
    if (!item) {
      throw new Error(
        `ADDITIONAL_COLLECTION_INVALID: ${displayPath} ${itemPointer} must be an object`
      );
    }
    const nestedItems = item.item;
    const hasNestedItems = Array.isArray(nestedItems);
    const hasRequest =
      asRecord(item.request) !== null ||
      (typeof item.request === 'string' && item.request.trim().length > 0);
    if (!hasNestedItems && !hasRequest) {
      throw new Error(
        `ADDITIONAL_COLLECTION_INVALID: ${displayPath} ${itemPointer} must include a request object or nested item array`
      );
    }
    if (hasNestedItems) {
      validateCollectionItems(nestedItems, displayPath, `${itemPointer}.item`);
    }
  });
}

function extractPostmanCollectionPayload(document: unknown, displayPath: string): JsonRecord {
  const root = asRecord(document);
  if (!root) {
    throw new Error(
      `ADDITIONAL_COLLECTION_INVALID: ${displayPath} must contain a Postman collection object`
    );
  }
  const collection = asRecord(root.collection) ?? root;
  const info = asRecord(collection.info);
  if (!info) {
    throw new Error(
      `ADDITIONAL_COLLECTION_INVALID: ${displayPath} is missing collection.info`
    );
  }
  const name = typeof info.name === 'string' ? info.name.trim() : '';
  if (!name) {
    throw new Error(
      `ADDITIONAL_COLLECTION_INVALID: ${displayPath} collection.info.name must be a non-empty string`
    );
  }
  const schema = typeof info.schema === 'string' ? info.schema.trim() : '';
  if (!schema.includes(POSTMAN_COLLECTION_V21_SCHEMA_FRAGMENT)) {
    throw new Error(
      `ADDITIONAL_COLLECTION_UNSUPPORTED_SCHEMA: ${displayPath} supports only Postman collection schema v2.1.0; no v3 converter is available`
    );
  }
  if (!Array.isArray(collection.item)) {
    throw new Error(
      `ADDITIONAL_COLLECTION_INVALID: ${displayPath} collection.item must be an array`
    );
  }
  validateCollectionItems(collection.item, displayPath, 'collection.item');
  return collection;
}

function collectSupportedCollectionPaths(
  directoryPath: string,
  workspaceRoot: string,
  files: string[],
  skippedDirectories = new Set<string>(),
  visitedDirectories = new Set<string>()
): void {
  const realDirectoryPath = realpathSync(directoryPath);
  assertInsideWorkspace(workspaceRoot, realDirectoryPath, 'additional-collections-dir');
  if (skippedDirectories.has(realDirectoryPath)) {
    return;
  }
  if (visitedDirectories.has(realDirectoryPath)) {
    return;
  }
  visitedDirectories.add(realDirectoryPath);

  const entries = readdirSync(realDirectoryPath, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const entryPath = path.join(realDirectoryPath, entry.name);
    const realEntryPath = realpathSync(entryPath);
    assertInsideWorkspace(workspaceRoot, realEntryPath, 'additional-collections-dir');
    const stats = statSync(realEntryPath);
    if (stats.isDirectory()) {
      collectSupportedCollectionPaths(
        realEntryPath,
        workspaceRoot,
        files,
        skippedDirectories,
        visitedDirectories
      );
      continue;
    }
    if (!stats.isFile()) {
      continue;
    }
    const extension = path.extname(entry.name).toLowerCase();
    if (!ADDITIONAL_COLLECTION_EXTENSIONS.has(extension)) {
      continue;
    }
    files.push(realEntryPath);
  }
}

function hasV3CollectionDefinition(directoryPath: string): boolean {
  return existsSync(path.join(directoryPath, V3_DEFINITION_PATH));
}

function collectV3CollectionDirectories(
  directoryPath: string,
  workspaceRoot: string,
  directories: string[],
  visitedDirectories = new Set<string>()
): void {
  const realDirectoryPath = realpathSync(directoryPath);
  assertInsideWorkspace(workspaceRoot, realDirectoryPath, 'additional-collections-dir');
  if (visitedDirectories.has(realDirectoryPath)) {
    return;
  }
  visitedDirectories.add(realDirectoryPath);

  if (hasV3CollectionDefinition(realDirectoryPath)) {
    directories.push(realDirectoryPath);
    return;
  }

  const entries = readdirSync(realDirectoryPath, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const entryPath = path.join(realDirectoryPath, entry.name);
    const realEntryPath = realpathSync(entryPath);
    assertInsideWorkspace(workspaceRoot, realEntryPath, 'additional-collections-dir');
    collectV3CollectionDirectories(realEntryPath, workspaceRoot, directories, visitedDirectories);
  }
}

function sortV3Items(items: JsonRecord[]): JsonRecord[] {
  return items.sort((a, b) => {
    const left = typeof a.order === 'number' && Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
    const right = typeof b.order === 'number' && Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
    if (left !== right) return left - right;
    return String(a.name ?? '').localeCompare(String(b.name ?? ''));
  });
}

function loadV3DirectoryItems(directoryPath: string, workspaceRoot: string): JsonRecord[] {
  const entries = readdirSync(directoryPath, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  const items: JsonRecord[] = [];

  for (const entry of entries) {
    if (entry.name === '.resources') {
      continue;
    }
    const entryPath = path.join(directoryPath, entry.name);
    const realEntryPath = realpathSync(entryPath);
    assertInsideWorkspace(workspaceRoot, realEntryPath, 'additional-collections-dir');
    if (entry.isSymbolicLink()) {
      throw new Error(
        `ADDITIONAL_COLLECTION_UNSUPPORTED: symlinked Local View entry ${normalizedDisplayPath(workspaceRoot, entryPath)} is not supported`
      );
    }
    const entryStats = statSync(realEntryPath);

    if (entryStats.isDirectory()) {
      const definitionPath = path.join(realEntryPath, V3_DEFINITION_PATH);
      const displayPath = normalizedDisplayPath(workspaceRoot, definitionPath);
      if (!existsSync(definitionPath)) {
        throw new Error(
          `ADDITIONAL_COLLECTION_INVALID: ${displayPath} is required for Local View folder ${path.basename(realEntryPath)}`
        );
      }
      const realDefinitionPath = resolveInsideWorkspace(
        workspaceRoot,
        definitionPath,
        'additional-collections-dir'
      );
      const definition = asRecord(parseYamlDocument(realDefinitionPath, displayPath));
      if (!definition) {
        throw new Error(
          `ADDITIONAL_COLLECTION_INVALID: ${displayPath} must contain a collection v3 folder object`
        );
      }
      if (definition.items !== undefined) {
        throw new Error(
          `ADDITIONAL_COLLECTION_UNSUPPORTED: ${displayPath} inline items are not supported; folder items come from the directory tree`
        );
      }
      if (definition.$kind !== 'collection' && definition.$kind !== 'folder') {
        throw new Error(
          `ADDITIONAL_COLLECTION_INVALID: ${displayPath} folder $kind must be collection or folder`
        );
      }
      const folder = normalizeV3LocalNode(definition, path.basename(realEntryPath), 'collection');
      // Native Local View folder metadata may use $kind: folder; writer recurses on collection.
      if (folder.$kind === 'folder') {
        folder.$kind = 'collection';
      }
      folder.items = loadV3DirectoryItems(realEntryPath, workspaceRoot);
      items.push(folder);
      continue;
    }

    if (!entryStats.isFile() || !entry.name.endsWith(V3_REQUEST_SUFFIX)) {
      throw new Error(
        `ADDITIONAL_COLLECTION_INVALID: unsupported Local View entry ${normalizedDisplayPath(workspaceRoot, entryPath)}`
      );
    }

    const displayPath = normalizedDisplayPath(workspaceRoot, realEntryPath);
    const request = asRecord(parseYamlDocument(realEntryPath, displayPath));
    if (!request) {
      throw new Error(
        `ADDITIONAL_COLLECTION_INVALID: ${displayPath} must contain a collection v3 request object`
      );
    }
    const kind = typeof request.$kind === 'string' ? request.$kind : '';
    if (kind !== 'http-request' && kind !== 'graphql-request') {
      throw new Error(
        `ADDITIONAL_COLLECTION_INVALID: ${displayPath} unsupported collection v3 request kind ${kind}`
      );
    }
    items.push(normalizeV3LocalNode(
      request,
      fileNameWithoutSuffix(realEntryPath, V3_REQUEST_SUFFIX),
      kind
    ));
  }

  return sortV3Items(items);
}

function loadV3CollectionDirectory(
  directoryPath: string,
  workspaceRoot: string,
  resourcesState: PostmanResourcesState | null
): AdditionalCollectionFile {
  const definitionPath = path.join(directoryPath, V3_DEFINITION_PATH);
  const displayPath = normalizedDisplayPath(workspaceRoot, directoryPath);
  const definitionDisplayPath = normalizedDisplayPath(workspaceRoot, definitionPath);
  const realDefinitionPath = resolveInsideWorkspace(
    workspaceRoot,
    definitionPath,
    'additional-collections-dir'
  );
  const definition = asRecord(parseYamlDocument(realDefinitionPath, definitionDisplayPath));
  if (!definition || definition.$kind !== 'collection') {
    throw new Error(
      `ADDITIONAL_COLLECTION_INVALID: ${definitionDisplayPath} must contain a collection v3 root object`
    );
  }
  if (definition.items !== undefined) {
    throw new Error(
      `ADDITIONAL_COLLECTION_UNSUPPORTED: ${definitionDisplayPath} inline items are not supported; collection items come from the directory tree`
    );
  }
  const collection = normalizeV3LocalNode(definition, path.basename(directoryPath), 'collection');
  collection.items = loadV3DirectoryItems(directoryPath, workspaceRoot);
  if (!Array.isArray(collection.items)) {
    throw new Error(
      `ADDITIONAL_COLLECTION_INVALID: ${definitionDisplayPath} collection v3 items must be an array`
    );
  }
  assertSupportedLocalViewContract(collection, { isRoot: true, displayPath });
  const name = String(collection.name ?? '').trim();
  const resourcePath = toResourcePath(displayPath);
  return {
    collection,
    existingCollectionId: findExistingAdditionalCollectionId(resourcesState, resourcePath),
    displayPath,
    name,
    resourcePath
  };
}

export function loadAdditionalCollectionFiles(
  directoryInput: string | undefined,
  resourcesState: PostmanResourcesState | null
): AdditionalCollectionFile[] {
  const configured = normalizeInputValue(directoryInput);
  if (!configured) {
    return [];
  }
  const { directoryPath, workspaceRoot } = resolveAdditionalCollectionsDir(configured);
  const v3Directories: string[] = [];
  collectV3CollectionDirectories(directoryPath, workspaceRoot, v3Directories);
  v3Directories.sort((a, b) => normalizedDisplayPath(workspaceRoot, a).localeCompare(normalizedDisplayPath(workspaceRoot, b)));

  const filePaths: string[] = [];
  collectSupportedCollectionPaths(
    directoryPath,
    workspaceRoot,
    filePaths,
    new Set(v3Directories)
  );
  filePaths.sort((a, b) => normalizedDisplayPath(workspaceRoot, a).localeCompare(normalizedDisplayPath(workspaceRoot, b)));

  if (v3Directories.length === 0 && filePaths.length === 0) {
    throw new Error(
      `ADDITIONAL_COLLECTIONS_DIR_EMPTY: additional-collections-dir contains no Postman collection JSON/YAML files or collection v3 directories: ${configured}`
    );
  }

  const collections = v3Directories.map((collectionDirectory) =>
    loadV3CollectionDirectory(collectionDirectory, workspaceRoot, resourcesState)
  );

  collections.push(...filePaths.map((filePath) => {
    const displayPath = normalizedDisplayPath(workspaceRoot, filePath);
    const extension = path.extname(filePath).toLowerCase();
    const document = parseAdditionalCollectionDocument(
      readFileSync(filePath, 'utf8'),
      extension,
      displayPath
    );
    const collection = extractPostmanCollectionPayload(document, displayPath);
    const info = asRecord(collection.info)!;
    const resourcePath = toResourcePath(displayPath);
    return {
      collection,
      existingCollectionId: findExistingAdditionalCollectionId(resourcesState, resourcePath),
      displayPath,
      name: String(info.name).trim(),
      resourcePath
    };
  }));

  return collections.sort((a, b) => a.resourcePath.localeCompare(b.resourcePath));
}

function ensureAdditionalCollectionsMap(state: PostmanResourcesState): CloudResourceMap {
  state.cloudResources ??= {};
  state.cloudResources.additionalCollections ??= {};
  return state.cloudResources.additionalCollections;
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  return (error as { status?: unknown }).status === 404;
}

async function createAdditionalCollection(options: {
  core: AdditionalCollectionsLogger;
  file: AdditionalCollectionFile;
  postman: AdditionalCollectionsPostmanClient;
  resourcesState: PostmanResourcesState;
  workspaceId: string;
}): Promise<AdditionalCollectionSyncResult> {
  const { core, file, postman, resourcesState, workspaceId } = options;
  if (!postman.createCollection) {
    throw new Error(
      'Additional collection creates require createCollection support from the Postman client'
    );
  }
  const collectionId = await postman.createCollection(workspaceId, file.collection);
  ensureAdditionalCollectionsMap(resourcesState)[file.resourcePath] = collectionId;
  writeResourcesState(resourcesState);
  core.info(
    `Created additional collection ${file.name} (${collectionId}) from ${file.displayPath}`
  );
  return {
    collectionId,
    displayPath: file.displayPath,
    name: file.name,
    operation: 'created',
    resourcePath: file.resourcePath
  };
}

export async function syncAdditionalCollections(options: {
  collectionFiles: AdditionalCollectionFile[];
  core: AdditionalCollectionsLogger;
  postman: AdditionalCollectionsPostmanClient;
  resourcesState: PostmanResourcesState;
  workspaceId: string;
}): Promise<AdditionalCollectionSyncResult[]> {
  const { collectionFiles, core, postman, resourcesState, workspaceId } = options;
  const results: AdditionalCollectionSyncResult[] = [];

  for (const file of collectionFiles) {
    if (file.existingCollectionId) {
      if (!postman.updateCollection) {
        throw new Error(
          'Additional collection updates require updateCollection support from the Postman client'
        );
      }
      try {
        await postman.updateCollection(file.existingCollectionId, file.collection);
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
        core.warning(
          `Existing additional collection ${file.existingCollectionId} was not found; creating ${file.name} in the current workspace`
        );
        results.push(await createAdditionalCollection({
          core,
          file,
          postman,
          resourcesState,
          workspaceId
        }));
        continue;
      }
      ensureAdditionalCollectionsMap(resourcesState)[file.resourcePath] = file.existingCollectionId;
      writeResourcesState(resourcesState);
      core.info(
        `Updated additional collection ${file.name} (${file.existingCollectionId}) from ${file.displayPath}`
      );
      results.push({
        collectionId: file.existingCollectionId,
        displayPath: file.displayPath,
        name: file.name,
        operation: 'updated',
        resourcePath: file.resourcePath
      });
      continue;
    }

    results.push(await createAdditionalCollection({
      core,
      file,
      postman,
      resourcesState,
      workspaceId
    }));
  }

  return results;
}

import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import type { CollectionRole } from './local-openapi-collection-generation.js';

type JsonRecord = Record<string, unknown>;

/**
 * Customer-supplied collection-root content for generated role payloads:
 * `beforeRequest` scripts (so an API needing a computed per-request signature —
 * OAuth 1.0a, HMAC, SigV4, JWS — is serviceable at all) and root `variable`
 * declarations (so that script has somewhere to read its inputs from).
 *
 * Both are written into the local v2 payload before it is canonicalized and
 * digested, which is what makes them survive regeneration. Neither uses a
 * post-create PATCH.
 */

/** Manifest schema version both inputs understand. */
export const COLLECTION_ROOT_CONTENT_SCHEMA_VERSION = 1;

/** Manifest role key applying to every generated role. */
export const WILDCARD_ROLE = '*';

const COLLECTION_ROLES: readonly CollectionRole[] = ['baseline', 'smoke', 'contract'];

/**
 * Collection-root script phases, named for the Collection v3 script types the
 * Local View contract already validates (`local-view-contract.ts` SCRIPT_TYPES)
 * rather than the legacy v2 `event.listen` phases, so one manifest key space can
 * serve the curated write surface later without a schema change.
 */
export const COLLECTION_ROOT_SCRIPT_TYPES = ['beforeRequest', 'afterResponse'] as const;
export type CollectionRootScriptType = (typeof COLLECTION_ROOT_SCRIPT_TYPES)[number];

/** v2 `event.listen` phase each v3 script type serializes to. */
const V2_LISTEN_BY_SCRIPT_TYPE: Record<CollectionRootScriptType, string> = {
  beforeRequest: 'prerequest',
  afterResponse: 'test'
};

/**
 * Phases actually applied today. `afterResponse` is part of the schema so the
 * input shape never has to change, but it is rejected on parse: a root
 * `afterResponse` lands beside the consolidated contract root `test` events and
 * needs a documented precedence rule before it can ship.
 */
const APPLIED_SCRIPT_TYPES: readonly CollectionRootScriptType[] = ['beforeRequest'];

/** Hard ceiling on one inlined script, matched to the contract script gate. */
export const MAX_COLLECTION_SCRIPT_BYTES = 900_000;

/**
 * `postman-smoke-flow-action` writes its own collection-root prerequest event
 * and strips prior events carrying this exact marker
 * (`collection-transform.ts` `isGeneratedOAuthEvent`). A customer script must
 * never contain it, or smoke-flow deletes the signer on its next run.
 */
export const SMOKE_FLOW_OAUTH_EVENT_MARKER =
  '[Smoke Flow] Auto-generated OAuth2 client-credentials token cache';

export type CollectionScriptPaths = Partial<Record<CollectionRootScriptType, string>>;
export type CollectionVariableValues = Record<string, string>;

/** Inlined script source per phase. */
export type CollectionRootScriptCode = Partial<Record<CollectionRootScriptType, string>>;

/** Fully resolved, file-contents-inlined scripts keyed by generated role. */
export type ResolvedCollectionRootScripts = Partial<Record<CollectionRole, CollectionRootScriptCode>>;

/** Resolved root variable declarations keyed by generated role. */
export type ResolvedCollectionRootVariables = Partial<Record<CollectionRole, CollectionVariableValues>>;

export interface CollectionRootContent {
  scripts?: ResolvedCollectionRootScripts;
  variables?: ResolvedCollectionRootVariables;
}

export interface CollectionRootContentDependencies {
  readFile?: (target: string) => string;
  realpath?: (candidate: string) => string;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function errorCode(inputName: string, suffix: string): string {
  return `${inputName.toUpperCase().replace(/-/g, '_')}_${suffix}`;
}

function isRoleKey(value: string): boolean {
  return value === WILDCARD_ROLE || (COLLECTION_ROLES as readonly string[]).includes(value);
}

/**
 * Real path of the workspace root, falling back to the resolved path when it
 * cannot be read. Both sides of the containment check must be realpathed or a
 * workspace root that is itself behind a symlink (macOS `/var`, and any agent
 * whose working directory is a link) rejects every legitimate path.
 */
function realWorkspaceRoot(workspaceRoot: string, realpath: (candidate: string) => string): string {
  const resolved = path.resolve(workspaceRoot);
  try {
    return realpath(resolved);
  } catch {
    return resolved;
  }
}

function resolveInsideWorkspace(
  workspaceRoot: string,
  relativePath: string,
  label: string,
  code: string,
  realpath: (candidate: string) => string
): string {
  const root = realWorkspaceRoot(workspaceRoot, realpath);
  const candidate = path.resolve(root, relativePath);
  let resolved: string;
  try {
    resolved = realpath(candidate);
  } catch (error) {
    throw new Error(`${code}_UNREADABLE: ${label} does not exist at ${relativePath}`, { cause: error });
  }
  // Checked after realpath so a symlink pointing outside the workspace cannot
  // smuggle host files into a collection payload. Compared on segment
  // boundaries, not by prefix: a legitimate in-workspace name whose first
  // component merely begins with two dots (`..fixtures/signer.js`) resolves
  // inside the workspace and must not be reported as an escape.
  const relative = path.relative(root, resolved);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `${code}_OUTSIDE_WORKSPACE: ${label} must resolve inside ${root}, got: ${resolved}`
    );
  }
  return resolved;
}

/**
 * Accept either form of a manifest input. A value starting with `{` is inline
 * JSON, which is what a GitHub Actions caller wants; anything else is a
 * workspace-relative path to a JSON file, which keeps the manifest reviewable in
 * a pull request and spares Azure DevOps callers three layers of quoting to pass
 * a JSON blob through a template parameter into a shell env var into a CLI flag.
 */
function readManifestText(
  raw: string | undefined,
  inputName: string,
  workspaceRoot: string,
  dependencies: CollectionRootContentDependencies
): string | undefined {
  const value = raw?.trim() ?? '';
  if (!value) return undefined;
  if (value.startsWith('{')) return value;

  if (path.isAbsolute(value)) {
    throw new Error(
      `${errorCode(inputName, 'INVALID')}: ${inputName} must be inline JSON starting with { or a workspace-relative manifest path, got an absolute path`
    );
  }
  const readFile = dependencies.readFile ?? ((target: string) => readFileSync(target, 'utf8'));
  const realpath = dependencies.realpath ?? ((candidate: string) => realpathSync(candidate));
  const target = resolveInsideWorkspace(
    workspaceRoot,
    value,
    `${inputName} manifest`,
    errorCode(inputName, 'MANIFEST'),
    realpath
  );
  try {
    return readFile(target);
  } catch (error) {
    throw new Error(
      `${errorCode(inputName, 'MANIFEST')}_UNREADABLE: ${inputName} manifest could not be read from ${value}`,
      { cause: error }
    );
  }
}

/**
 * Validate the `{ schemaVersion, roles }` envelope both inputs share and hand
 * each role entry to a per-input validator.
 */
function parseRoleEnvelope<TEntry>(
  text: string | undefined,
  inputName: string,
  parseEntry: (entry: JsonRecord, roleKey: string, invalid: (detail: string) => never) => TEntry
): Record<string, TEntry> | undefined {
  // Explicitly typed const so TypeScript treats it as a never-returning
  // assertion and narrows the null checks below.
  const invalid: (detail: string) => never = (detail) => {
    throw new Error(`${errorCode(inputName, 'INVALID')}: ${detail}`);
  };
  if (text === undefined || !text.trim()) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${errorCode(inputName, 'INVALID')}: ${inputName} must be valid JSON object content`,
      { cause: error }
    );
  }

  const manifest = asRecord(parsed);
  if (!manifest) invalid(`${inputName} must be a JSON object`);
  if (manifest.schemaVersion !== COLLECTION_ROOT_CONTENT_SCHEMA_VERSION) {
    invalid(
      `schemaVersion must be ${COLLECTION_ROOT_CONTENT_SCHEMA_VERSION}, got: ${JSON.stringify(manifest.schemaVersion)}`
    );
  }
  for (const field of Object.keys(manifest)) {
    if (field !== 'schemaVersion' && field !== 'roles') invalid(`unknown field ${field}`);
  }

  const roles = asRecord(manifest.roles);
  if (!roles) invalid('roles must be an object');
  if (Object.keys(roles).length === 0) invalid('roles must declare at least one entry');

  const validated: Record<string, TEntry> = {};
  for (const [roleKey, rawEntry] of Object.entries(roles)) {
    if (!isRoleKey(roleKey)) {
      invalid(`roles key ${roleKey} must be ${WILDCARD_ROLE} or one of ${COLLECTION_ROLES.join(', ')}`);
    }
    const entry = asRecord(rawEntry);
    if (!entry) invalid(`roles.${roleKey} must be an object`);
    validated[roleKey] = parseEntry(entry, roleKey, invalid);
  }
  return validated;
}

/**
 * Merge the wildcard entry with a role-specific entry. A role-specific key
 * replaces the wildcard for the same key; other keys compose.
 */
function effectiveEntryForRole<TEntry extends Record<string, unknown>>(
  roles: Record<string, TEntry>,
  role: CollectionRole
): TEntry {
  return { ...(roles[WILDCARD_ROLE] ?? {}), ...(roles[role] ?? {}) } as TEntry;
}

function parseScriptPaths(
  text: string | undefined
): Record<string, CollectionScriptPaths> | undefined {
  return parseRoleEnvelope<CollectionScriptPaths>(
    text,
    'collection-scripts-json',
    (entry, roleKey, invalid) => {
      if (Object.keys(entry).length === 0) {
        invalid(`roles.${roleKey} must declare at least one script type`);
      }
      const paths: CollectionScriptPaths = {};
      for (const [scriptType, rawPath] of Object.entries(entry)) {
        if (!(COLLECTION_ROOT_SCRIPT_TYPES as readonly string[]).includes(scriptType)) {
          invalid(
            `roles.${roleKey}.${scriptType} is not a supported script type (${COLLECTION_ROOT_SCRIPT_TYPES.join(', ')})`
          );
        }
        const applied = scriptType as CollectionRootScriptType;
        if (!APPLIED_SCRIPT_TYPES.includes(applied)) {
          invalid(
            `roles.${roleKey}.${scriptType} is reserved but not yet applied; only ${APPLIED_SCRIPT_TYPES.join(', ')} ships today`
          );
        }
        if (typeof rawPath !== 'string' || !rawPath.trim()) {
          invalid(`roles.${roleKey}.${scriptType} must be a non-empty workspace-relative path`);
        }
        const scriptPath = String(rawPath).trim();
        if (path.isAbsolute(scriptPath)) {
          invalid(`roles.${roleKey}.${scriptType} must be workspace-relative, got an absolute path`);
        }
        paths[applied] = scriptPath;
      }
      return paths;
    }
  );
}

function parseVariableValues(
  text: string | undefined
): Record<string, CollectionVariableValues> | undefined {
  return parseRoleEnvelope<CollectionVariableValues>(
    text,
    'collection-variables-json',
    (entry, roleKey, invalid) => {
      if (Object.keys(entry).length === 0) {
        invalid(`roles.${roleKey} must declare at least one variable`);
      }
      // Null prototype so a variable legitimately named `__proto__` becomes an
      // own property. On an ordinary object literal that assignment hits the
      // `Object.prototype.__proto__` setter, is ignored for a string value, and
      // the key silently disappears from `Object.keys`.
      const values: CollectionVariableValues = Object.create(null) as CollectionVariableValues;
      for (const [key, rawValue] of Object.entries(entry)) {
        if (!key.trim()) invalid(`roles.${roleKey} declares an empty variable name`);
        if (key !== key.trim()) {
          invalid(`roles.${roleKey} variable name ${JSON.stringify(key)} has surrounding whitespace`);
        }
        // Strings only. Coercing numbers and booleans would silently accept a
        // manifest whose author expected typed values Postman does not have.
        if (typeof rawValue !== 'string') {
          invalid(
            `roles.${roleKey}.${key} must be a string; declare the key as "" and supply the value at run time`
          );
        }
        values[key] = rawValue as string;
      }
      return values;
    }
  );
}

function inlineScripts(
  roles: Record<string, CollectionScriptPaths>,
  workspaceRoot: string,
  dependencies: CollectionRootContentDependencies
): ResolvedCollectionRootScripts | undefined {
  const readFile = dependencies.readFile ?? ((target: string) => readFileSync(target, 'utf8'));
  const realpath = dependencies.realpath ?? ((candidate: string) => realpathSync(candidate));

  const resolved: ResolvedCollectionRootScripts = {};
  for (const role of COLLECTION_ROLES) {
    const paths = effectiveEntryForRole(roles, role);
    const code: CollectionRootScriptCode = {};
    for (const scriptType of APPLIED_SCRIPT_TYPES) {
      const scriptPath = paths[scriptType];
      if (!scriptPath) continue;
      const label = `collection-scripts-json roles.${role}.${scriptType}`;
      const target = resolveInsideWorkspace(
        workspaceRoot,
        scriptPath,
        label,
        'COLLECTION_SCRIPT',
        realpath
      );
      let source: string;
      try {
        source = readFile(target);
      } catch (error) {
        throw new Error(
          `COLLECTION_SCRIPT_UNREADABLE: ${label} could not be read from ${scriptPath}`,
          { cause: error }
        );
      }
      if (typeof source !== 'string') {
        throw new Error(`COLLECTION_SCRIPT_UNREADABLE: ${label} did not read back as text`);
      }
      const bytes = Buffer.byteLength(source, 'utf8');
      if (bytes > MAX_COLLECTION_SCRIPT_BYTES) {
        throw new Error(
          `COLLECTION_SCRIPT_SIZE_EXCEEDED: ${label} is ${bytes} bytes, over the ${MAX_COLLECTION_SCRIPT_BYTES} byte limit`
        );
      }
      if (source.includes(SMOKE_FLOW_OAUTH_EVENT_MARKER)) {
        throw new Error(
          `COLLECTION_SCRIPT_RESERVED_MARKER: ${label} contains the postman-smoke-flow-action generated-OAuth marker, which makes smoke-flow delete this script on its next run`
        );
      }
      // Normalize to the exec form Sync round-trips: one joined string, LF
      // endings, no trailing blank lines. Emitting the same bytes the v2/v3/v2
      // canonicalization produces keeps the payload digest stable on rerun.
      const normalized = source.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
      // Checked on the normalized source, not the raw byte count. An
      // editor-created "empty" file often holds a single newline, which is one
      // byte; normalizing it yields '' and `applyCollectionRootScripts` then
      // drops it, so the run would succeed with no signer and no warning.
      if (!normalized.trim()) {
        throw new Error(`COLLECTION_SCRIPT_EMPTY: ${label} has no script content at ${scriptPath}`);
      }
      code[scriptType] = normalized;
    }
    if (Object.keys(code).length > 0) resolved[role] = code;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function resolveVariables(
  roles: Record<string, CollectionVariableValues>
): ResolvedCollectionRootVariables | undefined {
  const resolved: ResolvedCollectionRootVariables = {};
  for (const role of COLLECTION_ROLES) {
    const values = effectiveEntryForRole(roles, role);
    if (Object.keys(values).length > 0) resolved[role] = values;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/**
 * Resolve both inputs into applied content. Called before any provisioning side
 * effect so a malformed manifest, a missing script or a path escaping the
 * workspace fails the run before a workspace, spec or collection exists.
 *
 * Returns `undefined` when neither input is set, which is the sole path taken by
 * every existing caller: nothing is injected, the payload is byte-identical to
 * what today's code emits, and the payload digest is unchanged.
 */
export function resolveCollectionRootContent(
  scriptsInput: string | undefined,
  variablesInput: string | undefined,
  workspaceRoot: string,
  dependencies: CollectionRootContentDependencies = {}
): CollectionRootContent | undefined {
  const scriptRoles = parseScriptPaths(
    readManifestText(scriptsInput, 'collection-scripts-json', workspaceRoot, dependencies)
  );
  const variableRoles = parseVariableValues(
    readManifestText(variablesInput, 'collection-variables-json', workspaceRoot, dependencies)
  );

  const scripts = scriptRoles ? inlineScripts(scriptRoles, workspaceRoot, dependencies) : undefined;
  const variables = variableRoles ? resolveVariables(variableRoles) : undefined;
  if (!scripts && !variables) return undefined;
  return { ...(scripts ? { scripts } : {}), ...(variables ? { variables } : {}) };
}

/**
 * Write customer scripts onto a v2 role payload as collection-root events.
 *
 * Mutates and returns `collection`; callers pass role-local clones.
 *
 * Ordering is deliberate. This runs *after* `instrumentContractCollection`, so
 * the generated-contract forbidden-construct scan never inspects customer code
 * (a signing script that evals a pinned crypto library is legitimate and must
 * not fail onboarding), and *before* `canonicalizeV2CollectionForSync`, so the
 * script sits inside the digested payload and is rebuilt every run rather than
 * depending on a post-create PATCH.
 */
export function applyCollectionRootScripts(
  collection: JsonRecord,
  scripts: CollectionRootScriptCode | undefined
): JsonRecord {
  const applied = APPLIED_SCRIPT_TYPES.filter((scriptType) => scripts?.[scriptType]);
  if (!scripts || applied.length === 0) return collection;

  const replaced = new Set(applied.map((scriptType) => V2_LISTEN_BY_SCRIPT_TYPE[scriptType]));
  // Replace rather than append so a rerun converges instead of accumulating a
  // second copy of the same script.
  const preserved = asArray(collection.event).filter(
    (entry) => !replaced.has(String(asRecord(entry)?.listen ?? ''))
  );
  const injected = applied.map((scriptType) => ({
    listen: V2_LISTEN_BY_SCRIPT_TYPE[scriptType],
    script: { type: 'text/javascript', exec: [scripts[scriptType] as string] }
  }));
  collection.event = [...injected, ...preserved];
  return collection;
}

/**
 * Declare customer root variables on a v2 role payload.
 *
 * Mutates and returns `collection`. A declared key already present in the
 * spec-derived array (`baseUrl`, server variables) is updated in place so
 * ordering stays deterministic across reruns; new keys append in manifest order.
 * Only the *initial* value travels in the collection document, so a value typed
 * into the app's Current Value column survives regeneration as long as the key
 * still exists in the manifest.
 */
export function applyCollectionRootVariables(
  collection: JsonRecord,
  variables: CollectionVariableValues | undefined
): JsonRecord {
  if (!variables || Object.keys(variables).length === 0) return collection;

  const merged = asArray(collection.variable)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonRecord => Boolean(entry))
    .map((entry) => ({ ...entry }));
  for (const [key, value] of Object.entries(variables)) {
    const match = merged.find((entry) => String(entry.key ?? '') === key);
    if (match) match.value = value;
    else merged.push({ key, value });
  }
  collection.variable = merged;
  return collection;
}

/** Apply both channels to one role payload. */
export function applyCollectionRootContent(
  collection: JsonRecord,
  role: CollectionRole,
  content: CollectionRootContent | undefined
): JsonRecord {
  if (!content) return collection;
  applyCollectionRootVariables(collection, content.variables?.[role]);
  applyCollectionRootScripts(collection, content.scripts?.[role]);
  return collection;
}

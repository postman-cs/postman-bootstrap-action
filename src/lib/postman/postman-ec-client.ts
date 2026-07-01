import { itemsByType } from '@postman/runtime.models/extensible';

import { POSTMAN_ENDPOINT_PROFILES } from './base-urls.js';
import { HttpError } from '../http-error.js';
import { retry } from '../retry.js';
import { createSecretMasker, type SecretMasker } from '../secrets.js';
import type { AccessTokenProvider } from './token-provider.js';

type JsonRecord = Record<string, unknown>;

/** Write attempts before giving up, matching the rest of the action's retry cap. */
const EC_WRITE_MAX_ATTEMPTS = 3;

/**
 * Map a v2.1.0 `item.event` listen phase to the EC `extensions.events` phase.
 * The protocol instrumenters emit v2.1.0 events (`prerequest`/`test`); the EC
 * item model names the same phases `beforeRequest`/`afterResponse`.
 */
const EC_EVENT_LISTEN_BY_V2: Record<string, string> = {
  prerequest: 'beforeRequest',
  test: 'afterResponse'
};

// EC leaf request types that own message/example children in the item model
// (AsyncAPI WebSocket / Socket.IO). Unlike `folder`, these are request leaves,
// but the collection service accepts their messages as items parented to the
// request. Every other request type is a childless leaf.
const EC_CHILD_BEARING_REQUEST_TYPES = new Set(['ws-raw-request', 'ws-socketio-request']);

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Coerce a v2.1.0 `script.exec` (a string array, one entry per source line)
 * into the single string the EC v3 item schema enforces. A string passes
 * through unchanged; anything else collapses to an empty string.
 */
function execToString(exec: unknown): string {
  if (Array.isArray(exec)) return exec.map((line) => String(line ?? '')).join('\n');
  if (typeof exec === 'string') return exec;
  return '';
}

/**
 * Normalize one `extensions.events` entry to the EC v3 shape: a `script.exec`
 * string. Entries without a script object pass through untouched.
 */
function normalizeEcEvent(raw: unknown): unknown {
  const event = asRecord(raw);
  if (!event) return raw;
  const script = asRecord(event.script);
  if (!script) return raw;
  return { ...event, script: { ...script, exec: execToString(script.exec) } };
}

/**
 * Retry only on transient failures: bifrost/collection-service 429 + 5xx and
 * undici network errors (surfaced as TypeError). 4xx (auth, validation) are
 * permanent and rethrow immediately.
 */
function isRetryableEcError(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError;
}

export interface PostmanExtensibleCollectionClientOptions {
  /** Bifrost/governance access token. Required: the EC v3 API is access-token only. */
  accessToken: string;
  /**
   * Optional live-token accessor. When present, every request reads the token
   * through `tokenProvider.current()` so a mid-run re-mint propagates; the
   * `accessToken` field remains the back-compat seed and validation source.
   */
  tokenProvider?: AccessTokenProvider;
  /** Bifrost gateway base URL hosting the /ws/proxy collection-service route. */
  bifrostBaseUrl?: string;
  teamId?: string;
  orgMode?: boolean;
  fetchImpl?: typeof fetch;
  secretMasker?: SecretMasker;
  /**
   * Sink for pre-create EC-item schema drift messages (defaults to
   * `console.warn`, i.e. stderr). The action wires `core.warning` so drift
   * surfaces in the run log without failing the create.
   */
  validationReporter?: (message: string) => void;
}

export interface CreateExtensibleCollectionInput {
  name: string;
  description?: string;
  /**
   * Collection-level payload (e.g. `{ variables: [...] }`). The runtime.models
   * transform lifts a v2.1.0 collection's `variable` array to `payload.variables`;
   * forwarding it here keeps `{{baseUrl}}`-style request references resolvable.
   */
  payload?: JsonRecord;
  /**
   * Collection-level extensions (e.g. `{ documentation: { content } }`). When
   * provided it supersedes the `description`-derived documentation default.
   */
  extensions?: JsonRecord;
}

/**
 * Extensible Collection (EC) cloud client.
 *
 * gRPC collections use the `grpc-request` item type, which only exists in the
 * EC schema. The public `POST https://api.getpostman.com/collections` endpoint
 * validates the legacy v2.1.0 schema and rejects EC payloads
 * (`malformedRequestError: item must have required property 'request'`), so EC
 * collections must be created through the gateway proxy against the Collection
 * service's EC API instead.
 *
 * Transport and wire contract mirror the cloud-ec service
 * (postman-app data/collection-data/src/services/cloud-ec/operations/*) and our
 * own BifrostInternalIntegrationAdapter: a `POST {bifrost}/ws/proxy` envelope
 * `{ service:'collection', method, path, body }`, authenticated with
 * `x-access-token` (plus `x-entity-team-id` when org-mode). A collection is
 * created via `POST /collections/` with the `NewCollection` shape
 * (`{ workspace, title, payload, extensions }`); each folder / `grpc-request`
 * item is then added via `POST /collections/:id/items/` with the `NewItem`
 * shape (`{ type, title, position:{parent}, payload, extensions }`).
 */
export class PostmanExtensibleCollectionClient {
  private readonly accessToken: string;
  private readonly tokenProvider?: AccessTokenProvider;
  private readonly bifrostBaseUrl: string;
  private teamId: string;
  private orgMode: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly secretMasker: SecretMasker;
  private readonly validationReporter: (message: string) => void;

  constructor(options: PostmanExtensibleCollectionClientOptions) {
    this.accessToken = String(options.accessToken || '').trim();
    this.tokenProvider = options.tokenProvider;
    if (!this.currentToken()) {
      throw new Error(
        'EC_REQUIRES_ACCESS_TOKEN: creating a gRPC (extensible) collection requires postman-access-token; ' +
          'provide it (resolve-service-token mints one) or pre-create the collection.'
      );
    }
    this.bifrostBaseUrl = String(
      options.bifrostBaseUrl || POSTMAN_ENDPOINT_PROFILES.prod.bifrostBaseUrl
    ).replace(/\/+$/, '');
    this.teamId = String(options.teamId || '').trim();
    this.orgMode = options.orgMode ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.secretMasker =
      options.secretMasker ?? createSecretMasker([this.accessToken]);
    this.validationReporter =
      options.validationReporter ?? ((message: string) => console.warn(message));
  }

  /**
   * Re-scope EC requests to the workspace-owning sub-team once it is resolved.
   * The client is constructed before workspace provisioning runs, so org-mode
   * runs must hand it the resolved sub-team id (not the parent-org team) and the
   * independently derived org-mode flag, mirroring AccessTokenGatewayClient.
   */
  configureTeamContext(teamId: string, orgMode: boolean): void {
    this.teamId = String(teamId || '').trim();
    this.orgMode = orgMode;
  }

  /** Live access token: the provider's current value when wired, else the seed. */
  private currentToken(): string {
    return this.tokenProvider ? this.tokenProvider.current() : this.accessToken;
  }

  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-access-token': this.currentToken()
    };
    if (this.teamId && this.orgMode) {
      headers['x-entity-team-id'] = this.teamId;
    }
    return headers;
  }

  private async proxyRequest(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<Response> {
    const url = `${this.bifrostBaseUrl}/ws/proxy`;
    return this.fetchImpl(url, {
      method: 'POST',
      headers: this.requestHeaders(),
      body: JSON.stringify({
        service: 'collection',
        method: method.toLowerCase(),
        path,
        ...(body !== undefined ? { body } : {})
      })
    });
  }

  private async proxyJson(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: unknown,
    operation: string
  ): Promise<JsonRecord | null> {
    // Retry transient bifrost/collection-service failures (429/5xx/network);
    // permanent 4xx and inner-envelope errors rethrow on the first attempt.
    return retry(() => this.proxyJsonOnce(method, path, body, operation), {
      maxAttempts: EC_WRITE_MAX_ATTEMPTS,
      delayMs: 2000,
      shouldRetry: (error) => isRetryableEcError(error)
    });
  }

  private async proxyJsonOnce(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: unknown,
    operation: string
  ): Promise<JsonRecord | null> {
    const response = await this.proxyRequest(method, path, body);
    if (!response.ok) {
      throw await HttpError.fromResponse(response, {
        method,
        requestHeaders: this.requestHeaders(),
        secretValues: [this.currentToken()],
        url: `${this.bifrostBaseUrl}/ws/proxy (${operation}: ${method} ${path})`
      });
    }
    let parsed: JsonRecord | null;
    try {
      parsed = (await response.json()) as JsonRecord;
    } catch {
      return null;
    }
    this.assertNoInnerError(parsed, method, path, operation);
    return parsed;
  }

  /**
   * bifrost `/ws/proxy` can answer HTTP 200 while wrapping an inner
   * collection-service failure in the envelope (the outer transport succeeded
   * even though the inner RPC did not). Treat an envelope carrying an `error`,
   * `success:false`, or an inner `status`/`statusCode` >= 400 as a failure so a
   * write is not silently reported as success and the retry policy can still see
   * a retryable inner 5xx.
   */
  private assertNoInnerError(
    envelope: JsonRecord | null,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    operation: string
  ): void {
    if (!envelope) return;
    const innerStatus = this.innerStatus(envelope);
    const error = envelope.error;
    const errorRecord = asRecord(error);
    const hasError =
      (error !== undefined &&
        error !== null &&
        !(errorRecord !== null && Object.keys(errorRecord).length === 0)) ||
      envelope.success === false ||
      (typeof innerStatus === 'number' && innerStatus >= 400);
    if (!hasError) return;
    const status = typeof innerStatus === 'number' && innerStatus >= 400 ? innerStatus : 502;
    throw new HttpError({
      method,
      url: `${this.bifrostBaseUrl}/ws/proxy (${operation}: ${method} ${path}) [inner]`,
      status,
      statusText: 'Inner Error',
      requestHeaders: this.requestHeaders(),
      responseBody: this.secretMasker(JSON.stringify(envelope)),
      secretValues: [this.currentToken()]
    });
  }

  private innerStatus(envelope: JsonRecord): number | undefined {
    for (const key of ['status', 'statusCode']) {
      const value = envelope[key];
      if (typeof value === 'number') return value;
      if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    }
    return undefined;
  }

  /**
   * Create an empty extensible collection in the workspace. Returns its id.
   * The create endpoint echoes only `{ data: { id, createdAt } }`.
   */
  async createExtensibleCollection(
    workspaceId: string,
    input: CreateExtensibleCollectionInput
  ): Promise<string> {
    if (!workspaceId) {
      throw new Error('EC_CREATE_INVALID_ARGUMENT: workspaceId is required');
    }
    const name = String(input.name || '').trim();
    if (!name) {
      throw new Error('EC_CREATE_INVALID_ARGUMENT: collection name is required');
    }
    const extensions: JsonRecord = input.extensions ?? {
      documentation: { content: input.description ?? '' }
    };
    const body: JsonRecord = {
      workspace: workspaceId,
      title: name,
      payload: input.payload ?? {},
      extensions
    };
    const response = await this.proxyJson(
      'POST',
      '/collections/',
      body,
      'createExtensibleCollection'
    );
    const id = this.extractId(response);
    if (!id) {
      throw new Error('EC_CREATE_FAILED: extensible collection create did not return an id');
    }
    return id;
  }

  /**
   * Create a single EC item (folder or leaf request) under a collection,
   * optionally beneath a parent item. Returns the server-assigned id so the
   * caller can thread parent linkage for nested folders/requests. The wire
   * body is the cloud-ec `NewItem` shape
   * (`{ type, title, position, payload, extensions }`); `position.parent`
   * defaults to the collection id for top-level items.
   */
  async createItem(
    collectionId: string,
    item: JsonRecord,
    parentId?: string
  ): Promise<string> {
    if (!collectionId) {
      throw new Error('EC_ITEM_INVALID_ARGUMENT: collectionId is required');
    }
    const type = item.type;
    const title = item.title ?? item.name;
    const extensions = this.mergeEventExtensions(item, asRecord(item.extensions) ?? {});
    const payload = asRecord(item.payload) ?? {};
    // Validate the logical item against the official EC v3 item schema before
    // the gateway create, so a malformed node (e.g. a `grpc-request` missing
    // `extensions.schema.location`) fails fast with the exact offending path
    // instead of an opaque gateway 400.
    this.reportEcItemShapeIssues(type, { type, title, payload, extensions });
    const body: JsonRecord = {
      type,
      title,
      position: { parent: parentId || collectionId },
      payload,
      extensions
    };
    const response = await this.proxyJson(
      'POST',
      `/collections/${collectionId}/items/`,
      body,
      'createItem'
    );
    const id = this.extractId(response);
    if (!id) {
      throw new Error('EC_ITEM_FAILED: extensible collection item create did not return an id');
    }
    return id;
  }

  /**
   * Fold a v2.1.0 `item.event` array onto the EC item's `extensions.events`. The
   * protocol instrumenters write scripts as v2.1.0 events
   * (`{ listen:'test'|'prerequest', script:{exec} }`), but the EC item model
   * carries them under `extensions.events` with the EC phase names
   * (`afterResponse`/`beforeRequest`). Without this map the generated gRPC test
   * scripts are dropped on the EC create path. Existing `extensions.events` are
   * preserved; unrecognized listen phases pass through verbatim (no silent drop).
   */
  private mergeEventExtensions(item: JsonRecord, extensions: JsonRecord): JsonRecord {
    const mapped = asArray(item.event)
      .map((raw): JsonRecord | null => {
        const event = asRecord(raw);
        if (!event) return null;
        const script = asRecord(event.script);
        if (!script) return null;
        const v2Listen = typeof event.listen === 'string' ? event.listen : '';
        const listen = EC_EVENT_LISTEN_BY_V2[v2Listen] ?? v2Listen;
        // v2.1.0 scripts carry `exec` as a string array (one entry per line);
        // the EC item schema enforces `script.exec` as a single string, so the
        // verbatim array 400s with SCHEMA_ENFORCED. Join to the EC shape here.
        return { listen, script: { ...script, exec: execToString(script.exec) } };
      })
      .filter((entry): entry is JsonRecord => entry !== null);
    const existing = asArray(extensions.events).map(normalizeEcEvent);
    if (mapped.length === 0) {
      return existing.length > 0 ? { ...extensions, events: existing } : extensions;
    }
    return {
      ...extensions,
      events: [...existing, ...mapped]
    };
  }

  /**
   * Validate a logical EC item (`{ type, title, payload, extensions }`) against
   * the official `@postman/runtime.models` extensible item schema for its type
   * and surface any schema drift (e.g. a `grpc-request` missing
   * `extensions.schema.location`) through the validation reporter before the
   * gateway create. Reported rather than thrown: a forward-incompatible-but-
   * valid shape (a field the pinned models don't yet model) must not block a
   * create, and the gateway remains the authority that rejects a truly bad body.
   * Unknown item types pass through unvalidated (forward-compat).
   */
  private reportEcItemShapeIssues(type: unknown, logicalItem: JsonRecord): void {
    if (typeof type !== 'string') return;
    const registry = itemsByType as Record<
      string,
      { validate?: (value: unknown) => { issues?: unknown } } | undefined
    >;
    const model = registry[type];
    if (!model?.validate) return;
    const issues = model.validate(logicalItem)?.issues;
    if (issues) {
      this.validationReporter(
        `EC_ITEM_SCHEMA_DRIFT: ${type} item does not match the EC v3 schema before create: ` +
          this.secretMasker(JSON.stringify(issues))
      );
    }
  }

  async getExtensibleCollection(collectionId: string): Promise<JsonRecord | null> {
    if (!collectionId) {
      throw new Error('EC_GET_INVALID_ARGUMENT: collectionId is required');
    }
    return this.proxyJson(
      'GET',
      `/collections/${collectionId}`,
      undefined,
      'getExtensibleCollection'
    );
  }

  async deleteExtensibleCollection(collectionId: string): Promise<void> {
    if (!collectionId) {
      throw new Error('EC_DELETE_INVALID_ARGUMENT: collectionId is required');
    }
    await this.proxyJson(
      'DELETE',
      `/collections/${collectionId}`,
      {},
      'deleteExtensibleCollection'
    );
  }

  /**
   * Flat item list for an extensible collection via `GET /collections/:id/items/`
   * (the collection-service `getItemList`). Returns every item record (folders
   * and `grpc-request` leaves) the server holds, so a live readback can assert
   * leaf count, types, and the persisted `extensions.events` instead of trusting
   * the local create count. The envelope nests the list under `data` (array, or
   * `{ items: [...] }`); both shapes are tolerated.
   */
  async listExtensibleCollectionItems(collectionId: string): Promise<JsonRecord[]> {
    if (!collectionId) {
      throw new Error('EC_LIST_INVALID_ARGUMENT: collectionId is required');
    }
    const response = await this.proxyJson(
      'GET',
      `/collections/${collectionId}/items/`,
      undefined,
      'listExtensibleCollectionItems'
    );
    const root = response?.data ?? response;
    const items = Array.isArray(root) ? root : asArray(asRecord(root)?.items);
    return items
      .map((raw) => asRecord(raw))
      .filter((record): record is JsonRecord => record !== null);
  }

  /**
   * Fetch a single EC item via `GET /collections/:id/items/:itemId`
   * (collection-service `getItem`). Unlike {@link listExtensibleCollectionItems}
   * — whose `getItemList` projection omits `extensions` — the per-item GET
   * returns the full `ItemGet` record including `extensions.events`, so it is
   * the route a readback must use to assert persisted test scripts. Returns the
   * unwrapped item record (the response nests it under `data`), or null when the
   * server returns an empty body.
   */
  async getExtensibleCollectionItem(
    collectionId: string,
    itemId: string
  ): Promise<JsonRecord | null> {
    if (!collectionId) {
      throw new Error('EC_ITEM_GET_INVALID_ARGUMENT: collectionId is required');
    }
    if (!itemId) {
      throw new Error('EC_ITEM_GET_INVALID_ARGUMENT: itemId is required');
    }
    const response = await this.proxyJson(
      'GET',
      `/collections/${collectionId}/items/${itemId}`,
      undefined,
      'getExtensibleCollectionItem'
    );
    return asRecord(response?.data) ?? asRecord(response);
  }

  /**
   * Walk a built EC collection tree and materialize it in the cloud: create each
   * folder, then its leaf requests beneath that folder. Returns the count of leaf
   * request items created. Folders/leaves carry their test scripts, which the EC
   * item create persists.
   *
   * Accepts both tree shapes the action produces:
   *   - native builder trees (gRPC): children nest under `item`, tests under a
   *     v2-style `event` array (folded to `extensions.events` by createItem);
   *   - `@postman/runtime.models` transform output (graphql/soap/OAS): children
   *     nest under `children`, tests already under `extensions.events`, and each
   *     node carries a logical `id` the cloud must reassign;
   *   - AsyncAPI WS/Socket.IO trees: a `ws-raw-request` / `ws-socketio-request`
   *     leaf that itself carries `ws-*-message` / `ws-*-example` children. In the
   *     EC item model these messages belong to the request, so the request is
   *     created first and each message/example is created beneath it (its
   *     `position.parent` is the request id). The request counts as one leaf.
   */
  async populateFromTree(collectionId: string, tree: JsonRecord): Promise<number> {
    let leafCount = 0;
    const childrenOf = (node: JsonRecord): unknown[] =>
      node.children !== undefined ? asArray(node.children) : asArray(node.item);
    const createChildren = async (nodes: unknown[], parentId?: string): Promise<void> => {
      for (const raw of nodes) {
        const node = asRecord(raw);
        if (!node) continue;
        const children = childrenOf(node);
        const type = typeof node.type === 'string' ? node.type : '';
        const isFolder = type === 'folder';
        // A ws-raw-request / ws-socketio-request is a leaf request that owns its
        // message/example children in the EC item model.
        const isChildBearingRequest = EC_CHILD_BEARING_REQUEST_TYPES.has(type);
        // Type-authoritative: only a `folder` or a child-bearing ws request may
        // carry children. Any other type with nested items is a malformed tree
        // whose children would otherwise be silently dropped, so fail loudly.
        if (!isFolder && !isChildBearingRequest && children.length > 0) {
          const label = typeof node.title === 'string' ? node.title : String(node.name ?? '<unnamed>');
          throw new Error(
            `EC_TREE_INVALID: node "${label}" (type=${type || '<none>'}) carries child items but is not a folder or ws request; ` +
              "only 'folder' and 'ws-raw-request'/'ws-socketio-request' nodes may contain children"
          );
        }
        const nodeBody: JsonRecord = { ...node };
        // Strip nesting + any logical id; the cloud assigns the item id on create.
        delete nodeBody.item;
        delete nodeBody.children;
        delete nodeBody.id;
        const createdId = await this.createItem(collectionId, nodeBody, parentId);
        if (isFolder) {
          await createChildren(children, createdId);
        } else if (isChildBearingRequest) {
          // Messages/examples are items beneath the request, not request leaves,
          // so they are created but not counted toward the request-leaf total.
          for (const childRaw of children) {
            const childNode = asRecord(childRaw);
            if (!childNode) continue;
            const childBody: JsonRecord = { ...childNode };
            delete childBody.item;
            delete childBody.children;
            delete childBody.id;
            await this.createItem(collectionId, childBody, createdId);
          }
          leafCount += 1;
        } else {
          leafCount += 1;
        }
      }
    };
    await createChildren(childrenOf(tree));
    return leafCount;
  }

  private extractId(response: JsonRecord | null): string {
    const data = asRecord(response?.data) ?? response;
    const id = data ? data.id ?? data.uid : undefined;
    return typeof id === 'string' ? id.trim() : '';
  }
}

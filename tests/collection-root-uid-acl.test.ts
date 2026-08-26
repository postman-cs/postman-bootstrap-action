import { describe, expect, it, vi } from 'vitest';

import { AccessTokenGatewayClient } from '@postman-cs/automation-core';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';
import { renderAssetMarker } from '../src/lib/repo/branch-decision.js';

/**
 * Collection ROOT ACL contract (live-proven 2026-08-03, non-org + org sandbox).
 *
 * Postman tightened ACLs on the collection-service ROOT routes. Sending the
 * bare model id now fails closed:
 *
 *   PATCH /v3/collections/:id            bare=403 FORBIDDEN   full=200
 *   GET   /v3/collections/:id            bare=403 FORBIDDEN   full=200
 *   GET   /v3/collections/:id/export     bare=200             full=200
 *   DELETE /v3/collections/:id           bare=200             full=200
 *   PUT   sync /collection/deepupdate/:id bare=200            full=200
 *
 * The 403 body is
 *   {"error":{"code":"FORBIDDEN","message":"Access to the requested resource ..."}}
 *
 * `sync POST /collection/import` returns a BARE model id, so the import
 * finalize rename PATCHed a bare id and 403'd — and import-finalize's catch
 * DELETES the fresh collection, so the customer lost the import.
 *
 * These tests pin the wire vocabulary per route family. They fail on the
 * pre-fix source, where every ROOT path was built with `bareModelId`.
 */

const UUID = '6b9b8a7c-1111-4222-8333-444455556666';
const OWNER = '132319';
const FULL = `${OWNER}-${UUID}`;

const FULL_PUBLIC_UID_RE =
  /^\d+-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

interface Envelope {
  service: string;
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
}

/** Production's 403 for a bare id on a ROOT route, byte-shaped as live. */
function forbidden(id: string): Response {
  return jsonResponse(
    {
      error: {
        code: 'FORBIDDEN',
        message: `Access to the requested resource "${id}" has been denied`
      }
    },
    { status: 403 }
  );
}

/** Final path segment of a collection ROOT route, or undefined if not one. */
function rootSegment(path: string): string | undefined {
  const match = /^\/v3\/collections\/([^/?]+)$/.exec(path);
  return match?.[1];
}

function makeClient(
  handler: (env: Envelope, callIndex: number) => Response,
  clientOptions?: Record<string, unknown>
): { client: PostmanGatewayAssetsClient; calls: Envelope[] } {
  const calls: Envelope[] = [];
  let i = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const requestUrl = new URL(String(url));
    const env =
      requestUrl.pathname === '/ws/proxy'
        ? (JSON.parse(String((init as RequestInit).body)) as Envelope)
        : {
            service: 'direct',
            method: String((init as RequestInit).method ?? 'GET').toLowerCase(),
            path: `${requestUrl.pathname}${requestUrl.search}`
          };
    calls.push(env);
    return handler(env, i++);
  });
  const gateway = new AccessTokenGatewayClient({
    tokenProvider: new AccessTokenProvider({ accessToken: 'tok-1' }),
    fetchImpl,
    sleepImpl: async () => undefined
  });
  const client = new PostmanGatewayAssetsClient({
    gateway,
    sleep: async () => undefined,
    createIdentity: () => 'test-run',
    ...clientOptions
  });
  return { client, calls };
}

/**
 * A fake that enforces the live ACL: ROOT GET/PATCH 403 on anything that is not
 * a full `<owner>-<uuid>` public uid, while export/DELETE/sync keep accepting
 * the bare model id. Any route family that regresses shows up as a hard 403,
 * exactly as production does.
 */
function aclEnforcingHandler(options: {
  inventory: Array<{ id: string; name: string; description?: string }>;
  onImport?: (body: unknown) => void;
}): (env: Envelope) => Response {
  return (env) => {
    const path = String(env.path);

    if (env.service === 'sync' && env.method === 'post' && path === '/collection/import') {
      options.onImport?.(env.body);
      const body = env.body as { info?: { name?: string } };
      options.inventory.push({ id: FULL, name: String(body.info?.name ?? '') });
      // Live SyncService envelope: BARE model id, never the full public uid.
      return jsonResponse({
        model_id: UUID,
        data: { info: { _postman_id: UUID, name: String(body.info?.name ?? '') } }
      });
    }

    if (env.service === 'sync' && env.method === 'put' && path.startsWith('/collection/deepupdate/')) {
      return jsonResponse({ data: { id: path.split('/').pop() } });
    }

    if (env.service === 'collection' && path.startsWith('/v3/collections/?workspace=')) {
      return jsonResponse({ data: options.inventory });
    }

    if (env.service === 'collection' && /\/export$/.test(path)) {
      return jsonResponse({ data: { collection: { info: { name: 'Payments' }, item: [] } } });
    }

    const segment = rootSegment(path);
    if (env.service === 'collection' && segment !== undefined) {
      // Live ACL: ROOT GET/PATCH require the full public uid.
      if ((env.method === 'patch' || env.method === 'get') && !FULL_PUBLIC_UID_RE.test(segment)) {
        return forbidden(segment);
      }
      if (env.method === 'patch') {
        const ops = env.body as Array<{ path?: string; value?: string }>;
        const nameOp = ops?.find((op) => op.path === '/name');
        if (nameOp?.value) {
          const hit = options.inventory.find((entry) => entry.id === FULL);
          if (hit) hit.name = String(nameOp.value);
        }
      }
      if (env.method === 'delete') {
        const index = options.inventory.findIndex((entry) => entry.id === FULL);
        if (index >= 0) options.inventory.splice(index, 1);
        return jsonResponse({ data: { id: segment } });
      }
      return jsonResponse({ data: { id: FULL, name: options.inventory[0]?.name } });
    }

    return jsonResponse({ data: { ok: true } });
  };
}

const v21Collection = {
  info: {
    name: 'Payments',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    _postman_id: '11111111-1111-1111-1111-111111111111',
    description: ''
  },
  item: [
    {
      name: 'GET /payments',
      request: { method: 'GET', header: [], url: 'https://example.test/payments' }
    }
  ]
};

describe('collection ROOT routes address by full public uid (live ACL 2026-08-03)', () => {
  it('finalizes a sync import whose envelope returns only the bare model id', async () => {
    const inventory: Array<{ id: string; name: string }> = [];
    const { client, calls } = makeClient(aclEnforcingHandler({ inventory }));

    const result = await client.importV2Collection('ws-1', v21Collection, 'Payments');

    // Election still returns the canonical inventory uid.
    expect(result.collectionId).toBe(FULL);
    // The rename actually landed rather than 403ing.
    expect(inventory.some((entry) => entry.id === FULL && entry.name === 'Payments')).toBe(true);

    // No ROOT GET/PATCH may ever carry a bare id.
    const offenders = calls.filter((call) => {
      if (call.service !== 'collection') return false;
      if (call.method !== 'patch' && call.method !== 'get') return false;
      const segment = rootSegment(String(call.path));
      return segment !== undefined && !FULL_PUBLIC_UID_RE.test(segment);
    });
    expect(offenders.map((call) => `${call.method} ${call.path}`)).toEqual([]);
  });

  it('sends the full public uid on the generated-collection rename PATCH', async () => {
    const { client, calls } = makeClient((env) => {
      const segment = rootSegment(String(env.path));
      if (env.service === 'collection' && env.method === 'patch' && segment !== undefined) {
        if (!FULL_PUBLIC_UID_RE.test(segment)) return forbidden(segment);
        return jsonResponse({ data: { id: FULL } });
      }
      return jsonResponse({ data: { ok: true } });
    });

    await (
      client as unknown as {
        renameGeneratedCollection: (id: string, name: string) => Promise<void>;
      }
    ).renameGeneratedCollection(FULL, 'Renamed');

    const patch = calls.find((call) => call.service === 'collection' && call.method === 'patch');
    expect(patch?.path).toBe(`/v3/collections/${FULL}`);
  });

  it('fails locally rather than sending a bare generated-collection id to ROOT', async () => {
    const { client, calls } = makeClient(() => jsonResponse({ data: { ok: true } }));

    await expect(
      (
        client as unknown as {
          renameGeneratedCollection: (id: string, name: string) => Promise<void>;
        }
      ).renameGeneratedCollection(UUID, 'Renamed')
    ).rejects.toThrow(/COLLECTION_ROOT_UID_REQUIRED/);

    expect(calls).toEqual([]);
  });

  it('sends the full public uid on the description PATCH', async () => {
    const { client, calls } = makeClient((env) => {
      const segment = rootSegment(String(env.path));
      if (env.service === 'collection' && env.method === 'patch' && segment !== undefined) {
        if (!FULL_PUBLIC_UID_RE.test(segment)) return forbidden(segment);
        return jsonResponse({ data: { id: FULL } });
      }
      return jsonResponse({ data: { ok: true } });
    });

    await client.updateCollectionDescription(FULL, 'durable description');

    const patch = calls.find((call) => call.service === 'collection' && call.method === 'patch');
    expect(patch?.path).toBe(`/v3/collections/${FULL}`);
  });

  it('fails locally rather than sending a bare id on the description PATCH', async () => {
    const { client, calls } = makeClient(() => jsonResponse({ data: { ok: true } }));

    await expect(client.updateCollectionDescription(UUID, 'durable description')).rejects.toThrow(
      /COLLECTION_ROOT_UID_REQUIRED/
    );

    expect(calls).toEqual([]);
  });

  it('sends the full public uid on the absence-verification root GET', async () => {
    const inventory: Array<{ id: string; name: string }> = [];
    const { client, calls } = makeClient(aclEnforcingHandler({ inventory }));

    await client.deleteVerifiedRunOwnedCollections('ws-1', [FULL]);

    const rootGets = calls.filter(
      (call) =>
        call.service === 'collection' &&
        call.method === 'get' &&
        rootSegment(String(call.path)) !== undefined
    );
    expect(rootGets.length).toBeGreaterThan(0);
    for (const call of rootGets) {
      expect(rootSegment(String(call.path))).toMatch(FULL_PUBLIC_UID_RE);
    }
  });

  it('uses inventory directly when only a bare journal id is available for absence verification', async () => {
    const inventory: Array<{ id: string; name: string }> = [{ id: FULL, name: 'Payments' }];
    const { client, calls } = makeClient(aclEnforcingHandler({ inventory }));

    await client.deleteVerifiedRunOwnedCollections('ws-1', [UUID]);

    expect(
      calls.filter(
        (call) =>
          call.service === 'collection' &&
          call.method === 'get' &&
          rootSegment(String(call.path)) !== undefined
      )
    ).toEqual([]);
    expect(
      calls.some(
        (call) =>
          call.service === 'collection' &&
          call.method === 'get' &&
          String(call.path).startsWith('/v3/collections/?workspace=')
      )
    ).toBe(true);
  });

  it('polls inventory for the canonical uid when the imported row is briefly invisible', async () => {
    // Read-after-write: the ROOT-addressable uid does not exist until the row is
    // inventory-visible, and there is no bare-id fallback. The finalize PATCH has
    // to wait that lag out rather than 403.
    const inventory: Array<{ id: string; name: string }> = [];
    let inventoryReads = 0;
    const visibleAfterReads = 3;
    const sleeps: number[] = [];
    const { client, calls } = makeClient(
      (env) => {
        const path = String(env.path);
        if (env.service === 'collection' && path.startsWith('/v3/collections/?workspace=')) {
          inventoryReads += 1;
          // Hide the just-imported row from the first reads only.
          if (inventoryReads < visibleAfterReads) return jsonResponse({ data: [] });
          return jsonResponse({ data: inventory });
        }
        return aclEnforcingHandler({ inventory })(env);
      },
      { sleep: async (delayMs: number) => { sleeps.push(delayMs); } }
    );

    const result = await client.importV2Collection('ws-1', v21Collection, 'Payments');

    expect(result.collectionId).toBe(FULL);
    // The rename landed on the resolved full uid once the row appeared.
    expect(inventory.some((entry) => entry.id === FULL && entry.name === 'Payments')).toBe(true);
    const patch = calls.find((call) => call.service === 'collection' && call.method === 'patch');
    expect(patch?.path).toBe(`/v3/collections/${FULL}`);
    // The lag was slept through on the client's existing sleep seam.
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it('keeps polling when inventory first exposes only the bare identity', async () => {
    let imported = false;
    let inventoryReadsAfterImport = 0;
    let currentName = 'Payments [bootstrap:test-run]';
    const { client, calls } = makeClient((env) => {
      const path = String(env.path);
      if (env.service === 'sync' && env.method === 'post' && path === '/collection/import') {
        imported = true;
        return jsonResponse({ model_id: UUID, data: { info: { _postman_id: UUID } } });
      }
      if (env.service === 'collection' && path.startsWith('/v3/collections/?workspace=')) {
        if (!imported) return jsonResponse({ data: [] });
        inventoryReadsAfterImport += 1;
        return jsonResponse({
          data: [
            {
              id: inventoryReadsAfterImport < 3 ? UUID : FULL,
              name: currentName
            }
          ]
        });
      }
      const segment = rootSegment(path);
      if (env.service === 'collection' && env.method === 'patch' && segment !== undefined) {
        if (!FULL_PUBLIC_UID_RE.test(segment)) return forbidden(segment);
        currentName = 'Payments';
        return jsonResponse({ data: { id: FULL } });
      }
      return jsonResponse({ error: `unexpected ${env.method} ${env.path}` }, { status: 500 });
    });

    await expect(client.importV2Collection('ws-1', v21Collection, 'Payments')).resolves.toMatchObject({
      collectionId: FULL,
      journaledRootIds: [FULL]
    });
    expect(inventoryReadsAfterImport).toBeGreaterThanOrEqual(3);
    expect(
      calls.filter((call) => call.service === 'collection' && call.method === 'patch')
    ).toEqual([expect.objectContaining({ path: `/v3/collections/${FULL}` })]);
  });

  it('fails closed when inventory never promotes a bare identity to a ROOT-addressable uid', async () => {
    let imported = false;
    let deleted = false;
    const { client, calls } = makeClient((env) => {
      const path = String(env.path);
      if (env.service === 'sync' && env.method === 'post' && path === '/collection/import') {
        imported = true;
        return jsonResponse({ model_id: UUID, data: { info: { _postman_id: UUID } } });
      }
      if (env.service === 'collection' && path.startsWith('/v3/collections/?workspace=')) {
        return jsonResponse({
          data: imported && !deleted ? [{ id: UUID, name: 'Payments' }] : []
        });
      }
      const segment = rootSegment(path);
      if (env.service === 'collection' && env.method === 'delete' && segment === UUID) {
        deleted = true;
        return jsonResponse({ data: { id: UUID } });
      }
      if (env.service === 'collection' && segment !== undefined) {
        return forbidden(segment);
      }
      return jsonResponse({ error: `unexpected ${env.method} ${env.path}` }, { status: 500 });
    });

    await expect(client.importV2Collection('ws-1', v21Collection, 'Payments')).rejects.toThrow(
      /COLLECTION_ROOT_UID_RESOLUTION_FAILED/
    );
    expect(
      calls.filter((call) => {
        if (call.service !== 'collection') return false;
        if (call.method !== 'patch' && call.method !== 'get') return false;
        return rootSegment(String(call.path)) !== undefined;
      })
    ).toEqual([]);
    expect(deleted).toBe(true);
  });

  it('never sends the bare id to the finalize PATCH when the uid stays unresolvable', async () => {
    // Inventory never reports the imported identity. Sending the bare id here is
    // a guaranteed 403, so no ROOT PATCH may be attempted at all; the run fails
    // closed on election without deleting or adopting a foreign collection.
    const { client, calls } = makeClient((env) => {
      const path = String(env.path);
      if (env.service === 'sync' && env.method === 'post' && path === '/collection/import') {
        return jsonResponse({ model_id: UUID, data: { info: { _postman_id: UUID } } });
      }
      if (env.service === 'collection' && path.startsWith('/v3/collections/?workspace=')) {
        return jsonResponse({ data: [] });
      }
      const segment = rootSegment(path);
      if (env.service === 'collection' && segment !== undefined) {
        if (env.method === 'delete') return jsonResponse({ data: { id: segment } });
        if (!FULL_PUBLIC_UID_RE.test(segment)) return forbidden(segment);
        return jsonResponse({ error: 'missing' }, { status: 404 });
      }
      return jsonResponse({ data: { ok: true } });
    });

    await expect(client.importV2Collection('ws-1', v21Collection, 'Payments')).rejects.toThrow(
      /COLLECTION_ROOT_UID_RESOLUTION_FAILED/
    );
    // No ROOT PATCH at all — not even one doomed bare-id attempt.
    expect(
      calls.filter((call) => call.service === 'collection' && call.method === 'patch')
    ).toHaveLength(0);
    expect(
      calls.filter(
        (call) =>
          call.service === 'collection' &&
          call.method === 'get' &&
          rootSegment(String(call.path)) !== undefined
      )
    ).toHaveLength(0);
    // Only this run's own journaled root is ever deleted.
    const deletes = calls.filter(
      (call) => call.service === 'collection' && call.method === 'delete'
    );
    for (const call of deletes) {
      expect(rootSegment(String(call.path))).toBe(UUID);
    }
  });

  it('fails closed when inventory exposes only the matching bare id', async () => {
    const { client, calls } = makeClient((env) => {
      const path = String(env.path);
      if (env.service === 'sync' && env.method === 'post' && path === '/collection/import') {
        return jsonResponse({ model_id: UUID, data: { info: { _postman_id: UUID } } });
      }
      if (env.service === 'collection' && path.startsWith('/v3/collections/?workspace=')) {
        return jsonResponse({ data: [{ id: UUID, name: 'Payments' }] });
      }
      if (env.service === 'collection' && env.method === 'delete') {
        return jsonResponse({ data: { id: UUID } });
      }
      return jsonResponse({ data: { ok: true } });
    });

    await expect(client.importV2Collection('ws-1', v21Collection, 'Payments')).rejects.toThrow(
      /LOCAL_OPENAPI_IMPORT_FAILED/
    );
    expect(
      calls.filter((call) => call.service === 'collection' && call.method === 'patch')
    ).toEqual([]);
    expect(
      calls.filter((call) => call.service === 'collection' && call.method === 'patch').map((call) => call.path)
    ).not.toContain(`/v3/collections/${UUID}`);
  });

  it('uses normalized inventory only when verifying absence of a bare journal id', async () => {
    const { client, calls } = makeClient((env) => {
      if (env.service === 'collection' && env.method === 'delete') {
        return jsonResponse({ data: { id: UUID } });
      }
      if (env.service === 'collection' && String(env.path).startsWith('/v3/collections/?workspace=')) {
        return jsonResponse({ data: [] });
      }
      return jsonResponse({ data: { ok: true } });
    });

    await expect(client.deleteVerifiedRunOwnedCollections('ws-1', [UUID])).resolves.toBeUndefined();
    expect(
      calls.filter(
        (call) =>
          call.service === 'collection' &&
          call.method === 'get' &&
          rootSegment(String(call.path)) === UUID
      )
    ).toEqual([]);
    expect(
      calls
        .filter((call) => call.service === 'collection' && call.method === 'delete')
        .map((call) => call.path)
    ).toEqual([`/v3/collections/${UUID}`]);
  });

  it('deletes and verifies the inventory-invisible run-owned root before same-marker peer adoption', async () => {
    const peerUid = `999-${'aaaaaaaa-1111-4222-8333-444455556666'}`;
    const description = renderAssetMarker({
      repo: 'acme/api',
      rawBranch: 'feature/payments',
      sanitizedBranch: 'feature-payments',
      headRepoId: '42',
      role: 'preview',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastSyncedAt: '2026-01-01T00:00:00.000Z'
    });
    let renamed = false;
    const { client, calls } = makeClient((env) => {
      const path = String(env.path);
      if (env.service === 'collection' && path.startsWith('/v3/collections/?workspace=')) {
        return jsonResponse({
          data: renamed ? [{ id: peerUid, name: 'Payments', description }] : [{ id: UUID, name: 'temp' }]
        });
      }
      if (env.service === 'collection' && /\/export$/.test(path)) {
        return jsonResponse({ data: { collection: { info: { description }, item: [] } } });
      }
      if (env.service === 'collection' && env.method === 'delete') {
        return jsonResponse({ data: { id: path.split('/').pop() } });
      }
      return jsonResponse({ data: { ok: true } });
    });
    const privateClient = client as unknown as {
      renameImportedCollectionCanonical: (workspaceId: string, id: string, finalName: string) => Promise<void>;
      electImportedCollectionIdentity: (
        workspaceId: string,
        finalName: string,
        preferredId: string,
        staleFinalIdentities: ReadonlySet<string>,
        desiredDescription: string
      ) => Promise<string>;
    };

    await privateClient.renameImportedCollectionCanonical('ws-1', UUID, 'Payments');
    renamed = true;
    await expect(
      privateClient.electImportedCollectionIdentity('ws-1', 'Payments', UUID, new Set(), description)
    ).resolves.toBe(peerUid);

    expect(
      calls.filter((call) => call.service === 'collection' && call.method === 'patch')
    ).toEqual([]);
    expect(
      calls.filter((call) => call.service === 'collection' && call.method === 'delete').map((call) => call.path)
    ).toEqual([`/v3/collections/${UUID}`]);
    expect(calls.map((call) => `${call.method} ${call.path}`)).not.toContain(`delete /v3/collections/${peerUid}`);
  });

  it('keeps the bare model id on the sync deep-update route and its _postman_id', async () => {
    const calls: Envelope[] = [];
    const { client } = makeClient((env) => {
      calls.push(env);
      if (env.service === 'sync' && env.method === 'put') {
        return jsonResponse({ data: { id: UUID } });
      }
      return jsonResponse({ data: { ok: true } });
    });

    const { computePayloadDigest } = await import(
      '../src/lib/spec/local-openapi-collection-generation.js'
    );
    const prepared = structuredClone(v21Collection) as Record<string, unknown>;
    (prepared.info as Record<string, unknown>)._postman_id = UUID;

    await client.deepUpdateV2Collection(FULL, v21Collection, computePayloadDigest(prepared));

    const put = calls.find((call) => call.service === 'sync' && call.method === 'put');
    expect(put?.path).toBe(`/collection/deepupdate/${UUID}`);
    expect((put?.body as { info?: { _postman_id?: string } })?.info?._postman_id).toBe(UUID);
  });
});

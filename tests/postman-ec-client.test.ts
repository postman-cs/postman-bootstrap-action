import { describe, expect, it, vi } from 'vitest';

import { PostmanExtensibleCollectionClient } from '../src/lib/postman/postman-ec-client.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
}

const GATEWAY = 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy';

describe('PostmanExtensibleCollectionClient', () => {
  it('throws when constructed without an access token', () => {
    expect(() => new PostmanExtensibleCollectionClient({ accessToken: '' })).toThrow(
      /EC_REQUIRES_ACCESS_TOKEN/
    );
  });

  it('creates an extensible collection through the gateway EC proxy', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'ec-123', createdAt: 'now' } }));

    const client = new PostmanExtensibleCollectionClient({
      accessToken: 'token-abc',
      fetchImpl,
      appVersionProvider: { resolve: async () => '12.21.1' }
    });

    const id = await client.createExtensibleCollection('ws-1', { name: 'Telecom Contract' });

    expect(id).toBe('ec-123');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      GATEWAY,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'x-access-token': 'token-abc',
          'x-app-version': '12.21.1'
        }),
        body: JSON.stringify({
          service: 'collection',
          method: 'post',
          path: '/collections/',
          body: {
            workspace: 'ws-1',
            title: 'Telecom Contract',
            payload: {},
            extensions: { documentation: { content: '' } }
          }
        })
      })
    );
  });

  it('threads the description into extensions.documentation.content', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'ec-9' } }));
    const client = new PostmanExtensibleCollectionClient({ accessToken: 'tok', fetchImpl });

    await client.createExtensibleCollection('ws-1', {
      name: 'Telecom Contract',
      description: 'Generated gRPC contract'
    });

    const sent = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(sent.body.extensions).toEqual({
      documentation: { content: 'Generated gRPC contract' }
    });
  });

  it('adds the org-mode team header only when orgMode is set', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'ec-1' } }));
    const client = new PostmanExtensibleCollectionClient({
      accessToken: 'tok',
      teamId: '999',
      orgMode: true,
      fetchImpl
    });

    await client.createExtensibleCollection('ws-1', { name: 'n' });

    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ 'x-entity-team-id': '999' })
    });
  });

  it('omits the org-mode header in non-org mode', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'ec-1' } }));
    const client = new PostmanExtensibleCollectionClient({
      accessToken: 'tok',
      teamId: '999',
      orgMode: false,
      fetchImpl
    });

    await client.createExtensibleCollection('ws-1', { name: 'n' });

    const headers = (fetchImpl.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-entity-team-id']).toBeUndefined();
  });

  it('creates an item under a parent and threads position.parent', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'item-1' } }));
    const client = new PostmanExtensibleCollectionClient({ accessToken: 'tok', fetchImpl });

    const id = await client.createItem('ec-1', { type: 'grpc-request', title: 'Foo' }, 'folder-1');

    expect(id).toBe('item-1');
    expect(fetchImpl).toHaveBeenCalledWith(
      GATEWAY,
      expect.objectContaining({
        body: JSON.stringify({
          service: 'collection',
          method: 'post',
          path: '/collections/ec-1/items/',
          body: {
            type: 'grpc-request',
            title: 'Foo',
            position: { parent: 'folder-1' },
            payload: {},
            extensions: {}
          }
        })
      })
    );
  });

  it('fails an ambiguous EC item create when exact discovery finds zero matches', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('disconnect', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const client = new PostmanExtensibleCollectionClient({ accessToken: 'tok', fetchImpl });

    await expect(
      client.createItem('ec-1', { type: 'folder', title: 'Owned folder' })
    ).rejects.toThrow(/503|disconnect/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('adopts one exact EC item match after an accepted-disconnect response', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('disconnect', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({
        data: [{
          id: 'item-owned',
          type: 'folder',
          title: 'Owned folder',
          position: { parent: 'ec-1' }
        }]
      }));
    const client = new PostmanExtensibleCollectionClient({ accessToken: 'tok', fetchImpl });

    await expect(
      client.createItem('ec-1', { type: 'folder', title: 'Owned folder' })
    ).resolves.toBe('item-owned');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('names duplicate EC item ids when ambiguous discovery finds multiple exact matches', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('disconnect', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({
        data: [
          { id: 'item-a', type: 'folder', title: 'Owned folder', position: { parent: 'ec-1' } },
          { id: 'item-b', type: 'folder', title: 'Owned folder', position: { parent: 'ec-1' } }
        ]
      }));
    const client = new PostmanExtensibleCollectionClient({ accessToken: 'tok', fetchImpl });

    await expect(
      client.createItem('ec-1', { type: 'folder', title: 'Owned folder' })
    ).rejects.toThrow(/item-a.*item-b/);
  });

  it('populateFromTree creates folders then leaf requests with parent linkage', async () => {
    const ids = ['folder-A', 'leaf-1', 'leaf-2'];
    let i = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      jsonResponse({ data: { id: ids[i++] } })
    );
    const client = new PostmanExtensibleCollectionClient({ accessToken: 'tok', fetchImpl });

    const tree = {
      info: { name: 'C' },
      item: [
        {
          type: 'folder',
          name: 'ServiceA',
          item: [
            { type: 'grpc-request', title: 'M1', payload: { methodPath: 'A/M1' } },
            { type: 'grpc-request', title: 'M2', payload: { methodPath: 'A/M2' } }
          ]
        }
      ]
    };

    const leafCount = await client.populateFromTree('ec-1', tree);

    expect(leafCount).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // 1st call: folder, parented at the collection root, item[] stripped
    expect(JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string)).toMatchObject({
      body: { type: 'folder', title: 'ServiceA', position: { parent: 'ec-1' } }
    });
    expect(
      JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string).body.item
    ).toBeUndefined();
    // 2nd + 3rd: leaves parented under created folder id
    expect(JSON.parse((fetchImpl.mock.calls[1]?.[1] as RequestInit).body as string)).toMatchObject({
      body: { type: 'grpc-request', title: 'M1', position: { parent: 'folder-A' } }
    });
    expect(JSON.parse((fetchImpl.mock.calls[2]?.[1] as RequestInit).body as string)).toMatchObject({
      body: { type: 'grpc-request', title: 'M2', position: { parent: 'folder-A' } }
    });
  });

  it('populateFromTree consumes a runtime.models transform tree (children nesting, strips id/children)', async () => {
    const ids = ['folder-A', 'leaf-1'];
    let i = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      jsonResponse({ data: { id: ids[i++] } })
    );
    const client = new PostmanExtensibleCollectionClient({ accessToken: 'tok', fetchImpl });

    // Canonical Extensible tree: children nesting, logical ids, events already
    // under extensions.events (the @postman/runtime.models transform shape).
    const tree = {
      type: 'collection',
      title: 'C',
      children: [
        {
          type: 'folder',
          id: 'folder.logical',
          title: 'ServiceA',
          children: [
            {
              type: 'http-request',
              id: 'req.logical',
              title: 'GET ping',
              payload: { url: '{{baseUrl}}/ping', method: 'GET' },
              extensions: { events: [{ listen: 'afterResponse', script: { exec: 'pm.test();' } }] }
            }
          ]
        }
      ]
    };

    const leafCount = await client.populateFromTree('ec-1', tree);

    expect(leafCount).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const folderBody = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string).body;
    expect(folderBody).toMatchObject({ type: 'folder', title: 'ServiceA', position: { parent: 'ec-1' } });
    // Logical id + children nesting stripped from the create body.
    expect(folderBody.id).toBeUndefined();
    expect(folderBody.children).toBeUndefined();
    const leafBody = JSON.parse((fetchImpl.mock.calls[1]?.[1] as RequestInit).body as string).body;
    expect(leafBody).toMatchObject({
      type: 'http-request',
      title: 'GET ping',
      position: { parent: 'folder-A' }
    });
    expect(leafBody.id).toBeUndefined();
    // Pre-set extensions.events pass through (createItem normalizes, exec stays string).
    expect(leafBody.extensions.events).toEqual([
      { listen: 'afterResponse', script: { exec: 'pm.test();' } }
    ]);
  });

  it('reads back and deletes a collection via the EC proxy', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'ec-1', name: 'C', items: [] } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new PostmanExtensibleCollectionClient({ accessToken: 'tok', fetchImpl });

    const fetched = await client.getExtensibleCollection('ec-1');
    expect(fetched).toMatchObject({ id: 'ec-1' });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      GATEWAY,
      expect.objectContaining({
        body: JSON.stringify({ service: 'collection', method: 'get', path: '/collections/ec-1' })
      })
    );

    await client.deleteExtensibleCollection('ec-1');
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      GATEWAY,
      expect.objectContaining({
        body: JSON.stringify({ service: 'collection', method: 'delete', path: '/collections/ec-1', body: {} })
      })
    );
  });

  it('raises an HttpError with the access token redacted on failure', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('forbidden secret-tok', { status: 403 }));
    const client = new PostmanExtensibleCollectionClient({ accessToken: 'secret-tok', fetchImpl });

    let captured: unknown;
    try {
      await client.createExtensibleCollection('ws-1', { name: 'n' });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    const message = captured instanceof Error ? captured.message : String(captured);
    expect(message).toContain('403');
    expect(message).not.toContain('secret-tok');
  });

  it('reports EC v3 schema drift before create via the validationReporter (no throw)', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'item-drift' } }));
    const reported: string[] = [];
    const client = new PostmanExtensibleCollectionClient({
      accessToken: 'tok',
      fetchImpl,
      validationReporter: (m) => reported.push(m)
    });

    // `extensions.schema:{source:'file'}` without a `location` string is the
    // exact drift the gRPC builder used to emit; the official EC v3 GRPCRequest
    // schema requires `location`. The create still proceeds (gateway is the
    // authority); the drift is surfaced, not thrown.
    await client.createItem('ec-1', {
      type: 'grpc-request',
      title: 'Drift',
      payload: { url: 'grpc://h:443', methodPath: 'a/B', message: { content: '{}' }, metadata: [], settings: {} },
      extensions: { schema: { source: 'file' } }
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(reported.some((m) => m.includes('EC_ITEM_SCHEMA_DRIFT') && m.includes('location'))).toBe(true);
  });

  it('maps a v2.1.0 item.event test script into extensions.events (afterResponse)', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'item-1' } }));
    const client = new PostmanExtensibleCollectionClient({ accessToken: 'tok', fetchImpl });

    await client.createItem('ec-1', {
      type: 'grpc-request',
      title: 'M1',
      extensions: { schema: { source: 'file' } },
      event: [
        { listen: 'test', script: { type: 'text/javascript', exec: ['pm.test("ok", () => {});'] } }
      ]
    });

    const sent = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    // EC v3 enforces script.exec as a single string; the v2.1.0 array is joined.
    expect(sent.body.extensions).toEqual({
      schema: { source: 'file' },
      events: [
        { listen: 'afterResponse', script: { type: 'text/javascript', exec: 'pm.test("ok", () => {});' } }
      ]
    });
  });

  it('joins a multi-line v2.1.0 script.exec array into a single EC v3 string', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'item-multiline' } }));
    const client = new PostmanExtensibleCollectionClient({ accessToken: 'tok', fetchImpl });

    await client.createItem('ec-1', {
      type: 'grpc-request',
      title: 'M3',
      event: [
        { listen: 'test', script: { exec: ['line1', 'line2', 'line3'] } }
      ]
    });

    const sent = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(sent.body.extensions.events).toEqual([
      { listen: 'afterResponse', script: { exec: 'line1\nline2\nline3' } }
    ]);
  });

  it('maps prerequest -> beforeRequest and preserves existing extensions.events', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'item-2' } }));
    const client = new PostmanExtensibleCollectionClient({ accessToken: 'tok', fetchImpl });

    await client.createItem('ec-1', {
      type: 'grpc-request',
      title: 'M2',
      extensions: { events: [{ listen: 'afterResponse', script: { exec: ['existing'] } }] },
      event: [{ listen: 'prerequest', script: { exec: ['pre'] } }]
    });

    const sent = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    // Both pre-existing and newly-mapped events are normalized to the EC v3
    // single-string exec shape.
    expect(sent.body.extensions.events).toEqual([
      { listen: 'afterResponse', script: { exec: 'existing' } },
      { listen: 'beforeRequest', script: { exec: 'pre' } }
    ]);
  });

  it('lists extensible collection items via the flat getItemList endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: 'a', type: 'grpc-request', extensions: { events: [{ listen: 'afterResponse' }] } },
          { id: 'b', type: 'grpc-request' }
        ]
      })
    );
    const client = new PostmanExtensibleCollectionClient({ accessToken: 'tok', fetchImpl });

    const items = await client.listExtensibleCollectionItems('ec-1');

    expect(items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(fetchImpl).toHaveBeenCalledWith(
      GATEWAY,
      expect.objectContaining({
        body: JSON.stringify({
          service: 'collection',
          method: 'get',
          path: '/collections/ec-1/items/'
        })
      })
    );
  });

  it('tolerates the {data:{items:[...]}} list envelope shape', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { items: [{ id: 'x', type: 'folder' }] } }));
    const client = new PostmanExtensibleCollectionClient({ accessToken: 'tok', fetchImpl });

    const items = await client.listExtensibleCollectionItems('ec-1');
    expect(items).toEqual([{ id: 'x', type: 'folder' }]);
  });

  it('fetches a single item with extensions.events via the per-item GET endpoint', async () => {
    const item = {
      id: 'item-1',
      type: 'http-request',
      title: 'GET ping',
      extensions: { events: [{ listen: 'afterResponse', script: { exec: 'pm.test();' } }] }
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ data: item }));
    const client = new PostmanExtensibleCollectionClient({ accessToken: 'tok', fetchImpl });

    const result = await client.getExtensibleCollectionItem('ec-1', 'item-1');

    expect(result).toEqual(item);
    expect(fetchImpl).toHaveBeenCalledWith(
      GATEWAY,
      expect.objectContaining({
        body: JSON.stringify({
          service: 'collection',
          method: 'get',
          path: '/collections/ec-1/items/item-1'
        })
      })
    );
  });

  it('getExtensibleCollectionItem tolerates a bare (unwrapped) item body', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 'item-2', type: 'folder' }));
    const client = new PostmanExtensibleCollectionClient({ accessToken: 'tok', fetchImpl });

    const result = await client.getExtensibleCollectionItem('ec-1', 'item-2');
    expect(result).toEqual({ id: 'item-2', type: 'folder' });
  });

  it('getExtensibleCollectionItem throws on missing collectionId or itemId', async () => {
    const client = new PostmanExtensibleCollectionClient({ accessToken: 'tok', fetchImpl: vi.fn() });
    await expect(client.getExtensibleCollectionItem('', 'item-1')).rejects.toThrow(/EC_ITEM_GET_INVALID_ARGUMENT/);
    await expect(client.getExtensibleCollectionItem('ec-1', '')).rejects.toThrow(/EC_ITEM_GET_INVALID_ARGUMENT/);
  });

  it('surfaces an inner /ws/proxy envelope error on an HTTP 200 response', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ error: { name: 'collectionServiceError', message: 'boom secret-tok' }, status: 422 })
      );
    const client = new PostmanExtensibleCollectionClient({ accessToken: 'secret-tok', fetchImpl });

    let captured: unknown;
    try {
      await client.createExtensibleCollection('ws-1', { name: 'n' });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    const message = captured instanceof Error ? captured.message : String(captured);
    expect(message).toContain('422');
    expect(message).toContain('[inner]');
    expect(message).not.toContain('secret-tok');
  });

  it('does not blind-retry an unsafe EC create POST on transient 5xx', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('upstream down', { status: 503 }));
    const client = new PostmanExtensibleCollectionClient({
      accessToken: 'tok',
      fetchImpl
    });

    await expect(client.createExtensibleCollection('ws-1', { name: 'n' })).rejects.toThrow(/503/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a transient 5xx EC read and then succeeds', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('upstream down', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'ec-ok', title: 'n' } }));
    const client = new PostmanExtensibleCollectionClient({
      accessToken: 'tok',
      fetchImpl
    });

    const collection = await client.getExtensibleCollection('ec-ok');
    expect(collection).toMatchObject({ id: 'ec-ok' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent 4xx EC write', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('bad request', { status: 400 }));
    const client = new PostmanExtensibleCollectionClient({ accessToken: 'tok', fetchImpl });

    await expect(client.createExtensibleCollection('ws-1', { name: 'n' })).rejects.toThrow(/400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('populateFromTree throws on a *-request node carrying child items', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: { id: 'x' } }));
    const client = new PostmanExtensibleCollectionClient({ accessToken: 'tok', fetchImpl });

    const tree = {
      item: [
        {
          type: 'grpc-request',
          title: 'BadLeaf',
          item: [{ type: 'grpc-request', title: 'Nested' }]
        }
      ]
    };

    await expect(client.populateFromTree('ec-1', tree)).rejects.toThrow(/EC_TREE_INVALID/);
  });

  it('populateFromTree creates an empty-tree collection without items', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new PostmanExtensibleCollectionClient({ accessToken: 'tok', fetchImpl });

    const leafCount = await client.populateFromTree('ec-1', { item: [] });
    expect(leafCount).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('configureTeamContext re-scopes the org-mode x-entity-team-id header', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'ec-1' } }));
    const client = new PostmanExtensibleCollectionClient({ accessToken: 'tok', fetchImpl });

    client.configureTeamContext('132319', true);
    await client.createExtensibleCollection('ws-1', { name: 'n' });

    const headers = (fetchImpl.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-entity-team-id']).toBe('132319');
  });
});

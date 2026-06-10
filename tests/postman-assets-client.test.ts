import { afterEach, describe, expect, it, vi } from 'vitest';

import { PostmanAssetsClient } from '../src/lib/postman/postman-assets-client.js';
import { instrumentContractCollection } from '../src/lib/spec/collection-contracts.js';
import { buildContractIndex } from '../src/lib/spec/contract-index.js';
import { parseOpenApiDocument } from '../src/lib/spec/openapi-loader.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json'
    },
    ...init
  });
}

describe('PostmanAssetsClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the public Postman API base URL by default', () => {
    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test'
    });

    expect(client.getBaseUrl()).toBe('https://api.getpostman.com');
  });

  it('honors custom baseUrl and bifrostBaseUrl for beta stacks', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ repo: 'https://github.com/example/repo' })
    );
    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      baseUrl: 'https://api.getpostman-beta.com/',
      bifrostBaseUrl: 'https://bifrost-https-v4.gw.postman-beta.com/',
      fetchImpl
    });

    expect(client.getBaseUrl()).toBe('https://api.getpostman-beta.com');
    expect(client.getBifrostBaseUrl()).toBe('https://bifrost-https-v4.gw.postman-beta.com');

    await client.getWorkspaceGitRepoUrl('ws-1', 'team-1', 'access-token');

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://bifrost-https-v4.gw.postman-beta.com/ws/proxy',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('lists workspaces across cursor-paginated responses', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        workspaces: [{ id: 'ws-1', name: 'Payments', type: 'team' }],
        meta: { nextCursor: 'cursor-2' }
      }))
      .mockResolvedValueOnce(jsonResponse({
        workspaces: [{ id: 'ws-2', name: 'Orders', type: 'team' }]
      }));
    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await expect(client.listWorkspaces()).resolves.toEqual([
      { id: 'ws-1', name: 'Payments', type: 'team' },
      { id: 'ws-2', name: 'Orders', type: 'team' }
    ]);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.getpostman.com/workspaces?cursor=cursor-2',
      expect.any(Object)
    );
  });

  it('stops workspace pagination on repeated cursors', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        workspaces: [{ id: 'ws-1', name: 'Payments' }],
        meta: { nextCursor: 'cursor-1' }
      }))
      .mockResolvedValueOnce(jsonResponse({
        workspaces: [{ id: 'ws-1', name: 'Payments' }],
        meta: { nextCursor: 'cursor-1' }
      }));
    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await expect(client.listWorkspaces()).resolves.toEqual([
      { id: 'ws-1', name: 'Payments', type: 'team' },
      { id: 'ws-1', name: 'Payments', type: 'team' }
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('masks Bifrost workspace lookup failures with HttpError handling', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('access-token leaked', { status: 500, statusText: 'Server Error' })
    );
    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    let thrown: unknown;
    try {
      await client.getWorkspaceGitRepoUrl('ws-1', 'team-1', 'access-token');
    } catch (error) {
      thrown = error;
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain('500 Server Error');
    expect(message).not.toContain('access-token leaked');
  });

  it('creates a workspace and enforces team visibility', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          workspace: {
            id: 'ws-123'
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          workspace: {
            id: 'ws-123',
            visibility: 'private'
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          workspace: {
            id: 'ws-123',
            visibility: 'team'
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          workspace: {
            id: 'ws-123',
            visibility: 'team'
          }
        })
      );

    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await expect(client.createWorkspace('Core Banking', 'desc')).resolves.toEqual({
      id: 'ws-123'
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      'https://api.getpostman.com/workspaces/ws-123',
      expect.objectContaining({
        method: 'PUT'
      })
    );
  });

  it('deletes the workspace and fails when team visibility cannot be enforced', async () => {
    const personal = () =>
      jsonResponse({
        workspace: {
          id: 'ws-456',
          visibility: 'personal'
        }
      });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ workspace: { id: 'ws-456' } }))
      .mockResolvedValueOnce(personal())
      .mockResolvedValueOnce(personal())
      .mockResolvedValueOnce(personal())
      .mockResolvedValueOnce(jsonResponse({ workspace: { id: 'ws-456' } }));

    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await expect(client.createWorkspace('Org WS', 'desc')).rejects.toThrow(
      /visibility 'personal'.*workspace-team-id.*has been deleted/s
    );
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      5,
      'https://api.getpostman.com/workspaces/ws-456',
      expect.objectContaining({
        method: 'DELETE'
      })
    );
  });

  it('reports manual cleanup when the failed workspace cannot be deleted', async () => {
    const personal = () =>
      jsonResponse({
        workspace: {
          id: 'ws-456',
          visibility: 'personal'
        }
      });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ workspace: { id: 'ws-456' } }))
      .mockResolvedValueOnce(personal())
      .mockResolvedValueOnce(personal())
      .mockResolvedValueOnce(personal())
      .mockResolvedValueOnce(new Response('nope', { status: 500 }));

    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await expect(client.createWorkspace('Org WS', 'desc')).rejects.toThrow(
      /delete workspace ws-456 manually/
    );
  });

  it('reads workspace visibility and degrades to null on errors', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ workspace: { id: 'ws-1', visibility: 'personal' } })
      )
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }));

    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await expect(client.getWorkspaceVisibility('ws-1')).resolves.toBe('personal');
    await expect(client.getWorkspaceVisibility('ws-2')).resolves.toBeNull();
  });

  it('normalizes collection tags to valid Postman slugs', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 204
      })
    );
    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await client.tagCollection('col-123', ['Generated Smoke', 'core banking']);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.getpostman.com/collections/col-123/tags',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          tags: [{ slug: 'generated-smoke' }, { slug: 'core-banking' }]
        })
      })
    );
  });

  it('returns existing spec content when available', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ content: 'openapi: 3.1.0' })
    );
    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await expect(client.getSpecContent('spec-123')).resolves.toBe('openapi: 3.1.0');
  });

  it('returns undefined when fetching existing spec content fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('not found', { status: 404 })
    );
    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await expect(client.getSpecContent('spec-123')).resolves.toBeUndefined();
  });

  it('deletes collections successfully', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 204 })
    );
    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await expect(client.deleteCollection('col-123')).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.getpostman.com/collections/col-123',
      expect.objectContaining({
        method: 'DELETE'
      })
    );
  });

  it('treats collection delete 404 as success', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('not found', { status: 404 })
    );
    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await expect(client.deleteCollection('col-missing')).resolves.toBeUndefined();
  });

  it('creates a workspace with targetTeamId in the payload for org-mode', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          workspace: {
            id: 'ws-org-123'
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          workspace: {
            id: 'ws-org-123',
            visibility: 'team'
          }
        })
      );

    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await expect(client.createWorkspace('Org WS', 'desc', 132319)).resolves.toEqual({
      id: 'ws-org-123'
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://api.getpostman.com/workspaces',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          workspace: {
            about: 'desc',
            name: 'Org WS',
            type: 'team',
            teamId: 132319
          }
        })
      })
    );
  });

  it('creates a workspace without teamId when targetTeamId is not provided', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          workspace: { id: 'ws-no-team' }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          workspace: { id: 'ws-no-team', visibility: 'team' }
        })
      );

    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await expect(client.createWorkspace('Regular WS', 'desc')).resolves.toEqual({
      id: 'ws-no-team'
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://api.getpostman.com/workspaces',
      expect.objectContaining({
        body: JSON.stringify({
          workspace: {
            about: 'desc',
            name: 'Regular WS',
            type: 'team'
          }
        })
      })
    );
  });

  it('throws actionable error for org-mode workspace creation failure', async () => {
    const errorBody = JSON.stringify({
      error: {
        name: 'invalidParamError',
        message: 'Only personal workspaces (internal) can be created outside team'
      }
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () => new Response(errorBody, { status: 400 })
    );

    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await expect(client.createWorkspace('Org WS', 'desc')).rejects.toThrow(
      'workspace-team-id'
    );
  });

  it('returns parsed sub-teams from getTeams', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: 132109, name: 'Field Services', handle: 'fs', organizationId: 13347347 },
          { id: 132118, name: 'Customer Education', handle: 'ce', organizationId: 13347347 },
          { id: 132272, name: 'RonCorp', handle: 'rc', organizationId: 13347347 }
        ]
      })
    );

    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    const teams = await client.getTeams();
    expect(teams).toEqual([
      { id: 132109, name: 'Field Services', handle: 'fs', organizationId: 13347347 },
      { id: 132118, name: 'Customer Education', handle: 'ce', organizationId: 13347347 },
      { id: 132272, name: 'RonCorp', handle: 'rc', organizationId: 13347347 }
    ]);
  });

  it('returns empty array from getTeams when no teams exist', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({ data: [] })
    );

    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await expect(client.getTeams()).resolves.toEqual([]);
  });

  it('propagates errors from getTeams without swallowing', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response('Forbidden', { status: 403 })
    );

    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await expect(client.getTeams()).rejects.toThrow();
  });

  it('uploads a 3.0 spec with type OPENAPI:3.0', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 'spec-30' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'spec-30' }));

    const client = new PostmanAssetsClient({ apiKey: 'pmak-test', fetchImpl });
    const specId = await client.uploadSpec('ws-1', 'my-api', 'openapi: 3.0.3', '3.0');

    expect(specId).toBe('spec-30');
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://api.getpostman.com/specs?workspaceId=ws-1',
      expect.objectContaining({
        body: JSON.stringify({
          name: 'my-api',
          type: 'OPENAPI:3.0',
          files: [{ path: 'index.yaml', content: 'openapi: 3.0.3' }]
        })
      })
    );
  });

  it('uploads a 3.1 spec with type OPENAPI:3.1', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 'spec-31' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'spec-31' }));

    const client = new PostmanAssetsClient({ apiKey: 'pmak-test', fetchImpl });
    const specId = await client.uploadSpec('ws-1', 'my-api', 'openapi: 3.1.0', '3.1');

    expect(specId).toBe('spec-31');
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://api.getpostman.com/specs?workspaceId=ws-1',
      expect.objectContaining({
        body: JSON.stringify({
          name: 'my-api',
          type: 'OPENAPI:3.1',
          files: [{ path: 'index.yaml', content: 'openapi: 3.1.0' }]
        })
      })
    );
  });

  it('throws for an unrecognised openapiVersion rather than silently defaulting', async () => {
    const client = new PostmanAssetsClient({ apiKey: 'pmak-test' });
    await expect(
      client.uploadSpec('ws-1', 'my-api', 'openapi: 3.1.0', '3.2' as '3.1')
    ).rejects.toThrow(/unsupported openapiVersion/);
  });

  it('defaults to OPENAPI:3.0 type when no version is supplied', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 'spec-default' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'spec-default' }));

    const client = new PostmanAssetsClient({ apiKey: 'pmak-test', fetchImpl });
    await client.uploadSpec('ws-1', 'my-api', 'openapi: 3.0.3');

    const body = JSON.parse(
      (fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string
    ) as { type: string };
    expect(body.type).toBe('OPENAPI:3.0');
  });

  it('generateCollection sends folderStrategy and requestNameSource, omits nestedFolderHierarchy when strategy is Paths', async () => {
    const collectionUid = 'col-paths-123';
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ collection: { uid: collectionUid } })
    );

    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await client.generateCollection('spec-123', 'payments', '[Baseline]', 'Paths', true, 'Fallback');

    const [, callOptions] = fetchImpl.mock.calls[0];
    const body = JSON.parse((callOptions as RequestInit).body as string);
    expect(body.options.folderStrategy).toBe('Paths');
    expect(body.options.requestNameSource).toBe('Fallback');
    expect(body.options).not.toHaveProperty('nestedFolderHierarchy');
  });

  it('generateCollection includes nestedFolderHierarchy when folderStrategy is Tags', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ collection: { uid: 'col-tags-123' } })
    );

    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await client.generateCollection('spec-123', 'payments', '[Baseline]', 'Tags', true, 'URL');

    const [, callOptions] = fetchImpl.mock.calls[0];
    const body = JSON.parse((callOptions as RequestInit).body as string);
    expect(body.options.folderStrategy).toBe('Tags');
    expect(body.options.nestedFolderHierarchy).toBe(true);
    expect(body.options.requestNameSource).toBe('URL');
  });

  it('generateCollection includes nestedFolderHierarchy: false when Tags and hierarchy disabled', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ collection: { uid: 'col-tags-flat-123' } })
    );

    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await client.generateCollection('spec-123', 'payments', '[Smoke]', 'Tags', false, 'Fallback');

    const [, callOptions] = fetchImpl.mock.calls[0];
    const body = JSON.parse((callOptions as RequestInit).body as string);
    expect(body.options.folderStrategy).toBe('Tags');
    expect(body.options.nestedFolderHierarchy).toBe(false);
  });

  it('generateCollection retries transient 423 locks before returning the generated collection UID', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('locked', { status: 423, statusText: 'Locked' }))
      .mockResolvedValueOnce(jsonResponse({ collection: { uid: 'col-after-lock' } }));
    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    const result = client.generateCollection('spec-123', 'payments', '[Baseline]', 'Paths', false, 'Fallback');
    await vi.advanceTimersByTimeAsync(5000);

    await expect(result).resolves.toBe('col-after-lock');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('generateCollection polls async task URLs until completion', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ task: { id: 'task-123' } }))
      .mockResolvedValueOnce(jsonResponse({ task: { status: 'running' } }))
      .mockResolvedValueOnce(jsonResponse({ task: { status: 'completed' }, collection: { uid: 'col-task' } }));
    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    const result = client.generateCollection('spec-123', 'payments', '[Smoke]', 'Paths', false, 'Fallback');
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(result).resolves.toBe('col-task');
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.getpostman.com/specs/spec-123/tasks/task-123',
      expect.any(Object)
    );
  });

  it('generateCollection fails task failures without retrying the generation request', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ taskUrl: '/tasks/task-123' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'failed' }));
    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    const result = client.generateCollection('spec-123', 'payments', '[Contract]', 'Paths', false, 'Fallback');
    const rejection = expect(result).rejects.toThrow('Task failed for [Contract]');
    await vi.advanceTimersByTimeAsync(2000);

    await rejection;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('generateCollection does not retry non-lock API errors', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('server exploded', { status: 500, statusText: 'Server Error' }));
    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await expect(
      client.generateCollection('spec-123', 'payments', '[Baseline]', 'Paths', false, 'Fallback')
    ).rejects.toThrow('500 Server Error');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('injects operation-specific OpenAPI contract tests into contract collections', async () => {
    const spec = `openapi: 3.1.0
info:
  title: Pets
  version: 1.0.0
paths:
  /pets/{id}:
    get:
      summary: Get pet
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [id, name]
                properties:
                  id:
                    type: integer
                  name:
                    type: string
`;
    const body = instrumentContractCollection({
      info: { name: '[Contract] Pets' },
      item: [
        {
          name: 'Get pet',
          request: {
            method: 'GET',
            url: { raw: 'https://api.example.test/pets/123' }
          }
        }
      ]
    }, buildContractIndex(parseOpenApiDocument(spec))).collection;
    const item = (body.item as Array<{ event: Array<{ script: { exec: string[] } }> }>)[1]!;
    const exec = item.event[0]!.script.exec.join('\n');
    expect(exec).toContain('/pets/{id}');
    expect(exec).not.toContain('pm.response.to.have.jsonSchema');
    expect(exec).not.toMatch(/\beval\s*\(/);
    expect(exec).not.toContain('new Function');
    expect(exec).toContain('Response body matches OpenAPI schema');
    expect(exec).not.toContain('Required fields are present');
    expect(exec).not.toContain('Response time is acceptable');
  });

  it('injects failing mapping tests for extra unmapped requests while covered operations pass', async () => {
    const spec = `openapi: 3.1.0
info:
  title: Pets
  version: 1.0.0
paths:
  /pets:
    get:
      summary: List pets
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: array
`;
    const body = instrumentContractCollection({
      info: { name: '[Contract] Pets' },
      item: [
        { name: 'List pets', request: { method: 'GET', url: { path: ['pets'] } } },
        { name: 'Health', request: { method: 'GET', url: { path: ['health'] } } }
      ]
    }, buildContractIndex(parseOpenApiDocument(spec))).collection;
    const item = (body.item as Array<{ event: Array<{ script: { exec: string[] } }> }>)[2]!;
    const exec = item.event[0]!.script.exec.join('\n');
    expect(exec).toContain('No OpenAPI operation matched request GET /health');
    expect(exec).toContain('OpenAPI operation mapping exists');
  });

  it('fails contract injection before PUT when generated requests miss spec operations', async () => {
    const spec = `openapi: 3.1.0
info:
  title: Pets
  version: 1.0.0
paths:
  /pets:
    get:
      summary: List pets
      responses:
        '200':
          description: OK
`;
    expect(() =>
      instrumentContractCollection({
        info: { name: '[Contract] Pets' },
        item: [
          { name: 'Health', request: { method: 'GET', url: { path: ['health'] } } }
        ]
      }, buildContractIndex(parseOpenApiDocument(spec)))
    ).toThrow('Contract collection is missing generated request coverage for GET /pets');
  });
});

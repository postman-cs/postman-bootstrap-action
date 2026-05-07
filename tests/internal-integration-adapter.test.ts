import { describe, expect, it, vi } from 'vitest';

import {
  createInternalIntegrationAdapter
} from '../src/lib/postman/internal-integration-adapter.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json'
    },
    ...init
  });
}

describe('internal integration adapter', () => {
  it('routes governance assignment through the internal gateway API', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: 'group-1', name: 'Core Banking' }]
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      fetchImpl
    });

    await adapter.assignWorkspaceToGovernanceGroup(
      'ws-123',
      'core-banking',
      JSON.stringify({ 'core-banking': 'Core Banking' })
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://gateway.postman.com/configure/workspace-groups',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-access-token': 'token-123'
        })
      })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://gateway.postman.com/configure/workspace-groups/group-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ workspaces: ['ws-123'] })
      })
    );
  });

  it('uses the Bifrost proxy for workspace repository linking and rejects unsupported backends', async () => {
    expect(() =>
      createInternalIntegrationAdapter({
        backend: 'custom',
        accessToken: 'token-123',
        teamId: '11430732'
      })
    ).toThrow(/Unsupported integration backend/);

    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          ok: true
        }
      })
    );

    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      orgMode: true,
      fetchImpl
    });

    await adapter.connectWorkspaceToRepository(
      'ws-123',
      'https://github.com/Postman-FDE/example'
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-access-token': 'token-123',
          'x-entity-team-id': '11430732'
        }),
        body: JSON.stringify({
          service: 'workspaces',
          method: 'POST',
          path: '/workspaces/ws-123/filesystem',
          body: {
            path: '/',
            repo: 'https://github.com/Postman-FDE/example',
            versionControl: true
          }
        })
      })
    );
  });

  it('links GitLab repository URLs via the Bifrost proxy', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          ok: true
        }
      })
    );

    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      orgMode: true,
      fetchImpl
    });

    await adapter.connectWorkspaceToRepository(
      'ws-456',
      'https://gitlab.com/org/my-service'
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          service: 'workspaces',
          method: 'POST',
          path: '/workspaces/ws-456/filesystem',
          body: {
            path: '/',
            repo: 'https://gitlab.com/org/my-service',
            versionControl: true
          }
        })
      })
    );
  });

  it('routes specification collection linking through the Bifrost proxy with sync options', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ data: { updated: 1 } })
    );

    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      orgMode: true,
      fetchImpl
    });

    await adapter.linkCollectionsToSpecification('spec-123', [
      {
        collectionId: 'col-1',
        syncOptions: { syncExamples: true }
      }
    ]);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-access-token': 'token-123',
          'x-entity-team-id': '11430732'
        }),
        body: JSON.stringify({
          service: 'specification',
          method: 'put',
          path: '/specifications/spec-123/collections',
          body: [
            {
              collectionId: 'col-1',
              syncOptions: { syncExamples: true }
            }
          ]
        })
      })
    );
  });

  it('routes specification collection sync through the Bifrost proxy', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ data: { taskId: 'task-1' } })
    );

    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      orgMode: true,
      fetchImpl
    });

    await adapter.syncCollection('spec-123', 'col-1');

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          service: 'specification',
          method: 'post',
          path: '/specifications/spec-123/collections/col-1/sync'
        })
      })
    );
  });

  it('treats projectAlreadyConnected as idempotent when the same repo is linked', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      // First call: connectWorkspaceToRepository POST returns 400 projectAlreadyConnected
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { status: 400, name: 'projectAlreadyConnected', message: 'Workspace already has a file system connected.' } },
          { status: 400 }
        )
      )
      // Second call: getWorkspaceGitRepoUrl GET returns the linked repo
      .mockResolvedValueOnce(
        jsonResponse({
          repo: 'https://gitlab.com/org/my-service'
        })
      );

    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      orgMode: true,
      fetchImpl
    });

    // Should not throw because the linked repo matches
    await adapter.connectWorkspaceToRepository(
      'ws-456',
      'https://gitlab.com/org/my-service'
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('honors custom bifrostBaseUrl and gatewayBaseUrl overrides for beta stacks', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: 'group-beta', name: 'Core Banking' }]
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-beta',
      teamId: '99999999',
      orgMode: true,
      bifrostBaseUrl: 'https://bifrost-https-v4.gw.postman-beta.com/',
      gatewayBaseUrl: 'https://gateway.postman-beta.com/',
      fetchImpl
    });

    await adapter.assignWorkspaceToGovernanceGroup(
      'ws-beta',
      'core-banking',
      JSON.stringify({ 'core-banking': 'Core Banking' })
    );

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://gateway.postman-beta.com/configure/workspace-groups',
      expect.any(Object)
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://gateway.postman-beta.com/configure/workspace-groups/group-beta',
      expect.objectContaining({ method: 'PATCH' })
    );

    await adapter.syncCollection('spec-beta', 'col-beta');

    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      'https://bifrost-https-v4.gw.postman-beta.com/ws/proxy',
      expect.any(Object)
    );
  });

  it('throws when projectAlreadyConnected but linked to a different repo', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { status: 400, name: 'projectAlreadyConnected', message: 'Workspace already has a file system connected.' } },
          { status: 400 }
        )
      )
      .mockResolvedValueOnce(
        jsonResponse({
          repo: 'https://gitlab.com/org/different-service'
        })
      );

    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      orgMode: true,
      fetchImpl
    });

    await expect(
      adapter.connectWorkspaceToRepository('ws-456', 'https://gitlab.com/org/my-service')
    ).rejects.toThrow(/linked to a different repo/);
  });

  it('omits x-entity-team-id header when orgMode is false even with teamId set', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ data: { ok: true } })
    );

    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      orgMode: false,
      fetchImpl
    });

    await adapter.connectWorkspaceToRepository(
      'ws-non-org',
      'https://github.com/example/repo'
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy',
      expect.objectContaining({
        method: 'POST',
        headers: expect.not.objectContaining({
          'x-entity-team-id': expect.anything()
        })
      })
    );

    const callHeaders = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(callHeaders['x-entity-team-id']).toBeUndefined();
  });

  it('includes x-entity-team-id header when orgMode is true and teamId is set', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ data: { ok: true } })
    );

    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-org',
      teamId: '99999999',
      orgMode: true,
      fetchImpl
    });

    await adapter.connectWorkspaceToRepository(
      'ws-org',
      'https://github.com/example/org-repo'
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-access-token': 'token-org',
          'x-entity-team-id': '99999999'
        })
      })
    );
  });

  it('omits x-entity-team-id header when teamId is empty regardless of orgMode', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ data: { ok: true } })
    );

    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '',
      orgMode: true,
      fetchImpl
    });

    await adapter.linkCollectionsToSpecification('spec-123', [
      { collectionId: 'col-1' }
    ]);

    const callHeaders = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(callHeaders['x-entity-team-id']).toBeUndefined();
  });
});

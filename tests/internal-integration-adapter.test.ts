import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetIdentityMemo } from '../src/lib/postman/credential-identity.js';
import {
  createInternalIntegrationAdapter
} from '../src/lib/postman/internal-integration-adapter.js';
import { createSecretMasker, REDACTED } from '../src/lib/secrets.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json'
    },
    ...init
  });
}

describe('internal integration adapter', () => {
  it('routes governance assignment through the Bifrost ruleset proxy', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          workspaceGroups: [{ id: 'group-1', name: 'Core Banking' }]
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      fetchImpl,
      appVersionProvider: { resolve: async () => '12.10.0' }
    });

    await adapter.assignWorkspaceToGovernanceGroup(
      'ws-123',
      'core-banking',
      JSON.stringify({ 'core-banking': 'Core Banking' })
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'x-access-token': 'token-123',
          'x-app-version': '12.10.0'
        }),
        body: JSON.stringify({
          service: 'ruleset',
          method: 'get',
          path: '/configure/workspace-groups',
          query: { tag: 'governance' }
        })
      })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          service: 'ruleset',
          method: 'patch',
          path: '/configure/workspace-groups/group-1',
          body: {
            workspaces: {
              add: ['ws-123'],
              remove: []
            },
            vulnerabilities: {
              add: [],
              remove: []
            }
          }
        })
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

  it('retries collection sync when a peer holds the 423 sync lock', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              name: 'actionLockedError',
              status: 423,
              title: 'Collection sync in progress',
              detail: 'Collection sync is already in progress for the specification.'
            }
          },
          { status: 423, statusText: 'Locked' }
        )
      )
      .mockResolvedValueOnce(jsonResponse({ data: { taskId: 'task-2' } }));

    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      orgMode: true,
      fetchImpl,
      sleep
    });

    await expect(adapter.syncCollection('spec-123', 'col-1')).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('treats collection already-in-sync as success for concurrent dual-trigger', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            name: 'badRequestError',
            status: 400,
            title: 'Collection is already in sync',
            detail: 'Collection is already in sync'
          }
        },
        { status: 400, statusText: 'Bad Request' }
      )
    );

    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      orgMode: true,
      fetchImpl
    });

    await expect(adapter.syncCollection('spec-123', 'col-1')).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries collection linking when a peer holds the 423 sync lock', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              name: 'actionLockedError',
              status: 423,
              title: 'Collection sync in progress'
            }
          },
          { status: 423, statusText: 'Locked' }
        )
      )
      .mockResolvedValueOnce(jsonResponse({ data: { updated: 1 } }));

    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      orgMode: true,
      fetchImpl,
      sleep
    });

    await expect(
      adapter.linkCollectionsToSpecification('spec-123', [
        { collectionId: 'col-1', syncOptions: { syncExamples: true } }
      ])
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
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
          workspaceGroups: [{ id: 'group-beta', name: 'Core Banking' }]
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
      fetchImpl,
      appVersionProvider: { resolve: async () => '12.10.0' }
    });

    await adapter.assignWorkspaceToGovernanceGroup(
      'ws-beta',
      'core-banking',
      JSON.stringify({ 'core-banking': 'Core Banking' })
    );

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://bifrost-https-v4.gw.postman-beta.com/ws/proxy',
      expect.any(Object)
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://bifrost-https-v4.gw.postman-beta.com/ws/proxy',
      expect.objectContaining({ method: 'POST' })
    );

    await adapter.syncCollection('spec-beta', 'col-beta');

    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      'https://bifrost-https-v4.gw.postman-beta.com/ws/proxy',
      expect.any(Object)
    );
  });

  it('throws when projectAlreadyConnected but linked to a different repo', async () => {
    // Dynamic fields carry CR/LF/U+2028/U+2029 so the conflict path must
    // normalize the complete message to one line after secret masking.
    const attemptedUrl = 'https://gitlab.com/org/\rmy-service';
    const existingUrl = 'https://gitlab.com/org/\ndifferent\u2028service';
    const workspaceId = 'ws-leak-secret-xyz\u2029';
    const leakySecret = 'leak-secret-xyz';
    const toOneLine = (value: string) => value.replace(/[\r\n\u2028\u2029]+/g, ' ');

    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { status: 400, name: 'projectAlreadyConnected', message: 'Workspace already has a file system connected.' } },
          { status: 400 }
        )
      )
      .mockResolvedValueOnce(
        jsonResponse({
          repo: existingUrl
        })
      );

    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      orgMode: true,
      fetchImpl,
      secretMasker: createSecretMasker([leakySecret])
    });

    let thrown: unknown;
    try {
      await adapter.connectWorkspaceToRepository(workspaceId, attemptedUrl);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain(toOneLine(attemptedUrl));
    expect(message).toContain(toOneLine(existingUrl));
    expect(message).toContain(`workspace ws-${REDACTED}`);
    expect(message).toMatch(/Bifrost uniqueness conflict/);
    expect(message).toContain(
      'Disconnect the existing repository link from that workspace or use the intended repository/workspace, then rerun.'
    );
    expect(message).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(message).toContain(REDACTED);
    expect(message).not.toContain(leakySecret);
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

  describe('findWorkspaceForRepo', () => {
    const repoUrl = 'https://github.com/postman-cs/bootstrap-action-test';

    it('returns free when the filesystem probe finds no owner (200 + null data)', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({ meta: { model: 'workspace', action: 'find' }, data: null })
      );
      const adapter = createInternalIntegrationAdapter({
        backend: 'bifrost',
        accessToken: 'token-123',
        teamId: '11430732',
        fetchImpl
      });

      await expect(adapter.findWorkspaceForRepo(repoUrl)).resolves.toEqual({ state: 'free' });

      expect(fetchImpl).toHaveBeenCalledWith(
        'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            service: 'workspaces',
            method: 'GET',
            path: `/workspaces/filesystem?repo=${encodeURIComponent(repoUrl)}&path=${encodeURIComponent('/')}`
          })
        })
      );
    });

    it('returns linked-visible when the probe returns a workspace the credentials can view', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          meta: { model: 'workspace', action: 'find' },
          data: { id: 'ws-linked', name: 'Payments Service', visibilityStatus: 'team' }
        })
      );
      const adapter = createInternalIntegrationAdapter({
        backend: 'bifrost',
        accessToken: 'token-123',
        teamId: '11430732',
        fetchImpl
      });

      await expect(adapter.findWorkspaceForRepo(repoUrl, '/')).resolves.toEqual({
        state: 'linked-visible',
        workspace: {
          id: 'ws-linked',
          name: 'Payments Service',
          visibilityStatus: 'team'
        }
      });
    });

    it('returns linked-invisible when the probe is 403 with error.meta.workspaceId', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            error: {
              status: 403,
              name: 'forbiddenError',
              message: 'You do not have permission to view this workspace',
              meta: { workspaceId: 'ws-hidden' }
            }
          },
          { status: 403 }
        )
      );
      const adapter = createInternalIntegrationAdapter({
        backend: 'bifrost',
        accessToken: 'token-123',
        teamId: '11430732',
        fetchImpl
      });

      await expect(adapter.findWorkspaceForRepo(repoUrl)).resolves.toEqual({
        state: 'linked-invisible',
        workspaceId: 'ws-hidden'
      });
    });

    it('returns linked-invisible when HTTP 200 wraps error.meta.workspaceId', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            error: {
              status: 403,
              name: 'forbiddenError',
              message: 'You do not have permission to view this workspace',
              meta: { workspaceId: 'ws-hidden-wrapped' }
            }
          },
          { status: 200 }
        )
      );
      const adapter = createInternalIntegrationAdapter({
        backend: 'bifrost',
        accessToken: 'token-123',
        teamId: '11430732',
        fetchImpl
      });

      await expect(adapter.findWorkspaceForRepo(repoUrl)).resolves.toEqual({
        state: 'linked-invisible',
        workspaceId: 'ws-hidden-wrapped'
      });
    });

    it('returns unknown (non-fatal) on transport or unexpected probe failures', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('network down'));
      const adapter = createInternalIntegrationAdapter({
        backend: 'bifrost',
        accessToken: 'token-123',
        teamId: '11430732',
        fetchImpl
      });

      const result = await adapter.findWorkspaceForRepo(repoUrl);
      expect(result.state).toBe('unknown');
      if (result.state === 'unknown') {
        expect(result.reason).toMatch(/network down/);
      }
    });

    it('does not mistake an empty 200 or another 2xx response for a free link', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('', { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      const adapter = createInternalIntegrationAdapter({
        backend: 'bifrost',
        accessToken: 'token-123',
        teamId: '11430732',
        fetchImpl
      });

      await expect(adapter.findWorkspaceForRepo(repoUrl)).resolves.toMatchObject({
        state: 'unknown',
        reason: 'Filesystem probe returned 200 without a data payload'
      });
      await expect(adapter.findWorkspaceForRepo(repoUrl)).resolves.toMatchObject({
        state: 'unknown',
        reason: 'Filesystem probe returned HTTP 204'
      });
    });
  });
});

describe('internal integration adapter error advice', () => {
  beforeEach(() => {
    __resetIdentityMemo();
  });

  function createGovernanceAdapter(listResponse: Response) {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(listResponse);
    return createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      fetchImpl,
      appVersionProvider: { resolve: async () => '12.10.0' }
    });
  }

  it('governance 401 yields re-mint guidance', async () => {
    const adapter = createGovernanceAdapter(
      new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }), { status: 401 })
    );

    let thrown: unknown;
    try {
      await adapter.assignWorkspaceToGovernanceGroup(
        'ws-123',
        'core-banking',
        JSON.stringify({ 'core-banking': 'Core Banking' })
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain('Bifrost rejected the access token (UNAUTHENTICATED)');
    expect(message).toContain('postman-resolve-service-token-action');
  });

  it('governance 403 yields role/team guidance', async () => {
    const adapter = createGovernanceAdapter(
      new Response(
        JSON.stringify({ error: { message: 'You are not authorized to perform this action' } }),
        { status: 403 }
      )
    );

    let thrown: unknown;
    try {
      await adapter.assignWorkspaceToGovernanceGroup(
        'ws-123',
        'core-banking',
        JSON.stringify({ 'core-banking': 'Core Banking' })
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain('Bifrost refused governance assignment with 403');
    expect(message).toContain('workspace-team-id 11430732');
    expect(message).toContain('GET https://api.getpostman.com/teams');
  });

  it('wires a per-request AbortSignal deadline onto every outbound fetch', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ workspaceGroups: [{ id: 'group-1', name: 'Core Banking' }] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      fetchImpl,
      appVersionProvider: { resolve: async () => '12.10.0' }
    });

    await adapter.assignWorkspaceToGovernanceGroup(
      'ws-123',
      'core-banking',
      JSON.stringify({ 'core-banking': 'Core Banking' })
    );

    // Every proxy call carries an AbortSignal so a hung endpoint aborts on the
    // deadline instead of blocking forever.
    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal?.aborted).toBe(false);
    }
  });
});

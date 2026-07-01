import { describe, expect, it, vi } from 'vitest';

import { createRoutingPostmanClient } from '../src/index.js';
import type { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';

function makeGateway(overrides: Partial<Record<keyof PostmanGatewayAssetsClient, unknown>> = {}): PostmanGatewayAssetsClient {
  const base = {
    uploadSpec: vi.fn(async () => 'gw-spec'),
    updateSpec: vi.fn(async () => undefined),
    getSpecContent: vi.fn(async () => 'gw-content'),
    generateCollection: vi.fn(async () => 'gw-col'),
    createWorkspace: vi.fn(async () => ({ id: 'gw-ws' })),
    getWorkspaceVisibility: vi.fn(async () => 'team'),
    getWorkspaceGitRepoUrl: vi.fn(async () => 'https://github.com/acme/gw'),
    findWorkspacesByName: vi.fn(async () => [{ id: 'g', name: 'n' }]),
    addAdminsToWorkspace: vi.fn(async () => undefined),
    inviteRequesterToWorkspace: vi.fn(async () => undefined),
    injectTests: vi.fn(async () => undefined),
    tagCollection: vi.fn(async () => undefined),
    deleteCollection: vi.fn(async () => undefined),
    injectContractTests: vi.fn(async () => []),
    getTeams: vi.fn(async () => [{ id: 132319, name: 'CSE v12', handle: 'cse-v12', organizationId: 13347347 }]),
    configureTeamContext: vi.fn(),
    ...overrides
  };
  return base as unknown as PostmanGatewayAssetsClient;
}

describe('createRoutingPostmanClient', () => {
  it('no-gateway (no access token, none mintable) rejects every asset op — never routes to PMAK', async () => {
    const facade = createRoutingPostmanClient({});
    expect(() => facade.configureTeamContext?.('t', true)).not.toThrow();
    await expect(facade.uploadSpec('ws', 'p', 'spec', '3.0')).rejects.toThrow(/access token/);
    await expect(facade.generateCollection('s', 'p', '[Smoke]', 'Tags', true, 'Fallback')).rejects.toThrow(/access token/);
    await expect(facade.createWorkspace('n', 'about')).rejects.toThrow(/access token/);
    await expect(facade.updateSpec('s', 'spec', 'ws')).rejects.toThrow(/access token/);
    await expect(facade.getSpecContent('s')).rejects.toThrow(/access token/);
    await expect(facade.getWorkspaceVisibility('ws')).rejects.toThrow(/access token/);
    await expect(facade.findWorkspacesByName('n')).rejects.toThrow(/access token/);
    await expect(facade.getTeams()).rejects.toThrow(/access token/);
    await expect(facade.addAdminsToWorkspace('ws', '1')).rejects.toThrow(/access token/);
    await expect(facade.inviteRequesterToWorkspace('ws', 'a@b.c')).rejects.toThrow(/access token/);
    await expect(facade.injectTests('uid', 'smoke')).rejects.toThrow(/access token/);
    await expect(facade.tagCollection('uid', ['x'])).rejects.toThrow(/access token/);
    await expect(facade.deleteCollection?.('uid')).rejects.toThrow(/access token/);
    await expect(facade.injectContractTests?.('uid', {} as never)).rejects.toThrow(/access token/);
  });

  it('gateway present: every asset op routes through the gateway', async () => {
    const gateway = makeGateway();
    const facade = createRoutingPostmanClient({ gateway });

    expect(await facade.uploadSpec('ws', 'p', 'spec', '3.1')).toBe('gw-spec');
    expect(await facade.generateCollection('s', 'p', '[Smoke]', 'Tags', true, 'Fallback')).toBe('gw-col');
    expect(gateway.uploadSpec).toHaveBeenCalledWith('ws', 'p', 'spec', '3.1');

    await facade.updateSpec('s', 'new spec', 'ws');
    expect(gateway.updateSpec).toHaveBeenCalledWith('s', 'new spec', 'ws');
    expect(await facade.getSpecContent('s')).toBe('gw-content');
  });

  it('gateway route error rethrows (never masks with a PMAK fallback)', async () => {
    const gateway = makeGateway({ uploadSpec: vi.fn(async () => { throw new Error('gateway 400'); }) });
    const facade = createRoutingPostmanClient({ gateway });
    await expect(facade.uploadSpec('ws', 'p', 'spec', '3.0')).rejects.toThrow('gateway 400');
  });

  it('getWorkspaceVisibility is gateway-only', async () => {
    const gateway = makeGateway({ getWorkspaceVisibility: vi.fn(async () => null) });
    const facade = createRoutingPostmanClient({ gateway });
    expect(await facade.getWorkspaceVisibility('ws')).toBeNull();
  });

  it('injectTests and tagCollection are gateway-only', async () => {
    const gateway = makeGateway();
    const facade = createRoutingPostmanClient({ gateway });
    await facade.injectTests('uid', 'smoke');
    await facade.tagCollection('uid', ['x']);
    expect(gateway.injectTests).toHaveBeenCalledWith('uid', 'smoke');
    expect(gateway.tagCollection).toHaveBeenCalledWith('uid', ['x']);
  });

  it('addAdminsToWorkspace and inviteRequesterToWorkspace route through the gateway', async () => {
    const gateway = makeGateway();
    const facade = createRoutingPostmanClient({ gateway });
    await facade.addAdminsToWorkspace('ws', '42');
    await facade.inviteRequesterToWorkspace('ws', 'a@b.c');
    expect(gateway.addAdminsToWorkspace).toHaveBeenCalledWith('ws', '42');
    expect(gateway.inviteRequesterToWorkspace).toHaveBeenCalledWith('ws', 'a@b.c');
  });

  it('injectContractTests routes through the gateway v3 /scripts surface', async () => {
    const gateway = makeGateway();
    const facade = createRoutingPostmanClient({ gateway });
    const index = { warnings: [], operations: [] } as never;
    await facade.injectContractTests?.('uid', index);
    expect(gateway.injectContractTests).toHaveBeenCalledWith('uid', index);
  });

  it('getTeams routes to the gateway ums squads enumeration', async () => {
    const gateway = makeGateway();
    const facade = createRoutingPostmanClient({ gateway });
    const teams = await facade.getTeams();
    expect(gateway.getTeams).toHaveBeenCalled();
    expect(teams).toEqual([{ id: 132319, name: 'CSE v12', handle: 'cse-v12', organizationId: 13347347 }]);
  });

  it('configureTeamContext is delegated to the gateway client', () => {
    const gateway = makeGateway();
    const facade = createRoutingPostmanClient({ gateway });
    facade.configureTeamContext?.('team-9', true);
    expect(gateway.configureTeamContext).toHaveBeenCalledWith('team-9', true);
  });
});

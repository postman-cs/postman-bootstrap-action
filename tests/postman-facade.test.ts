import { describe, expect, it, vi } from 'vitest';

import { createRoutingPostmanClient } from '../src/index.js';
import type { PostmanAssetsClient } from '../src/lib/postman/postman-assets-client.js';
import type { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';

function makeLog() {
  return { info: vi.fn(), warning: vi.fn() };
}

/** Minimal PMAK stub: only the methods the facade touches are wired. */
function makePmak(overrides: Partial<Record<keyof PostmanAssetsClient, unknown>> = {}): PostmanAssetsClient {
  const base = {
    uploadSpec: vi.fn(async () => 'pmak-spec'),
    generateCollection: vi.fn(async () => 'pmak-col'),
    getWorkspaceVisibility: vi.fn(async () => 'team'),
    getWorkspaceGitRepoUrl: vi.fn(async () => 'https://github.com/acme/pmak'),
    findWorkspacesByName: vi.fn(async () => [{ id: 'p', name: 'n' }]),
    getAutoDerivedTeamId: vi.fn(async () => '123'),
    getTeams: vi.fn(async () => []),
    getSpecContent: vi.fn(async () => 'content'),
    injectTests: vi.fn(async () => undefined),
    inviteRequesterToWorkspace: vi.fn(async () => undefined),
    addAdminsToWorkspace: vi.fn(async () => undefined),
    tagCollection: vi.fn(async () => undefined),
    createWorkspace: vi.fn(async () => ({ id: 'ws' })),
    updateSpec: vi.fn(async () => undefined),
    createCollection: vi.fn(async () => 'cc'),
    getCollection: vi.fn(async () => ({})),
    updateCollection: vi.fn(async () => undefined),
    deleteCollection: vi.fn(async () => undefined),
    ...overrides
  };
  return base as unknown as PostmanAssetsClient;
}

function makeGateway(overrides: Partial<Record<keyof PostmanGatewayAssetsClient, unknown>> = {}): PostmanGatewayAssetsClient {
  const base = {
    uploadSpec: vi.fn(async () => 'gw-spec'),
    generateCollection: vi.fn(async () => 'gw-col'),
    getWorkspaceVisibility: vi.fn(async () => 'team'),
    getWorkspaceGitRepoUrl: vi.fn(async () => 'https://github.com/acme/gw'),
    findWorkspacesByName: vi.fn(async () => [{ id: 'g', name: 'n' }]),
    configureTeamContext: vi.fn(),
    ...overrides
  };
  return base as unknown as PostmanGatewayAssetsClient;
}

describe('createRoutingPostmanClient', () => {
  it('PMAK-only (no gateway) routes everything to the PMAK client', async () => {
    const pmak = makePmak();
    const facade = createRoutingPostmanClient({ pmak, hasPmak: true, log: makeLog() });
    expect(await facade.uploadSpec('ws', 'p', 'spec', '3.0')).toBe('pmak-spec');
    expect(pmak.uploadSpec).toHaveBeenCalled();
    // configureTeamContext is a safe no-op on the PMAK path
    expect(() => facade.configureTeamContext?.('t', true)).not.toThrow();
  });

  it('access-token primary: gateway wins and PMAK is not touched', async () => {
    const pmak = makePmak();
    const gateway = makeGateway();
    const facade = createRoutingPostmanClient({ gateway, pmak, hasPmak: true, log: makeLog() });

    expect(await facade.uploadSpec('ws', 'p', 'spec', '3.1')).toBe('gw-spec');
    expect(await facade.generateCollection('s', 'p', '[Smoke]', 'Tags', true, 'Fallback')).toBe('gw-col');
    expect(gateway.uploadSpec).toHaveBeenCalledWith('ws', 'p', 'spec', '3.1');
    expect(pmak.uploadSpec).not.toHaveBeenCalled();
    expect(pmak.generateCollection).not.toHaveBeenCalled();
  });

  it('falls back to PMAK (with a warning) when a gateway route throws and a key exists', async () => {
    const pmak = makePmak();
    const gateway = makeGateway({ uploadSpec: vi.fn(async () => { throw new Error('gateway 400'); }) });
    const log = makeLog();
    const facade = createRoutingPostmanClient({ gateway, pmak, hasPmak: true, log });

    expect(await facade.uploadSpec('ws', 'p', 'spec', '3.0')).toBe('pmak-spec');
    expect(pmak.uploadSpec).toHaveBeenCalled();
    expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('falling back to the API key'));
  });

  it('access-token-only (no key) rethrows the gateway error instead of masking it', async () => {
    const pmak = makePmak();
    const gateway = makeGateway({ generateCollection: vi.fn(async () => { throw new Error('gateway 401'); }) });
    const facade = createRoutingPostmanClient({ gateway, pmak, hasPmak: false, log: makeLog() });

    await expect(facade.generateCollection('s', 'p', '[Smoke]', 'Tags', true, 'Fallback')).rejects.toThrow('gateway 401');
    expect(pmak.generateCollection).not.toHaveBeenCalled();
  });

  it('getWorkspaceVisibility falls back to PMAK when the gateway read returns null', async () => {
    const pmak = makePmak();
    const gateway = makeGateway({ getWorkspaceVisibility: vi.fn(async () => null) });
    const facade = createRoutingPostmanClient({ gateway, pmak, hasPmak: true, log: makeLog() });

    expect(await facade.getWorkspaceVisibility('ws')).toBe('team');
    expect(pmak.getWorkspaceVisibility).toHaveBeenCalled();
  });

  it('PMAK-only routes (injectTests, tagCollection, getTeams) always use the PMAK client even with a gateway', async () => {
    const pmak = makePmak();
    const gateway = makeGateway();
    const facade = createRoutingPostmanClient({ gateway, pmak, hasPmak: true, log: makeLog() });

    await facade.injectTests('uid', 'smoke');
    await facade.tagCollection('uid', ['x']);
    await facade.getTeams();
    expect(pmak.injectTests).toHaveBeenCalled();
    expect(pmak.tagCollection).toHaveBeenCalled();
    expect(pmak.getTeams).toHaveBeenCalled();
  });

  it('configureTeamContext is delegated to the gateway client', () => {
    const pmak = makePmak();
    const gateway = makeGateway();
    const facade = createRoutingPostmanClient({ gateway, pmak, hasPmak: true, log: makeLog() });
    facade.configureTeamContext?.('team-9', true);
    expect(gateway.configureTeamContext).toHaveBeenCalledWith('team-9', true);
  });
});

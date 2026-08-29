import { describe, expect, it } from 'vitest';

import { AccessTokenGatewayClient } from '@postman-cs/automation-core';
import { PostmanGatewayAssetsClient } from '../../src/lib/postman/postman-gateway-assets-client.js';
import { WORKSPACE_PERSONAL_ONLY_ADVICE } from '../../src/lib/postman/error-advice.js';
import { AccessTokenProvider } from '../../src/lib/postman/token-provider.js';
import { stripCollectionSemanticReceipt } from '../../src/lib/postman/collection-semantic-receipt.js';
import { renderAssetMarker } from '../../src/lib/repo/branch-decision.js';
import {
  createPlatformFake,
  type PlatformFake,
  type PlatformFakeCollectionState
} from './platform-fake.js';

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const OWN_BARE = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const OWN_UID = `300-${OWN_BARE}`;
const PEER_BARE = '11111111-1111-1111-1111-111111111111';
const PEER_UID = `100-${PEER_BARE}`;
const STRANGER_UID = '050-22222222-2222-2222-2222-222222222222';
const FINAL_NAME = 'Payments';

function marker(branch: 'feature/x' | 'feature/y' = 'feature/x'): string {
  return renderAssetMarker({
    repo: 'acme/api',
    rawBranch: branch,
    sanitizedBranch: branch.replace('/', '-'),
    headRepoId: '42',
    role: 'preview',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSyncedAt: '2026-01-01T00:00:00.000Z'
  });
}

function collection(description = marker(), rootId = OWN_BARE): Record<string, unknown> {
  return {
    info: {
      name: FINAL_NAME,
      description,
      schema: SCHEMA,
      _postman_id: rootId
    },
    item: []
  };
}

function makeClient(fake: PlatformFake, identity = 'state-machine-run'): PostmanGatewayAssetsClient {
  const gateway = new AccessTokenGatewayClient({
    tokenProvider: new AccessTokenProvider({ accessToken: 'access-token-test' }),
    fetchImpl: fake.fetch,
    sleepImpl: async () => undefined
  });
  return new PostmanGatewayAssetsClient({
    gateway,
    createIdentity: () => identity,
    sleep: async () => undefined
  });
}

function activeCollections(fake: PlatformFake): PlatformFakeCollectionState[] {
  return fake.state.collections.filter((entry) => entry.status === 'active');
}

function collectionRequests(fake: PlatformFake, method?: string) {
  return fake.state.requests.filter(
    (request) => request.service === 'collection' && (!method || request.method === method)
  );
}

function importRequests(fake: PlatformFake) {
  return fake.state.requests.filter(
    (request) =>
      request.service === 'sync' &&
      request.method === 'post' &&
      request.path === '/collection/import'
  );
}

function workspaceRequestMethods(fake: PlatformFake): string[] {
  return fake.state.requests
    .filter((request) => request.service === 'workspaces')
    .map((request) => `${request.method.toUpperCase()} ${request.path}`);
}

describe('contract: import election state machine', () => {
  it('imports the final name under one preallocated canonical identity', async () => {
    const fake = createPlatformFake({
      collectionId: () => OWN_BARE,
      importElection: { importedCanonicalId: OWN_UID }
    });

    const result = await makeClient(fake).importV2Collection('ws-contract', collection(), FINAL_NAME);

    expect(result).toEqual({
      collectionId: OWN_UID,
      journaledRootIds: [OWN_UID],
      deleteVerifiedCleanup: expect.any(Function)
    });
    expect(activeCollections(fake)).toEqual([
      expect.objectContaining({ id: OWN_UID, name: FINAL_NAME, origin: 'imported' })
    ]);
    expect(fake.state.collectionTransitions).toEqual([
      `imported:${OWN_UID}:${FINAL_NAME}`,
      `visible:${OWN_UID}:observation=1`
    ]);
    expect(fake.state.collectionDeleteLedger).toEqual([]);
    expect(importRequests(fake)).toHaveLength(1);
    expect(collectionRequests(fake, 'patch')).toEqual([]);
    expect(collectionRequests(fake, 'delete')).toEqual([]);
  });

  it('adopts the sole same-marker peer when its own entry vanishes during election', async () => {
    const sharedMarker = marker();
    const fake = createPlatformFake({
      collectionId: () => OWN_BARE,
      importElection: {
        importedCanonicalId: OWN_UID,
        importedVanishesAfterObservations: 1,
        peers: [
          {
            id: PEER_UID,
            name: FINAL_NAME,
            description: sharedMarker,
            visibleAfterObservations: 2,
            collection: collection(sharedMarker, PEER_BARE)
          }
        ]
      }
    });

    const result = await makeClient(fake).importV2Collection(
      'ws-contract',
      collection(sharedMarker),
      FINAL_NAME
    );

    expect(result.collectionId).toBe(PEER_UID);
    expect(result.journaledRootIds).toEqual([]);
    expect(activeCollections(fake)).toEqual([
      expect.objectContaining({ id: PEER_UID, name: FINAL_NAME, origin: 'peer' })
    ]);
    expect(fake.state.collectionTransitions).toContain(`vanished:${OWN_UID}:observation=2`);
    expect(fake.state.collectionDeleteLedger).toEqual([
      { id: OWN_UID, ownedByRun: true, verifiedAbsent: true }
    ]);
    expect(fake.state.deepUpdatedCollectionIds).toEqual([PEER_UID]);
    expect(importRequests(fake)).toHaveLength(1);
    expect(collectionRequests(fake, 'delete').map((request) => request.path)).toEqual([
      `/v3/collections/${OWN_BARE}`
    ]);
  });

  it('elects the lower-UID peer and deletes only its verified run-owned loser', async () => {
    const sharedMarker = marker();
    const fake = createPlatformFake({
      collectionId: () => OWN_BARE,
      importElection: {
        importedCanonicalId: OWN_UID,
        peers: [
          {
            id: PEER_UID,
            name: FINAL_NAME,
            description: sharedMarker,
            visibleAfterObservations: 2,
            collection: collection(sharedMarker, PEER_BARE)
          }
        ]
      }
    });

    const result = await makeClient(fake).importV2Collection(
      'ws-contract',
      collection(sharedMarker),
      FINAL_NAME
    );

    expect(result.collectionId).toBe(PEER_UID);
    expect(result.journaledRootIds).toEqual([]);
    expect(activeCollections(fake)).toEqual([
      expect.objectContaining({ id: PEER_UID, name: FINAL_NAME, origin: 'peer' })
    ]);
    expect(fake.state.collectionDeleteLedger).toEqual([
      { id: OWN_UID, ownedByRun: true, verifiedAbsent: true }
    ]);
    expect(collectionRequests(fake, 'delete').map((request) => request.path)).toEqual([
      `/v3/collections/${OWN_BARE}`
    ]);
    expect(importRequests(fake)).toHaveLength(1);
  });

  it('keeps a stale stranger untouched and retains exactly one same-marker canonical identity', async () => {
    const ownMarker = marker();
    const strangerMarker = marker('feature/y');
    const fake = createPlatformFake({
      collectionId: () => OWN_BARE,
      importElection: {
        importedCanonicalId: OWN_UID,
        peers: [
          {
            id: STRANGER_UID,
            name: FINAL_NAME,
            description: strangerMarker,
            collection: collection(strangerMarker)
          }
        ]
      }
    });

    const result = await makeClient(fake).importV2Collection(
      'ws-contract',
      collection(ownMarker),
      FINAL_NAME
    );

    expect(result.collectionId).toBe(OWN_UID);
    expect(activeCollections(fake)).toEqual([
      expect.objectContaining({ id: STRANGER_UID, origin: 'peer' }),
      expect.objectContaining({ id: OWN_UID, origin: 'imported' })
    ]);
    expect(activeCollections(fake).filter(
      (entry) => stripCollectionSemanticReceipt(entry.description) === ownMarker
    )).toHaveLength(1);
    expect(fake.state.collectionDeleteLedger).toEqual([]);
    expect(importRequests(fake)).toHaveLength(1);
    expect(collectionRequests(fake, 'delete')).toEqual([]);
  });

  it('hydrates an org peer marker from a populated Sync snapshot when inventory omits descriptions', async () => {
    const sharedMarker = marker();
    const fake = createPlatformFake({
      org: true,
      collectionId: () => OWN_BARE,
      importElection: {
        importedCanonicalId: OWN_UID,
        importedVanishesAfterObservations: 0,
        omitInventoryDescriptions: true,
        peers: [
          {
            id: PEER_UID,
            name: FINAL_NAME,
            description: sharedMarker,
            collection: collection(sharedMarker, PEER_BARE)
          }
        ]
      }
    });

    const result = await makeClient(fake).importV2Collection(
      'ws-contract',
      collection(sharedMarker),
      FINAL_NAME
    );

    expect(result.collectionId).toBe(PEER_UID);
    expect(result.journaledRootIds).toEqual([]);
    expect(fake.state.collectionDeleteLedger).toEqual([
      { id: OWN_UID, ownedByRun: true, verifiedAbsent: true }
    ]);
    expect(
      fake.state.requests.some((request) =>
        request.service === 'sync' &&
        request.method === 'get' &&
        request.path === `/collection/${PEER_UID}` &&
        request.query?.populate === 'true'
      )
    ).toBe(true);
    expect(activeCollections(fake)).toEqual([
      expect.objectContaining({ id: PEER_UID })
    ]);
    expect(stripCollectionSemanticReceipt(activeCollections(fake)[0]?.description)).toBe(sharedMarker);
    expect(importRequests(fake)).toHaveLength(1);
    expect(collectionRequests(fake, 'delete').map((request) => request.path)).toEqual([
      `/v3/collections/${OWN_BARE}`
    ]);
  });

  it('regresses fe-onsite-g02 attempt 4: own canonical identity appears after the historic six-observation window', async () => {
    const fake = createPlatformFake({
      collectionId: () => OWN_BARE,
      importElection: {
        importedCanonicalId: OWN_UID,
        importedVisibleAfterObservations: 6
      }
    });

    const result = await makeClient(fake, 'fe-onsite-g02-attempt-4').importV2Collection(
      'ws-contract',
      collection(''),
      FINAL_NAME
    );

    expect(result.collectionId).toBe(OWN_UID);
    expect(result.journaledRootIds).toEqual([OWN_UID]);
    expect(fake.state.collectionTransitions).toContain(`visible:${OWN_UID}:observation=7`);
    // Plan §4 carries one per-identity cursor from root resolution into election:
    // one pre-import snapshot plus seven resolution observations; election replays
    // that cursor instead of duplicating its inventory poll timeline.
    expect(fake.state.collectionObservationCount).toBe(8);
    expect(fake.state.collectionDeleteLedger).toEqual([]);
    expect(importRequests(fake)).toHaveLength(1);
    expect(collectionRequests(fake, 'delete')).toEqual([]);
  });

  it('fails closed and cleans only the owned root when canonical inventory visibility never arrives', async () => {
    const fake = createPlatformFake({
      collectionId: () => OWN_BARE,
      importElection: {
        importedCanonicalId: OWN_UID,
        importedVisibleAfterObservations: 999
      }
    });

    await expect(
      makeClient(fake).importV2Collection('ws-contract', collection(''), FINAL_NAME)
    ).rejects.toThrow(/COLLECTION_ROOT_UID_RESOLUTION_FAILED/);

    expect(activeCollections(fake)).toEqual([]);
    expect(fake.state.collectionDeleteLedger).toEqual([
      expect.objectContaining({ id: OWN_UID, ownedByRun: true })
    ]);
    expect(collectionRequests(fake, 'patch')).toEqual([]);
    expect(collectionRequests(fake, 'delete').map((request) => request.path)).toEqual([
      `/v3/collections/${OWN_BARE}`
    ]);
    expect(
      collectionRequests(fake, 'get').some(
        (request) => request.path === `/v3/collections/${OWN_BARE}`
      )
    ).toBe(false);
    expect(importRequests(fake)).toHaveLength(1);
  });
});

describe('contract: workspace visibility state machine', () => {
  it('creates personal, flips to team, and verifies the team-visible terminal state', async () => {
    const fake = createPlatformFake({ org: false, visibilityFlip: 'success' });

    await expect(makeClient(fake).createWorkspace('Payments', '')).resolves.toEqual({
      id: 'ws-contract'
    });

    expect(fake.state.workspaceCreateBodies).toEqual([
      expect.objectContaining({ name: 'Payments', visibilityStatus: 'personal' })
    ]);
    expect(fake.state.flipAttempts).toBe(1);
    expect(fake.state.workspaces).toEqual([
      { id: 'ws-contract', visibility: 'team', status: 'active' }
    ]);
    expect(workspaceRequestMethods(fake)).toEqual([
      'POST /workspaces',
      'PUT /workspaces/ws-contract/visibility',
      'GET /workspaces/ws-contract'
    ]);
  });

  it('creates an org squad workspace team-visible without attempting a flip', async () => {
    const fake = createPlatformFake({ org: true, visibilityFlip: 'forbidden' });

    await expect(makeClient(fake).createWorkspace('Payments', '', 132319)).resolves.toEqual({
      id: 'ws-contract'
    });

    expect(fake.state.workspaceCreateBodies).toEqual([
      expect.objectContaining({
        name: 'Payments',
        visibilityStatus: 'team',
        squad: 132319
      })
    ]);
    expect(fake.state.flipAttempts).toBe(0);
    expect(fake.state.workspaces).toEqual([
      { id: 'ws-contract', visibility: 'team', status: 'active' }
    ]);
    expect(workspaceRequestMethods(fake)).toEqual([
      'POST /workspaces',
      'GET /workspaces/ws-contract'
    ]);
  });

  it('rewrites a flip 403 to the guidance contract and cleans up the owned workspace', async () => {
    const fake = createPlatformFake({ org: false, visibilityFlip: 'forbidden' });

    await expect(makeClient(fake).createWorkspace('Payments', '')).rejects.toThrow(
      WORKSPACE_PERSONAL_ONLY_ADVICE
    );

    expect(fake.state.flipAttempts).toBe(1);
    expect(fake.state.workspaces).toEqual([
      { id: 'ws-contract', visibility: 'personal', status: 'deleted' }
    ]);
    expect(
      fake.state.requests.filter(
        (request) => request.service === 'workspaces' && request.method === 'delete'
      )
    ).toEqual([
      expect.objectContaining({ path: '/workspaces/ws-contract' })
    ]);
    expect(workspaceRequestMethods(fake)).toEqual([
      'POST /workspaces',
      'PUT /workspaces/ws-contract/visibility',
      'DELETE /workspaces/ws-contract'
    ]);
  });
});

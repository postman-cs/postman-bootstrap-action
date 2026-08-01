import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createPlatformFake,
  isModeledPlatformFakeRoute,
  PLATFORM_FAKE_ROUTES,
  type ProxyEnvelope
} from './platform-fake.js';

interface ManifestRoute {
  service: string;
  method: string;
  path: string;
  classification: string;
}

async function proxy(
  fake: ReturnType<typeof createPlatformFake>,
  request: ProxyEnvelope
): Promise<Response> {
  return fake.fetch(`${fake.hosts.bifrost}/ws/proxy`, {
    method: 'POST',
    body: JSON.stringify(request)
  });
}

function cassetteRoute(key: string): { service: string; method: string; path: string } {
  const proxyMatch = /^proxy:([^ ]+) ([A-Z]+) ([^ #]+)/.exec(key);
  if (proxyMatch) {
    return { service: proxyMatch[1]!, method: proxyMatch[2]!, path: proxyMatch[3]! };
  }
  const directMatch = /^([A-Z]+) (https:\/\/[^ #]+)/.exec(key);
  if (!directMatch) throw new Error(`Unparseable cassette key: ${key}`);
  const url = new URL(directMatch[2]!);
  const service =
    url.hostname === 'api.getpostman.com'
      ? 'postman-api'
      : url.hostname === 'iapub.postman.co'
        ? 'iapub'
        : url.hostname;
  return { service, method: directMatch[1]!, path: `${url.pathname}${url.search}` };
}

describe('contract: platform fake routing', () => {
  it.each([
    ['service', { service: 'unknown-service', method: 'get', path: '/v3/collections/?workspace=ws-contract' }],
    ['method', { service: 'collection', method: 'trace', path: '/v3/collections/?workspace=ws-contract' }],
    ['path', { service: 'collection', method: 'delete', path: '/unexpected-collection' }]
  ] as const)('fails loudly when proxied traffic has an unknown %s', async (_axis, request) => {
    const fake = createPlatformFake();

    await expect(proxy(fake, request)).rejects.toThrow(
      /Unmatched platform fake request: .*Nearest modeled route:/s
    );
  });

  it('rejects query and body shape drift on otherwise known routes', async () => {
    const fake = createPlatformFake();

    await expect(
      proxy(fake, {
        service: 'collection',
        method: 'get',
        path: '/v3/collections/?workspace=ws-contract&unexpected=true'
      })
    ).rejects.toThrow(/query or body shape did not match/);

    await expect(
      proxy(fake, {
        service: 'workspaces',
        method: 'post',
        path: '/workspaces',
        body: []
      })
    ).rejects.toThrow(/query or body shape did not match/);
  });

  it('models every manifest-simulated route and every committed cassette route', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, 'route-manifest.json'), 'utf8')
    ) as { routes: ManifestRoute[] };
    const simulated = manifest.routes.filter((route) => route.classification === 'simulated');
    expect(simulated).toHaveLength(21);
    expect(
      simulated.filter(
        (route) => !isModeledPlatformFakeRoute(route.service, route.method, route.path)
      )
    ).toEqual([]);

    const cassetteDir = join(import.meta.dirname, 'cassettes');
    const cassetteRoutes = readdirSync(cassetteDir)
      .filter((file) => file.endsWith('.json'))
      .flatMap((file) => {
        const cassette = JSON.parse(readFileSync(join(cassetteDir, file), 'utf8')) as {
          interactions: Array<{ key: string }>;
        };
        return cassette.interactions.map((interaction) => cassetteRoute(interaction.key));
      });
    expect(
      cassetteRoutes.filter(
        (route) => !isModeledPlatformFakeRoute(route.service, route.method, route.path)
      )
    ).toEqual([]);
    expect(PLATFORM_FAKE_ROUTES.length).toBeGreaterThanOrEqual(simulated.length);
  });

  it('paginates inventory with opaque cursors without advancing the lag observation per page', async () => {
    const fake = createPlatformFake({
      pageSize: 1,
      existingCollections: [
        { id: '123-a', name: 'A' },
        { id: '123-b', name: 'B' },
        { id: '123-c', name: 'C' }
      ]
    });

    const first = (await (
      await proxy(fake, {
        service: 'collection',
        method: 'get',
        path: '/v3/collections/?workspace=ws-contract'
      })
    ).json()) as { data: Array<{ id: string }>; meta: { pagination: { nextPage: string } } };
    const second = (await (
      await proxy(fake, {
        service: 'collection',
        method: 'get',
        path: '/v3/collections/?workspace=ws-contract',
        query: { cursor: first.meta.pagination.nextPage }
      })
    ).json()) as { data: Array<{ id: string }>; meta: { pagination: { nextPage: string } } };
    const third = (await (
      await proxy(fake, {
        service: 'collection',
        method: 'get',
        path: '/v3/collections/?workspace=ws-contract',
        query: { cursor: second.meta.pagination.nextPage }
      })
    ).json()) as { data: Array<{ id: string }>; meta: { pagination: { nextPage: string } } };

    expect([...first.data, ...second.data, ...third.data].map((entry) => entry.id)).toEqual([
      '123-a',
      '123-b',
      '123-c'
    ]);
    expect(first.meta.pagination.nextPage).not.toBe('');
    expect(second.meta.pagination.nextPage).not.toBe(first.meta.pagination.nextPage);
    expect(third.meta.pagination.nextPage).toBe('');
    expect(fake.state.paginationCursorsIssued).toBe(2);
    expect(fake.state.collectionObservationCount).toBe(1);
  });

  it('returns 403 instead of deleting a collection owned by another user', async () => {
    const fake = createPlatformFake({
      userId: 123,
      existingCollections: [{ id: '999-foreign', name: 'Foreign', ownerId: 999 }]
    });

    const denied = await proxy(fake, {
      service: 'collection',
      method: 'delete',
      path: '/v3/collections/999-foreign'
    });
    expect(denied.status).toBe(403);

    const inventory = (await (
      await proxy(fake, {
        service: 'collection',
        method: 'get',
        path: '/v3/collections/?workspace=ws-contract'
      })
    ).json()) as { data: Array<{ id: string }> };
    expect(inventory.data.map((entry) => entry.id)).toContain('999-foreign');
    expect(fake.state.collectionDeleteLedger).toEqual([]);
  });
});

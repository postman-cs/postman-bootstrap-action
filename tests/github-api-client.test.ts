import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GitHubApiClient,
  type GitHubApiClientAuthMode
} from '../src/lib/github/github-api-client.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json'
    },
    ...init
  });
}

describe('GitHubApiClient', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('falls back to the fallback token for repo variable writes after a 403', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
      .mockResolvedValueOnce(new Response('', { status: 201 }));

    const client = new GitHubApiClient({
      repository: 'postman-cs/bootstrap-demo',
      token: 'primary-token',
      fallbackToken: 'fallback-token',
      fetch: fetchMock
    });

    await client.setRepositoryVariable('POSTMAN_WORKSPACE_ID', 'ws_123');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer primary-token'
      })
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer fallback-token'
      })
    });
  });

  it.each<[GitHubApiClientAuthMode, string[]]>([
    ['github_token_first', ['primary-token', 'fallback-token']],
    ['fallback_pat_first', ['fallback-token', 'primary-token']],
    ['app_token', ['app-token', 'primary-token', 'fallback-token']]
  ])('exposes explicit token ordering for %s', (authMode, expected) => {
    const client = new GitHubApiClient({
      repository: 'postman-cs/bootstrap-demo',
      token: 'primary-token',
      fallbackToken: 'fallback-token',
      appToken: 'app-token',
      authMode
    });

    expect(client.getTokenOrder()).toEqual(expected);
  });

  it('sanitizes GitHub API error messages before surfacing them', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          message:
            'workflow write denied for token fallback-token and bearer primary-token'
        },
        { status: 500, statusText: 'Internal Server Error' }
      )
    );
    const client = new GitHubApiClient({
      repository: 'postman-cs/bootstrap-demo',
      token: 'primary-token',
      fallbackToken: 'fallback-token',
      fetch: fetchMock
    });

    await expect(
      client.getRepositoryVariable('POSTMAN_WORKSPACE_ID')
    ).rejects.toThrow('[REDACTED]');
    await expect(
      client.getRepositoryVariable('POSTMAN_WORKSPACE_ID')
    ).rejects.not.toThrow('primary-token');
    await expect(
      client.getRepositoryVariable('POSTMAN_WORKSPACE_ID')
    ).rejects.not.toThrow('fallback-token');
  });

  it('retries rate-limit-shaped responses with deterministic Retry-After delays', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { message: 'API rate limit exceeded for user' },
          {
            status: 403,
            headers: {
              'content-type': 'application/json',
              'retry-after': '1'
            }
          }
        )
      )
      .mockResolvedValueOnce(jsonResponse({ value: 'ws-123' }));

    const client = new GitHubApiClient({
      repository: 'postman-cs/bootstrap-demo',
      token: 'primary-token',
      fetch: fetchMock
    });

    const result = client.getRepositoryVariable('POSTMAN_WORKSPACE_ID');
    await vi.advanceTimersByTimeAsync(1000);

    await expect(result).resolves.toBe('ws-123');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: 'Bearer primary-token'
      })
    });
  });

  it('does not retry a plain 403 that is not rate-limit-shaped before fallback handling', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ message: 'Resource not accessible by integration' }, { status: 403 }))
      .mockResolvedValueOnce(jsonResponse({ value: 'from-fallback' }));

    const client = new GitHubApiClient({
      repository: 'postman-cs/bootstrap-demo',
      token: 'primary-token',
      fallbackToken: 'fallback-token',
      fetch: fetchMock
    });

    await expect(
      client.getRepositoryVariable('POSTMAN_WORKSPACE_ID')
    ).resolves.toBe('from-fallback');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: 'Bearer primary-token'
      })
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: 'Bearer fallback-token'
      })
    });
  });

  it('reads repository custom property values', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse([
        { property_name: 'postman-governance-group', value: 'Core Banking' }
      ])
    );

    const client = new GitHubApiClient({
      repository: 'postman-cs/bootstrap-demo',
      token: 'primary-token',
      fetch: fetchMock
    });

    await expect(
      client.getRepositoryCustomProperty('postman-governance-group')
    ).resolves.toBe('Core Banking');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/postman-cs/bootstrap-demo/properties/values',
      expect.objectContaining({ method: 'GET' })
    );
  });
});

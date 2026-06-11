import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleReporter } from '../src/cli.js';
import { HttpError } from '../src/lib/http-error.js';
import {
  __resetIdentityMemo,
  crossCheckIdentities,
  formatIdentityLine,
  runCredentialPreflight,
  type CredentialIdentity
} from '../src/lib/postman/credential-identity.js';
import {
  WORKSPACE_PERSONAL_ONLY_ADVICE,
  adviseFromBifrostBody,
  adviseFromHttpError,
  workspaceTeamIdUnauthorizedAdvice,
  type ErrorAdviceContext
} from '../src/lib/postman/error-advice.js';
import {
  REDACTED,
  createSecretMasker,
  redactSecrets,
  sanitizeHeaders,
  type SecretMasker
} from '../src/lib/secrets.js';

describe('secret safety rails', () => {
  it('redacts configured secret values from freeform text', () => {
    const sanitized = redactSecrets(
      'Authorization: Bearer token-123 and key pmak-secret',
      ['token-123', 'pmak-secret']
    );

    expect(sanitized).toBe(`Authorization: Bearer ${REDACTED} and key ${REDACTED}`);
  });

  it('sanitizes headers before surfacing them', () => {
    const headers = sanitizeHeaders(
      {
        Authorization: 'Bearer token-123',
        'x-api-key': 'pmak-secret',
        'x-trace-id': 'trace-token-123'
      },
      ['token-123', 'pmak-secret']
    );

    expect(headers).toEqual({
      authorization: REDACTED,
      'x-api-key': REDACTED,
      'x-trace-id': `trace-${REDACTED}`
    });
  });

  it('builds sanitized HTTP diagnostics without leaking token material', () => {
    const error = new HttpError({
      method: 'POST',
      url: 'https://example.test/resource?token=token-123',
      status: 401,
      statusText: 'Unauthorized',
      requestHeaders: {
        Authorization: 'Bearer token-123',
        'x-api-key': 'pmak-secret'
      },
      responseBody: 'token-123 rejected with api key pmak-secret',
      secretValues: ['token-123', 'pmak-secret']
    });

    expect(error.message).not.toContain('token-123');
    expect(error.message).not.toContain('pmak-secret');
    expect(error.toJSON()).toEqual({
      method: 'POST',
      name: 'HttpError',
      requestHeaders: {
        authorization: REDACTED,
        'x-api-key': REDACTED
      },
      responseBody: `${REDACTED} rejected with api key ${REDACTED}`,
      status: 401,
      statusText: 'Unauthorized',
      url: `https://example.test/resource?token=${REDACTED}`
    });
  });
});

const FAKE_TOKEN = 'fake-access-token-abc123';
const API_BASE = 'https://api.getpostman.com';
const IAPUB_BASE = 'https://iapub.postman.co';

function sampleIdentities() {
  const pmak: CredentialIdentity = {
    source: 'pmak/me',
    userId: '12345678',
    fullName: 'Ada Lovelace',
    teamId: '10490519',
    teamName: 'jared-demo',
    teamDomain: 'jared-demo'
  };
  const session: CredentialIdentity = {
    source: 'iapub/sessions',
    teamId: '13347347',
    teamDomain: 'field-services-v12-demo',
    roles: ['collection-editor'],
    consumerType: 'service_account'
  };
  return { pmak, session };
}

function sampleAdviceContext(mask: SecretMasker): ErrorAdviceContext {
  return {
    operation: 'governance assignment',
    hasAccessToken: true,
    sessionTeamId: '13347347',
    sessionRoles: ['collection-editor'],
    sessionConsumerType: 'service_account',
    workspaceTeamId: '132109',
    mask
  };
}

function preflightJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

async function collectDiagnosticLines(mask: SecretMasker): Promise<string[]> {
  const { pmak, session } = sampleIdentities();
  const lines: string[] = [];

  lines.push(formatIdentityLine(pmak, mask));
  lines.push(formatIdentityLine(session, mask));
  lines.push(crossCheckIdentities({ pmak, session, mode: 'warn', mask }).message);
  lines.push(crossCheckIdentities({ pmak, session, mode: 'enforce', mask }).message);
  lines.push(
    crossCheckIdentities({ pmak, session: { ...session, teamId: '10490519' }, mode: 'warn', mask })
      .message
  );
  lines.push(
    crossCheckIdentities({
      pmak,
      session: { ...session, teamId: '10490519' },
      workspaceTeamId: '132319',
      mode: 'enforce',
      mask
    }).message
  );
  lines.push(
    crossCheckIdentities({ pmak: { ...pmak, teamId: undefined }, session, mode: 'enforce', mask })
      .message
  );

  const ctx = sampleAdviceContext(mask);
  const reactiveInputs: Array<[number, string]> = [
    [401, '{"error":{"code":"UNAUTHENTICATED"}}'],
    [401, '{"error":{"name":"authenticationError","message":"Invalid session"}}'],
    [403, '{"error":{"message":"You are not authorized to perform this action"}}'],
    [400, '{"error":{"message":"Only personal workspaces (internal) can be created outside team"}}'],
    [400, '{"error":{"name":"invalidParamError","message":"filesystem already exists"}}'],
    [400, '{"error":{"name":"projectAlreadyConnected"}}'],
    [400, '{"error":{"message":"Team feature is not available for your organization"}}']
  ];
  for (const [status, body] of reactiveInputs) {
    const advised = adviseFromBifrostBody(status, body, ctx);
    expect(advised).toBeDefined();
    lines.push(advised!.message);
  }
  lines.push(WORKSPACE_PERSONAL_ONLY_ADVICE);
  lines.push(workspaceTeamIdUnauthorizedAdvice('999999999'));

  const captured: string[] = [];
  const log = {
    info: (message: string) => {
      captured.push(message);
    },
    warning: (message: string) => {
      captured.push(message);
    }
  };
  const happyFetch = (async (input: RequestInfo | URL) =>
    String(input).endsWith('/me')
      ? preflightJson({
          user: { id: 1, fullName: 'Ada Lovelace', teamId: 10490519, teamName: 'jared-demo' }
        })
      : preflightJson({
          identity: { team: 13347347, domain: 'field-services-v12-demo' },
          data: { user: { id: 2, roles: ['collection-editor'] } },
          consumerType: 'service_account'
        })) as typeof fetch;
  const failingFetch = (async () => preflightJson({ error: 'denied' }, 404)) as typeof fetch;

  __resetIdentityMemo();
  await runCredentialPreflight({
    apiBaseUrl: API_BASE,
    iapubBaseUrl: IAPUB_BASE,
    postmanApiKey: 'pmak-style-1',
    postmanAccessToken: 'token-style-1',
    mode: 'warn',
    mask,
    log,
    fetchImpl: happyFetch
  });
  __resetIdentityMemo();
  await runCredentialPreflight({
    apiBaseUrl: API_BASE,
    iapubBaseUrl: IAPUB_BASE,
    postmanApiKey: 'pmak-style-2',
    postmanAccessToken: 'token-style-2',
    mode: 'warn',
    mask,
    log,
    fetchImpl: failingFetch
  });
  __resetIdentityMemo();
  await runCredentialPreflight({
    apiBaseUrl: API_BASE,
    iapubBaseUrl: IAPUB_BASE,
    postmanApiKey: 'pmak-style-3',
    mode: 'warn',
    mask,
    log,
    fetchImpl: happyFetch
  });
  lines.push(...captured);

  return lines.filter((line) => line.length > 0);
}

describe('diagnostic style-ban and leak grep', () => {
  beforeEach(() => {
    __resetIdentityMemo();
  });

  it('emitted diagnostics contain no Bearer, x-access-token:, em dash, or antithesis fragments and no fed token', async () => {
    const mask = createSecretMasker([FAKE_TOKEN]);
    const lines = await collectDiagnosticLines(mask);

    expect(lines.length).toBeGreaterThanOrEqual(15);
    for (const line of lines) {
      expect(line).not.toContain('Bearer ');
      expect(line).not.toContain('x-access-token:');
      expect(line).not.toContain('\u2014');
      expect(line).not.toContain(' , not ');
      expect(line).not.toContain(' - not ');
      expect(line).not.toContain(FAKE_TOKEN);
    }
  });
});

describe('CLI ConsoleReporter masking path (AC7)', () => {
  beforeEach(() => {
    __resetIdentityMemo();
  });

  it('every new diagnostic line reaches the unmasking ConsoleReporter already redacted for a fed fake-token secret', () => {
    const mask = createSecretMasker([FAKE_TOKEN]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const reporter = new ConsoleReporter();
      const { pmak, session } = sampleIdentities();
      const tokenBearingLines = [
        formatIdentityLine({ ...pmak, fullName: FAKE_TOKEN }, mask),
        formatIdentityLine({ ...session, teamDomain: FAKE_TOKEN }, mask),
        crossCheckIdentities({
          pmak: { ...pmak, teamName: FAKE_TOKEN },
          session,
          mode: 'warn',
          mask
        }).message,
        adviseFromHttpError(
          new HttpError({
            method: 'POST',
            url: 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy',
            status: 403,
            statusText: 'Forbidden',
            responseBody: 'You are not authorized to perform this action'
          }),
          { ...sampleAdviceContext(mask), workspaceTeamId: FAKE_TOKEN }
        )!.message,
        adviseFromBifrostBody(403, 'You are not authorized to perform this action', {
          ...sampleAdviceContext(mask),
          sessionTeamId: FAKE_TOKEN
        })!.message
      ];

      for (const line of tokenBearingLines) {
        reporter.info(line);
        reporter.warning(line);
      }

      const emitted = consoleError.mock.calls.map((call) => String(call[0]));
      expect(emitted.length).toBe(tokenBearingLines.length * 2);
      for (const line of emitted) {
        expect(line).toContain(REDACTED);
        expect(line).not.toContain(FAKE_TOKEN);
      }
    } finally {
      consoleError.mockRestore();
    }
  });

  it('helpers mask internally: the secret fed THROUGH adviseFromHttpError and formatIdentityLine returns [REDACTED] without caller pre-wrapping', () => {
    const mask = createSecretMasker([FAKE_TOKEN]);

    const line = formatIdentityLine(
      {
        source: 'pmak/me',
        userId: '1',
        fullName: FAKE_TOKEN,
        teamId: '10490519'
      },
      mask
    );
    expect(line).toContain(REDACTED);
    expect(line).not.toContain(FAKE_TOKEN);

    const advised = adviseFromHttpError(
      new HttpError({
        method: 'POST',
        url: 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy',
        status: 403,
        statusText: 'Forbidden',
        responseBody: 'You are not authorized to perform this action'
      }),
      {
        operation: 'collection sync',
        hasAccessToken: true,
        workspaceTeamId: FAKE_TOKEN,
        mask
      }
    );
    expect(advised).toBeDefined();
    expect(advised!.message).toContain(REDACTED);
    expect(advised!.message).not.toContain(FAKE_TOKEN);
  });

  it('an iapub payload containing a token field never appears in preflight output even when the masker does not know the token', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const reporter = new ConsoleReporter();
      const mask = createSecretMasker([]);
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/me')) {
          return preflightJson({
            user: { id: 1, teamId: 10490519, teamName: 'jared-demo' }
          });
        }
        return preflightJson({
          identity: { team: 10490519, domain: 'jared-demo' },
          data: { user: { id: 2, roles: ['admin'], token: FAKE_TOKEN } },
          consumerType: 'service_account',
          token: FAKE_TOKEN
        });
      }) as typeof fetch;

      await runCredentialPreflight({
        apiBaseUrl: API_BASE,
        iapubBaseUrl: IAPUB_BASE,
        postmanApiKey: 'pmak-iapub-token-case',
        postmanAccessToken: 'token-iapub-token-case',
        mode: 'warn',
        mask,
        log: reporter,
        fetchImpl
      });

      const emitted = consoleError.mock.calls.map((call) => String(call[0]));
      expect(emitted.length).toBeGreaterThan(0);
      for (const line of emitted) {
        expect(line).not.toContain(FAKE_TOKEN);
      }
    } finally {
      consoleError.mockRestore();
    }
  });
});

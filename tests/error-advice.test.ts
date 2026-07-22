import { describe, expect, it } from 'vitest';

import { HttpError } from '../src/lib/http-error.js';
import { createSecretMasker, REDACTED } from '../src/lib/secrets.js';
import {
  WORKSPACE_PERSONAL_ONLY_ADVICE,
  adviseFromBifrostBody,
  adviseFromHttpError,
  adviseFromWorkspaceCreateError,
  workspaceTeamIdUnauthorizedAdvice,
  type ErrorAdviceContext
} from '../src/lib/postman/error-advice.js';

function createContext(overrides: Partial<ErrorAdviceContext> = {}): ErrorAdviceContext {
  return {
    operation: 'governance assignment',
    hasAccessToken: true,
    mask: (value: string) => value,
    ...overrides
  };
}

function bifrostHttpError(status: number, responseBody: string): HttpError {
  return new HttpError({
    method: 'POST',
    url: 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy',
    status,
    statusText: status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Bad Request',
    responseBody
  });
}

const UNAUTHENTICATED_ADVICE =
  'postman: Bifrost rejected the access token (UNAUTHENTICATED). ' +
  'Service-account access tokens expire after about 1 to 1.5 hours; this run likely outlived its token. ' +
  'Re-mint a fresh token with postman-resolve-service-token-action and re-run. ' +
  'If it was just minted, confirm postman-access-token is the token for the same parent org as postman-api-key.';

describe('error advice', () => {
  it('UNAUTHENTICATED bare body recommends the service-token action', () => {
    const httpErr = bifrostHttpError(401, '{"error":{"code":"UNAUTHENTICATED"}}');
    const advised = adviseFromHttpError(httpErr, createContext());

    expect(advised).toBeDefined();
    expect(advised?.message).toBe(
      `${UNAUTHENTICATED_ADVICE} Underlying cause: ${httpErr.message}`
    );
    expect(advised?.message).toContain('POST https://bifrost-premium-https-v4.gw.postman.com/ws/proxy');
    expect(advised?.message).toContain('401 Unauthorized');
    expect(advised?.message).toContain('UNAUTHENTICATED');
    expect(advised?.message).toContain('postman-resolve-service-token-action');
    expect(advised?.message).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(advised?.cause).toBe(httpErr);

    const fromBody = adviseFromBifrostBody(
      401,
      '{"error":{"code":"UNAUTHENTICATED"}}',
      createContext()
    );
    expect(fromBody?.message).toBe(
      `${UNAUTHENTICATED_ADVICE} Underlying cause: HTTP 401: {"error":{"code":"UNAUTHENTICATED"}}`
    );
    expect(fromBody?.cause).toBeInstanceOf(Error);
    expect((fromBody?.cause as Error).message).toBe(
      'HTTP 401: {"error":{"code":"UNAUTHENTICATED"}}'
    );
  });

  it('authenticationError body -> same expiry guidance', () => {
    const advised = adviseFromBifrostBody(
      401,
      '{"error":{"name":"authenticationError","message":"Invalid session"}}',
      createContext()
    );

    expect(advised).toBeDefined();
    expect(advised?.message).toContain('postman: Bifrost rejected the access token (authenticationError).');
    expect(advised?.message).toContain('expire after about 1 to 1.5 hours');
    expect(advised?.message).toContain('postman-resolve-service-token-action');
    expect(advised?.message).toContain(
      'Underlying cause: HTTP 401: {"error":{"name":"authenticationError","message":"Invalid session"}}'
    );
    expect(advised?.message).not.toMatch(/[\r\n\u2028\u2029]/);
  });

  it('403 "You are not authorized to perform this action" with workspace-team-id context -> "...GET https://api.getpostman.com/teams lists valid sub-team ids..."', () => {
    const httpErr = bifrostHttpError(
      403,
      '{"error":{"message":"You are not authorized to perform this action"}}'
    );
    const advised = adviseFromHttpError(httpErr, createContext({ workspaceTeamId: '132109' }));

    expect(advised).toBeDefined();
    expect(advised?.message).toContain('governance assignment');
    expect(advised?.message).toContain('403');
    expect(advised?.message).toContain('workspace-team-id 132109');
    expect(advised?.message).toContain('GET https://api.getpostman.com/teams');
    expect(advised?.message).toContain(`Underlying cause: ${httpErr.message}`);
    expect(advised?.message).toContain('POST https://bifrost-premium-https-v4.gw.postman.com/ws/proxy');
    expect(advised?.message).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(advised?.cause).toBe(httpErr);
  });

  it('403 valid-token-wrong-team (preflight memo says parent orgs differ) -> cross-team message naming both teams and the session roles/consumerType when known', () => {
    const mask = createSecretMasker(['secret-role-token']);
    const httpErr = bifrostHttpError(
      403,
      '{"error":{"message":"You are not authorized to perform this action"}}'
    );
    const advised = adviseFromHttpError(
      httpErr,
      createContext({
        operation: 'governance\u2028assignment',
        sessionTeamId: '13347347\u2029',
        sessionRoles: ['collection-editor\nsecret-role-token'],
        sessionConsumerType: 'service_account\r\n',
        workspaceTeamId: '132109',
        mask
      })
    );

    expect(advised).toBeDefined();
    expect(advised?.message).toContain('governance assignment');
    expect(advised?.message).toContain('team 13347347');
    expect(advised?.message).toContain('roles [collection-editor [REDACTED]]');
    expect(advised?.message).toContain('consumerType service_account');
    expect(advised?.message).toContain('workspace-team-id 132109');
    expect(advised?.message).toContain('POST https://bifrost-premium-https-v4.gw.postman.com/ws/proxy');
    expect(advised?.message).toContain('403 Forbidden');
    expect(advised?.message).toContain('GET https://api.getpostman.com/teams');
    expect(advised?.message).toContain('Underlying cause:');
    expect(advised?.message).toContain('You are not authorized to perform this action');
    expect(advised?.message).not.toContain('secret-role-token');
    expect(advised?.message).toContain(REDACTED);
    expect(advised?.message).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(advised?.message.split('\n')).toHaveLength(1);
    expect(advised?.cause).toBe(httpErr);
  });

  it('invalidParamError + "already exists" -> duplicate-link advice (defers to describeWorkspaceLinkConflict where present)', () => {
    const advised = adviseFromBifrostBody(
      400,
      '{"error":{"name":"invalidParamError","message":"workspace filesystem already exists"}}',
      createContext({ operation: 'workspace repository linking' })
    );

    expect(advised).toBeDefined();
    expect(advised?.message).toContain('workspace repository linking');
    expect(advised?.message).toContain('invalidParamError');
    expect(advised?.message).toContain('already exists');
    expect(advised?.message).toContain('one credential pair from a single parent org');
    expect(advised?.message).toContain(
      'Underlying cause: HTTP 400: {"error":{"name":"invalidParamError","message":"workspace filesystem already exists"}}'
    );
    expect(advised?.message).not.toMatch(/[\r\n\u2028\u2029]/);
  });

  it('projectAlreadyConnected body with no workspace id -> its own honest "linked but not visible to this credential; delete and re-run with one credential pair" message (no misleading success)', () => {
    const advised = adviseFromBifrostBody(
      400,
      '{"error":{"name":"projectAlreadyConnected"}}',
      createContext({ operation: 'workspace repository linking' })
    );

    expect(advised).toBeDefined();
    expect(advised?.message).toContain('projectAlreadyConnected');
    expect(advised?.message).toContain('no workspace id');
    expect(advised?.message).toContain('cannot see');
    expect(advised?.message).toContain('Delete the stale link');
    expect(advised?.message).toContain('one credential pair from a single parent org');
    expect(advised?.message).toContain(
      'Underlying cause: HTTP 400: {"error":{"name":"projectAlreadyConnected"}}'
    );
    expect(advised?.message.toLowerCase()).not.toContain('success');
    expect(advised?.message).not.toMatch(/[\r\n\u2028\u2029]/);
  });

  it('400 "Only personal workspaces" -> workspace-team-id advice', () => {
    const body =
      '{"error":{"name":"invalidParamError","message":"Only personal workspaces (internal) can be created outside team"}}';
    const advised = adviseFromBifrostBody(400, body, createContext({ hasAccessToken: false }));

    expect(advised).toBeDefined();
    expect(advised?.message).toBe(
      `${WORKSPACE_PERSONAL_ONLY_ADVICE} Underlying cause: HTTP 400: ${body}`
    );
    expect(advised?.message).toContain('workspace-team-id');
    expect(advised?.message).not.toMatch(/[\r\n\u2028\u2029]/);

    const fromCreateError = adviseFromWorkspaceCreateError(
      new Error(
        'POST https://api.getpostman.com/workspaces failed: 400 - Only personal workspaces (internal) can be created outside team'
      )
    );
    expect(fromCreateError?.message).toBe(WORKSPACE_PERSONAL_ONLY_ADVICE);
  });

  it('"Team feature is not available for your organization" -> team plan advice', () => {
    const advised = adviseFromBifrostBody(
      400,
      '{"error":{"message":"Team feature is not available for your organization"}}',
      createContext()
    );

    expect(advised).toBeDefined();
    expect(advised?.message).toContain('team feature is not available');
    expect(advised?.message).toContain(
      'Underlying cause: HTTP 400: {"error":{"message":"Team feature is not available for your organization"}}'
    );
  });

  it('unknown error passes through unchanged (no false rewrite)', () => {
    const unknownHttp = adviseFromHttpError(
      bifrostHttpError(500, '{"error":{"name":"serverError","message":"flaky upstream"}}'),
      createContext()
    );
    expect(unknownHttp).toBeUndefined();

    const unknownBody = adviseFromBifrostBody(404, 'no such route', createContext());
    expect(unknownBody).toBeUndefined();

    const pmakOnly403WithoutMarker = adviseFromBifrostBody(
      403,
      'some other forbidden body',
      createContext({ hasAccessToken: false })
    );
    expect(pmakOnly403WithoutMarker).toBeUndefined();

    const createError = adviseFromWorkspaceCreateError(new Error('totally unrelated failure'));
    expect(createError).toBeUndefined();
  });

  it('createWorkspace unauthorized teamId advice keeps the v0.14.2 wording', () => {
    const advised = adviseFromWorkspaceCreateError(
      new Error('POST https://api.getpostman.com/workspaces failed: 403 - You are not authorized to perform this action'),
      999999999
    );

    expect(advised).toBeDefined();
    expect(advised?.message).toBe(workspaceTeamIdUnauthorizedAdvice(999999999));
    expect(advised?.message).toContain('workspace-team-id input (999999999)');
    expect(advised?.message).toContain('GET https://api.getpostman.com/teams');
    expect(advised?.message).toContain('Fix the workspace-team-id value and re-run.');
  });

  it('rewritten text is run through secretMasker (no token leakage)', () => {
    const mask = createSecretMasker(['fake-token-abc123']);

    const advised = adviseFromHttpError(
      bifrostHttpError(403, 'You are not authorized to perform this action'),
      createContext({ workspaceTeamId: 'fake-token-abc123', mask })
    );
    expect(advised).toBeDefined();
    expect(advised?.message).toContain(REDACTED);
    expect(advised?.message).not.toContain('fake-token-abc123');
    expect(advised?.message).toContain('Underlying cause:');
    expect(advised?.message).toContain('POST https://bifrost-premium-https-v4.gw.postman.com/ws/proxy');
    expect(advised?.message).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(advised?.cause).toBeInstanceOf(HttpError);

    const fromBody = adviseFromBifrostBody(
      403,
      'You are not authorized to perform this action',
      createContext({ sessionTeamId: 'fake-token-abc123', mask })
    );
    expect(fromBody).toBeDefined();
    expect(fromBody?.message).toContain(REDACTED);
    expect(fromBody?.message).not.toContain('fake-token-abc123');
    expect(fromBody?.message).toContain(
      `Underlying cause: HTTP 403: You are not authorized to perform this action`
    );
    expect(fromBody?.message).not.toMatch(/[\r\n\u2028\u2029]/);
  });

  it('appended cause normalizes CR/LF and other line separators to spaces and stays one line', () => {
    const multilineBody =
      '{\r\n"error":{\n"message":"You are not authorized\u2028to perform this action"\u2029}\r}';
    const advised = adviseFromBifrostBody(403, multilineBody, createContext());

    expect(advised).toBeDefined();
    expect(advised?.message).toContain('Underlying cause: HTTP 403:');
    expect(advised?.message).toContain('You are not authorized to perform this action');
    expect(advised?.message).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(advised?.message.split('\n')).toHaveLength(1);

    // Cause object preserves the raw (possibly multiline) status/body text.
    expect(advised?.cause).toBeInstanceOf(Error);
    expect((advised?.cause as Error).message).toBe(`HTTP 403: ${multilineBody.slice(0, 800)}`);
  });

  it('adviseFromHttpError message surfaces operation/endpoint/status/cause/remediation while preserving Error.cause as the HttpError', () => {
    const httpErr = bifrostHttpError(
      403,
      '{"error":{"message":"You are not authorized to perform this action"}}'
    );
    const advised = adviseFromHttpError(
      httpErr,
      createContext({ operation: 'collection sync', workspaceTeamId: '132109' })
    );

    expect(advised?.message).toContain('collection sync');
    expect(advised?.message).toContain('POST');
    expect(advised?.message).toContain('https://bifrost-premium-https-v4.gw.postman.com/ws/proxy');
    expect(advised?.message).toContain('403 Forbidden');
    expect(advised?.message).toContain('You are not authorized to perform this action');
    expect(advised?.message).toContain('GET https://api.getpostman.com/teams');
    expect(advised?.message).toContain('Underlying cause:');
    expect(advised?.message).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(advised?.cause).toBe(httpErr);
  });
});

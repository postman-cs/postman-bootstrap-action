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

describe('error advice', () => {
  it('UNAUTHENTICATED bare body -> "access token rejected ... re-mint via postman-resolve-service-token-action or POST /service-account-tokens"', () => {
    const httpErr = bifrostHttpError(401, '{"error":{"code":"UNAUTHENTICATED"}}');
    const advised = adviseFromHttpError(httpErr, createContext());

    expect(advised).toBeDefined();
    expect(advised?.message).toBe(
      'postman: Bifrost rejected the access token (UNAUTHENTICATED). ' +
        'Service-account access tokens expire after about 1 to 1.5 hours; this run likely outlived its token. ' +
        'Re-mint a fresh token (postman-resolve-service-token-action, or POST https://api.getpostman.com/service-account-tokens) and re-run. ' +
        'If it was just minted, confirm postman-access-token is the token for the same parent org as postman-api-key.'
    );
    expect(advised?.cause).toBe(httpErr);

    const fromBody = adviseFromBifrostBody(
      401,
      '{"error":{"code":"UNAUTHENTICATED"}}',
      createContext()
    );
    expect(fromBody?.message).toBe(advised?.message);
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
    expect(advised?.message).toContain('POST https://api.getpostman.com/service-account-tokens');
  });

  it('403 "You are not authorized to perform this action" with workspace-team-id context -> "...GET https://api.getpostman.com/teams lists valid sub-team ids..."', () => {
    const advised = adviseFromHttpError(
      bifrostHttpError(403, '{"error":{"message":"You are not authorized to perform this action"}}'),
      createContext({ workspaceTeamId: '132109' })
    );

    expect(advised).toBeDefined();
    expect(advised?.message).toContain('403');
    expect(advised?.message).toContain('workspace-team-id 132109');
    expect(advised?.message).toContain('GET https://api.getpostman.com/teams');
  });

  it('403 valid-token-wrong-team (preflight memo says parent orgs differ) -> cross-team message naming both teams and the session roles/consumerType when known', () => {
    const advised = adviseFromHttpError(
      bifrostHttpError(403, '{"error":{"message":"You are not authorized to perform this action"}}'),
      createContext({
        sessionTeamId: '13347347',
        sessionRoles: ['collection-editor'],
        sessionConsumerType: 'service_account',
        workspaceTeamId: '132109'
      })
    );

    expect(advised).toBeDefined();
    expect(advised?.message).toBe(
      'postman: Bifrost refused governance assignment with 403 while the access token is valid ' +
        '(it resolved to team 13347347, roles [collection-editor], consumerType service_account at preflight). ' +
        "The token's identity lacks permission for this endpoint, or workspace-team-id 132109 names a sub-team it cannot act in. " +
        "Verify the token's role and that workspace-team-id / POSTMAN_TEAM_ID matches a sub-team from GET https://api.getpostman.com/teams."
    );
  });

  it('invalidParamError + "already exists" -> duplicate-link advice (defers to describeWorkspaceLinkConflict where present)', () => {
    const advised = adviseFromBifrostBody(
      400,
      '{"error":{"name":"invalidParamError","message":"workspace filesystem already exists"}}',
      createContext({ operation: 'workspace repository linking' })
    );

    expect(advised).toBeDefined();
    expect(advised?.message).toContain('invalidParamError');
    expect(advised?.message).toContain('already exists');
    expect(advised?.message).toContain('one credential pair from a single parent org');
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
    expect(advised?.message.toLowerCase()).not.toContain('success');
  });

  it('400 "Only personal workspaces" -> workspace-team-id advice', () => {
    const advised = adviseFromBifrostBody(
      400,
      '{"error":{"name":"invalidParamError","message":"Only personal workspaces (internal) can be created outside team"}}',
      createContext({ hasAccessToken: false })
    );

    expect(advised).toBeDefined();
    expect(advised?.message).toBe(WORKSPACE_PERSONAL_ONLY_ADVICE);
    expect(advised?.message).toContain('workspace-team-id');

    const fromCreateError = adviseFromWorkspaceCreateError(
      new Error(
        'POST https://api.getpostman.com/workspaces failed: 400 - Only personal workspaces (internal) can be created outside team'
      )
    );
    expect(fromCreateError?.message).toBe(advised?.message);
  });

  it('"Team feature is not available for your organization" -> team plan advice', () => {
    const advised = adviseFromBifrostBody(
      400,
      '{"error":{"message":"Team feature is not available for your organization"}}',
      createContext()
    );

    expect(advised).toBeDefined();
    expect(advised?.message).toContain('team feature is not available');
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

    const fromBody = adviseFromBifrostBody(
      403,
      'You are not authorized to perform this action',
      createContext({ sessionTeamId: 'fake-token-abc123', mask })
    );
    expect(fromBody).toBeDefined();
    expect(fromBody?.message).toContain(REDACTED);
    expect(fromBody?.message).not.toContain('fake-token-abc123');
  });
});

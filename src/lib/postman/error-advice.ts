import type { HttpError } from '@postman-cse/automation-core';
import type { SecretMasker } from '../secrets.js';

export interface ErrorAdviceContext {
  operation: string;
  hasAccessToken: boolean;
  sessionTeamId?: string;
  sessionRoles?: string[];
  sessionConsumerType?: string;
  workspaceTeamId?: string;
  explicitTeamId?: string;
  mask: SecretMasker;
}

/** v0.14.2 createWorkspace guidance, single-sourced here so the texts cannot diverge. */
export const WORKSPACE_PERSONAL_ONLY_ADVICE =
  'Workspace creation failed: This may be an Org-mode account that requires a workspace-team-id input. ' +
  'The Postman API does not allow creating team workspaces at the organization level. ' +
  'Use the workspace-team-id input to specify which sub-team should own this workspace.';

/**
 * Pre-create failure for indeterminate org sub-team (squad) discovery. Raised
 * when the squads read did not return a usable list AND did not return the
 * recognized non-org sentinel, so whether the account is org-mode is unknown.
 * Guessing "not org-mode" is what produced the late, misleading 403 on
 * PUT /workspaces/:id/visibility after a workspace had already been created.
 */
export function squadDiscoveryUnavailableAdvice(observedStatus: number | string): string {
  return (
    `Cannot determine whether this is an Org-mode account: the Postman sub-team (squad) list could not be read (observed UMS status ${observedStatus}). ` +
    'Creating a workspace without that answer risks a personal-only workspace that org accounts reject with 403 on the visibility change. ' +
    'Set the workspace-team-id input to the numeric id of the sub-team that should own this workspace ' +
    '(GitHub Actions: workspace-team-id; env: POSTMAN_WORKSPACE_TEAM_ID; CLI: --workspace-team-id <id>). ' +
    'If you believe this account is genuinely not Org-mode, re-run once the squads endpoint is readable, ' +
    'or pass an existing workspace-id so no workspace has to be created.'
  );
}

export function workspaceTeamIdUnauthorizedAdvice(targetTeamId: number | string): string {
  return (
    `The workspace-team-id input (${targetTeamId}) was rejected as unauthorized by the Postman API. ` +
    'In org-mode accounts it must be the numeric id of a sub-team this API key can access; ' +
    'GET https://api.getpostman.com/teams lists the available sub-teams. ' +
    'Fix the workspace-team-id value and re-run.'
  );
}

export function adviseFromWorkspaceCreateError(
  err: Error,
  targetTeamId?: number | string
): Error | undefined {
  if (err.message.includes('Only personal workspaces')) {
    return new Error(WORKSPACE_PERSONAL_ONLY_ADVICE, { cause: err });
  }
  if (
    targetTeamId != null &&
    err.message.includes('You are not authorized to perform this action')
  ) {
    return new Error(workspaceTeamIdUnauthorizedAdvice(targetTeamId), { cause: err });
  }
  return undefined;
}

function expiryAdvice(code: 'UNAUTHENTICATED' | 'authenticationError'): string {
  return (
    `postman: Bifrost rejected the access token (${code}). ` +
    'Service-account access tokens expire after about 1 to 1.5 hours; this run likely outlived its token. ' +
    'Re-mint a fresh token with postman-resolve-service-token-action and re-run. ' +
    'If it was just minted, confirm postman-access-token is the token for the same parent org as postman-api-key.'
  );
}

function forbiddenAdvice(ctx: ErrorAdviceContext): string {
  const sessionDetail = ctx.sessionTeamId
    ? ` while the access token is valid (it resolved to team ${ctx.sessionTeamId}` +
      `${ctx.sessionRoles && ctx.sessionRoles.length > 0 ? `, roles [${ctx.sessionRoles.join(', ')}]` : ''}` +
      `${ctx.sessionConsumerType ? `, consumerType ${ctx.sessionConsumerType}` : ''} at preflight)`
    : '';
  const scopedTeamId = ctx.workspaceTeamId || ctx.explicitTeamId;
  const teamClause = scopedTeamId
    ? `, or workspace-team-id ${scopedTeamId} names a sub-team it cannot act in`
    : ', or the workspace-team-id / POSTMAN_TEAM_ID in use names a sub-team it cannot act in';
  return (
    `postman: Bifrost refused ${ctx.operation || 'this operation'} with 403${sessionDetail}. ` +
    `The token's identity lacks permission for this endpoint${teamClause}. ` +
    "Verify the token's role and that workspace-team-id / POSTMAN_TEAM_ID matches a sub-team from GET https://api.getpostman.com/teams."
  );
}

function buildAdvice(status: number, body: string, ctx: ErrorAdviceContext): string | undefined {
  if (body.includes('UNAUTHENTICATED')) {
    return expiryAdvice('UNAUTHENTICATED');
  }
  if (body.includes('authenticationError')) {
    return expiryAdvice('authenticationError');
  }
  if (body.includes('Only personal workspaces')) {
    return WORKSPACE_PERSONAL_ONLY_ADVICE;
  }
  if (body.includes('projectAlreadyConnected')) {
    return (
      `postman: ${ctx.operation || 'this operation'} reports projectAlreadyConnected with no workspace id in the error body. ` +
      'The repository is already linked to a workspace this credential cannot see, usually one created by a different credential pair or sub-team. ' +
      'Delete the stale link or its workspace, then re-run with one credential pair from a single parent org.'
    );
  }
  if (body.includes('invalidParamError') && body.includes('already exists')) {
    return (
      `postman: ${ctx.operation || 'this operation'} hit a duplicate resource error (invalidParamError: already exists). ` +
      'A matching resource already exists, possibly under another credential pair or sub-team where this credential cannot see it. ' +
      'Identify which workspace holds the existing resource and re-run with one credential pair from a single parent org.'
    );
  }
  if (body.includes('Team feature is not available for your organization')) {
    return (
      `postman: ${ctx.operation || 'this operation'} failed because the team feature is not available for this organization. ` +
      'The credential belongs to an account whose plan lacks team features; use credentials from the intended team and confirm the plan supports this operation.'
    );
  }
  if (
    body.includes('You are not authorized to perform this action') ||
    (status === 403 && ctx.hasAccessToken)
  ) {
    return forbiddenAdvice(ctx);
  }
  return undefined;
}

/** Collapse CR/LF and other line separators so composed advice stays one CI-friendly line. */
function toOneLine(value: string): string {
  return String(value || '')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .trim();
}

function withUnderlyingCause(advice: string, causeText: string, mask: SecretMasker): string {
  const cause = String(causeText || '').trim();
  const composed = cause ? `${advice} Underlying cause: ${cause}` : advice;
  return toOneLine(mask(composed));
}

export function adviseFromHttpError(err: HttpError, ctx: ErrorAdviceContext): Error | undefined {
  const body = err.responseBody || err.message || '';
  const advice = buildAdvice(err.status, body, ctx);
  if (!advice) {
    return undefined;
  }
  return new Error(withUnderlyingCause(advice, err.message, ctx.mask), { cause: err });
}

export function adviseFromBifrostBody(
  status: number,
  body: string,
  ctx: ErrorAdviceContext
): Error | undefined {
  const advice = buildAdvice(status, String(body || ''), ctx);
  if (!advice) {
    return undefined;
  }
  const causeText = `HTTP ${status}: ${String(body || '').slice(0, 800)}`;
  return new Error(withUnderlyingCause(advice, causeText, ctx.mask), {
    cause: new Error(ctx.mask(causeText))
  });
}

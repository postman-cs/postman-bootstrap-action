import type { SecretMasker } from '../secrets.js';

export interface CredentialIdentity {
  source: 'pmak/me' | 'iapub/sessions';
  userId?: string;
  fullName?: string;
  teamId?: string;
  teamName?: string;
  teamDomain?: string;
  roles?: string[];
  consumerType?: string;
}

export type PreflightMode = 'enforce' | 'warn' | 'off';

export interface ResolvePmakIdentityOptions {
  apiBaseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export interface ResolveSessionIdentityOptions {
  iapubBaseUrl: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}

export interface CrossCheckResult {
  ok: boolean;
  level: 'ok' | 'note' | 'fail';
  message: string;
}

export interface CrossCheckIdentitiesArgs {
  pmak?: CredentialIdentity;
  session?: CredentialIdentity;
  workspaceTeamId?: string;
  explicitTeamId?: string;
  mode: PreflightMode;
  mask: SecretMasker;
}

export interface PreflightLogger {
  info(message: string): void;
  warning(message: string): void;
}

export interface RunCredentialPreflightArgs {
  apiBaseUrl: string;
  iapubBaseUrl: string;
  postmanApiKey?: string;
  postmanAccessToken?: string;
  workspaceTeamId?: string;
  explicitTeamId?: string;
  mode: PreflightMode;
  mask: SecretMasker;
  log: PreflightLogger;
  fetchImpl?: typeof fetch;
}

const sessionPath = '/api/sessions/current';

type JsonRecord = Record<string, unknown>;

const pmakMemo = new Map<string, Promise<CredentialIdentity | undefined>>();
const sessionMemo = new Map<string, Promise<CredentialIdentity | undefined>>();
let memoizedSessionIdentity: CredentialIdentity | undefined;

/** Test-only: clears the in-process identity memos so cases cannot bleed into each other. */
export function __resetIdentityMemo(): void {
  pmakMemo.clear();
  sessionMemo.clear();
  memoizedSessionIdentity = undefined;
}

/** Last session identity resolved in this process, for reactive error-advice context. */
export function getMemoizedSessionIdentity(): CredentialIdentity | undefined {
  return memoizedSessionIdentity;
}

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonRecord;
}

function coerceId(raw: unknown): string | undefined {
  return raw ? String(raw) : undefined;
}

function coerceText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeBaseUrl(raw: string): string {
  return String(raw || '').replace(/\/+$/, '');
}

export async function resolvePmakIdentity(
  opts: ResolvePmakIdentityOptions
): Promise<CredentialIdentity | undefined> {
  const apiKey = String(opts.apiKey || '').trim();
  if (!apiKey) {
    return undefined;
  }
  const baseUrl = normalizeBaseUrl(opts.apiBaseUrl);
  const memoKey = `${baseUrl}::${apiKey}`;
  let pending = pmakMemo.get(memoKey);
  if (!pending) {
    pending = probePmakIdentity(baseUrl, apiKey, opts.fetchImpl ?? fetch);
    pmakMemo.set(memoKey, pending);
  }
  return pending;
}

async function probePmakIdentity(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch
): Promise<CredentialIdentity | undefined> {
  try {
    const response = await fetchImpl(`${baseUrl}/me`, {
      method: 'GET',
      headers: { 'X-Api-Key': apiKey }
    });
    if (!response.ok) {
      return undefined;
    }
    const payload = asRecord(await response.json());
    const user = asRecord(payload?.user);
    if (!user) {
      return undefined;
    }
    return {
      source: 'pmak/me',
      userId: coerceId(user.id),
      fullName: coerceText(user.fullName) ?? coerceText(user.username),
      teamId: coerceId(user.teamId),
      teamName: coerceText(user.teamName),
      teamDomain: coerceText(user.teamDomain)
    };
  } catch {
    return undefined;
  }
}

export async function resolveSessionIdentity(
  opts: ResolveSessionIdentityOptions
): Promise<CredentialIdentity | undefined> {
  const accessToken = String(opts.accessToken || '').trim();
  if (!accessToken) {
    return undefined;
  }
  const baseUrl = normalizeBaseUrl(opts.iapubBaseUrl);
  const memoKey = `${baseUrl}::${accessToken}`;
  let pending = sessionMemo.get(memoKey);
  if (!pending) {
    pending = probeSessionIdentity(baseUrl, accessToken, opts.fetchImpl ?? fetch);
    sessionMemo.set(memoKey, pending);
  }
  return pending;
}

async function probeSessionIdentity(
  baseUrl: string,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<CredentialIdentity | undefined> {
  try {
    const response = await fetchImpl(`${baseUrl}${sessionPath}`, {
      method: 'GET',
      headers: { 'x-access-token': accessToken }
    });
    if (!response.ok) {
      return undefined;
    }
    const payload = asRecord(await response.json());
    if (!payload) {
      return undefined;
    }
    // iapub wraps the live session under `session`; tolerate an unwrapped shape too.
    // Whitelisted extraction only; the raw session body (incl. session.token) is discarded.
    const root = asRecord(payload.session) ?? payload;
    const identity = asRecord(root.identity);
    const data = asRecord(root.data);
    const user = asRecord(data?.user);
    const roleEntries = Array.isArray(user?.roles)
      ? user.roles
          .map((entry) => coerceText(entry) ?? coerceId(entry))
          .filter((entry): entry is string => Boolean(entry))
      : [];
    const singleRole = coerceText(user?.role);
    const roles =
      roleEntries.length > 0 ? roleEntries : singleRole ? [singleRole] : undefined;
    const resolved: CredentialIdentity = {
      source: 'iapub/sessions',
      userId: coerceId(identity?.user) ?? coerceId(user?.id),
      fullName:
        coerceText(user?.fullName) ?? coerceText(user?.name) ?? coerceText(user?.username),
      teamId: coerceId(identity?.team),
      teamName: coerceText(user?.teamName),
      teamDomain: coerceText(identity?.domain),
      ...(roles ? { roles } : {}),
      consumerType:
        coerceText(root.consumerType) ??
        coerceText(data?.consumerType) ??
        coerceText(user?.consumerType)
    };
    memoizedSessionIdentity = resolved;
    return resolved;
  } catch {
    return undefined;
  }
}

function describeTeam(id: CredentialIdentity | undefined): string {
  const label = id?.teamName ?? id?.teamDomain;
  return `team ${id?.teamId ?? 'unresolved'}${label ? ` (${label})` : ''}`;
}

export function formatIdentityLine(id: CredentialIdentity, mask: SecretMasker): string {
  const teamPart = id.teamId ? describeTeam(id) : 'team unresolved';
  const domainPart = id.teamDomain ? `, domain ${id.teamDomain}` : '';
  if (id.source === 'pmak/me') {
    const userPart = id.userId
      ? `user ${id.userId}${id.fullName ? ` (${id.fullName})` : ''}, `
      : '';
    return mask(`postman: PMAK identity - ${userPart}${teamPart}${domainPart}`);
  }
  return mask(
    `postman: access-token session identity - ${teamPart}${domainPart} [source: iapub/sessions]`
  );
}

export function crossCheckIdentities(args: CrossCheckIdentitiesArgs): CrossCheckResult {
  if (args.mode === 'off') {
    return { ok: true, level: 'ok', message: '' };
  }
  const pmakTeamId = args.pmak?.teamId;
  const sessionTeamId = args.session?.teamId;

  if (pmakTeamId && sessionTeamId && pmakTeamId !== sessionTeamId) {
    const level = args.mode === 'enforce' ? 'fail' : 'note';
    const lead = level === 'fail' ? 'credential preflight FAILED' : 'credential preflight note';
    const fix =
      level === 'fail'
        ? 'Use one credential pair from a single parent org: re-mint the access token from the same parent org as postman-api-key ' +
          "(postman-resolve-service-token-action, or POST https://api.getpostman.com/service-account-tokens with that team's PMAK), " +
          'or set postman-api-key to the matching parent org.'
        : 'Use one credential pair from a single parent org. Set credential-preflight: enforce to fail the run on this condition.';
    return {
      ok: false,
      level,
      message: args.mask(
        `postman: ${lead} - PMAK belongs to ${describeTeam(args.pmak)} but the access token's session belongs to a different parent org, ${describeTeam(args.session)}. ` +
          'Assets would be created against one team while Bifrost linking and governance act under the other, ' +
          'producing duplicate-link 400s and workspaces not visible to the other credential. ' +
          fix
      )
    };
  }

  if (pmakTeamId && sessionTeamId) {
    const scope = args.workspaceTeamId || args.explicitTeamId ? 'parent org team' : 'team';
    const label =
      args.pmak?.teamName ??
      args.pmak?.teamDomain ??
      args.session?.teamName ??
      args.session?.teamDomain;
    return {
      ok: true,
      level: 'ok',
      message: args.mask(
        `postman: credential preflight OK - PMAK and access token both resolve to ${scope} ${pmakTeamId}${label ? ` (${label})` : ''}`
      )
    };
  }

  const missing = [
    !pmakTeamId ? 'PMAK identity' : undefined,
    !sessionTeamId ? 'access-token session identity' : undefined
  ]
    .filter(Boolean)
    .join(' and ');
  return {
    ok: false,
    level: 'note',
    message: args.mask(
      `postman: credential preflight note - cross-check skipped because the ${missing} did not resolve a team id; continuing with reactive error guidance only`
    )
  };
}

export async function runCredentialPreflight(args: RunCredentialPreflightArgs): Promise<void> {
  if (args.mode === 'off') {
    return;
  }
  const mask = args.mask;
  const apiKey = String(args.postmanApiKey || '').trim();
  const accessToken = String(args.postmanAccessToken || '').trim();

  let pmak: CredentialIdentity | undefined;
  if (apiKey) {
    try {
      pmak = await resolvePmakIdentity({
        apiBaseUrl: args.apiBaseUrl,
        apiKey,
        fetchImpl: args.fetchImpl
      });
    } catch (error) {
      args.log.warning(
        mask(
          `postman: credential preflight could not resolve PMAK identity: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
    if (pmak) {
      args.log.info(formatIdentityLine(pmak, mask));
    } else {
      args.log.warning(
        mask('postman: credential preflight could not resolve PMAK identity from GET /me; continuing')
      );
    }
  }

  if (!accessToken) {
    args.log.info(mask('postman: Bifrost diagnostics limited: no access token'));
    return;
  }

  let session: CredentialIdentity | undefined;
  try {
    session = await resolveSessionIdentity({
      iapubBaseUrl: args.iapubBaseUrl,
      accessToken,
      fetchImpl: args.fetchImpl
    });
  } catch (error) {
    args.log.warning(
      mask(
        `postman: credential preflight could not resolve access-token session identity: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
  if (session) {
    args.log.info(formatIdentityLine(session, mask));
  } else {
    args.log.warning(
      mask(
        'postman: credential preflight could not resolve the access-token session identity from iapub; continuing with reactive error guidance only'
      )
    );
  }

  const result = crossCheckIdentities({
    pmak,
    session,
    workspaceTeamId: args.workspaceTeamId,
    explicitTeamId: args.explicitTeamId,
    mode: args.mode,
    mask
  });
  if (!result.message) {
    return;
  }
  if (result.level === 'fail') {
    throw new Error(result.message);
  }
  if (result.level === 'note') {
    args.log.warning(result.message);
    return;
  }
  args.log.info(result.message);
}

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

export type PreflightMode = 'enforce' | 'warn';

export interface ResolvePmakIdentityOptions {
  apiBaseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export interface ResolveSessionIdentityOptions {
  iapubBaseUrl: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  /** Max attempts for transient (network / 429 / 5xx) iapub failures (default 3). */
  maxAttempts?: number;
  /**
   * Injectable clock for deterministic retry tests: the computed wait (ms) is
   * passed here so the suite advances without real time. Defaults to setTimeout.
   */
  sleepImpl?: (ms: number) => Promise<void>;
  /**
   * Injectable RNG for the full-jitter backoff fallback, so the jittered path is
   * deterministic under test. Defaults to Math.random.
   */
  randomImpl?: () => number;
}

/**
 * Why the last session-identity resolution failed, when it did:
 * - `auth`: iapub rejected the token (401/403) - it is invalid or expired.
 * - `unavailable`: network error, 5xx after retries, or a non-auth non-2xx.
 * Lets callers distinguish "token invalid" from "iapub temporarily unreachable"
 * instead of collapsing every miss to "no session" (which reads as non-org).
 */
export type SessionResolutionFailure = 'auth' | 'unavailable';

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
  /** Injectable clock threaded into session-identity retries for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Injectable RNG threaded into the session-retry full-jitter fallback for tests. */
  randomImpl?: () => number;
}

const sessionPath = '/api/sessions/current';

type JsonRecord = Record<string, unknown>;

const SESSION_MAX_ATTEMPTS = 3;
const SESSION_RETRY_BASE_DELAY_MS = 500;
const SESSION_RETRY_MAX_DELAY_MS = 8000;

const pmakMemo = new Map<string, Promise<CredentialIdentity | undefined>>();
const sessionMemo = new Map<string, Promise<CredentialIdentity | undefined>>();
let memoizedSessionIdentity: CredentialIdentity | undefined;
let memoizedSessionFailure: SessionResolutionFailure | undefined;

function defaultSessionSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultRandom(): number {
  return Math.random();
}

/**
 * Parse an HTTP `Retry-After` value (RFC 7231): either delta-seconds or an
 * HTTP-date. Returns milliseconds, or undefined when absent/unparseable. A past
 * date clamps to 0 (retry now).
 */
function parseRetryAfterMs(value: string | null): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

/**
 * Parse a `RateLimit-Reset` header. IETF ratelimit uses seconds-until-reset;
 * some servers emit an absolute epoch (seconds). Values that look like an epoch
 * (greater than "now" in seconds) are treated as absolute and converted to a
 * delta. Returns milliseconds, or undefined when absent/unparseable.
 */
function parseRateLimitResetMs(value: string | null): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const seconds = Number(trimmed);
  const nowSeconds = Date.now() / 1000;
  if (seconds > nowSeconds) {
    return Math.max(0, (seconds - nowSeconds) * 1000);
  }
  return seconds * 1000;
}

/**
 * Event-based backoff: prefer a server-provided wait signal (`Retry-After`,
 * then `RateLimit-Reset`/`x-ratelimit-reset`), clamped to [0, maxDelayMs] so a
 * rogue large value cannot stall CI. With no signal (or a network-level failure
 * where `response` is undefined), fall back to full-jitter exponential:
 * random in [0, min(maxDelayMs, baseDelayMs * 2^(attempt-1))].
 */
function computeSessionRetryDelayMs(
  response: Response | undefined,
  attempt: number,
  random: () => number
): number {
  const headers = response?.headers;
  const signal =
    parseRetryAfterMs(headers?.get('retry-after') ?? null) ??
    parseRateLimitResetMs(
      headers?.get('ratelimit-reset') ?? headers?.get('x-ratelimit-reset') ?? null
    );
  if (signal !== undefined) {
    return Math.min(Math.max(0, signal), SESSION_RETRY_MAX_DELAY_MS);
  }
  const ceiling = Math.min(SESSION_RETRY_MAX_DELAY_MS, SESSION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
  return Math.round(random() * ceiling);
}

/** Test-only: clears the in-process identity memos so cases cannot bleed into each other. */
export function __resetIdentityMemo(): void {
  pmakMemo.clear();
  sessionMemo.clear();
  memoizedSessionIdentity = undefined;
  memoizedSessionFailure = undefined;
}

/** Last session identity resolved in this process, for reactive error-advice context. */
export function getMemoizedSessionIdentity(): CredentialIdentity | undefined {
  return memoizedSessionIdentity;
}

/**
 * Why the last session-identity resolution failed in this process, or `undefined`
 * when the most recent resolve succeeded (or none has run). Cleared on success.
 */
export function getSessionResolutionFailure(): SessionResolutionFailure | undefined {
  return memoizedSessionFailure;
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
    pending = probeSessionIdentity(
      baseUrl,
      accessToken,
      opts.fetchImpl ?? fetch,
      Math.max(1, opts.maxAttempts ?? SESSION_MAX_ATTEMPTS),
      opts.sleepImpl ?? defaultSessionSleep,
      opts.randomImpl ?? defaultRandom
    );
    sessionMemo.set(memoKey, pending);
  }
  return pending;
}

/**
 * Parse a 2xx iapub session body into a whitelisted identity. iapub wraps the
 * live session under `session`; an unwrapped shape is tolerated. Only the
 * whitelisted fields are lifted - the raw body (including session.token) is
 * discarded. Returns undefined on an unparseable/empty body.
 */
async function parseSessionResponse(response: Response): Promise<CredentialIdentity | undefined> {
  let payload: JsonRecord | undefined;
  try {
    payload = asRecord(await response.json());
  } catch {
    return undefined;
  }
  if (!payload) {
    return undefined;
  }
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
  const roles = roleEntries.length > 0 ? roleEntries : singleRole ? [singleRole] : undefined;
  return {
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
}

/**
 * Resolve the session identity from iapub with status-aware, event-based
 * retries. Transient failures (network errors, 429, 5xx) are retried; the wait
 * honors a server signal (`Retry-After`, then `RateLimit-Reset`) when present
 * and otherwise uses full-jitter exponential backoff - never a fixed sleep. A
 * 401/403 is a deterministic auth failure (expired/invalid token) and is NOT
 * retried; other non-2xx are treated as terminal-unavailable. On terminal
 * failure it records the reason (see getSessionResolutionFailure) and returns
 * undefined, so callers can tell "token invalid" from "iapub unreachable"
 * instead of assuming non-org. On success the failure memo is cleared.
 */
async function probeSessionIdentity(
  baseUrl: string,
  accessToken: string,
  fetchImpl: typeof fetch,
  maxAttempts: number,
  sleepImpl: (ms: number) => Promise<void>,
  random: () => number
): Promise<CredentialIdentity | undefined> {
  let failure: SessionResolutionFailure = 'unavailable';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${sessionPath}`, {
        method: 'GET',
        headers: { 'x-access-token': accessToken }
      });
    } catch {
      // Network-level failure: transient. No response to read a signal from, so
      // fall back to full jitter and retry.
      failure = 'unavailable';
      if (attempt < maxAttempts) {
        await sleepImpl(computeSessionRetryDelayMs(undefined, attempt, random));
        continue;
      }
      break;
    }

    if (response.ok) {
      const resolved = await parseSessionResponse(response);
      if (resolved) {
        memoizedSessionIdentity = resolved;
        memoizedSessionFailure = undefined;
        return resolved;
      }
      // 2xx but unparseable/empty: deterministic, no retry.
      failure = 'unavailable';
      break;
    }

    if (response.status === 401 || response.status === 403) {
      // Deterministic auth failure: the token is invalid or expired. No retry.
      failure = 'auth';
      break;
    }

    if (response.status === 429 || response.status >= 500) {
      // Transient (rate-limited or server-side): honor a server wait signal
      // when present, else full jitter.
      failure = 'unavailable';
      if (attempt < maxAttempts) {
        await sleepImpl(computeSessionRetryDelayMs(response, attempt, random));
        continue;
      }
      break;
    }

    // Other non-2xx (e.g. 400/404): deterministic, no retry.
    failure = 'unavailable';
    break;
  }
  memoizedSessionFailure = failure;
  return undefined;
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
      fetchImpl: args.fetchImpl,
      ...(args.sleepImpl ? { sleepImpl: args.sleepImpl } : {}),
      ...(args.randomImpl ? { randomImpl: args.randomImpl } : {})
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
    const consumerType = session.consumerType?.trim();
    if (consumerType && consumerType.toLowerCase() !== 'service_account') {
      args.log.warning(
        mask(
          `postman: deprecation warning - postman-access-token resolved to consumerType ${consumerType}. postman-cs/postman-resolve-service-token-action is the primary CI path for service-account access tokens. The Postman CLI credential store populated by \`postman login\` is a legacy fallback for migration only.`
        )
      );
    }
  } else {
    // An access token was supplied but its iapub session did not resolve. This is
    // the load-bearing signal for org-mode detection and team scope, so do not
    // silently continue as if it were merely diagnostic. Distinguish an expired/
    // invalid token from a transient iapub outage, and under `enforce` fail closed
    // rather than degrading into a create path that later 403s with a misleading
    // "not authorized" instead of the real cause.
    const failure = getSessionResolutionFailure();
    const detail =
      failure === 'auth'
        ? 'the access token was rejected by iapub (401/403), so it is invalid or expired. Re-mint it with postman-resolve-service-token-action (or POST https://api.getpostman.com/service-account-tokens) and re-run.'
        : 'iapub was unreachable after retries (network or 5xx). This is usually transient; re-run the job.';
    const base =
      'postman: credential preflight could not resolve the access-token session identity from iapub: ' +
      detail;
    if (args.mode === 'enforce') {
      throw new Error(
        mask(
          `${base} (credential-preflight: enforce requires a resolvable session identity; use credential-preflight: warn to continue with reactive error guidance only.)`
        )
      );
    }
    args.log.warning(
      mask(`${base} Continuing with reactive error guidance only (credential-preflight: warn).`)
    );
    return;
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

export type PmakDiagnosticKind = 'personal' | 'service-account' | 'invalid' | 'inconclusive';
export type PmakDiagnosticResult = { kind: PmakDiagnosticKind; status?: number; payload?: Record<string, unknown> };

export function maskPmakDiagnostic(message: string, secrets: readonly (string | undefined)[]): string {
  let value = String(message);
  for (const secret of secrets) if (secret) value = value.split(secret).join('***');
  // eslint-disable-next-line no-control-regex -- diagnostic output must be one-line safe.
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function formatRejectedMint(original: string, result: PmakDiagnosticResult): string {
  if (result.kind === 'personal') return `${original} Personal API key detected, cannot mint a service-account access token.`;
  if (result.kind === 'service-account') return `${original} postman-api-key authenticates (GET /me OK) but was rejected by POST /service-account-tokens and lacks permission to mint access tokens.`;
  if (result.kind === 'invalid') return `${original} postman-api-key is invalid, disabled, or expired.`;
  return original;
}

export async function inspectPmakIdentity(options: {
  apiBaseUrl: string; apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal; mode?: 'diagnostic' | 'preflight';
}): Promise<PmakDiagnosticResult> {
  const base = new URL(options.apiBaseUrl.trim()).toString().replace(/\/+$/, '');
  const mode = options.mode ?? 'diagnostic';
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 2000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const response = await (options.fetchImpl ?? fetch)(`${base}/me`, { method: 'GET', headers: { 'x-api-key': options.apiKey }, signal });
    if (response.status === 401 || response.status === 403) return { kind: 'invalid', status: response.status };
    if (!response.ok) return { kind: 'inconclusive', status: response.status };
    const parsed = await response.json() as Record<string, unknown>;
    const user = parsed.user;
    if (!user || typeof user !== 'object' || Array.isArray(user)) {
      return mode === 'preflight' ? { kind: 'service-account', payload: parsed } : { kind: 'inconclusive' };
    }
    const record = user as Record<string, unknown>;
    if (typeof record.username === 'string' && record.username || typeof record.email === 'string' && record.email) return { kind: 'personal', payload: parsed };
    if (Object.hasOwn(record, 'username') && Object.hasOwn(record, 'email') && (record.username == null || record.username === '') && (record.email == null || record.email === '')) return { kind: 'service-account', payload: parsed };
    return mode === 'preflight' ? { kind: 'service-account', payload: parsed } : { kind: 'inconclusive' };
  } catch { return { kind: 'inconclusive' }; }
}

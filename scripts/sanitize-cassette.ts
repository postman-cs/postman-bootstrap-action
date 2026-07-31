import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CASSETTE_MINTED_TOKEN,
  cassetteRequest,
  type Cassette,
  type CassetteInteraction
} from '@postman-cse/automation-core/cassette';

const REDACTED = '[REDACTED]';
const REDACTED_REPOSITORY = '[REDACTED-REPOSITORY]';
const FIXED_ISO_TIMESTAMP = '2000-01-01T00:00:00.000Z';
const FIXED_HTTP_TIMESTAMP = 'Sat, 01 Jan 2000 00:00:00 GMT';
const USAGE =
  'Usage: node --experimental-strip-types scripts/sanitize-cassette.ts integration/cassettes/raw/<name>.json [tests/contract/cassettes/<name>.json]';

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const POSTMAN_UID_PATTERN = /\b\d{3,}-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const OBJECT_ID_PATTERN = /\b[0-9a-f]{24}\b/gi;
const ISO_TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
const HTTP_TIMESTAMP_PATTERN = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT\b/g;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const REPOSITORY_URL_PATTERN = /(?:https?:\/\/|ssh:\/\/|git@)(?:[^\s/@]+@)?(?:github\.com|gitlab\.com|bitbucket\.org|dev\.azure\.com|ssh\.dev\.azure\.com)[^\s"'<>\\]*/gi;
const ENCODED_REPOSITORY_URL_PATTERN = /(?:https?|ssh)%3A%2F%2F(?:github\.com|gitlab\.com|bitbucket\.org|dev\.azure\.com|ssh\.dev\.azure\.com)[^&# ]*/gi;
const PMAK_PATTERN = /\bPMAK-[A-Z0-9._-]+\b/gi;
const POSTMAN_TOKEN_PATTERN = /\b(?:PMAT|PMSA|PMSC)-[A-Z0-9._-]+\b/gi;
const JWT_PATTERN = /\beyJ[A-Z0-9_-]{8,}\.[A-Z0-9_-]{8,}(?:\.[A-Z0-9_-]{8,})?\b/gi;
const LIVE_BEARER_PATTERN = /\bBearer\s+(?!(?:\[REDACTED\]|\{\{))[^\s,"'}]{12,}/gi;
const BODY_DIGEST_SEGMENT = /(#body-sha256=[0-9a-f]{64})/gi;

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-access-token',
  'x-api-key'
]);
const SENSITIVE_RESPONSE_HEADER_NAMES = new Set([
  ...SENSITIVE_HEADER_NAMES,
  'cookie',
  'set-cookie'
]);
const SENSITIVE_VALUE_NAMES = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'postmanaccessToken'.toLowerCase(),
  'postmanapikey',
  'serviceaccounttoken',
  'token',
  'x-access-token',
  'x-api-key'
]);

type EntityCategory =
  | 'collection'
  | 'run'
  | 'specification'
  | 'team'
  | 'uid'
  | 'user'
  | 'workspace';

interface Candidate {
  numeric: boolean;
  values: Set<string>;
}

interface Replacement {
  numeric: boolean;
  value: string | number;
}

interface ReplacementPlan {
  entities: Map<string, Replacement>;
  secrets: Map<string, string>;
}

type JsonRecord = Record<string, unknown>;

type RawCassetteInteraction = CassetteInteraction & { rawRequestBody?: unknown };

const CATEGORY_ORDER: EntityCategory[] = [
  'workspace',
  'specification',
  'collection',
  'team',
  'user',
  'run',
  'uid'
];

const NUMERIC_PLACEHOLDER_BASE: Record<EntityCategory, number> = {
  workspace: -3_000,
  specification: -4_000,
  collection: -5_000,
  team: -1_000,
  user: -2_000,
  run: -6_000,
  uid: -7_000
};
const SYNTHETIC_NUMERIC_PLACEHOLDERS: Partial<Record<EntityCategory, ReadonlySet<number>>> = {
  team: new Set([1001, 1002]),
  user: new Set([2001, 2002])
};

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

function isMintKey(key: string): boolean {
  return /^POST https?:\/\/[^ ]+\/service-account-tokens(?:[? ]|$)/.test(key);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)])
  );
}

export function stableCassetteJson(cassette: Cassette): string {
  return `${JSON.stringify(stableValue(cassette), null, 2)}\n`;
}

function validateCassette(value: unknown): asserts value is Cassette {
  const cassette = asRecord(value);
  if (!cassette || cassette.version !== 2 || !Array.isArray(cassette.interactions)) {
    throw new Error('Raw cassette must be a Cassette v2 object with an interactions array');
  }
  for (const [index, candidate] of cassette.interactions.entries()) {
    const interaction = asRecord(candidate);
    if (
      !interaction ||
      typeof interaction.key !== 'string' ||
      typeof interaction.requestQuery !== 'string' ||
      typeof interaction.status !== 'number' ||
      typeof interaction.body !== 'string' ||
      !asRecord(interaction.responseHeaders)
    ) {
      throw new Error(`Raw cassette interaction ${index} does not match CassetteInteraction`);
    }
  }
}

function createCandidates(): Record<EntityCategory, Candidate> {
  return Object.fromEntries(
    CATEGORY_ORDER.map((category) => [category, { numeric: false, values: new Set<string>() }])
  ) as Record<EntityCategory, Candidate>;
}

function placeholderPattern(category: EntityCategory): RegExp {
  return new RegExp(`^cassette-${category}-\\d+$`);
}

function isNumericPlaceholder(value: number, category: EntityCategory): boolean {
  if (SYNTHETIC_NUMERIC_PLACEHOLDERS[category]?.has(value)) return true;
  const base = NUMERIC_PLACEHOLDER_BASE[category];
  return value <= base - 1 && value > base - 1_000;
}

function isEntityPlaceholder(value: unknown, category: EntityCategory): boolean {
  if (typeof value === 'number') return isNumericPlaceholder(value, category);
  if (typeof value !== 'string') return false;
  if (category === 'uid' && /^00000000-0000-4000-8000-\d{12}$/.test(value)) return true;
  if (/^-?\d+$/.test(value) && isNumericPlaceholder(Number(value), category)) return true;
  return placeholderPattern(category).test(value);
}

function addCandidate(
  candidates: Record<EntityCategory, Candidate>,
  category: EntityCategory,
  value: unknown
): void {
  if (typeof value !== 'string' && typeof value !== 'number') return;
  if (isEntityPlaceholder(value, category)) return;
  const normalized = String(value).trim();
  if (/^-?\d+$/.test(normalized) && isNumericPlaceholder(Number(normalized), category)) return;
  if (!normalized || normalized === REDACTED) return;
  candidates[category].values.add(normalized);
  if (typeof value === 'number') candidates[category].numeric = true;
}

function routeCategory(key: string): EntityCategory | undefined {
  if (/proxy:workspaces\b/.test(key) || /\/workspaces(?:[/? #]|$)/.test(key)) return 'workspace';
  if (/proxy:specification\b/.test(key) || /\/specifications(?:[/? #]|$)/.test(key)) {
    return 'specification';
  }
  if (
    /proxy:(?:collection|sync|tagging)\b/.test(key) ||
    /\/collections?(?:[/? #]|$)/.test(key)
  ) {
    return 'collection';
  }
  if (/proxy:(?:ums|god)\b/.test(key) || /\/(?:teams|users|members|squads)(?:[/? #]|$)/.test(key)) {
    return 'team';
  }
  return undefined;
}

function categoryForPath(path: string[], interactionKey: string): EntityCategory | undefined {
  const name = normalizeName(path.at(-1) ?? '');
  const ancestors = path.slice(0, -1).map(normalizeName);
  if (/^(?:runid|githubrunid|correlationid|taskid)$/.test(name)) return 'run';
  if (/^(?:team|teamid|organization|organizationid|squad|squadid)$/.test(name)) return 'team';
  if (/^(?:user|userid|createdby|updatedby|ownerid|requesterid)$/.test(name)) return 'user';
  if (/^(?:workspace|workspaceid|workspaceuid)$/.test(name)) return 'workspace';
  if (/^(?:spec|specid|specification|specificationid|specificationuid)$/.test(name)) {
    return 'specification';
  }
  if (/^(?:collection|collectionid|collectionuid|modelid|postmanid)$/.test(name)) {
    return 'collection';
  }
  if (/^(?:uid|fileid|delegateeid|pubid|installationuid)$/.test(name)) return 'uid';
  if (name !== 'id') return undefined;
  if (ancestors.some((entry) => /^(?:user|users|member|members|owner)$/.test(entry))) return 'user';
  if (ancestors.some((entry) => /^(?:team|teams|organization|squad|squads)$/.test(entry))) {
    return 'team';
  }
  if (ancestors.some((entry) => /workspace/.test(entry))) return 'workspace';
  if (ancestors.some((entry) => /spec/.test(entry))) return 'specification';
  if (ancestors.some((entry) => /collection/.test(entry))) return 'collection';
  return routeCategory(interactionKey) ?? 'uid';
}

function categoryForEntry(
  record: JsonRecord,
  name: string,
  path: string[],
  interactionKey: string
): EntityCategory | undefined {
  if (normalizeName(name) === 'ownerid') {
    const ownerType = normalizeName(String(record.ownerType ?? record.owner_type ?? ''));
    if (ownerType === 'team' || ownerType === 'organization') return 'team';
    if (ownerType === 'user') return 'user';
  }
  return categoryForPath([...path, name], interactionKey);
}

function isSensitiveName(name: string): boolean {
  return SENSITIVE_VALUE_NAMES.has(normalizeName(name));
}

function collectFromBody(
  value: unknown,
  path: string[],
  interactionKey: string,
  candidates: Record<EntityCategory, Candidate>,
  secrets: Map<string, string>
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectFromBody(entry, [...path, String(index)], interactionKey, candidates, secrets)
    );
    return;
  }
  const record = asRecord(value);
  if (record) {
    for (const [name, entry] of Object.entries(record)) {
      const normalizedName = normalizeName(name);
      if (isSensitiveName(name) && (typeof entry === 'string' || typeof entry === 'number')) {
        const raw = String(entry).trim();
        if (raw) {
          secrets.set(
            raw,
            normalizedName === 'accesstoken' && isMintKey(interactionKey)
              ? CASSETTE_MINTED_TOKEN
              : REDACTED
          );
        }
      } else {
        const category = categoryForEntry(record, name, path, interactionKey);
        if (category) addCandidate(candidates, category, entry);
      }
      collectFromBody(entry, [...path, name], interactionKey, candidates, secrets);
    }
    return;
  }
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\[bootstrap:([^\]]+)\]/g)) {
      addCandidate(candidates, 'run', match[1] ?? '');
    }
    for (const match of value.matchAll(POSTMAN_UID_PATTERN)) addCandidate(candidates, 'uid', match[0]);
    for (const match of value.matchAll(UUID_PATTERN)) addCandidate(candidates, 'uid', match[0]);
    for (const match of value.matchAll(OBJECT_ID_PATTERN)) addCandidate(candidates, 'uid', match[0]);
  }
}

function collectRequestSecrets(
  value: unknown,
  interactionKey: string,
  secrets: Map<string, string>
): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectRequestSecrets(entry, interactionKey, secrets));
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [name, entry] of Object.entries(record)) {
    const normalizedName = normalizeName(name);
    if (isSensitiveName(name) && (typeof entry === 'string' || typeof entry === 'number')) {
      const raw = String(entry).trim();
      if (raw) {
        secrets.set(
          raw,
          normalizedName === 'accesstoken' && isMintKey(interactionKey)
            ? CASSETTE_MINTED_TOKEN
            : REDACTED
        );
      }
    }
    collectRequestSecrets(entry, interactionKey, secrets);
  }
}

function collectRouteIds(
  key: string,
  candidates: Record<EntityCategory, Candidate>
): void {
  const routePatterns: Array<[EntityCategory, RegExp]> = [
    ['workspace', /\/workspaces\/(?!(?:filesystem)(?:[/? #]|$))([^/? #]+)/g],
    ['specification', /\/specifications\/([^/? #]+)/g],
    ['collection', /\/(?:collections|deepupdate)\/([^/? #]+)/g],
    ['collection', /\/collection\/(?!(?:import|deepupdate)(?:[/? #]|$))([^/? #]+)/g],
    ['team', /\/(?:teams|organizations|squads)\/([^/? #]+)/g],
    ['user', /\/(?:users|members)\/([^/? #]+)/g]
  ];
  for (const [category, pattern] of routePatterns) {
    for (const match of key.matchAll(pattern)) addCandidate(candidates, category, decodeURIComponent(match[1] ?? ''));
  }
  const queryPatterns: Array<[EntityCategory, RegExp]> = [
    ['workspace', /[?&](?:workspace|workspaceId)=([^&# ]+)/g],
    ['specification', /[?&](?:spec|specification|specificationId)=([^&# ]+)/g],
    ['collection', /[?&](?:collection|collectionId)=([^&# ]+)/g]
  ];
  for (const [category, pattern] of queryPatterns) {
    for (const match of key.matchAll(pattern)) addCandidate(candidates, category, decodeURIComponent(match[1] ?? ''));
  }
}

function replacementPlan(cassette: Cassette): ReplacementPlan {
  const candidates = createCandidates();
  const secrets = new Map<string, string>();
  for (const interaction of cassette.interactions) {
    collectRouteIds(interaction.key, candidates);
    try {
      collectFromBody(JSON.parse(interaction.body), [], interaction.key, candidates, secrets);
    } catch {
      collectFromBody(interaction.body, [], interaction.key, candidates, secrets);
    }
    const rawRequestBody = (interaction as RawCassetteInteraction).rawRequestBody;
    if (typeof rawRequestBody === 'string') {
      try {
        collectRequestSecrets(JSON.parse(rawRequestBody), interaction.key, secrets);
      } catch {
        // A non-JSON request has no named secret field to inspect; do not infer
        // identity replacements from raw request bytes.
      }
    }
    for (const [name, value] of Object.entries(interaction.responseHeaders)) {
      if (SENSITIVE_RESPONSE_HEADER_NAMES.has(name.toLowerCase()) && value !== REDACTED) {
        secrets.set(value, REDACTED);
      }
    }
  }

  const entities = new Map<string, Replacement>();
  for (const category of CATEGORY_ORDER) {
    const values = [...candidates[category].values].sort((left, right) => left.localeCompare(right));
    values.forEach((raw, index) => {
      if (entities.has(raw) || secrets.has(raw)) return;
      const numeric = candidates[category].numeric && /^-?\d+$/.test(raw);
      entities.set(raw, {
        numeric,
        value: numeric
          ? NUMERIC_PLACEHOLDER_BASE[category] - index - 1
          : `cassette-${category}-${index + 1}`
      });
    });
  }
  return { entities, secrets };
}

function replaceLiteral(value: string, raw: string, replacement: string): string {
  let result = value.split(raw).join(replacement);
  const encoded = encodeURIComponent(raw);
  if (encoded !== raw) result = result.split(encoded).join(encodeURIComponent(replacement));
  return result;
}

function applyPlanReplacements(value: string, plan: ReplacementPlan): string {
  let sanitized = value;
  const replacements = [
    ...[...plan.secrets].map(([raw, replacement]) => ({ raw, replacement })),
    ...[...plan.entities].map(([raw, replacement]) => ({
      raw,
      replacement: String(replacement.value)
    }))
  ].sort((left, right) => right.raw.length - left.raw.length || left.raw.localeCompare(right.raw));
  for (const { raw, replacement } of replacements) {
    sanitized = replaceLiteral(sanitized, raw, replacement);
  }
  return sanitized;
}

function sanitizeTextSegment(value: string, plan: ReplacementPlan): string {
  const sanitized = applyPlanReplacements(value, plan);
  return sanitized
    .replace(POSTMAN_UID_PATTERN, (match) => `cassette-uid-${match.length}`)
    .replace(UUID_PATTERN, (match) =>
      /^00000000-0000-4000-8000-\d{12}$/.test(match)
        ? match
        : `cassette-uid-${match.length}`
    )
    .replace(OBJECT_ID_PATTERN, (match) => `cassette-uid-${match.length}`)
    .replace(ISO_TIMESTAMP_PATTERN, FIXED_ISO_TIMESTAMP)
    .replace(HTTP_TIMESTAMP_PATTERN, FIXED_HTTP_TIMESTAMP)
    .replace(ENCODED_REPOSITORY_URL_PATTERN, encodeURIComponent(REDACTED_REPOSITORY))
    .replace(REPOSITORY_URL_PATTERN, REDACTED_REPOSITORY)
    .replace(EMAIL_PATTERN, REDACTED)
    .replace(PMAK_PATTERN, REDACTED)
    .replace(POSTMAN_TOKEN_PATTERN, REDACTED)
    .replace(JWT_PATTERN, REDACTED)
    .replace(LIVE_BEARER_PATTERN, REDACTED);
}

function sanitizeText(value: string, plan: ReplacementPlan): string {
  return value
    .split(BODY_DIGEST_SEGMENT)
    .map((segment) =>
      /^#body-sha256=[0-9a-f]{64}$/i.test(segment) ? segment : sanitizeTextSegment(segment, plan)
    )
    .join('');
}

function sanitizeBodyValue(
  value: unknown,
  plan: ReplacementPlan,
  interactionKey: string,
  propertyName = ''
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeBodyValue(entry, plan, interactionKey));
  }
  const record = asRecord(value);
  if (record) {
    const sanitized = Object.fromEntries(
      Object.entries(record)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, entry]) => {
          const normalizedName = normalizeName(name);
          if (isSensitiveName(name)) {
            if (normalizedName === 'accesstoken' && isMintKey(interactionKey)) {
              return [name, CASSETTE_MINTED_TOKEN];
            }
            return [name, REDACTED];
          }
          return [name, sanitizeBodyValue(entry, plan, interactionKey, name)];
        })
    );
    const headerName = String(sanitized.key ?? sanitized.name ?? '').toLowerCase();
    if (SENSITIVE_HEADER_NAMES.has(headerName) && 'value' in sanitized) sanitized.value = REDACTED;
    return sanitized;
  }
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const entityReplacement = plan.entities.get(raw);
  if (entityReplacement) {
    return typeof value === 'number' && entityReplacement.numeric
      ? entityReplacement.value
      : String(entityReplacement.value);
  }
  const secretReplacement = plan.secrets.get(raw);
  if (secretReplacement) return secretReplacement;
  if (typeof value === 'string') {
    if (isSensitiveName(propertyName)) {
      return normalizeName(propertyName) === 'accesstoken' && isMintKey(interactionKey)
        ? CASSETTE_MINTED_TOKEN
        : REDACTED;
    }
    return sanitizeText(value, plan);
  }
  return value;
}

function sanitizeBody(body: string, plan: ReplacementPlan, interactionKey: string): string {
  try {
    return JSON.stringify(sanitizeBodyValue(JSON.parse(body), plan, interactionKey));
  } catch {
    return sanitizeText(body, plan);
  }
}

function sanitizeRequestBody(body: string, plan: ReplacementPlan): string {
  // Request bytes are part of the replay key. Replace values without reserializing
  // JSON, and only substitute values proven by the replacement plan. Generic
  // redaction would alter request-only generated IDs that the replay emits again.
  return applyPlanReplacements(body, plan);
}

function recomputeRequest(
  key: string,
  rawRequestBody: string
): Pick<CassetteInteraction, 'key' | 'requestQuery' | 'requestBodySha256'> {
  if (key.startsWith('proxy:')) {
    return cassetteRequest('https://cassette.invalid/ws/proxy', 'POST', rawRequestBody);
  }
  const match = /^([A-Z]+) (https?:\/\/[^ ?#]+)(?:\?([^ #]*))?/.exec(key);
  if (!match) {
    throw new Error(`Cannot recompute cassette request from key "${key}"`);
  }
  const [, method, originAndPath, query = ''] = match;
  return cassetteRequest(
    `${originAndPath}${query ? `?${query}` : ''}`,
    method,
    rawRequestBody
  );
}

function sanitizeInteraction(
  interaction: CassetteInteraction,
  plan: ReplacementPlan
): CassetteInteraction {
  const rawRequestBody = (interaction as RawCassetteInteraction).rawRequestBody;
  if (rawRequestBody !== undefined && typeof rawRequestBody !== 'string') {
    throw new Error('Raw cassette interaction rawRequestBody must be a string');
  }
  const sanitizedKey = sanitizeText(interaction.key, plan);
  const sanitizedRequestQuery = sanitizeText(interaction.requestQuery, plan);
  const sanitizedBody = sanitizeBody(interaction.body, plan, sanitizedKey);
  if (
    interaction.requestBodySha256 &&
    rawRequestBody === undefined &&
    (sanitizedKey !== interaction.key ||
      sanitizedRequestQuery !== interaction.requestQuery ||
      sanitizedBody !== interaction.body)
  ) {
    throw new Error(
      'Cannot sanitize digest-bearing raw cassette interaction without rawRequestBody for safe rekeying'
    );
  }
  const request = rawRequestBody === undefined
    ? {
        key: sanitizedKey,
        requestQuery: sanitizedRequestQuery,
        ...(interaction.requestBodySha256 ? { requestBodySha256: interaction.requestBodySha256 } : {})
      }
    : recomputeRequest(sanitizedKey, sanitizeRequestBody(rawRequestBody, plan));
  const responseHeaders = Object.fromEntries(
    Object.entries(interaction.responseHeaders)
      .map(([name, value]) => {
        const normalizedName = name.toLowerCase();
        return [
          normalizedName,
          SENSITIVE_RESPONSE_HEADER_NAMES.has(normalizedName) ? REDACTED : sanitizeText(value, plan)
        ];
      })
      .sort(([left], [right]) => left.localeCompare(right))
  );
  return {
    ...request,
    status: interaction.status,
    ...(interaction.statusText ? { statusText: interaction.statusText } : {}),
    body: sanitizedBody,
    responseHeaders,
    ...(interaction.repeatLast ? { repeatLast: true } : {})
  };
}

export function sanitizeCassette(raw: unknown): Cassette {
  validateCassette(raw);
  const plan = replacementPlan(raw);
  const sanitized: Cassette = {
    version: 2,
    ...(raw.recordedAt ? { recordedAt: FIXED_ISO_TIMESTAMP } : {}),
    interactions: raw.interactions.map((interaction) => sanitizeInteraction(interaction, plan))
  };
  assertCassetteRedacted(sanitized);
  return sanitized;
}

function assertNoForbiddenText(value: string, location: string): void {
  const forbidden: Array<[string, RegExp]> = [
    ['PMAK prefix', /\bPMAK-/i],
    ['Postman access/service-account token', /\b(?:PMAT|PMSA|PMSC)-/i],
    ['JWT access token', /\beyJ[A-Z0-9_-]{8,}\.[A-Z0-9_-]{8,}/i],
    ['live Authorization value', /\bBearer\s+(?!(?:\[REDACTED\]|\{\{))\S{12,}/i],
    ['email address', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
    [
      'repository URL',
      /(?:https?:\/\/|ssh:\/\/|git@)(?:[^\s/@]+@)?(?:github\.com|gitlab\.com|bitbucket\.org|dev\.azure\.com|ssh\.dev\.azure\.com)/i
    ],
    [
      'encoded repository URL',
      /(?:https?|ssh)%3A%2F%2F(?:github\.com|gitlab\.com|bitbucket\.org|dev\.azure\.com|ssh\.dev\.azure\.com)/i
    ],
    ['Postman UID', /\b\d{3,}-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i],
    ['object UID', /\b[0-9a-f]{24}\b/i]
  ];
  for (const [label, pattern] of forbidden) {
    if (pattern.test(value)) throw new Error(`Cassette redaction invariant failed at ${location}: ${label}`);
  }
  for (const match of value.matchAll(UUID_PATTERN)) {
    if (!/^00000000-0000-4000-8000-\d{12}$/.test(match[0])) {
      throw new Error(`Cassette redaction invariant failed at ${location}: UUID`);
    }
  }
  for (const match of value.matchAll(ISO_TIMESTAMP_PATTERN)) {
    if (match[0] !== FIXED_ISO_TIMESTAMP) {
      throw new Error(`Cassette redaction invariant failed at ${location}: live timestamp`);
    }
  }
  for (const match of value.matchAll(HTTP_TIMESTAMP_PATTERN)) {
    if (match[0] !== FIXED_HTTP_TIMESTAMP) {
      throw new Error(`Cassette redaction invariant failed at ${location}: live HTTP timestamp`);
    }
  }
  for (const match of value.matchAll(/\[bootstrap:([^\]]+)\]/g)) {
    if (!/^cassette-run-\d+$/.test(match[1] ?? '')) {
      throw new Error(`Cassette redaction invariant failed at ${location}: live run ID`);
    }
  }
}

function assertSafeIdentityValue(
  name: string,
  value: unknown,
  category: EntityCategory,
  location: string
): void {
  if (!isEntityPlaceholder(value, category)) {
    const actualCategory = CATEGORY_ORDER.find((candidate) =>
      isEntityPlaceholder(value, candidate)
    );
    throw new Error(
      `Cassette redaction invariant failed at ${location}.${name}: real ${category} ID` +
        (actualCategory ? ` (parameterized as ${actualCategory})` : '')
    );
  }
}

function assertBodyRedacted(
  value: unknown,
  path: string[],
  location: string,
  interactionKey: string
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertBodyRedacted(entry, [...path, String(index)], location, interactionKey)
    );
    return;
  }
  const record = asRecord(value);
  if (record) {
    const headerName = String(record.key ?? record.name ?? '').toLowerCase();
    if (SENSITIVE_HEADER_NAMES.has(headerName) && record.value !== REDACTED) {
      throw new Error(`Cassette redaction invariant failed at ${location}: live ${headerName} header`);
    }
    for (const [name, entry] of Object.entries(record)) {
      const normalizedName = normalizeName(name);
      if (SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) && entry !== REDACTED) {
        throw new Error(`Cassette redaction invariant failed at ${location}: live ${name} header`);
      }
      if (isSensitiveName(name)) {
        const allowedMintToken = normalizedName === 'accesstoken' && entry === CASSETTE_MINTED_TOKEN;
        if (entry !== REDACTED && !allowedMintToken) {
          throw new Error(`Cassette redaction invariant failed at ${location}: live ${name} value`);
        }
      }
      const category = categoryForEntry(record, name, path, interactionKey);
      if (category && (typeof entry === 'string' || typeof entry === 'number')) {
        assertSafeIdentityValue(name, entry, category, location);
      }
      assertBodyRedacted(entry, [...path, name], location, interactionKey);
    }
    return;
  }
  if (typeof value === 'string') assertNoForbiddenText(value, location);
}

export function assertCassetteRedacted(value: unknown): asserts value is Cassette {
  validateCassette(value);
  if (value.recordedAt && value.recordedAt !== FIXED_ISO_TIMESTAMP) {
    throw new Error('Cassette redaction invariant failed at recordedAt: live timestamp');
  }
  value.interactions.forEach((interaction, index) => {
    const location = `interactions[${index}]`;
    if ('rawRequestBody' in interaction) {
      throw new Error(`Cassette redaction invariant failed at ${location}: rawRequestBody`);
    }
    assertNoForbiddenText(interaction.key, `${location}.key`);
    assertNoForbiddenText(interaction.requestQuery, `${location}.requestQuery`);
    for (const [name, headerValue] of Object.entries(interaction.responseHeaders)) {
      if (SENSITIVE_RESPONSE_HEADER_NAMES.has(name.toLowerCase()) && headerValue !== REDACTED) {
        throw new Error(`Cassette redaction invariant failed at ${location}: live ${name} header`);
      }
      assertNoForbiddenText(headerValue, `${location}.responseHeaders.${name}`);
    }
    try {
      assertBodyRedacted(JSON.parse(interaction.body), [], `${location}.body`, interaction.key);
    } catch (error) {
      if (error instanceof SyntaxError) assertNoForbiddenText(interaction.body, `${location}.body`);
      else throw error;
    }
  });
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !path.startsWith(`/`) && !path.startsWith('\\'));
}

export function sanitizeCassetteFile(rawPath: string, outputPath: string): Cassette {
  const raw = JSON.parse(readFileSync(rawPath, 'utf8')) as unknown;
  const sanitized = sanitizeCassette(raw);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, stableCassetteJson(sanitized));
  return sanitized;
}

function runCli(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const packageRoot = process.cwd();
  const rawRoot = resolve(packageRoot, 'integration/cassettes/raw');
  const committedRoot = resolve(packageRoot, 'tests/contract/cassettes');
  const rawArgument = args[0];
  if (!rawArgument) {
    throw new Error(USAGE);
  }
  const rawPath = resolve(packageRoot, rawArgument);
  const outputPath = resolve(
    packageRoot,
    args[1] ?? `tests/contract/cassettes/${basename(rawPath).replace(/\.raw(?=\.json$)/, '')}`
  );
  if (!isWithin(rawRoot, rawPath)) {
    throw new Error('Raw cassette input must be under integration/cassettes/raw/');
  }
  if (!isWithin(committedRoot, outputPath) || !outputPath.endsWith('.json')) {
    throw new Error('Sanitized cassette output must be a JSON file under tests/contract/cassettes/');
  }
  sanitizeCassetteFile(rawPath, outputPath);
  console.log(relative(packageRoot, outputPath));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2));
}

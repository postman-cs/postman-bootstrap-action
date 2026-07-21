#!/usr/bin/env node
/**
 * R5 live Spec Hub multi-file capability probe.
 *
 * Uses the same access-token Bifrost /ws/proxy request profile as production
 * AccessTokenGatewayClient. Credentials resolve through the root .env / e2e leg
 * conventions (never ambient POSTMAN_API_KEY for the wrong team).
 *
 *   node scripts/probe-multifile-spec-sync.mjs --leg nonorg
 *   node scripts/probe-multifile-spec-sync.mjs --leg org
 *
 * Writes a sanitized receipt to validation/evidence/multifile-spec-sync.json.
 * Org and non-org must run serially. All created resources are journaled and
 * deleted in finally; teams are never wiped.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(REPO_ROOT, '../..');
const ENV_FILE = path.join(WORKSPACE_ROOT, '.env');
const RECEIPT_PATH = path.join(REPO_ROOT, 'validation/evidence/multifile-spec-sync.json');

const API = 'https://api.getpostman.com';
const BIFROST = 'https://bifrost-premium-https-v4.gw.postman.com';

export const SANDBOX_TEAM_ID = '10490519';
export const ORG_PARENT_TEAM_ID = '13347347';
export const ORG_WORKSPACE_TEAM_ID = '132319';

export const REQUIRED_LEG_MODES = ['nonorg', 'org'];
export const REQUIRED_PROBE_IDS = [
  'P01',
  'P02',
  'P03',
  'P04',
  'P05',
  'P06',
  'P07',
  'P08',
  'P09',
  'P10',
  'P11'
];
export const CAPABILITY_KEYS = [
  'multiFileCreate',
  'multiFileRead',
  'perFileCreate',
  'perFilePatch',
  'perFileDelete',
  'bulkModify',
  'atomicBulk',
  'rootPathChange',
  'openapiGeneration',
  'protobufGeneration'
];

const REQUEST_TIMEOUT_MS = 30_000;
const GENERATION_POLL_ATTEMPTS = Number(process.env.POSTMAN_GENERATION_POLL_ATTEMPTS || 180);
const GENERATION_POLL_DELAY_MS = Number(process.env.POSTMAN_GENERATION_POLL_DELAY_MS || 1000);

const ROOT_OPENAPI = [
  'openapi: 3.0.3',
  'info:',
  '  title: MultiFile Spec Sync Probe',
  '  version: 1.0.0',
  'paths:',
  '  /pets:',
  '    post:',
  '      operationId: createPet',
  '      summary: Create pet',
  '      requestBody:',
  '        required: true',
  '        content:',
  '          application/json:',
  '            schema:',
  "              $ref: './components/pet.yaml'",
  '      responses:',
  "        '200':",
  '          description: OK'
].join('\n');

function petDependency(sentinel) {
  return [
    'type: object',
    'required:',
    '  - name',
    'properties:',
    '  name:',
    '    type: string',
    `    example: ${sentinel}`
  ].join('\n');
}

const PROTO_ROOT = [
  'syntax = "proto3";',
  'package probe;',
  'import "types.proto";',
  'service Greeter {',
  '  rpc SayHello (HelloRequest) returns (HelloReply);',
  '}'
].join('\n');

const PROTO_TYPES = [
  'syntax = "proto3";',
  'package probe;',
  'message HelloRequest { string name = 1; }',
  'message HelloReply { string message = 1; }'
].join('\n');

const SECRET_PATTERNS = [
  /PMAK-[A-Za-z0-9_-]{10,}/i,
  /PMAT-[A-Za-z0-9_-]{10,}/i,
  /x-access-token/i,
  /x-api-key/i,
  /authorization\s*[:=]/i,
  /Bearer\s+[A-Za-z0-9._-]+/i,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]+/i,
  /cookie\s*[:=]/i,
  /\/Users\/[^\s"']+/i,
  /\/home\/[^\s"']+/i,
  /[A-Za-z]:\\[^\s"']+/i,
  /bifrost[^\s"']*/i,
  /go\.postman\.co[^\s"']*/i,
  /iapub\.postman/i,
  /request[_-]?id/i,
  /user[_-]?id["']?\s*[:=]/i,
  /"(?:createdBy|updatedBy|ownerId|userId)"\s*:\s*"?\d{5,}/i
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function out(line) {
  process.stdout.write(`${line}\n`);
}

function err(line) {
  process.stderr.write(`${line}\n`);
}

function loadDotEnv() {
  const entries = {};
  if (!existsSync(ENV_FILE)) return entries;
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)=(.*)$/);
    if (match) entries[match[1]] = match[2].replace(/^["']|["']$/g, '').trim();
  }
  return entries;
}

function pickEnv(name, fileEnv) {
  return String(process.env[name] ?? fileEnv[name] ?? '').trim();
}

function resolveLeg(leg) {
  const fileEnv = loadDotEnv();
  if (leg === 'nonorg') {
    const apiKey = pickEnv('POSTMAN_E2E_API_KEY_NON_ORG_MODE', fileEnv);
    if (!apiKey) {
      throw new Error(
        'Missing POSTMAN_E2E_API_KEY_NON_ORG_MODE: export it or add it to the workspace-root .env'
      );
    }
    return {
      mode: 'nonorg',
      apiKey,
      teamId: SANDBOX_TEAM_ID,
      workspaceTeamId: '',
      orgMode: false
    };
  }
  if (leg === 'org') {
    const apiKey = pickEnv('POSTMAN_E2E_API_KEY_ORG_MODE', fileEnv);
    if (!apiKey) {
      throw new Error(
        'Missing POSTMAN_E2E_API_KEY_ORG_MODE: export it or add it to the workspace-root .env'
      );
    }
    return {
      mode: 'org',
      apiKey,
      teamId: ORG_PARENT_TEAM_ID,
      workspaceTeamId: ORG_WORKSPACE_TEAM_ID,
      orgMode: true
    };
  }
  throw new Error('Usage: node scripts/probe-multifile-spec-sync.mjs --leg nonorg|org');
}

function currentBootstrapCommit() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function containsSecretLeak(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return null;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) return pattern.source;
  }
  // OpenAPI/protobuf source bodies must never land in the receipt.
  // Avoid matching the enum token OPENAPI:3.0 in requestShape strings.
  if (/(^|\n)openapi:\s*3\.\d/i.test(text) || /syntax\s*=\s*"proto3"/i.test(text)) {
    return 'source-content';
  }
  // Multi-line YAML payloads (not short sentinel labels / request shapes).
  if (
    text.includes('\n') &&
    (/(^|\n)paths:\s*\n/i.test(text) || /(^|\n)info:\s*\n\s+title:/i.test(text))
  ) {
    return 'source-content';
  }
  return null;
}

function shapeOf(value, depth = 0) {
  if (depth > 4) return '…';
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return `string(${value.length})`;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [shapeOf(value[0], depth + 1), `…x${value.length}`];
  }
  const record = asRecord(value);
  if (!record) return typeof value;
  const outShape = {};
  for (const key of Object.keys(record).sort()) {
    if (
      /content|token|cookie|authorization|password|secret|createdBy|updatedBy|ownerId|userId|requestId/i.test(
        key
      )
    ) {
      outShape[key] = 'redacted';
      continue;
    }
    // Numeric actor ids occasionally appear as bare numbers under other keys.
    if (typeof record[key] === 'number' && /by$/i.test(key)) {
      outShape[key] = 'redacted';
      continue;
    }
    outShape[key] = shapeOf(record[key], depth + 1);
  }
  return outShape;
}

/**
 * Validate a sanitized multifile Spec Hub probe receipt (schema + matrix only).
 * Intentionally git-free: source-commit binding belongs in
 * {@link assertMultifileSpecSyncReceiptSourceBinding}.
 * @param {unknown} receipt
 */
export function validateMultifileSpecSyncReceipt(receipt) {
  const record = asRecord(receipt);
  if (!record) throw new Error('receipt must be an object');
  if (record.schemaVersion !== 1) throw new Error('receipt.schemaVersion must be 1');
  if (typeof record.testedAt !== 'string' || !record.testedAt) {
    throw new Error('receipt.testedAt must be a non-empty string');
  }
  if (typeof record.bootstrapCommit !== 'string' || !/^[a-f0-9]{40}$/.test(record.bootstrapCommit)) {
    throw new Error('receipt.bootstrapCommit must be a 40-char lowercase git sha');
  }

  const leak = containsSecretLeak(record);
  if (leak) {
    throw new Error(`receipt contains secret/redactable material (${leak})`);
  }

  if (!Array.isArray(record.legs) || record.legs.length === 0) {
    throw new Error('receipt.legs missing leg entries');
  }
  const modes = new Set(record.legs.map((leg) => asRecord(leg)?.mode));
  for (const mode of REQUIRED_LEG_MODES) {
    if (!modes.has(mode)) throw new Error(`receipt missing leg mode ${mode}`);
  }

  const capabilities = asRecord(record.capabilities);
  if (!capabilities) throw new Error('receipt.capabilities missing');
  for (const key of CAPABILITY_KEYS) {
    if (typeof capabilities[key] !== 'boolean') {
      throw new Error(`receipt.capabilities.${key} must be boolean`);
    }
  }
  for (const leg of record.legs) {
    const legRecord = asRecord(leg);
    if (!legRecord) throw new Error('leg must be an object');
    if (!REQUIRED_LEG_MODES.includes(legRecord.mode)) {
      throw new Error(`unsupported leg mode ${legRecord.mode}`);
    }
    if (typeof legRecord.teamId !== 'string' || !/^\d+$/.test(legRecord.teamId)) {
      throw new Error('leg.teamId must be a numeric team id string');
    }
    if (legRecord.teardown !== undefined) {
      const teardown = asRecord(legRecord.teardown);
      if (!teardown || typeof teardown.residue !== 'boolean') {
        throw new Error('leg.teardown.residue must be boolean when present');
      }
    }
    if (!Array.isArray(legRecord.results)) throw new Error('leg.results must be an array');
    const ids = new Set(legRecord.results.map((row) => asRecord(row)?.id));
    for (const id of REQUIRED_PROBE_IDS) {
      if (!ids.has(id)) throw new Error(`missing probe row ${id} in leg ${legRecord.mode}`);
    }
    for (const row of legRecord.results) {
      const result = asRecord(row);
      if (!result) throw new Error('result row must be an object');
      if (!REQUIRED_PROBE_IDS.includes(result.id)) {
        throw new Error(`unexpected probe id ${result.id}`);
      }
      if (typeof result.passed !== 'boolean') throw new Error(`${result.id}.passed must be boolean`);
      if (!Array.isArray(result.httpStatuses)) {
        throw new Error(`${result.id}.httpStatuses must be an array`);
      }
      for (const status of result.httpStatuses) {
        if (!Number.isInteger(status)) {
          throw new Error(`${result.id}.httpStatuses must be integers`);
        }
      }
      if (typeof result.requestShape !== 'string') {
        throw new Error(`${result.id}.requestShape must be a string`);
      }
      if (typeof result.responseShape !== 'string' && typeof result.responseShape !== 'object') {
        throw new Error(`${result.id}.responseShape must be string or object`);
      }
      if (!asRecord(result.observed) && result.observed !== undefined) {
        // observed may be object; undefined allowed only before fill — require object
      }
      if (!asRecord(result.observed)) {
        throw new Error(`${result.id}.observed must be an object`);
      }
      const observed = asRecord(result.observed);
      if (result.id === 'P05' && result.passed === true) {
        if (observed.fixedContractAccepted !== true) {
          throw new Error('P05 cannot pass when fixedContractAccepted is false');
        }
        if (observed.exactBytes !== true || observed.pathPresent !== true) {
          throw new Error('P05 pass requires pathPresent and exactBytes readback');
        }
      }
      if (result.id === 'P06' && result.passed === true && observed.absentAfterDelete !== true) {
        throw new Error('P06 cannot pass unless list proves absence after delete');
      }
      if (result.id === 'P10') {
        const needsFullSetSnapshots =
          result.passed === true ||
          observed.atomicBulkProven === true ||
          observed.beforeSnapshot !== undefined ||
          observed.afterSnapshot !== undefined;
        if (needsFullSetSnapshots) {
          assertSanitizedSnapshot(observed.beforeSnapshot, `${legRecord.mode} P10.beforeSnapshot`);
          assertSanitizedSnapshot(observed.afterSnapshot, `${legRecord.mode} P10.afterSnapshot`);
        }
        if (observed.atomicBulkProven === true) {
          if (!sanitizedSnapshotsEqual(observed.beforeSnapshot, observed.afterSnapshot)) {
            throw new Error(
              `${legRecord.mode} P10 atomicBulkProven requires equal before/after path-role-hash snapshots`
            );
          }
        }
      }
      const rowLeak = containsSecretLeak(result);
      if (rowLeak) throw new Error(`${result.id} leaks ${rowLeak}`);
    }
  }

  if (capabilities.atomicBulk === true) {
    for (const leg of record.legs) {
      const legRecord = asRecord(leg);
      const row = (legRecord?.results || []).find((r) => asRecord(r)?.id === 'P10');
      const observed = asRecord(asRecord(row)?.observed);
      if (observed?.atomicBulkProven !== true) {
        throw new Error('atomicBulk=true requires P10 atomicBulkProven in every leg');
      }
      assertSanitizedSnapshot(observed.beforeSnapshot, `${legRecord.mode} P10.beforeSnapshot`);
      assertSanitizedSnapshot(observed.afterSnapshot, `${legRecord.mode} P10.afterSnapshot`);
      if (!sanitizedSnapshotsEqual(observed.beforeSnapshot, observed.afterSnapshot)) {
        throw new Error(
          'atomicBulk=true requires complete equal before/after path-role-hash snapshots in every leg'
        );
      }
    }
  }

  return record;
}

/**
 * Paths allowed to change after receipt.bootstrapCommit without invalidating
 * live capability evidence. Anything under src/, action.yml, probe/scripts,
 * capability-defining tests, or other production seams must not appear here.
 * @param {string} relPath
 */
export function isReleaseOnlyDriftPath(relPath) {
  const p = String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  if (!p) return false;
  if (p === 'package.json' || p === 'package-lock.json') return true;
  if (p === 'README.md' || p === 'LICENSE' || p === 'LICENSE.md') return true;
  if (p === 'CHANGELOG' || /^CHANGELOG(\.|[-_])/i.test(p)) return true;
  if (p.startsWith('validation/evidence/')) return true;
  if (p.startsWith('dist/')) return true;
  // Release/docs metadata (markdown only).
  if (p.startsWith('docs/') && /\.md$/i.test(p)) return true;
  return false;
}

/**
 * @param {string[]} changedPaths paths from `git diff --name-only receipt..HEAD`
 */
export function assertReleaseOnlySourceDrift(changedPaths) {
  const paths = Array.isArray(changedPaths) ? changedPaths : [];
  const offenders = paths
    .map((entry) => String(entry || '').replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter((entry) => entry && !isReleaseOnlyDriftPath(entry));
  if (offenders.length > 0) {
    throw new Error(
      `receipt bootstrapCommit is stale: behavior-bearing paths changed after receipt (${offenders.join(', ')})`
    );
  }
  return true;
}

function gitIsAncestor(ancestor, descendant, repoRoot) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: repoRoot,
      stdio: 'ignore'
    });
    return true;
  } catch {
    return false;
  }
}

function gitChangedPaths(fromCommit, toCommit, repoRoot) {
  return execFileSync('git', ['diff', '--name-only', `${fromCommit}..${toCommit}`], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Test/CLI wrapper: schema validation plus source-commit binding.
 * Receipt bootstrapCommit identifies the committed production source probed.
 * It may equal HEAD, or be an ancestor of HEAD only when every path in
 * `git diff --name-only receiptCommit..HEAD` is release-only drift.
 *
 * @param {unknown} receipt
 * @param {{
 *   headCommit: string,
 *   repoRoot?: string,
 *   isAncestor?: (receiptCommit: string, headCommit: string) => boolean,
 *   changedPaths?: string[],
 * }} options
 */
export function assertMultifileSpecSyncReceiptSourceBinding(receipt, options = {}) {
  const validated = validateMultifileSpecSyncReceipt(receipt);
  const receiptCommit = validated.bootstrapCommit;
  const headCommit = options.headCommit;
  if (typeof headCommit !== 'string' || !/^[a-f0-9]{40}$/.test(headCommit)) {
    throw new Error('headCommit must be a 40-char lowercase git sha');
  }
  if (receiptCommit === headCommit) {
    return validated;
  }

  const repoRoot = options.repoRoot || REPO_ROOT;
  const isAncestor =
    typeof options.isAncestor === 'function'
      ? options.isAncestor
      : (ancestor, descendant) => gitIsAncestor(ancestor, descendant, repoRoot);

  if (!isAncestor(receiptCommit, headCommit)) {
    throw new Error(
      `receipt.bootstrapCommit ${receiptCommit} is not an ancestor of HEAD ${headCommit}`
    );
  }

  const changedPaths =
    options.changedPaths ?? gitChangedPaths(receiptCommit, headCommit, repoRoot);
  assertReleaseOnlySourceDrift(changedPaths);
  return validated;
}

function createGateway(accessToken, orgMode, entityTeamId) {
  let token = accessToken;
  return {
    setToken(next) {
      token = next;
    },
    async request({ service, method, path: reqPath, query, body, headers }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const requestHeaders = {
          'Content-Type': 'application/json',
          'x-access-token': token,
          ...(headers || {})
        };
        if (orgMode && entityTeamId) {
          requestHeaders['x-entity-team-id'] = entityTeamId;
        }
        const response = await fetch(`${BIFROST}/ws/proxy`, {
          method: 'POST',
          headers: requestHeaders,
          signal: controller.signal,
          body: JSON.stringify({
            service,
            method,
            path: reqPath,
            ...(query !== undefined ? { query } : {}),
            ...(body !== undefined ? { body } : {})
          })
        });
        const text = await response.text().catch(() => '');
        let json = null;
        try {
          json = text.trim() ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        let status = response.status;
        const envelope = asRecord(json);
        if (response.ok && envelope) {
          const inner =
            typeof envelope.status === 'number'
              ? envelope.status
              : typeof envelope.statusCode === 'number'
                ? envelope.statusCode
                : undefined;
          const hasError =
            (envelope.error !== undefined &&
              envelope.error !== null &&
              !(asRecord(envelope.error) && Object.keys(asRecord(envelope.error)).length === 0)) ||
            envelope.success === false ||
            (typeof inner === 'number' && inner >= 400);
          if (hasError) status = typeof inner === 'number' && inner >= 400 ? inner : 502;
        }
        return { status, ok: status >= 200 && status < 300, json, text };
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

async function mintAccessToken(apiKey) {
  const response = await fetch(`${API}/service-account-tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ apiKey })
  });
  const text = await response.text().catch(() => '');
  let parsed;
  try {
    parsed = text.trim() ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const token = String(
    asRecord(parsed)?.access_token ?? asRecord(asRecord(parsed)?.session)?.token ?? ''
  ).trim();
  if (!response.ok || !token) {
    throw new Error(`Token mint failed (HTTP ${response.status}); check e2e leg credentials`);
  }
  return token;
}

function runId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const suffix = createHash('sha256').update(randomUUID()).digest('hex').slice(0, 8);
  return `${stamp}-${suffix}`;
}

function listFilesFromResponse(json) {
  const data = asRecord(json)?.data ?? json;
  if (Array.isArray(data)) return data.map((entry) => asRecord(entry)).filter(Boolean);
  const nested = asRecord(data)?.files;
  if (Array.isArray(nested)) return nested.map((entry) => asRecord(entry)).filter(Boolean);
  return [];
}

function fileMeta(entry) {
  return {
    id: String(entry?.id ?? '').trim(),
    path: String(entry?.path ?? entry?.name ?? '').trim(),
    type: String(entry?.type ?? '').trim(),
    parentId: String(entry?.parentId ?? '').trim()
  };
}

function contentFromFileRead(json) {
  const data = asRecord(json)?.data ?? json;
  const content = asRecord(data)?.content ?? asRecord(json)?.content;
  return typeof content === 'string' ? content : '';
}

function contentHash(content) {
  return createHash('sha256').update(typeof content === 'string' ? content : '').digest('hex');
}

/**
 * List every ROOT/DEFAULT cloud member and read each content, reducing evidence
 * to normalized path/role/byteLength/hash only (no source body or member IDs).
 * @returns {Promise<{ status: number, members: Array<{ path: string, role: string, byteLength: number, hash: string }> }>}
 */
async function captureSanitizedFullSetSnapshot(gw, specId) {
  const listed = await listSpecFiles(gw, specId);
  const metas = listFilesFromResponse(listed.json)
    .map(fileMeta)
    .filter((entry) => entry.type === 'ROOT' || entry.type === 'DEFAULT')
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const members = [];
  for (const meta of metas) {
    const read = meta.id
      ? await readSpecFile(gw, specId, meta.id)
      : { status: 0, json: null };
    const content = contentFromFileRead(read.json);
    members.push({
      path: meta.path,
      role: meta.type,
      byteLength: content.length,
      hash: contentHash(content)
    });
  }
  return { status: listed.status, members };
}

function sanitizedSnapshotsEqual(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return false;
  if (before.length !== after.length) return false;
  for (let i = 0; i < before.length; i += 1) {
    const left = asRecord(before[i]);
    const right = asRecord(after[i]);
    if (!left || !right) return false;
    if (
      left.path !== right.path ||
      left.role !== right.role ||
      left.byteLength !== right.byteLength ||
      left.hash !== right.hash
    ) {
      return false;
    }
  }
  return true;
}

function assertSanitizedSnapshot(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of path/role/byteLength/hash members`);
  }
  for (const entry of value) {
    const row = asRecord(entry);
    if (!row) throw new Error(`${label} member must be an object`);
    if (typeof row.path !== 'string' || !row.path) {
      throw new Error(`${label} member.path must be a non-empty string`);
    }
    if (row.role !== 'ROOT' && row.role !== 'DEFAULT') {
      throw new Error(`${label} member.role must be ROOT or DEFAULT`);
    }
    if (!Number.isInteger(row.byteLength) || row.byteLength < 0) {
      throw new Error(`${label} member.byteLength must be a non-negative integer`);
    }
    if (typeof row.hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.hash)) {
      throw new Error(`${label} member.hash must be a 64-char lowercase sha256 hex`);
    }
    const keys = Object.keys(row).sort();
    if (keys.join(',') !== 'byteLength,hash,path,role') {
      throw new Error(`${label} member may only contain path/role/byteLength/hash`);
    }
  }
}

function bareModelId(uid) {
  const value = String(uid || '').trim();
  const parts = value.split('-');
  return parts.length > 1 && /^\d+$/.test(parts[0]) ? parts.slice(1).join('-') : value;
}

async function createWorkspace(gw, name, leg) {
  if (leg.orgMode) {
    const squadId = leg.workspaceTeamId;
    const created = await gw.request({
      service: 'workspaces',
      method: 'post',
      path: '/workspaces',
      body: {
        name,
        visibilityStatus: 'team',
        squad: squadId,
        roles: { group: { [squadId]: ['WORKSPACE_VIEWER_V9'] } }
      }
    });
    const id = String(asRecord(created.json?.data)?.id ?? created.json?.id ?? '').trim();
    return { status: created.status, id };
  }
  const created = await gw.request({
    service: 'workspaces',
    method: 'post',
    path: '/workspaces',
    body: { name, visibilityStatus: 'personal' }
  });
  const id = String(asRecord(created.json?.data)?.id ?? created.json?.id ?? '').trim();
  if (!id) return { status: created.status, id: '' };
  const flip = await gw.request({
    service: 'workspaces',
    method: 'put',
    path: `/workspaces/${id}/visibility`,
    body: { visibilityStatus: 'team' }
  });
  return { status: flip.ok ? created.status : flip.status, id };
}

async function deleteWorkspace(gw, workspaceId) {
  if (!workspaceId) return { status: 0 };
  return gw.request({
    service: 'workspaces',
    method: 'delete',
    path: `/workspaces/${workspaceId}`
  });
}

async function deleteSpecification(gw, specId) {
  if (!specId) return { status: 0 };
  return gw.request({
    service: 'specification',
    method: 'delete',
    path: `/specifications/${specId}`
  });
}

async function deleteCollection(gw, collectionId, apiKey) {
  if (!collectionId) return { status: 0 };
  const gateway = await gw.request({
    service: 'collection',
    method: 'delete',
    path: `/v3/collections/${bareModelId(collectionId)}`
  });
  if (gateway.ok || !apiKey) return gateway;
  const response = await fetch(`${API}/collections/${collectionId}`, {
    method: 'DELETE',
    headers: { 'X-Api-Key': apiKey }
  });
  return { status: response.status, ok: response.ok };
}

async function listSpecFiles(gw, specId) {
  return gw.request({
    service: 'specification',
    method: 'get',
    path: `/specifications/${specId}/files`
  });
}

async function readSpecFile(gw, specId, fileId) {
  return gw.request({
    service: 'specification',
    method: 'get',
    path: `/specifications/${specId}/files/${fileId}`,
    query: { fields: 'content' }
  });
}

/** Explicit Spec Hub terminal-success task states for collection generation. */
export const TERMINAL_GENERATION_SUCCESS_STATUSES = Object.freeze(['completed', 'success']);

/** In-flight generation states that must not count as pass. */
export const NON_TERMINAL_GENERATION_STATUSES = Object.freeze([
  'pending',
  'queued',
  'in-progress'
]);

/**
 * True only for an explicit terminal-success generation task state.
 * @param {unknown} taskStatus
 */
export function isTerminalGenerationSuccess(taskStatus) {
  const status = String(taskStatus ?? '')
    .trim()
    .toLowerCase();
  return TERMINAL_GENERATION_SUCCESS_STATUSES.includes(status);
}

/**
 * True while the generation task is still in flight.
 * @param {unknown} taskStatus
 */
export function isNonTerminalGenerationStatus(taskStatus) {
  const status = String(taskStatus ?? '')
    .trim()
    .toLowerCase();
  return NON_TERMINAL_GENERATION_STATUSES.includes(status);
}

/**
 * Normalize the final task status after polling.
 * Exhausted pending/queued/in-progress becomes `exhausted`; bare unknown stays `unknown`.
 * @param {unknown} taskStatus
 * @param {{ pollsExhausted?: boolean }} [options]
 */
export function finalizeGenerationTaskStatus(taskStatus, options = {}) {
  const status = String(taskStatus ?? '')
    .trim()
    .toLowerCase() || 'unknown';
  if (options.pollsExhausted) {
    if (isNonTerminalGenerationStatus(status)) return 'exhausted';
    if (status === 'unknown') return 'unknown';
  }
  return status;
}

/**
 * Generation pass gate for P03/P04/P11: HTTP success + terminal success + collection id.
 * Rejects pending/queued/in-progress/unknown/exhausted and other non-success states.
 * @param {{ status?: number, taskStatus?: string, collectionId?: string } | null | undefined} gen
 */
export function generationOutcomePassed(gen) {
  const status = Number(gen?.status);
  return (
    Number.isFinite(status) &&
    status >= 200 &&
    status < 300 &&
    isTerminalGenerationSuccess(gen?.taskStatus) &&
    Boolean(String(gen?.collectionId ?? '').trim())
  );
}

/**
 * Identify the collection associated with a completed generation from the list
 * contract: prefer exact name match when present; otherwise sole id; otherwise
 * newest listed id only when a name match is unavailable.
 * @param {unknown} entries
 * @param {string} [expectedName]
 */
export function pickCollectionIdForGeneration(entries, expectedName = '') {
  const rows = Array.isArray(entries) ? entries : [];
  const want = String(expectedName || '').trim();
  const parsed = [];
  for (const raw of rows) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const id = String(entry.collection ?? entry.collectionId ?? entry.id ?? '').trim();
    if (!id) continue;
    const name = String(entry.name ?? entry.collectionName ?? '').trim();
    parsed.push({ id, name });
  }
  if (parsed.length === 0) return '';
  if (want) {
    const named = parsed.filter((row) => row.name === want);
    if (named.length > 0) return named[named.length - 1].id;
  }
  if (parsed.length === 1) return parsed[0].id;
  // Nameless multi-entry lists: take the last id (API order ≈ newest).
  return parsed[parsed.length - 1].id;
}

/**
 * Continue-safe run-scoped cleanup: attempt every journaled collection/spec/
 * workspace even when an earlier delete throws; then workspace readback.
 * Never logs resource ids or secrets.
 * @param {{ workspaceId?: string, collectionIds?: string[], specIds?: string[] }} journal
 * @param {{
 *   deleteCollection: (id: string) => Promise<{ status?: number }>,
 *   deleteSpecification: (id: string) => Promise<{ status?: number }>,
 *   deleteWorkspace: (id: string) => Promise<{ status?: number }>,
 *   readWorkspace: (id: string) => Promise<{ status?: number }>
 * }} ops
 */
export async function cleanupJournaledResources(journal, ops) {
  const deleted = [];
  const collectionIds = Array.isArray(journal?.collectionIds) ? journal.collectionIds : [];
  const specIds = Array.isArray(journal?.specIds) ? journal.specIds : [];
  const workspaceId = String(journal?.workspaceId ?? '').trim();

  for (const collectionId of collectionIds) {
    try {
      const response = await ops.deleteCollection(collectionId);
      deleted.push({ kind: 'collection', status: Number(response?.status) || 0 });
    } catch {
      deleted.push({ kind: 'collection', status: 0 });
    }
  }
  for (const id of specIds) {
    try {
      const response = await ops.deleteSpecification(id);
      deleted.push({ kind: 'specification', status: Number(response?.status) || 0 });
    } catch {
      deleted.push({ kind: 'specification', status: 0 });
    }
  }
  if (workspaceId) {
    try {
      const response = await ops.deleteWorkspace(workspaceId);
      deleted.push({ kind: 'workspace', status: Number(response?.status) || 0 });
    } catch {
      deleted.push({ kind: 'workspace', status: 0 });
    }
    try {
      const check = await ops.readWorkspace(workspaceId);
      deleted.push({ kind: 'workspace-readback', status: Number(check?.status) || 0 });
    } catch {
      deleted.push({ kind: 'workspace-readback', status: 0 });
    }
  }

  const readback = deleted.find((entry) => entry.kind === 'workspace-readback');
  // Residue when a journaled workspace still reads back as present (2xx).
  const residue =
    Boolean(workspaceId) &&
    (!readback || (readback.status >= 200 && readback.status < 300));

  return {
    residue: Boolean(residue),
    deletedKinds: deleted.map((entry) => `${entry.kind}:${entry.status}`)
  };
}

async function generateCollection(gw, specId, name) {
  const create = await gw.request({
    service: 'specification',
    method: 'post',
    path: `/specifications/${specId}/collections`,
    body: {
      name,
      options: {
        requestNameSource: 'Fallback',
        folderStrategy: 'Paths'
      }
    }
  });
  const taskId = String(asRecord(create.json?.data)?.taskId ?? create.json?.taskId ?? '').trim();
  if (!create.ok) {
    return { status: create.status, collectionId: '', taskStatus: 'failed' };
  }
  if (!taskId) {
    return { status: create.status, collectionId: '', taskStatus: 'unknown' };
  }

  let taskStatus = 'pending';
  let pollsExhausted = true;
  for (let attempt = 0; attempt < GENERATION_POLL_ATTEMPTS; attempt += 1) {
    await sleep(GENERATION_POLL_DELAY_MS);
    const task = await gw.request({
      service: 'specification',
      method: 'get',
      path: '/tasks',
      query: {
        entityId: specId,
        entityType: 'specification',
        type: 'collection-generation'
      }
    });
    taskStatus = String(asRecord(task.json?.data)?.[taskId] ?? '').toLowerCase() || 'unknown';
    if (taskStatus === 'failed' || taskStatus === 'error') {
      return { status: create.status, collectionId: '', taskStatus };
    }
    if (isTerminalGenerationSuccess(taskStatus)) {
      pollsExhausted = false;
      break;
    }
    // Keep polling through non-terminal and unknown; do not treat them as success.
  }

  taskStatus = finalizeGenerationTaskStatus(taskStatus, { pollsExhausted });
  if (!isTerminalGenerationSuccess(taskStatus)) {
    return { status: create.status, collectionId: '', taskStatus };
  }

  const listed = await gw.request({
    service: 'specification',
    method: 'get',
    path: `/specifications/${specId}/collections`
  });
  const entries = Array.isArray(listed.json?.data) ? listed.json.data : [];
  const collectionId = pickCollectionIdForGeneration(entries, name);
  return { status: create.status, collectionId, taskStatus, listStatus: listed.status };
}

/**
 * Generation itself is gateway-only. Spec-generated example bodies are not
 * present on the gateway collection metadata GET (live-proven); the public
 * collections read returns the serialized request examples needed for P03/P04.
 */
async function readCollectionSerialized(gw, collectionId, apiKey) {
  const gateway = await gw.request({
    service: 'collection',
    method: 'get',
    path: `/v3/collections/${bareModelId(collectionId)}`
  });
  const uid = String(collectionId || '').trim();
  let publicStatus = 0;
  let serialized = JSON.stringify(gateway.json ?? {});
  if (apiKey && uid) {
    const response = await fetch(`${API}/collections/${uid}`, {
      headers: { 'X-Api-Key': apiKey }
    });
    publicStatus = response.status;
    const text = await response.text().catch(() => '');
    if (response.ok && text) serialized = text;
  }
  return {
    status: gateway.status,
    publicStatus,
    serialized,
    shape: shapeOf(gateway.json)
  };
}

function componentsParentId(files) {
  const pet = files.find((f) => f.path === 'components/pet.yaml');
  return String(pet?.parentId ?? '').trim();
}

function emptyResult(id) {
  return {
    id,
    passed: false,
    httpStatuses: [],
    requestShape: '',
    responseShape: '',
    observed: {}
  };
}

function computeCapabilities(results) {
  const byId = Object.fromEntries(results.map((row) => [row.id, row]));
  const pass = (id) => byId[id]?.passed === true;
  const obs = (id) => asRecord(byId[id]?.observed) || {};
  return {
    multiFileCreate: pass('P01'),
    multiFileRead: pass('P02'),
    perFileCreate: pass('P05'),
    perFilePatch: pass('P04') || pass('P05'),
    perFileDelete: pass('P06'),
    bulkModify: pass('P07') && obs('P07').bulkAccepted === true,
    atomicBulk: obs('P10').atomicBulkProven === true,
    rootPathChange: obs('P08').rootPathChange === true,
    openapiGeneration: pass('P03') && pass('P04'),
    protobufGeneration: pass('P11')
  };
}

function loadExistingReceipt() {
  if (!existsSync(RECEIPT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(RECEIPT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeReceipt(receipt) {
  mkdirSync(path.dirname(RECEIPT_PATH), { recursive: true });
  const validated = validateMultifileSpecSyncReceipt(receipt);
  writeFileSync(RECEIPT_PATH, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
}

function writeReceiptAllowingPartial(receipt) {
  mkdirSync(path.dirname(RECEIPT_PATH), { recursive: true });
  const leak = containsSecretLeak(receipt);
  if (leak) throw new Error(`refusing to persist receipt with leak (${leak})`);
  writeFileSync(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}

async function runLegProbe(leg) {
  const stamp = runId();
  const workspaceName = `mfsync-${leg.mode}-${stamp}`;
  const specName = `mfsync-spec-${stamp}`;
  const collectionName = `mfsync-col-${stamp}`;
  const protoSpecName = `mfsync-proto-${stamp}`;

  out(`[probe] leg=${leg.mode} teamId=${leg.teamId} workspaceTeamId=${leg.workspaceTeamId || '(none)'}`);

  let accessToken;
  try {
    accessToken = await mintAccessToken(leg.apiKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      blocker: message,
      leg: {
        mode: leg.mode,
        teamId: leg.teamId,
        results: REQUIRED_PROBE_IDS.map((id) => ({
          ...emptyResult(id),
          observed: { blocker: 'auth-mint-failed' }
        })),
        teardown: { residue: false, deleted: [] }
      },
      capabilities: Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false]))
    };
  }

  const gw = createGateway(
    accessToken,
    leg.orgMode,
    leg.orgMode ? leg.workspaceTeamId : ''
  );

  const journal = {
    workspaceId: '',
    specIds: [],
    collectionIds: [],
    protoSpecId: ''
  };
  const results = Object.fromEntries(REQUIRED_PROBE_IDS.map((id) => [id, emptyResult(id)]));
  let blocker = '';
  /** @type {{ residue: boolean, deletedKinds: string[] }} */
  let teardownOutcome;

  const trackSpec = (id) => {
    if (id && !journal.specIds.includes(id)) journal.specIds.push(id);
  };
  const trackCollection = (id) => {
    if (id && !journal.collectionIds.includes(id)) journal.collectionIds.push(id);
  };

  try {
    const ws = await createWorkspace(gw, workspaceName, leg);
    journal.workspaceId = ws.id;
    if (!ws.id || ws.status < 200 || ws.status >= 300) {
      blocker = `workspace-create-failed:${ws.status || 0}`;
      throw new Error(blocker);
    }
    out(`[probe] workspace created (journaled)`);

    // ---- P01 multi-file create ----
    {
      const body = {
        name: specName,
        type: 'OPENAPI:3.0',
        files: [
          { path: 'openapi.yaml', content: ROOT_OPENAPI, type: 'ROOT' },
          { path: 'components/pet.yaml', content: petDependency('bundle-v1'), type: 'DEFAULT' }
        ]
      };
      const created = await gw.request({
        service: 'specification',
        method: 'post',
        path: `/specifications?containerType=workspace&containerId=${journal.workspaceId}`,
        body
      });
      const specId = String(asRecord(created.json?.data)?.id ?? created.json?.id ?? '').trim();
      trackSpec(specId);
      const listed = specId ? await listSpecFiles(gw, specId) : { status: 0, json: null };
      const files = listFilesFromResponse(listed.json).map(fileMeta);
      const paths = files.map((f) => f.path).sort();
      const rootCount = files.filter((f) => f.type === 'ROOT').length;
      const passed =
        created.ok &&
        Boolean(specId) &&
        listed.ok &&
        paths.includes('openapi.yaml') &&
        paths.includes('components/pet.yaml') &&
        rootCount === 1 &&
        files.every((f) => Boolean(f.id));
      results.P01 = {
        id: 'P01',
        passed,
        httpStatuses: [created.status, listed.status].filter((n) => n > 0),
        requestShape:
          "POST /specifications?containerType=workspace&containerId=<workspaceId> {name,type:'OPENAPI:3.0',files:[{path,content,type:'ROOT'|'DEFAULT'}]}",
        responseShape: JSON.stringify(shapeOf(created.json)),
        observed: {
          fileCount: files.length,
          paths,
          rootCount,
          hasUuids: files.every((f) => Boolean(f.id))
        }
      };
      if (!passed) {
        blocker = `P01-failed:status=${created.status}`;
        throw new Error(blocker);
      }
      journal.primarySpecId = specId;
      out(`[P01] passed fileCount=${files.length}`);
    }

    const specId = journal.primarySpecId;
    let files = listFilesFromResponse((await listSpecFiles(gw, specId)).json).map(fileMeta);
    const byPath = () => Object.fromEntries(files.map((f) => [f.path, f]));

    // ---- P02 read each member ----
    {
      const statuses = [];
      const comparisons = [];
      const expected = {
        'openapi.yaml': ROOT_OPENAPI,
        'components/pet.yaml': petDependency('bundle-v1')
      };
      for (const [filePath, content] of Object.entries(expected)) {
        const meta = byPath()[filePath];
        const read = meta
          ? await readSpecFile(gw, specId, meta.id)
          : { status: 0, json: null };
        statuses.push(read.status);
        const body = contentFromFileRead(read.json);
        comparisons.push({
          path: filePath,
          role: meta?.type || '',
          exactBytes: body === content,
          contentLength: body.length
        });
      }
      const passed =
        comparisons.length === 2 &&
        comparisons.every((c) => c.exactBytes && (c.role === 'ROOT' || c.role === 'DEFAULT'));
      results.P02 = {
        id: 'P02',
        passed,
        httpStatuses: statuses,
        requestShape: 'GET /specifications/:id/files/:fileId?fields=content',
        responseShape: 'content+id',
        observed: { comparisons: comparisons.map(({ path: p, role, exactBytes, contentLength }) => ({
          path: p,
          role,
          exactBytes,
          contentLength
        })) }
      };
      out(`[P02] passed=${passed}`);
    }

    // ---- P03 generate collection; find bundle-v1 ----
    {
      const gen = await generateCollection(gw, specId, `${collectionName}-v1`);
      trackCollection(gen.collectionId);
      const read = gen.collectionId
        ? await readCollectionSerialized(gw, gen.collectionId, leg.apiKey)
        : { status: 0, publicStatus: 0, serialized: '', shape: {} };
      const found = read.serialized.includes('bundle-v1');
      const passed = generationOutcomePassed(gen) && found;
      results.P03 = {
        id: 'P03',
        passed,
        httpStatuses: [gen.status, read.status, read.publicStatus].filter((n) => n > 0),
        requestShape:
          'POST /specifications/:id/collections + task poll; collection example readback',
        responseShape: JSON.stringify({ taskStatus: gen.taskStatus, collectionShape: read.shape }),
        observed: {
          taskStatus: gen.taskStatus,
          foundSentinelV1: found,
          exampleReadback: read.publicStatus >= 200 && read.publicStatus < 300 ? 'public-collections' : 'gateway-metadata'
        }
      };
      out(
        `[P03] passed=${passed} foundSentinel=${found} genStatus=${gen.status} task=${gen.taskStatus} col=${Boolean(gen.collectionId)} public=${read.publicStatus} serLen=${read.serialized.length}`
      );
    }

    // ---- P04 companion-only change -> bundle-v2 ----
    {
      files = listFilesFromResponse((await listSpecFiles(gw, specId)).json).map(fileMeta);
      const pet = byPath()['components/pet.yaml'];
      const patch = await gw.request({
        service: 'specification',
        method: 'patch',
        path: `/specifications/${specId}/files/${pet.id}`,
        body: [{ op: 'replace', path: '/content', value: petDependency('bundle-v2') }]
      });
      const readback = await readSpecFile(gw, specId, pet.id);
      const body = contentFromFileRead(readback.json);
      const gen = await generateCollection(gw, specId, `${collectionName}-v2`);
      trackCollection(gen.collectionId);
      const read = gen.collectionId
        ? await readCollectionSerialized(gw, gen.collectionId, leg.apiKey)
        : { status: 0, publicStatus: 0, serialized: '' };
      const hasV2 = read.serialized.includes('bundle-v2');
      const hasV1 = read.serialized.includes('bundle-v1');
      const passed =
        patch.ok &&
        body === petDependency('bundle-v2') &&
        generationOutcomePassed(gen) &&
        hasV2 &&
        !hasV1;
      results.P04 = {
        id: 'P04',
        passed,
        httpStatuses: [patch.status, readback.status, gen.status, read.status, read.publicStatus].filter(
          (n) => n > 0
        ),
        requestShape: "PATCH /specifications/:id/files/:uuid [{op:'replace',path:'/content',value}]",
        responseShape: 'patched+generated',
        observed: {
          readbackChanged: body.includes('bundle-v2'),
          foundBundleV2: hasV2,
          foundBundleV1: hasV1,
          taskStatus: gen.taskStatus
        }
      };
      out(
        `[P04] passed=${passed} patch=${patch.status} readback=${readback.status} changed=${body.includes('bundle-v2')} gen=${gen.status} v2=${hasV2} v1=${hasV1}`
      );
    }

    // ---- P05 add components/error.yaml (fixed live contract: name + parentId) ----
    {
      const errorYaml = ['type: object', 'properties:', '  code:', '    type: string'].join('\n');
      files = listFilesFromResponse((await listSpecFiles(gw, specId)).json).map(fileMeta);
      const parentId = componentsParentId(files);
      const fixedShape =
        "{name:'error.yaml',content,type:'DEFAULT',parentId:<components-folder-uuid>}";
      const create = parentId
        ? await gw.request({
            service: 'specification',
            method: 'post',
            path: `/specifications/${specId}/files`,
            body: {
              name: 'error.yaml',
              content: errorYaml,
              type: 'DEFAULT',
              parentId
            }
          })
        : { status: 0, ok: false, json: null };
      files = listFilesFromResponse((await listSpecFiles(gw, specId)).json).map(fileMeta);
      const added = byPath()['components/error.yaml'];
      const read = added ? await readSpecFile(gw, specId, added.id) : { status: 0, json: null };
      const body = contentFromFileRead(read.json);
      const fixedContractAccepted = create.ok === true;
      const pathPresent = Boolean(added) && added.path === 'components/error.yaml';
      const exactBytes = body === errorYaml;
      const hasUuid = Boolean(added?.id);
      const passed =
        Boolean(parentId) &&
        fixedContractAccepted &&
        pathPresent &&
        hasUuid &&
        read.ok &&
        exactBytes;
      results.P05 = {
        id: 'P05',
        passed,
        httpStatuses: [create.status, read.status].filter((n) => n > 0),
        requestShape: `POST /specifications/:id/files ${fixedShape}`,
        responseShape: JSON.stringify(shapeOf(create.json)),
        observed: {
          pathPresent,
          exactBytes,
          identifier: hasUuid ? 'uuid' : 'none',
          fixedContractAccepted,
          fixedRequestShape: fixedShape,
          parentIdResolved: Boolean(parentId)
        }
      };
      out(
        `[P05] passed=${passed} create=${create.status} read=${read.status} accepted=${fixedContractAccepted} present=${pathPresent} exact=${exactBytes}`
      );
    }

    // ---- P06 delete added file ----
    {
      files = listFilesFromResponse((await listSpecFiles(gw, specId)).json).map(fileMeta);
      const added = byPath()['components/error.yaml'];
      const del = added
        ? await gw.request({
            service: 'specification',
            method: 'delete',
            path: `/specifications/${specId}/files/${added.id}`
          })
        : { status: 0, ok: false };
      files = listFilesFromResponse((await listSpecFiles(gw, specId)).json).map(fileMeta);
      const stillThere = Boolean(byPath()['components/error.yaml']);
      const passed = del.ok && !stillThere;
      results.P06 = {
        id: 'P06',
        passed,
        httpStatuses: [del.status].filter((n) => n > 0),
        requestShape: 'DELETE /specifications/:id/files/:uuid',
        responseShape: 'deleted',
        observed: { absentAfterDelete: !stillThere }
      };
      out(`[P06] passed=${passed}`);
    }

    // ---- P07 bulk-files create+update+delete ----
    {
      files = listFilesFromResponse((await listSpecFiles(gw, specId)).json).map(fileMeta);
      const parentId = componentsParentId(files);
      // Seed via live-supported per-file create (name+parentId); bulk create uses path.
      const seed = await gw.request({
        service: 'specification',
        method: 'post',
        path: `/specifications/${specId}/files`,
        body: {
          name: 'bulk-seed.yaml',
          content: 'type: string\n',
          type: 'DEFAULT',
          ...(parentId ? { parentId } : {})
        }
      });
      files = listFilesFromResponse((await listSpecFiles(gw, specId)).json).map(fileMeta);
      const pet = byPath()['components/pet.yaml'];
      const seedMeta = byPath()['components/bulk-seed.yaml'];
      const bulkBody = {
        create: [
          {
            path: 'components/bulk-new.yaml',
            content: 'type: number\n',
            type: 'DEFAULT'
          }
        ],
        update: [{ id: pet.id, content: petDependency('bundle-v2') }],
        ...(seedMeta?.id ? { delete: [{ id: seedMeta.id }] } : {})
      };
      const bulk = await gw.request({
        service: 'specification',
        method: 'post',
        path: `/specifications/${specId}/bulk-files`,
        body: bulkBody
      });
      files = listFilesFromResponse((await listSpecFiles(gw, specId)).json).map(fileMeta);
      const paths = files.map((f) => f.path).sort();
      const effectsTogether =
        paths.includes('components/bulk-new.yaml') &&
        !paths.includes('components/bulk-seed.yaml') &&
        Boolean(byPath()['components/pet.yaml']);
      const passed = bulk.ok && effectsTogether && seed.ok && Boolean(seedMeta?.id);
      results.P07 = {
        id: 'P07',
        passed,
        httpStatuses: [seed.status, bulk.status].filter((n) => n > 0),
        requestShape:
          "POST /specifications/:id/bulk-files {create:[{path,content,type:'DEFAULT'}],update:[{id,content}],delete:[{id}]}",
        responseShape: JSON.stringify(shapeOf(bulk.json)),
        observed: {
          bulkAccepted: bulk.ok,
          effectsVisibleTogether: effectsTogether,
          pathCount: paths.length,
          createdPathPresent: paths.includes('components/bulk-new.yaml'),
          seedDeleted: !paths.includes('components/bulk-seed.yaml')
        }
      };
      out(
        `[P07] passed=${passed} seed=${seed.status} bulk=${bulk.status} together=${effectsTogether} paths=${paths.length}`
      );
    }

    // ---- P08 root-role change / two-root rejection ----
    {
      files = listFilesFromResponse((await listSpecFiles(gw, specId)).json).map(fileMeta);
      const root = files.find((f) => f.type === 'ROOT');
      const dep = byPath()['components/pet.yaml'];
      let rootPathChange = false;
      let ordering = 'unsupported';
      const statuses = [];
      if (root && dep) {
        // Promote dependency to ROOT then demote old root — record whatever live accepts.
        const promote = await gw.request({
          service: 'specification',
          method: 'patch',
          path: `/specifications/${specId}/files/${dep.id}`,
          body: [{ op: 'replace', path: '/type', value: 'ROOT' }]
        });
        statuses.push(promote.status);
        const demote = await gw.request({
          service: 'specification',
          method: 'patch',
          path: `/specifications/${specId}/files/${root.id}`,
          body: [{ op: 'replace', path: '/type', value: 'DEFAULT' }]
        });
        statuses.push(demote.status);
        files = listFilesFromResponse((await listSpecFiles(gw, specId)).json).map(fileMeta);
        const roots = files.filter((f) => f.type === 'ROOT');
        if (promote.ok && demote.ok && roots.length === 1 && roots[0].path === 'components/pet.yaml') {
          rootPathChange = true;
          ordering = 'promote-dep-then-demote-old-root';
          // Restore original root for subsequent probes.
          await gw.request({
            service: 'specification',
            method: 'patch',
            path: `/specifications/${specId}/files/${root.id}`,
            body: [{ op: 'replace', path: '/type', value: 'ROOT' }]
          });
          await gw.request({
            service: 'specification',
            method: 'patch',
            path: `/specifications/${specId}/files/${dep.id}`,
            body: [{ op: 'replace', path: '/type', value: 'DEFAULT' }]
          });
        } else {
          // Attempted two-root or unsupported; restore best-effort.
          if (roots.length !== 1 || roots[0].path !== 'openapi.yaml') {
            await gw.request({
              service: 'specification',
              method: 'patch',
              path: `/specifications/${specId}/files/${root.id}`,
              body: [{ op: 'replace', path: '/type', value: 'ROOT' }]
            }).catch(() => undefined);
            await gw.request({
              service: 'specification',
              method: 'patch',
              path: `/specifications/${specId}/files/${dep.id}`,
              body: [{ op: 'replace', path: '/type', value: 'DEFAULT' }]
            }).catch(() => undefined);
          }
        }
        files = listFilesFromResponse((await listSpecFiles(gw, specId)).json).map(fileMeta);
      }
      const finalRoots = files.filter((f) => f.type === 'ROOT');
      const invariant = finalRoots.length === 1;
      results.P08 = {
        id: 'P08',
        passed: invariant,
        httpStatuses: statuses,
        requestShape: "PATCH /files/:uuid [{op:'replace',path:'/type',value:'ROOT'|'DEFAULT'}]",
        responseShape: 'role-update',
        observed: {
          rootPathChange,
          ordering,
          finalRootCount: finalRoots.length,
          finalRootPath: finalRoots[0]?.path || ''
        }
      };
      out(`[P08] passed=${invariant} rootPathChange=${rootPathChange}`);
    }

    // ---- P09 nested/encoded/duplicate/NFC identity semantics ----
    {
      // Nested paths are accepted via bulk create `path` (per-file POST rejects
      // slash-containing names). Other identity probes use live name(+parentId).
      const nestedBulk = await gw.request({
        service: 'specification',
        method: 'post',
        path: `/specifications/${specId}/bulk-files`,
        body: {
          create: [
            {
              path: 'components/nested/deep.yaml',
              content: 'type: boolean\n',
              type: 'DEFAULT'
            }
          ]
        }
      });
      files = listFilesFromResponse((await listSpecFiles(gw, specId)).json).map(fileMeta);
      const parentId = componentsParentId(files);
      const encoded = await gw.request({
        service: 'specification',
        method: 'post',
        path: `/specifications/${specId}/files`,
        body: {
          name: 'with space.yaml',
          content: 'type: integer\n',
          type: 'DEFAULT',
          ...(parentId ? { parentId } : {})
        }
      });
      const duplicate = await gw.request({
        service: 'specification',
        method: 'post',
        path: `/specifications/${specId}/files`,
        body: {
          name: 'pet.yaml',
          content: 'type: string\n',
          type: 'DEFAULT',
          ...(parentId ? { parentId } : {})
        }
      });
      const nfc = await gw.request({
        service: 'specification',
        method: 'post',
        path: `/specifications/${specId}/files`,
        body: {
          name: 'cafe\u00e9.yaml',
          content: 'type: string\n',
          type: 'DEFAULT',
          ...(parentId ? { parentId } : {})
        }
      });
      const nfd = await gw.request({
        service: 'specification',
        method: 'post',
        path: `/specifications/${specId}/files`,
        body: {
          name: 'cafe\u0065\u0301.yaml',
          content: 'type: string\n',
          type: 'DEFAULT',
          ...(parentId ? { parentId } : {})
        }
      });
      files = listFilesFromResponse((await listSpecFiles(gw, specId)).json).map(fileMeta);
      const paths = files.map((f) => f.path);
      const nestedAccepted = nestedBulk.ok && paths.includes('components/nested/deep.yaml');
      results.P09 = {
        id: 'P09',
        passed: nestedAccepted,
        httpStatuses: [nestedBulk.status, encoded.status, duplicate.status, nfc.status, nfd.status],
        requestShape:
          'bulk create nested path; per-file name(+parentId) for encoded/duplicate/NFC',
        responseShape: 'per-candidate statuses',
        observed: {
          nestedAccepted,
          encodedAccepted: encoded.ok,
          duplicateRejected: !duplicate.ok,
          nfcAccepted: nfc.ok,
          nfdAccepted: nfd.ok,
          clientRejectsCollisionsLocally: true,
          pathCount: paths.length
        }
      };
      out(`[P09] nested=${nestedAccepted} duplicateRejected=${!duplicate.ok}`);
    }

    // ---- P10 failure injection for atomicity (full-set before/after readback) ----
    {
      files = listFilesFromResponse((await listSpecFiles(gw, specId)).json).map(fileMeta);
      const pet = byPath()['components/pet.yaml'];
      const beforeSnap = await captureSanitizedFullSetSnapshot(gw, specId);
      const beforeSnapshot = beforeSnap.members;
      const marker = `bundle-atomic-${createHash('sha256').update(stamp).digest('hex').slice(0, 8)}`;
      const bulkFail = await gw.request({
        service: 'specification',
        method: 'post',
        path: `/specifications/${specId}/bulk-files`,
        body: {
          create: [],
          update: [{ id: pet.id, content: petDependency(marker) }],
          delete: [{ id: '00000000-0000-0000-0000-000000000000' }]
        }
      });
      const afterSnap = await captureSanitizedFullSetSnapshot(gw, specId);
      const afterSnapshot = afterSnap.members;
      const fullSetUnchanged = sanitizedSnapshotsEqual(beforeSnapshot, afterSnapshot);
      const petAfter = afterSnapshot.find((entry) => entry.path === 'components/pet.yaml');
      const petBefore = beforeSnapshot.find((entry) => entry.path === 'components/pet.yaml');
      const bulkLanded = Boolean(petAfter && petBefore && petAfter.hash !== petBefore.hash);
      // atomicBulkProven requires rejection status AND complete equal full-set snapshots.
      const atomicBulkProven = bulkFail.status >= 400 && fullSetUnchanged;

      // Restore pet to known content before per-file failure injection.
      if (pet?.id) {
        await gw.request({
          service: 'specification',
          method: 'patch',
          path: `/specifications/${specId}/files/${pet.id}`,
          body: [{ op: 'replace', path: '/content', value: petDependency('bundle-v2') }]
        });
      }
      const marker2 = `${marker}-pf`;
      const validPatch = pet?.id
        ? await gw.request({
            service: 'specification',
            method: 'patch',
            path: `/specifications/${specId}/files/${pet.id}`,
            body: [{ op: 'replace', path: '/content', value: petDependency(marker2) }]
          })
        : { status: 0, ok: false };
      const invalidPatch = await gw.request({
        service: 'specification',
        method: 'patch',
        path: `/specifications/${specId}/files/00000000-0000-0000-0000-000000000000`,
        body: [{ op: 'replace', path: '/content', value: petDependency('should-not-matter') }]
      });
      const afterPerFile = pet?.id
        ? contentFromFileRead((await readSpecFile(gw, specId, pet.id)).json)
        : '';
      const perFileLanded = afterPerFile.includes(marker2);
      // Restore known companion content after per-file evidence capture.
      if (pet?.id) {
        await gw.request({
          service: 'specification',
          method: 'patch',
          path: `/specifications/${specId}/files/${pet.id}`,
          body: [{ op: 'replace', path: '/content', value: petDependency('bundle-v2') }]
        });
      }
      // Probe row passes when failure statuses + full-set readbacks were captured,
      // not only when bulk is atomic.
      const passed =
        Boolean(pet?.id) &&
        bulkFail.status > 0 &&
        invalidPatch.status > 0 &&
        beforeSnapshot.length > 0 &&
        afterSnapshot.length > 0;
      results.P10 = {
        id: 'P10',
        passed,
        httpStatuses: [beforeSnap.status, bulkFail.status, afterSnap.status, validPatch.status, invalidPatch.status].filter(
          (n) => n > 0
        ),
        requestShape:
          "bulk fail: update+delete(nonexistent); full-set path/role/hash readback; per-file: valid PATCH then PATCH nonexistent uuid",
        responseShape: 'failure-statuses+full-set-readback',
        observed: {
          bulkStatus: bulkFail.status,
          bulkLanded,
          fullSetUnchanged,
          perFileValidLanded: perFileLanded,
          perFileInvalidStatus: invalidPatch.status,
          atomicBulkProven,
          memberCount: beforeSnapshot.length,
          beforeSnapshot,
          afterSnapshot,
          partialApplicationOrder: !fullSetUnchanged
            ? ['bulk-partial-mutation-observed-in-full-set']
            : perFileLanded
              ? ['per-file-valid-patch-applied', 'per-file-invalid-patch-rejected']
              : ['no-partial-mutation-observed']
        }
      };
      out(
        `[P10] passed=${passed} atomicBulkProven=${atomicBulkProven} fullSetUnchanged=${fullSetUnchanged} bulkLanded=${bulkLanded} members=${beforeSnapshot.length}`
      );
    }

    // ---- P11 protobuf create/update/generate ----
    {
      const create = await gw.request({
        service: 'specification',
        method: 'post',
        path: `/specifications?containerType=workspace&containerId=${journal.workspaceId}`,
        body: {
          name: protoSpecName,
          type: 'PROTOBUF',
          files: [
            { path: 'service.proto', content: PROTO_ROOT, type: 'ROOT' },
            { path: 'types.proto', content: PROTO_TYPES, type: 'DEFAULT' }
          ]
        }
      });
      const protoId = String(asRecord(create.json?.data)?.id ?? create.json?.id ?? '').trim();
      if (protoId) {
        journal.protoSpecId = protoId;
        trackSpec(protoId);
      }
      let gen = { status: 0, collectionId: '', taskStatus: 'skipped' };
      let listedPaths = [];
      if (create.ok && protoId) {
        const listed = await listSpecFiles(gw, protoId);
        listedPaths = listFilesFromResponse(listed.json).map((f) => fileMeta(f).path);
        gen = await generateCollection(gw, protoId, `${collectionName}-proto`);
        trackCollection(gen.collectionId);
      }
      const passed =
        create.ok &&
        Boolean(protoId) &&
        listedPaths.includes('service.proto') &&
        listedPaths.includes('types.proto') &&
        generationOutcomePassed(gen);
      results.P11 = {
        id: 'P11',
        passed,
        httpStatuses: [create.status, gen.status].filter((n) => n > 0),
        requestShape:
          "POST /specifications type:'PROTOBUF' files ROOT+DEFAULT; POST .../collections",
        responseShape: JSON.stringify(shapeOf(create.json)),
        observed: {
          acceptedSpecType: create.ok ? 'PROTOBUF' : 'rejected',
          paths: listedPaths,
          generationTaskStatus: gen.taskStatus,
          generated: Boolean(gen.collectionId)
        }
      };
      out(`[P11] passed=${passed} (optional for R6)`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!blocker) blocker = message.slice(0, 200);
    err(`[probe] leg error: ${blocker}`);
  } finally {
    // Always run continue-safe cleanup after probe work (or probe failure).
    teardownOutcome = await cleanupJournaledResources(journal, {
      deleteCollection: (id) => deleteCollection(gw, id, leg.apiKey),
      deleteSpecification: (id) => deleteSpecification(gw, id),
      deleteWorkspace: (id) => deleteWorkspace(gw, id),
      readWorkspace: (id) =>
        gw.request({
          service: 'workspaces',
          method: 'get',
          path: `/workspaces/${id}`
        })
    });
  }

  out(
    `[teardown] deleted=${teardownOutcome.deletedKinds.length} residue=${teardownOutcome.residue}`
  );
  const ordered = REQUIRED_PROBE_IDS.map((id) => results[id]);
  return {
    blocker,
    leg: {
      mode: leg.mode,
      teamId: leg.teamId,
      results: ordered,
      teardown: {
        residue: Boolean(teardownOutcome.residue),
        deletedKinds: teardownOutcome.deletedKinds
      }
    },
    capabilities: computeCapabilities(ordered)
  };
}

function parseArgs(argv) {
  const legFlag = argv.find((arg) => arg.startsWith('--leg='));
  if (legFlag) return legFlag.slice('--leg='.length);
  const idx = argv.indexOf('--leg');
  if (idx >= 0) return argv[idx + 1] || '';
  return '';
}

async function main() {
  const legName = parseArgs(process.argv.slice(2));
  if (legName !== 'nonorg' && legName !== 'org') {
    err('Usage: node scripts/probe-multifile-spec-sync.mjs --leg nonorg|org');
    process.exitCode = 2;
    return;
  }

  const commit = currentBootstrapCommit();
  const legConfig = resolveLeg(legName);
  const outcome = await runLegProbe(legConfig);

  const existing = loadExistingReceipt();
  // Only merge a peer leg from the same bootstrap commit that already obeys the
  // P05 fixed contract (no fabricated pass with fixedContractAccepted=false).
  const otherLegs =
    Array.isArray(existing?.legs) && existing?.bootstrapCommit === commit
      ? existing.legs.filter((entry) => {
          const legRecord = asRecord(entry);
          if (!legRecord || legRecord.mode === legName) return false;
          const p05 = (Array.isArray(legRecord.results) ? legRecord.results : [])
            .map((row) => asRecord(row))
            .find((row) => row?.id === 'P05');
          if (p05?.passed === true && asRecord(p05.observed)?.fixedContractAccepted !== true) {
            return false;
          }
          // Drop superseded legs that still record the rejected {path} candidate.
          if (asRecord(p05?.observed)?.prdRequestShape || asRecord(p05?.observed)?.prdCandidateAccepted === false) {
            return false;
          }
          return true;
        })
      : [];
  const legs = [...otherLegs, outcome.leg].sort((a, b) =>
    String(a.mode).localeCompare(String(b.mode))
  );

  let capabilities = outcome.capabilities;
  if (legs.length === 2) {
    const byMode = Object.fromEntries(legs.map((entry) => [entry.mode, entry]));
    const caps = {};
    for (const key of CAPABILITY_KEYS) {
      const nonorgPass = computeCapabilities(byMode.nonorg.results)[key];
      const orgPass = computeCapabilities(byMode.org.results)[key];
      caps[key] = Boolean(nonorgPass) && Boolean(orgPass);
    }
    capabilities = caps;
  }

  const receipt = {
    schemaVersion: 1,
    testedAt: new Date().toISOString(),
    bootstrapCommit: commit,
    legs: legs.map((entry) => ({
      mode: entry.mode,
      teamId: entry.teamId,
      results: entry.results,
      teardown: entry.teardown
    })),
    capabilities
  };

  if (legs.length === 2) {
    try {
      writeReceipt(receipt);
      out(`[receipt] wrote dual-leg receipt capabilities=${JSON.stringify(capabilities)}`);
    } catch (error) {
      // Persist truthful dual-leg evidence even when the contract is unmet (e.g. P05).
      writeReceiptAllowingPartial(receipt);
      const message = error instanceof Error ? error.message : String(error);
      err(`[receipt] dual-leg receipt failed contract validation: ${message}`);
    }
  } else {
    writeReceiptAllowingPartial(receipt);
    out(`[receipt] wrote partial receipt for leg=${legName}; run the other leg to finalize`);
  }

  const p01p10 = outcome.leg.results.filter((row) => row.id !== 'P11');
  const allPassed = p01p10.every((row) => row.passed);
  const teardownClean = outcome.leg.teardown?.residue === false;
  const p05 = outcome.leg.results.find((row) => row.id === 'P05');
  const p05Blocked =
    p05 &&
    p05.passed !== true &&
    asRecord(p05.observed)?.fixedContractAccepted === false;

  if (p05Blocked) {
    err(
      "[BLOCKED] P05 fixed body {name,content,type:'DEFAULT',parentId} was not accepted; truthful failure evidence preserved"
    );
    process.exitCode = 1;
    return;
  }
  if (outcome.blocker && !allPassed) {
    err(`[blocker] ${outcome.blocker}`);
    process.exitCode = 1;
    return;
  }
  if (!allPassed) {
    err('[fail] P01-P10 did not all pass');
    process.exitCode = 1;
    return;
  }
  if (!teardownClean) {
    err('[fail] teardown reported residue');
    process.exitCode = 1;
    return;
  }
  out(`[pass] leg=${legName} P01-P10 passed teardown=clean P11=${outcome.leg.results.find((r) => r.id === 'P11')?.passed}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    err(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

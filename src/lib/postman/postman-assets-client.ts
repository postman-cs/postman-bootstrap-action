import { HttpError } from '../http-error.js';
import { retry } from '../retry.js';
import { createSecretMasker, type SecretMasker } from '../secrets.js';
import { POSTMAN_ENDPOINT_PROFILES } from './base-urls.js';
import { adviseFromWorkspaceCreateError } from './error-advice.js';

type EnvironmentValue = {
  key: string;
  type: string;
  value: string;
};

type JsonRecord = Record<string, unknown>;
type FetchResult = JsonRecord | null;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

export interface PostmanAssetsClientOptions {
  apiKey: string;
  baseUrl?: string;
  bifrostBaseUrl?: string;
  fetchImpl?: typeof fetch;
  secretMasker?: SecretMasker;
}

function extractWorkspacesPage(data: FetchResult): {
  nextCursor?: string;
  workspaces: unknown[];
} {
  const workspaces = Array.isArray(data?.workspaces) ? data.workspaces : [];
  const meta = asRecord(data?.meta);
  const pagination = asRecord(data?.pagination);
  const nextCursor = String(
    data?.nextCursor ??
    data?.next_cursor ??
    meta?.nextCursor ??
    meta?.next_cursor ??
    pagination?.nextCursor ??
    pagination?.next_cursor ??
    ''
  ).trim() || undefined;
  return { nextCursor, workspaces };
}

export function normalizeGitRepoUrl(url: string | null | undefined): string {
  const raw = String(url || '').trim();
  if (!raw) return '';

  // git@<host>:<owner>/<repo>.git  ->  https://<host>/<owner>/<repo>
  const sshMatch = raw.match(/^git@([^:]+):(.+)$/i);
  if (sshMatch?.[1] && sshMatch?.[2]) {
    return normalizeGitRepoUrl(`https://${sshMatch[1]}/${sshMatch[2]}`);
  }

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    const parts = parsed.pathname
      .replace(/^\/+|\/+$/g, '')
      .replace(/\.git$/i, '')
      .split('/')
      .filter(Boolean);
    if (parts.length < 2) return raw.replace(/\.git$/i, '').replace(/\/+$/g, '').toLowerCase();
    return `https://${host}/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
  } catch {
    return raw.replace(/\.git$/i, '').replace(/\/+$/g, '').toLowerCase();
  }
}

function extractGitRepoUrl(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') {
    const normalized = normalizeGitRepoUrl(value);
    // Accept any URL that looks like a hosted git repo (github.com, gitlab.com, or self-hosted)
    if (/^https:\/\/[^/]+\/[^/]+\/[^/]+$/.test(normalized)) return normalized;
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const repoUrl = extractGitRepoUrl(item);
      if (repoUrl) return repoUrl;
    }
    return null;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const preferredKeys = ['repo', 'repository', 'repoUrl', 'repo_url', 'remoteUrl', 'remote_url', 'origin'];
    for (const key of preferredKeys) {
      const repoUrl = extractGitRepoUrl(record[key]);
      if (repoUrl) return repoUrl;
    }
    for (const nested of Object.values(record)) {
      const repoUrl = extractGitRepoUrl(nested);
      if (repoUrl) return repoUrl;
    }
  }
  return null;
}

export class PostmanAssetsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly bifrostBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly secretMasker: SecretMasker;

  constructor(options: PostmanAssetsClientOptions) {
    this.apiKey = String(options.apiKey || '').trim();
    this.baseUrl = String(options.baseUrl || POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl).replace(
      /\/+$/,
      ''
    );
    this.bifrostBaseUrl = String(
      options.bifrostBaseUrl || POSTMAN_ENDPOINT_PROFILES.prod.bifrostBaseUrl
    ).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.secretMasker =
      options.secretMasker ?? createSecretMasker([this.apiKey]);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getBifrostBaseUrl(): string {
    return this.bifrostBaseUrl;
  }

  async getMe(): Promise<Record<string, unknown> | null> {
    return this.request('/me', { method: 'GET' }) as Promise<Record<string, unknown> | null>;
  }

  async getAutoDerivedTeamId(): Promise<string | undefined> {
    try {
      const data = await this.getMe();
      const user = data?.user;
      if (user && typeof user === 'object' && 'teamId' in user && user.teamId) {
        return String(user.teamId);
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  async getTeams(): Promise<Array<{ id: number; name: string; handle: string; organizationId?: number }>> {
    const data = await this.request('/teams');
    const teams = data?.data ?? [];
    return Array.isArray(teams)
      ? teams
          .map((entry) => asRecord(entry))
          .filter((team): team is JsonRecord => Boolean(team?.id && team?.name))
          .map((team) => ({
            id: Number(team.id),
            name: String(team.name),
            handle: String(team.handle || ''),
            ...(team.organizationId != null ? { organizationId: Number(team.organizationId) } : {})
          }))
      : [];
  }

  private async request(
    path: string,
    init: RequestInit = {}
  ): Promise<FetchResult> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': this.apiKey,
        ...(init.headers || {})
      }
    });

    if (!response.ok) {
      throw await HttpError.fromResponse(response, {
        method: init.method || 'GET',
        requestHeaders: {
          'Content-Type': 'application/json',
          'X-Api-Key': this.apiKey,
          ...(init.headers || {})
        },
        secretValues: [this.apiKey],
        url
      });
    }

    try {
      return (await response.json()) as JsonRecord;
    } catch {
      return null;
    }
  }

  async createWorkspace(name: string, about: string, targetTeamId?: number): Promise<{ id: string }> {
    return retry(async () => {
      const payload = {
        workspace: {
          about,
          name,
          type: 'team',
          ...(targetTeamId != null && !Number.isNaN(targetTeamId) ? { teamId: targetTeamId } : {})
        }
      };
      let created: FetchResult;
      try {
        created = await this.request('/workspaces', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
      } catch (err) {
        // v0.14.2 guidance, single-sourced in error-advice.ts so the wording
        // stays identical to the shared mapper.
        if (err instanceof Error) {
          const advised = adviseFromWorkspaceCreateError(err, targetTeamId);
          if (advised) {
            throw advised;
          }
        }
        throw err;
      }

      const createdWorkspace = asRecord(created?.workspace);
      const workspaceId = String(createdWorkspace?.id || '').trim();
      if (!workspaceId) {
        throw new Error('Workspace create did not return an id');
      }

      const workspace = await this.request(`/workspaces/${workspaceId}`);
      let visibility = asRecord(workspace?.workspace)?.visibility;
      if (visibility !== 'team') {
        await this.request(`/workspaces/${workspaceId}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
        const reread = await this.request(`/workspaces/${workspaceId}`);
        visibility = asRecord(reread?.workspace)?.visibility;
      }

      // Org-mode teams silently accept the corrective PUT above without
      // changing anything: a workspace created at the organization level
      // (missing or wrong teamId) stays personal-visibility, invisible to
      // teammates, other API keys, and the API Catalog, while every
      // downstream step still succeeds for the creator. Verify the
      // visibility actually took and refuse to hand back an invisible
      // workspace.
      if (typeof visibility === 'string' && visibility !== 'team') {
        let cleanedUp = false;
        try {
          await this.request(`/workspaces/${workspaceId}`, { method: 'DELETE' });
          cleanedUp = true;
        } catch {
          // The error below tells the operator to delete it manually.
        }
        throw new Error(
          `Workspace ${workspaceId} was created with visibility '${visibility}' and could not be promoted to team visibility. ` +
            'On org-mode accounts this happens when the workspace-team-id input is missing or wrong: ' +
            'the workspace is created at the organization level with personal visibility, so teammates, ' +
            'other API keys, and the API Catalog cannot see it. Set workspace-team-id to the sub-team ' +
            'that should own this workspace and re-run. ' +
            (cleanedUp
              ? 'The just-created workspace has been deleted so it does not hold the repository link invisibly.'
              : `Cleanup of the just-created workspace failed; delete workspace ${workspaceId} manually before re-running.`)
        );
      }

      return {
        id: workspaceId
      };
    }, {
      maxAttempts: 3,
      delayMs: 2000,
      shouldRetry: (err) =>
        !(err instanceof Error && err.message.includes('workspace-team-id'))
    });
  }

  /**
   * Visibility of a workspace as seen by this API key, or null when the
   * workspace cannot be read (deleted, or invisible to these credentials).
   */
  async getWorkspaceVisibility(workspaceId: string): Promise<string | null> {
    try {
      const workspace = await this.request(`/workspaces/${workspaceId}`);
      const visibility = asRecord(workspace?.workspace)?.visibility;
      return typeof visibility === 'string' ? visibility : null;
    } catch {
      return null;
    }
  }

  async listWorkspaces(): Promise<Array<{ id: string; name: string; type: string }>> {
    const allWorkspaces: unknown[] = [];
    const seenCursors = new Set<string>();
    let nextCursor: string | undefined;

    do {
      const query = nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : '';
      const data = await this.request(`/workspaces${query}`);
      const page = extractWorkspacesPage(data);
      allWorkspaces.push(...page.workspaces);

      if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
        nextCursor = undefined;
      } else {
        seenCursors.add(page.nextCursor);
        nextCursor = page.nextCursor;
      }
    } while (nextCursor);

    return allWorkspaces
          .map((entry) => asRecord(entry))
          .filter((workspace): workspace is JsonRecord => Boolean(workspace?.id && workspace?.name))
          .map((workspace) => ({
            id: String(workspace.id),
            name: String(workspace.name),
            type: String(workspace.type ?? 'team')
          }));
  }

  async findWorkspacesByName(name: string): Promise<Array<{ id: string; name: string }>> {
    const workspaces = await this.listWorkspaces();
    return workspaces
      .filter((w) => w.name === name)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((w) => ({ id: w.id, name: w.name }));
  }

  async getWorkspaceGitRepoUrl(
    workspaceId: string,
    teamId: string,
    accessToken: string
  ): Promise<string | null> {
    const url = `${this.bifrostBaseUrl}/ws/proxy`;
    const headers: Record<string, string> = {
      'x-access-token': accessToken,
      'Content-Type': 'application/json'
    };
    if (teamId) {
      headers['x-entity-team-id'] = teamId;
    }

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        service: 'workspaces',
        method: 'GET',
        path: `/workspaces/${workspaceId}/filesystem`
      })
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      throw await HttpError.fromResponse(response, {
        method: 'POST',
        requestHeaders: headers,
        secretValues: [this.apiKey, accessToken],
        url
      });
    }

    const body = await response.text();
    if (!body.trim()) return null;

    try {
      return extractGitRepoUrl(JSON.parse(body));
    } catch {
      return extractGitRepoUrl(body);
    }
  }

  async inviteRequesterToWorkspace(
    workspaceId: string,
    email: string
  ): Promise<void> {
    const users = await this.request('/users');
    const userList = Array.isArray(users?.data) ? users.data : [];
    const user = userList
      .map((entry) => asRecord(entry))
      .find((entry) => entry?.email === email);
    if (!user?.id) {
      return;
    }

    await this.request(`/workspaces/${workspaceId}/roles`, {
      method: 'PATCH',
      body: JSON.stringify({
        roles: [
          {
            op: 'add',
            path: '/user',
            value: [{ id: user.id, role: 2 }]
          }
        ]
      })
    });
  }

  async addAdminsToWorkspace(
    workspaceId: string,
    adminIds: string
  ): Promise<void> {
    const ids = String(adminIds || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      return;
    }

    await this.request(`/workspaces/${workspaceId}/roles`, {
      method: 'PATCH',
      body: JSON.stringify({
        roles: [
          {
            op: 'add',
            path: '/user',
            value: ids.map((id) => ({
              id: Number.parseInt(id, 10),
              role: 3
            }))
          }
        ]
      })
    });
  }

  async uploadSpec(
    workspaceId: string,
    projectName: string,
    specContent: string,
    openapiVersion: string = '3.0'
  ): Promise<string> {
    if (openapiVersion !== '3.0' && openapiVersion !== '3.1') {
      throw new Error(`uploadSpec: unsupported openapiVersion "${openapiVersion}". Expected '3.0' or '3.1'.`);
    }
    const specType = openapiVersion === '3.1' ? 'OPENAPI:3.1' : 'OPENAPI:3.0';
    const response = await this.request(`/specs?workspaceId=${workspaceId}`, {
      method: 'POST',
      body: JSON.stringify({
        name: projectName,
        type: specType,
        files: [{ path: 'index.yaml', content: specContent }]
      })
    });

    const specId = String(response?.id || '').trim();
    if (!specId) {
      throw new Error('Spec upload did not return an ID');
    }

    await retry(async () => {
      const verified = await this.request(`/specs/${specId}?workspaceId=${workspaceId}`);
      if (verified?.id !== specId) {
        throw new Error(`Spec preflight response did not contain expected id ${specId}`);
      }
    }, { maxAttempts: 3, delayMs: 2000 });

    return specId;
  }


  async updateSpec(
    specId: string,
    specContent: string,
    workspaceId?: string
  ): Promise<void> {
    void workspaceId;
    // Postman Spec Hub uses PATCH /specs/{specId}/files/{filePath} for updates.
    // PUT /specs/{specId} is not a valid endpoint and returns 404.
    await this.request(`/specs/${specId}/files/index.yaml`, {
      method: 'PATCH',
      body: JSON.stringify({ content: specContent })
    });
  }

  async getSpecContent(specId: string): Promise<string | undefined> {
    try {
      const result = await this.request(`/specs/${specId}/files/index.yaml`);
      return typeof result?.content === 'string' ? result.content : undefined;
    } catch {
      return undefined;
    }
  }

  async generateCollection(
    specId: string,
    projectName: string,
    prefix: string,
    folderStrategy: string,
    nestedFolderHierarchy: boolean,
    requestNameSource: string
  ): Promise<string> {
    const name = [prefix.trim(), projectName.trim()].filter(Boolean).join(' ');
    const payload = {
      name,
      options: {
        requestNameSource,
        folderStrategy,
        ...(folderStrategy === 'Tags' ? { nestedFolderHierarchy } : {})
      }
    };

    const extractUid = (data: unknown): string | undefined => {
      const root = asRecord(data);
      const details = asRecord(root?.details);
      const resources = Array.isArray(details?.resources) ? details.resources : [];
      const firstResource = asRecord(resources[0]);
      const collection = asRecord(root?.collection);
      const resource = asRecord(root?.resource);
      return String(
        firstResource?.id ??
        collection?.id ??
        collection?.uid ??
        resource?.uid ??
        resource?.id ??
        ''
      ).trim() || undefined;
    };

    const maxLockedRetries = 5;
    let generationResponse: FetchResult | undefined;

    for (let lockedAttempt = 0; ; lockedAttempt += 1) {
      try {
        generationResponse = await this.request(`/specs/${specId}/generations/collection`, {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        break;
      } catch (error) {
        const message = this.secretMasker(
          error instanceof Error ? error.message : String(error)
        );
        const isLocked = message.includes('423');
        if (!isLocked || lockedAttempt >= maxLockedRetries) {
          throw error;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 5000 * Math.pow(2, lockedAttempt));
        });
      }
    }

    if (!generationResponse) {
      throw new Error(`Collection generation request did not return a response for ${prefix}`);
    }

    const directUid = extractUid(generationResponse);
    if (directUid) {
      return directUid;
    }

    let taskUrl =
      String(generationResponse?.url ?? '') ||
      String(generationResponse?.task_url ?? '') ||
      String(generationResponse?.taskUrl ?? '') ||
      String(asRecord(generationResponse?.links)?.task ?? '');
    if (!taskUrl) {
      const task = asRecord(generationResponse?.task);
      const taskId = generationResponse?.taskId || task?.id || generationResponse?.id;
      if (!taskId) {
        throw new Error(
          `Collection generation did not return a task URL or ID for ${prefix}`
        );
      }
      taskUrl = `/specs/${specId}/tasks/${taskId}`;
    }

    for (let attempt = 0; attempt < 45; attempt += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 2000);
      });
      const task = await this.request(taskUrl);
      const taskRecord = asRecord(task);
      const taskNested = asRecord(taskRecord?.task);
      const status = String(taskRecord?.status || taskNested?.status || '').toLowerCase();
      if (status === 'completed') {
        const taskUid = extractUid(task);
        if (!taskUid) {
          throw new Error(`Task completed but no UID found for ${prefix}`);
        }
        return taskUid;
      }
      if (status === 'failed') {
        throw new Error(`Task failed for ${prefix}`);
      }
    }

    throw new Error(`Collection generation timed out for ${prefix}`);
  }

  async tagCollection(collectionUid: string, tags: string[]): Promise<void> {
    const normalized = tags
      .map((entry) =>
        String(entry || '')
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9-]+/g, '-')
          .replace(/^-+|-+$/g, '')
      )
      .filter((entry) => /^[a-z][a-z0-9-]*[a-z0-9]$/.test(entry));

    if (normalized.length === 0) {
      throw new Error(`No valid tag slugs to apply for collection ${collectionUid}`);
    }

    await this.request(`/collections/${collectionUid}/tags`, {
      method: 'PUT',
      body: JSON.stringify({
        tags: normalized.map((slug) => ({ slug }))
      })
    });
  }

  async injectTests(
    collectionUid: string,
    type: 'smoke'
  ): Promise<void> {
    const collectionResponse = await this.request(`/collections/${collectionUid}`);
    const collection = asRecord(collectionResponse?.collection);
    if (!collection) {
      throw new Error(`Failed to fetch collection ${collectionUid}`);
    }

    const smokeTests = [
      "// [Smoke] Auto-generated test assertions",
      "",
      "pm.test('Status code is successful (2xx)', function () {",
      "    pm.response.to.be.success;",
      "});",
      "",
      "pm.test('Response time is acceptable', function () {",
      "    var threshold = parseInt(pm.environment.get('RESPONSE_TIME_THRESHOLD') || '2000', 10);",
      "    pm.expect(pm.response.responseTime).to.be.below(threshold);",
      "});",
      "",
      "pm.test('Response body is not empty', function () {",
      "    if (pm.response.code !== 204) {",
      "        var body = pm.response.text();",
      "        pm.expect(body.length).to.be.above(0);",
      "    }",
      "});"
    ];
    const request0Item = {
      name: '00 - Resolve Secrets',
      request: {
        auth: {
          type: 'awsv4',
          awsv4: [
            { key: 'accessKey', value: '{{AWS_ACCESS_KEY_ID}}' },
            { key: 'secretKey', value: '{{AWS_SECRET_ACCESS_KEY}}' },
            { key: 'region', value: '{{AWS_REGION}}' },
            { key: 'service', value: 'secretsmanager' }
          ]
        },
        method: 'POST',
        header: [
          { key: 'X-Amz-Target', value: 'secretsmanager.GetSecretValue' },
          { key: 'Content-Type', value: 'application/x-amz-json-1.1' }
        ],
        body: {
          mode: 'raw',
          raw: '{"SecretId": "{{AWS_SECRET_NAME}}"}'
        },
        url: {
          raw: 'https://secretsmanager.{{AWS_REGION}}.amazonaws.com',
          protocol: 'https',
          host: ['secretsmanager', '{{AWS_REGION}}', 'amazonaws', 'com']
        }
      },
      event: [
        {
          listen: 'test',
          script: {
            exec: [
              'if (pm.environment.get("CI") === "true") { return; }',
              'const body = pm.response.json();',
              'if (body.SecretString) {',
              '  const secrets = JSON.parse(body.SecretString);',
              '  Object.entries(secrets).forEach(([k, v]) => pm.collectionVariables.set(k, v));',
              '}'
            ]
          }
        }
      ]
    };

    void type;

    const injectScripts = (itemNode: Record<string, unknown>) => {
      if (itemNode.name === '00 - Resolve Secrets') {
        return;
      }

      if (itemNode.request) {
        const scriptsToInject = smokeTests;
        const events = Array.isArray(itemNode.event) ? itemNode.event : [];
        itemNode.event = events.filter(
          (entry: { listen?: string }) => entry.listen !== 'test'
        );
        (itemNode.event as Array<Record<string, unknown>>).push({
          listen: 'test',
          script: {
            type: 'text/javascript',
            exec: scriptsToInject
          }
        });
      }
      if (Array.isArray(itemNode.item)) {
        itemNode.item
          .map((entry) => asRecord(entry))
          .filter((entry): entry is JsonRecord => Boolean(entry))
          .forEach(injectScripts);
      }
    };

    if (Array.isArray(collection.item)) {
      // Remove any existing secrets resolver to prevent duplicates on reruns
      const collectionItems = collection.item as Array<Record<string, unknown>>;
      collection.item = collectionItems.filter(
        (entry: { name?: string }) => entry.name !== '00 - Resolve Secrets'
      );
      (collection.item as Array<Record<string, unknown>>).forEach(injectScripts);
    } else {
      collection.item = [];
    }

    (collection.item as Array<Record<string, unknown>>).unshift(request0Item);

    await this.request(`/collections/${collectionUid}`, {
      method: 'PUT',
      body: JSON.stringify({ collection })
    });
  }

  async createEnvironment(
    workspaceId: string,
    name: string,
    values: EnvironmentValue[]
  ): Promise<string> {
    const response = await this.request(`/environments?workspace=${workspaceId}`, {
      method: 'POST',
      body: JSON.stringify({
        environment: {
          name,
          values
        }
      })
    });

    const environment = asRecord(response?.environment);
    const uid = String(environment?.uid || '').trim();
    if (!uid) {
      throw new Error('Environment create did not return a UID');
    }
    return uid;
  }

  async updateEnvironment(
    uid: string,
    name: string,
    values: EnvironmentValue[]
  ): Promise<void> {
    await this.request(`/environments/${uid}`, {
      method: 'PUT',
      body: JSON.stringify({
        environment: {
          name,
          values
        }
      })
    });
  }

  async createMonitor(
    workspaceId: string,
    name: string,
    collectionUid: string,
    environmentUid: string
  ): Promise<string> {
    const response = await this.request(`/monitors?workspace=${workspaceId}`, {
      method: 'POST',
      body: JSON.stringify({
        monitor: {
          name,
          collection: collectionUid,
          environment: environmentUid,
          schedule: {
            cron: '*/5 * * * *',
            timezone: 'UTC'
          }
        }
      })
    });

    const monitor = asRecord(response?.monitor);
    const uid = String(monitor?.uid || '').trim();
    if (!uid) {
      throw new Error('Monitor create did not return a UID');
    }
    return uid;
  }

  async createMock(
    workspaceId: string,
    name: string,
    collectionUid: string,
    environmentUid: string
  ): Promise<{ uid: string; url: string }> {
    const response = await this.request(`/mocks?workspace=${workspaceId}`, {
      method: 'POST',
      body: JSON.stringify({
        mock: {
          name,
          collection: collectionUid,
          environment: environmentUid,
          private: false
        }
      })
    });

    const mock = asRecord(response?.mock);
    const mockConfig = asRecord(mock?.config);
    const uid = String(mock?.uid || '').trim();
    if (!uid) {
      throw new Error('Mock create did not return a UID');
    }

    return {
      uid,
      url:
        String(mock?.mockUrl || '').trim() ||
        String(mockConfig?.serverResponseId || '').trim()
    };
  }

  async getCollection(uid: string): Promise<unknown> {
    const response = await this.request(`/collections/${uid}`);
    return response?.collection;
  }

  /**
   * Create a collection in a workspace from a fully-formed collection object
   * (v2.1.0 or v3/EC). Used by the multi-protocol path, which builds and
   * instruments collections locally rather than generating them from Spec Hub.
   * Returns the new collection UID.
   */
  async createCollection(workspaceId: string, collection: unknown): Promise<string> {
    const response = await this.request(`/collections?workspace=${workspaceId}`, {
      method: 'POST',
      body: JSON.stringify({ collection })
    });
    const created = asRecord(response?.collection);
    const uid = String(created?.uid ?? created?.id ?? '').trim();
    if (!uid) {
      throw new Error('Collection creation did not return a UID');
    }
    return uid;
  }

  async updateCollection(collectionUid: string, collection: unknown): Promise<void> {
    await this.request(`/collections/${collectionUid}`, {
      method: 'PUT',
      body: JSON.stringify({ collection })
    });
  }

  async deleteCollection(collectionUid: string): Promise<void> {
    try {
      await this.request(`/collections/${collectionUid}`, {
        method: 'DELETE'
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        return;
      }
      throw error;
    }
  }

  async getEnvironment(uid: string): Promise<unknown> {
    const response = await this.request(`/environments/${uid}`);
    return response?.environment;
  }

  async getEnvironments(workspaceId: string): Promise<unknown[]> {
    const response = await this.request(`/environments?workspace=${workspaceId}`);
    return Array.isArray(response?.environments) ? response.environments : [];
  }
}

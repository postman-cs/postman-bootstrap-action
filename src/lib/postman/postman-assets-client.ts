import { HttpError } from '../http-error.js';
import { retry } from '../retry.js';
import { createSecretMasker, type SecretMasker } from '../secrets.js';

type EnvironmentValue = {
  key: string;
  type: string;
  value: string;
};

type FetchResult = Record<string, any> | null;

export interface PostmanAssetsClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  secretMasker?: SecretMasker;
}

export class PostmanAssetsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly secretMasker: SecretMasker;

  constructor(options: PostmanAssetsClientOptions) {
    this.apiKey = String(options.apiKey || '').trim();
    this.baseUrl = String(options.baseUrl || 'https://api.getpostman.com').replace(
      /\/+$/,
      ''
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.secretMasker =
      options.secretMasker ?? createSecretMasker([this.apiKey]);
  }

  getBaseUrl(): string {
    return this.baseUrl;
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
      return (await response.json()) as Record<string, any>;
    } catch {
      return null;
    }
  }

  async createWorkspace(name: string, about: string): Promise<{ id: string }> {
    return retry(async () => {
      const payload = {
        workspace: {
          about,
          name,
          type: 'team'
        }
      };
      let created;
      try {
        created = await this.request('/workspaces', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
      } catch (err) {
        if (err instanceof Error && err.message.includes('Only personal workspaces')) {
          throw new Error(
            'Workspace creation failed: Your team may have Org Mode enabled. Org-level workspaces require a different API request schema which is currently unsupported in this alpha version.'
          );
        }
        throw err;
      }

      const workspaceId = created?.workspace?.id;
      if (!workspaceId) {
        throw new Error('Workspace create did not return an id');
      }

      const workspace = await this.request(`/workspaces/${workspaceId}`);
      if (workspace?.workspace?.visibility !== 'team') {
        await this.request(`/workspaces/${workspaceId}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
      }

      return {
        id: workspaceId
      };
    }, 3, 2000);
  }

  async inviteRequesterToWorkspace(
    workspaceId: string,
    email: string
  ): Promise<void> {
    const users = await this.request('/users');
    const user = users?.data?.find((entry: any) => entry.email === email);
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
    specContent: string
  ): Promise<string> {
    const response = await this.request(`/specs?workspaceId=${workspaceId}`, {
      method: 'POST',
      body: JSON.stringify({
        name: projectName,
        type: 'OPENAPI:3.0',
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
    }, 3, 2000);

    return specId;
  }


  async updateSpec(
    specId: string,
    specContent: string,
    _workspaceId?: string
  ): Promise<void> {
    // Postman Spec Hub uses PATCH /specs/{specId}/files/{filePath} for updates.
    // PUT /specs/{specId} is not a valid endpoint and returns 404.
    await this.request(`/specs/${specId}/files/index.yaml`, {
      method: 'PATCH',
      body: JSON.stringify({ content: specContent })
    });
  }

  async generateCollection(
    specId: string,
    projectName: string,
    prefix: string
  ): Promise<string> {
    const payload = {
      name: `${prefix} ${projectName}`,
      options: {
        requestNameSource: 'Fallback'
      }
    };

    const extractUid = (data: any): string =>
      data?.details?.resources?.[0]?.id ||
      data?.collection?.id ||
      data?.collection?.uid ||
      data?.resource?.uid ||
      data?.resource?.id ||
      '';

    return retry(
      async () => {
        const maxLockedRetries = 5;
        let response: FetchResult = null;

        for (let lockedAttempt = 0; ; lockedAttempt += 1) {
          try {
            response = await this.request(`/specs/${specId}/generations/collection`, {
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

        const directUid = extractUid(response);
        if (directUid) {
          return directUid;
        }

        let taskUrl =
          response?.url ||
          response?.task_url ||
          response?.taskUrl ||
          response?.links?.task;
        if (!taskUrl) {
          const taskId = response?.taskId || response?.task?.id || response?.id;
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
          const status = String(task?.status || task?.task?.status || '').toLowerCase();
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
      },
      {
        maxAttempts: 4,
        delayMs: 2000
      }
    );
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

  async injectTests(collectionUid: string, type: 'contract' | 'smoke'): Promise<void> {
    const collectionResponse = await this.request(`/collections/${collectionUid}`);
    const collection = collectionResponse?.collection;
    if (!collection) {
      throw new Error(`Failed to fetch collection ${collectionUid}`);
    }

    const smokeTests = [
      "// [Smoke] Auto-generated test assertions",
      "",
      "pm.test('Status code is successful (2xx)', function () {",
      "    pm.response.to.be.success;",
      "});"
    ];
    const contractTests = [
      "// [Contract] Auto-generated contract test assertions",
      "",
      "pm.test('Status code is successful (2xx)', function () {",
      "    pm.response.to.be.success;",
      "});"
    ];

    const scriptsToInject = type === 'smoke' ? smokeTests : contractTests;
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
              'const body = pm.response.json();'
            ]
          }
        }
      ]
    };

    const injectScripts = (itemNode: any) => {
      if (itemNode.name === '00 - Resolve Secrets') {
        return;
      }

      if (itemNode.request) {
        itemNode.event = (itemNode.event || []).filter(
          (entry: any) => entry.listen !== 'test'
        );
        itemNode.event.push({
          listen: 'test',
          script: {
            type: 'text/javascript',
            exec: scriptsToInject
          }
        });
      }
      if (Array.isArray(itemNode.item)) {
        itemNode.item.forEach(injectScripts);
      }
    };

    if (Array.isArray(collection.item)) {
      // Remove any existing secrets resolver to prevent duplicates on reruns
      collection.item = collection.item.filter(
        (entry: any) => entry.name !== '00 - Resolve Secrets'
      );
      collection.item.forEach(injectScripts);
    } else {
      collection.item = [];
    }

    collection.item.unshift(request0Item);

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

    const uid = String(response?.environment?.uid || '').trim();
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

    const uid = String(response?.monitor?.uid || '').trim();
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

    const uid = String(response?.mock?.uid || '').trim();
    if (!uid) {
      throw new Error('Mock create did not return a UID');
    }

    return {
      uid,
      url:
        String(response?.mock?.mockUrl || '').trim() ||
        String(response?.mock?.config?.serverResponseId || '').trim()
    };
  }

  async getCollection(uid: string): Promise<any> {
    const response = await this.request(`/collections/${uid}`);
    return response?.collection;
  }

  async getEnvironment(uid: string): Promise<any> {
    const response = await this.request(`/environments/${uid}`);
    return response?.environment;
  }

  async getEnvironments(workspaceId: string): Promise<any[]> {
    const response = await this.request(`/environments?workspace=${workspaceId}`);
    return response?.environments || [];
  }
}

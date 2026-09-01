import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildContractIndex } from '../src/lib/spec/contract-index.js';
import {
  applyCollectionRootScripts,
  applyCollectionRootVariables,
  resolveCollectionRootContent,
  SMOKE_FLOW_OAUTH_EVENT_MARKER
} from '../src/lib/spec/collection-root-content.js';
import { generateLocalOpenApiRolePayloads } from '../src/lib/spec/local-openapi-collection-generation.js';
import { parseOpenApiDocument } from '../src/lib/spec/openapi-loader.js';

type JsonRecord = Record<string, unknown>;

const SIGNER_SOURCE = [
  '// Mastercard OAuth 1.0a RSA-SHA256 signer',
  "var oauth = eval(pm.collectionVariables.get('signerLib'));",
  "pm.request.headers.add({ key: 'Authorization', value: oauth.sign(pm.request) });"
].join('\n');

const names = {
  baseline: 'Pet API',
  smoke: '[Smoke] Pet API',
  contract: '[Contract] Pet API'
};

const oas30 = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Pet API', version: '1.0.0' },
  servers: [{ url: 'https://api.example.test/v1' }],
  paths: {
    '/pets': {
      get: {
        summary: 'List pets',
        operationId: 'listPets',
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { example: [{ id: 'pet-1' }] } }
          }
        }
      }
    }
  }
});

function record(value: unknown): JsonRecord {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
  return value as JsonRecord;
}

function array(value: unknown): unknown[] {
  expect(Array.isArray(value)).toBe(true);
  return value as unknown[];
}

function baseOptions() {
  return {
    openApiVersion: '3.0' as const,
    requestNameSource: 'Fallback' as const,
    folderStrategy: 'Paths' as const,
    names,
    contractIndex: buildContractIndex(parseOpenApiDocument(oas30))
  };
}

/** Collection-root events of one listen phase, joined exactly as sent. */
function rootScriptSources(collection: JsonRecord, listen: string): string[] {
  return array(collection.event ?? [])
    .map(record)
    .filter((event) => event.listen === listen)
    .map((event) => {
      const exec = record(event.script).exec;
      return Array.isArray(exec) ? exec.map(String).join('\n') : String(exec ?? '');
    });
}

function rootVariables(collection: JsonRecord): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of array(collection.variable ?? []).map(record)) {
    out[String(entry.key)] = String(entry.value ?? '');
  }
  return out;
}

/** Workspace with a committed signer script, mirroring the customer repo layout. */
function workspaceWithSigner(source = SIGNER_SOURCE): string {
  const root = mkdtempSync(path.join(tmpdir(), 'collection-root-content-'));
  mkdirSync(path.join(root, '.postman', 'scripts'), { recursive: true });
  writeFileSync(path.join(root, '.postman', 'scripts', 'signer.js'), source, 'utf8');
  return root;
}

const SCRIPTS_INLINE = JSON.stringify({
  schemaVersion: 1,
  roles: { '*': { beforeRequest: '.postman/scripts/signer.js' } }
});

const VARIABLES_INLINE = JSON.stringify({
  schemaVersion: 1,
  roles: { '*': { consumerKey: '', signerLib: '', signatureMethod: 'RSA-SHA256' } }
});

describe('collection-root content resolution', () => {
  it('resolves to undefined when neither input is set', () => {
    expect(resolveCollectionRootContent(undefined, undefined, workspaceWithSigner())).toBeUndefined();
    expect(resolveCollectionRootContent('', '   ', workspaceWithSigner())).toBeUndefined();
  });

  it('accepts an inline JSON manifest and inlines the script source', () => {
    const root = workspaceWithSigner();
    const content = resolveCollectionRootContent(SCRIPTS_INLINE, undefined, root);
    expect(content?.scripts?.baseline?.beforeRequest).toBe(SIGNER_SOURCE);
    expect(content?.scripts?.smoke?.beforeRequest).toBe(SIGNER_SOURCE);
    expect(content?.scripts?.contract?.beforeRequest).toBe(SIGNER_SOURCE);
    expect(content?.variables).toBeUndefined();
  });

  it('accepts a workspace-relative manifest path so ADO callers avoid nested JSON quoting', () => {
    const root = workspaceWithSigner();
    writeFileSync(path.join(root, '.postman', 'collection-scripts.json'), SCRIPTS_INLINE, 'utf8');
    const content = resolveCollectionRootContent(
      '.postman/collection-scripts.json',
      undefined,
      root
    );
    expect(content?.scripts?.contract?.beforeRequest).toBe(SIGNER_SOURCE);
  });

  it('lets a role key override the wildcard for the same script type', () => {
    const root = workspaceWithSigner();
    writeFileSync(path.join(root, '.postman', 'scripts', 'contract-only.js'), '// contract only', 'utf8');
    const content = resolveCollectionRootContent(
      JSON.stringify({
        schemaVersion: 1,
        roles: {
          '*': { beforeRequest: '.postman/scripts/signer.js' },
          contract: { beforeRequest: '.postman/scripts/contract-only.js' }
        }
      }),
      undefined,
      root
    );
    expect(content?.scripts?.baseline?.beforeRequest).toBe(SIGNER_SOURCE);
    expect(content?.scripts?.contract?.beforeRequest).toBe('// contract only');
  });

  it('normalizes CRLF and trailing newlines so a rerun digests identically', () => {
    const root = workspaceWithSigner('line one\r\nline two\r\n\n');
    const content = resolveCollectionRootContent(SCRIPTS_INLINE, undefined, root);
    expect(content?.scripts?.smoke?.beforeRequest).toBe('line one\nline two');
  });

  it('resolves declared variables for every role without touching the filesystem', () => {
    const content = resolveCollectionRootContent(undefined, VARIABLES_INLINE, workspaceWithSigner());
    expect(content?.scripts).toBeUndefined();
    expect(content?.variables?.baseline).toEqual({
      consumerKey: '',
      signerLib: '',
      signatureMethod: 'RSA-SHA256'
    });
    expect(content?.variables?.contract).toEqual(content?.variables?.baseline);
  });

  describe('rejections', () => {
    const cases: Array<[string, string, string]> = [
      ['a wrong schema version', JSON.stringify({ schemaVersion: 2, roles: {} }), 'schemaVersion must be 1'],
      ['an unknown envelope field', JSON.stringify({ schemaVersion: 1, roles: {}, extra: 1 }), 'unknown field extra'],
      ['an empty roles map', JSON.stringify({ schemaVersion: 1, roles: {} }), 'must declare at least one entry'],
      [
        'an unknown role key',
        JSON.stringify({ schemaVersion: 1, roles: { staging: { beforeRequest: 'a.js' } } }),
        'roles key staging must be *'
      ],
      [
        'an unknown script type',
        JSON.stringify({ schemaVersion: 1, roles: { '*': { onError: 'a.js' } } }),
        'is not a supported script type'
      ],
      [
        'the reserved afterResponse phase',
        JSON.stringify({ schemaVersion: 1, roles: { '*': { afterResponse: 'a.js' } } }),
        'reserved but not yet applied'
      ],
      [
        'an absolute script path',
        JSON.stringify({ schemaVersion: 1, roles: { '*': { beforeRequest: '/etc/passwd' } } }),
        'must be workspace-relative'
      ],
      ['malformed JSON', '{ not json', 'must be valid JSON object content']
    ];

    for (const [label, manifest, expected] of cases) {
      it(`rejects ${label}`, () => {
        expect(() => resolveCollectionRootContent(manifest, undefined, workspaceWithSigner())).toThrow(
          new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        );
      });
    }

    it('rejects a script path that does not exist', () => {
      expect(() =>
        resolveCollectionRootContent(
          JSON.stringify({ schemaVersion: 1, roles: { '*': { beforeRequest: '.postman/scripts/nope.js' } } }),
          undefined,
          workspaceWithSigner()
        )
      ).toThrow(/COLLECTION_SCRIPT_UNREADABLE/);
    });

    it('rejects an empty script file', () => {
      expect(() =>
        resolveCollectionRootContent(SCRIPTS_INLINE, undefined, workspaceWithSigner(''))
      ).toThrow(/COLLECTION_SCRIPT_EMPTY/);
    });

    it('rejects a symlink escaping the workspace', () => {
      const root = workspaceWithSigner();
      const outside = mkdtempSync(path.join(tmpdir(), 'outside-'));
      writeFileSync(path.join(outside, 'host.js'), '// host file', 'utf8');
      symlinkSync(path.join(outside, 'host.js'), path.join(root, '.postman', 'scripts', 'escape.js'));
      expect(() =>
        resolveCollectionRootContent(
          JSON.stringify({ schemaVersion: 1, roles: { '*': { beforeRequest: '.postman/scripts/escape.js' } } }),
          undefined,
          root
        )
      ).toThrow(/COLLECTION_SCRIPT_OUTSIDE_WORKSPACE/);
    });

    it('rejects a script carrying the smoke-flow generated-OAuth marker', () => {
      const root = workspaceWithSigner(`// ${SMOKE_FLOW_OAUTH_EVENT_MARKER}\nvar t = 1;`);
      expect(() => resolveCollectionRootContent(SCRIPTS_INLINE, undefined, root)).toThrow(
        /COLLECTION_SCRIPT_RESERVED_MARKER/
      );
    });

    it('rejects a non-string variable value', () => {
      expect(() =>
        resolveCollectionRootContent(
          undefined,
          JSON.stringify({ schemaVersion: 1, roles: { '*': { timeout: 30 } } }),
          workspaceWithSigner()
        )
      ).toThrow(/must be a string/);
    });
  });
});

describe('collection-root content application', () => {
  it('replaces rather than appends its own phase so a rerun converges', () => {
    const collection: JsonRecord = { info: { name: 'c' }, item: [] };
    applyCollectionRootScripts(collection, { beforeRequest: 'first' });
    applyCollectionRootScripts(collection, { beforeRequest: 'second' });
    expect(rootScriptSources(collection, 'prerequest')).toEqual(['second']);
  });

  it('preserves collection-root test events belonging to contract instrumentation', () => {
    const collection: JsonRecord = {
      info: { name: 'c' },
      event: [{ listen: 'test', script: { type: 'text/javascript', exec: ['// contract shard'] } }],
      item: []
    };
    applyCollectionRootScripts(collection, { beforeRequest: SIGNER_SOURCE });
    expect(rootScriptSources(collection, 'test')).toEqual(['// contract shard']);
    expect(rootScriptSources(collection, 'prerequest')).toEqual([SIGNER_SOURCE]);
  });

  it('updates a spec-derived variable in place and appends new keys in manifest order', () => {
    const collection: JsonRecord = {
      info: { name: 'c' },
      variable: [{ key: 'baseUrl', value: 'https://api.example.test/v1' }],
      item: []
    };
    applyCollectionRootVariables(collection, { consumerKey: '', baseUrl: 'https://override.test' });
    expect(array(collection.variable).map((entry) => String(record(entry).key))).toEqual([
      'baseUrl',
      'consumerKey'
    ]);
    expect(rootVariables(collection)).toEqual({
      baseUrl: 'https://override.test',
      consumerKey: ''
    });
  });
});

describe('collection-root content in generated role payloads', () => {
  it('leaves payloads and digests byte-identical when the inputs are absent', async () => {
    const withoutOption = await generateLocalOpenApiRolePayloads(oas30, baseOptions());
    const withUndefined = await generateLocalOpenApiRolePayloads(oas30, {
      ...baseOptions(),
      collectionRootContent: undefined
    });
    for (const role of ['baseline', 'smoke', 'contract'] as const) {
      expect(withUndefined.roles[role].payloadDigest).toBe(withoutOption.roles[role].payloadDigest);
      expect(rootScriptSources(withUndefined.roles[role].collection, 'prerequest')).toEqual([]);
    }
  });

  it('carries a customer signer that evals a pinned library onto every role, contract included', async () => {
    const content = resolveCollectionRootContent(SCRIPTS_INLINE, VARIABLES_INLINE, workspaceWithSigner());
    // Regression guard: `instrumentContractCollection` throws
    // CONTRACT_FORBIDDEN_SCRIPT_CONSTRUCT on `eval(`, which is correct for our
    // generated contract runtime and wrong for a customer signer. Injection
    // happens after that scan, so this must not throw.
    const generated = await generateLocalOpenApiRolePayloads(oas30, {
      ...baseOptions(),
      collectionRootContent: content
    });

    for (const role of ['baseline', 'smoke', 'contract'] as const) {
      const collection = generated.roles[role].collection;
      expect(rootScriptSources(collection, 'prerequest')).toEqual([SIGNER_SOURCE]);
      expect(rootVariables(collection)).toMatchObject({
        consumerKey: '',
        signerLib: '',
        signatureMethod: 'RSA-SHA256'
      });
    }
    // The spec-derived variable must still be there beside the declared ones.
    expect(Object.keys(rootVariables(generated.roles.baseline.collection))).toContain('baseUrl');
    // Contract instrumentation still owns the root test channel.
    expect(rootScriptSources(generated.roles.contract.collection, 'test').length).toBeGreaterThan(0);
  });

  it('survives regeneration: a second run is byte-identical and digests the same', async () => {
    const content = resolveCollectionRootContent(SCRIPTS_INLINE, VARIABLES_INLINE, workspaceWithSigner());
    const options = { ...baseOptions(), collectionRootContent: content };

    const first = await generateLocalOpenApiRolePayloads(oas30, options);
    const second = await generateLocalOpenApiRolePayloads(oas30, options);

    for (const role of ['baseline', 'smoke', 'contract'] as const) {
      expect(rootScriptSources(second.roles[role].collection, 'prerequest')).toEqual([SIGNER_SOURCE]);
      // Exactly one, so reruns cannot accumulate a second copy of the signer.
      expect(rootScriptSources(second.roles[role].collection, 'prerequest')).toHaveLength(1);
      expect(second.roles[role].payloadDigest).toBe(first.roles[role].payloadDigest);
    }
  });

  it('changes the digest when the script changes, so deep-update is not skipped', async () => {
    const before = resolveCollectionRootContent(SCRIPTS_INLINE, undefined, workspaceWithSigner());
    const after = resolveCollectionRootContent(
      SCRIPTS_INLINE,
      undefined,
      workspaceWithSigner(`${SIGNER_SOURCE}\n// revised`)
    );
    const first = await generateLocalOpenApiRolePayloads(oas30, {
      ...baseOptions(),
      collectionRootContent: before
    });
    const revised = await generateLocalOpenApiRolePayloads(oas30, {
      ...baseOptions(),
      collectionRootContent: after
    });
    expect(revised.roles.contract.payloadDigest).not.toBe(first.roles.contract.payloadDigest);
  });
});

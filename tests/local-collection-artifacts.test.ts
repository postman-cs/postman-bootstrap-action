import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, mkdtemp, mkdir, readFile, readdir, rename as fsRename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  LOCAL_COLLECTION_ARTIFACTS_FAILED,
  assertSafeCollectionName,
  computeArtifactDigest,
  confineEmittedRelativePath,
  confineRepoRelativePath,
  finalizeLocalOpenApiArtifactManifest,
  materializeLocalCollectionArtifacts,
  persistLocalOpenApiArtifactManifest,
  type CollectionSplitter,
  type RenameFn
} from '../src/lib/repo/local-collection-artifacts.js';
import { buildContractIndex } from '../src/lib/spec/contract-index.js';
import {
  buildLocalOpenApiConversionOptions,
  generateLocalOpenApiRolePayloads
} from '../src/lib/spec/local-openapi-collection-generation.js';
import { parseOpenApiDocument } from '../src/lib/spec/openapi-loader.js';

type JsonRecord = Record<string, unknown>;

const oas30 = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Artifact API', version: '1.0.0' },
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } }
              }
            }
          }
        }
      }
    }
  }
});

const generationOptions = buildLocalOpenApiConversionOptions({
  openApiVersion: '3.0',
  requestNameSource: 'Fallback',
  folderStrategy: 'Paths',
  nestedFolderHierarchy: true,
  names: {
    baseline: 'Artifact API',
    smoke: '[Smoke] Artifact API',
    contract: '[Contract] Artifact API'
  },
  contractIndex: buildContractIndex(parseOpenApiDocument(oas30))
});

async function makeRepo(): Promise<{ repoRoot: string; runTempDir: string; cleanup: () => Promise<void> }> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'local-artifacts-repo-'));
  const runTempDir = await mkdtemp(path.join(tmpdir(), 'local-artifacts-run-'));
  return {
    repoRoot,
    runTempDir,
    cleanup: async () => {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(runTempDir, { recursive: true, force: true });
    }
  };
}

async function roleInputs() {
  const payloads = await generateLocalOpenApiRolePayloads(oas30, {
    openApiVersion: '3.0',
    requestNameSource: 'Fallback',
    folderStrategy: 'Paths',
    names: {
      baseline: 'Artifact API',
      smoke: '[Smoke] Artifact API',
      contract: '[Contract] Artifact API'
    },
    contractIndex: buildContractIndex(parseOpenApiDocument(oas30))
  });
  return [
    {
      role: 'baseline' as const,
      collectionName: 'Artifact API',
      collection: payloads.roles.baseline.collection,
      payloadDigest: payloads.roles.baseline.payloadDigest,
      cloudId: 'col-baseline'
    },
    {
      role: 'smoke' as const,
      collectionName: '[Smoke] Artifact API',
      collection: payloads.roles.smoke.collection,
      payloadDigest: payloads.roles.smoke.payloadDigest
    },
    {
      role: 'contract' as const,
      collectionName: '[Contract] Artifact API',
      collection: payloads.roles.contract.collection,
      payloadDigest: payloads.roles.contract.payloadDigest
    }
  ];
}

function harmlessSplitter(): CollectionSplitter {
  return async () => [
    { relative: '.resources/definition.yaml', content: '$kind: collection\nname: Artifact API\n' },
    { relative: 'List Pets.request.yaml', content: '$kind: http-request\nmethod: GET\n' }
  ];
}

describe('local collection artifacts', () => {
  it('pins @postman/v3.export and emits runtime.models→v3.export trees', async () => {
    const packageJson = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../node_modules/@postman/v3.export/package.json', import.meta.url)),
        'utf8'
      )
    ) as { version: string };
    expect(packageJson.version).toBe('0.2.28');

    const { repoRoot, runTempDir, cleanup } = await makeRepo();
    try {
      await writeFile(path.join(repoRoot, 'openapi.json'), oas30, 'utf8');
      const roles = await roleInputs();
      const result = await materializeLocalCollectionArtifacts({
        repoRoot,
        runTempDir,
        roles,
        specPath: 'openapi.json',
        options: generationOptions as JsonRecord
      });

      expect(result.manifest).toHaveLength(3);
      for (const entry of result.manifest) {
        expect(entry.collectionPath.startsWith('postman/collections/')).toBe(true);
        expect(entry.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(entry.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
        const definition = await readFile(
          path.join(repoRoot, entry.collectionPath, '.resources', 'definition.yaml'),
          'utf8'
        );
        expect(definition).toContain('$kind: collection');
        expect(definition).not.toMatch(/^id:/m);
      }
      expect(result.manifest.find((entry) => entry.role === 'baseline')?.cloudId).toBe('col-baseline');
    } finally {
      await cleanup();
    }
  });

  it('confines paths and rejects absolute, traversal, nested names, symlink escape, and collisions', async () => {
    const { repoRoot, runTempDir, cleanup } = await makeRepo();
    try {
      expect(() => confineRepoRelativePath(repoRoot, '/tmp/evil', 'path')).toThrow(/repository root/);
      expect(() => confineRepoRelativePath(repoRoot, '../escape', 'path')).toThrow(/repository root/);
      expect(() => assertSafeCollectionName('nested/evil')).toThrow(/single safe collection segment/);
      expect(() => assertSafeCollectionName('..')).toThrow(/single safe collection segment/);
      expect(assertSafeCollectionName('[Smoke] Artifact API')).toBe('[Smoke] Artifact API');

      const outside = await mkdtemp(path.join(tmpdir(), 'local-artifacts-outside-'));
      await symlink(outside, path.join(repoRoot, 'linked-out'));
      expect(() => confineRepoRelativePath(repoRoot, 'linked-out/file.yaml', 'path')).toThrow(/symlink/);

      const roles = await roleInputs();
      await expect(
        materializeLocalCollectionArtifacts({
          repoRoot,
          runTempDir,
          roles: [roles[0]!, { ...roles[1]!, collectionName: 'Artifact API' }],
          options: generationOptions as JsonRecord
        })
      ).rejects.toMatchObject({ code: LOCAL_COLLECTION_ARTIFACTS_FAILED, message: expect.stringContaining('collision') });
      await rm(outside, { recursive: true, force: true });
    } finally {
      await cleanup();
    }
  });

  it('rejects invalid and duplicate runtime roles before filesystem mutation or splitting', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'local-artifacts-role-repo-'));
    const roles = await roleInputs();
    try {
      for (const role of ['../escape', '/absolute', 'unknown']) {
        const runTempDir = path.join(repoRoot, `missing-${role.replaceAll('/', '-')}`);
        let splitCalls = 0;
        await expect(materializeLocalCollectionArtifacts({
          repoRoot,
          runTempDir,
          roles: [{ ...roles[0]!, role: role as 'baseline' }],
          splitter: async () => {
            splitCalls += 1;
            return [];
          }
        })).rejects.toThrow(/role must be exactly/);
        expect(splitCalls).toBe(0);
        await expect(access(runTempDir)).rejects.toBeTruthy();
      }

      const duplicateTemp = path.join(repoRoot, 'missing-duplicate');
      let duplicateSplits = 0;
      await expect(materializeLocalCollectionArtifacts({
        repoRoot,
        runTempDir: duplicateTemp,
        roles: [roles[0]!, { ...roles[1]!, role: 'baseline' }],
        splitter: async () => {
          duplicateSplits += 1;
          return [];
        }
      })).rejects.toThrow(/duplicate role baseline/);
      expect(duplicateSplits).toBe(0);
      await expect(access(duplicateTemp)).rejects.toBeTruthy();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('atomically creates and replaces finalized manifests and preserves prior bytes on promotion failure', async () => {
    const { repoRoot, cleanup } = await makeRepo();
    const baseManifest = finalizeLocalOpenApiArtifactManifest([
      { role: 'baseline', collectionPath: 'postman/collections/API', payloadDigest: 'payload-a', artifactDigest: 'artifact-a' }
    ], { baseline: 'cloud-a' });
    const manifestPath = path.join(repoRoot, '.postman/local-openapi-artifact-manifest.json');
    try {
      await expect(persistLocalOpenApiArtifactManifest(repoRoot, baseManifest)).resolves.toBe(
        '.postman/local-openapi-artifact-manifest.json'
      );
      const firstBytes = await readFile(manifestPath, 'utf8');
      expect(JSON.parse(firstBytes)).toEqual(baseManifest);

      const replacement = finalizeLocalOpenApiArtifactManifest([
        { role: 'baseline', collectionPath: 'postman/collections/API', payloadDigest: 'payload-b', artifactDigest: 'artifact-b' }
      ], { baseline: 'cloud-b' });
      await persistLocalOpenApiArtifactManifest(repoRoot, replacement);
      const replacementBytes = await readFile(manifestPath, 'utf8');
      expect(JSON.parse(replacementBytes)).toEqual(replacement);

      await expect(persistLocalOpenApiArtifactManifest(repoRoot, baseManifest, {
        rename: async () => {
          throw new Error('forced promotion failure');
        }
      })).rejects.toThrow(/atomically persist/);
      expect(await readFile(manifestPath, 'utf8')).toBe(replacementBytes);
      expect((await readdir(path.dirname(manifestPath))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('rejects a symlinked finalized manifest path', async () => {
    const { repoRoot, cleanup } = await makeRepo();
    const outside = path.join(repoRoot, 'outside.json');
    const finalized = finalizeLocalOpenApiArtifactManifest([
      { role: 'baseline', collectionPath: 'postman/collections/API', payloadDigest: 'p', artifactDigest: 'a' }
    ], { baseline: 'cloud' });
    try {
      await mkdir(path.join(repoRoot, '.postman'), { recursive: true });
      await writeFile(outside, 'keep');
      await symlink(outside, path.join(repoRoot, '.postman/local-openapi-artifact-manifest.json'));
      await expect(persistLocalOpenApiArtifactManifest(repoRoot, finalized)).rejects.toThrow(/symlink/);
      expect(await readFile(outside, 'utf8')).toBe('keep');
    } finally {
      await cleanup();
    }
  });

  it('rejects malformed exporter paths before any stage write', async () => {
    expect(() => confineEmittedRelativePath('/abs.yaml')).toThrow(/absolute/);
    expect(() => confineEmittedRelativePath('..\\windows.yaml')).toThrow(/absolute|traversal|POSIX/);
    expect(() => confineEmittedRelativePath('../escape.yaml')).toThrow(/traversal|normalization/);
    expect(() => confineEmittedRelativePath('a/\u0000b.yaml')).toThrow(/confined POSIX-relative/);

    const { repoRoot, runTempDir, cleanup } = await makeRepo();
    try {
      const roles = await roleInputs();
      const secretOutside = path.join(repoRoot, 'secret-outside.txt');
      await writeFile(secretOutside, 'do-not-touch\n', 'utf8');
      const adversarial: CollectionSplitter = async () => [
        { relative: '../secret-outside.txt', content: 'pwned\n' },
        { relative: '/tmp/abs.yaml', content: 'nope\n' }
      ];
      await expect(
        materializeLocalCollectionArtifacts({
          repoRoot,
          runTempDir,
          roles: [roles[0]!],
          splitter: adversarial
        })
      ).rejects.toMatchObject({ code: LOCAL_COLLECTION_ARTIFACTS_FAILED });
      expect(await readFile(secretOutside, 'utf8')).toBe('do-not-touch\n');
      await expect(readFile(path.join(repoRoot, 'postman/collections/Artifact API/.resources/definition.yaml'), 'utf8')).rejects.toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it('rejects internal symlinks without reading external targets and restores exact prior state', async () => {
    const { repoRoot, runTempDir, cleanup } = await makeRepo();
    const outside = await mkdtemp(path.join(tmpdir(), 'local-artifacts-link-target-'));
    try {
      const outsideFile = path.join(outside, 'external.txt');
      await writeFile(outsideFile, 'external-secret\n', 'utf8');
      const collectionDir = path.join(repoRoot, 'postman/collections/Artifact API');
      await mkdir(collectionDir, { recursive: true });
      await writeFile(path.join(collectionDir, 'keep.yaml'), 'keep: true\n', 'utf8');
      await symlink(outsideFile, path.join(collectionDir, 'escape.link'));

      const roles = await roleInputs();
      const beforeOutside = await readFile(outsideFile, 'utf8');
      await expect(
        materializeLocalCollectionArtifacts({
          repoRoot,
          runTempDir,
          roles: [roles[0]!],
          splitter: harmlessSplitter()
        })
      ).rejects.toMatchObject({
        code: LOCAL_COLLECTION_ARTIFACTS_FAILED,
        message: expect.stringContaining('symlink')
      });
      expect(await readFile(path.join(collectionDir, 'keep.yaml'), 'utf8')).toBe('keep: true\n');
      expect(await readFile(outsideFile, 'utf8')).toBe(beforeOutside);
      expect(await readFile(path.join(collectionDir, 'escape.link'), 'utf8')).toBe('external-secret\n');
      await expect(
        readFile(path.join(collectionDir, '.resources/definition.yaml'), 'utf8')
      ).rejects.toBeTruthy();
    } finally {
      await cleanup();
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('writes options/syncOptions, merge-preserves unknowns, stays ID-free, and restores exactly', async () => {
    const { repoRoot, runTempDir, cleanup } = await makeRepo();
    try {
      const collectionDir = path.join(repoRoot, 'postman/collections/Artifact API');
      await mkdir(path.join(collectionDir, 'Stale'), { recursive: true });
      await writeFile(path.join(collectionDir, 'Stale/old.request.yaml'), 'stale: true\n', 'utf8');
      await writeFile(path.join(collectionDir, 'keep-me-not.yaml'), 'gone\n', 'utf8');
      await mkdir(path.join(repoRoot, '.postman'), { recursive: true });
      const priorWorkflows = [
        'generation:',
        '  mode: keep-me',
        'workflows:',
        '  customKeep: true',
        '  syncSpecToCollection:',
        '    - spec: ../other.yaml',
        '      collection: ../postman/collections/other',
        '    - spec: ../stale.yaml',
        '      collection: ../postman/collections/Artifact API',
        '      extra: keep-extra',
        '      options:',
        '        legacy: true',
        '      syncOptions:',
        '        syncExamples: false',
        '        keepFlag: 1'
      ].join('\n');
      await writeFile(path.join(repoRoot, '.postman/workflows.yaml'), priorWorkflows, 'utf8');
      await writeFile(path.join(repoRoot, 'openapi.json'), oas30, 'utf8');

      const roles = await roleInputs();
      const first = await materializeLocalCollectionArtifacts({
        repoRoot,
        runTempDir,
        roles,
        specPath: 'openapi.json',
        options: generationOptions as JsonRecord,
        syncOptions: { syncExamples: true }
      });

      await expect(readFile(path.join(collectionDir, 'Stale/old.request.yaml'), 'utf8')).rejects.toBeTruthy();
      await expect(readFile(path.join(collectionDir, 'keep-me-not.yaml'), 'utf8')).rejects.toBeTruthy();

      const workflows = parseYaml(await readFile(path.join(repoRoot, '.postman/workflows.yaml'), 'utf8')) as JsonRecord;
      expect(workflows.generation).toEqual({ mode: 'keep-me' });
      const pairs = ((workflows.workflows as JsonRecord).syncSpecToCollection as JsonRecord[]) ?? [];
      expect(pairs).toEqual(
        expect.arrayContaining([
          { spec: '../other.yaml', collection: '../postman/collections/other' },
          expect.objectContaining({
            spec: '../openapi.json',
            collection: '../postman/collections/Artifact API',
            extra: 'keep-extra',
            options: expect.objectContaining({
              legacy: true,
              parametersResolution: 'Example',
              requestNameSource: 'Fallback',
              folderStrategy: 'Paths'
            }),
            syncOptions: expect.objectContaining({
              syncExamples: true,
              keepFlag: 1
            })
          }),
          expect.objectContaining({
            spec: '../openapi.json',
            collection: '../postman/collections/[Smoke] Artifact API',
            options: expect.objectContaining({ parametersResolution: 'Example' }),
            syncOptions: { syncExamples: true }
          })
        ])
      );
      expect(JSON.stringify(pairs)).not.toMatch(/col-baseline|cloudId|"id":/);

      await first.restore();
      expect(await readFile(path.join(collectionDir, 'Stale/old.request.yaml'), 'utf8')).toBe('stale: true\n');
      expect(await readFile(path.join(collectionDir, 'keep-me-not.yaml'), 'utf8')).toBe('gone\n');
      expect(await readFile(path.join(repoRoot, '.postman/workflows.yaml'), 'utf8')).toBe(priorWorkflows);
    } finally {
      await cleanup();
    }
  });

  it('writes trees for URL-only runs without synthesizing syncSpecToCollection pairs', async () => {
    const { repoRoot, runTempDir, cleanup } = await makeRepo();
    try {
      await mkdir(path.join(repoRoot, '.postman'), { recursive: true });
      await writeFile(
        path.join(repoRoot, '.postman/workflows.yaml'),
        'workflows:\n  syncSpecToCollection:\n    - spec: ../kept.yaml\n      collection: ../postman/collections/kept\n',
        'utf8'
      );
      const roles = await roleInputs();
      await materializeLocalCollectionArtifacts({
        repoRoot,
        runTempDir,
        roles
      });
      const definition = await readFile(
        path.join(repoRoot, 'postman/collections/Artifact API/.resources/definition.yaml'),
        'utf8'
      );
      expect(definition).toContain('$kind: collection');
      const workflows = parseYaml(await readFile(path.join(repoRoot, '.postman/workflows.yaml'), 'utf8')) as JsonRecord;
      expect(workflows).toEqual({
        workflows: {
          syncSpecToCollection: [{ spec: '../kept.yaml', collection: '../postman/collections/kept' }]
        }
      });
    } finally {
      await cleanup();
    }
  });

  it('falls back to same-parent sibling copy when runTemp rename hits EXDEV', async () => {
    const { repoRoot, runTempDir, cleanup } = await makeRepo();
    try {
      const roles = await roleInputs();
      const renameCalls: Array<{ oldPath: string; newPath: string }> = [];
      let forced = 0;
      const rename: RenameFn = async (oldPath, newPath) => {
        renameCalls.push({ oldPath, newPath });
        // First run-temp -> destination-parent sibling promotion is the
        // cross-device seam; later same-parent renames must succeed.
        if (forced === 0 && /stage/.test(oldPath) && newPath.includes('.__local_artifact_incoming__')) {
          forced += 1;
          const error = new Error('cross-device link') as NodeJS.ErrnoException;
          error.code = 'EXDEV';
          throw error;
        }
        await fsRename(oldPath, newPath);
      };
      const result = await materializeLocalCollectionArtifacts({
        repoRoot,
        runTempDir,
        roles: [roles[0]!],
        splitter: harmlessSplitter(),
        rename
      });
      expect(renameCalls.some((call) => call.newPath.includes('.__local_artifact_incoming__'))).toBe(true);
      expect(forced).toBe(1);
      expect(result.manifest[0]?.collectionPath).toBe('postman/collections/Artifact API');
      expect(
        await readFile(path.join(repoRoot, 'postman/collections/Artifact API/.resources/definition.yaml'), 'utf8')
      ).toContain('$kind: collection');
    } finally {
      await cleanup();
    }
  });

  it('recomputes artifactDigest from sorted relative paths+bytes and ignores traversal', () => {
    const digestA = computeArtifactDigest([
      { relative: 'b.yaml', bytes: 'one' },
      { relative: 'a.yaml', bytes: 'two' }
    ]);
    const digestB = computeArtifactDigest([
      { relative: 'a.yaml', bytes: 'two' },
      { relative: 'b.yaml', bytes: 'one' }
    ]);
    expect(digestA).toBe(digestB);
    expect(
      computeArtifactDigest([
        { relative: 'a.yaml', bytes: 'two!' },
        { relative: 'b.yaml', bytes: 'one' }
      ])
    ).not.toBe(digestA);
    expect(digestA).toBe(
      createHash('sha256')
        .update('a.yaml')
        .update('\0')
        .update('two')
        .update('\0')
        .update('b.yaml')
        .update('\0')
        .update('one')
        .update('\0')
        .digest('hex')
    );
  });
});

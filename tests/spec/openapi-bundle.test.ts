import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { acquireDefinitionBundle } from '../../src/lib/spec/acquire-definition-bundle.js';
import { loadOpenApiContractSpecFromPath } from '../../src/lib/spec/openapi-loader.js';

describe('OpenAPI local definition bundle closure', () => {
  let workspaceDir = '';
  let originalWorkspace: string | undefined;

  beforeEach(() => {
    workspaceDir = join(realpathSync(mkdtempSync(join(tmpdir(), 'oas-bundle-'))), 'RUNNER~1');
    mkdirSync(workspaceDir);
    originalWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = workspaceDir;
  });

  afterEach(() => {
    if (originalWorkspace === undefined) {
      delete process.env.GITHUB_WORKSPACE;
    } else {
      process.env.GITHUB_WORKSPACE = originalWorkspace;
    }
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  const writeRel = (relPath: string, body: string): void => {
    const full = join(workspaceDir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  };

  it('acquires a two-file OpenAPI relative $ref closure with exact source bytes', async () => {
    const root = `openapi: 3.0.3
info:
  title: Pets
  version: 1.0.0
paths:
  /pets:
    post:
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: './components/pet.yaml'
      responses:
        '200':
          description: OK
`;
    const pet = `type: object
properties:
  name:
    type: string
    example: bundle-v1
required:
  - name
`;
    writeRel('apis/svc/openapi.yaml', root);
    writeRel('apis/svc/components/pet.yaml', pet);

    const bundle = await acquireDefinitionBundle({
      workspaceRoot: workspaceDir,
      specPath: 'apis/svc/openapi.yaml'
    });

    expect(bundle.rootPath).toBe('openapi.yaml');
    expect(bundle.files.size).toBe(2);
    expect(bundle.files.get('openapi.yaml')?.content).toBe(root);
    expect(bundle.files.get('components/pet.yaml')?.content).toBe(pet);
    expect(bundle.files.get('components/pet.yaml')?.role).toBe('dependency');

    const loaded = await loadOpenApiContractSpecFromPath('apis/svc/openapi.yaml');
    expect(loaded.content).toBe(root);
    expect(loaded.definitionBundle?.files.size).toBe(2);
    expect(loaded.definitionBundle?.files.get('components/pet.yaml')?.content).toBe(pet);
    expect(JSON.stringify(loaded.bundledDocument)).toContain('bundle-v1');
    expect(loaded.contractIndex.operations[0]?.path).toBe('/pets');
  });

  it('fails missing relative refs with CONTRACT_DEFINITION_CLOSURE_INCOMPLETE before any callback read', async () => {
    writeRel(
      'apis/svc/openapi.yaml',
      `openapi: 3.0.3
info: { title: T, version: 1.0.0 }
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: './components/missing.yaml'
`
    );
    const onUnsafeReadAttempt = vi.fn();
    await expect(
      acquireDefinitionBundle({
        workspaceRoot: workspaceDir,
        specPath: 'apis/svc/openapi.yaml',
        onUnsafeReadAttempt
      })
    ).rejects.toThrow(/CONTRACT_DEFINITION_CLOSURE_INCOMPLETE/);
    expect(onUnsafeReadAttempt).not.toHaveBeenCalled();
  });

  it('rejects escaping relative refs during loader acquisition', async () => {
    writeRel(
      'apis/svc/openapi.yaml',
      `openapi: 3.0.3
info: { title: T, version: 1.0.0 }
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '../../outside.yaml'
`
    );
    await expect(loadOpenApiContractSpecFromPath('apis/svc/openapi.yaml')).rejects.toThrow(
      /CONTRACT_SPEC_PATH_ESCAPE|CONTRACT_DEFINITION_CLOSURE_INCOMPLETE/
    );
  });

  it('rejects absolute file:///outside refs that would suffix-alias an acquired member', async () => {
    const root = `openapi: 3.0.3
info:
  title: Pets
  version: 1.0.0
paths:
  /pets:
    post:
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: 'file:///outside/evil/components/pet.yaml'
      responses:
        '200':
          description: OK
`;
    const pet = `type: object
properties:
  name:
    type: string
    example: should-not-alias
required:
  - name
`;
    writeRel('apis/svc/openapi.yaml', root);
    writeRel('apis/svc/components/pet.yaml', pet);

    await expect(
      acquireDefinitionBundle({
        workspaceRoot: workspaceDir,
        specPath: 'apis/svc/openapi.yaml'
      })
    ).rejects.toThrow(/CONTRACT_DEFINITION_CLOSURE_INCOMPLETE/);

    // Loader path must also refuse suffix-aliasing even if a pre-built bundle
    // already contains the colliding relative member.
    const { createDefinitionBundle, createDefinitionFile } = await import(
      '../../src/lib/spec/definition-bundle.js'
    );
    const planted = createDefinitionBundle({
      rootPath: 'openapi.yaml',
      format: 'openapi-yaml',
      completeness: 'full',
      provenance: { source: 'spec-path', evidence: ['test'] },
      files: [
        createDefinitionFile({
          path: 'openapi.yaml',
          role: 'root',
          bytes: Buffer.from(root, 'utf8')
        }),
        createDefinitionFile({
          path: 'components/pet.yaml',
          role: 'dependency',
          bytes: Buffer.from(pet, 'utf8')
        })
      ]
    });
    await expect(
      loadOpenApiContractSpecFromPath('apis/svc/openapi.yaml', { definitionBundle: planted })
    ).rejects.toThrow(/CONTRACT_DEFINITION_CLOSURE_INCOMPLETE/);
  });

  it('leaves HTTPS spec-url behavior on the existing safe bundled single-root path', async () => {
    const { loadOpenApiContractSpec } = await import('../../src/lib/spec/openapi-loader.js');
    const root = `openapi: 3.1.0
info: { title: T, version: 1.0.0 }
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: 'https://cdn.example.test/schemas/pet.yaml'
`;
    const fetchText = vi.fn(async (url: string) => {
      if (url.includes('pet.yaml')) return 'type: object\nproperties:\n  id:\n    type: integer\n';
      return root;
    });
    const loaded = await loadOpenApiContractSpec('https://api.example.test/openapi.yaml', { fetchText });
    expect(fetchText).toHaveBeenCalledWith('https://cdn.example.test/schemas/pet.yaml', expect.any(Object));
    expect(loaded.contractIndex.operations[0]?.path).toBe('/pets');
  });
});

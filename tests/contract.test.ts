import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  openAlphaActionContract,
  contractInputNames,
  contractOutputNames
} from '../src/contracts.js';
import { createPlannedOutputs, readActionInputs, resolveInputs } from '../src/index.js';

const repoRoot = resolve(import.meta.dirname, '..');
const actionManifest = parse(
  readFileSync(resolve(repoRoot, 'action.yml'), 'utf8')
) as {
  inputs: Record<string, { required?: boolean; default?: string }>;
  outputs: Record<string, unknown>;
};

describe('open-alpha action contract', () => {
  it('uses kebab-case input and output names', () => {
    const kebabCasePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

    for (const name of [...contractInputNames, ...contractOutputNames]) {
      expect(name).toMatch(kebabCasePattern);
    }
  });

  it('keeps action.yml aligned with the contract surface', () => {
    expect(Object.keys(actionManifest.inputs)).toEqual(contractInputNames);
    expect(Object.keys(actionManifest.outputs)).toEqual(contractOutputNames);
  });

  it('defaults integration-backend to bifrost in the contract, manifest, and runtime', () => {
    expect(openAlphaActionContract.inputs['integration-backend'].default).toBe('bifrost');
    expect(openAlphaActionContract.inputs['integration-backend'].allowedValues).toEqual([
      'bifrost'
    ]);
    expect(actionManifest.inputs['integration-backend'].default).toBe('bifrost');
    expect(resolveInputs({}).integrationBackend).toBe('bifrost');
  });

  it('defaults lifecycle controls in contract, manifest, and runtime', () => {
    expect(openAlphaActionContract.inputs['sync-examples'].default).toBe('true');
    expect(openAlphaActionContract.inputs['sync-examples'].allowedValues).toEqual([
      'true',
      'false'
    ]);
    expect(actionManifest.inputs['sync-examples'].default).toBe('true');
    expect(resolveInputs({}).syncExamples).toBe(true);

    expect(openAlphaActionContract.inputs['collection-sync-mode'].default).toBe('refresh');
    expect(openAlphaActionContract.inputs['collection-sync-mode'].allowedValues).toEqual([
      'refresh',
      'version'
    ]);
    expect(actionManifest.inputs['collection-sync-mode'].default).toBe('refresh');
    expect(resolveInputs({}).collectionSyncMode).toBe('refresh');
    expect(resolveInputs({ INPUT_COLLECTION_SYNC_MODE: 'reuse' }).collectionSyncMode).toBe('refresh');

    expect(openAlphaActionContract.inputs['spec-sync-mode'].default).toBe('update');
    expect(openAlphaActionContract.inputs['spec-sync-mode'].allowedValues).toEqual([
      'update',
      'version'
    ]);
    expect(actionManifest.inputs['spec-sync-mode'].default).toBe('update');
    expect(resolveInputs({}).specSyncMode).toBe('update');

  });

  it('preserves legacy boolean aliases while rejecting unknown values', () => {
    expect(resolveInputs({ INPUT_SYNC_EXAMPLES: '1' }).syncExamples).toBe(true);
    expect(resolveInputs({ INPUT_SYNC_EXAMPLES: 'yes' }).syncExamples).toBe(true);
    expect(resolveInputs({ INPUT_SYNC_EXAMPLES: 'on' }).syncExamples).toBe(true);
    expect(resolveInputs({ INPUT_SYNC_EXAMPLES: '0' }).syncExamples).toBe(false);
    expect(resolveInputs({ INPUT_SYNC_EXAMPLES: 'no' }).syncExamples).toBe(false);
    expect(resolveInputs({ INPUT_SYNC_EXAMPLES: 'off' }).syncExamples).toBe(false);
    expect(() => resolveInputs({ INPUT_SYNC_EXAMPLES: 'sometimes' }))
      .toThrow(/sync-examples must be a boolean/);
  });

  it('rejects unsupported lifecycle control values instead of silently falling back', () => {
    expect(() => resolveInputs({ INPUT_COLLECTION_SYNC_MODE: 'unsupported' }))
      .toThrow(/Unsupported collection-sync-mode/);
    expect(() => resolveInputs({ INPUT_SPEC_SYNC_MODE: 'reuse' }))
      .toThrow(/Unsupported spec-sync-mode/);
  });

  it('defaults collection generation options in contract, manifest, and runtime', () => {
    expect(openAlphaActionContract.inputs['folder-strategy'].default).toBe('Paths');
    expect(openAlphaActionContract.inputs['folder-strategy'].allowedValues).toEqual(['Paths', 'Tags']);
    expect(actionManifest.inputs['folder-strategy'].default).toBe('Paths');
    expect(resolveInputs({}).folderStrategy).toBe('Paths');

    expect(openAlphaActionContract.inputs['nested-folder-hierarchy'].default).toBe('false');
    expect(actionManifest.inputs['nested-folder-hierarchy'].default).toBe('false');
    expect(resolveInputs({}).nestedFolderHierarchy).toBe(false);

    expect(openAlphaActionContract.inputs['request-name-source'].default).toBe('Fallback');
    expect(openAlphaActionContract.inputs['request-name-source'].allowedValues).toEqual(['Fallback', 'URL']);
    expect(actionManifest.inputs['request-name-source'].default).toBe('Fallback');
    expect(resolveInputs({}).requestNameSource).toBe('Fallback');
  });

  it('rejects unsupported integration backends during input resolution', () => {
    expect(() =>
      resolveInputs({
        INPUT_INTEGRATION_BACKEND: 'custom'
      })
    ).toThrow(/Unsupported integration-backend/);
  });

  it('rejects non-HTTPS spec URLs', () => {
    expect(() =>
      resolveInputs({
        'INPUT_SPEC_URL': 'http://example.com/spec.yaml'
      })
    ).toThrow(/spec-url must be a valid HTTPS URL/);
  });

  it('redacts credential-bearing spec URL details in validation errors', () => {
    expect(() =>
      resolveInputs({
        'INPUT_SPEC_URL': 'http://user:pass@example.com/spec.yaml?token=secret#frag'
      })
    ).toThrow('spec-url must be a valid HTTPS URL, got: http://example.com/spec.yaml');

    let thrown: unknown;
    try {
      resolveInputs({
        'INPUT_SPEC_URL': 'https://example .com/spec.yaml?token=secret#frag'
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain('[invalid OpenAPI URL]');
    expect(message).not.toContain('token=secret');
    expect(message).not.toContain('#frag');
  });

  it('defaults openapi-version to empty string in contract, manifest, and runtime (auto-detect)', () => {
    expect(openAlphaActionContract.inputs['openapi-version'].default).toBe('');
    expect(openAlphaActionContract.inputs['openapi-version'].allowedValues).toEqual(['3.0', '3.1']);
    expect(actionManifest.inputs['openapi-version'].default).toBe('');
    // Empty string signals auto-detect from spec content at runtime.
    expect(resolveInputs({}).openapiVersion).toBe('');
  });

  it('accepts explicit openapi-version 3.1 override at runtime', () => {
    const inputs = resolveInputs({ INPUT_OPENAPI_VERSION: '3.1' });
    expect(inputs.openapiVersion).toBe('3.1');
  });

  it('accepts explicit openapi-version 3.0 override at runtime', () => {
    const inputs = resolveInputs({ INPUT_OPENAPI_VERSION: '3.0' });
    expect(inputs.openapiVersion).toBe('3.0');
  });

  it('rejects unsupported openapi-version values', () => {
    expect(() =>
      resolveInputs({ INPUT_OPENAPI_VERSION: '2.0' })
    ).toThrow(/Unsupported openapi-version/);
  });

  it('readActionInputs explicitly wires openapi-version from core.getInput', () => {
    const coreStub = {
      getInput: (name: string) => {
        const map: Record<string, string> = {
          'project-name': 'my-api',
          'spec-url': 'https://example.com/openapi.yaml',
          'postman-api-key': 'pmak-test',
          'openapi-version': '3.1'
        };
        return map[name] ?? '';
      },
      setSecret: () => {}
    };
    const inputs = readActionInputs(coreStub);
    expect(inputs.openapiVersion).toBe('3.1');
  });

  it('documents the retained bootstrap steps and removed internal-only behavior', () => {
    expect(openAlphaActionContract.retainedBehavior).toContain('spec linting by UID');
    expect(openAlphaActionContract.retainedBehavior).toContain('workspace creation');
    expect(openAlphaActionContract.retainedBehavior).toContain(
      'governance group assignment'
    );
    expect(openAlphaActionContract.removedBehavior).toContain('step mode');
    expect(openAlphaActionContract.removedBehavior).toContain(
      'aws, docker, and infra workflow concerns'
    );
  });

  it('builds placeholder outputs that match the public open-alpha output surface', () => {
    const outputs = createPlannedOutputs(
      resolveInputs({
        INPUT_PROJECT_NAME: 'core-payments',
        INPUT_DOMAIN_CODE: 'AF',
        INPUT_SPEC_URL: 'https://example.com/openapi.yaml',
        INPUT_POSTMAN_API_KEY: 'pmak-test'
      })
    );

    expect(outputs).toEqual({
      'workspace-id': '',
      'workspace-url': '',
      'workspace-name': '[AF] core-payments',
      'spec-id': '',
      'baseline-collection-id': '',
      'smoke-collection-id': '',
      'contract-collection-id': '',
      'collections-json': JSON.stringify({
        baseline: '',
        smoke: '',
        contract: ''
      }),
      'lint-summary-json': JSON.stringify({
        errors: 0,
        total: 0,
        violations: [],
        warnings: 0
      })
    });
  });
});

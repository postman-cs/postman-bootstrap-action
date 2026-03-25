import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  openAlphaActionContract,
  contractInputNames,
  contractOutputNames
} from '../src/contracts.js';
import { createPlannedOutputs, resolveInputs } from '../src/index.js';

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

  it('defaults the new lifecycle controls in the contract, manifest, and runtime', () => {
    expect(openAlphaActionContract.inputs['collection-sync-mode'].default).toBe('reuse');
    expect(openAlphaActionContract.inputs['collection-sync-mode'].allowedValues).toEqual([
      'reuse',
      'refresh',
      'version'
    ]);
    expect(actionManifest.inputs['collection-sync-mode'].default).toBe('reuse');
    expect(resolveInputs({}).collectionSyncMode).toBe('reuse');

    expect(openAlphaActionContract.inputs['spec-sync-mode'].default).toBe('update');
    expect(openAlphaActionContract.inputs['spec-sync-mode'].allowedValues).toEqual([
      'update',
      'version'
    ]);
    expect(actionManifest.inputs['spec-sync-mode'].default).toBe('update');
    expect(resolveInputs({}).specSyncMode).toBe('update');

    expect(openAlphaActionContract.inputs['set-as-current'].default).toBe('true');
    expect(actionManifest.inputs['set-as-current'].default).toBe('true');
    expect(resolveInputs({}).setAsCurrent).toBe(true);
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

  it('documents the retained bootstrap steps and removed internal-only behavior', () => {
    expect(openAlphaActionContract.retainedBehavior).toContain('spec linting by UID');
    expect(openAlphaActionContract.retainedBehavior).toContain('workspace creation');
    expect(openAlphaActionContract.retainedBehavior).toContain(
      'governance group assignment'
    );
    expect(openAlphaActionContract.retainedBehavior).toContain(
      'GitHub repository variable persistence for downstream sync steps'
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

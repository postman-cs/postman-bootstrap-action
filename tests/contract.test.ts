import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  bootstrapActionContract,
  contractInputNames,
  contractOutputNames
} from '../src/contracts.js';
import { createPlannedOutputs, readActionInputs, resolveInputs } from '../src/index.js';

const repoRoot = resolve(import.meta.dirname, '..');
const publicSyntheticSpecUrl =
  'https://raw.githubusercontent.com/postman-cs/postman-bootstrap-action/main/examples/core-payments-openapi.yaml';
const actionManifest = parse(
  readFileSync(resolve(repoRoot, 'action.yml'), 'utf8')
) as {
  description: string;
  inputs: Record<string, { required?: boolean; default?: string }>;
  outputs: Record<string, unknown>;
  runs: { using: string; main: string };
};
const packageManifest = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf8')
) as {
  description: string;
  main: string;
  scripts: Record<string, string>;
};
const contractSmokeWorkflowText = readFileSync(
  resolve(repoRoot, '.github/workflows/contract-smoke.yml'),
  'utf8'
);
const contractSmokeWorkflow = parse(contractSmokeWorkflowText) as {
  jobs: Record<string, { if?: string; steps?: Array<{ id?: string; run?: string }> }>;
};

describe('bootstrap action contract', () => {
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

  it('accepts PMAK only as an optional access-token mint credential', () => {
    expect(contractInputNames).toContain('postman-access-token');
    expect(actionManifest.inputs['postman-access-token']).toMatchObject({ required: false });
    expect(contractInputNames).toContain('postman-api-key');
    expect(actionManifest.inputs['postman-api-key']).toMatchObject({ required: false });
  });

  it('keeps the action metadata on the committed Node 24 bundle', () => {
    expect(actionManifest.runs).toEqual({
      using: 'node24',
      main: 'dist/action.cjs'
    });
    expect(packageManifest.main).toBe('dist/index.cjs');
    expect(packageManifest.scripts.bundle).toContain('src/index.ts --bundle');
    expect(packageManifest.scripts.bundle).toContain('--outfile=dist/index.cjs');
    expect(packageManifest.scripts.bundle).toContain('src/main.ts --bundle');
    expect(packageManifest.scripts.bundle).toContain('--outfile=dist/action.cjs');
    expect(packageManifest.scripts.bundle).toContain('--banner:js="#!/usr/bin/env node"');
    expect(packageManifest.scripts.bundle).toContain("process.platform!=='win32'");
    expect(packageManifest.scripts.bundle).toContain("chmodSync('dist/cli.cjs',0o755)");
    expect(packageManifest.scripts.build.match(/npm run typecheck/g) ?? []).toHaveLength(1);
    expect(packageManifest.scripts.build.match(/npm run bundle/g) ?? []).toHaveLength(1);
    expect(packageManifest.scripts['verify:dist:assert']).toBe(
      'git diff --ignore-space-at-eol --text --exit-code -- dist && node scripts/verify-dist-artifact.mjs'
    );
    expect(packageManifest.scripts['verify:dist']).toBe('npm run build && npm run verify:dist:assert');
  });

  it('keeps integration-backend internal: contract and runtime resolve to bifrost while the manifest omits a visible default', () => {
    expect(bootstrapActionContract.inputs['integration-backend'].default).toBe('bifrost');
    expect(bootstrapActionContract.inputs['integration-backend'].allowedValues).toEqual([
      'bifrost'
    ]);
    expect(actionManifest.inputs['integration-backend'].default).toBeUndefined();
    expect(resolveInputs({}).integrationBackend).toBe('bifrost');
  });

  it('defaults lifecycle controls in contract, manifest, and runtime', () => {
    expect(bootstrapActionContract.inputs['sync-examples'].default).toBe('true');
    expect(bootstrapActionContract.inputs['sync-examples'].allowedValues).toEqual([
      'true',
      'false'
    ]);
    expect(actionManifest.inputs['sync-examples'].default).toBe('true');
    expect(resolveInputs({}).syncExamples).toBe(true);

    expect(bootstrapActionContract.inputs['collection-sync-mode'].default).toBe('refresh');
    expect(bootstrapActionContract.inputs['collection-sync-mode'].allowedValues).toEqual([
      'refresh',
      'version'
    ]);
    expect(actionManifest.inputs['collection-sync-mode'].default).toBe('refresh');
    expect(resolveInputs({}).collectionSyncMode).toBe('refresh');
    expect(resolveInputs({ INPUT_COLLECTION_SYNC_MODE: 'reuse' }).collectionSyncMode).toBe('refresh');

    expect(bootstrapActionContract.inputs['spec-sync-mode'].default).toBe('update');
    expect(bootstrapActionContract.inputs['spec-sync-mode'].allowedValues).toEqual([
      'update',
      'version'
    ]);
    expect(actionManifest.inputs['spec-sync-mode'].default).toBe('update');
    expect(resolveInputs({}).specSyncMode).toBe('update');

  });

  it('resolves token-mint and access-token credentials with INPUT_ taking precedence', () => {
    // Plain-env fallback supports Jenkins `withCredentials` without the INPUT_ prefix.
    const fromPlain = resolveInputs({
      POSTMAN_API_KEY: 'pmak-plain',
      POSTMAN_ACCESS_TOKEN: 'pat-plain'
    });
    expect(fromPlain.postmanApiKey).toBe('pmak-plain');
    expect(fromPlain.postmanAccessToken).toBe('pat-plain');

    // An explicit INPUT_ (kebab flag / action input) wins over the plain-env fallback.
    const inputWins = resolveInputs({
      INPUT_POSTMAN_API_KEY: 'pmak-input',
      POSTMAN_API_KEY: 'pmak-plain',
      INPUT_POSTMAN_ACCESS_TOKEN: 'pat-input',
      POSTMAN_ACCESS_TOKEN: 'pat-plain'
    });
    expect(inputWins.postmanApiKey).toBe('pmak-input');
    expect(inputWins.postmanAccessToken).toBe('pat-input');

    // Credential-free branch-gated validation remains supported.
    const none = resolveInputs({});
    expect(none.postmanApiKey).toBe('');
    expect(none.postmanAccessToken).toBeUndefined();
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
    expect(bootstrapActionContract.inputs['folder-strategy'].default).toBe('Paths');
    expect(bootstrapActionContract.inputs['folder-strategy'].allowedValues).toEqual(['Paths', 'Tags']);
    expect(actionManifest.inputs['folder-strategy'].default).toBe('Paths');
    expect(resolveInputs({}).folderStrategy).toBe('Paths');

    expect(bootstrapActionContract.inputs['nested-folder-hierarchy'].default).toBe('false');
    expect(actionManifest.inputs['nested-folder-hierarchy'].default).toBe('false');
    expect(resolveInputs({}).nestedFolderHierarchy).toBe(false);

    expect(bootstrapActionContract.inputs['request-name-source'].default).toBe('Fallback');
    expect(bootstrapActionContract.inputs['request-name-source'].allowedValues).toEqual(['Fallback', 'URL']);
    expect(actionManifest.inputs['request-name-source'].default).toBe('Fallback');
    expect(resolveInputs({}).requestNameSource).toBe('Fallback');
  });

  it('rejects unsupported collection generation option values instead of silently falling back', () => {
    expect(() => resolveInputs({ INPUT_FOLDER_STRATEGY: 'Folders' }))
      .toThrow(/Unsupported folder-strategy/);
    expect(() => resolveInputs({ INPUT_NESTED_FOLDER_HIERARCHY: 'maybe' }))
      .toThrow(/nested-folder-hierarchy must be a boolean/);
    expect(() => resolveInputs({ INPUT_REQUEST_NAME_SOURCE: 'Name' }))
      .toThrow(/Unsupported request-name-source/);
  });

  it('selects access-token gateway endpoint profiles from postman-stack and postman-region inputs', () => {
    expect(bootstrapActionContract.inputs['postman-stack'].default).toBe('prod');
    expect(bootstrapActionContract.inputs['postman-stack'].allowedValues).toEqual(['prod', 'beta']);
    expect(bootstrapActionContract.inputs['postman-region'].default).toBe('us');
    expect(bootstrapActionContract.inputs['postman-region'].allowedValues).toEqual(['us', 'eu']);
    expect(actionManifest.inputs['postman-stack'].default).toBe('prod');
    expect(actionManifest.inputs['postman-region'].default).toBe('us');

    const prod = resolveInputs({});
    expect(prod.postmanRegion).toBe('us');
    expect(prod.postmanStack).toBe('prod');
    expect(prod.postmanApiBase).toBe('https://api.getpostman.com');
    expect(prod.postmanBifrostBase).toBe('https://bifrost-premium-https-v4.gw.postman.com');
    expect(prod.postmanGatewayBase).toBe('https://gateway.postman.com');

    const beta = resolveInputs({ INPUT_POSTMAN_STACK: 'beta' });
    expect(beta.postmanStack).toBe('beta');
    expect(beta.postmanApiBase).toBe('https://api.getpostman-beta.com');
    expect(beta.postmanBifrostBase).toBe('https://bifrost-https-v4.gw.postman-beta.com');
    expect(beta.postmanGatewayBase).toBe('https://gateway.postman-beta.com');

    const betaWithLegacyOverrides = resolveInputs({
      INPUT_POSTMAN_STACK: 'beta',
      INPUT_POSTMAN_BIFROST_BASE: 'https://override.example.com',
      INPUT_POSTMAN_GATEWAY_BASE: 'https://override.example.com'
    });
    expect(betaWithLegacyOverrides.postmanBifrostBase).toBe(beta.postmanBifrostBase);
    expect(betaWithLegacyOverrides.postmanGatewayBase).toBe(beta.postmanGatewayBase);

    const eu = resolveInputs({ INPUT_POSTMAN_REGION: 'eu' });
    expect(eu.postmanRegion).toBe('eu');
    expect(eu.postmanApiBase).toBe('https://api.eu.postman.com');

    expect(() => resolveInputs({ INPUT_POSTMAN_REGION: 'ap' }))
      .toThrow(/Unsupported postman-region/);
    expect(() => resolveInputs({ INPUT_POSTMAN_REGION: 'eu', INPUT_POSTMAN_STACK: 'beta' }))
      .toThrow(/postman-region=eu/);
    expect(() => resolveInputs({ INPUT_POSTMAN_STACK: 'stage' }))
      .toThrow(/Unsupported postman-stack/);
  });

  it('rejects malformed governance JSON and non-numeric workspace team IDs during resolution', () => {
    expect(() => resolveInputs({ INPUT_GOVERNANCE_MAPPING_JSON: '{not-json' }))
      .toThrow(/governance-mapping-json must be valid JSON/);
    expect(() => resolveInputs({ INPUT_WORKSPACE_TEAM_ID: 'team-alpha' }))
      .toThrow(/workspace-team-id must be a numeric sub-team ID/);
  });

  it('rejects unsupported integration backends during input resolution', () => {
    expect(() =>
      resolveInputs({
        INPUT_INTEGRATION_BACKEND: 'custom'
      })
    ).toThrow(/Unsupported integration-backend/);
  });

  it('places optional spec-files-json immediately after spec-path with empty default', () => {
    const contractNames = contractInputNames;
    const manifestNames = Object.keys(actionManifest.inputs);
    expect(contractNames.indexOf('spec-files-json')).toBe(contractNames.indexOf('spec-path') + 1);
    expect(manifestNames.indexOf('spec-files-json')).toBe(manifestNames.indexOf('spec-path') + 1);
    expect(bootstrapActionContract.inputs['spec-files-json'].default).toBe('');
    expect(actionManifest.inputs['spec-files-json'].default).toBe('');
    expect(bootstrapActionContract.inputs['spec-files-json'].description).toMatch(/content-free/i);
    expect(bootstrapActionContract.inputs['spec-files-json'].description).toMatch(/root must equal spec-path/i);
    expect(bootstrapActionContract.inputs['spec-files-json'].description).toMatch(/not a directory mode/i);
    expect(resolveInputs({}).specFilesJson).toBe('');
  });

  it('forwards raw spec-files-json and rejects inventory combined with spec-url', () => {
    const inventory = '{"schemaVersion":1,"root":"openapi.yaml"}';
    const withPath = resolveInputs({
      INPUT_SPEC_PATH: 'openapi.yaml',
      INPUT_SPEC_FILES_JSON: inventory
    });
    expect(withPath.specPath).toBe('openapi.yaml');
    expect(withPath.specUrl).toBe('');
    expect(withPath.specFilesJson).toBe(inventory);

    expect(() =>
      resolveInputs({
        INPUT_SPEC_URL: publicSyntheticSpecUrl,
        INPUT_SPEC_FILES_JSON: inventory
      })
    ).toThrow(/CONTRACT_DEFINITION_INVENTORY_WITH_URL/);

    // Legacy mutual exclusion and HTTPS rules remain unchanged when inventory is empty.
    expect(() =>
      resolveInputs({
        INPUT_SPEC_URL: publicSyntheticSpecUrl,
        INPUT_SPEC_PATH: 'openapi.yaml'
      })
    ).toThrow(/not both/);
    expect(
      resolveInputs({
        INPUT_SPEC_URL: publicSyntheticSpecUrl,
        INPUT_SPEC_FILES_JSON: ''
      }).specFilesJson
    ).toBe('');
  });

  it('readActionInputs wires raw spec-files-json without parsing inventory schema', () => {
    const inventory = '{"schemaVersion":1,"root":"apis/core/openapi.yaml","not-fully-valid":true}';
    const getInputCalls: string[] = [];
    const coreStub = {
      getInput: (name: string) => {
        getInputCalls.push(name);
        const map: Record<string, string> = {
          'project-name': 'my-api',
          'spec-path': 'apis/core/openapi.yaml',
          'spec-files-json': inventory
        };
        return map[name] ?? '';
      },
      setSecret: () => {}
    };
    const inputs = readActionInputs(coreStub);
    expect(getInputCalls).toContain('spec-files-json');
    expect(inputs.specPath).toBe('apis/core/openapi.yaml');
    expect(inputs.specFilesJson).toBe(inventory);
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
    expect(bootstrapActionContract.inputs['openapi-version'].default).toBe('');
    expect(bootstrapActionContract.inputs['openapi-version'].allowedValues).toEqual(['3.0', '3.1']);
    expect(actionManifest.inputs['openapi-version'].default).toBe('');
    // Empty string signals auto-detect from spec content at runtime.
    expect(resolveInputs({}).openapiVersion).toBe('');
  });

  it('defaults breaking-change controls in contract, manifest, and runtime', () => {
    expect(bootstrapActionContract.inputs['breaking-change-mode'].default).toBe('off');
    expect(bootstrapActionContract.inputs['breaking-change-mode'].allowedValues).toEqual([
      'off',
      'pr-native',
      'baseline-only',
      'previous-spec'
    ]);
    expect(actionManifest.inputs['breaking-change-mode'].default).toBe('off');
    expect(resolveInputs({}).breakingChangeMode).toBe('off');

    expect(bootstrapActionContract.inputs['breaking-rules-path'].default).toBe('changes-rules.yaml');
    expect(actionManifest.inputs['breaking-rules-path'].default).toBe('changes-rules.yaml');
    expect(resolveInputs({}).breakingRulesPath).toBe('changes-rules.yaml');

    expect(resolveInputs({ INPUT_BREAKING_CHANGE_MODE: 'previous-spec' }).breakingChangeMode)
      .toBe('previous-spec');
    expect(() => resolveInputs({ INPUT_BREAKING_CHANGE_MODE: 'strict' }))
      .toThrow(/Unsupported breaking-change-mode/);
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
          'spec-url': publicSyntheticSpecUrl,
          'openapi-version': '3.1',
          'breaking-change-mode': 'previous-spec',
          'breaking-baseline-spec-path': 'specs/baseline.yaml',
          'breaking-rules-path': 'config/rules.yaml',
          'breaking-target-ref': 'release/main',
          'breaking-summary-path': 'tmp/summary.md',
          'breaking-log-path': 'tmp/check.log'
        };
        return map[name] ?? '';
      },
      setSecret: () => {}
    };
    const inputs = readActionInputs(coreStub);
    expect(inputs.openapiVersion).toBe('3.1');
    expect(inputs.breakingChangeMode).toBe('previous-spec');
    expect(inputs.breakingBaselineSpecPath).toBe('specs/baseline.yaml');
    expect(inputs.breakingRulesPath).toBe('config/rules.yaml');
    expect(inputs.breakingTargetRef).toBe('release/main');
    expect(inputs.breakingSummaryPath).toBe('tmp/summary.md');
    expect(inputs.breakingLogPath).toBe('tmp/check.log');
  });

  it('readActionInputs explicitly wires postman-stack and postman-region once from core.getInput', () => {
    const calls: string[] = [];
    const coreStub = {
      getInput: (name: string) => {
        calls.push(name);
        const map: Record<string, string> = {
          'project-name': 'my-api',
          'spec-url': publicSyntheticSpecUrl,
          'postman-region': 'eu'
        };
        return map[name] ?? '';
      },
      setSecret: () => {}
    };
    const inputs = readActionInputs(coreStub);
    expect(inputs.postmanRegion).toBe('eu');
    expect(inputs.postmanStack).toBe('prod');
    expect(calls.filter((name) => name === 'postman-region')).toHaveLength(1);
    expect(calls.filter((name) => name === 'postman-stack')).toHaveLength(1);
  });

  it('readActionInputs ignores removed legacy team inputs', () => {
    const coreStub = {
      getInput: (name: string) => {
        const map: Record<string, string> = {
          'project-name': 'my-api',
          'spec-url': publicSyntheticSpecUrl,
          'postman-team-id': 'legacy-team'
        };
        return map[name] ?? '';
      },
      setSecret: () => {}
    };

    expect(readActionInputs(coreStub).teamId).toBe('');
  });

  it('documents the retained bootstrap steps and removed non-bootstrap behavior', () => {
    expect(bootstrapActionContract.retainedBehavior).toContain('spec linting by UID');
    expect(bootstrapActionContract.retainedBehavior).toContain('workspace creation');
    expect(bootstrapActionContract.retainedBehavior).toContain(
      'governance group assignment'
    );
    expect(bootstrapActionContract.removedBehavior).toContain('step mode');
    expect(bootstrapActionContract.removedBehavior).toContain(
      'aws, docker, and infra workflow concerns'
    );
  });

  it('uses marketplace-ready wording in public contract and package metadata', () => {
    const publicText = [
      actionManifest.description,
      packageManifest.description,
      bootstrapActionContract.description,
      ...bootstrapActionContract.retainedBehavior,
      ...bootstrapActionContract.removedBehavior
    ].join('\n');
    expect(publicText).not.toMatch(/\bpreview\b/i);
    expect(publicText).not.toMatch(/\binternal(?:-only)?\b/i);
    expect(publicText).not.toMatch(/\bruntime(?:-coupled| deployment)?\b/i);
    expect(publicText).not.toMatch(/\bregistry-backed\b/i);
    expect(bootstrapActionContract.description).toBe(
      'Contract for bootstrapping Postman assets from an OpenAPI spec.'
    );
  });

  it('lets scheduled contract smoke skip missing secrets but makes manual dispatch fail preflight', () => {
    const preflight = contractSmokeWorkflow.jobs.preflight;
    const credentialsStep = preflight.steps?.find((step) => step.id === 'credentials');
    expect(credentialsStep?.run).toContain('GITHUB_EVENT_NAME');
    expect(credentialsStep?.run).toContain('[ "$GITHUB_EVENT_NAME" = "schedule" ]');
    expect(credentialsStep?.run).toContain('::error::');
    expect(credentialsStep?.run).toContain('exit 1');
    expect(contractSmokeWorkflow.jobs['bootstrap-smoke'].if).toBe(
      '$' + "{{ needs.preflight.outputs.bootstrap_api == 'true' }}"
    );
    expect(contractSmokeWorkflow.jobs['bifrost-smoke'].if).toBe(
      '$' + "{{ needs.preflight.outputs.bifrost == 'true' }}"
    );
    expect(contractSmokeWorkflow.jobs['session-smoke'].if).toBe(
      '$' + "{{ needs.preflight.outputs.session == 'true' }}"
    );
  });

  it('builds placeholder outputs that match the public bootstrap output surface', () => {
    const outputs = createPlannedOutputs(
      resolveInputs({
        INPUT_PROJECT_NAME: 'core-payments',
        INPUT_DOMAIN_CODE: 'AF',
        INPUT_SPEC_URL: publicSyntheticSpecUrl,
        INPUT_POSTMAN_ACCESS_TOKEN: 'access-token-test'
      })
    );

    expect(outputs).toEqual({
      'workspace-id': '',
      'workspace-url': '',
      'workspace-name': '[AF] core-payments',
      'spec-id': '',
      'spec-version-tag': '',
      'spec-version-url': '',
      'spec-content-changed': '',
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
      }),
      'breaking-change-status': 'skipped',
      'breaking-change-summary-json': JSON.stringify({
        breakingChanges: 0,
        comparison: '',
        exitCode: 0,
        logPath: '',
        message: 'Breaking-change check is disabled.',
        mode: 'off',
        status: 'skipped',
        summaryPath: ''
      }),
      'sync-status': '',
      'branch-decision': ''
    });
  });

  it('exposes credential-preflight as an optional kebab-case input defaulting to warn', () => {
    expect('credential-preflight').toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(contractInputNames).toContain('credential-preflight');

    expect(bootstrapActionContract.inputs['credential-preflight'].required).toBe(false);
    expect(bootstrapActionContract.inputs['credential-preflight'].default).toBe('warn');
    expect(bootstrapActionContract.inputs['credential-preflight'].allowedValues).toEqual([
      'enforce',
      'warn'
    ]);

    expect(actionManifest.inputs['credential-preflight'].required).toBe(false);
    expect(actionManifest.inputs['credential-preflight'].default).toBe('warn');

    expect(resolveInputs({}).credentialPreflight).toBe('warn');
    expect(resolveInputs({ INPUT_CREDENTIAL_PREFLIGHT: 'enforce' }).credentialPreflight).toBe(
      'enforce'
    );
    expect(() => resolveInputs({ INPUT_CREDENTIAL_PREFLIGHT: 'off' })).toThrow(
      /Unsupported credential-preflight/
    );
    expect(() => resolveInputs({ INPUT_CREDENTIAL_PREFLIGHT: 'loud' })).toThrow(
      /Unsupported credential-preflight/
    );
  });

  it('readActionInputs explicitly wires credential-preflight from core.getInput', () => {
    const coreStub = {
      getInput: (name: string) => {
        const map: Record<string, string> = {
          'project-name': 'my-api',
          'spec-url': publicSyntheticSpecUrl,
          'credential-preflight': 'enforce'
        };
        return map[name] ?? '';
      },
      setSecret: () => {}
    };
    expect(readActionInputs(coreStub).credentialPreflight).toBe('enforce');
  });
});

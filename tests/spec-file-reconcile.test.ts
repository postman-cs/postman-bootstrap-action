import { describe, expect, it } from 'vitest';

import {
  createDefinitionBundle,
  createDefinitionFile
} from '../src/lib/spec/definition-bundle.js';
import {
  assertSameRootPath,
  buildBulkFilesBody,
  buildMultiFileCreateBody,
  cloudMembersToDefinitionBundle,
  DEFAULT_SPEC_RECONCILE_CAPABILITY_POLICY,
  deriveSpecReconcileCapabilityPolicyFromReceipt,
  listFilesFromGatewayResponse,
  MULTI_FILE_SPEC_SYNC_DEFAULT,
  orderPerFileReconcileOps,
  perFileCreateName,
  planHasMutations,
  planSpecFileReconcile,
  R6_REQUIRED_RECEIPT_CAPABILITIES,
  R6_REQUIRED_RECEIPT_LEG_MODES,
  R6_REQUIRED_RECEIPT_PROBE_IDS,
  r5ReceiptJustifiesMultiFileSyncDefaultOn,
  resolveMultiFileSpecSyncDefaultFromReceipt,
  resolvePerFileCreateParentId,
  validateSpecReconcileCapabilityPolicy
} from '../src/lib/postman/spec-file-reconcile.js';
import committedR5MultifileSpecSyncReceipt from '../validation/evidence/multifile-spec-sync.json' with {
  type: 'json'
};

function file(path: string, role: 'root' | 'dependency', content: string) {
  return createDefinitionFile({
    path,
    role,
    bytes: new TextEncoder().encode(content)
  });
}

const ALL_PROBE_IDS = [...R6_REQUIRED_RECEIPT_PROBE_IDS, 'P11'] as const;

function justifyingCapabilities(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    multiFileCreate: true,
    multiFileRead: true,
    perFileCreate: true,
    perFilePatch: true,
    perFileDelete: true,
    bulkModify: true,
    atomicBulk: true,
    rootPathChange: false,
    openapiGeneration: true,
    protobufGeneration: false,
    ...overrides
  };
}

function syntheticJustifyingReceipt(options?: {
  modes?: string[];
  capabilities?: Record<string, unknown>;
  probePassed?: Partial<Record<(typeof ALL_PROBE_IDS)[number], boolean>>;
  omitProbe?: (typeof ALL_PROBE_IDS)[number];
  teardownResidue?: boolean;
  omitTeardown?: boolean;
}): Record<string, unknown> {
  const modes = options?.modes ?? [...R6_REQUIRED_RECEIPT_LEG_MODES];
  return {
    schemaVersion: 1,
    testedAt: '2026-01-01T00:00:00.000Z',
    bootstrapCommit: 'a'.repeat(40),
    legs: modes.map((mode) => {
      const results = ALL_PROBE_IDS.filter((id) => id !== options?.omitProbe).map((id) => ({
        id,
        passed: options?.probePassed?.[id] ?? id !== 'P11',
        httpStatuses: [200],
        requestShape: 'probe',
        responseShape: 'data',
        observed: {}
      }));
      const leg: Record<string, unknown> = {
        mode,
        results
      };
      if (!options?.omitTeardown) {
        leg.teardown = { residue: options?.teardownResidue ?? false, deletedKinds: [] };
      }
      return leg;
    }),
    capabilities: justifyingCapabilities(options?.capabilities)
  };
}

function bundle(files: ReturnType<typeof file>[]) {
  const root = files.find((entry) => entry.role === 'root');
  if (!root) throw new Error('missing root');
  return createDefinitionBundle({
    rootPath: root.path,
    format: 'openapi-yaml',
    completeness: 'full',
    provenance: { source: 'spec-path', evidence: ['test'] },
    files
  });
}

describe('spec-file-reconcile', () => {
  it('builds the exact R5 P01 multi-file create shape', () => {
    const target = bundle([
      file('openapi.yaml', 'root', 'openapi: 3.0.3\n'),
      file('components/pet.yaml', 'dependency', 'type: object\n')
    ]);
    expect(buildMultiFileCreateBody({ name: 'Payments', openapiVersion: '3.0', bundle: target })).toEqual({
      name: 'Payments',
      type: 'OPENAPI:3.0',
      files: [
        { path: 'components/pet.yaml', content: 'type: object\n', type: 'DEFAULT' },
        { path: 'openapi.yaml', content: 'openapi: 3.0.3\n', type: 'ROOT' }
      ]
    });
  });

  it('plans a no-op when path set and content match', () => {
    const target = bundle([
      file('openapi.yaml', 'root', 'root-v1'),
      file('components/pet.yaml', 'dependency', 'pet-v1')
    ]);
    const plan = planSpecFileReconcile({
      cloud: [
        { id: 'root-id', path: 'openapi.yaml', type: 'ROOT' },
        { id: 'pet-id', path: 'components/pet.yaml', type: 'DEFAULT' }
      ],
      cloudContentById: new Map([
        ['root-id', 'root-v1'],
        ['pet-id', 'pet-v1']
      ]),
      target
    });
    expect(planHasMutations(plan)).toBe(false);
  });

  it('plans companion-only update', () => {
    const target = bundle([
      file('openapi.yaml', 'root', 'root-v1'),
      file('components/pet.yaml', 'dependency', 'pet-v2')
    ]);
    const plan = planSpecFileReconcile({
      cloud: [
        { id: 'root-id', path: 'openapi.yaml', type: 'ROOT' },
        { id: 'pet-id', path: 'components/pet.yaml', type: 'DEFAULT' }
      ],
      cloudContentById: new Map([
        ['root-id', 'root-v1'],
        ['pet-id', 'pet-v1']
      ]),
      target
    });
    expect(plan).toEqual({
      create: [],
      update: [{ id: 'pet-id', content: 'pet-v2' }],
      delete: []
    });
    expect(buildBulkFilesBody(plan)).toEqual({
      update: [{ id: 'pet-id', content: 'pet-v2' }]
    });
  });

  it('plans add and delete by exact path', () => {
    const target = bundle([
      file('openapi.yaml', 'root', 'root-v1'),
      file('components/error.yaml', 'dependency', 'error-v1')
    ]);
    const plan = planSpecFileReconcile({
      cloud: [
        { id: 'root-id', path: 'openapi.yaml', type: 'ROOT' },
        { id: 'pet-id', path: 'components/pet.yaml', type: 'DEFAULT' }
      ],
      cloudContentById: new Map([
        ['root-id', 'root-v1'],
        ['pet-id', 'pet-v1']
      ]),
      target
    });
    expect(plan.create).toEqual([
      { path: 'components/error.yaml', content: 'error-v1', type: 'DEFAULT' }
    ]);
    expect(plan.delete).toEqual([{ id: 'pet-id' }]);
  });

  it('rejects root path change without building mutations', () => {
    expect(() => assertSameRootPath('openapi.yaml', 'index.yaml')).toThrow(
      /CONTRACT_SPEC_ROOT_PATH_CHANGE_UNSUPPORTED/
    );
  });

  it('rejects duplicate cloud paths', () => {
    expect(() =>
      cloudMembersToDefinitionBundle({
        format: 'openapi-yaml',
        members: [
          { path: 'openapi.yaml', type: 'ROOT', content: 'a' },
          { path: 'OpenAPI.yaml', type: 'DEFAULT', content: 'b' }
        ]
      })
    ).toThrow(/CONTRACT_DEFINITION_DUPLICATE_PATH/);
  });

  it('filters folder nodes from gateway list responses', () => {
    const metas = listFilesFromGatewayResponse({
      data: [
        { id: 'folder-1', path: 'components', type: 'FOLDER' },
        { id: 'root-id', path: 'openapi.yaml', type: 'ROOT' },
        { id: 'pet-id', path: 'components/pet.yaml', type: 'DEFAULT' }
      ]
    });
    expect(metas.map((entry) => entry.path).sort()).toEqual([
      'components/pet.yaml',
      'openapi.yaml'
    ]);
  });

  it('validates reconcile capability policy shape independently of receipt literals', () => {
    const derived = deriveSpecReconcileCapabilityPolicyFromReceipt(
      committedR5MultifileSpecSyncReceipt
    );
    expect(validateSpecReconcileCapabilityPolicy(derived)).toEqual(derived);
    expect(() =>
      validateSpecReconcileCapabilityPolicy({
        bulkModify: true,
        atomicBulk: true,
        rootPathChange: 'no' as unknown as boolean
      })
    ).toThrow(/reconcile capability policy\.rootPathChange must be a boolean/);
  });

  it('rejects synthetic receipts that fail R6 production gating', () => {
    const justified = syntheticJustifyingReceipt();
    expect(deriveSpecReconcileCapabilityPolicyFromReceipt(justified)).toEqual(
      deriveSpecReconcileCapabilityPolicyFromReceipt(committedR5MultifileSpecSyncReceipt)
    );
    expect(r5ReceiptJustifiesMultiFileSyncDefaultOn(justified)).toBe(true);
    expect(resolveMultiFileSpecSyncDefaultFromReceipt(justified)).toBe('on');

    expect(() =>
      deriveSpecReconcileCapabilityPolicyFromReceipt(
        syntheticJustifyingReceipt({ modes: ['nonorg'] })
      )
    ).toThrow(/missing leg mode org/);
    expect(() =>
      deriveSpecReconcileCapabilityPolicyFromReceipt(syntheticJustifyingReceipt({ modes: ['org'] }))
    ).toThrow(/missing leg mode nonorg/);

    for (const id of R6_REQUIRED_RECEIPT_PROBE_IDS) {
      expect(() =>
        deriveSpecReconcileCapabilityPolicyFromReceipt(
          syntheticJustifyingReceipt({ probePassed: { [id]: false } })
        )
      ).toThrow(new RegExp(`${id} must pass`));
      expect(() =>
        deriveSpecReconcileCapabilityPolicyFromReceipt(
          syntheticJustifyingReceipt({ omitProbe: id })
        )
      ).toThrow(new RegExp(`missing probe row ${id}`));
    }

    expect(
      deriveSpecReconcileCapabilityPolicyFromReceipt(
        syntheticJustifyingReceipt({ probePassed: { P11: false } })
      )
    ).toEqual(deriveSpecReconcileCapabilityPolicyFromReceipt(committedR5MultifileSpecSyncReceipt));

    expect(() =>
      deriveSpecReconcileCapabilityPolicyFromReceipt(
        syntheticJustifyingReceipt({ teardownResidue: true })
      )
    ).toThrow(/teardown\.residue must be false/);
    expect(() =>
      deriveSpecReconcileCapabilityPolicyFromReceipt(syntheticJustifyingReceipt({ omitTeardown: true }))
    ).toThrow(/teardown\.residue must be false/);

    expect(() =>
      deriveSpecReconcileCapabilityPolicyFromReceipt(
        syntheticJustifyingReceipt({ capabilities: { bulkModify: 'true' } })
      )
    ).toThrow(/capabilities\.bulkModify must be a boolean/);
    expect(() =>
      deriveSpecReconcileCapabilityPolicyFromReceipt(
        syntheticJustifyingReceipt({ capabilities: { atomicBulk: 1 } })
      )
    ).toThrow(/capabilities\.atomicBulk must be a boolean/);
    expect(() =>
      deriveSpecReconcileCapabilityPolicyFromReceipt(
        syntheticJustifyingReceipt({ capabilities: { rootPathChange: null } })
      )
    ).toThrow(/capabilities\.rootPathChange must be a boolean/);

    for (const key of R6_REQUIRED_RECEIPT_CAPABILITIES) {
      expect(
        r5ReceiptJustifiesMultiFileSyncDefaultOn(
          syntheticJustifyingReceipt({ capabilities: { [key]: false } })
        )
      ).toBe(false);
      expect(
        resolveMultiFileSpecSyncDefaultFromReceipt(
          syntheticJustifyingReceipt({ capabilities: { [key]: false } })
        )
      ).toBe('off');
    }
  });

  it('derives production reconcile policy from the fully validated committed R5 receipt', () => {
    const fromCommitted = deriveSpecReconcileCapabilityPolicyFromReceipt(
      committedR5MultifileSpecSyncReceipt
    );
    const defaultFromCommitted = resolveMultiFileSpecSyncDefaultFromReceipt(
      committedR5MultifileSpecSyncReceipt
    );
    // Production constants must equal derivation from the committed artifact (not copied literals).
    expect(DEFAULT_SPEC_RECONCILE_CAPABILITY_POLICY).toEqual(fromCommitted);
    expect(MULTI_FILE_SPEC_SYNC_DEFAULT).toBe(defaultFromCommitted);
    expect(r5ReceiptJustifiesMultiFileSyncDefaultOn(committedR5MultifileSpecSyncReceipt)).toBe(
      true
    );
    expect(Object.keys(DEFAULT_SPEC_RECONCILE_CAPABILITY_POLICY).sort()).toEqual(
      Object.keys(fromCommitted).sort()
    );
    for (const key of Object.keys(fromCommitted) as Array<keyof typeof fromCommitted>) {
      expect(typeof DEFAULT_SPEC_RECONCILE_CAPABILITY_POLICY[key]).toBe('boolean');
      expect(DEFAULT_SPEC_RECONCILE_CAPABILITY_POLICY[key]).toBe(fromCommitted[key]);
    }
  });

  it('orders per-file ops: sorted non-root upserts, root last, then sorted deletes', () => {
    const target = bundle([
      file('openapi.yaml', 'root', 'root-v2'),
      file('components/error.yaml', 'dependency', 'error-v1'),
      file('components/zoo.yaml', 'dependency', 'zoo-v2')
    ]);
    const cloud = [
      { id: 'root-id', path: 'openapi.yaml', type: 'ROOT', parentId: 'folder-root' },
      { id: 'pet-id', path: 'components/pet.yaml', type: 'DEFAULT', parentId: 'folder-components' },
      { id: 'zoo-id', path: 'components/zoo.yaml', type: 'DEFAULT', parentId: 'folder-components' }
    ];
    const plan = planSpecFileReconcile({
      cloud,
      cloudContentById: new Map([
        ['root-id', 'root-v1'],
        ['pet-id', 'pet-v1'],
        ['zoo-id', 'zoo-v1']
      ]),
      target
    });
    const ops = orderPerFileReconcileOps({ plan, cloud });
    expect(ops.map((op) => `${op.kind}:${op.path}`)).toEqual([
      'create:components/error.yaml',
      'update:components/zoo.yaml',
      'update:openapi.yaml',
      'delete:components/pet.yaml'
    ]);
    expect(perFileCreateName('components/error.yaml')).toBe('error.yaml');
    expect(resolvePerFileCreateParentId(cloud, 'components/error.yaml')).toBe('folder-components');
  });
});

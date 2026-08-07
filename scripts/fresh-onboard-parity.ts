import type { PlannedOutputs } from '../src/index.js';

export interface FreshOnboardParityResult {
  outputs: Partial<PlannedOutputs>;
  interactionKeys: readonly string[];
}

const REQUIRED_OUTPUTS = [
  'workspace-id',
  'spec-id',
  'baseline-collection-id',
  'smoke-collection-id',
  'contract-collection-id'
] as const;

const MINT_KEY = 'POST https://api.getpostman.com/service-account-tokens';
const IMPORT_KEY = 'proxy:sync POST /collection/import';
const DEEP_UPDATE_KEY = 'proxy:sync PUT /collection/deepupdate/';
const WORKSPACE_CREATE_KEY = 'proxy:workspaces POST /workspaces';
const SPEC_CREATE_KEY = 'proxy:specification POST /specifications';

function countKeys(keys: readonly string[], prefix: string): number {
  return keys.filter((key) => key.startsWith(prefix)).length;
}

/**
 * The source-agnostic minimum contract for a successful fresh onboarding
 * recording. Output IDs intentionally only need to be present: live captures
 * receive volatile IDs while the deterministic fake uses fixed synthetic ones.
 */
export function assertFreshOnboardParity({
  outputs,
  interactionKeys
}: FreshOnboardParityResult): void {
  for (const output of REQUIRED_OUTPUTS) {
    if (!outputs[output]) throw new Error(`fresh-onboard parity requires output "${output}"`);
  }

  let ledger: { counts?: Record<string, number> };
  try {
    ledger = JSON.parse(outputs['openapi-operation-ledger-json'] || '{}');
  } catch {
    throw new Error('fresh-onboard parity requires a valid openapi-operation-ledger-json output');
  }
  if (
    ledger.counts?.wholeCollectionImport !== 3 ||
    ledger.counts.deepUpdate !== 0 ||
    ledger.counts.specHubCollectionGeneration !== 0 ||
    ledger.counts.temporaryOpenApiSpecCreate !== 0 ||
    ledger.counts.postCreateScriptPatch !== 0
  ) {
    throw new Error('fresh-onboard parity requires the fresh OpenAPI operation ledger');
  }

  if (
    countKeys(interactionKeys, MINT_KEY) !== 1 ||
    countKeys(interactionKeys, IMPORT_KEY) !== 3 ||
    countKeys(interactionKeys, DEEP_UPDATE_KEY) !== 0 ||
    countKeys(interactionKeys, WORKSPACE_CREATE_KEY) !== 1 ||
    countKeys(interactionKeys, SPEC_CREATE_KEY) < 1
  ) {
    throw new Error('fresh-onboard parity requires the fresh onboarding wire contract');
  }
}

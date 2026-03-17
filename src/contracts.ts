export interface ActionInputContract {
  description: string;
  required: boolean;
  default?: string;
  allowedValues?: string[];
}

export interface ActionOutputContract {
  description: string;
}

export interface BetaActionContract {
  name: string;
  description: string;
  inputs: Record<string, ActionInputContract>;
  outputs: Record<string, ActionOutputContract>;
  retainedBehavior: string[];
  removedBehavior: string[];
}

export const openAlphaActionContract: BetaActionContract = {
  name: 'postman-bootstrap-action',
  description: 'Public open-alpha contract for bootstrapping Postman assets from a registry-backed spec.',
  inputs: {

    'workspace-id': {
      description: 'Existing Postman workspace ID.',
      required: false
    },
    'spec-id': {
      description: 'Existing Postman spec ID.',
      required: false
    },
    'baseline-collection-id': {
      description: 'Existing baseline collection ID.',
      required: false
    },
    'smoke-collection-id': {
      description: 'Existing smoke collection ID.',
      required: false
    },
    'contract-collection-id': {
      description: 'Existing contract collection ID.',
      required: false
    },
    'project-name': {
      description: 'Service project name.',
      required: true
    },
    domain: {
      description: 'Business domain for the service.',
      required: false
    },
    'domain-code': {
      description: 'Short domain code used in workspace naming.',
      required: false
    },
    'requester-email': {
      description: 'Requester email for audit context.',
      required: false
    },
    'workspace-admin-user-ids': {
      description: 'Comma-separated workspace admin user ids.',
      required: false
    },
    'spec-url': {
      description: 'HTTPS URL to the OpenAPI document.',
      required: true
    },
    'environments-json': {
      description: 'JSON array of environment slugs to preserve in bootstrap outputs.',
      required: false,
      default: '["prod"]'
    },
    'system-env-map-json': {
      description: 'JSON map of environment slug to system environment id.',
      required: false,
      default: '{}'
    },
    'governance-mapping-json': {
      description: 'JSON map of business domain to governance group name.',
      required: false,
      default: '{}'
    },
    'postman-api-key': {
      description: 'Postman API key used for bootstrap operations.',
      required: true
    },
    'postman-access-token': {
      description: 'Postman access token used for governance and workspace mutations.',
      required: false
    },
    'github-token': {
      description: 'GitHub token for repository variable persistence.',
      required: false
    },
    'gh-fallback-token': {
      description: 'Fallback token for repository variable APIs.',
      required: false
    },
    'github-auth-mode': {
      description: 'GitHub auth mode for repository variable APIs.',
      required: false,
      default: 'github_token_first'
    },
    'integration-backend': {
      description: 'Integration backend for downstream workspace connectivity.',
      required: false,
      default: 'bifrost',
      allowedValues: ['bifrost']
    }
  },
  outputs: {
    'workspace-id': {
      description: 'Postman workspace ID.'
    },
    'workspace-url': {
      description: 'Postman workspace URL.'
    },
    'workspace-name': {
      description: 'Postman workspace name.'
    },
    'spec-id': {
      description: 'Uploaded Postman spec ID.'
    },
    'baseline-collection-id': {
      description: 'Baseline collection ID.'
    },
    'smoke-collection-id': {
      description: 'Smoke collection ID.'
    },
    'contract-collection-id': {
      description: 'Contract collection ID.'
    },
    'collections-json': {
      description: 'JSON summary of generated collections.'
    },
    'spec-server-url': {
      description: 'First server URL extracted from the OpenAPI spec servers field.'
    },
    'lint-summary-json': {
      description: 'JSON summary of lint errors and warnings.'
    }
  },
  retainedBehavior: [
    'workspace creation',
    'governance group assignment',
    'requester workspace invitation',
    'workspace admin assignment',
    'spec upload to Spec Hub',
    'spec linting by UID',
    'baseline, smoke, and contract collection generation',
    'collection tagging',
    'GitHub repository variable persistence for downstream sync steps',
    'workspace, spec, and collection outputs'
  ],
  removedBehavior: [
    'snake_case input and output names',
    'step mode',
    'hardcoded runtime deployment assumptions',
    'aws, docker, and infra workflow concerns',
    'runtime-coupled workflow tuning knobs',
    'legacy placeholder inputs such as team-id'
  ]
};

export const contractInputNames = Object.keys(openAlphaActionContract.inputs);
export const contractOutputNames = Object.keys(openAlphaActionContract.outputs);

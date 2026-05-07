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
    'sync-examples': {
      description: 'Whether linked spec/collection relations should enable example syncing.',
      required: false,
      default: 'true',
      allowedValues: ['true', 'false']
    },
    'collection-sync-mode': {
      description:
        'Collection lifecycle policy: refresh tracked collections from the latest spec or version them by release label.',
      required: false,
      default: 'refresh',
      allowedValues: ['refresh', 'version']
    },
    'spec-sync-mode': {
      description:
        'Spec lifecycle policy: update the canonical spec or create/reuse a versioned spec for the resolved release label.',
      required: false,
      default: 'update',
      allowedValues: ['update', 'version']
    },
    'release-label': {
      description:
        'Optional release label. When omitted for versioned sync, the action derives one from GitHub ref metadata.',
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
    'workspace-team-id': {
      description: 'Numeric sub-team ID for org-mode workspace creation.',
      required: false
    },
    'spec-url': {
      description: 'HTTPS URL to the OpenAPI document.',
      required: true
    },
    'openapi-version': {
      description: 'OpenAPI specification version override (3.0 or 3.1). When not set, the version is auto-detected from the spec content.',
      required: false,
      default: '',
      allowedValues: ['3.0', '3.1']
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
    'integration-backend': {
      description: 'Integration backend for downstream workspace connectivity.',
      required: false,
      default: 'bifrost',
      allowedValues: ['bifrost']
    },
    'folder-strategy': {
      description: 'Folder organization strategy for generated collections.',
      required: false,
      default: 'Paths',
      allowedValues: ['Paths', 'Tags']
    },
    'nested-folder-hierarchy': {
      description: 'When folder-strategy is Tags, enables nested folder hierarchy. Has no effect when folder-strategy is Paths.',
      required: false,
      default: 'false'
    },
    'request-name-source': {
      description: 'Determines how requests are named in generated collections. Fallback uses summary, operationId, description, or URL in order.',
      required: false,
      default: 'Fallback',
      allowedValues: ['Fallback', 'URL']
    },
    'postman-api-base': {
      description: 'Base URL for the public Postman API (override for beta/staging stacks).',
      required: false,
      default: 'https://api.getpostman.com'
    },
    'postman-bifrost-base': {
      description: 'Base URL for the Bifrost gateway used by internal integration calls (override for beta/staging stacks).',
      required: false,
      default: 'https://bifrost-premium-https-v4.gw.postman.com'
    },
    'postman-gateway-base': {
      description: 'Base URL for the Postman gateway used by governance and workspace-group calls (override for beta/staging stacks).',
      required: false,
      default: 'https://gateway.postman.com'
    },
    'postman-cli-install-url': {
      description: 'Installer URL for the Postman CLI (override for beta/staging stacks).',
      required: false,
      default: 'https://dl-cli.pstmn.io/install/unix.sh'
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
    'OpenAPI operation summary normalization before upload (missing or oversized summaries)',
    'spec linting by UID',
    'baseline, smoke, and contract collection generation',
    'collection refresh and versioning policies',
    'collection tagging',
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

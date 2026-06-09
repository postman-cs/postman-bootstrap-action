export interface ActionInputContract {
  description: string;
  required: boolean;
  default?: string;
  allowedValues?: string[];
}

export interface ActionOutputContract {
  description: string;
}

export interface CustomerPreviewActionContract {
  name: string;
  description: string;
  inputs: Record<string, ActionInputContract>;
  outputs: Record<string, ActionOutputContract>;
  retainedBehavior: string[];
  removedBehavior: string[];
}

export const customerPreviewActionContract: CustomerPreviewActionContract = {
  name: 'postman-bootstrap-action',
  description: 'Public customer preview contract for bootstrapping Postman assets from a registry-backed spec.',
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
    'governance-group': {
      description: 'Postman governance workspace group name. Overrides the postman-governance-group repository custom property and domain mapping.',
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
      description: 'HTTPS URL to the OpenAPI document. Provide either spec-url or spec-path.',
      required: false
    },
    'spec-path': {
      description: 'Local filesystem path to the OpenAPI document (read from the workspace). Provide either spec-url or spec-path.',
      required: false
    },
    'openapi-version': {
      description: 'OpenAPI specification version override (3.0 or 3.1). When not set, the version is auto-detected from the spec content.',
      required: false,
      default: '',
      allowedValues: ['3.0', '3.1']
    },
    'breaking-change-mode': {
      description: 'OpenAPI breaking-change comparison mode.',
      required: false,
      default: 'off',
      allowedValues: ['off', 'pr-native', 'baseline-only', 'previous-spec']
    },
    'breaking-baseline-spec-path': {
      description: 'Workspace-relative baseline OpenAPI spec path used by baseline-only mode and pr-native fallback.',
      required: false
    },
    'breaking-rules-path': {
      description: 'Workspace-relative openapi-changes rules file. Missing files are ignored.',
      required: false,
      default: 'changes-rules.yaml'
    },
    'breaking-target-ref': {
      description: 'Optional target branch or git ref override for pr-native breaking-change comparisons.',
      required: false
    },
    'breaking-summary-path': {
      description: 'Optional markdown report output path. Defaults to a runner-temp file.',
      required: false,
      default: ''
    },
    'breaking-log-path': {
      description: 'Optional raw command log output path. Defaults to a runner-temp file.',
      required: false,
      default: ''
    },
    'governance-mapping-json': {
      description:
        'Legacy JSON map of business domain to governance group name. Prefer governance-group or the postman-governance-group repository custom property.',
      required: false,
      default: '{}'
    },
    'github-token': {
      description: 'GitHub token used to read repository custom properties.',
      required: false
    },
    'gh-fallback-token': {
      description: 'Fallback GitHub token used to read repository custom properties.',
      required: false
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
    'postman-stack': {
      description: 'Postman stack profile.',
      required: false,
      default: 'prod',
      allowedValues: ['prod', 'beta']
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
    },
    'breaking-change-status': {
      description: 'OpenAPI breaking-change check status.'
    },
    'breaking-change-summary-json': {
      description: 'JSON summary of the OpenAPI breaking-change check.'
    }
  },
  retainedBehavior: [
    'workspace creation',
    'governance group assignment',
    'requester workspace invitation',
    'workspace admin assignment',
    'spec upload to Spec Hub',
    'OpenAPI operation summary normalization before upload (missing or oversized summaries)',
    'optional OpenAPI breaking-change detection before Postman mutations',
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

export const contractInputNames = Object.keys(customerPreviewActionContract.inputs);
export const contractOutputNames = Object.keys(customerPreviewActionContract.outputs);

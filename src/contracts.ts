export interface ActionInputContract {
  description: string;
  required: boolean;
  default?: string;
  allowedValues?: string[];
}

export interface ActionOutputContract {
  description: string;
}

export interface ActionContract {
  name: string;
  description: string;
  inputs: Record<string, ActionInputContract>;
  outputs: Record<string, ActionOutputContract>;
  retainedBehavior: string[];
  removedBehavior: string[];
}

export const bootstrapActionContract: ActionContract = {
  name: 'postman-bootstrap-action',
  description: 'Contract for bootstrapping Postman assets from an OpenAPI spec.',
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
    'additional-collections-dir': {
      description: 'Workspace-relative directory containing curated Postman v2.1 JSON/YAML files or canonical HTTP collection v3 Local View directories to create or update.',
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
    'spec-files-json': {
      description:
        'Optional content-free JSON inventory of multi-file definition members from discovery (schemaVersion 1). Empty by default. When set, inventory root must equal spec-path. Cannot be combined with spec-url. Not a directory mode — companions are listed explicitly; file content is never embedded.',
      required: false,
      default: ''
    },
    'protocol': {
      description:
        'API spec protocol. auto (default) detects from the spec content/extension. openapi flows through Spec Hub; graphql (SDL/introspection), grpc (.proto), soap (WSDL), and asyncapi (AsyncAPI 2.x WebSocket/Socket.IO) build and instrument a Postman collection directly.',
      required: false,
      default: 'auto',
      allowedValues: ['auto', 'openapi', 'graphql', 'grpc', 'soap', 'asyncapi']
    },
    'protocol-endpoint-url': {
      description:
        'Endpoint URL/authority used by generated non-OpenAPI requests (e.g. {{baseUrl}}/graphql, grpc://host:port). Supports Postman variable interpolation. Ignored for openapi.',
      required: false,
      default: ''
    },
    'openapi-version': {
      description: 'OpenAPI specification version override (3.0 or 3.1). When not set, the version is auto-detected from the spec content.',
      required: false,
      default: '',
      allowedValues: ['3.0', '3.1']
    },
    'preserve-oas30-type-null': {
      description: 'Opt-in compatibility mode for legacy OpenAPI 3.0 oneOf schemas that pair a normal schema with type: null. The original source bytes are uploaded unchanged while an internal nullable view is used for validation and generated artifacts.',
      required: false,
      default: 'false',
      allowedValues: ['true', 'false']
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
      description: 'Postman service-account API key used only to mint or re-mint the short-lived access token.',
      required: false
    },
    'postman-access-token': {
      description: 'Postman service-account access token used for every identity and asset operation.',
      required: false
    },
    'credential-preflight': {
      description:
        'Access-token session preflight policy. warn (default) continues when session identity is unavailable; enforce fails before any workspace is created.',
      required: false,
      default: 'warn',
      allowedValues: ['enforce', 'warn']
    },
    'branch-strategy': {
      description:
        'Branch-aware sync strategy. legacy (default) keeps branch-blind behavior; publish-gate restricts canonical writes to the canonical branch and runs credential-free static validation on other branches; preview additionally maintains suffixed per-branch preview asset sets.',
      required: false,
      default: 'legacy',
      allowedValues: ['legacy', 'preview', 'publish-gate']
    },
    'canonical-branch': {
      description:
        'Explicit canonical branch (the sole writer of canonical assets). Defaults to the provider-resolved default branch; required on providers without a default-branch variable (Bitbucket, Azure DevOps) when branch-strategy is not legacy.',
      required: false
    },
    'channels': {
      description:
        'Comma-separated channel map for long-lived promotion branches, e.g. "develop=DEV, staging=STAGE, release/*=RC". Channel branches maintain prefix-named parallel asset sets and never mutate canonical assets.',
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
    'postman-region': {
      description: 'Postman data residency region for public API and Postman CLI calls.',
      required: false,
      default: 'us',
      allowedValues: ['us', 'eu']
    },
    'postman-stack': {
      description: 'Postman stack profile. One of: prod or beta. beta is supported only with postman-region=us.',
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
      description: 'JSON summary of validation findings. Bootstrap does not invoke the Postman CLI lint.'
    },
    'breaking-change-status': {
      description: 'OpenAPI breaking-change check status.'
    },
    'breaking-change-summary-json': {
      description: 'JSON summary of the OpenAPI breaking-change check.'
    },
    'sync-status': {
      description:
        'Branch-aware sync status: synced (canonical/channel/preview write ran), skipped-branch-gate (gated run, credential-free validation only), or empty under branch-strategy legacy.'
    },
    'branch-decision': {
      description: 'Serialized BranchDecision JSON for downstream actions (also exported as POSTMAN_BRANCH_DECISION).'
    },
    'spec-version-tag': {
      description:
        'Native Spec Hub version tag applied on this canonical publish (tag-per-publish), empty when tagging was skipped (no-op sync, non-canonical run, or legacy client).'
    },
    'spec-version-url': {
      description:
        'Reserved for the repo-sync finalizer; bootstrap does not tag before complete onboarding.'
    },
    'spec-content-changed': {
      description: 'Whether bootstrap changed canonical spec content; repo-sync uses this to skip native version tags on no-op syncs.'
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
    'hardcoded deployment assumptions',
    'aws, docker, and infra workflow concerns',
    'deployment-coupled workflow tuning knobs',
    'legacy placeholder inputs such as team-id'
  ]
};

export const contractInputNames = Object.keys(bootstrapActionContract.inputs);
export const contractOutputNames = Object.keys(bootstrapActionContract.outputs);

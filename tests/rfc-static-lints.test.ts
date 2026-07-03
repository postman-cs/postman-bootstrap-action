import { describe, expect, it } from 'vitest';

import { buildContractIndex } from '../src/lib/spec/contract-index.js';
import { parseOpenApiDocument } from '../src/lib/spec/openapi-loader.js';

function indexFrom(spec: string) {
  return buildContractIndex(parseOpenApiDocument(spec));
}

describe('RFC/OpenAPI static lints', () => {
  it('flags unregistered HTTP auth schemes, query credentials, and security URL defects', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /a:
    get:
      security:
        - weird: []
        - queryKey: []
        - oauth: ['read:missing']
        - oidc: []
      responses:
        '200': { description: OK }
        '401': { description: unauthorized }
        '403': { description: forbidden }
components:
  securitySchemes:
    weird: { type: http, scheme: hoba2 }
    queryKey: { type: apiKey, in: query, name: key }
    oauth:
      type: oauth2
      flows:
        clientCredentials:
          tokenUrl: 'http://insecure.example/token'
          scopes: { 'read:things': read things }
    oidc: { type: openIdConnect, openIdConnectUrl: 'https://id.example.com/config' }
`);
    const warnings = index.operations[0]!.warnings;
    expect(warnings.some((w) => w.startsWith('CONTRACT_UNKNOWN_HTTP_AUTH_SCHEME') && w.includes('hoba2'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_CREDENTIALS_IN_QUERY') && w.includes('queryKey'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_SECURITY_SCHEME_URL') && w.includes('tokenUrl'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_OAUTH2_UNDECLARED_SCOPE') && w.includes('read:missing'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_SECURITY_SCHEME_URL') && w.includes('openid-configuration'))).toBe(true);
  });

  it('flags security/response documentation gaps in both directions', () => {
    const base = (security: string, responses: string) => `openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /a:
    get:
${security}      responses:
${responses}components:
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer }
    oauth:
      type: oauth2
      flows:
        clientCredentials:
          tokenUrl: 'https://auth.example.com/token'
          scopes: { 'read:things': read }
`;
    const secured = indexFrom(base('      security:\n        - bearerAuth: []\n', "        '200': { description: OK }\n"));
    expect(secured.operations[0]!.warnings.some((w) => w.startsWith('CONTRACT_SECURITY_RESPONSES_INCOMPLETE') && w.includes('401'))).toBe(true);
    const scoped = indexFrom(base("      security:\n        - oauth: ['read:things']\n", "        '200': { description: OK }\n        '401': { description: no }\n"));
    expect(scoped.operations[0]!.warnings.some((w) => w.startsWith('CONTRACT_SECURITY_RESPONSES_INCOMPLETE') && w.includes('403'))).toBe(true);
    expect(scoped.operations[0]!.warnings.some((w) => w.startsWith('CONTRACT_SECURITY_RESPONSES_INCOMPLETE') && w.includes('401 '))).toBe(false);
    const unsecured = indexFrom(base('', "        '200': { description: OK }\n        '401': { description: no }\n"));
    expect(unsecured.operations[0]!.warnings.some((w) => w.startsWith('CONTRACT_UNSECURED_AUTH_RESPONSES'))).toBe(true);
    const catchall = indexFrom(base('      security:\n        - bearerAuth: []\n', "        '200': { description: OK }\n        default: { description: any }\n"));
    expect(catchall.operations[0]!.warnings.filter((w) => w.startsWith('CONTRACT_SECURITY_RESPONSES_INCOMPLETE'))).toEqual([]);
  });

  it('flags invalid status keys and bodyless statuses declaring content', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /a:
    get:
      responses:
        '200': { description: OK }
        '99': { description: bogus }
        '204':
          description: NoContent
          content:
            application/json:
              schema: { type: object }
`);
    const warnings = index.operations[0]!.warnings;
    expect(warnings.some((w) => w.startsWith('CONTRACT_INVALID_STATUS_CODE') && w.includes('"99"'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_BODYLESS_STATUS_WITH_CONTENT') && w.includes('204'))).toBe(true);
  });

  it('flags spec-declared request bodies on GET', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /a:
    get:
      requestBody:
        content:
          application/json:
            schema: { type: object }
      responses:
        '200': { description: OK }
`);
    expect(index.warnings.some((w) => w.startsWith('CONTRACT_METHOD_BODY_SEMANTICS') && w.includes('GET /a'))).toBe(true);
  });

  it('separates evaluable link expressions from warning-only links', () => {
    const spec = (links: string) => `openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /a:
    get:
      responses:
        '200':
          description: OK
          links:
${links}`;
    const partial = indexFrom(spec("            next:\n              operationId: getA\n              parameters: { id: '$response.body#/id', path: '$request.path.id' }\n"));
    expect(partial.operations[0]!.responses['200']!.links).toEqual([{ link: 'next', kind: 'body', pointer: '/id' }]);
    expect(partial.operations[0]!.warnings.some((w) => w.startsWith('CONTRACT_LINKS_PARTIALLY_VALIDATED'))).toBe(true);
    const none = indexFrom(spec('            next:\n              operationId: getA\n'));
    expect(none.operations[0]!.responses['200']!.links).toBeUndefined();
    expect(none.operations[0]!.warnings.some((w) => w.startsWith('CONTRACT_LINKS_NOT_VALIDATED'))).toBe(true);
  });

  it('creates deepObject and label path checks instead of serialization warnings', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /r/{id}:
    get:
      parameters:
        - { name: id, in: path, required: true, style: label, schema: { type: string } }
        - name: filter
          in: query
          style: deepObject
          explode: true
          schema: { type: object, properties: { kind: { type: string } } }
      responses:
        '200': { description: OK }
`);
    const operation = index.operations[0]!;
    expect(operation.parameterChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ in: 'path', name: 'id', pathStyle: 'label' }),
      expect.objectContaining({ in: 'query', name: 'filter', decode: 'deepObject' })
    ]));
    expect(operation.warnings.filter((w) => w.startsWith('CONTRACT_PARAM_SERIALIZATION_NOT_VALIDATED'))).toEqual([]);
    expect(operation.warnings.filter((w) => w.startsWith('CONTRACT_PATH_PARAM_NOT_VALIDATED'))).toEqual([]);
  });

  it('validates parameter examples against their schemas', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /a:
    get:
      parameters:
        - { name: n, in: query, schema: { type: integer }, example: nope }
      responses:
        '200': { description: OK }
`);
    expect(index.operations[0]!.warnings.some((w) => w.startsWith('CONTRACT_EXAMPLE_SCHEMA_MISMATCH') && w.includes('query:n'))).toBe(true);
  });

  it('accepts serialized array examples for decodable query and header parameter styles', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /a:
    get:
      parameters:
        - { name: q, in: query, style: spaceDelimited, explode: false, schema: { type: array, items: { type: string } }, example: "a b" }
        - { name: X-Ids, in: header, style: simple, schema: { type: array, items: { type: integer } }, example: "1,2,3" }
      responses:
        '200': { description: OK }
`);
    expect(index.operations[0]!.warnings.some((w) => w.startsWith('CONTRACT_EXAMPLE_SCHEMA_MISMATCH') && w.includes('header:X-Ids'))).toBe(false);
  });

  it('flags unregistered /.well-known/ suffixes against the IANA snapshot', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /.well-known/openid-configuration:
    get:
      responses:
        '200': { description: OK }
  /.well-known/my-custom-thing:
    get:
      responses:
        '200': { description: OK }
`);
    expect(index.warnings.filter((w) => w.startsWith('CONTRACT_WELL_KNOWN_UNREGISTERED'))).toEqual([
      expect.stringContaining('my-custom-thing')
    ]);
  });

  it('flags encoding map keys that are not request body schema properties', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
paths:
  /upload:
    post:
      requestBody:
        content:
          multipart/form-data:
            schema:
              type: object
              properties:
                file: { type: string, format: binary }
            encoding:
              file: { contentType: application/octet-stream }
              ghost: { contentType: application/json }
      responses:
        '201': { description: Created }
`);
    const warnings = index.operations[0]!.warnings;
    expect(warnings.some((w) => w.startsWith('CONTRACT_MULTIPART_ENCODING_FIELD_UNKNOWN') && w.includes('ghost'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_MULTIPART_ENCODING_FIELD_UNKNOWN') && w.includes('field file'))).toBe(false);
  });

  it('emits server advisory patterns with enum-constrained variables', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
servers:
  - url: 'https://{region}.api.example.com/v1'
    variables:
      region:
        default: us
        enum: [us, eu]
paths:
  /a:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/DefaultedThing'
`);
    expect(index.operations[0]!.servers).toEqual(['^https://(us|eu)\\.api\\.example\\.com/v1']);
  });

  it('flags OpenAPI version-specific schema and document constructs', () => {
    const v30 = indexFrom(`openapi: 3.0.3
info: { title: T, version: 1 }
webhooks: { created: {} }
components:
  pathItems: { Reusable: {} }
  schemas:
    Thing:
      type: [string, 'null']
      const: a
      contains: { type: string }
      minContains: 1
      maxContains: 2
      exclusiveMinimum: 1
      prefixItems: []
      if: { type: string }
      default: 7
    NullOnly:
      type: 'null'
    NullableWithoutType:
      nullable: true
      enum: [x]
    EmptyEnum:
      type: string
      enum: []
    DuplicateEnum:
      type: string
      enum: [a, a]
    BothDirections:
      type: string
      readOnly: true
      writeOnly: true
    RefSibling:
      $ref: '#/components/schemas/Thing'
      type: string
paths:
  /a:
    get:
      responses:
        '200': { description: OK }
`);
    expect(v30.warnings.some((w) => w.startsWith('CONTRACT_OAS_VERSION_UNSUPPORTED_FIELD') && w.includes('webhooks'))).toBe(true);
    expect(v30.warnings.some((w) => w.startsWith('CONTRACT_OAS_VERSION_UNSUPPORTED_FIELD') && w.includes('components.pathItems'))).toBe(true);
    expect(v30.warnings.some((w) => w.startsWith('CONTRACT_SCHEMA_VERSION_MISMATCH') && w.includes('type arrays'))).toBe(true);
    expect(v30.warnings.some((w) => w.startsWith('CONTRACT_SCHEMA_VERSION_MISMATCH') && w.includes('const'))).toBe(true);
    expect(v30.warnings.some((w) => w.startsWith('CONTRACT_SCHEMA_VERSION_MISMATCH') && w.includes('contains'))).toBe(true);
    expect(v30.warnings.some((w) => w.startsWith('CONTRACT_SCHEMA_VERSION_MISMATCH') && w.includes('minContains'))).toBe(true);
    expect(v30.warnings.some((w) => w.startsWith('CONTRACT_SCHEMA_VERSION_MISMATCH') && w.includes('maxContains'))).toBe(true);
    expect(v30.warnings.some((w) => w.startsWith('CONTRACT_SCHEMA_VERSION_MISMATCH') && w.includes('type "null"'))).toBe(true);
    expect(v30.warnings.some((w) => w.startsWith('CONTRACT_SCHEMA_VERSION_MISMATCH') && w.includes('exclusiveMinimum'))).toBe(true);
    expect(v30.warnings.some((w) => w.startsWith('CONTRACT_SCHEMA_VERSION_MISMATCH') && w.includes('prefixItems'))).toBe(true);
    expect(v30.warnings.some((w) => w.startsWith('CONTRACT_REF_SIBLING_INVALID'))).toBe(true);
    expect(v30.warnings.some((w) => w.startsWith('CONTRACT_SCHEMA_VALUE_MISMATCH') && w.includes('default does not match declared type'))).toBe(true);
    expect(v30.warnings.some((w) => w.startsWith('CONTRACT_SCHEMA_VERSION_MISMATCH') && w.includes('without a sibling type'))).toBe(true);
    expect(v30.warnings.some((w) => w.startsWith('CONTRACT_SCHEMA_VALUE_MISMATCH') && w.includes('enum excludes null'))).toBe(true);
    expect(v30.warnings.some((w) => w.startsWith('CONTRACT_SCHEMA_VALUE_MISMATCH') && w.includes('must not be empty'))).toBe(true);
    expect(v30.warnings.some((w) => w.startsWith('CONTRACT_SCHEMA_VALUE_MISMATCH') && w.includes('duplicate values'))).toBe(true);
    expect(v30.warnings.some((w) => w.startsWith('CONTRACT_SCHEMA_IMPOSSIBLE_MESSAGE') && w.includes('both readOnly and writeOnly'))).toBe(true);
    const v31 = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
jsonSchemaDialect: not-a-uri
components:
  schemas:
    Thing:
      type: string
      nullable: true
      exclusiveMinimum: true
      format: made-up
      default: ok
    DefaultedThing:
      type: integer
      minimum: 10
      default: 7
paths:
  /a:
    get:
      responses:
        '200': { description: OK }
`);
    expect(v31.warnings.some((w) => w.startsWith('CONTRACT_JSON_SCHEMA_DIALECT_UNSUPPORTED'))).toBe(true);
    expect(v31.warnings.some((w) => w.startsWith('CONTRACT_SCHEMA_VERSION_MISMATCH') && w.includes('nullable'))).toBe(true);
    expect(v31.warnings.some((w) => w.startsWith('CONTRACT_FORMAT_UNKNOWN'))).toBe(true);
    const v31Default = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
components:
  schemas:
    DefaultedThing:
      type: integer
      minimum: 10
      default: 7
paths:
  /a:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/DefaultedThing'
`);
    expect(v31Default.warnings.some((w) => w.startsWith('CONTRACT_SCHEMA_VALUE_MISMATCH') && w.includes('default does not validate against its schema'))).toBe(true);
  });

  it('flags parameter, path, operationId, server, and response-shape lints', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
servers:
  - url: 'https://{region}.example.com/{unused}'
    variables:
      region: { enum: [] }
      ghost: { default: x }
tags:
  - { name: declared }
  - { name: unused }
paths:
  /pets/{id}:
    get:
      operationId: dup
      tags: [missing]
      parameters:
        - { name: id, in: path, required: false, schema: { type: string } }
        - { name: id, in: path, required: true, schema: { type: string } }
        - { name: token, in: header, allowReserved: true, style: form, schema: { type: string } }
        - { name: f, in: query, style: deepObject, schema: { type: string } }
        - { name: c, in: query, schema: { type: string }, content: { application/json: { schema: { type: object } } } }
      responses:
        '200': { description: OK }
    post:
      operationId: dup
      parameters:
        - { name: other, in: path, required: true, schema: { type: string } }
      responses:
        '200': { description: OK }
  /pets/{petId}:
    get:
      responses:
        '200': { description: OK }
`);
    const warnings = [...index.warnings, ...index.operations.flatMap((op) => op.warnings)];
    expect(warnings.some((w) => w.startsWith('CONTRACT_OPERATION_ID_DUPLICATE'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_TAG_UNDECLARED'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_TAG_UNUSED'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_SERVER_VARIABLE_INVALID') && w.includes('default'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_TEMPLATED_PATH_COLLISION'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_PARAMETER_DUPLICATE'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_PATH_PARAMETER_INVALID'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_PATH_PARAMETER_BIJECTION'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_PARAMETER_STYLE_INVALID'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_PARAMETER_ALLOW_RESERVED_INVALID'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_PARAMETER_DEEPOBJECT_INVALID'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_PARAMETER_SCHEMA_CONTENT_XOR'))).toBe(true);
  });

  it('flags encoding, discriminator, impossible-message, link, callback, and media-range lints', () => {
    const index = indexFrom(`openapi: 3.1.0
info: { title: T, version: 1 }
components:
  schemas:
    BadDiscriminator:
      type: object
      discriminator: { propertyName: kind, mapping: { a: '#/components/schemas/Missing' } }
      properties:
        kind: { type: string }
    Overlap:
      oneOf:
        - { enum: [a, b] }
        - { enum: [b, c] }
paths:
  /a:
    post:
      deprecated: true
      callbacks:
        '$request.body#/missing': {}
      requestBody:
        content:
          multipart/form-data:
            schema:
              type: object
              required: [ro]
              properties:
                ro: { type: string, readOnly: true }
                file: { type: string }
            encoding:
              ghost: { contentType: application/json }
              file:
                headers:
                  Content-Type: { schema: { type: string } }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema: { type: object, required: [secret], properties: { secret: { type: string, writeOnly: true } } }
            application/*+json:
              schema: { type: object, properties: { id: { type: string } } }
          links:
            bad:
              operationId: getA
              operationRef: '#/paths/~1missing/get'
`);
    const warnings = [...index.warnings, ...index.operations.flatMap((op) => op.warnings)];
    expect(warnings.some((w) => w.startsWith('CONTRACT_DISCRIMINATOR_INVALID'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_DISCRIMINATOR_INVALID') && w.includes('must be required by the base schema'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_ONEOF_OVERLAP'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_ENCODING_FIELD_UNKNOWN'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_ENCODING_HEADER_INVALID'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_SCHEMA_IMPOSSIBLE_MESSAGE') && w.includes('request'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_SCHEMA_IMPOSSIBLE_MESSAGE') && w.includes('response'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_LINK_TARGET_INVALID'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_CALLBACK_EXPRESSION_INVALID'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_MEDIA_RANGE_SHADOWING'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('CONTRACT_DEPRECATED_HEADERS_ADVISORY'))).toBe(true);
  });
});

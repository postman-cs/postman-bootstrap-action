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
        '200': { description: OK }
`);
    expect(index.operations[0]!.servers).toEqual(['^https://(us|eu)\\.api\\.example\\.com/v1']);
  });
});

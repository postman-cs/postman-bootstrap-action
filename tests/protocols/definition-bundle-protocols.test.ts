import { describe, expect, it } from 'vitest';

import { buildProtocolCollection } from '../../src/lib/protocols/dispatch.js';
import { parseAsyncApi } from '../../src/lib/protocols/asyncapi/asyncapi-parser.js';
import { parseProtoSchema } from '../../src/lib/protocols/grpc/proto-parser.js';
import { parseWsdl } from '../../src/lib/protocols/soap/parser.js';
import {
  createDefinitionBundle,
  createDefinitionFile,
  type DefinitionBundle,
  type DefinitionCompleteness,
  type DefinitionFormat
} from '../../src/lib/spec/definition-bundle.js';
import { PROTOBUF } from './grpc/helpers.js';

function bundleOf(
  format: DefinitionFormat,
  rootPath: string,
  members: Array<{ path: string; role: 'root' | 'dependency'; body: string }>,
  completeness: DefinitionCompleteness = 'full'
): DefinitionBundle {
  return createDefinitionBundle({
    rootPath,
    format,
    completeness,
    provenance: { source: 'spec-path', evidence: ['protocol-test'] },
    files: members.map((member) =>
      createDefinitionFile({
        path: member.path,
        role: member.role,
        bytes: Buffer.from(member.body, 'utf8')
      })
    )
  });
}

describe('protocol DefinitionBundle consumers', () => {
  describe('protobuf multi-file', () => {
    const typesProto = `syntax = "proto3";
package payments.v1;

message ChargeRequest {
  string imported_amount = 1;
  string currency = 2;
}

message ChargeResponse {
  string receipt_id = 1;
}
`;

    const serviceProto = `syntax = "proto3";
package payments.v1;

import "types.proto";

service Payments {
  rpc Charge(ChargeRequest) returns (ChargeResponse);
}
`;

    it('resolves a two-file proto import so imported fields participate', () => {
      // Declared dependency (@postman/protobufjs); must execute, not skip.
      expect(PROTOBUF).toBeTruthy();
      const definitionBundle = bundleOf('protobuf', 'service.proto', [
        { path: 'service.proto', role: 'root', body: serviceProto },
        { path: 'types.proto', role: 'dependency', body: typesProto }
      ]);

      const index = parseProtoSchema(serviceProto, {
        protobuf: PROTOBUF!,
        definitionBundle
      });

      expect(index.warnings.some((warning) => warning.startsWith('GRPC_IMPORT_UNRESOLVED_DISCLOSURE'))).toBe(false);
      const request = index.messages['payments.v1.ChargeRequest'];
      expect(request).toBeDefined();
      expect(request.fields.some((field) => field.name === 'imported_amount')).toBe(true);
      expect(index.operations.some((operation) => operation.method === 'Charge')).toBe(true);
    });

    it('fails missing non-well-known imports with CONTRACT_DEFINITION_CLOSURE_INCOMPLETE', () => {
      expect(PROTOBUF).toBeTruthy();
      const definitionBundle = bundleOf('protobuf', 'service.proto', [
        { path: 'service.proto', role: 'root', body: serviceProto }
      ]);

      expect(() =>
        parseProtoSchema(serviceProto, {
          protobuf: PROTOBUF!,
          definitionBundle
        })
      ).toThrow(/CONTRACT_DEFINITION_CLOSURE_INCOMPLETE/);
    });

    it('preserves single-file callers and well-known import disclosure without a bundle', () => {
      expect(PROTOBUF).toBeTruthy();
      const index = parseProtoSchema(
        [
          'syntax = "proto3";',
          'import "google/protobuf/timestamp.proto";',
          'package t;',
          'message M { google.protobuf.Timestamp t = 1; string a = 2; }',
          'service S { rpc G(M) returns (M); }'
        ].join('\n'),
        { protobuf: PROTOBUF! }
      );
      expect(index.warnings.some((warning) => warning.startsWith('GRPC_IMPORT_UNRESOLVED_DISCLOSURE'))).toBe(true);
      expect(index.messages['t.M']?.fields.find((field) => field.name === 't')?.jsonFormat).toBe('proto-timestamp');
    });
  });

  describe('WSDL/XSD multi-file', () => {
    const typesXsd = `<?xml version="1.0" encoding="UTF-8"?>
<schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:payments/types" elementFormDefault="qualified">
  <element name="Charge">
    <complexType>
      <sequence>
        <element name="importedAmount" type="string"/>
        <element name="currency" type="string"/>
      </sequence>
    </complexType>
  </element>
  <element name="ChargeResponse">
    <complexType>
      <sequence>
        <element name="receiptId" type="string"/>
      </sequence>
    </complexType>
  </element>
</schema>
`;

    const importedWsdl = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
    xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
    xmlns:tns="urn:payments/ops"
    xmlns:types="urn:payments/types"
    targetNamespace="urn:payments/ops">
  <types>
    <schema xmlns="http://www.w3.org/2001/XMLSchema">
      <import namespace="urn:payments/types" schemaLocation="types.xsd"/>
    </schema>
  </types>
  <message name="ChargeRequest"><part name="body" element="types:Charge"/></message>
  <message name="ChargeResponse"><part name="body" element="types:ChargeResponse"/></message>
  <portType name="PaymentsPortType">
    <operation name="Charge">
      <input message="tns:ChargeRequest"/>
      <output message="tns:ChargeResponse"/>
    </operation>
  </portType>
</definitions>
`;

    const rootWsdl = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
    xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
    xmlns:tns="urn:payments"
    xmlns:ops="urn:payments/ops"
    targetNamespace="urn:payments">
  <import namespace="urn:payments/ops" location="payments-ops.wsdl"/>
  <binding name="PaymentsBinding" type="ops:PaymentsPortType">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/>
    <operation name="Charge">
      <soap:operation soapAction="urn:payments/Charge"/>
      <input><soap:body use="literal"/></input>
      <output><soap:body use="literal"/></output>
    </operation>
  </binding>
  <service name="PaymentsService">
    <port name="PaymentsPort" binding="tns:PaymentsBinding">
      <soap:address location="https://payments.example.test/soap"/>
    </port>
  </service>
</definitions>
`;

    it('resolves a two-file WSDL so imported operations and schema components participate', () => {
      const definitionBundle = bundleOf('wsdl', 'payments.wsdl', [
        { path: 'payments.wsdl', role: 'root', body: rootWsdl },
        { path: 'payments-ops.wsdl', role: 'dependency', body: importedWsdl },
        { path: 'types.xsd', role: 'dependency', body: typesXsd }
      ]);

      const index = parseWsdl(rootWsdl, { definitionBundle });
      const service = index.services.find((entry) => entry.name === 'PaymentsService');
      expect(service).toBeDefined();
      expect(service?.operations.some((operation) => operation.name === 'Charge')).toBe(true);
      const charge = service?.operations.find((operation) => operation.name === 'Charge');
      expect(charge?.expectedResponseElement).toBe('ChargeResponse');
      expect(index.schemaIndex.complete).toBe(true);
      expect(index.schemaIndex.elements.has('urn:payments/types|Charge')).toBe(true);
      expect(index.schemaIndex.elements.get('urn:payments/types|Charge')?.children?.some((child) => child.name === 'importedAmount')).toBe(true);
    });

    it('resolves nested/transitive XSD relative to the importing file, not the WSDL root', () => {
      const leafXsd = `<?xml version="1.0" encoding="UTF-8"?>
<schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:payments/common" elementFormDefault="qualified">
  <element name="Money">
    <complexType>
      <sequence>
        <element name="amount" type="string"/>
        <element name="currency" type="string"/>
      </sequence>
    </complexType>
  </element>
</schema>
`;
      const midXsd = `<?xml version="1.0" encoding="UTF-8"?>
<schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:payments/types" elementFormDefault="qualified"
    xmlns:common="urn:payments/common">
  <import namespace="urn:payments/common" schemaLocation="../common/money.xsd"/>
  <element name="Charge">
    <complexType>
      <sequence>
        <element ref="common:Money"/>
      </sequence>
    </complexType>
  </element>
  <element name="ChargeResponse">
    <complexType>
      <sequence>
        <element name="receiptId" type="string"/>
      </sequence>
    </complexType>
  </element>
</schema>
`;
      const opsWsdl = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
    xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
    xmlns:tns="urn:payments/ops"
    xmlns:types="urn:payments/types"
    targetNamespace="urn:payments/ops">
  <types>
    <schema xmlns="http://www.w3.org/2001/XMLSchema">
      <import namespace="urn:payments/types" schemaLocation="schemas/types.xsd"/>
    </schema>
  </types>
  <message name="ChargeRequest"><part name="body" element="types:Charge"/></message>
  <message name="ChargeResponse"><part name="body" element="types:ChargeResponse"/></message>
  <portType name="PaymentsPortType">
    <operation name="Charge">
      <input message="tns:ChargeRequest"/>
      <output message="tns:ChargeResponse"/>
    </operation>
  </portType>
</definitions>
`;
      const root = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
    xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
    xmlns:tns="urn:payments"
    xmlns:ops="urn:payments/ops"
    targetNamespace="urn:payments">
  <import namespace="urn:payments/ops" location="ops/payments-ops.wsdl"/>
  <binding name="PaymentsBinding" type="ops:PaymentsPortType">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/>
    <operation name="Charge">
      <soap:operation soapAction="urn:payments/Charge"/>
      <input><soap:body use="literal"/></input>
      <output><soap:body use="literal"/></output>
    </operation>
  </binding>
  <service name="PaymentsService">
    <port name="PaymentsPort" binding="tns:PaymentsBinding">
      <soap:address location="https://payments.example.test/soap"/>
    </port>
  </service>
</definitions>
`;
      // Decoy same-basename types.xsd at root must not be selected when ops imports schemas/types.xsd.
      const decoyTypesXsd = `<?xml version="1.0" encoding="UTF-8"?>
<schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:payments/decoy" elementFormDefault="qualified">
  <element name="Decoy"><complexType><sequence><element name="x" type="string"/></sequence></complexType></element>
</schema>
`;

      const definitionBundle = bundleOf('wsdl', 'payments.wsdl', [
        { path: 'payments.wsdl', role: 'root', body: root },
        { path: 'ops/payments-ops.wsdl', role: 'dependency', body: opsWsdl },
        { path: 'ops/schemas/types.xsd', role: 'dependency', body: midXsd },
        { path: 'ops/common/money.xsd', role: 'dependency', body: leafXsd },
        { path: 'types.xsd', role: 'dependency', body: decoyTypesXsd }
      ]);

      const index = parseWsdl(root, { definitionBundle });
      expect(index.schemaIndex.complete).toBe(true);
      expect(index.schemaIndex.elements.has('urn:payments/types|Charge')).toBe(true);
      expect(index.schemaIndex.elements.has('urn:payments/common|Money')).toBe(true);
      expect(index.schemaIndex.elements.has('urn:payments/decoy|Decoy')).toBe(false);
      expect(index.services[0]?.operations.some((operation) => operation.name === 'Charge')).toBe(true);
    });

    it('fails missing WSDL imports with CONTRACT_DEFINITION_CLOSURE_INCOMPLETE', () => {
      const definitionBundle = bundleOf('wsdl', 'payments.wsdl', [
        { path: 'payments.wsdl', role: 'root', body: rootWsdl }
      ]);
      expect(() => parseWsdl(rootWsdl, { definitionBundle })).toThrow(/CONTRACT_DEFINITION_CLOSURE_INCOMPLETE/);
    });
  });

  describe('AsyncAPI local refs', () => {
    const messagesYaml = `ChatMessage:
  name: ChatMessage
  payload:
    type: object
    properties:
      text:
        type: string
        example: hello-bundle
`;

    const rootYaml = `asyncapi: 2.6.0
info:
  title: Chat
  version: 1.0.0
servers:
  production:
    url: wss://chat.example.test
    protocol: ws
channels:
  chat:
    publish:
      message:
        $ref: './messages.yaml#/ChatMessage'
`;

    it('resolves a local AsyncAPI relative $ref from a full confined bundle', async () => {
      const definitionBundle = bundleOf('asyncapi-yaml', 'asyncapi.yaml', [
        { path: 'asyncapi.yaml', role: 'root', body: rootYaml },
        { path: 'messages.yaml', role: 'dependency', body: messagesYaml }
      ]);
      const index = await parseAsyncApi(rootYaml, { definitionBundle });
      expect(index.channels).toHaveLength(1);
      expect(JSON.stringify(index.channels[0]?.messages[0]?.payloadSchema)).toContain('hello-bundle');
      expect(index.channels[0]?.messages[0]?.sample).toEqual(
        expect.objectContaining({ text: 'hello-bundle' })
      );
    });

    it('resolves nested AsyncAPI refs relative to the importing document', async () => {
      const sharedYaml = `SharedPayload:
  type: object
  properties:
    nestedText:
      type: string
      example: nested-hello
`;
      const messagesNested = `ChatMessage:
  name: ChatMessage
  payload:
    $ref: '../common/shared.yaml#/SharedPayload'
`;
      const nestedRoot = `asyncapi: 2.6.0
info:
  title: Chat
  version: 1.0.0
servers:
  production:
    url: wss://chat.example.test
    protocol: ws
channels:
  chat:
    publish:
      message:
        $ref: './schemas/messages.yaml#/ChatMessage'
`;
      const definitionBundle = bundleOf('asyncapi-yaml', 'asyncapi.yaml', [
        { path: 'asyncapi.yaml', role: 'root', body: nestedRoot },
        { path: 'schemas/messages.yaml', role: 'dependency', body: messagesNested },
        { path: 'common/shared.yaml', role: 'dependency', body: sharedYaml }
      ]);
      const index = await parseAsyncApi(nestedRoot, { definitionBundle });
      expect(JSON.stringify(index.channels[0]?.messages[0]?.payloadSchema)).toContain('nested-hello');
    });

    it('does not resolve ambiguous same-basename paths by suffix guessing', async () => {
      const aMessages = `ChatMessage:
  name: ChatMessage
  payload:
    type: object
    properties:
      text:
        type: string
        example: from-a
`;
      const bMessages = `ChatMessage:
  name: ChatMessage
  payload:
    type: object
    properties:
      text:
        type: string
        example: from-b
`;
      const collisionRoot = `asyncapi: 2.6.0
info:
  title: Chat
  version: 1.0.0
servers:
  production:
    url: wss://chat.example.test
    protocol: ws
channels:
  chat:
    publish:
      message:
        $ref: './dir-a/messages.yaml#/ChatMessage'
`;
      const definitionBundle = bundleOf('asyncapi-yaml', 'asyncapi.yaml', [
        { path: 'asyncapi.yaml', role: 'root', body: collisionRoot },
        { path: 'dir-a/messages.yaml', role: 'dependency', body: aMessages },
        { path: 'dir-b/messages.yaml', role: 'dependency', body: bMessages }
      ]);
      const index = await parseAsyncApi(collisionRoot, { definitionBundle });
      expect(JSON.stringify(index.channels[0]?.messages[0]?.payloadSchema)).toContain('from-a');
      expect(JSON.stringify(index.channels[0]?.messages[0]?.payloadSchema)).not.toContain('from-b');
    });

    it('rejects partial AsyncAPI bundles with CONTRACT_DEFINITION_CLOSURE_INCOMPLETE', async () => {
      const definitionBundle = bundleOf(
        'asyncapi-yaml',
        'asyncapi.yaml',
        [
          { path: 'asyncapi.yaml', role: 'root', body: rootYaml },
          { path: 'messages.yaml', role: 'dependency', body: messagesYaml }
        ],
        'partial'
      );
      await expect(parseAsyncApi(rootYaml, { definitionBundle })).rejects.toThrow(
        /CONTRACT_DEFINITION_CLOSURE_INCOMPLETE/
      );
    });

    it('fails missing AsyncAPI local refs with CONTRACT_DEFINITION_CLOSURE_INCOMPLETE', async () => {
      const definitionBundle = bundleOf('asyncapi-yaml', 'asyncapi.yaml', [
        { path: 'asyncapi.yaml', role: 'root', body: rootYaml }
      ]);
      await expect(parseAsyncApi(rootYaml, { definitionBundle })).rejects.toThrow(
        /CONTRACT_DEFINITION_CLOSURE_INCOMPLETE/
      );
    });

    it('fails remote AsyncAPI refs under a confined bundle', async () => {
      const withRemote = `asyncapi: 2.6.0
info:
  title: Chat
  version: 1.0.0
servers:
  production:
    url: wss://chat.example.test
    protocol: ws
channels:
  chat:
    publish:
      message:
        $ref: 'https://cdn.example.test/messages.yaml#/ChatMessage'
`;
      const definitionBundle = bundleOf('asyncapi-yaml', 'asyncapi.yaml', [
        { path: 'asyncapi.yaml', role: 'root', body: withRemote }
      ]);
      await expect(parseAsyncApi(withRemote, { definitionBundle })).rejects.toThrow(
        /CONTRACT_DEFINITION_CLOSURE_INCOMPLETE/
      );
    });
  });

  describe('MCP multi-file', () => {
    it('rejects more than one member with CONTRACT_MCP_MULTIFILE_UNSUPPORTED', async () => {
      const root = JSON.stringify({
        name: 'io.github.example/weather',
        packages: [{ registryType: 'npm', identifier: '@example/weather', version: '1.0.0' }]
      });
      const definitionBundle = bundleOf('mcp-json', 'server.json', [
        { path: 'server.json', role: 'root', body: root },
        { path: 'extra.json', role: 'dependency', body: '{}' }
      ]);
      await expect(
        buildProtocolCollection('mcp', root, { definitionBundle })
      ).rejects.toThrow(/CONTRACT_MCP_MULTIFILE_UNSUPPORTED/);
    });
  });

  describe('GraphQL remains single-file ordered', () => {
    it('keeps deterministic operation order when a one-file bundle is supplied via dispatch', async () => {
      const sdl = [
        'type Query {',
        '  zebra: String',
        '  alpha: String',
        '}',
        'type Mutation {',
        '  mid: String',
        '}'
      ].join('\n');
      const definitionBundle = bundleOf('graphql-sdl', 'schema.graphql', [
        { path: 'schema.graphql', role: 'root', body: sdl }
      ]);

      const withBundle = await buildProtocolCollection('graphql', sdl, {
        name: 'T',
        definitionBundle
      });
      const without = await buildProtocolCollection('graphql', sdl, { name: 'T' });

      expect(withBundle.operationCount).toBe(without.operationCount);
      expect(withBundle.format).toBe(without.format);
      expect(withBundle.runnableInCi).toBe(true);

      const leafNames = (collection: Record<string, unknown>): string[] => {
        const out: string[] = [];
        const walk = (node: unknown): void => {
          if (!node || typeof node !== 'object') return;
          const record = node as Record<string, unknown>;
          const children = (record.children ?? record.item) as unknown[] | undefined;
          if (Array.isArray(children) && children.length > 0) {
            for (const child of children) walk(child);
            return;
          }
          const name = typeof record.name === 'string' ? record.name : typeof record.title === 'string' ? record.title : '';
          if (name) out.push(name);
        };
        walk(collection);
        return out;
      };

      expect(leafNames(withBundle.collection)).toEqual(leafNames(without.collection));
      expect(
        leafNames(withBundle.collection).filter((name) => /^(query|mutation)\s/.test(name))
      ).toEqual(['query alpha', 'query zebra', 'mutation mid']);
    });
  });
});

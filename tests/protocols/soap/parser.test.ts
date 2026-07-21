import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultActionIri, parseWsdl } from '../../../src/lib/protocols/soap/parser.js';
import {
  createDefinitionBundle,
  createDefinitionFile
} from '../../../src/lib/spec/definition-bundle.js';

const here = dirname(fileURLToPath(import.meta.url));
const wsdl = readFileSync(resolve(here, '../../../fixtures/soap/stockquote.wsdl'), 'utf8');
const addressingWsdl = readFileSync(resolve(here, '../../../fixtures/soap/addressing.wsdl'), 'utf8');

describe('parseWsdl', () => {
  it('parses a WSDL 1.1 document into services and operations', () => {
    const index = parseWsdl(wsdl);
    expect(index.wsdlVersion).toBe('1.1');
    expect(index.targetNamespace).toBe('http://example.com/stockquote');
    expect(index.services).toHaveLength(1);
    const service = index.services[0]!;
    expect(service.name).toBe('StockQuoteService');
    expect(service.endpoint).toBe('https://example.com/soap/stockquote');
    expect(service.operations.map((operation) => operation.name)).toEqual(['GetStockPrice', 'ListSymbols']);
  });

  it('resolves SOAPAction and SOAP version from the binding', () => {
    const index = parseWsdl(wsdl);
    const op = index.services[0]!.operations[0]!;
    expect(op.soapAction).toBe('http://example.com/stockquote/GetStockPrice');
    expect(op.soapVersion).toBe('1.1');
  });

  it('derives the expected response element from the output message element', () => {
    const index = parseWsdl(wsdl);
    const op = index.services[0]!.operations[0]!;
    expect(op.expectedResponseElement).toBe('GetStockPriceResponse');
    expect(op.expectedResponseNamespace).toBe('http://example.com/stockquote');
    expect(op.output?.parts[0]?.element).toBe('tns:GetStockPriceResponse');
  });

  it('preserves deterministic document ordering of operations', () => {
    const a = parseWsdl(wsdl);
    const b = parseWsdl(wsdl);
    expect(a.services[0]!.operations.map((o) => o.name)).toEqual(b.services[0]!.operations.map((o) => o.name));
  });

  it('throws a prefixed error on empty input', () => {
    expect(() => parseWsdl('')).toThrow(/SOAP_EMPTY_WSDL/);
  });

  it('throws a prefixed error on a non-WSDL root', () => {
    expect(() => parseWsdl('<html><body>not wsdl</body></html>')).toThrow(/SOAP_WSDL_ROOT_INVALID/);
  });

  it('throws when a WSDL declares no operations', () => {
    const empty = `<?xml version="1.0"?><definitions xmlns="http://schemas.xmlsoap.org/wsdl/" targetNamespace="urn:x"></definitions>`;
    expect(() => parseWsdl(empty)).toThrow(/SOAP_NO_OPERATIONS/);
  });

  it('warns and synthesizes a service when <service> is absent', () => {
    const noService = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
             xmlns:tns="urn:x" targetNamespace="urn:x" name="X">
  <message name="In"><part name="p" element="tns:Op"/></message>
  <message name="Out"><part name="p" element="tns:OpResponse"/></message>
  <portType name="PT">
    <operation name="Op"><input message="tns:In"/><output message="tns:Out"/></operation>
  </portType>
  <binding name="B" type="tns:PT">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="Op"><soap:operation soapAction="urn:x/Op"/></operation>
  </binding>
</definitions>`;
    const index = parseWsdl(noService);
    expect(index.warnings.join('\n')).toMatch(/SOAP_SERVICE_MISSING/);
    expect(index.services[0]!.operations[0]!.name).toBe('Op');
  });

  it('detects SOAP 1.2 bindings', () => {
    const soap12 = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/"
             xmlns:tns="urn:x" targetNamespace="urn:x" name="X">
  <message name="In"><part name="p" element="tns:Op"/></message>
  <message name="Out"><part name="p" element="tns:OpResponse"/></message>
  <portType name="PT">
    <operation name="Op"><input message="tns:In"/><output message="tns:Out"/></operation>
  </portType>
  <binding name="B" type="tns:PT">
    <soap12:binding transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="Op"><soap12:operation soapAction="urn:x/Op"/></operation>
  </binding>
  <service name="S"><port name="P" binding="tns:B"><soap12:address location="https://x/soap"/></port></service>
</definitions>`;
    const index = parseWsdl(soap12);
    expect(index.services[0]!.operations[0]!.soapVersion).toBe('1.2');
  });

  it('detects WS-Addressing engagement and captures explicit action IRIs', () => {
    const index = parseWsdl(addressingWsdl);
    expect(index.declaresAddressing).toBe(true);
    const op = index.services[0]!.operations[0]!;
    expect(op.inputAction).toBe('http://example.com/quote/GetQuote');
    expect(op.outputAction).toBe('http://example.com/quote/GetQuoteReply');
  });

  it('reports declaresAddressing false when the WSDL never engages WS-Addressing', () => {
    expect(parseWsdl(wsdl).declaresAddressing).toBe(false);
  });

  it('indexes transitive XSD includes relative to the importing schema file', () => {
    const shared = `<?xml version="1.0" encoding="UTF-8"?>
<schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:x/shared" elementFormDefault="qualified">
  <element name="SharedField"><complexType><sequence><element name="value" type="string"/></sequence></complexType></element>
</schema>`;
    const types = `<?xml version="1.0" encoding="UTF-8"?>
<schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:x" elementFormDefault="qualified"
    xmlns:shared="urn:x/shared">
  <import namespace="urn:x/shared" schemaLocation="../shared/common.xsd"/>
  <element name="Op"><complexType><sequence><element ref="shared:SharedField"/></sequence></complexType></element>
  <element name="OpResponse"><complexType><sequence><element name="ok" type="boolean"/></sequence></complexType></element>
</schema>`;
    const root = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
             xmlns:tns="urn:x" targetNamespace="urn:x" name="X">
  <types>
    <schema xmlns="http://www.w3.org/2001/XMLSchema">
      <import namespace="urn:x" schemaLocation="schemas/types.xsd"/>
    </schema>
  </types>
  <message name="In"><part name="p" element="tns:Op"/></message>
  <message name="Out"><part name="p" element="tns:OpResponse"/></message>
  <portType name="PT">
    <operation name="Op"><input message="tns:In"/><output message="tns:Out"/></operation>
  </portType>
  <binding name="B" type="tns:PT">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="Op"><soap:operation soapAction="urn:x/Op"/>
      <input><soap:body use="literal"/></input>
      <output><soap:body use="literal"/></output>
    </operation>
  </binding>
  <service name="S"><port name="P" binding="tns:B"><soap:address location="https://x/soap"/></port></service>
</definitions>`;

    const definitionBundle = createDefinitionBundle({
      rootPath: 'service.wsdl',
      format: 'wsdl',
      completeness: 'full',
      provenance: { source: 'spec-path', evidence: ['soap-parser-test'] },
      files: [
        createDefinitionFile({ path: 'service.wsdl', role: 'root', bytes: Buffer.from(root, 'utf8') }),
        createDefinitionFile({ path: 'schemas/types.xsd', role: 'dependency', bytes: Buffer.from(types, 'utf8') }),
        createDefinitionFile({ path: 'shared/common.xsd', role: 'dependency', bytes: Buffer.from(shared, 'utf8') })
      ]
    });

    const index = parseWsdl(root, { definitionBundle });
    expect(index.schemaIndex.complete).toBe(true);
    expect(index.schemaIndex.elements.has('urn:x|Op')).toBe(true);
    expect(index.schemaIndex.elements.has('urn:x/shared|SharedField')).toBe(true);
    expect(index.services[0]!.operations[0]!.name).toBe('Op');
  });

  it('fails when a nested XSD import is missing from the confined bundle', () => {
    const types = `<?xml version="1.0" encoding="UTF-8"?>
<schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:x" elementFormDefault="qualified">
  <import namespace="urn:x/shared" schemaLocation="../shared/common.xsd"/>
  <element name="Op"><complexType/></element>
  <element name="OpResponse"><complexType/></element>
</schema>`;
    const root = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
             xmlns:tns="urn:x" targetNamespace="urn:x" name="X">
  <types>
    <schema xmlns="http://www.w3.org/2001/XMLSchema">
      <import namespace="urn:x" schemaLocation="schemas/types.xsd"/>
    </schema>
  </types>
  <message name="In"><part name="p" element="tns:Op"/></message>
  <message name="Out"><part name="p" element="tns:OpResponse"/></message>
  <portType name="PT">
    <operation name="Op"><input message="tns:In"/><output message="tns:Out"/></operation>
  </portType>
  <binding name="B" type="tns:PT">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="Op"><soap:operation soapAction="urn:x/Op"/></operation>
  </binding>
  <service name="S"><port name="P" binding="tns:B"><soap:address location="https://x/soap"/></port></service>
</definitions>`;

    const definitionBundle = createDefinitionBundle({
      rootPath: 'service.wsdl',
      format: 'wsdl',
      completeness: 'full',
      provenance: { source: 'spec-path', evidence: ['soap-parser-test'] },
      files: [
        createDefinitionFile({ path: 'service.wsdl', role: 'root', bytes: Buffer.from(root, 'utf8') }),
        createDefinitionFile({ path: 'schemas/types.xsd', role: 'dependency', bytes: Buffer.from(types, 'utf8') })
      ]
    });

    expect(() => parseWsdl(root, { definitionBundle })).toThrow(/CONTRACT_DEFINITION_CLOSURE_INCOMPLETE/);
  });
});

describe('defaultActionIri', () => {
  it('joins with "/" for hierarchical target namespaces, trimming trailing slashes', () => {
    expect(defaultActionIri('http://example.com/quote/', 'QuotePort', 'GetQuoteResponse')).toBe('http://example.com/quote/QuotePort/GetQuoteResponse');
  });

  it('joins with ":" for URN target namespaces', () => {
    expect(defaultActionIri('urn:example:quote', 'QuotePort', 'GetQuoteResponse')).toBe('urn:example:quote:QuotePort:GetQuoteResponse');
  });

  it('returns "" when any component is missing', () => {
    expect(defaultActionIri('', 'QuotePort', 'M')).toBe('');
    expect(defaultActionIri('urn:x', undefined, 'M')).toBe('');
    expect(defaultActionIri('urn:x', 'QuotePort', '')).toBe('');
  });
});

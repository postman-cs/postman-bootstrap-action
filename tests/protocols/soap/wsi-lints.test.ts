import { describe, expect, it } from 'vitest';

import { parseWsdl } from '../../../src/lib/protocols/soap/parser.js';
import { lintWsiConformance } from '../../../src/lib/protocols/soap/wsi-lints.js';

const ROOT_WSDL = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"',
  '    xmlns:tns="urn:main" xmlns:imp="urn:other" xmlns:x="urn:types" targetNamespace="urn:main">',
  '  <import namespace="urn:other" location="other.wsdl"/>',
  '  <types>',
  '    <schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:types">',
  '      <import namespace="urn:ext" schemaLocation="ext.xsd"/>',
  '      <element name="Ping"/>',
  '    </schema>',
  '  </types>',
  '  <message name="In"><part name="body" element="x:Ping"/></message>',
  '  <message name="Bad"><part name="b" element="x:Nope"/></message>',
  '  <portType name="PT"><operation name="Do"><input message="tns:In"/><output message="tns:Missing"/></operation></portType>',
  '  <binding name="B" type="imp:RemotePT">',
  '    <soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/>',
  '    <operation name="Do"><soap:operation soapAction="urn:do"/><input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation>',
  '  </binding>',
  '  <service name="Svc"><port name="P" binding="tns:B"><soap:address location="ftp://x"/></port><port name="P2" binding="tns:B"/></service>',
  '</definitions>'
].join('\n');

const OTHER_WSDL = ['<?xml version="1.1"?>', '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" targetNamespace="urn:mismatch"><portType name="OtherPT"/></definitions>'].join('\n');
const EXT_XSD = ['<?xml version="1.0"?>', '<schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:wrong"><element name="Ext"/></schema>'].join('\n');
const resolver = (location: string) => (location === 'other.wsdl' ? OTHER_WSDL : location === 'ext.xsd' ? EXT_XSD : undefined);

describe('WSDL 1.1 WS-I conformance lints (catalog additions)', () => {
  it('checks ports without a resolver: address count, scheme vs transport', () => {
    const warnings = lintWsiConformance(ROOT_WSDL).join('\n');
    expect(warnings).toContain('SOAP_WSI_ADDRESS_SCHEME');
    expect(warnings).toContain('SOAP_WSI_PORT_ADDRESS_COUNT');
    expect(warnings).not.toContain('SOAP_WSI_QNAME');
    expect(warnings).not.toContain('SOAP_WSI_PART_ELEMENT_UNRESOLVED');
  });

  it('verifies resolved imports: XML declarations, namespace agreement, root kinds', () => {
    const warnings = lintWsiConformance(ROOT_WSDL, resolver).join('\n');
    expect(warnings).toContain('SOAP_WSI_IMPORT_XML_DECL');
    expect(warnings).toContain('SOAP_WSI_IMPORT_NAMESPACE_MISMATCH');
    expect(warnings).toContain('SOAP_WSI_XSD_IMPORT_TNS_MISMATCH');
  });

  it('resolves QNames and part elements across the import scope', () => {
    const warnings = lintWsiConformance(ROOT_WSDL, resolver).join('\n');
    expect(warnings).toContain('SOAP_WSI_PART_ELEMENT_UNRESOLVED');
    expect(warnings).toContain('element "x:Nope"');
    expect(warnings).not.toContain('element "x:Ping"');
    expect(warnings).toContain('SOAP_WSI_QNAME_UNRESOLVED');
    expect(warnings).toContain('message "tns:Missing"');
    expect(warnings).toContain('SOAP_WSI_QNAME_NAMESPACE_UNKNOWN');
  });

  it('flags wsdl:import resolving to a schema document', () => {
    const warnings = lintWsiConformance(ROOT_WSDL, () => EXT_XSD).join('\n');
    expect(warnings).toContain('SOAP_WSI_IMPORT_TARGETS_SCHEMA');
  });

  it('flags soapAction on non-HTTP transports and rpc namespace attributes', () => {
    const wsdl = ROOT_WSDL
      .replace('transport="http://schemas.xmlsoap.org/soap/http" style="document"', 'transport="urn:jms" style="rpc"')
      .replace('<output><soap:body use="literal"/></output>', '<output><soap:body use="literal" namespace="urn:main"/><soap:header message="tns:In" namespace="urn:main"/></output>');
    const warnings = lintWsiConformance(wsdl).join('\n');
    expect(warnings).toContain('SOAP_WSI_SOAPACTION_NON_HTTP');
    expect(warnings).toContain('SOAP_WSI_RPC_NAMESPACE_ATTR');
    expect(warnings).toContain('SOAP_WSI_HEADER_PART_MISSING');
  });

  it('flags xsd:import outside xsd:schema and non-NMTOKEN header parts', () => {
    const wsdl = ROOT_WSDL
      .replace('<message name="In">', '<message name="In"><import namespace="urn:x"/>')
      .replace('<output><soap:body use="literal"/></output>', '<output><soap:body use="literal"/><soap:header message="tns:In" part="a b"/></output>');
    const warnings = lintWsiConformance(wsdl).join('\n');
    expect(warnings).toContain('SOAP_WSI_XSD_IMPORT_PLACEMENT');
    expect(warnings).toContain('SOAP_WSI_HEADER_PART_NMTOKEN');
  });

  it('passes the resolver through parseWsdl', () => {
    const index = parseWsdl(ROOT_WSDL.replace('type="imp:RemotePT"', 'type="tns:PT"'), { resolveImport: resolver });
    expect(index.warnings.join('\n')).toContain('SOAP_WSI_QNAME_UNRESOLVED');
  });
});

describe('WSDL 2.0 conformance lints (catalog additions)', () => {
  const DESC = [
    '<description xmlns="http://www.w3.org/ns/wsdl" xmlns:tns="urn:w2" xmlns:x="urn:t2"',
    '    xmlns:wsoap="http://www.w3.org/ns/wsdl/soap" xmlns:wsp="http://www.w3.org/ns/ws-policy" targetNamespace="urn:w2">',
    '  <types><schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:t2"><element name="Req"/></schema></types>',
    '  <interface name="I">',
    '    <fault name="F" element="x:Missing"/>',
    '    <operation name="Do" pattern="http://www.w3.org/ns/wsdl/in-only" style="http://www.w3.org/ns/wsdl/style/rpc">',
    '      <input element="#any" messageLabel="Wrong"/>',
    '      <output element="x:Req"/>',
    '      <infault ref="tns:F"/>',
    '    </operation>',
    '    <operation name="NoPattern"/>',
    '  </interface>',
    '  <binding name="B" type="urn:not-a-known-binding" interface="tns:I" wsoap:protocol="urn:jms">',
    '    <fault ref="tns:Nope" wsoap:code="bad code"/>',
    '    <wsp:PolicyReference/>',
    '    <operation ref="tns:Do"/>',
    '  </binding>',
    '  <service name="S" interface="tns:I">',
    '    <endpoint name="E" binding="tns:Ghost" address="http://e.test/"/>',
    '    <endpoint name="E" binding="tns:B" address="http://e.test/2"/>',
    '  </service>',
    '</description>'
  ].join('\n');

  it('validates MEP shape, labels, fault directions, and style constraints', () => {
    const warnings = lintWsiConformance(DESC).join('\n');
    expect(warnings).toContain('SOAP_WSDL20_MEP_SHAPE');
    expect(warnings).toContain('output placeholder');
    expect(warnings).toContain('propagates no fault');
    expect(warnings).toContain('SOAP_WSDL20_MESSAGE_LABEL');
    expect(warnings).toContain('SOAP_WSDL20_STYLE_CONSTRAINT');
  });

  it('runs the structural pass and resolves element QNames against inline schemas', () => {
    const warnings = lintWsiConformance(DESC).join('\n');
    expect(warnings).toContain('SOAP_WSDL20_STRUCTURE');
    expect(warnings).toContain('message exchange pattern');
    expect(warnings).toContain('SOAP_WSDL20_ELEMENT_UNRESOLVED');
    expect(warnings).toContain('x:Missing');
    expect(warnings).not.toContain('element "x:Req"');
  });

  it('gates binding type/protocol and validates binding faults and policies', () => {
    const warnings = lintWsiConformance(DESC).join('\n');
    expect(warnings).toContain('SOAP_WSDL20_BINDING_TYPE_UNSUPPORTED');
    expect(warnings).toContain('SOAP_WSDL20_PROTOCOL_NOT_HTTP');
    expect(warnings).toContain('SOAP_WSDL20_BINDING_FAULT_UNRESOLVED');
    expect(warnings).toContain('SOAP_WSDL20_FAULT_CODE');
    expect(warnings).toContain('SOAP_WSDL20_POLICY');
  });

  it('checks endpoint binding resolution and interface agreement', () => {
    const warnings = lintWsiConformance(DESC).join('\n');
    expect(warnings).toContain('binding "tns:Ghost" resolves to no declared binding');
    expect(warnings).toContain('endpoint name "E" is not unique');
  });

  it('verifies wsdl 2.0 imports and includes through the resolver', () => {
    const doc = DESC.replace('<types>', '<import namespace="urn:other2" location="o.wsdl"/><include location="inc.wsdl"/><types>');
    const resolve = (location: string) =>
      location === 'o.wsdl'
        ? '<description xmlns="http://www.w3.org/ns/wsdl" targetNamespace="urn:elsewhere"/>'
        : location === 'inc.wsdl'
          ? '<description xmlns="http://www.w3.org/ns/wsdl" targetNamespace="urn:not-w2"/>'
          : undefined;
    const warnings = lintWsiConformance(doc, resolve).join('\n');
    expect(warnings).toContain('SOAP_WSDL20_IMPORT');
    expect(warnings).toContain('declares targetNamespace "urn:elsewhere"');
    expect(warnings).toContain('include requires the including namespace "urn:w2"');
  });

  it('flags soapActionRequired without a SOAPAction on WSDL 1.1 bindings', () => {
    const wsdl = ROOT_WSDL.replace('<soap:operation soapAction="urn:do"/>', '<soap:operation soapActionRequired="true"/>');
    expect(lintWsiConformance(wsdl).join('\n')).toContain('SOAP_WSI_SOAPACTION_REQUIRED');
  });
});

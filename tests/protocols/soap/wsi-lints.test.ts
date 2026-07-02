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

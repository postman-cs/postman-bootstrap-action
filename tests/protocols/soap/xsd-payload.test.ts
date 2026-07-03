import { describe, expect, it } from 'vitest';

import { buildSoapCollection, instrumentSoapCollection, parseWsdl } from '../../../src/lib/protocols/soap/index.js';

const WSDL = [
  '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"',
  '    xmlns:tns="urn:m" xmlns:x="urn:t" targetNamespace="urn:m">',
  '  <types><schema xmlns="http://www.w3.org/2001/XMLSchema" xmlns:t="urn:t" targetNamespace="urn:t" elementFormDefault="qualified">',
  '    <simpleType name="Currency"><restriction base="string"><enumeration value="USD"/><enumeration value="EUR"/></restriction></simpleType>',
  '    <element name="GetQuote"/>',
  '    <element name="GetQuoteResponse">',
  '      <complexType><sequence>',
  '        <element name="price" type="decimal"/>',
  '        <element name="currency" type="t:Currency"/>',
  '        <element name="note" type="string" minOccurs="0" nillable="true"/>',
  '        <element name="count" type="int" minOccurs="0" maxOccurs="3"/>',
  '      </sequence><attribute name="version" use="required" fixed="1.0"/></complexType>',
  '    </element>',
  '  </schema></types>',
  '  <message name="In"><part name="a" element="x:GetQuote"/></message>',
  '  <message name="Out"><part name="r" element="x:GetQuoteResponse"/></message>',
  '  <portType name="PT"><operation name="GetQuote"><input message="tns:In"/><output message="tns:Out"/></operation></portType>',
  '  <binding name="B" type="tns:PT">',
  '    <soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/>',
  '    <operation name="GetQuote"><soap:operation soapAction="urn:gq"/>',
  '      <input><soap:body use="literal"/></input><output><soap:body use="literal"/></output>',
  '    </operation>',
  '  </binding>',
  '  <service name="S"><port name="P" binding="tns:B"><soap:address location="http://example.test/x"/></port></service>',
  '</definitions>'
].join('\n');

const WSDL_NO_SHAPE = WSDL.replace(/<element name="GetQuoteResponse">[\s\S]*?<\/element>/, '<element name="GetQuoteResponse"/>');

describe('XSD payload assertions (soap_runtime_payload_ws_i lane)', () => {
  it('indexes sequence children, enumeration facets, and attribute uses', () => {
    const index = parseWsdl(WSDL);
    const decl = index.schemaIndex.elements.get('urn:t|GetQuoteResponse');
    expect(decl).toBeDefined();
    expect(decl!.children!.map((c) => c.name)).toEqual(['price', 'currency', 'note', 'count']);
    expect(decl!.children![0].builtinType).toBe('decimal');
    expect(decl!.children![1].builtinType).toBe('string');
    expect(decl!.children![1].enumeration).toEqual(['USD', 'EUR']);
    expect(decl!.children![2].nillable).toBe(true);
    expect(decl!.children![3].maxOccurs).toBe(3);
    expect(decl!.attributes).toEqual([{ name: 'version', required: true, fixed: '1.0' }]);
  });

  it('emits sequence, form, scalar, nil, soap-attr, xsi:type, and attribute assertions', () => {
    const index = parseWsdl(WSDL);
    const collection = buildSoapCollection(index, {});
    const { collection: instrumented, warnings } = instrumentSoapCollection(collection, index);
    const scripts = JSON.stringify(instrumented);
    expect(scripts).toContain('Response wrapper children match the declared xsd:sequence');
    expect(scripts).toContain('Response wrapper children follow the schema element form');
    expect(scripts).toContain('Response wrapper scalar children match their XSD simple types');
    expect(scripts).toContain('xsi:nil usage matches the schema nillable declarations');
    expect(scripts).toContain('Literal response element carries no SOAP envelope attributes');
    expect(scripts).toContain('xsi:type values name declared or built-in schema types');
    expect(scripts).toContain('Response wrapper carries its required and fixed XSD attributes');
    expect(warnings.join('\n')).not.toContain('SOAP_RESPONSE_BODY_WRAPPER_ONLY: operation GetQuote ');
  });

  it('keeps the wrapper-only warning when the response element has no provable shape', () => {
    const index = parseWsdl(WSDL_NO_SHAPE);
    const collection = buildSoapCollection(index, {});
    const { warnings } = instrumentSoapCollection(collection, index);
    expect(warnings.join('\n')).toContain('SOAP_RESPONSE_BODY_WRAPPER_ONLY: operation GetQuote ');
  });
});

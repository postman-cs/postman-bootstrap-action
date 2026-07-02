import { describe, expect, it } from 'vitest';

import { buildSoapCollection, instrumentSoapCollection, parseWsdl } from '../../../src/lib/protocols/soap/index.js';

const WSDL = [
  '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"',
  '    xmlns:tns="urn:m" xmlns:x="urn:t" targetNamespace="urn:m">',
  '  <types><schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:t">',
  '    <element name="DoReq"/><element name="DoResp"/><element name="Session"/></schema></types>',
  '  <message name="In"><part name="a" element="x:DoReq"/></message>',
  '  <message name="Out"><part name="r" element="x:DoResp"/><part name="s" element="x:DoReq"/></message>',
  '  <message name="Hdr"><part name="session" element="x:Session"/></message>',
  '  <portType name="PT"><operation name="Do"><input message="tns:In"/><output message="tns:Out"/></operation></portType>',
  '  <binding name="B" type="tns:PT">',
  '    <soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="rpc"/>',
  '    <operation name="Do"><soap:operation soapAction="urn:do"/>',
  '      <input><soap:body use="literal" namespace="urn:m"/></input>',
  '      <output><soap:body use="literal" namespace="urn:m"/><soap:header message="tns:Hdr" part="session" use="literal"/></output>',
  '    </operation>',
  '  </binding>',
  '  <service name="S"><port name="P" binding="tns:B"><soap:address location="http://example.test/x"/></port></service>',
  '</definitions>'
].join('\n');

describe('SOAP output-header and rpc-order assertions (catalog additions)', () => {
  it('asserts declared output headers are present and rpc accessors keep part order', () => {
    const index = parseWsdl(WSDL);
    const collection = buildSoapCollection(index, {});
    const { collection: instrumented } = instrumentSoapCollection(collection, index);
    const scripts = JSON.stringify(instrumented);
    expect(scripts).toContain('Response carries the SOAP headers declared on the binding output');
    expect(scripts).toContain('declared output header ');
    expect(scripts).toContain('wsdl:part order of the output message');
  });
});

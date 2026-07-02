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

const WSDL20 = [
  '<description xmlns="http://www.w3.org/ns/wsdl" xmlns:tns="urn:w3" xmlns:x="urn:t3"',
  '    xmlns:wsoap="http://www.w3.org/ns/wsdl/soap" xmlns:wsam="http://www.w3.org/2007/05/addressing/metadata" targetNamespace="urn:w3">',
  '  <types><schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:t3">',
  '    <element name="Req"/><element name="Resp"/><element name="Sess"/><element name="ErrDetail"/></schema></types>',
  '  <interface name="I">',
  '    <fault name="F" element="x:ErrDetail"/>',
  '    <operation name="Do" pattern="http://www.w3.org/ns/wsdl/in-out" xmlns:wrpc="http://www.w3.org/ns/wsdl/rpc" wrpc:signature="x:Req #bogus">',
  '      <input element="x:Req" wsam:Action="urn:action-a"/>',
  '      <output element="x:Resp"/>',
  '      <outfault ref="tns:F"/>',
  '    </operation>',
  '  </interface>',
  '  <binding name="B" type="http://www.w3.org/ns/wsdl/soap" interface="tns:I" wsoap:protocol="http://www.w3.org/2003/05/soap/bindings/HTTP/">',
  '    <fault ref="tns:F" wsoap:code="x:BadInput"/>',
  '    <operation ref="tns:Do" wsoap:action="urn:action-b">',
  '      <output><wsoap:header element="x:Sess"/></output>',
  '    </operation>',
  '  </binding>',
  '  <service name="S" interface="tns:I"><endpoint name="E" binding="tns:B" address="http://e.test/"/></service>',
  '</description>'
].join('\n');

describe('WSDL 2.0 runtime wiring (catalog additions)', () => {
  it('flags wsam:Action vs wsoap:action disagreement', () => {
    const index = parseWsdl(WSDL20);
    const all = [...index.warnings, ...index.services.flatMap((s) => s.operations.flatMap((o) => o.warnings))].join('\n');
    expect(all).toContain('SOAP_WSDL20_ACTION_MISMATCH');
  });

  it('emits fault Detail, Subcode, and declared-output-header assertions', () => {
    const index = parseWsdl(WSDL20);
    const collection = buildSoapCollection(index, {});
    const { collection: instrumented } = instrumentSoapCollection(collection, index);
    const scripts = JSON.stringify(instrumented);
    expect(scripts).toContain('SOAP Fault Detail children match the declared interface faults');
    expect(scripts).toContain('SOAP Fault Subcode is declared by the binding');
    expect(scripts).toContain('Response carries the SOAP headers declared on the binding output');
  });
});

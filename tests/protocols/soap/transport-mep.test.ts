import { describe, expect, it } from 'vitest';

import { buildSoapCollection, instrumentSoapCollection, parseWsdl } from '../../../src/lib/protocols/soap/index.js';

const MEP = 'http://www.w3.org/2003/05/soap/mep/soap-response/';

const WSDL20 = [
  '<description xmlns="http://www.w3.org/ns/wsdl" xmlns:tns="urn:w4" xmlns:x="urn:t4"',
  '    xmlns:wsoap="http://www.w3.org/ns/wsdl/soap" xmlns:whttp="http://www.w3.org/ns/wsdl/http" targetNamespace="urn:w4">',
  '  <types><schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:t4">',
  '    <element name="Req"/><element name="Resp"/><element name="Req2"/><element name="Resp2"/></schema></types>',
  '  <interface name="I">',
  '    <operation name="Fetch" pattern="http://www.w3.org/ns/wsdl/in-out">',
  '      <input element="x:Req"/><output element="x:Resp"/>',
  '    </operation>',
  '    <operation name="Do2" pattern="http://www.w3.org/ns/wsdl/in-out">',
  '      <input element="x:Req2"/><output element="x:Resp2"/>',
  '    </operation>',
  '  </interface>',
  '  <binding name="B" type="http://www.w3.org/ns/wsdl/soap" interface="tns:I" wsoap:protocol="http://www.w3.org/2003/05/soap/bindings/HTTP/">',
  '    <operation ref="tns:Fetch" wsoap:mep="' + MEP + '">',
  '      <output><whttp:header name="X-Rate-Limit" required="true"/></output>',
  '    </operation>',
  '    <operation ref="tns:Do2"/>',
  '  </binding>',
  '  <service name="S" interface="tns:I"><endpoint name="E" binding="tns:B" address="http://e.test/"/></service>',
  '</description>'
].join('\n');

const WSDL11 = [
  '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"',
  '    xmlns:tns="urn:m5" xmlns:x="urn:t5" targetNamespace="urn:m5">',
  '  <types><schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:t5">',
  '    <element name="DoReq"/><element name="DoResp"/><element name="Session"/><element name="SessionFault"/></schema></types>',
  '  <message name="In"><part name="a" element="x:DoReq"/></message>',
  '  <message name="Out"><part name="r" element="x:DoResp"/></message>',
  '  <message name="Hdr"><part name="session" element="x:Session"/></message>',
  '  <message name="HdrF"><part name="fault" element="x:SessionFault"/></message>',
  '  <portType name="PT"><operation name="Do"><input message="tns:In"/><output message="tns:Out"/></operation></portType>',
  '  <binding name="B" type="tns:PT">',
  '    <soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="rpc"/>',
  '    <operation name="Do"><soap:operation soapAction="urn:do"/>',
  '      <input><soap:body use="encoded" namespace="urn:m5" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/></input>',
  '      <output><soap:body use="encoded" namespace="urn:m5" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/>',
  '        <soap:header message="tns:Hdr" part="session" use="literal"><soap:headerfault message="tns:HdrF" part="fault" use="literal"/></soap:header></output>',
  '    </operation>',
  '  </binding>',
  '  <service name="S"><port name="P" binding="tns:B"><soap:address location="http://example.test/x"/></port></service>',
  '</definitions>'
].join('\n');

interface TreeItem {
  name?: string;
  item?: TreeItem[];
  request?: { method?: string; body?: unknown };
  event?: Array<{ script?: { exec?: string[] } }>;
}

function findItem(node: TreeItem, name: string): TreeItem | undefined {
  if (node.name === name && node.request) return node;
  for (const child of node.item ?? []) {
    const hit = findItem(child, name);
    if (hit) return hit;
  }
  return undefined;
}

function scriptFor(instrumented: unknown, name: string): string {
  const item = findItem(instrumented as TreeItem, name);
  return (item?.event ?? []).map((e) => (e.script?.exec ?? []).join('\n')).join('\n');
}

describe('SOAP transport completions (soap_runtime_envelope_transport lane)', () => {
  it('binds SOAP-response MEP operations to GET with no envelope and checks required whttp headers', () => {
    const index = parseWsdl(WSDL20);
    const op = index.services[0].operations.find((o) => o.name === 'Fetch');
    expect(op?.soapMep).toBe(MEP);
    expect(op?.outputHttpHeaders).toEqual(['X-Rate-Limit']);
    const collection = buildSoapCollection(index, {});
    const { collection: instrumented } = instrumentSoapCollection(collection, index);
    const fetchItem = findItem(instrumented as TreeItem, 'Fetch');
    expect(fetchItem?.request?.method).toBe('GET');
    expect(fetchItem?.request?.body).toBeUndefined();
    const script = scriptFor(instrumented, 'Fetch');
    expect(script).toContain('SOAP-response MEP request is a plain HTTP GET');
    expect(script).not.toContain('SOAP request uses HTTP POST');
    expect(script).toContain('Required whttp:header fields are present on the response');
    expect(script).toContain('X-Rate-Limit');
  });

  it('rejects an empty Content-Type action parameter on ordinary SOAP 1.2 requests', () => {
    const index = parseWsdl(WSDL20);
    const collection = buildSoapCollection(index, {});
    const { collection: instrumented } = instrumentSoapCollection(collection, index);
    const script = scriptFor(instrumented, 'Do2');
    expect(script).toContain('the action media-type parameter must not be empty (RFC 3902)');
    expect(script).toContain('sit only on immediate Header children');
  });

  it('asserts headerfault placement and encoded encodingStyle agreement for WSDL 1.1', () => {
    const index = parseWsdl(WSDL11);
    const op = index.services[0].operations[0];
    expect(op.headerFaults).toEqual([{ element: 'SessionFault', namespace: 'urn:t5' }]);
    expect(op.encodingStyle).toBe('http://schemas.xmlsoap.org/soap/encoding/');
    const collection = buildSoapCollection(index, {});
    const { collection: instrumented } = instrumentSoapCollection(collection, index);
    const script = scriptFor(instrumented, 'Do');
    expect(script).toContain('Declared soap:headerfault blocks ride the SOAP Header');
    expect(script).toContain('Encoded response encodingStyle includes the WSDL-declared encoding');
  });
});

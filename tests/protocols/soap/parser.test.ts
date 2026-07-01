import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWsdl } from '../../../src/lib/protocols/soap/parser.js';

const here = dirname(fileURLToPath(import.meta.url));
const wsdl = readFileSync(resolve(here, '../../../fixtures/soap/stockquote.wsdl'), 'utf8');

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
});

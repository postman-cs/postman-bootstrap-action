import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWsdl } from '../../../src/lib/protocols/soap/parser.js';
import { buildSoapCollection, COLLECTION_V210_SCHEMA } from '../../../src/lib/protocols/soap/builder.js';

const here = dirname(fileURLToPath(import.meta.url));
const wsdl = readFileSync(resolve(here, '../../../fixtures/soap/stockquote.wsdl'), 'utf8');
const addressingWsdl = readFileSync(resolve(here, '../../../fixtures/soap/addressing.wsdl'), 'utf8');

type AnyRec = Record<string, unknown>;
function items(collection: AnyRec): AnyRec[] {
  const out: AnyRec[] = [];
  const walk = (node: AnyRec): void => {
    const children = (node.item as AnyRec[] | undefined) ?? [];
    if (children.length > 0) {
      for (const child of children) walk(child);
      return;
    }
    if (node.request) out.push(node);
  };
  walk(collection);
  return out;
}

function header(item: AnyRec, key: string): string | undefined {
  const headers = ((item.request as AnyRec).header as Array<{ key: string; value: string }>) ?? [];
  return headers.find((entry) => entry.key === key)?.value;
}

describe('buildSoapCollection', () => {
  it('emits a v2.1.0 collection with one http item per operation, raw XML body', () => {
    const index = parseWsdl(wsdl);
    const collection = buildSoapCollection(index, { schemaLocation: 'fixtures/soap/stockquote.wsdl' }) as AnyRec;
    expect(((collection.info as AnyRec).schema)).toBe(COLLECTION_V210_SCHEMA);
    const reqs = items(collection);
    expect(reqs).toHaveLength(2);
    const first = reqs[0]!;
    const request = first.request as AnyRec;
    expect(first.name).toBe('GetStockPrice');
    expect(request.method).toBe('POST');
    expect((request.url as AnyRec).raw).toBe('https://example.com/soap/stockquote');
    expect((request.body as AnyRec).mode).toBe('raw');
    expect((request.body as AnyRec).raw).toMatch(/<soap:Envelope/);
    expect(((request.body as AnyRec).options as AnyRec).raw).toEqual({ language: 'xml' });
    expect(header(first, 'Content-Type')).toBe('text/xml; charset=UTF-8');
    expect(header(first, 'SOAPAction')).toBe('"http://example.com/stockquote/GetStockPrice"');
    expect((request.auth as AnyRec).type).toBe('noauth');
    expect(typeof first.id).toBe('string');
    expect(first.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('groups operations into a folder per service', () => {
    const index = parseWsdl(wsdl);
    const collection = buildSoapCollection(index) as AnyRec;
    const folders = (collection.item as AnyRec[]);
    expect(folders.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray((folders[0]! as AnyRec).item)).toBe(true);
  });

  it('is deterministic across builds (same ids, same bytes)', () => {
    const index = parseWsdl(wsdl);
    const a = JSON.stringify(buildSoapCollection(index, { schemaLocation: 'x.wsdl' }));
    const b = JSON.stringify(buildSoapCollection(index, { schemaLocation: 'x.wsdl' }));
    expect(a).toBe(b);
  });

  it('uses a baseUrl placeholder when the WSDL has no endpoint', () => {
    const noEndpoint = wsdl.replace(/<soap:address[^>]*\/>/, '');
    const index = parseWsdl(noEndpoint);
    const collection = buildSoapCollection(index) as AnyRec;
    expect(((items(collection)[0]!.request as AnyRec).url as AnyRec).raw).toBe('{{baseUrl}}');
  });

  it('builds a 1.2 Content-Type with action parameter for SOAP 1.2', () => {
    const soap12 = wsdl
      .replace('xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"', 'xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap12/"');
    const index = parseWsdl(soap12);
    const first = items(buildSoapCollection(index) as AnyRec)[0]!;
    expect(String(header(first, 'Content-Type'))).toMatch(/application\/soap\+xml/);
    expect(String(header(first, 'Content-Type'))).toMatch(/action="http:\/\/example.com\/stockquote\/GetStockPrice"/);
    expect(header(first, 'SOAPAction')).toBeUndefined();
  });

  it('injects wsa:Action, wsa:MessageID and anonymous wsa:ReplyTo when addressing is engaged', () => {
    const index = parseWsdl(addressingWsdl);
    const first = items(buildSoapCollection(index) as AnyRec)[0]!;
    const raw = String(((first.request as AnyRec).body as AnyRec).raw);
    expect(raw).toContain('xmlns:wsa="http://www.w3.org/2005/08/addressing"');
    expect(raw).toContain('<wsa:Action>http://example.com/quote/GetQuote</wsa:Action>');
    expect(raw).toContain('<wsa:MessageID>urn:uuid:{{$guid}}</wsa:MessageID>');
    expect(raw).toContain('<wsa:Address>http://www.w3.org/2005/08/addressing/anonymous</wsa:Address>');
  });

  it('derives the request action from the WSDL default pattern when none is declared', () => {
    const index = parseWsdl(addressingWsdl);
    const listQuotes = items(buildSoapCollection(index) as AnyRec).find((item) => item.name === 'ListQuotes')!;
    const raw = String(((listQuotes.request as AnyRec).body as AnyRec).raw);
    expect(raw).toContain('<wsa:Action>http://example.com/quote/QuotePort/ListQuotesRequest</wsa:Action>');
  });

  it('emits no wsa headers when the WSDL does not engage addressing', () => {
    const index = parseWsdl(wsdl);
    const raw = String(((items(buildSoapCollection(index) as AnyRec)[0]!.request as AnyRec).body as AnyRec).raw);
    expect(raw).not.toContain('wsa:');
    expect(raw).toContain('<soap:Header/>');
  });
});

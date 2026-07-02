import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWsdl } from '../../../src/lib/protocols/soap/parser.js';
import { buildSoapCollection } from '../../../src/lib/protocols/soap/builder.js';
import { createSoapScript, instrumentSoapCollection } from '../../../src/lib/protocols/soap/instrumenter.js';

const here = dirname(fileURLToPath(import.meta.url));
const wsdl = readFileSync(resolve(here, '../../../fixtures/soap/stockquote.wsdl'), 'utf8');

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

function scriptCode(item: AnyRec): string {
  const events = (item.event as AnyRec[]) ?? [];
  const after = events.find((e) => e.listen === 'test');
  const exec = (after?.script as AnyRec | undefined)?.exec;
  return Array.isArray(exec) ? exec.join('\n') : String(exec ?? '');
}

describe('instrumentSoapCollection', () => {
  it('injects a test script with the required SOAP assertions', () => {
    const index = parseWsdl(wsdl);
    const built = buildSoapCollection(index);
    const { collection } = instrumentSoapCollection(built, index);
    const code = scriptCode(items(collection)[0]!);
    expect(code).toContain("pm.response.to.have.status(200)");
    expect(code).toContain('SOAP response Content-Type matches the SOAP 1.1 binding');
    expect(code).toContain('to.include("text/xml")');
    expect(code).toContain('matchTag("Envelope")');
    expect(code).toContain('matchTag("Body")');
    expect(code).toContain('matchTag("Fault")');
    expect(code).toContain('SOAP Fault returned for operation');
    expect(code).toContain('GetStockPriceResponse');
  });

  it('attaches the script as a v2 test event and keeps it valid JS', () => {
    const index = parseWsdl(wsdl);
    const { collection } = instrumentSoapCollection(buildSoapCollection(index), index);
    const events = (items(collection)[0]!.event as AnyRec[]) ?? [];
    const after = events.find((e) => e.listen === 'test')!;
    expect((after.script as AnyRec).type).toBe('text/javascript');
    expect(() => new Function('pm', scriptCode(items(collection)[0]!))).not.toThrow();
  });

  it('warns SOAP_ITEM_UNMATCHED for a request with no matching operation', () => {
    const index = parseWsdl(wsdl);
    const built = buildSoapCollection(index) as AnyRec;
    const folder = (built.item as AnyRec[])[0]!;
    folder.item = [
      ...(folder.item as AnyRec[]),
      { name: 'Ghost', request: { method: 'POST', body: { mode: 'raw', raw: '' } }, event: [] }
    ];
    const { warnings } = instrumentSoapCollection(built, index);
    expect(warnings.join('\n')).toMatch(/SOAP_ITEM_UNMATCHED: request "Ghost"/);
  });

  it('warns when an output message has no resolvable response element', () => {
    const index = parseWsdl(wsdl);
    // Strip the element ref off the output message part so resolution fails.
    index.services[0]!.operations[0]!.expectedResponseElement = undefined;
    index.services[0]!.operations[0]!.output = { name: 'Out', parts: [{ name: 'p' }] };
    const built = buildSoapCollection(index);
    const { warnings } = instrumentSoapCollection(built, index);
    expect(warnings.join('\n')).toMatch(/SOAP_RESPONSE_ELEMENT_UNKNOWN/);
  });

  it('asserts application/soap+xml for a SOAP 1.2 operation (RFC 3902)', () => {
    const code = createSoapScript({ name: 'GetLastTradePrice', soapAction: 'urn:GetLastTradePrice', soapVersion: '1.2', warnings: [] });
    expect(code).toContain('SOAP response Content-Type matches the SOAP 1.2 binding');
    expect(code).toContain('to.include("application/soap+xml")');
    expect(code).not.toContain('to.include("text/xml")');
  });

  it('golden snapshot: generated assertions for the stockquote service', () => {
    const index = parseWsdl(wsdl);
    const { collection, warnings } = instrumentSoapCollection(buildSoapCollection(index), index);
    const golden = items(collection).map((item) => ({ name: item.name, code: scriptCode(item) }));
    expect({ golden, warnings }).toMatchSnapshot();
  });
});

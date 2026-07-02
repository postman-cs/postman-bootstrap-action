import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWsdl } from '../../../src/lib/protocols/soap/parser.js';
import { buildSoapCollection } from '../../../src/lib/protocols/soap/builder.js';
import { createSoapScript, instrumentSoapCollection } from '../../../src/lib/protocols/soap/instrumenter.js';

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

  it('emits WS-Addressing response assertions when the WSDL engages addressing', () => {
    const index = parseWsdl(addressingWsdl);
    const { collection } = instrumentSoapCollection(buildSoapCollection(index), index);
    const code = scriptCode(items(collection)[0]!);
    expect(code).toContain('WS-Addressing response headers are present');
    expect(code).toContain('wsa:Action matches the WSDL output action');
    expect(code).toContain('wsa:RelatesTo echoes the request wsa:MessageID');
    expect(code).toContain('wsaAction');
    expect(code).toContain('http://example.com/quote/GetQuoteReply');
    expect(() => new Function('pm', code)).not.toThrow();
  });

  it('derives the reply action from the WSDL default pattern when none is declared', () => {
    const index = parseWsdl(addressingWsdl);
    const { collection } = instrumentSoapCollection(buildSoapCollection(index), index);
    const listQuotes = items(collection).find((item) => item.name === 'ListQuotes')!;
    expect(scriptCode(listQuotes)).toContain('http://example.com/quote/QuotePort/ListQuotesResponse');
  });

  it('omits WS-Addressing assertions when the WSDL does not engage addressing', () => {
    const index = parseWsdl(wsdl);
    const { collection } = instrumentSoapCollection(buildSoapCollection(index), index);
    expect(scriptCode(items(collection)[0]!)).not.toContain('WS-Addressing');
  });

  it('warns SOAP_ADDRESSING_ACTION_UNDERIVABLE when no output action is derivable', () => {
    const warnings: string[] = [];
    const code = createSoapScript(
      { name: 'Op', soapAction: '', soapVersion: '1.1', warnings: [], input: { name: 'In', parts: [] }, output: { name: 'Out', parts: [] } },
      warnings,
      { declaresAddressing: true }
    );
    expect(warnings.join('\n')).toMatch(/SOAP_ADDRESSING_ACTION_UNDERIVABLE/);
    expect(code).toContain('WS-Addressing response headers are present');
    expect(code).not.toContain('wsa:Action matches the WSDL output action');
  });

  it('golden snapshot: generated assertions for the stockquote service', () => {
    const index = parseWsdl(wsdl);
    const { collection, warnings } = instrumentSoapCollection(buildSoapCollection(index), index);
    const golden = items(collection).map((item) => ({ name: item.name, code: scriptCode(item) }));
    expect({ golden, warnings }).toMatchSnapshot();
  });
});

// Execute a generated SOAP script in a VM against a mock pm to prove the fault
// and serialization checks accept/reject real envelopes, not merely that their
// source text is present (mirrors the gRPC instrumenter test harness).
import { Script, createContext } from 'node:vm';

interface SoapRunResult { name: string; passed: boolean; error?: string }

function runSoapScript(source: string, body: string, headers: Record<string, string>, code = 200): SoapRunResult[] {
  const results: SoapRunResult[] = [];
  const expectFn = ((actual: unknown, msg?: string) => ({
    to: {
      eql: (exp: unknown): void => { if (actual !== exp) throw new Error(msg ?? 'expected eql'); },
      include: (part: string): void => { if (typeof actual !== 'string' || !actual.includes(part)) throw new Error(msg ?? 'expected include'); },
      match: (re: RegExp): void => { if (typeof actual !== 'string' || !re.test(actual)) throw new Error(msg ?? 'expected match'); },
      be: { an: (t: string): void => { if (typeof actual !== t) throw new Error(msg ?? 'expected ' + t); } },
      have: { property: (p: string): void => { if (!actual || typeof actual !== 'object' || !(p in (actual as object))) throw new Error(msg ?? 'expected property'); } }
    }
  })) as ((actual: unknown, msg?: string) => unknown) & { fail: (m?: string) => never };
  expectFn.fail = (m?: string): never => { throw new Error(m ?? 'pm.expect.fail'); };
  const lookup = (bag: Record<string, string>) => (name: string): string | null => {
    const hit = Object.keys(bag).find((key) => key.toLowerCase() === name.toLowerCase());
    return hit === undefined ? null : bag[hit];
  };
  const pm = {
    request: {
      method: 'POST',
      headers: { get: lookup({ SOAPAction: '""', 'Content-Type': 'text/xml; charset=UTF-8' }) },
      body: { raw: '' }
    },
    response: {
      code,
      text: (): string => body,
      headers: { get: lookup(headers) },
      to: { have: { status: (status: number): void => { if (code !== status) throw new Error('expected HTTP ' + status + ' but got ' + code); } } }
    },
    expect: expectFn,
    test: (name: string, fn: () => void): void => {
      try { fn(); results.push({ name, passed: true }); }
      catch (error) { results.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) }); }
    }
  };
  new Script(source).runInContext(createContext({ pm, JSON, RegExp, String, Array, Object, Number, Math }));
  return results;
}

describe('SOAP fault and serialization runtime semantics', () => {
  const index = parseWsdl(wsdl);
  const { collection } = instrumentSoapCollection(buildSoapCollection(index), index);
  const script11 = scriptCode(items(collection)[0]!);
  const ct11 = { 'Content-Type': 'text/xml; charset=UTF-8' };
  const envelope11 = (kids: string) => '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' + kids + '</soap:Body></soap:Envelope>';
  const fault11 = (kids: string) => envelope11('<soap:Fault>' + kids + '</soap:Fault>');
  const named = (results: SoapRunResult[], prefix: string) => results.find((entry) => entry.name.startsWith(prefix));

  it('requires a Fault to be the sole direct child of Body', () => {
    const sole = 'A SOAP Fault is the only child of the SOAP Body';
    expect(named(runSoapScript(script11, fault11('<faultcode>soap:Server</faultcode><faultstring>x</faultstring>'), ct11, 500), sole)?.passed).toBe(true);
    expect(named(runSoapScript(script11, envelope11('<soap:Fault><faultcode>c</faultcode><faultstring>x</faultstring></soap:Fault><Extra/>'), ct11, 500), sole)?.passed).toBe(false);
  });

  it('enforces the closed unqualified SOAP 1.1 fault child set and lowercase detail', () => {
    const closed = 'SOAP 1.1 Fault children are the closed unqualified set';
    expect(named(runSoapScript(script11, fault11('<faultcode>soap:Server</faultcode><faultstring>x</faultstring><detail/>'), ct11, 500), closed)?.passed).toBe(true);
    expect(named(runSoapScript(script11, fault11('<faultcode>c</faultcode><faultstring>x</faultstring><Extra/>'), ct11, 500), closed)?.passed).toBe(false);
    expect(named(runSoapScript(script11, fault11('<soap:faultcode>c</soap:faultcode>'), ct11, 500), closed)?.passed).toBe(false);
    expect(named(runSoapScript(script11, fault11('<faultcode>c</faultcode><faultstring>x</faultstring><Detail/>'), ct11, 500), closed)?.passed).toBe(false);
  });

  it('pins response charset and XML declaration to UTF-8/UTF-16 and agreement', () => {
    const serial = 'SOAP response charset and XML declaration';
    const okBody = envelope11('<GetStockPriceResponse xmlns="http://example.com/stock"><Price>1</Price></GetStockPriceResponse>');
    expect(named(runSoapScript(script11, okBody, ct11), serial)?.passed).toBe(true);
    expect(named(runSoapScript(script11, okBody, { 'Content-Type': 'text/xml; charset=ISO-8859-1' }), serial)?.passed).toBe(false);
    const utf16Decl = '<?xml version="1.0" encoding="utf-16"?>' + okBody.slice(okBody.indexOf('?>') + 2);
    expect(named(runSoapScript(script11, utf16Decl, ct11), serial)?.passed).toBe(false);
  });

  it('enforces SOAP 1.2 fault child order, closed set, and capital Detail', () => {
    const script12 = createSoapScript({ name: 'Ping', soapAction: '', soapVersion: '1.2', warnings: [], input: { name: 'In', parts: [] }, output: { name: 'Out', parts: [] } });
    const ct12 = { 'Content-Type': 'application/soap+xml; charset=UTF-8' };
    const envelope12 = (kids: string) => '<?xml version="1.0" encoding="utf-8"?><env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body>' + kids + '</env:Body></env:Envelope>';
    const fault12 = (kids: string) => envelope12('<env:Fault>' + kids + '</env:Fault>');
    const ordered = 'SOAP 1.2 Fault children are the defined set in schema order';
    const code = '<env:Code><env:Value>env:Receiver</env:Value></env:Code>';
    const reason = '<env:Reason><env:Text xml:lang="en">x</env:Text></env:Reason>';
    expect(named(runSoapScript(script12, fault12(code + reason + '<env:Detail/>'), ct12, 500), ordered)?.passed).toBe(true);
    expect(named(runSoapScript(script12, fault12(reason + code), ct12, 500), ordered)?.passed).toBe(false);
    expect(named(runSoapScript(script12, fault12(code + reason + '<env:detail/>'), ct12, 500), ordered)?.passed).toBe(false);
    expect(named(runSoapScript(script12, fault12(code + reason + '<env:Bogus/>'), ct12, 500), ordered)?.passed).toBe(false);
  });
});

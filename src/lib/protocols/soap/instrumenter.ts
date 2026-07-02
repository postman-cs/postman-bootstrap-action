import { SOAP12_UNSUPPORTED_MEDIA_PROBE_NAME } from './builder.js';
import { defaultActionIri, localName, type SoapContractIndex, type SoapOperation } from './parser.js';

type JsonRecord = Record<string, unknown>;

export interface SoapInstrumentationResult {
  collection: JsonRecord;
  warnings: string[];
}

export interface SoapScript {
  type: 'afterResponse';
  code: string;
  language: 'text/javascript';
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The afterResponse code runs inside the runtime sandbox where pm.response.xml()
 * is not guaranteed (PROJECTED in recon). We assert structurally on the raw XML
 * text with namespace-agnostic regexes so the tests run on the existing HTTP
 * path without an XML parser dependency in the sandbox. Element-presence checks
 * match `<prefix:Local` or `<Local` ignoring namespace prefixes.
 */
function elementPresenceRegex(local: string): string {
  // Escape for embedding in a JS RegExp literal built from a string.
  const escaped = local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(?:^|<)(?:[A-Za-z_][\\w.-]*:)?${escaped}(?=[\\s/>])`;
}

/**
 * Shared sandbox helpers for the structural XML checks. `elementInner` and
 * `directChildNames` are regex tokenizers, not an XML parser: attribute values
 * containing ">" and same-name nesting are out of scope (consistent with the
 * module-wide raw-text assertion strategy).
 */
export interface SoapScriptOptions {
  /** True when the WSDL engages WS-Addressing (index.declaresAddressing). */
  declaresAddressing?: boolean;
  /** WSDL targetNamespace, used to derive the defaulted wsa:Action IRI. */
  targetNamespace?: string;
}

const XML_HELPER_LINES: string[] = [
  'var cleanXml = bodyText.replace(/<!--[\\s\\S]*?-->/g, "").replace(/<!\\[CDATA\\[[\\s\\S]*?\\]\\]>/g, "");',
  'function localPart(name) { var i = name.indexOf(":"); return i === -1 ? name : name.slice(i + 1); }',
  'function elementInner(xml, local) {',
  '  var open = xml.match(new RegExp("<(?:[A-Za-z_][\\\\w.-]*:)?" + local + "(?=[\\\\s/>])[^>]*>"));',
  '  if (!open) return null;',
  '  if (/\\/>$/.test(open[0])) return "";',
  '  var start = open.index + open[0].length;',
  '  var rest = xml.slice(start);',
  '  var close = rest.search(new RegExp("</(?:[A-Za-z_][\\\\w.-]*:)?" + local + "\\\\s*>"));',
  '  return close === -1 ? null : rest.slice(0, close);',
  '}',
  'function directChildNames(inner) {',
  '  var names = []; var depth = 0; var m;',
  '  var re = /<(\\/?)([A-Za-z_][\\w.-]*(?::[A-Za-z_][\\w.-]*)?)([^>]*?)(\\/?)>/g;',
  '  while ((m = re.exec(inner))) {',
  '    if (m[1]) { depth -= 1; continue; }',
  '    if (depth === 0) names.push(m[2]);',
  '    if (!m[4]) depth += 1;',
  '  }',
  '  return names;',
  '}'
];

/**
 * HTTP 405/Allow conditional check (SOAP 1.2 Part 2 section 7 binds SOAP to
 * POST; RFC 9110 section 10.2.1 requires Allow on 405). Emitted on every path.
 */
const ALLOW_405_LINES: string[] = [
  '',
  "pm.test('HTTP 405 responses advertise POST via the Allow header (SOAP 1.2 Part 2 section 7 / RFC 9110)', function () {",
  '  if (pm.response.code !== 405) return;',
  '  var allow = header("Allow").toUpperCase();',
  '  if (allow.indexOf("POST") === -1) pm.expect.fail("a 405 from a SOAP endpoint must carry an Allow header listing POST (SOAP 1.2 Part 2 section 7 / RFC 9110 section 10.2.1); got Allow: " + (allow || "<missing>"));',
  '});'
];

/**
 * One-way (input-only) operations: WS-I Basic Profile 1.1 R2714 forbids a SOAP
 * envelope in the response, and the SOAP 1.2 HTTP binding (Part 2 section 6.3)
 * responds 200/202/204. These replace the request-response envelope checks.
 */

function jsString(value: string): string {
  return JSON.stringify(value);
}

// Request-side transport discipline (WS-I BP 1.1 section 3; RFC 3902). These
// reference only pm.request, so both one-way and request-response scripts can
// carry them.
function requestDisciplineLines(operation: SoapOperation): string[] {
  const lines: string[] = [
    '',
    "pm.test('SOAP request uses HTTP POST (WS-I Basic Profile 1.1 R1141)', function () {",
    '  pm.expect(pm.request.method, "SOAP over HTTP binds operations to POST").to.eql("POST");',
    '});'
  ];
  if (operation.soapVersion === '1.1') {
    lines.push(
      '',
      "pm.test('SOAPAction request header is present and quoted (WS-I Basic Profile 1.1 R2744/R2745)', function () {",
      '  var sa = pm.request.headers.get("SOAPAction");',
      '  if (sa === null || sa === undefined) { pm.expect.fail("SOAP 1.1 HTTP requests carry a SOAPAction header, quoted, even when empty"); return; }',
      '  if (!/^"[\\s\\S]*"$/.test(sa)) pm.expect.fail("SOAPAction must be quoted on the wire (got: " + sa + ")");',
      '  if (sa.slice(1, -1) !== ' + jsString(operation.soapAction) + ') pm.expect.fail("SOAPAction " + sa + " does not match the WSDL soapAction value");',
      '});'
    );
  } else {
    lines.push(
      '',
      "pm.test('SOAP 1.2 request media type is application/soap+xml (RFC 3902)', function () {",
      '  var ct = String(pm.request.headers.get("Content-Type") || "");',
      '  pm.expect(ct.toLowerCase(), "SOAP 1.2 requests use application/soap+xml").to.include("application/soap+xml");',
      '  var action = /action="([^"]*)"/.exec(ct);',
      '  if (action && action[1] && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(action[1])) pm.expect.fail("the action media-type parameter must be an absolute URI (RFC 3902); got " + action[1]);',
      operation.soapAction
        ? '  if (action && action[1] !== ' + jsString(operation.soapAction) + ') pm.expect.fail("the action parameter " + action[1] + " does not match the WSDL soapAction value");'
        : '',
      '});',
      '',
      "pm.test('SOAP 1.2 request Accept header, when present, admits application/soap+xml (SOAP 1.2 Part 2 section 7)', function () {",
      '  var accept = String(pm.request.headers.get("Accept") || "");',
      '  if (!accept) return;',
      '  if (accept.indexOf("application/soap+xml") === -1 && accept.indexOf("*/*") === -1 && accept.indexOf("application/*") === -1) pm.expect.fail("Accept " + accept + " excludes application/soap+xml, the SOAP 1.2 response media type");',
      '});'
    );
  }
  return lines.filter((line, i, all) => line !== '' || all[i - 1] !== '');
}

// Response-envelope conformance derived from the WSDL: XML hygiene, Body
// shape, attribute lexical rules, and rpc-literal wrapper/accessor structure.
// Relies on the helpers defined earlier in the generated script (bodyText,
// cleanXml, elementInner, directChildNames, localPart).
function deepConformanceLines(operation: SoapOperation): string[] {
  const is12 = operation.soapVersion === '1.2';
  const lines: string[] = [
    '',
    "pm.test('SOAP response contains no DTD or processing instruction (WS-I Basic Profile 1.1 R1008/R1009)', function () {",
    '  if (!bodyText.trim()) return;',
    '  if (/<!DOCTYPE/i.test(bodyText)) pm.expect.fail("SOAP messages must not contain a Document Type Declaration");',
    '  if (/<\\?(?!xml[\\s?])/i.test(bodyText)) pm.expect.fail("SOAP messages must not contain processing instructions");',
    '});',
    '',
    "pm.test('No element trailers follow the SOAP Body (WS-I Basic Profile 1.1 R1011)', function () {",
    '  var m = /<\\/(?:[A-Za-z_][\\w.-]*:)?Body\\s*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?Envelope\\s*>/.exec(cleanXml);',
    '  if (m && /<[A-Za-z_]/.test(m[1])) pm.expect.fail("the SOAP Envelope must not contain element children after soap:Body");',
    '});',
    '',
    "pm.test('SOAP Body has at most one direct child element (WS-I Basic Profile 1.1 R2201)', function () {",
    '  var inner = elementInner(cleanXml, "Body");',
    '  if (inner === null) return;',
    '  var kids = directChildNames(inner);',
    '  if (kids.length > 1) pm.expect.fail("the response soap:Body carries " + kids.length + " direct children (" + kids.join(", ") + "); literal responses bind at most one body element");',
    '});',
    '',
    "pm.test('HTTP 202 responses carry no SOAP envelope (SOAP 1.2 Part 2 section 6.3)', function () {",
    '  if (pm.response.code !== 202) return;',
    '  if (/<(?:[A-Za-z_][\\w.-]*:)?Envelope[\\s/>]/.test(bodyText)) pm.expect.fail("a 202 acceptance acknowledgement must not carry a SOAP envelope");',
    '});',
    ''
  ];
  if (is12) {
    lines.push(
      "pm.test('env:mustUnderstand and env:relay values are xs:boolean (SOAP 1.2 Part 1 section 5.2.3)', function () {",
      '  var re = /(?:mustUnderstand|relay)\\s*=\\s*["\']([^"\']*)["\']/g; var m;',
      '  while ((m = re.exec(cleanXml))) { if (["0", "1", "true", "false"].indexOf(m[1]) === -1) pm.expect.fail("mustUnderstand/relay must be an xs:boolean (got " + m[1] + ")"); }',
      '});'
    );
  } else {
    lines.push(
      "pm.test('soap:mustUnderstand values use only 0 or 1 (SOAP 1.1 section 4.2.3 / WS-I Basic Profile 1.1 R1013)', function () {",
      '  var re = /mustUnderstand\\s*=\\s*["\']([^"\']*)["\']/g; var m;',
      '  while ((m = re.exec(cleanXml))) { if (m[1] !== "0" && m[1] !== "1") pm.expect.fail("mustUnderstand must be exactly 0 or 1 (got " + m[1] + ")"); }',
      '});'
    );
  }
  lines.push(
    '',
    "pm.test('SOAP Header children are namespace-qualified (WS-I Basic Profile 1.1 R1027)', function () {",
    '  var inner = elementInner(cleanXml, "Header");',
    '  if (!inner || !inner.trim()) return;',
    '  if (inner.indexOf("xmlns=") !== -1) return;',
    '  var kids = directChildNames(inner);',
    '  for (var i = 0; i < kids.length; i++) { if (kids[i].indexOf(":") === -1) pm.expect.fail("header block " + kids[i] + " is unqualified; SOAP header blocks must be namespace-qualified"); }',
    '});',
    '',
    is12
      ? "pm.test('SOAP role attributes are URIs or predefined roles (SOAP 1.2 Part 1 section 5.2.2)', function () {"
      : "pm.test('SOAP actor attributes are URIs (SOAP 1.1 section 4.2.2)', function () {",
    '  var re = /(?:actor|role)\\s*=\\s*["\']([^"\']*)["\']/g; var m;',
    '  while ((m = re.exec(cleanXml))) {',
    '    var v = m[1];',
    is12
      ? '    if (/^http:\\/\\/www\\.w3\\.org\\/2003\\/05\\/soap-envelope\\/role\\/(next|none|ultimateReceiver)$/.test(v)) continue;'
      : '    if (v === "http://schemas.xmlsoap.org/soap/actor/next") continue;',
    '    if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(v)) pm.expect.fail("actor/role value " + v + " is not an absolute URI");',
    '  }',
    '});'
  );
  if (operation.use !== 'encoded') {
    lines.push(
      '',
      "pm.test('Literal response carries no encodingStyle on SOAP structural elements (WS-I Basic Profile 1.1 R1005 / SOAP 1.2 Part 1 section 5.1.1)', function () {",
      '  if (cleanXml.indexOf("encodingStyle") === -1) return;',
      '  var core = cleanXml.match(/<(?:[A-Za-z_][\\w.-]*:)?(?:Envelope|Header|Body|Fault)[^>]*>/g) || [];',
      '  for (var i = 0; i < core.length; i++) { if (core[i].indexOf("encodingStyle") !== -1) pm.expect.fail("encodingStyle must not appear on " + core[i].replace(/[<>]/g, "").split(/\\s/)[0]); }',
      is12
        ? '  var re = /encodingStyle\\s*=\\s*["\']([^"\']*)["\']/g; var m; while ((m = re.exec(cleanXml))) { if (/\\s/.test(m[1].trim())) pm.expect.fail("SOAP 1.2 encodingStyle is a single xs:anyURI value (got " + m[1] + ")"); }'
        : '  var re = /encodingStyle\\s*=\\s*["\']([^"\']*)["\']/g; var m; while ((m = re.exec(cleanXml))) { var toks = m[1].split(/\\s+/).filter(Boolean); for (var j = 0; j < toks.length; j++) { if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(toks[j])) pm.expect.fail("encodingStyle token " + toks[j] + " is not an absolute URI"); } }',
      '});'
    );
  }
  if (operation.style !== 'rpc' && operation.expectedResponseElement) {
    lines.push(
      '',
      "pm.test('Expected response element is the direct child of soap:Body (WS-I Basic Profile 1.1 R2201)', function () {",
      '  var inner = elementInner(cleanXml, "Body");',
      '  if (inner === null) return;',
      '  var kids = directChildNames(inner);',
      '  if (kids.length === 0) return;',
      '  if (kids.some(function (k) { return localPart(k) === "Fault"; })) return;',
      '  if (!kids.some(function (k) { return localPart(k) === ' + jsString(operation.expectedResponseElement) + '; })) pm.expect.fail("the WSDL output element " + ' + jsString(operation.expectedResponseElement) + ' + " must be the direct child of soap:Body (got: " + kids.join(", ") + ")");',
      '});'
    );
    if (operation.expectedResponseNamespace) {
      const escaped = operation.expectedResponseElement.replace(/[.*+?^$()|[\]{}\\]/g, '\\function createOneWayScript');
      lines.push(
        '',
        "pm.test('Response element namespace matches the WSDL schema declaration (WS-I Basic Profile 1.1 R2712)', function () {",
        '  var open = cleanXml.match(new RegExp("<([A-Za-z_][\\\\w.-]*):' + escaped + '[\\\\s/>]"));',
        '  if (!open) return;',
        '  var decl = new RegExp("xmlns:" + open[1] + "\\\\s*=\\\\s*[\\"\']([^\\"\']*)[\\"\']").exec(cleanXml);',
        '  if (decl && decl[1] !== ' + jsString(operation.expectedResponseNamespace) + ') pm.expect.fail("response element is bound to namespace " + decl[1] + " but the WSDL schema declares " + ' + jsString(operation.expectedResponseNamespace) + ');',
        '});'
      );
    }
  }
  if (operation.outputBodyPartCount === 0) {
    lines.push(
      '',
      "pm.test('Zero-part document-literal response Body is empty (WS-I Basic Profile 1.1 R2201)', function () {",
      '  var inner = elementInner(cleanXml, "Body");',
      '  if (inner === null) return;',
      '  if (directChildNames(inner).some(function (k) { return localPart(k) !== "Fault"; })) pm.expect.fail("the WSDL binds zero body parts; the response soap:Body must be empty");',
      '});'
    );
  }
  if (operation.style === 'rpc' && operation.use !== 'encoded' && operation.output) {
    const wrapper = operation.name + 'Response';
    const partNames = operation.output.parts.map((p) => p.name);
    lines.push(
      '',
      "pm.test('RPC-literal response wrapper and part accessors follow WS-I Basic Profile 1.1 (R2729/R2735)', function () {",
      '  var inner = elementInner(cleanXml, "Body");',
      '  if (inner === null) return;',
      '  var kids = directChildNames(inner);',
      '  if (kids.length === 0 || kids.some(function (k) { return localPart(k) === "Fault"; })) return;',
      '  if (localPart(kids[0]) !== ' + jsString(wrapper) + ') pm.expect.fail("rpc-literal response wrappers are named <operation>Response (expected " + ' + jsString(wrapper) + ' + ", got " + kids[0] + ")");',
      '  var wrapInner = elementInner(inner, ' + jsString(wrapper) + ');',
      '  if (wrapInner === null) return;',
      '  var accessors = directChildNames(wrapInner);',
      '  for (var i = 0; i < accessors.length; i++) { if (accessors[i].indexOf(":") !== -1) pm.expect.fail("rpc-literal part accessor " + accessors[i] + " must be unqualified (WS-I Basic Profile 1.1 R2735)"); }',
      '  var declared = ' + JSON.stringify(partNames) + ';',
      '  if (declared.length > 0) { for (var j = 0; j < accessors.length; j++) { if (declared.indexOf(localPart(accessors[j])) === -1) pm.expect.fail("accessor " + accessors[j] + " matches no wsdl:part of the output message"); } }',
      '  if (/xsi:nil\\s*=\\s*["\'](?:1|true)["\']/.test(wrapInner)) pm.expect.fail("rpc-literal part accessors must not carry xsi:nil (WS-I Basic Profile 1.1)");',
      '});'
    );
  } else if (operation.style !== 'rpc') {
    lines.push(
      '',
      "pm.test('SOAP Body children are namespace-qualified (WS-I Basic Profile 1.1 R1014)', function () {",
      '  var inner = elementInner(cleanXml, "Body");',
      '  if (!inner || !inner.trim()) return;',
      '  if (inner.indexOf("xmlns=") !== -1) return;',
      '  var kids = directChildNames(inner);',
      '  for (var i = 0; i < kids.length; i++) { if (kids[i].indexOf(":") === -1) pm.expect.fail("Body child " + kids[i] + " is unqualified; literal body elements come from a schema targetNamespace"); }',
      '});'
    );
  }
  if (is12) {
    lines.push(
      '',
      "pm.test('MustUnderstand/VersionMismatch fault diagnostics are well-formed (SOAP 1.2 Part 1 section 5.4.8)', function () {",
      '  if (cleanXml.indexOf("MustUnderstand") !== -1) {',
      '    var re = /<(?:[A-Za-z_][\\w.-]*:)?NotUnderstood\\b([^>]*)>/g; var m;',
      '    while ((m = re.exec(cleanXml))) { if (m[1].indexOf("qname") === -1) pm.expect.fail("NotUnderstood header blocks must carry a qname attribute"); }',
      '  }',
      '  if (cleanXml.indexOf("VersionMismatch") !== -1 && /<(?:[A-Za-z_][\\w.-]*:)?Upgrade[\\s/>]/.test(cleanXml)) {',
      '    if (!/<(?:[A-Za-z_][\\w.-]*:)?SupportedEnvelope[\\s/>]/.test(cleanXml)) pm.expect.fail("an Upgrade header block must list SupportedEnvelope entries");',
      '  }',
      '});'
    );
  }
  return lines;
}

function createOneWayScript(operation: SoapOperation): string {
  const meta = { name: operation.name, soapVersion: operation.soapVersion, oneWay: true };
  const lines: string[] = [
    `var soap = JSON.parse(${JSON.stringify(JSON.stringify(meta))});`,
    'var bodyText = (pm.response.text && pm.response.text()) || "";',
    'function header(name) { return (pm.response.headers.get(name) || ""); }',
    '',
    "pm.test('One-way SOAP response body is empty (WS-I BP 1.1 R2714)', function () {",
    '  if (bodyText.replace(/\\s+/g, "") !== "") pm.expect.fail("a one-way operation response MUST NOT carry a SOAP envelope; the HTTP entity body must be empty (WS-I Basic Profile 1.1 R2714)");',
    '});',
    '',
    "pm.test('One-way SOAP response status is 200, 202 or 204 (SOAP 1.2 Part 2 section 6.3)', function () {",
    '  var code = pm.response.code;',
    '  if (code !== 200 && code !== 202 && code !== 204) pm.expect.fail("one-way operations respond 2xx with no envelope -- 200, 202 or 204 (SOAP 1.2 Part 2 section 6.3; WS-I Basic Profile 1.1 R2714); got HTTP " + code);',
    '});',
    ...requestDisciplineLines(operation),
    ...ALLOW_405_LINES
  ];
  return lines.join('\n');
}

/** Build the afterResponse JavaScript for one SOAP operation. */
export function createSoapScript(operation: SoapOperation, warnings: string[] = [], options: SoapScriptOptions = {}): string {
  // Only a parse-confirmed one-way shape (input declared, output absent)
  // switches to the one-way transport contract; partial operation objects
  // (neither side known) keep the full request-response script.
  if (operation.input && !operation.output) return createOneWayScript(operation);

  // Expected reply wsa:Action: explicit wsaw:/wsam:Action on the portType
  // output, else the WSDL default action pattern (WS-A WSDL Binding 4.4.4)
  // with the defaulted output name ([operation]Response, WSDL 1.1 2.4.5).
  const responseAction = options.declaresAddressing
    ? operation.outputAction || defaultActionIri(options.targetNamespace ?? '', operation.portTypeName, operation.outputName || `${operation.name}Response`)
    : '';
  if (options.declaresAddressing && !responseAction) {
    warnings.push(`SOAP_ADDRESSING_ACTION_UNDERIVABLE: operation ${operation.name} engages WS-Addressing but no output action IRI is declared or derivable; asserting wsa header presence only`);
  }

  const meta = {
    name: operation.name,
    soapVersion: operation.soapVersion,
    expectedResponseElement: operation.expectedResponseElement ?? '',
    hasOutput: Boolean(operation.output),
    ...(responseAction ? { wsaAction: responseAction } : {})
  };
  const responseRegex = operation.expectedResponseElement
    ? elementPresenceRegex(operation.expectedResponseElement)
    : '';
  const mediaType = operation.soapVersion === '1.2' ? 'application/soap+xml' : 'text/xml';
  // SOAP 1.1 envelopes are namespace-qualified with the soap/envelope/ URI;
  // SOAP 1.2 (Part 1 section 5.4.7) makes a mismatched envelope namespace a
  // VersionMismatch fault condition.
  const envelopeNs = operation.soapVersion === '1.2' ? 'http://www.w3.org/2003/05/soap-envelope' : 'http://schemas.xmlsoap.org/soap/envelope/';
  // A Fault and the HTTP status must agree: SOAP 1.1 binds Faults to HTTP 500
  // (WS-I Basic Profile R1126); SOAP 1.2 (Part 2, HTTP binding) maps env:Sender
  // faults to 400 and all other faults to 500.
  const faultStatusLine = operation.soapVersion === '1.2'
    ? '  if (faulted && code !== 500 && code !== 400) pm.expect.fail("SOAP 1.2 Faults ride HTTP 500, or 400 for env:Sender faults (SOAP 1.2 Part 2 HTTP binding); got HTTP " + code);'
    : '  if (faulted && code !== 500) pm.expect.fail("SOAP 1.1 Faults must ride HTTP 500 (WS-I Basic Profile R1126); got HTTP " + code);';
  const lines: string[] = [
    `var soap = JSON.parse(${JSON.stringify(JSON.stringify(meta))});`,
    'var bodyText = (pm.response.text && pm.response.text()) || "";',
    'function header(name) { return (pm.response.headers.get(name) || ""); }',
    'function matchTag(local) { return new RegExp("(?:^|<)(?:[A-Za-z_][\\\\w.-]*:)?" + local + "(?=[\\\\s/>])"); }',
    ...XML_HELPER_LINES,
    '',
    "pm.test('SOAP transport returned HTTP 200', function () {",
    '  pm.response.to.have.status(200);',
    '});',
    '',
    // SOAP 1.1 responses bind to text/xml (SOAP 1.1 HTTP binding, WS-I Basic
    // Profile); SOAP 1.2 responses bind to application/soap+xml (RFC 3902).
    `pm.test('SOAP response Content-Type matches the SOAP ${operation.soapVersion} binding', function () {`,
    '  var ct = header("Content-Type").toLowerCase();',
    `  pm.expect(ct, "SOAP ${operation.soapVersion} responses use ${mediaType} (got: " + (ct || "<missing>") + ")").to.include("${mediaType}");`,
    '});',
    '',
    "pm.test('SOAP Envelope element is present', function () {",
    '  pm.expect(bodyText, "response body is not a SOAP envelope").to.match(matchTag("Envelope"));',
    '});',
    '',
    `pm.test('SOAP Envelope namespace matches SOAP ${operation.soapVersion}', function () {`,
    '  if (!matchTag("Envelope").test(bodyText)) return;',
    `  pm.expect(bodyText.indexOf(${JSON.stringify(envelopeNs)}) !== -1, "SOAP ${operation.soapVersion} envelopes must declare the ${envelopeNs} namespace").to.equal(true);`,
    '});',
    '',
    "pm.test('SOAP Body element is present', function () {",
    '  pm.expect(bodyText, "SOAP envelope has no Body element").to.match(matchTag("Body"));',
    '});',
    '',
    "pm.test('Response is not a SOAP Fault', function () {",
    '  var hasFault = matchTag("Fault").test(bodyText);',
    '  if (hasFault) {',
    '    var detail = (bodyText.match(/<(?:[A-Za-z_][\\w.-]*:)?(?:faultstring|Reason|Text)[^>]*>([\\s\\S]*?)<\\//) || [])[1] || "";',
    '    pm.expect.fail("SOAP Fault returned for operation " + soap.name + (detail ? (": " + detail.trim()) : ""));',
    '  }',
    '});',
    '',
    "pm.test('SOAP Fault and HTTP status are consistent', function () {",
    '  var faulted = matchTag("Fault").test(bodyText);',
    '  var code = pm.response.code;',
    faultStatusLine,
    '  if (!faulted && code === 500) pm.expect.fail("HTTP 500 from a SOAP endpoint must carry a SOAP Fault in the body");',
    '});',
    // Fault well-formedness (diagnostic companion to the Fault-absence test: a
    // faulted run already fails, this pinpoints a malformed Fault). SOAP 1.1
    // section 4.4 requires faultcode + faultstring children; SOAP 1.2 Part 1
    // section 5.4 requires Code/Value + Reason/Text and pins the top-level
    // Value QName to the five defined fault codes.
    ...(operation.soapVersion === '1.2' ? [
      '',
      "pm.test('SOAP Fault is well-formed for SOAP 1.2', function () {",
      '  if (!matchTag("Fault").test(bodyText)) return;',
      '  if (!matchTag("Code").test(bodyText)) { pm.expect.fail("a SOAP 1.2 Fault must carry an env:Code child (SOAP 1.2 Part 1 section 5.4)"); return; }',
      '  if (!matchTag("Value").test(bodyText)) { pm.expect.fail("a SOAP 1.2 Fault Code must carry an env:Value child (SOAP 1.2 Part 1 section 5.4.1)"); return; }',
      '  if (!matchTag("Reason").test(bodyText)) pm.expect.fail("a SOAP 1.2 Fault must carry an env:Reason child (SOAP 1.2 Part 1 section 5.4)");',
      '  else if (!matchTag("Text").test(bodyText)) pm.expect.fail("a SOAP 1.2 Fault Reason must carry an env:Text child (SOAP 1.2 Part 1 section 5.4.2)");',
      '  var faultValue = (bodyText.match(/<(?:[A-Za-z_][\\w.-]*:)?Value[^>]*>([\\s\\S]*?)<\\//) || [])[1] || "";',
      '  var faultLocal = faultValue.trim().split(":").pop();',
      '  var faultCodes = ["VersionMismatch", "MustUnderstand", "DataEncodingUnknown", "Sender", "Receiver"];',
      '  if (faultLocal && faultCodes.indexOf(faultLocal) === -1) pm.expect.fail("the SOAP 1.2 Fault Code Value must be one of " + faultCodes.join(", ") + " (SOAP 1.2 Part 1 table 4); got " + faultValue.trim());',
      '});',
      '',
      "pm.test('SOAP 1.2 Fault Reason Text elements carry xml:lang (SOAP 1.2 Part 1 section 5.4.2.1)', function () {",
      '  if (!matchTag("Fault").test(bodyText)) return;',
      '  var reasonInner = elementInner(cleanXml, "Reason");',
      '  if (!reasonInner) return;',
      '  var re = /<(?:[A-Za-z_][\\w.-]*:)?Text(?=[\\s/>])([^>]*)>/g; var m;',
      '  while ((m = re.exec(reasonInner))) { if (!/xml:lang\\s*=/i.test(m[1])) pm.expect.fail("every env:Text child of env:Reason must carry xml:lang (SOAP 1.2 Part 1 section 5.4.2.1)"); }',
      '});',
      '',
      "pm.test('SOAP 1.2 Fault Subcode Values are QNames (SOAP 1.2 Part 1 section 5.4.1.2)', function () {",
      '  if (!matchTag("Subcode").test(cleanXml)) return;',
      '  var sub = elementInner(cleanXml, "Subcode"); var guard = 0;',
      '  while (sub !== null && guard < 16) {',
      '    guard += 1;',
      '    var subValue = (sub.match(/<(?:[A-Za-z_][\\w.-]*:)?Value[^>]*>([\\s\\S]*?)<\\//) || [])[1];',
      '    if (subValue === undefined) { pm.expect.fail("every env:Subcode must carry an env:Value child (SOAP 1.2 Part 1 section 5.4.1.2)"); return; }',
      '    if (!/^\\s*(?:[A-Za-z_][\\w.-]*:)?[A-Za-z_][\\w.-]*\\s*$/.test(subValue)) pm.expect.fail("Subcode Value must be an xs:QName (SOAP 1.2 Part 1 section 5.4.1.2); got " + subValue.trim());',
      '    sub = elementInner(sub, "Subcode");',
      '  }',
      '});',
      '',
      "pm.test('SOAP 1.2 Fault Node and Role values are absolute URIs (SOAP 1.2 Part 1 sections 5.4.3-5.4.4)', function () {",
      '  if (!matchTag("Fault").test(bodyText)) return;',
      '  var re = /<(?:[A-Za-z_][\\w.-]*:)?(Node|Role)(?=[\\s>])[^>]*>([\\s\\S]*?)<\\//g; var m;',
      '  while ((m = re.exec(cleanXml))) { if (!/^\\s*[A-Za-z][A-Za-z0-9+.-]*:/.test(m[2])) pm.expect.fail("env:" + m[1] + " must carry an absolute URI (SOAP 1.2 Part 1 sections 5.4.3-5.4.4); got " + m[2].trim()); }',
      '});'
    ] : [
      '',
      "pm.test('SOAP Fault is well-formed for SOAP 1.1', function () {",
      '  if (!matchTag("Fault").test(bodyText)) return;',
      '  if (!matchTag("faultcode").test(bodyText)) pm.expect.fail("a SOAP 1.1 Fault must carry a faultcode child (SOAP 1.1 section 4.4)");',
      '  if (!matchTag("faultstring").test(bodyText)) pm.expect.fail("a SOAP 1.1 Fault must carry a faultstring child (SOAP 1.1 section 4.4)");',
      '});',
      '',
      "pm.test('SOAP 1.1 faultactor value is a URI (SOAP 1.1 section 4.4)', function () {",
      '  if (!matchTag("Fault").test(bodyText)) return;',
      '  var actor = (cleanXml.match(/<(?:[A-Za-z_][\\w.-]*:)?faultactor[^>]*>([\\s\\S]*?)<\\//) || [])[1];',
      '  if (actor === undefined) return;',
      '  if (!/^\\s*[A-Za-z][A-Za-z0-9+.-]*:/.test(actor)) pm.expect.fail("faultactor must carry a URI identifying the faulting node (SOAP 1.1 section 4.4); got " + actor.trim());',
      '});'
    ])
  ];

  if (responseRegex) {
    lines.push(
      '',
      `pm.test('Expected response element ' + soap.expectedResponseElement + ' is present', function () {`,
      '  if (matchTag("Fault").test(bodyText)) return;',
      `  pm.expect(bodyText, "expected SOAP response element <" + soap.expectedResponseElement + "> not found").to.match(new RegExp(${JSON.stringify(responseRegex)}));`,
      '});'
    );
    // Explicit scope caveat (not a silent gap): SOAP assertions validate transport,
    // content-type, Envelope/Body, Fault-absence and the top-level response element
    // only. Deep WSDL/XSD child-element and scalar payload validation is out of scope
    // for the XML-parser-free sandbox path.
    warnings.push(`SOAP_RESPONSE_BODY_WRAPPER_ONLY: operation ${operation.name} asserts the SOAP envelope/body/fault and the top-level response element <${operation.expectedResponseElement}> but NOT its child element/scalar shapes (WSDL/XSD payload validation is out of scope)`);
  } else if (operation.output) {
    warnings.push(`SOAP_RESPONSE_ELEMENT_UNKNOWN: operation ${operation.name} has an output message but no resolvable response element; only Envelope/Body/Fault are asserted`);
  }


  // WS-Addressing (engaged by the WSDL): a conformant reply carries wsa:Action
  // (WS-A 1.0 Core section 3.2) and, because the generated request sends a
  // wsa:MessageID, a wsa:RelatesTo echoing it (section 3.4). Fault responses
  // are skipped: a Fault legitimately carries the WS-A fault action instead.
  if (options.declaresAddressing) {
    lines.push(
      '',
      "pm.test('WS-Addressing response headers are present', function () {",
      '  if (matchTag("Fault").test(bodyText)) return;',
      '  var headerXml = elementInner(cleanXml, "Header");',
      '  if (!headerXml) { pm.expect.fail("WS-Addressing is engaged by the WSDL; the response must carry a SOAP Header with wsa:Action (WS-Addressing 1.0 Core section 3.2)"); return; }',
      '  if (!matchTag("Action").test(headerXml)) pm.expect.fail("WS-Addressing is engaged by the WSDL; the response Header must carry wsa:Action (WS-Addressing 1.0 Core section 3.2)");',
      '  var requestXml = (pm.request && pm.request.body && pm.request.body.raw) || "";',
      '  if (matchTag("MessageID").test(requestXml) && !matchTag("RelatesTo").test(headerXml)) pm.expect.fail("the request carried wsa:MessageID, so the reply must carry wsa:RelatesTo (WS-Addressing 1.0 Core section 3.4)");',
      '});'
    );
    if (responseAction) {
      lines.push(
        '',
        "pm.test('wsa:Action matches the WSDL output action', function () {",
        '  if (matchTag("Fault").test(bodyText)) return;',
        '  var headerXml = elementInner(cleanXml, "Header") || "";',
        '  var action = (headerXml.match(/<(?:[A-Za-z_][\\w.-]*:)?Action[^>]*>([\\s\\S]*?)<\\//) || [])[1];',
        '  if (action === undefined) return;',
        '  pm.expect(action.trim(), "wsa:Action must equal the action IRI declared or derived for the output message (WS-Addressing 1.0 WSDL Binding section 4.4)").to.eql(soap.wsaAction);',
        '});'
      );
    }
    lines.push(
      '',
      "pm.test('wsa:RelatesTo echoes the request wsa:MessageID', function () {",
      '  if (matchTag("Fault").test(bodyText)) return;',
      '  var requestXml = (pm.request && pm.request.body && pm.request.body.raw) || "";',
      '  var sentId = (requestXml.match(/<(?:[A-Za-z_][\\w.-]*:)?MessageID[^>]*>([\\s\\S]*?)<\\//) || [])[1];',
      '  if (sentId === undefined || sentId.indexOf("{{") !== -1) return;',
      '  var headerXml = elementInner(cleanXml, "Header") || "";',
      '  var related = (headerXml.match(/<(?:[A-Za-z_][\\w.-]*:)?RelatesTo[^>]*>([\\s\\S]*?)<\\//) || [])[1];',
      '  if (related === undefined) return;',
      '  pm.expect(related.trim(), "wsa:RelatesTo must reference the request wsa:MessageID (WS-Addressing 1.0 Core section 3.4)").to.eql(sentId.trim());',
      '});'
    );
  }
  lines.push(...requestDisciplineLines(operation), ...deepConformanceLines(operation));
  return lines.join('\n');
}

/** Walk every leaf HTTP request item in a v2.1.0 collection tree. */
function forEachHttpRequest(node: JsonRecord, visit: (item: JsonRecord) => void): void {
  const children = asArray(node.item);
  if (children.length > 0) {
    for (const child of children) {
      const record = asRecord(child);
      if (record) forEachHttpRequest(record, visit);
    }
    return;
  }
  if (asRecord(node.request)) visit(node);
}

/**
 * Inject SOAP `test` (afterResponse) assertion scripts into every HTTP request
 * item of a built v2.1.0 SOAP collection, matching items to operations by name.
 * No silent drop: unmatched items and unresolved response elements emit SOAP_*
 * warnings.
 */
export function instrumentSoapCollection(collection: JsonRecord, index: SoapContractIndex): SoapInstrumentationResult {
  const warnings: string[] = [...index.warnings];
  const byName = new Map<string, SoapOperation>();
  const allOperationNames = new Set<string>();
  for (const service of index.services) {
    for (const operation of service.operations) {
      byName.set(operation.name, operation);
      allOperationNames.add(operation.name);
      warnings.push(...operation.warnings);
    }
  }
  const covered = new Set<string>();

  forEachHttpRequest(collection, (item) => {
    const name = typeof item.name === 'string' ? item.name : '';
    if (name === SOAP12_UNSUPPORTED_MEDIA_PROBE_NAME) {
      const probeExec = [
        "pm.test('Unsupported request media type is rejected with HTTP 415 (SOAP 1.2 Part 2 section 7)', function () {",
        '  var code = pm.response.code;',
        '  if (code >= 200 && code < 300) { pm.expect.fail("the endpoint accepted a SOAP request mislabeled as text/plain; the SOAP 1.2 HTTP binding maps unsupported media types to HTTP 415 (SOAP 1.2 Part 2 section 7)"); return; }',
        '  if (code === 500) { pm.expect.fail("an unsupported request media type must be classified as HTTP 415, not a 500 server error (SOAP 1.2 Part 2 section 7)"); return; }',
        '  pm.expect(code, "unsupported media types map to HTTP 415 (SOAP 1.2 Part 2 section 7)").to.eql(415);',
        '});'
      ];
      const existingEvents = asArray(item.event)
        .map((entry) => asRecord(entry))
        .filter((entry): entry is JsonRecord => Boolean(entry) && entry!.listen !== 'test');
      item.event = [...existingEvents, { listen: 'test', script: { type: 'text/javascript', exec: probeExec } }];
      return;
    }
    const operation = byName.get(name) ?? byName.get(localName(name));
    if (!operation) {
      const mappingError = `SOAP request "${name}" did not match any WSDL operation`;
      warnings.push(`SOAP_ITEM_UNMATCHED: request "${name}" did not match any WSDL operation; attached fail-closed assertion`);
      const failExec = [
        `var contractMappingError = ${JSON.stringify(mappingError)};`,
        "pm.test('SOAP operation mapping exists', function () {",
        '  pm.expect.fail(contractMappingError);',
        '});'
      ];
      const existing = asArray(item.event)
        .map((entry) => asRecord(entry))
        .filter((entry): entry is JsonRecord => Boolean(entry) && entry!.listen !== 'test');
      item.event = [...existing, { listen: 'test', script: { type: 'text/javascript', exec: failExec } }];
      return;
    }
    covered.add(operation.name);
    const exec = createSoapScript(operation, warnings, { declaresAddressing: index.declaresAddressing, targetNamespace: index.targetNamespace }).split('\n');
    const existing = asArray(item.event)
      .map((entry) => asRecord(entry))
      .filter((entry): entry is JsonRecord => Boolean(entry) && entry!.listen !== 'test');
    item.event = [
      ...existing,
      { listen: 'test', script: { type: 'text/javascript', exec } }
    ];
  });

  // Coverage enforcement (parity with OpenAPI/GraphQL/gRPC/AsyncAPI): every WSDL
  // operation must be materialized as a request item, or the builder silently
  // dropped one and the collection would ship it unasserted.
  const missing = [...allOperationNames].filter((name) => !covered.has(name));
  if (missing.length > 0) {
    throw new Error(`SOAP_OPERATION_COVERAGE_FAILED: SOAP collection is missing generated request coverage for ${missing.join(', ')}`);
  }

  return { collection, warnings: [...new Set(warnings)] };
}

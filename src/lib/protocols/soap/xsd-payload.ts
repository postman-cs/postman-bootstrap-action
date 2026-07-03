// Response-payload assertions driven by the inline-XSD component index
// (contract catalog soap_runtime_payload_ws_i lane). Shares the raw-text
// strategy of instrumenter.ts: regex tokenizers over the response XML, never
// a full XML parser, and every check skips shapes the index cannot prove.
// The emitted code relies on top-level helpers the request-response script
// always defines (bodyText, cleanXml, matchTag, elementInner, localPart,
// accepted202).

import type { SoapOperation } from './parser.js';
import { lookupXsdElement, type XsdChildElement, type XsdElementDecl, type XsdSchemaIndex } from './xsd-index.js';

function jsString(value: string): string {
  return JSON.stringify(value);
}

/** XSD built-in lexical spaces (XML Schema Part 2) the scalar check can prove. */
const XSD_LEXICAL: Record<string, string> = {
  boolean: '^(true|false|1|0)$',
  decimal: '^[+-]?(\\d+(\\.\\d*)?|\\.\\d+)$',
  float: '^([+-]?(\\d+(\\.\\d*)?|\\.\\d+)([eE][+-]?\\d+)?|-?INF|NaN)$',
  double: '^([+-]?(\\d+(\\.\\d*)?|\\.\\d+)([eE][+-]?\\d+)?|-?INF|NaN)$',
  integer: '^[+-]?\\d+$',
  long: '^[+-]?\\d+$',
  int: '^[+-]?\\d+$',
  short: '^[+-]?\\d+$',
  byte: '^[+-]?\\d+$',
  nonNegativeInteger: '^[+-]?\\d+$',
  positiveInteger: '^[+-]?\\d+$',
  negativeInteger: '^[+-]?\\d+$',
  nonPositiveInteger: '^[+-]?\\d+$',
  unsignedLong: '^[+-]?\\d+$',
  unsignedInt: '^[+-]?\\d+$',
  unsignedShort: '^[+-]?\\d+$',
  unsignedByte: '^[+-]?\\d+$',
  date: '^-?\\d{4,}-\\d{2}-\\d{2}(Z|[+-]\\d{2}:\\d{2})?$',
  dateTime: '^-?\\d{4,}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})?$',
  time: '^\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})?$',
  gYear: '^-?\\d{4,}(Z|[+-]\\d{2}:\\d{2})?$'
};

// Integer value bounds beyond the shared lexical space. xsd:long is omitted:
// its bounds exceed JS double precision and would misreport edge values.
const XSD_INT_BOUNDS: Record<string, [number | null, number | null]> = {
  int: [-2147483648, 2147483647],
  short: [-32768, 32767],
  byte: [-128, 127],
  unsignedInt: [0, 4294967295],
  unsignedShort: [0, 65535],
  unsignedByte: [0, 255],
  unsignedLong: [0, null],
  nonNegativeInteger: [0, null],
  positiveInteger: [1, null],
  negativeInteger: [null, -1],
  nonPositiveInteger: [null, 0]
};

/** XSD built-in type local names accepted by the xsi:type resolution check. */
const XSD_BUILTIN_TYPE_NAMES: string[] = [
  'anyType', 'anySimpleType', 'string', 'boolean', 'decimal', 'float', 'double', 'duration',
  'dateTime', 'time', 'date', 'gYearMonth', 'gYear', 'gMonthDay', 'gDay', 'gMonth',
  'hexBinary', 'base64Binary', 'anyURI', 'QName', 'NOTATION', 'normalizedString', 'token',
  'language', 'NMTOKEN', 'NMTOKENS', 'Name', 'NCName', 'ID', 'IDREF', 'IDREFS', 'ENTITY',
  'ENTITIES', 'integer', 'nonPositiveInteger', 'negativeInteger', 'long', 'int', 'short',
  'byte', 'nonNegativeInteger', 'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte',
  'positiveInteger'
];

interface ChildMeta {
  name: string;
  min: number;
  max: number;
  nillable: boolean;
  ref?: boolean;
  builtin?: string;
  lex?: string;
  vmin?: number;
  vmax?: number;
  enums?: string[];
}

function childMeta(c: XsdChildElement): ChildMeta {
  const lex = c.builtinType ? XSD_LEXICAL[c.builtinType] : undefined;
  const bounds = c.builtinType ? XSD_INT_BOUNDS[c.builtinType] : undefined;
  return {
    name: c.name,
    min: c.minOccurs,
    max: c.maxOccurs === 'unbounded' ? -1 : c.maxOccurs,
    nillable: c.nillable,
    ...(c.viaRef ? { ref: true } : {}),
    ...(c.builtinType ? { builtin: c.builtinType } : {}),
    ...(lex ? { lex } : {}),
    ...(bounds && bounds[0] !== null ? { vmin: bounds[0] } : {}),
    ...(bounds && bounds[1] !== null ? { vmax: bounds[1] } : {}),
    ...(c.enumeration && c.enumeration.length > 0 ? { enums: c.enumeration } : {})
  };
}

/**
 * Inline-XSD declaration for the operation's expected response element, when
 * payload assertions are provable: literal (not encoded), non-rpc, and the
 * element resolves in the index.
 */
export function resolveResponseDecl(operation: SoapOperation, index?: XsdSchemaIndex): XsdElementDecl | undefined {
  if (!index || operation.style === 'rpc' || operation.use === 'encoded' || !operation.expectedResponseElement) return undefined;
  return lookupXsdElement(index, operation.expectedResponseNamespace, operation.expectedResponseElement);
}

/** Payload assertion lines for the response wrapper, empty when unprovable. */
export function xsdPayloadLines(operation: SoapOperation, index?: XsdSchemaIndex): string[] {
  const decl = resolveResponseDecl(operation, index);
  if (!decl || !index) return [];
  const childrenKnown = decl.children !== undefined;
  const meta = {
    wrapper: decl.name,
    complete: index.complete,
    qualified: decl.childrenQualified,
    nillable: decl.nillable,
    childrenKnown,
    children: (decl.children ?? []).map(childMeta),
    attrs: (decl.attributes ?? []).map((a) => ({ name: a.name, required: a.required, ...(a.fixed !== undefined && a.fixed !== '' ? { fixed: a.fixed } : {}) })),
    typeNames: [...index.typeLocalNames].sort(),
    builtins: XSD_BUILTIN_TYPE_NAMES,
    envNs: operation.soapVersion === '1.2' ? 'http://www.w3.org/2003/05/soap-envelope' : 'http://schemas.xmlsoap.org/soap/envelope/'
  };
  const lines: string[] = [
    '',
    'var xsd = JSON.parse(' + jsString(JSON.stringify(meta)) + ');',
    'function directChildEls(inner) {',
    '  var out = []; var depth = 0; var m; var start = -1; var name = ""; var tag = "";',
    '  var re = /<(\\/?)([A-Za-z_][\\w.-]*(?::[A-Za-z_][\\w.-]*)?)([^>]*?)(\\/?)>/g;',
    '  while ((m = re.exec(inner))) {',
    '    if (m[1]) { depth -= 1; if (depth === 0) out.push({ name: name, tag: tag, inner: inner.slice(start, m.index) }); continue; }',
    '    if (depth === 0) { name = m[2]; tag = m[0]; start = m.index + m[0].length; if (m[4]) { out.push({ name: name, tag: tag, inner: "" }); continue; } }',
    '    if (!m[4]) depth += 1;',
    '  }',
    '  return out;',
    '}',
    'function xsdWrapperInner() {',
    '  if (accepted202 || matchTag("Fault").test(bodyText)) return null;',
    '  return elementInner(cleanXml, xsd.wrapper);',
    '}',
    'function xsdWrapperTag() {',
    '  if (accepted202 || matchTag("Fault").test(bodyText)) return null;',
    '  var open = cleanXml.match(new RegExp("<(?:[A-Za-z_][\\\\w.-]*:)?" + xsd.wrapper + "(?=[\\\\s/>])[^>]*>"));',
    '  return open ? open[0] : null;',
    '}'
  ];
  if (childrenKnown) {
    lines.push(
      '',
      "pm.test('Response wrapper children match the declared xsd:sequence (XML Schema Part 1 section 3.8)', function () {",
      '  var inner = xsdWrapperInner();',
      '  if (inner === null) return;',
      '  var kids = directChildEls(inner);',
      '  var declared = xsd.children.map(function (c) { return c.name; });',
      '  if (xsd.complete) {',
      '    for (var i = 0; i < kids.length; i++) { if (declared.indexOf(localPart(kids[i].name)) === -1) pm.expect.fail("element " + kids[i].name + " is not declared in the xsd:sequence of " + xsd.wrapper); }',
      '  }',
      '  for (var j = 0; j < xsd.children.length; j++) {',
      '    var c = xsd.children[j]; var cnt = 0;',
      '    for (var k = 0; k < kids.length; k++) { if (localPart(kids[k].name) === c.name) cnt += 1; }',
      '    if (cnt < c.min) pm.expect.fail("child " + c.name + " of " + xsd.wrapper + " occurs " + cnt + " time(s); the schema requires minOccurs=" + c.min);',
      '    if (c.max !== -1 && cnt > c.max) pm.expect.fail("child " + c.name + " of " + xsd.wrapper + " occurs " + cnt + " time(s); the schema allows maxOccurs=" + c.max);',
      '  }',
      '  var seq = []; for (var s = 0; s < kids.length; s++) { var di = declared.indexOf(localPart(kids[s].name)); if (di !== -1) seq.push(di); }',
      '  for (var o = 1; o < seq.length; o++) { if (seq[o] < seq[o - 1]) pm.expect.fail("children of " + xsd.wrapper + " must follow the xsd:sequence order " + declared.join(", ")); }',
      '});',
      '',
      "pm.test('Response wrapper children follow the schema element form (XML Schema Part 1 section 3.3.2 / WS-I Basic Profile 1.1 R1014)', function () {",
      '  var inner = xsdWrapperInner();',
      '  if (inner === null || inner.indexOf("xmlns=") !== -1) return;',
      '  var kids = directChildEls(inner);',
      '  for (var i = 0; i < kids.length; i++) {',
      '    var prefixed = kids[i].name.indexOf(":") !== -1;',
      '    var known = null;',
      '    for (var j = 0; j < xsd.children.length; j++) { if (xsd.children[j].name === localPart(kids[i].name)) { known = xsd.children[j]; break; } }',
      '    if (xsd.qualified && !prefixed) pm.expect.fail("child " + kids[i].name + " of " + xsd.wrapper + " must be namespace-qualified (elementFormDefault=qualified)");',
      '    if (!xsd.qualified && prefixed && known && !known.ref) pm.expect.fail("child " + kids[i].name + " of " + xsd.wrapper + " must be unqualified (unqualified local elements live in no namespace)");',
      '  }',
      '});'
    );
  }
  if (meta.children.some((c) => c.lex || c.enums)) {
    lines.push(
      '',
      "pm.test('Response wrapper scalar children match their XSD simple types (XML Schema Part 2)', function () {",
      '  var inner = xsdWrapperInner();',
      '  if (inner === null) return;',
      '  var kids = directChildEls(inner);',
      '  for (var i = 0; i < kids.length; i++) {',
      '    var name = localPart(kids[i].name); var c = null;',
      '    for (var j = 0; j < xsd.children.length; j++) { if (xsd.children[j].name === name) { c = xsd.children[j]; break; } }',
      '    if (!c || (!c.lex && !c.enums)) continue;',
      '    if (/(?:^|\\s)xsi:nil\\s*=\\s*["\'](?:1|true)["\']/.test(kids[i].tag)) continue;',
      '    if (kids[i].inner.indexOf("<") !== -1) continue;',
      '    var text = kids[i].inner.trim().replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, String.fromCharCode(34)).replace(/&apos;/g, String.fromCharCode(39)).replace(/&amp;/g, "&");',
      '    if (c.lex && !new RegExp(c.lex).test(text)) pm.expect.fail("element " + name + " value " + text + " is not a valid xsd:" + c.builtin + " (XML Schema Part 2)");',
      '    if (c.lex && new RegExp(c.lex).test(text) && (c.vmin !== undefined || c.vmax !== undefined)) {',
      '      var n = Number(text);',
      '      if (c.vmin !== undefined && n < c.vmin) pm.expect.fail("element " + name + " value " + text + " is below the xsd:" + c.builtin + " minimum " + c.vmin);',
      '      if (c.vmax !== undefined && n > c.vmax) pm.expect.fail("element " + name + " value " + text + " exceeds the xsd:" + c.builtin + " maximum " + c.vmax);',
      '    }',
      '    if (c.enums && c.enums.indexOf(text) === -1) pm.expect.fail("element " + name + " value " + text + " is not among the enumeration " + c.enums.join(", "));',
      '  }',
      '});'
    );
  }
  lines.push(
    '',
    "pm.test('xsi:nil usage matches the schema nillable declarations (XML Schema Part 1 section 3.3.1)', function () {",
    '  var tag = xsdWrapperTag();',
    '  if (tag === null) return;',
    '  var nilRe = /(?:^|\\s)xsi:nil\\s*=\\s*["\'](?:1|true)["\']/;',
    '  if (nilRe.test(tag) && !xsd.nillable) pm.expect.fail("element " + xsd.wrapper + " is not declared nillable but carries xsi:nil=true");',
    '  var inner = xsdWrapperInner();',
    '  if (inner === null) return;',
    '  if (nilRe.test(tag) && inner.trim()) pm.expect.fail("element " + xsd.wrapper + " carries xsi:nil=true and must therefore be empty");',
    '  var kids = directChildEls(inner);',
    '  for (var i = 0; i < kids.length; i++) {',
    '    if (!nilRe.test(kids[i].tag)) continue;',
    '    if (kids[i].inner.trim()) pm.expect.fail("element " + kids[i].name + " carries xsi:nil=true and must therefore be empty");',
    '    if (!xsd.childrenKnown) continue;',
    '    var name = localPart(kids[i].name);',
    '    for (var j = 0; j < xsd.children.length; j++) { if (xsd.children[j].name === name && !xsd.children[j].nillable) pm.expect.fail("element " + name + " is not declared nillable but carries xsi:nil=true"); }',
    '  }',
    '});',
    '',
    "pm.test('Literal response element carries no SOAP envelope attributes (WS-I Basic Profile 1.1 R1005/R2706)', function () {",
    '  var tag = xsdWrapperTag();',
    '  if (tag === null) return;',
    '  var re = /([A-Za-z_][\\w.-]*):(encodingStyle|mustUnderstand|actor|role|relay)\\s*=/g; var m;',
    '  while ((m = re.exec(tag))) {',
    '    if (cleanXml.indexOf("xmlns:" + m[1] + "=" + String.fromCharCode(34) + xsd.envNs + String.fromCharCode(34)) !== -1 || cleanXml.indexOf("xmlns:" + m[1] + "=" + String.fromCharCode(39) + xsd.envNs + String.fromCharCode(39)) !== -1) pm.expect.fail("SOAP " + m[2] + " must not appear on the literal response element " + xsd.wrapper + " (WS-I Basic Profile 1.1 R1005/R2706)");',
    '  }',
    '});'
  );
  if (index.complete) {
    lines.push(
      '',
      "pm.test('xsi:type values name declared or built-in schema types (XML Schema Part 1 section 2.6.1)', function () {",
      '  var inner = xsdWrapperInner();',
      '  if (inner === null) return;',
      '  var re = /xsi:type\\s*=\\s*["\']([^"\']+)["\']/g; var m;',
      '  while ((m = re.exec(inner))) {',
      '    var lp = localPart(m[1].trim());',
      '    if (xsd.builtins.indexOf(lp) === -1 && xsd.typeNames.indexOf(lp) === -1) pm.expect.fail("xsi:type " + m[1] + " names no schema-declared or XSD built-in type");',
      '  }',
      '});'
    );
  }
  if (meta.attrs.length > 0) {
    lines.push(
      '',
      "pm.test('Response wrapper carries its required and fixed XSD attributes (XML Schema Part 1 section 3.2)', function () {",
      '  var tag = xsdWrapperTag();',
      '  if (tag === null) return;',
      '  for (var i = 0; i < xsd.attrs.length; i++) {',
      '    var a = xsd.attrs[i];',
      '    var m = new RegExp("(?:^|\\\\s)(?:[A-Za-z_][\\\\w.-]*:)?" + a.name + "\\\\s*=\\\\s*[\\"\']([^\\"\']*)[\\"\']").exec(tag);',
      '    if (a.required && !m) pm.expect.fail("attribute " + a.name + " (use=required) is missing on " + xsd.wrapper);',
      '    if (m && a.fixed !== undefined && m[1] !== a.fixed) pm.expect.fail("attribute " + a.name + " on " + xsd.wrapper + " is fixed to " + a.fixed + " (got " + m[1] + ")");',
      '  }',
      '});'
    );
  }
  return lines;
}

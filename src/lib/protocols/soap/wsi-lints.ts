// Generation-time WS-I / WSDL conformance lints over the raw WSDL document.
//
// These checks need lexical detail (element ordering, attribute placement,
// XML declaration content) that the flattened SoapContractIndex no longer
// carries, so they re-parse the document with preserveOrder and walk the
// ordered tree. Emitted codes are SOAP_WSI_* (WSDL 1.1 / WS-I Basic Profile
// 1.1) and SOAP_WSDL20_* (WSDL 2.0 component-model rules).

import { XMLParser } from 'fast-xml-parser';

interface XNode {
  tag: string;
  attrs: Record<string, string>;
  children: XNode[];
}

const ORDERED_PARSER_OPTIONS = {
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  allowBooleanAttributes: true,
  parseTagValue: false,
  parseAttributeValue: false
};

function normalize(nodes: unknown): XNode[] {
  if (!Array.isArray(nodes)) return [];
  const out: XNode[] = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const tag = Object.keys(record).find((k) => k !== ':@' && k !== '#text');
    if (!tag) continue;
    const attrsRaw = record[':@'];
    const attrs: Record<string, string> = {};
    if (attrsRaw && typeof attrsRaw === 'object' && !Array.isArray(attrsRaw)) {
      for (const [k, v] of Object.entries(attrsRaw as Record<string, unknown>)) attrs[k] = String(v);
    }
    out.push({ tag, attrs, children: normalize(record[tag]) });
  }
  return out;
}

function local(tag: string): string {
  const i = tag.indexOf(':');
  return i === -1 ? tag : tag.slice(i + 1);
}

function isAbsoluteUri(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function children(node: XNode, name: string): XNode[] {
  return node.children.filter((c) => local(c.tag) === name);
}

function attr(node: XNode, name: string): string | undefined {
  for (const [k, v] of Object.entries(node.attrs)) {
    if (local(k) === name) return v;
  }
  return undefined;
}

function walk(node: XNode, visit: (node: XNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

/**
 * Deterministic import resolver supplied by the caller: maps a
 * wsdl:import/xsd:import location to already-fetched document text. No
 * network I/O happens in this module; unresolvable locations simply skip the
 * resolution-dependent checks.
 */
export type WsdlImportResolver = (location: string) => string | undefined;

/** Merge a node's xmlns declarations onto an inherited prefix scope. */
function xmlnsScope(node: XNode, base: Record<string, string>): Record<string, string> {
  let merged = base;
  for (const [k, v] of Object.entries(node.attrs)) {
    if (k !== 'xmlns' && !k.startsWith('xmlns:')) continue;
    if (merged === base) merged = { ...base };
    merged[k === 'xmlns' ? '' : k.slice(6)] = v;
  }
  return merged;
}

/** Walk the ordered tree carrying the in-scope xmlns prefix declarations. */
function walkWithScope(
  node: XNode,
  scope: Record<string, string>,
  visit: (node: XNode, ns: Record<string, string>) => void
): void {
  const merged = xmlnsScope(node, scope);
  visit(node, merged);
  for (const child of node.children) walkWithScope(child, merged, visit);
}

function tagNamespace(tag: string, ns: Record<string, string>): string {
  const i = tag.indexOf(':');
  return i === -1 ? ns[''] ?? '' : ns[tag.slice(0, i)] ?? '';
}

function qnameNamespace(qname: string, ns: Record<string, string>): string {
  const i = qname.indexOf(':');
  return i === -1 ? ns[''] ?? '' : ns[qname.slice(0, i)] ?? '';
}

/** Parse a resolver-supplied document into its root element, or null. */
function parseImported(content: string): XNode | null {
  try {
    const roots = normalize(new XMLParser(ORDERED_PARSER_OPTIONS).parse(content) as unknown);
    return roots.find((r) => !r.tag.startsWith('?')) ?? null;
  } catch {
    return null;
  }
}

/**
 * XML declaration hygiene for resolver-supplied imports: WS-I Basic Profile
 * 1.1 R4003/R4004 apply to every document in the description, not only the
 * root WSDL.
 */
function lintImportedXmlDeclaration(content: string, label: string, warnings: string[]): void {
  const decl = /^\uFEFF?\s*<\?xml\b([^?]*)\?>/.exec(content);
  if (!decl) return;
  const version = /version\s*=\s*["']([^"']+)["']/.exec(decl[1]);
  if (version && version[1] !== '1.0') {
    warnings.push('SOAP_WSI_IMPORT_XML_DECL: ' + label + ' declares XML version "' + version[1] + '"; WS-I Basic Profile 1.1 R4004 requires XML 1.0');
  }
  const encoding = /encoding\s*=\s*["']([^"']+)["']/.exec(decl[1]);
  if (encoding && !/^utf-(8|16)(le|be)?$/i.test(encoding[1])) {
    warnings.push('SOAP_WSI_IMPORT_XML_ENCODING: ' + label + ' declares encoding "' + encoding[1] + '"; WS-I Basic Profile 1.1 R4003 requires UTF-8 or UTF-16');
  }
}

interface WsdlMessagePart {
  name: string;
  element?: string;
  type?: string;
}

interface PortTypeOperation {
  name: string;
  inputMessage?: string;
  outputMessage?: string;
  wsamAction?: string;
}

export function lintWsiConformance(text: string, resolveImport?: WsdlImportResolver): string[] {
  const warnings: string[] = [];
  const decl = /^\uFEFF?\s*<\?xml\b([^?]*)\?>/.exec(text);
  if (decl) {
    const version = /version\s*=\s*["']([^"']+)["']/.exec(decl[1]);
    if (version && version[1] !== '1.0') {
      warnings.push('SOAP_WSI_XML_DECL: WSDL declares XML version "' + version[1] + '"; WS-I Basic Profile 1.1 R4004 requires XML 1.0');
    }
    const encoding = /encoding\s*=\s*["']([^"']+)["']/.exec(decl[1]);
    if (encoding && !/^utf-(8|16)(le|be)?$/i.test(encoding[1])) {
      warnings.push('SOAP_WSI_XML_ENCODING: WSDL encoding "' + encoding[1] + '" is not UTF-8 or UTF-16 (WS-I Basic Profile 1.1 R4003)');
    }
  }
  if (/xmlns:xml\s*=/.test(text)) {
    warnings.push('SOAP_WSI_XMLNS_XML_DECL: WSDL redeclares the xml namespace prefix (xmlns:xml); WS-I Basic Profile 1.1 R4005 warns against this');
  }
  if (/[\s"']wsdl:arrayType\s*=/.test(text)) {
    warnings.push('SOAP_WSI_ARRAYTYPE: wsdl:arrayType is a soapenc array idiom; WS-I Basic Profile 1.1 R2110 prohibits it in type declarations');
  }
  if (/base\s*=\s*["'][A-Za-z_][\w.-]*:Array["']/.test(text)) {
    warnings.push('SOAP_WSI_SOAPENC_ARRAY: type declarations must not extend or restrict soapenc:Array (WS-I Basic Profile 1.1 R2110/R2111)');
  }

  let roots: XNode[];
  try {
    roots = normalize(new XMLParser(ORDERED_PARSER_OPTIONS).parse(text) as unknown);
  } catch {
    return warnings;
  }
  const definitions = roots.find((r) => local(r.tag) === 'definitions');
  const description = roots.find((r) => local(r.tag) === 'description');
  if (definitions) lintWsdl11(definitions, warnings, resolveImport);
  if (description) lintWsdl20(description, warnings, resolveImport);
  return warnings;
}

function lintWsdl11(defs: XNode, warnings: string[], resolveImport?: WsdlImportResolver): void {
  lintWsdl11Structure(defs, warnings);
  lintWsdl11Ordering(defs, warnings);
  const imported = lintWsdl11Imports(defs, warnings, resolveImport);
  const allImportsResolved = children(defs, 'import').length === imported.length;
  lintWsdl11Types(defs, warnings);
  const schemaTable = collectSchemaElementTable([defs, ...imported.map((entry) => entry.node)], warnings, resolveImport);
  const messages = collectMessages(defs, warnings);
  const portTypes = collectPortTypes(defs, messages, warnings);
  lintWsdl11Bindings(defs, messages, portTypes, warnings);
  lintWsdl11PartElements(defs, schemaTable, schemaTable.complete && allImportsResolved, warnings);
  // QName checks only run when every wsdl:import resolved (or none exist), so a
  // split WSDL without a resolver never floods namespace-unknown warnings.
  if (allImportsResolved) lintWsdl11QNames(defs, imported, warnings);
  lintXsdImportPlacement(defs, warnings);
  lintWsdl11Services(defs, warnings);
  lintRequiredExtensions(defs, warnings);
}

const WSDL11_NS = 'http://schemas.xmlsoap.org/wsdl/';
const SOAP_HTTP_TRANSPORT_URI = 'http://schemas.xmlsoap.org/soap/http';

// Element locals defined by the WS-I corrected WSDL 1.1 schema, plus the
// required attributes this generator depends on. Foreign-namespace extension
// elements are exempt (WSDL 1.1 section 2.1.3 extensibility).
const WSDL11_SCHEMA_LOCALS = new Set([
  'definitions', 'documentation', 'import', 'types', 'message', 'part', 'portType', 'operation',
  'input', 'output', 'fault', 'binding', 'service', 'port'
]);
const WSDL11_REQUIRED_ATTRS: Record<string, string[]> = {
  message: ['name'],
  part: ['name'],
  portType: ['name'],
  operation: ['name'],
  binding: ['name', 'type'],
  service: ['name'],
  port: ['name', 'binding'],
  import: ['namespace']
};

/**
 * Pinned structural pass over the WSDL 1.1 content model: every element in
 * the WSDL 1.1 namespace must be schema-defined and carry its required
 * attributes (WS-I Basic Profile 1.1 R2028/R2029: descriptions must be valid
 * against the corrected WSDL 1.1 schema).
 */
function lintWsdl11Structure(defs: XNode, warnings: string[]): void {
  walkWithScope(defs, {}, (node, ns) => {
    if (tagNamespace(node.tag, ns) !== WSDL11_NS) return;
    const name = local(node.tag);
    if (!WSDL11_SCHEMA_LOCALS.has(name)) {
      warnings.push('SOAP_WSI_SCHEMA_INVALID: element <' + node.tag + '> is not defined by the WSDL 1.1 schema (WS-I Basic Profile 1.1 R2028/R2029)');
      return;
    }
    for (const required of WSDL11_REQUIRED_ATTRS[name] ?? []) {
      if (attr(node, required) === undefined) {
        warnings.push('SOAP_WSI_SCHEMA_INVALID: <' + node.tag + '> omits its required ' + required + ' attribute (WS-I Basic Profile 1.1 R2028/R2029)');
      }
    }
  });
}

function lintWsdl11Ordering(defs: XNode, warnings: string[]): void {
  let sawTypes = false;
  let sawOther = false;
  for (const child of defs.children) {
    const name = local(child.tag);
    if (name === 'documentation') continue;
    if (name === 'import') {
      if (sawTypes || sawOther) {
        warnings.push('SOAP_WSI_ELEMENT_ORDER: wsdl:import must precede all elements except wsdl:documentation (WS-I Basic Profile 1.1 R2022)');
      }
      continue;
    }
    if (name === 'types') {
      if (sawOther) {
        warnings.push('SOAP_WSI_ELEMENT_ORDER: wsdl:types must precede all elements except documentation and imports (WS-I Basic Profile 1.1 R2023)');
      }
      sawTypes = true;
      continue;
    }
    sawOther = true;
  }
}

interface ImportedWsdl {
  node: XNode;
  label: string;
}

function lintWsdl11Imports(defs: XNode, warnings: string[], resolveImport?: WsdlImportResolver): ImportedWsdl[] {
  const imported: ImportedWsdl[] = [];
  for (const imp of children(defs, 'import')) {
    const location = attr(imp, 'location');
    if (location === undefined || location === '') {
      warnings.push('SOAP_WSI_IMPORT_LOCATION: wsdl:import must carry a non-empty location attribute (WS-I Basic Profile 1.1 R2007)');
    } else if (/\.xsd([?#]|$)/i.test(location)) {
      warnings.push('SOAP_WSI_IMPORT_TARGETS_SCHEMA: wsdl:import location "' + location + '" looks like an XML Schema document; wsdl:import imports WSDL descriptions only (WS-I Basic Profile 1.1 R2001) -- use xsd:import inside wsdl:types');
    }
    const namespace = attr(imp, 'namespace');
    if (namespace !== undefined && !isAbsoluteUri(namespace)) {
      warnings.push('SOAP_WSI_IMPORT_NAMESPACE_RELATIVE: wsdl:import namespace "' + namespace + '" is relative; WS-I Basic Profile 1.1 R2803 requires absolute namespace URIs');
    }
    if (location === undefined || location === '' || !resolveImport) continue;
    const content = resolveImport(location);
    if (content === undefined) continue;
    lintImportedXmlDeclaration(content, 'imported WSDL "' + location + '"', warnings);
    const root = parseImported(content);
    if (!root) {
      warnings.push('SOAP_WSI_IMPORT_UNPARSEABLE: wsdl:import location "' + location + '" did not parse as XML (WS-I Basic Profile 1.1 R2007)');
    } else if (local(root.tag) === 'schema') {
      warnings.push('SOAP_WSI_IMPORT_TARGETS_SCHEMA: wsdl:import location "' + location + '" resolves to an XML Schema document; wsdl:import imports WSDL descriptions only (WS-I Basic Profile 1.1 R2001) -- use xsd:import inside wsdl:types');
    } else if (local(root.tag) === 'definitions') {
      const tns = attr(root, 'targetNamespace');
      if (namespace !== undefined && tns !== undefined && namespace !== tns) {
        warnings.push('SOAP_WSI_IMPORT_NAMESPACE_MISMATCH: wsdl:import declares namespace "' + namespace + '" but the WSDL at "' + location + '" declares targetNamespace "' + tns + '" (WSDL 1.1 section 2.1.1 / WS-I Basic Profile 1.1 R2005)');
      }
      imported.push({ node: root, label: location });
    } else {
      warnings.push('SOAP_WSI_IMPORT_ROOT_INVALID: wsdl:import location "' + location + '" resolves to a <' + root.tag + '> root, not a WSDL definitions document (WS-I Basic Profile 1.1 R2001)');
    }
  }
  return imported;
}

function lintWsdl11Types(defs: XNode, warnings: string[]): { elements: Set<string>; schemasComplete: boolean } {
  const elements = new Set<string>();
  let schemasComplete = children(defs, 'import').length === 0;
  for (const types of children(defs, 'types')) {
    for (const child of types.children) {
      const name = local(child.tag);
      if (name === 'import') {
        warnings.push('SOAP_WSI_XSD_IMPORT_PLACEMENT: xsd:import must appear inside an xsd:schema under wsdl:types, not directly under wsdl:types (WS-I Basic Profile 1.1 R2003)');
        continue;
      }
      if (name !== 'schema') continue;
      const tns = attr(child, 'targetNamespace');
      const substantive = child.children.some((c) => local(c.tag) !== 'import' && local(c.tag) !== 'annotation');
      if ((tns === undefined || tns === '') && substantive) {
        warnings.push('SOAP_WSI_SCHEMA_TNS_MISSING: an xsd:schema under wsdl:types declares components without a targetNamespace (WS-I Basic Profile 1.1 R2105)');
      }
      if (children(child, 'import').length > 0 || children(child, 'include').length > 0 || children(child, 'redefine').length > 0) {
        schemasComplete = false;
      }
      for (const el of children(child, 'element')) {
        const elName = attr(el, 'name');
        if (elName) elements.add(elName);
      }
    }
  }
  return { elements, schemasComplete };
}

function collectMessages(defs: XNode, warnings: string[]): Map<string, WsdlMessagePart[]> {
  const messages = new Map<string, WsdlMessagePart[]>();
  for (const message of children(defs, 'message')) {
    const name = attr(message, 'name') ?? '';
    const parts: WsdlMessagePart[] = [];
    for (const part of children(message, 'part')) {
      const partName = attr(part, 'name') ?? '';
      const element = attr(part, 'element');
      const type = attr(part, 'type');
      if (element !== undefined && type !== undefined) {
        warnings.push('SOAP_WSI_PART_TYPE_AND_ELEMENT: message ' + name + ' part "' + partName + '" specifies both element and type; WS-I Basic Profile 1.1 R2306 requires exactly one');
      }
      parts.push({ name: partName, element, type });
    }
    if (name) messages.set(name, parts);
  }
  return messages;
}

function collectPortTypes(
  defs: XNode,
  messages: Map<string, WsdlMessagePart[]>,
  warnings: string[]
): Map<string, Map<string, PortTypeOperation>> {
  const portTypes = new Map<string, Map<string, PortTypeOperation>>();
  for (const portType of children(defs, 'portType')) {
    const ptName = attr(portType, 'name') ?? '';
    const ops = new Map<string, PortTypeOperation>();
    for (const op of children(portType, 'operation')) {
      const opName = attr(op, 'name') ?? '';
      if (ops.has(opName)) {
        warnings.push('SOAP_WSI_OPERATION_NAME_DUP: portType ' + ptName + ' declares operation "' + opName + '" more than once (WS-I Basic Profile 1.1 R2304)');
      }
      const ordered = op.children.map((c) => local(c.tag));
      const inputIdx = ordered.indexOf('input');
      const outputIdx = ordered.indexOf('output');
      if (inputIdx === -1 && outputIdx !== -1) {
        warnings.push('SOAP_WSI_OPERATION_MEP: portType ' + ptName + ' operation ' + opName + ' is a notification operation; WS-I Basic Profile 1.1 R2303 allows only one-way and request-response');
      } else if (inputIdx !== -1 && outputIdx !== -1 && outputIdx < inputIdx) {
        warnings.push('SOAP_WSI_OPERATION_MEP: portType ' + ptName + ' operation ' + opName + ' is a solicit-response operation; WS-I Basic Profile 1.1 R2303 allows only one-way and request-response');
      }
      const input = children(op, 'input')[0];
      const output = children(op, 'output')[0];
      let wsamAction: string | undefined;
      if (input) {
        for (const [k, v] of Object.entries(input.attrs)) {
          if (local(k) === 'Action') wsamAction = v;
        }
      }
      const record: PortTypeOperation = {
        name: opName,
        inputMessage: input ? local(attr(input, 'message') ?? '') : undefined,
        outputMessage: output ? local(attr(output, 'message') ?? '') : undefined,
        wsamAction
      };
      lintParameterOrder(op, ptName, record, messages, warnings);
      for (const fault of children(op, 'fault')) {
        const faultName = attr(fault, 'name') ?? '';
        const faultMessage = local(attr(fault, 'message') ?? '');
        const parts = messages.get(faultMessage);
        if (parts && (parts.length !== 1 || parts[0].type !== undefined)) {
          warnings.push('SOAP_WSI_FAULT_MESSAGE_PARTS: portType ' + ptName + ' operation ' + opName + ' fault "' + faultName + '" message must have exactly one element-defined part (WS-I Basic Profile 1.1 R2205)');
        }
      }
      ops.set(opName, record);
    }
    portTypes.set(ptName, ops);
  }
  return portTypes;
}

function lintParameterOrder(
  op: XNode,
  ptName: string,
  record: PortTypeOperation,
  messages: Map<string, WsdlMessagePart[]>,
  warnings: string[]
): void {
  const paramOrder = attr(op, 'parameterOrder');
  if (paramOrder === undefined) return;
  const tokens = paramOrder.split(/\s+/).filter(Boolean);
  const inParts = (record.inputMessage !== undefined ? messages.get(record.inputMessage) : undefined) ?? [];
  const outParts = (record.outputMessage !== undefined ? messages.get(record.outputMessage) : undefined) ?? [];
  const known = new Set([...inParts, ...outParts].map((p) => p.name));
  for (const token of tokens) {
    if (!known.has(token)) {
      warnings.push('SOAP_WSI_PARAMETER_ORDER: portType ' + ptName + ' operation ' + record.name + ' parameterOrder token "' + token + '" names no part of the input or output message (WSDL 1.1 section 2.4.6)');
    }
  }
  const omitted = outParts.filter((p) => !tokens.includes(p.name)).length;
  if (omitted > 1) {
    warnings.push('SOAP_WSI_PARAMETER_ORDER: portType ' + ptName + ' operation ' + record.name + ' parameterOrder omits ' + omitted + ' output parts; at most one (the return value) may be omitted (WSDL 1.1 section 2.4.6)');
  }
}

function lintWsdl11Bindings(
  defs: XNode,
  messages: Map<string, WsdlMessagePart[]>,
  portTypes: Map<string, Map<string, PortTypeOperation>>,
  warnings: string[]
): void {
  for (const binding of children(defs, 'binding')) {
    const bindingName = attr(binding, 'name') ?? '';
    const soapBinding = children(binding, 'binding')[0];
    if (!soapBinding) {
      warnings.push('SOAP_WSI_BINDING_NOT_SOAP: binding ' + bindingName + ' carries no soap:binding extension element; WS-I Basic Profile 1.1 R2401 requires the WSDL 1.1 SOAP binding');
      continue;
    }
    const transport = attr(soapBinding, 'transport');
    if (transport === undefined || transport === '') {
      warnings.push('SOAP_WSI_TRANSPORT_MISSING: binding ' + bindingName + ' soap:binding omits the transport attribute (WSDL 1.1 section 3.3)');
    }
    const bindingStyle = attr(soapBinding, 'style') ?? 'document';
    const ptOps = portTypes.get(local(attr(binding, 'type') ?? ''));
    for (const op of children(binding, 'operation')) {
      lintWsdl11BindingOperation(op, bindingName, bindingStyle, transport, ptOps, messages, warnings);
    }
  }
}

function lintWsdl11BindingOperation(
  op: XNode,
  bindingName: string,
  bindingStyle: string,
  transport: string | undefined,
  ptOps: Map<string, PortTypeOperation> | undefined,
  messages: Map<string, WsdlMessagePart[]>,
  warnings: string[]
): void {
  const opName = attr(op, 'name') ?? '';
  const soapOp = children(op, 'operation')[0];
  const style = (soapOp ? attr(soapOp, 'style') : undefined) ?? bindingStyle;
  const soapAction = soapOp ? attr(soapOp, 'soapAction') : undefined;
  const soapActionRequired = soapOp ? attr(soapOp, 'soapActionRequired') : undefined;
  if (soapActionRequired !== undefined && !/^(true|false|1|0)$/.test(soapActionRequired)) {
    warnings.push('SOAP_WSI_SOAPACTION_REQUIRED: binding ' + bindingName + ' operation ' + opName + ' soapActionRequired "' + soapActionRequired + '" is not a boolean (WSDL 1.1 section 3.4)');
  } else if (/^(true|1)$/.test(soapActionRequired ?? '') && (soapAction === undefined || soapAction === '')) {
    warnings.push('SOAP_WSI_SOAPACTION_REQUIRED: binding ' + bindingName + ' operation ' + opName + ' requires a SOAPAction (soapActionRequired=true) but declares none (WS-I Basic Profile 1.1 R2745)');
  }
  if (soapAction === undefined && (transport === undefined || transport === 'http://schemas.xmlsoap.org/soap/http')) {
    warnings.push('SOAP_WSI_SOAPACTION_MISSING: binding ' + bindingName + ' operation ' + opName + ' omits soapAction; HTTP SOAP bindings should declare it, and the wire value must be quoted (WS-I Basic Profile 1.1 R2744/R2745)');
  }
  const ptOp = ptOps?.get(opName);
  if (ptOp?.wsamAction !== undefined && ptOp.wsamAction !== '' && soapAction !== undefined && soapAction !== '' && ptOp.wsamAction !== soapAction) {
    warnings.push('SOAP_WSI_ACTION_MISMATCH: operation ' + opName + ' declares wsam:Action "' + ptOp.wsamAction + '" but soapAction "' + soapAction + '"; WS-Addressing Metadata section 4.4.1 requires them to be identical');
  }
  if (soapAction !== undefined && transport !== undefined && transport !== '' && transport !== SOAP_HTTP_TRANSPORT_URI) {
    warnings.push('SOAP_WSI_SOAPACTION_NON_HTTP: binding ' + bindingName + ' operation ' + opName + ' declares soapAction on a non-HTTP transport (' + transport + '); soapAction is defined only for the HTTP binding (WSDL 1.1 section 3.4)');
  }
  for (const direction of ['input', 'output'] as const) {
    const dirNode = children(op, direction)[0];
    if (!dirNode) continue;
    const messageName = ptOp ? (direction === 'input' ? ptOp.inputMessage : ptOp.outputMessage) : undefined;
    const parts = (messageName !== undefined ? messages.get(messageName) : undefined) ?? [];
    const bound = new Set<string>();
    const body = children(dirNode, 'body')[0];
    let bodyPartsAttr: string | undefined;
    if (body) {
      bodyPartsAttr = attr(body, 'parts');
      if (bodyPartsAttr !== undefined) {
        for (const token of bodyPartsAttr.split(/\s+/).filter(Boolean)) bound.add(token);
      } else if (style === 'document' && parts.length > 1) {
        warnings.push('SOAP_WSI_DOC_LITERAL_PARTS_OMITTED: binding ' + bindingName + ' operation ' + opName + ' ' + direction + ' soap:body omits parts while its message has ' + parts.length + ' parts; document-literal bodies bind at most one part (WS-I Basic Profile 1.1 R2201)');
      }
    }
    const headers = children(dirNode, 'header');
    const headerish: { node: XNode; kind: string }[] = headers.map((h) => ({ node: h, kind: 'soap:header' }));
    for (const header of headers) {
      for (const hf of children(header, 'headerfault')) headerish.push({ node: hf, kind: 'soap:headerfault' });
    }
    for (const { node, kind } of headerish) {
      lintHeaderish(node, kind, bindingName, opName, style, messages, messageName, bound, warnings);
    }
    if (bodyPartsAttr !== undefined && parts.length > 0) {
      const unboundNames = parts.filter((p) => !bound.has(p.name)).map((p) => p.name);
      if (unboundNames.length > 0) {
        warnings.push('SOAP_WSI_PART_UNBOUND: binding ' + bindingName + ' operation ' + opName + ' ' + direction + ' leaves message parts unbound (' + unboundNames.join(', ') + '); every part should be bound to body, header, or fault (WSDL 1.1 section 3.5)');
      }
    }
  }
  for (const fault of children(op, 'fault')) {
    const soapFault = children(fault, 'fault')[0];
    if (!soapFault) continue;
    if (attr(soapFault, 'name') === undefined) {
      warnings.push('SOAP_WSI_FAULT_BINDING: binding ' + bindingName + ' operation ' + opName + ' soap:fault omits its name attribute (WS-I Basic Profile 1.1 R2721)');
    }
    if (attr(soapFault, 'use') === 'encoded') {
      warnings.push('SOAP_WSI_ENCODED_USE: binding ' + bindingName + ' operation ' + opName + ' soap:fault uses use="encoded"; WS-I Basic Profile 1.1 R2706 requires literal use');
    }
    if (style === 'rpc' && attr(soapFault, 'namespace') !== undefined) {
      warnings.push('SOAP_WSI_RPC_NAMESPACE_ATTR: binding ' + bindingName + ' operation ' + opName + ' soap:fault carries a namespace attribute; rpc-literal bindings must not set namespace on header/headerfault/fault (WS-I Basic Profile 1.1 R2726)');
    }
    if (style === 'document' && attr(soapFault, 'namespace') !== undefined) {
      warnings.push('SOAP_WSI_LITERAL_NAMESPACE_ATTR: binding ' + bindingName + ' operation ' + opName + ' soap:fault carries a namespace attribute on a document-literal binding (WS-I Basic Profile 1.1 R2716)');
    }
  }
}

function lintHeaderish(
  node: XNode,
  kind: string,
  bindingName: string,
  opName: string,
  style: string,
  messages: Map<string, WsdlMessagePart[]>,
  boundMessageName: string | undefined,
  bound: Set<string>,
  warnings: string[]
): void {
  if (attr(node, 'parts') !== undefined) {
    warnings.push('SOAP_WSI_HEADER_PARTS_ATTR: binding ' + bindingName + ' operation ' + opName + ' ' + kind + ' uses a plural parts attribute; the SOAP binding defines a singular part of type NMTOKEN (WSDL 1.1 section 3.7)');
  }
  if (attr(node, 'use') === 'encoded') {
    warnings.push('SOAP_WSI_ENCODED_USE: binding ' + bindingName + ' operation ' + opName + ' ' + kind + ' uses use="encoded"; WS-I Basic Profile 1.1 R2706 requires literal use');
  }
  if (style === 'document' && attr(node, 'namespace') !== undefined) {
    warnings.push('SOAP_WSI_LITERAL_NAMESPACE_ATTR: binding ' + bindingName + ' operation ' + opName + ' ' + kind + ' carries a namespace attribute on a document-literal binding (WS-I Basic Profile 1.1 R2716)');
  }
  if (style === 'rpc' && attr(node, 'namespace') !== undefined) {
    warnings.push('SOAP_WSI_RPC_NAMESPACE_ATTR: binding ' + bindingName + ' operation ' + opName + ' ' + kind + ' carries a namespace attribute; rpc-literal bindings must not set namespace on header/headerfault/fault (WS-I Basic Profile 1.1 R2726)');
  }
  const declaredPart = attr(node, 'part');
  if (declaredPart === undefined || declaredPart === '') {
    warnings.push('SOAP_WSI_HEADER_PART_MISSING: binding ' + bindingName + ' operation ' + opName + ' ' + kind + ' omits its singular part attribute (WSDL 1.1 section 3.7)');
  } else if (!/^[\w.:-]+$/.test(declaredPart)) {
    warnings.push('SOAP_WSI_HEADER_PART_NMTOKEN: binding ' + bindingName + ' operation ' + opName + ' ' + kind + ' part "' + declaredPart + '" is not a single NMTOKEN (WSDL 1.1 section 3.7)');
  }
  const headerMessage = local(attr(node, 'message') ?? '');
  const headerPart = attr(node, 'part');
  if (headerMessage && headerPart !== undefined && headerPart !== '') {
    const part = messages.get(headerMessage)?.find((p) => p.name === headerPart);
    if (part && part.type !== undefined) {
      warnings.push('SOAP_WSI_HEADER_PART_NOT_ELEMENT: binding ' + bindingName + ' operation ' + opName + ' ' + kind + ' part "' + headerPart + '" is defined with type; header and fault parts must be defined with element (WS-I Basic Profile 1.1 R2205)');
    }
    if (headerMessage === boundMessageName) bound.add(headerPart);
  }
}

function lintWsdl11PartElements(
  defs: XNode,
  table: SchemaElementTable,
  complete: boolean,
  warnings: string[]
): void {
  if (!complete) return;
  const base = xmlnsScope(defs, {});
  for (const message of children(defs, 'message')) {
    const messageName = attr(message, 'name') ?? '';
    const msgScope = xmlnsScope(message, base);
    for (const part of children(message, 'part')) {
      const element = attr(part, 'element');
      if (element === undefined) continue;
      const scope = xmlnsScope(part, msgScope);
      const ns = qnameNamespace(element, scope);
      const names = table.byNamespace.get(ns);
      if (!names || !names.has(qnameLocal(element))) {
        warnings.push('SOAP_WSI_PART_ELEMENT_UNRESOLVED: message ' + messageName + ' part "' + (attr(part, 'name') ?? '') + '" references element "' + element + '" which no schema in scope declares as a global element (WSDL 1.1 section 2.3.1)');
      }
    }
  }
}

interface SchemaElementTable {
  byNamespace: Map<string, Set<string>>;
  complete: boolean;
}

/**
 * Global element declarations by target namespace, from inline schemas plus
 * resolver-supplied xsd:imports (followed recursively with cycle protection).
 * `complete` is false whenever any import/include/redefine could not be
 * resolved, which downgrades resolution checks rather than guessing.
 */
function collectSchemaElementTable(docs: XNode[], warnings: string[], resolveImport?: WsdlImportResolver): SchemaElementTable {
  const byNamespace = new Map<string, Set<string>>();
  let complete = true;
  const seenLocations = new Set<string>();
  const addElement = (ns: string, name: string): void => {
    const bucket = byNamespace.get(ns);
    if (bucket) bucket.add(name);
    else byNamespace.set(ns, new Set([name]));
  };
  const visitSchema = (schema: XNode): void => {
    const tns = attr(schema, 'targetNamespace') ?? '';
    for (const el of children(schema, 'element')) {
      const name = attr(el, 'name');
      if (name) addElement(tns, name);
    }
    if (children(schema, 'include').length > 0 || children(schema, 'redefine').length > 0) complete = false;
    for (const imp of children(schema, 'import')) {
      const location = attr(imp, 'schemaLocation');
      const namespace = attr(imp, 'namespace') ?? '';
      if (location === undefined || !resolveImport) { complete = false; continue; }
      if (seenLocations.has(location)) continue;
      seenLocations.add(location);
      const content = resolveImport(location);
      if (content === undefined) { complete = false; continue; }
      lintImportedXmlDeclaration(content, 'imported schema "' + location + '"', warnings);
      const root = parseImported(content);
      if (!root || local(root.tag) !== 'schema') {
        warnings.push('SOAP_WSI_XSD_IMPORT_ROOT: xsd:import schemaLocation "' + location + '" does not resolve to a document with an xsd:schema root (XML Schema part 1 section 4.2.3)');
        complete = false;
        continue;
      }
      const importedTns = attr(root, 'targetNamespace') ?? '';
      if (namespace !== importedTns) {
        warnings.push('SOAP_WSI_XSD_IMPORT_TNS_MISMATCH: xsd:import declares namespace "' + namespace + '" but the schema at "' + location + '" declares targetNamespace "' + importedTns + '" (XML Schema part 1 section 4.2.3)');
      }
      visitSchema(root);
    }
  };
  for (const doc of docs) {
    for (const types of children(doc, 'types')) {
      for (const child of types.children) {
        if (local(child.tag) === 'schema') visitSchema(child);
      }
    }
  }
  return { byNamespace, complete };
}

function qnameLocal(qname: string): string {
  return qname.includes(':') ? qname.slice(qname.indexOf(':') + 1) : qname;
}

/**
 * Namespace-aware WSDL QName resolution (WSDL 1.1 section 2.1.1): binding/@type,
 * port/@binding, portType message references, and soap:header/@message must
 * resolve to symbols declared under the referenced targetNamespace, across the
 * root document and every resolver-supplied wsdl:import.
 */
function lintWsdl11QNames(defs: XNode, imported: ImportedWsdl[], warnings: string[]): void {
  const symbols: Record<'message' | 'portType' | 'binding', Map<string, Set<string>>> = {
    message: new Map(),
    portType: new Map(),
    binding: new Map()
  };
  const knownNamespaces = new Set<string>();
  for (const node of [defs, ...imported.map((entry) => entry.node)]) {
    const tns = attr(node, 'targetNamespace') ?? '';
    knownNamespaces.add(tns);
    for (const kind of ['message', 'portType', 'binding'] as const) {
      const bucket = symbols[kind].get(tns) ?? new Set<string>();
      for (const child of children(node, kind)) {
        const name = attr(child, 'name');
        if (name) bucket.add(name);
      }
      symbols[kind].set(tns, bucket);
    }
  }
  const check = (qname: string | undefined, kind: 'message' | 'portType' | 'binding', scope: Record<string, string>, context: string): void => {
    if (qname === undefined || qname === '') return;
    const ns = qnameNamespace(qname, scope);
    const name = qnameLocal(qname);
    if (!knownNamespaces.has(ns)) {
      warnings.push('SOAP_WSI_QNAME_NAMESPACE_UNKNOWN: ' + context + ' references ' + kind + ' "' + qname + '" in namespace "' + ns + '", which no available WSDL document declares as its targetNamespace (WSDL 1.1 section 2.1.1)');
      return;
    }
    if (!symbols[kind].get(ns)?.has(name)) {
      warnings.push('SOAP_WSI_QNAME_UNRESOLVED: ' + context + ' references ' + kind + ' "' + qname + '" which is not declared in namespace "' + ns + '" (WSDL 1.1 section 2.1.1)');
    }
  };
  const base = xmlnsScope(defs, {});
  for (const portType of children(defs, 'portType')) {
    const ptScope = xmlnsScope(portType, base);
    const ptName = attr(portType, 'name') ?? '';
    for (const op of children(portType, 'operation')) {
      const opScope = xmlnsScope(op, ptScope);
      for (const dir of ['input', 'output', 'fault'] as const) {
        for (const dirNode of children(op, dir)) {
          check(attr(dirNode, 'message'), 'message', xmlnsScope(dirNode, opScope), 'portType ' + ptName + ' operation ' + (attr(op, 'name') ?? '') + ' ' + dir);
        }
      }
    }
  }
  for (const binding of children(defs, 'binding')) {
    const bScope = xmlnsScope(binding, base);
    const bName = attr(binding, 'name') ?? '';
    check(attr(binding, 'type'), 'portType', bScope, 'binding ' + bName);
    for (const op of children(binding, 'operation')) {
      const oScope = xmlnsScope(op, bScope);
      const oName = attr(op, 'name') ?? '';
      for (const dir of ['input', 'output'] as const) {
        const dirNode = children(op, dir)[0];
        if (!dirNode) continue;
        const dScope = xmlnsScope(dirNode, oScope);
        for (const header of children(dirNode, 'header')) {
          const hScope = xmlnsScope(header, dScope);
          check(attr(header, 'message'), 'message', hScope, 'binding ' + bName + ' operation ' + oName + ' soap:header');
          for (const hf of children(header, 'headerfault')) {
            check(attr(hf, 'message'), 'message', xmlnsScope(hf, hScope), 'binding ' + bName + ' operation ' + oName + ' soap:headerfault');
          }
        }
      }
    }
  }
  for (const service of children(defs, 'service')) {
    const sScope = xmlnsScope(service, base);
    for (const port of children(service, 'port')) {
      check(attr(port, 'binding'), 'binding', xmlnsScope(port, sScope), 'service ' + (attr(service, 'name') ?? '') + ' port ' + (attr(port, 'name') ?? ''));
    }
  }
}

// R2003: xsd:import belongs directly inside an xsd:schema. The types-level
// check catches the direct-under-types case; this ancestor-aware pass catches
// imports nested anywhere else (inside complexType, wsdl:message, ...).
function lintXsdImportPlacement(defs: XNode, warnings: string[]): void {
  const visit = (node: XNode, parentLocal: string): void => {
    for (const child of node.children) {
      const childLocal = local(child.tag);
      if (childLocal === 'import' && parentLocal !== 'definitions' && parentLocal !== 'schema' && parentLocal !== 'types') {
        warnings.push('SOAP_WSI_XSD_IMPORT_PLACEMENT: an import element appears under ' + parentLocal + '; xsd:import must be a direct child of xsd:schema (WS-I Basic Profile 1.1 R2003)');
      }
      visit(child, childLocal);
    }
  };
  visit(defs, 'definitions');
}

function lintWsdl11Services(defs: XNode, warnings: string[]): void {
  // binding local name -> declared soap:binding transport URI, for scheme
  // correspondence between the port address and its binding transport.
  const transports = new Map<string, string | undefined>();
  for (const binding of children(defs, 'binding')) {
    const soapBinding = children(binding, 'binding')[0];
    transports.set(attr(binding, 'name') ?? '', soapBinding ? attr(soapBinding, 'transport') : undefined);
  }
  for (const service of children(defs, 'service')) {
    for (const port of children(service, 'port')) {
      const portName = attr(port, 'name') ?? '';
      const addresses = children(port, 'address');
      if (addresses.length === 0) {
        warnings.push('SOAP_WSI_PORT_ADDRESS_COUNT: port ' + portName + ' declares no soap:address element; a SOAP port carries exactly one (WSDL 1.1 section 3.8 / WS-I Basic Profile 1.1 R2711)');
      } else if (addresses.length > 1) {
        warnings.push('SOAP_WSI_PORT_ADDRESS_COUNT: port ' + portName + ' declares ' + addresses.length + ' soap:address elements; exactly one is allowed (WSDL 1.1 section 3.8)');
      }
      const transport = transports.get(local(attr(port, 'binding') ?? ''));
      const location = addresses[0] ? attr(addresses[0], 'location') : undefined;
      if (location !== undefined && transport === SOAP_HTTP_TRANSPORT_URI && !/^https?:\/\//i.test(location)) {
        warnings.push('SOAP_WSI_ADDRESS_SCHEME: port ' + portName + ' soap:address location "' + location + '" does not use the http or https scheme required by the declared HTTP transport (WS-I Basic Profile 1.1 R2702)');
      }
    }
  }
}

const KNOWN_WSDL_LOCALS = new Set([
  'definitions', 'documentation', 'import', 'types', 'message', 'part', 'portType', 'operation',
  'input', 'output', 'fault', 'binding', 'service', 'port', 'address', 'body', 'header',
  'headerfault', 'schema', 'element', 'complexType', 'simpleType', 'annotation', 'include',
  'attribute', 'sequence', 'all', 'choice', 'any'
]);

function lintRequiredExtensions(defs: XNode, warnings: string[]): void {
  walk(defs, (node) => {
    const required = Object.entries(node.attrs).find(([k]) => local(k) === 'required');
    if (!required || !/^(true|1)$/.test(required[1])) return;
    if (!KNOWN_WSDL_LOCALS.has(local(node.tag))) {
      warnings.push('SOAP_WSI_REQUIRED_EXTENSION: extension element ' + node.tag + ' is marked wsdl:required="true" but is not understood by this generator; WSDL 1.1 section 2.1.3 makes required extensions mandatory to honor');
    }
  });
}

function dupCheck(nodes: XNode[], kind: string, warnings: string[]): void {
  const seen = new Set<string>();
  for (const node of nodes) {
    const name = attr(node, 'name') ?? '';
    if (name && seen.has(name)) {
      warnings.push('SOAP_WSDL20_SYMBOL_DUP: ' + kind + ' name "' + name + '" is declared more than once; WSDL 2.0 top-level component names are unique per kind (WSDL 2.0 section 2.1.2)');
    }
    seen.add(name);
  }
}

function checkElementToken(value: string | undefined, context: string, code: string, warnings: string[]): void {
  if (value === undefined) return;
  if (value === '#any' || value === '#none' || value === '#other') return;
  if (value.startsWith('#')) {
    warnings.push(code + ': ' + context + ' element token "' + value + '" is not #any, #none, #other, or an element QName (WSDL 2.0 section 2.5.1)');
  }
}

function closureOf(map: Map<string, Set<string>>, extendsMap: Map<string, string[]>, start: string): Set<string> {
  const out = new Set<string>(map.get(start) ?? []);
  const stack = [...(extendsMap.get(start) ?? [])];
  const seen = new Set<string>([start]);
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined || seen.has(cur)) continue;
    seen.add(cur);
    for (const item of map.get(cur) ?? []) out.add(item);
    stack.push(...(extendsMap.get(cur) ?? []));
  }
  return out;
}

function lintWsdl20(description: XNode, warnings: string[], resolveImport?: WsdlImportResolver): void {
  const interfaces = children(description, 'interface');
  const bindings = children(description, 'binding');
  const services = children(description, 'service');
  dupCheck(interfaces, 'interface', warnings);
  dupCheck(bindings, 'binding', warnings);
  dupCheck(services, 'service', warnings);
  lintWsdl20Structure(description, warnings);
  lintWsdl20ImportsIncludes(description, warnings, resolveImport);
  if (services.length === 0) {
    warnings.push('SOAP_WSDL20_SERVICE: the description declares no service; operations are surfaced from a synthesized service and endpoint URLs stay placeholders (WSDL 2.0 section 2.14)');
  }

  const extendsMap = new Map<string, string[]>();
  for (const iface of interfaces) {
    const name = attr(iface, 'name') ?? '';
    const ext = (attr(iface, 'extends') ?? '').split(/\s+/).filter(Boolean).map(local);
    if (new Set(ext).size !== ext.length) {
      warnings.push('SOAP_WSDL20_EXTENDS: interface ' + name + ' lists a duplicate QName in extends (WSDL 2.0 section 2.2.1)');
    }
    extendsMap.set(name, ext);
  }
  for (const start of extendsMap.keys()) {
    const stack = [...(extendsMap.get(start) ?? [])];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur === start) {
        warnings.push('SOAP_WSDL20_EXTENDS: interface ' + start + ' participates in a circular extends graph (WSDL 2.0 section 2.2.1)');
        break;
      }
      if (cur === undefined || seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(extendsMap.get(cur) ?? []));
    }
  }

  const interfaceOps = new Map<string, Set<string>>();
  const interfaceFaults = new Map<string, Set<string>>();
  const pendingFaultRefs: { iface: string; op: string; ref: string }[] = [];
  for (const iface of interfaces) {
    const ifName = attr(iface, 'name') ?? '';
    const ops = new Set<string>();
    const faults = new Set<string>();
    for (const fault of children(iface, 'fault')) {
      const fName = attr(fault, 'name') ?? '';
      if (faults.has(fName)) {
        warnings.push('SOAP_WSDL20_SYMBOL_DUP: interface ' + ifName + ' fault name "' + fName + '" is not unique (WSDL 2.0 section 2.3.1)');
      }
      faults.add(fName);
      checkElementToken(attr(fault, 'element'), 'interface ' + ifName + ' fault ' + fName, 'SOAP_WSDL20_FAULT_ELEMENT', warnings);
    }
    for (const op of children(iface, 'operation')) {
      const opName = attr(op, 'name') ?? '';
      if (ops.has(opName)) {
        warnings.push('SOAP_WSDL20_SYMBOL_DUP: interface ' + ifName + ' operation name "' + opName + '" is not unique (WSDL 2.0 section 2.4.1)');
      }
      ops.add(opName);
      const pattern = attr(op, 'pattern');
      if (pattern !== undefined && !isAbsoluteUri(pattern)) {
        warnings.push('SOAP_WSDL20_OPERATION_PATTERN: interface ' + ifName + ' operation ' + opName + ' pattern "' + pattern + '" must be an absolute IRI (WSDL 2.0 section 2.4.1)');
      }
      for (const styleToken of (attr(op, 'style') ?? '').split(/\s+/).filter(Boolean)) {
        if (!isAbsoluteUri(styleToken)) {
          warnings.push('SOAP_WSDL20_OPERATION_PATTERN: interface ' + ifName + ' operation ' + opName + ' style token "' + styleToken + '" must be an absolute IRI (WSDL 2.0 section 2.4.1)');
        }
      }
      for (const io of ['input', 'output'] as const) {
        for (const node of children(op, io)) {
          checkElementToken(attr(node, 'element'), 'interface ' + ifName + ' operation ' + opName + ' ' + io, 'SOAP_WSDL20_MESSAGE_CONTENT', warnings);
        }
      }
      lintWsdl20MepShape(op, ifName, opName, pattern, warnings);      for (const fr of [...children(op, 'infault'), ...children(op, 'outfault')]) {
        const ref = attr(fr, 'ref');
        if (ref !== undefined) pendingFaultRefs.push({ iface: ifName, op: opName, ref });
      }
    }
    interfaceOps.set(ifName, ops);
    interfaceFaults.set(ifName, faults);
  }
  for (const pending of pendingFaultRefs) {
    const all = closureOf(interfaceFaults, extendsMap, pending.iface);
    if (!all.has(local(pending.ref))) {
      warnings.push('SOAP_WSDL20_FAULT_REF: interface ' + pending.iface + ' operation ' + pending.op + ' references fault "' + pending.ref + '" which is not declared on the interface or its ancestors (WSDL 2.0 section 2.6.1)');
    }
  }

  lintWsdl20Bindings(bindings, interfaceOps, interfaceFaults, extendsMap, warnings);
  lintWsdl20Services(services, interfaces, bindings, warnings);
  lintWsdl20ElementResolution(description, collectSchemaElementTable([description], warnings, resolveImport), warnings);
  lintWsdl20InheritedCollisions(interfaceOps, extendsMap, warnings);
  lintWsdl20Policies(description, warnings);
  for (const iface of interfaces) {
    walk(iface, (node) => {
      if (local(node.tag) === 'Addressing') {
        warnings.push('SOAP_WSDL20_ADDRESSING_PLACEMENT: interface ' + (attr(iface, 'name') ?? '') + ' attaches a wsam:Addressing policy; WS-Addressing Metadata section 3.1 attaches Addressing at endpoint or binding, not interface');
      }
    });
  }
}

const WSDL20_REQUIRED_ATTRS: Record<string, string[]> = {
  interface: ['name'],
  binding: ['name', 'type'],
  service: ['name', 'interface']
};

// Pinned structural pass over the WSDL 2.0 content model: required attributes
// on top-level components, pattern on interface operations, ref on binding
// operations (WSDL 2.0 sections 2.2-2.15).
function lintWsdl20Structure(description: XNode, warnings: string[]): void {
  for (const [kind, attrs] of Object.entries(WSDL20_REQUIRED_ATTRS)) {
    for (const node of children(description, kind)) {
      for (const required of attrs) {
        if (attr(node, required) === undefined) {
          warnings.push('SOAP_WSDL20_STRUCTURE: a ' + kind + ' element omits its required ' + required + ' attribute (WSDL 2.0 component model)');
        }
      }
    }
  }
  for (const service of children(description, 'service')) {
    for (const endpoint of children(service, 'endpoint')) {
      for (const required of ['name', 'binding']) {
        if (attr(endpoint, required) === undefined) {
          warnings.push('SOAP_WSDL20_STRUCTURE: service ' + (attr(service, 'name') ?? '') + ' has an endpoint omitting its required ' + required + ' attribute (WSDL 2.0 section 2.15.1)');
        }
      }
    }
  }
  for (const iface of children(description, 'interface')) {
    for (const op of children(iface, 'operation')) {
      if (attr(op, 'pattern') === undefined) {
        warnings.push('SOAP_WSDL20_STRUCTURE: interface ' + (attr(iface, 'name') ?? '') + ' operation ' + (attr(op, 'name') ?? '') + ' omits its required message exchange pattern attribute (WSDL 2.0 section 2.4.1)');
      }
    }
  }
  for (const binding of children(description, 'binding')) {
    for (const op of children(binding, 'operation')) {
      if (attr(op, 'ref') === undefined) {
        warnings.push('SOAP_WSDL20_STRUCTURE: binding ' + (attr(binding, 'name') ?? '') + ' operation omits its required ref attribute (WSDL 2.0 section 2.10.1)');
      }
    }
  }
}

function lintWsdl20ImportsIncludes(description: XNode, warnings: string[], resolveImport?: WsdlImportResolver): void {
  const ownTns = attr(description, 'targetNamespace') ?? '';
  for (const imp of children(description, 'import')) {
    const namespace = attr(imp, 'namespace');
    if (namespace === undefined || !isAbsoluteUri(namespace)) {
      warnings.push('SOAP_WSDL20_IMPORT: wsdl:import requires an absolute namespace IRI (WSDL 2.0 section 4.2)');
    } else if (namespace === ownTns) {
      warnings.push('SOAP_WSDL20_IMPORT: wsdl:import namespace equals the importing targetNamespace; same-namespace components are combined with wsdl:include, not wsdl:import (WSDL 2.0 section 4.2)');
    }
    const location = attr(imp, 'location');
    if (location === undefined || location === '' || !resolveImport) continue;
    const content = resolveImport(location);
    if (content === undefined) continue;
    lintImportedXmlDeclaration(content, 'imported WSDL "' + location + '"', warnings);
    const root = parseImported(content);
    if (!root || local(root.tag) !== 'description') {
      warnings.push('SOAP_WSDL20_IMPORT: wsdl:import location "' + location + '" does not resolve to a WSDL 2.0 description document (WSDL 2.0 section 4.2)');
    } else if (namespace !== undefined && (attr(root, 'targetNamespace') ?? '') !== namespace) {
      warnings.push('SOAP_WSDL20_IMPORT: wsdl:import declares namespace "' + namespace + '" but the description at "' + location + '" declares targetNamespace "' + (attr(root, 'targetNamespace') ?? '') + '" (WSDL 2.0 section 4.2)');
    }
  }
  for (const inc of children(description, 'include')) {
    const location = attr(inc, 'location');
    if (location === undefined || location === '') {
      warnings.push('SOAP_WSDL20_IMPORT: wsdl:include requires a location attribute (WSDL 2.0 section 4.1)');
      continue;
    }
    if (!resolveImport) continue;
    const content = resolveImport(location);
    if (content === undefined) continue;
    lintImportedXmlDeclaration(content, 'included WSDL "' + location + '"', warnings);
    const root = parseImported(content);
    if (!root || local(root.tag) !== 'description') {
      warnings.push('SOAP_WSDL20_IMPORT: wsdl:include location "' + location + '" does not resolve to a WSDL 2.0 description document (WSDL 2.0 section 4.1)');
    } else if ((attr(root, 'targetNamespace') ?? '') !== ownTns) {
      warnings.push('SOAP_WSDL20_IMPORT: wsdl:include at "' + location + '" declares targetNamespace "' + (attr(root, 'targetNamespace') ?? '') + '"; include requires the including namespace "' + ownTns + '" (WSDL 2.0 section 4.1)');
    }
  }
}

const WSDL20_MEP_BASE = 'http://www.w3.org/ns/wsdl/';
const WSDL20_MEP_RULES: Record<string, { input: [number, number]; output: [number, number]; infault: boolean; outfault: boolean }> = {
  'in-only': { input: [1, 1], output: [0, 0], infault: false, outfault: false },
  'robust-in-only': { input: [1, 1], output: [0, 0], infault: true, outfault: false },
  'in-out': { input: [1, 1], output: [1, 1], infault: true, outfault: true },
  'in-opt-out': { input: [1, 1], output: [0, 1], infault: true, outfault: true },
  'out-only': { input: [0, 0], output: [1, 1], infault: false, outfault: false },
  'robust-out-only': { input: [0, 0], output: [1, 1], infault: false, outfault: true },
  'out-in': { input: [1, 1], output: [1, 1], infault: true, outfault: true },
  'out-opt-in': { input: [0, 1], output: [1, 1], infault: true, outfault: true }
};

// MEP placeholder shape, message labels, fault propagation directions, and
// style input constraints for one interface operation (WSDL 2.0 Adjuncts
// sections 2 and 4-6).
function lintWsdl20MepShape(op: XNode, ifName: string, opName: string, pattern: string | undefined, warnings: string[]): void {
  const label = 'interface ' + ifName + ' operation ' + opName;
  const inputs = children(op, 'input');
  const outputs = children(op, 'output');
  for (const [dir, nodes, expected] of [['input', inputs, 'In'], ['output', outputs, 'Out']] as const) {
    for (const node of nodes) {
      const messageLabel = attr(node, 'messageLabel');
      if (messageLabel !== undefined && messageLabel !== expected) {
        warnings.push('SOAP_WSDL20_MESSAGE_LABEL: ' + label + ' ' + dir + ' messageLabel "' + messageLabel + '" does not match the predefined placeholder label "' + expected + '" (WSDL 2.0 Adjuncts section 2.2)');
      }
    }
  }
  const seenFaultRefs = new Set<string>();
  for (const dir of ['infault', 'outfault'] as const) {
    for (const faultRef of children(op, dir)) {
      const key = dir + '|' + (attr(faultRef, 'ref') ?? '') + '|' + (attr(faultRef, 'messageLabel') ?? '');
      if (seenFaultRefs.has(key)) {
        warnings.push('SOAP_WSDL20_FAULT_REF: ' + label + ' repeats ' + dir + ' "' + (attr(faultRef, 'ref') ?? '') + '" with the same messageLabel; (fault, messageLabel) pairs must be unique (WSDL 2.0 section 2.6.1)');
      }
      seenFaultRefs.add(key);
    }
  }
  if (pattern !== undefined && pattern.startsWith(WSDL20_MEP_BASE)) {
    const rule = WSDL20_MEP_RULES[pattern.slice(WSDL20_MEP_BASE.length)];
    if (!rule) {
      warnings.push('SOAP_WSDL20_MEP_SHAPE: ' + label + ' pattern "' + pattern + '" is not one of the eight predefined WSDL 2.0 MEPs; its placeholder shape is not asserted (WSDL 2.0 Adjuncts section 2.2)');
    } else {
      const within = (count: number, [lo, hi]: [number, number]) => count >= lo && count <= hi;
      if (!within(inputs.length, rule.input)) {
        warnings.push('SOAP_WSDL20_MEP_SHAPE: ' + label + ' declares ' + inputs.length + ' input placeholder(s) but MEP ' + pattern + ' allows between ' + rule.input[0] + ' and ' + rule.input[1] + ' (WSDL 2.0 Adjuncts section 2.2)');
      }
      if (!within(outputs.length, rule.output)) {
        warnings.push('SOAP_WSDL20_MEP_SHAPE: ' + label + ' declares ' + outputs.length + ' output placeholder(s) but MEP ' + pattern + ' allows between ' + rule.output[0] + ' and ' + rule.output[1] + ' (WSDL 2.0 Adjuncts section 2.2)');
      }
      if (!rule.infault && children(op, 'infault').length > 0) {
        warnings.push('SOAP_WSDL20_MEP_SHAPE: ' + label + ' declares an infault but MEP ' + pattern + ' propagates no fault in that direction (WSDL 2.0 Adjuncts section 2.1)');
      }
      if (!rule.outfault && children(op, 'outfault').length > 0) {
        warnings.push('SOAP_WSDL20_MEP_SHAPE: ' + label + ' declares an outfault but MEP ' + pattern + ' propagates no fault in that direction (WSDL 2.0 Adjuncts section 2.1)');
      }
    }
  }
  for (const style of (attr(op, 'style') ?? '').split(/\s+/).filter(Boolean)) {
    if (/\/wsdl\/style\/(rpc|iri|multipart)$/.test(style)) {
      const inputWithoutElement = inputs.some((node) => {
        const element = attr(node, 'element');
        return element === undefined || element.startsWith('#');
      });
      if (inputWithoutElement) {
        warnings.push('SOAP_WSDL20_STYLE_CONSTRAINT: ' + label + ' declares style ' + style + ' but an input carries no global element declaration; the RPC/IRI/Multipart styles constrain the input content model (WSDL 2.0 Adjuncts sections 4-6)');
      }
    }
  }
}

function lintWsdl20ElementResolution(description: XNode, table: SchemaElementTable, warnings: string[]): void {
  if (!table.complete) return;
  const base = xmlnsScope(description, {});
  const resolve = (value: string | undefined, scope: Record<string, string>, context: string): void => {
    if (value === undefined || value === '' || value.startsWith('#')) return;
    const ns = qnameNamespace(value, scope);
    const bucket = table.byNamespace.get(ns);
    if (!bucket || !bucket.has(qnameLocal(value))) {
      warnings.push('SOAP_WSDL20_ELEMENT_UNRESOLVED: ' + context + ' references element "' + value + '" which no schema in scope declares as a global element (WSDL 2.0 section 3.1)');
    }
  };
  for (const iface of children(description, 'interface')) {
    const ifScope = xmlnsScope(iface, base);
    const ifName = attr(iface, 'name') ?? '';
    for (const fault of children(iface, 'fault')) {
      resolve(attr(fault, 'element'), xmlnsScope(fault, ifScope), 'interface ' + ifName + ' fault ' + (attr(fault, 'name') ?? ''));
    }
    for (const op of children(iface, 'operation')) {
      const opScope = xmlnsScope(op, ifScope);
      for (const dir of ['input', 'output'] as const) {
        for (const node of children(op, dir)) {
          resolve(attr(node, 'element'), xmlnsScope(node, opScope), 'interface ' + ifName + ' operation ' + (attr(op, 'name') ?? '') + ' ' + dir);
        }
      }
    }
  }
}

// WSDL 2.0 section 2.2.1: an operation inherited through multiple extends
// paths must be the equivalent component; equivalence cannot be proven from a
// single document, so multi-parent collisions are surfaced for review.
function lintWsdl20InheritedCollisions(interfaceOps: Map<string, Set<string>>, extendsMap: Map<string, string[]>, warnings: string[]): void {
  for (const [ifName, ext] of extendsMap) {
    if (ext.length === 0) continue;
    const lineage = new Set<string>([ifName]);
    const stack = [...ext];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (lineage.has(cur)) continue;
      lineage.add(cur);
      stack.push(...(extendsMap.get(cur) ?? []));
    }
    const owners = new Map<string, string[]>();
    for (const ancestor of lineage) {
      for (const opName of interfaceOps.get(ancestor) ?? []) {
        const list = owners.get(opName);
        if (list) list.push(ancestor);
        else owners.set(opName, [ancestor]);
      }
    }
    for (const [opName, list] of owners) {
      if (list.length > 1) {
        warnings.push('SOAP_WSDL20_INHERITED_OP_COLLISION: interface ' + ifName + ' sees operation "' + opName + '" from multiple interfaces (' + list.sort().join(', ') + '); WSDL 2.0 section 2.2.1 requires colliding components to be equivalent, which cannot be proven from names alone');
      }
    }
  }
}

function lintWsdl20Policies(description: XNode, warnings: string[]): void {
  walk(description, (node) => {
    const name = local(node.tag);
    if (name === 'PolicyReference' && attr(node, 'URI') === undefined) {
      warnings.push('SOAP_WSDL20_POLICY: wsp:PolicyReference omits its URI attribute (WS-Policy Attachment section 3.2)');
    }
    if (name === 'All' || name === 'Policy') {
      const kids = node.children.map((child) => local(child.tag));
      if (kids.includes('AnonymousResponses') && kids.includes('NonAnonymousResponses')) {
        warnings.push('SOAP_WSDL20_POLICY: a policy alternative asserts both wsam:AnonymousResponses and wsam:NonAnonymousResponses; WS-Addressing Metadata section 3.2 makes them mutually exclusive within one alternative');
      }
    }
  });
}


function lintWsdl20Bindings(
  bindings: XNode[],
  interfaceOps: Map<string, Set<string>>,
  interfaceFaults: Map<string, Set<string>>,
  extendsMap: Map<string, string[]>,
  warnings: string[]
): void {
  for (const binding of bindings) {
    const name = attr(binding, 'name') ?? '';
    const opRefs = children(binding, 'operation');
    const faultRefs = children(binding, 'fault');
    const ifaceAttr = attr(binding, 'interface');
    if ((opRefs.length > 0 || faultRefs.length > 0) && ifaceAttr === undefined) {
      warnings.push('SOAP_WSDL20_BINDING_INTERFACE: binding ' + name + ' has operation or fault details but names no interface (WSDL 2.0 section 2.9.1)');
    }
    const type = attr(binding, 'type');
    if (type !== undefined && !isAbsoluteUri(type)) {
      warnings.push('SOAP_WSDL20_BINDING_TYPE: binding ' + name + ' type "' + type + '" must be an absolute IRI (WSDL 2.0 section 2.9.1)');
    }
    const wsoapVersion = attr(binding, 'version');
    if (wsoapVersion !== undefined && wsoapVersion !== '1.2') {
      warnings.push('SOAP_WSDL20_SOAP_VERSION: binding ' + name + ' wsoap:version "' + wsoapVersion + '" is unsupported; the WSDL 2.0 SOAP binding defaults to 1.2 and this generator emits SOAP 1.2 assertions only (WSDL 2.0 Adjuncts section 5.10.1)');
    }
    const mepDefault = attr(binding, 'mepDefault');
    if (mepDefault !== undefined && !isAbsoluteUri(mepDefault)) {
      warnings.push('SOAP_WSDL20_IRI_RELATIVE: binding ' + name + ' wsoap:mepDefault "' + mepDefault + '" must be an absolute IRI (WSDL 2.0 Adjuncts section 5.10.3)');
    }
    for (const module of children(binding, 'module')) {
      const ref = attr(module, 'ref');
      if (ref !== undefined && !isAbsoluteUri(ref)) {
        warnings.push('SOAP_WSDL20_MODULE: binding ' + name + ' wsoap:module ref "' + ref + '" must be an absolute IRI (WSDL 2.0 Adjuncts section 5.10.4)');
      }
      const required = attr(module, 'required');
      if (required === 'true' || required === '1') {
        warnings.push('SOAP_WSDL20_MODULE: binding ' + name + ' requires SOAP module ' + (ref ?? '<unnamed>') + ' which this generator does not implement; required modules gate generation (WSDL 2.0 Adjuncts section 5.10.4)');
      }
    }
    const scope = ifaceAttr !== undefined ? closureOf(interfaceOps, extendsMap, local(ifaceAttr)) : undefined;
    const wsdl20SoapType = 'http://www.w3.org/ns/wsdl/soap';
    if (type !== undefined && isAbsoluteUri(type) && type !== wsdl20SoapType && type !== 'http://www.w3.org/ns/wsdl/http') {
      warnings.push('SOAP_WSDL20_BINDING_TYPE_UNSUPPORTED: binding ' + name + ' type "' + type + '" is neither the WSDL 2.0 SOAP nor HTTP binding; its extension rules are not asserted (WSDL 2.0 Adjuncts sections 5-6)');
    }
    const protocol = attr(binding, 'protocol');
    if (protocol !== undefined && !isAbsoluteUri(protocol)) {
      warnings.push('SOAP_WSDL20_IRI_RELATIVE: binding ' + name + ' wsoap:protocol "' + protocol + '" must be an absolute IRI (WSDL 2.0 Adjuncts section 5.10.1)');
    } else if (protocol !== undefined && protocol !== 'http://www.w3.org/2003/05/soap/bindings/HTTP/') {
      warnings.push('SOAP_WSDL20_PROTOCOL_NOT_HTTP: binding ' + name + ' wsoap:protocol "' + protocol + '" is not the SOAP 1.2 HTTP binding; the generated collection executes over HTTP only (WSDL 2.0 Adjuncts section 5.10.1)');
    }
    const faultScope = ifaceAttr !== undefined ? closureOf(interfaceFaults, extendsMap, local(ifaceAttr)) : undefined;
    const qnameLexical = /^[\w.-]+(:[\w.-]+)?$/;
    for (const boundFault of faultRefs) {
      const ref = attr(boundFault, 'ref');
      if (ref !== undefined && faultScope && !faultScope.has(local(ref))) {
        warnings.push('SOAP_WSDL20_BINDING_FAULT_UNRESOLVED: binding ' + name + ' fault ref "' + ref + '" resolves to no fault on interface ' + ifaceAttr + ' or its ancestors (WSDL 2.0 section 2.11.1)');
      }
      const code = attr(boundFault, 'code');
      if (code !== undefined && code !== '#any' && !qnameLexical.test(code)) {
        warnings.push('SOAP_WSDL20_FAULT_CODE: binding ' + name + ' fault ' + (ref ?? '') + ' wsoap:code "' + code + '" must be "#any" or an xs:QName (WSDL 2.0 Adjuncts section 5.5.6)');
      }
      const subcodes = attr(boundFault, 'subcodes');
      if (subcodes !== undefined && subcodes !== '#any' && subcodes.split(/\s+/).filter(Boolean).some((token) => !qnameLexical.test(token))) {
        warnings.push('SOAP_WSDL20_FAULT_CODE: binding ' + name + ' fault ' + (ref ?? '') + ' wsoap:subcodes "' + subcodes + '" must be "#any" or a list of xs:QName (WSDL 2.0 Adjuncts section 5.5.7)');
      }
    }
    for (const boundOp of opRefs) {
      const opLabel = attr(boundOp, 'ref') ?? '';
      for (const dir of ['input', 'output'] as const) {
        const refs = children(boundOp, dir);
        if (refs.length > 1) {
          warnings.push('SOAP_WSDL20_BINDING_MESSAGE_REF: binding ' + name + ' operation "' + opLabel + '" declares ' + refs.length + ' ' + dir + ' message references; the predefined MEPs carry at most one per direction (WSDL 2.0 section 2.10.1)');
        }
      }
      for (const dir of ['infault', 'outfault'] as const) {
        for (const faultRef of children(boundOp, dir)) {
          const ref = attr(faultRef, 'ref');
          if (ref !== undefined && faultScope && !faultScope.has(local(ref))) {
            warnings.push('SOAP_WSDL20_BINDING_FAULT_UNRESOLVED: binding ' + name + ' operation "' + opLabel + '" ' + dir + ' ref "' + ref + '" resolves to no interface fault (WSDL 2.0 section 2.12.1)');
          }
        }
      }
      for (const scopeNode of [...children(boundOp, 'input'), ...children(boundOp, 'output'), ...children(boundOp, 'infault'), ...children(boundOp, 'outfault')]) {
        for (const mod of children(scopeNode, 'module')) {
          const ref = attr(mod, 'ref');
          if (ref === undefined || !isAbsoluteUri(ref)) {
            warnings.push('SOAP_WSDL20_MODULE: binding ' + name + ' operation "' + opLabel + '" declares a wsoap:module without an absolute-IRI ref (WSDL 2.0 Adjuncts section 5.4.1)');
          }
        }
      }
    }
    const seenRefs = new Set<string>();
    for (const opRef of opRefs) {
      const ref = attr(opRef, 'ref');
      if (ref === undefined) continue;
      const refLocal = local(ref);
      if (seenRefs.has(refLocal)) {
        warnings.push('SOAP_WSDL20_BINDING_OP_UNRESOLVED: binding ' + name + ' binds operation "' + ref + '" more than once (WSDL 2.0 section 2.10.1)');
      }
      seenRefs.add(refLocal);
      if (scope && !scope.has(refLocal)) {
        warnings.push('SOAP_WSDL20_BINDING_OP_UNRESOLVED: binding ' + name + ' operation ref "' + ref + '" resolves to no operation on interface ' + ifaceAttr + ' or its ancestors (WSDL 2.0 section 2.10.1)');
      }
      for (const attrName of ['mep', 'action'] as const) {
        const value = attr(opRef, attrName);
        if (value !== undefined && !isAbsoluteUri(value)) {
          warnings.push('SOAP_WSDL20_IRI_RELATIVE: binding ' + name + ' operation "' + ref + '" wsoap:' + attrName + ' "' + value + '" must be an absolute IRI (WSDL 2.0 Adjuncts section 5.10.3)');
        }
      }
    }
  }
}

function lintWsdl20Services(services: XNode[], interfaces: XNode[], bindings: XNode[], warnings: string[]): void {
  const interfaceNames = new Set(interfaces.map((iface) => attr(iface, 'name') ?? ''));
  const bindingInterfaces = new Map<string, string | undefined>();
  for (const binding of bindings) {
    bindingInterfaces.set(attr(binding, 'name') ?? '', attr(binding, 'interface'));
  }
  for (const service of services) {
    const name = attr(service, 'name') ?? '';
    const ifaceAttr = attr(service, 'interface');
    if (ifaceAttr === undefined || !interfaceNames.has(local(ifaceAttr))) {
      warnings.push('SOAP_WSDL20_SERVICE: service ' + name + ' must reference a declared interface (WSDL 2.0 section 2.14.1)' + (ifaceAttr !== undefined ? '; "' + ifaceAttr + '" does not resolve' : ''));
    }
    const endpoints = children(service, 'endpoint');
    if (endpoints.length === 0) {
      warnings.push('SOAP_WSDL20_SERVICE: service ' + name + ' declares no endpoint; at least one is required (WSDL 2.0 section 2.14.1)');
    }
    const endpointNames = new Set<string>();
    for (const endpoint of endpoints) {
      const epName = attr(endpoint, 'name') ?? '';
      if (endpointNames.has(epName)) {
        warnings.push('SOAP_WSDL20_ENDPOINT: service ' + name + ' endpoint name "' + epName + '" is not unique (WSDL 2.0 section 2.15.1)');
      }
      endpointNames.add(epName);
      const address = attr(endpoint, 'address');
      if (address !== undefined && !isAbsoluteUri(address)) {
        warnings.push('SOAP_WSDL20_ENDPOINT: service ' + name + ' endpoint "' + epName + '" address "' + address + '" must be an absolute IRI (WSDL 2.0 section 2.15.1)');
      }
      const bindingRef = attr(endpoint, 'binding');
      if (bindingRef !== undefined) {
        if (!bindingInterfaces.has(local(bindingRef))) {
          warnings.push('SOAP_WSDL20_ENDPOINT: service ' + name + ' endpoint "' + epName + '" binding "' + bindingRef + '" resolves to no declared binding (WSDL 2.0 section 2.15.1)');
        } else {
          const boundInterface = bindingInterfaces.get(local(bindingRef));
          if (boundInterface !== undefined && ifaceAttr !== undefined && local(boundInterface) !== local(ifaceAttr)) {
            warnings.push('SOAP_WSDL20_ENDPOINT: service ' + name + ' endpoint "' + epName + '" binding "' + bindingRef + '" binds interface "' + boundInterface + '" but the service declares interface "' + ifaceAttr + '" (WSDL 2.0 section 2.15.1)');
          }
        }
      }
    }
  }
}

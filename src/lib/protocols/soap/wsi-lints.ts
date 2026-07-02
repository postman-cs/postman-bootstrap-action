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

export function lintWsiConformance(text: string): string[] {
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
  if (definitions) lintWsdl11(definitions, warnings);
  if (description) lintWsdl20(description, warnings);
  return warnings;
}

function lintWsdl11(defs: XNode, warnings: string[]): void {
  lintWsdl11Ordering(defs, warnings);
  lintWsdl11Imports(defs, warnings);
  const { elements, schemasComplete } = lintWsdl11Types(defs, warnings);
  const messages = collectMessages(defs, warnings);
  const portTypes = collectPortTypes(defs, messages, warnings);
  lintWsdl11Bindings(defs, messages, portTypes, warnings);
  lintWsdl11PartElements(messages, elements, schemasComplete, warnings);
  lintWsdl11Services(defs, warnings);
  lintRequiredExtensions(defs, warnings);
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

function lintWsdl11Imports(defs: XNode, warnings: string[]): void {
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
  }
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
  if (soapAction === undefined && (transport === undefined || transport === 'http://schemas.xmlsoap.org/soap/http')) {
    warnings.push('SOAP_WSI_SOAPACTION_MISSING: binding ' + bindingName + ' operation ' + opName + ' omits soapAction; HTTP SOAP bindings should declare it, and the wire value must be quoted (WS-I Basic Profile 1.1 R2744/R2745)');
  }
  const ptOp = ptOps?.get(opName);
  if (ptOp?.wsamAction !== undefined && ptOp.wsamAction !== '' && soapAction !== undefined && soapAction !== '' && ptOp.wsamAction !== soapAction) {
    warnings.push('SOAP_WSI_ACTION_MISMATCH: operation ' + opName + ' declares wsam:Action "' + ptOp.wsamAction + '" but soapAction "' + soapAction + '"; WS-Addressing Metadata section 4.4.1 requires them to be identical');
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
  messages: Map<string, WsdlMessagePart[]>,
  elements: Set<string>,
  schemasComplete: boolean,
  warnings: string[]
): void {
  if (!schemasComplete || elements.size === 0) return;
  for (const [messageName, parts] of messages) {
    for (const part of parts) {
      if (part.element === undefined) continue;
      if (!elements.has(local(part.element))) {
        warnings.push('SOAP_WSI_PART_ELEMENT_UNRESOLVED: message ' + messageName + ' part "' + part.name + '" references element "' + part.element + '" which no inline schema declares as a global element (WSDL 1.1 section 2.3.1)');
      }
    }
  }
}

function lintWsdl11Services(defs: XNode, warnings: string[]): void {
  for (const service of children(defs, 'service')) {
    for (const port of children(service, 'port')) {
      const addresses = children(port, 'address');
      if (addresses.length > 1) {
        warnings.push('SOAP_WSI_PORT_ADDRESS_COUNT: port ' + (attr(port, 'name') ?? '') + ' declares ' + addresses.length + ' soap:address elements; exactly one is allowed (WSDL 1.1 section 3.8)');
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

function lintWsdl20(description: XNode, warnings: string[]): void {
  const interfaces = children(description, 'interface');
  const bindings = children(description, 'binding');
  const services = children(description, 'service');
  dupCheck(interfaces, 'interface', warnings);
  dupCheck(bindings, 'binding', warnings);
  dupCheck(services, 'service', warnings);

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
      if (pattern !== undefined && /(robust-)?in-only$/.test(pattern) && children(op, 'output').length > 0) {
        warnings.push('SOAP_WSDL20_MEP_SHAPE: interface ' + ifName + ' operation ' + opName + ' uses MEP ' + pattern + ' but declares an output; in-only and robust-in-only have no output placeholder (WSDL 2.0 Adjuncts section 2.2)');
      }
      for (const fr of [...children(op, 'infault'), ...children(op, 'outfault')]) {
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

  lintWsdl20Bindings(bindings, interfaceOps, extendsMap, warnings);
  lintWsdl20Services(services, interfaces, warnings);
  for (const iface of interfaces) {
    walk(iface, (node) => {
      if (local(node.tag) === 'Addressing') {
        warnings.push('SOAP_WSDL20_ADDRESSING_PLACEMENT: interface ' + (attr(iface, 'name') ?? '') + ' attaches a wsam:Addressing policy; WS-Addressing Metadata section 3.1 attaches Addressing at endpoint or binding, not interface');
      }
    });
  }
}

function lintWsdl20Bindings(
  bindings: XNode[],
  interfaceOps: Map<string, Set<string>>,
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

function lintWsdl20Services(services: XNode[], interfaces: XNode[], warnings: string[]): void {
  const interfaceNames = new Set(interfaces.map((i) => attr(i, 'name') ?? ''));
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
    }
  }
}

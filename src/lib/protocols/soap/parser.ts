import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { lintWsiConformance, type WsdlImportResolver } from './wsi-lints.js';
import { buildXsdIndex, type XsdSchemaIndex } from './xsd-index.js';

type JsonRecord = Record<string, unknown>;

/** SOAP transport binding style for an operation. */
export type SoapVersion = '1.1' | '1.2';

export interface SoapMessagePart {
  name: string;
  /** QName of the referenced element (when part references a schema element). */
  element?: string;
  /** QName of the referenced type (when part references a schema type). */
  type?: string;
}

export interface SoapMessage {
  /** Local name of the WSDL message (1.1) or operation message (2.0). */
  name: string;
  parts: SoapMessagePart[];
}

export interface SoapHeaderDecl {
  /** Local name of the header block element resolved from message/part. */
  element: string;
  /** Namespace of the header element, when derivable from the document. */
  namespace?: string;
}

export interface SoapOperation {
  /** Local operation name as declared on the portType/interface. */
  name: string;
  /** SOAPAction URI from the binding (empty string when none declared). */
  soapAction: string;
  /** Resolved SOAP envelope version for the binding holding this operation. */
  soapVersion: SoapVersion;
  /** Binding style (soap:operation style, falling back to soap:binding style). */
  style?: 'document' | 'rpc';
  /** soapbind:body use for this operation (output preferred, else input). */
  use?: 'literal' | 'encoded';
  /** soapbind:body namespace attribute (rpc bindings; output preferred). */
  bodyNamespace?: string;
  /** Raw soapbind:body parts attribute on the output ('' means "no parts bound"). */
  outputBodyParts?: string;
  /** Effective declared part count for the output body (parts attr narrows the message). */
  outputBodyPartCount?: number;
  /** WSDL 2.0 interface operation pattern IRI (message exchange pattern). */
  mepPattern?: string;
  /** WSDL 2.0 binding wsoap:mep (or wsoap:mepDefault) IRI, when declared. */
  soapMep?: string;
  /** Local names of schema elements bound as fault detail (WSDL 2.0 infault/outfault refs). */
  faultElements?: string[];
  /** Local parts of binding-declared SOAP fault codes (wsoap:code, excluding #any). */
  faultCodes?: string[];
  /** Binding soap:header blocks declared for the request (WSDL 1.1 section 3.7). */
  inputHeaders?: SoapHeaderDecl[];
  /** Binding soap:header blocks declared for the response (WSDL 1.1 section 3.7). */
  outputHeaders?: SoapHeaderDecl[];
  /** Binding soap:headerfault declarations (WSDL 1.1 section 3.7) for header-fault placement checks. */
  headerFaults?: SoapHeaderDecl[];
  /** Required HTTP header field names from WSDL 2.0 whttp:header on the output. */
  outputHttpHeaders?: string[];
  /** soapbind:body encodingStyle declared for encoded operations (output preferred). */
  encodingStyle?: string;
  /** Name of the portType/interface declaring this operation. */
  portTypeName?: string;
  /** Name attribute of the portType wsdl:input element, when present. */
  inputName?: string;
  /** Explicit wsaw:/wsam:Action on the portType input, when declared. */
  inputAction?: string;
  /** Name attribute of the portType wsdl:output element, when present. */
  outputName?: string;
  /** Explicit wsaw:/wsam:Action on the portType output, when declared. */
  outputAction?: string;
  /** Input message (request); undefined for notification-only operations. */
  input?: SoapMessage;
  /** Output message (response); undefined for one-way operations. */
  output?: SoapMessage;
  /** Local name of the top-level element expected in the response body. */
  expectedResponseElement?: string;
  /** Namespace of the expected response element, when derivable. */
  expectedResponseNamespace?: string;
  warnings: string[];
}

export interface SoapService {
  name: string;
  /** Concrete endpoint location (soap:address). Empty string when absent. */
  endpoint: string;
  operations: SoapOperation[];
}

export interface SoapContractIndex {
  /** WSDL major version that was parsed. */
  wsdlVersion: '1.1' | '2.0';
  /** Target namespace of the WSDL definitions/description element. */
  targetNamespace: string;
  /**
   * True when the WSDL engages WS-Addressing (a wsaw:UsingAddressing element
   * or a wsam:/wsp: Addressing policy assertion anywhere in the definitions).
   */
  declaresAddressing: boolean;
  /** Inline-XSD component index over wsdl:types (single-document, offline). */
  schemaIndex: XsdSchemaIndex;
  services: SoapService[];
  warnings: string[];
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

/** Strip a namespace prefix from a QName, returning the local part. */
export function localName(qname: string): string {
  const value = asString(qname);
  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(colon + 1);
}

function prefixOf(qname: string): string {
  const value = asString(qname);
  const colon = value.indexOf(':');
  return colon === -1 ? '' : value.slice(0, colon);
}

/**
 * fast-xml-parser is configured to keep namespace prefixes on element names
 * (removeNSPrefix:false) so WSDL 1.1 (`wsdl:`/`soap:`) and bare-namespace
 * documents both round-trip. We then walk by local name to stay prefix-agnostic.
 */
function createParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: false,
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
    isArray: () => false
  });
}

/** Find the single child of `record` whose local name equals `local`. */
function child(record: JsonRecord | null, local: string): unknown {
  if (!record) return undefined;
  for (const key of Object.keys(record)) {
    if (key.startsWith('@_') || key === '#text') continue;
    if (localName(key) === local) return record[key];
  }
  return undefined;
}

/** Collect all children (across prefixes) whose local name equals `local`. */
function children(record: JsonRecord | null, local: string): JsonRecord[] {
  if (!record) return [];
  const out: JsonRecord[] = [];
  for (const key of Object.keys(record)) {
    if (key.startsWith('@_') || key === '#text') continue;
    if (localName(key) !== local) continue;
    for (const entry of asArray(record[key])) {
      const rec = asRecord(entry);
      if (rec) out.push(rec);
    }
  }
  return out;
}

function attr(record: JsonRecord | null, name: string): string {
  if (!record) return '';
  const direct = record[`@_${name}`];
  if (direct !== undefined) return asString(direct);
  // Attribute may itself be namespace-prefixed (e.g. wsdl:required); match local.
  for (const key of Object.keys(record)) {
    if (!key.startsWith('@_')) continue;
    if (localName(key.slice(2)) === name) return asString(record[key]);
  }
  return '';
}

/** True when the attribute (prefix-agnostic) is declared, even with an empty value. */
function hasLocalAttr(record: JsonRecord | null, name: string): boolean {
  if (!record) return false;
  if (record[`@_${name}`] !== undefined) return true;
  for (const key of Object.keys(record)) {
    if (key.startsWith('@_') && localName(key.slice(2)) === name) return true;
  }
  return false;
}

/** Map a prefix used in a QName back to its namespace via xmlns declarations. */
function namespaceForPrefix(scopes: JsonRecord[], prefix: string): string {
  const attrName = prefix ? `xmlns:${prefix}` : 'xmlns';
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    const scope = scopes[i];
    if (!scope) continue;
    const value = attr(scope, attrName);
    if (value) return value;
  }
  return '';
}

const SOAP11_BINDING_NS = 'http://schemas.xmlsoap.org/wsdl/soap/';
const SOAP12_BINDING_NS = 'http://schemas.xmlsoap.org/wsdl/soap12/';

function detectWsdlVersion(definitions: JsonRecord | null, description: JsonRecord | null): '1.1' | '2.0' {
  if (description) return '2.0';
  if (definitions) return '1.1';
  return '1.1';
}

function parseMessages11(definitions: JsonRecord): Map<string, SoapMessage> {
  const out = new Map<string, SoapMessage>();
  for (const message of children(definitions, 'message')) {
    const name = attr(message, 'name');
    if (!name) continue;
    const parts: SoapMessagePart[] = children(message, 'part').map((part) => ({
      name: attr(part, 'name'),
      element: attr(part, 'element') || undefined,
      type: attr(part, 'type') || undefined
    }));
    out.set(name, { name, parts });
  }
  return out;
}

interface BindingOp11 {
  soapAction: string;
  soapVersion: SoapVersion;
  style?: 'document' | 'rpc';
  use?: 'literal' | 'encoded';
  bodyNamespace?: string;
  outputBodyParts?: string;
  inputHeaders?: SoapHeaderDecl[];
  outputHeaders?: SoapHeaderDecl[];
  headerFaults?: SoapHeaderDecl[];
  encodingStyle?: string;
}

/** First soapbind:body marker child of a wsdl:input/wsdl:output record. */
function bodyMarker(direction: JsonRecord | null): JsonRecord | null {
  if (!direction) return null;
  return children(direction, 'body')[0] ?? null;
}

/**
 * Binding soap:header declarations for a wsdl:input/wsdl:output record,
 * resolved to the header element local name + namespace via message/part.
 */
function headerDecls(
  direction: JsonRecord | null,
  messages: Map<string, SoapMessage>,
  scopes: JsonRecord[]
): SoapHeaderDecl[] {
  const out: SoapHeaderDecl[] = [];
  if (!direction) return out;
  for (const header of children(direction, 'header')) {
    const message = messages.get(localName(attr(header, 'message')));
    const partName = attr(header, 'part');
    const part = message?.parts.find((candidate) => candidate.name === partName);
    if (!part?.element) continue;
    out.push({
      element: localName(part.element),
      namespace: namespaceForPrefix(scopes, prefixOf(part.element)) || undefined
    });
  }
  return out;
}

/** Binding soap:headerfault declarations nested under soap:header (WSDL 1.1 section 3.7). */
function headerFaultDecls(
  direction: JsonRecord | null,
  messages: Map<string, SoapMessage>,
  scopes: JsonRecord[]
): SoapHeaderDecl[] {
  const out: SoapHeaderDecl[] = [];
  if (!direction) return out;
  for (const header of children(direction, 'header')) {
    for (const hf of children(header, 'headerfault')) {
      const message = messages.get(localName(attr(hf, 'message')));
      const part = message?.parts.find((candidate) => candidate.name === attr(hf, 'part'));
      if (!part?.element) continue;
      out.push({
        element: localName(part.element),
        namespace: namespaceForPrefix(scopes, prefixOf(part.element)) || undefined
      });
    }
  }
  return out;
}

function parseSoapBindings11(
  definitions: JsonRecord,
  messages: Map<string, SoapMessage>,
  warnings: string[]
): Map<string, Map<string, BindingOp11>> {
  // bindingName -> operationName -> { soapAction, soapVersion, style, use, ... }
  const out = new Map<string, Map<string, BindingOp11>>();
  for (const binding of children(definitions, 'binding')) {
    const bindingName = attr(binding, 'name');
    if (!bindingName) continue;
    let soapVersion: SoapVersion | null = null;
    let bindingStyle = '';
    for (const key of Object.keys(binding)) {
      if (key.startsWith('@_') || localName(key) !== 'binding') continue;
      // soap:binding / soap12:binding marker child; resolve version by prefix ns.
      const ns = namespaceForPrefix([definitions, binding], prefixOf(key));
      if (ns === SOAP12_BINDING_NS) soapVersion = '1.2';
      else if (ns === SOAP11_BINDING_NS) soapVersion = '1.1';
      else continue;
      for (const marker of asArray(binding[key])) {
        const style = attr(asRecord(marker), 'style');
        if (style) bindingStyle = style;
      }
    }
    const ops = new Map<string, BindingOp11>();
    for (const operation of children(binding, 'operation')) {
      const opName = attr(operation, 'name');
      if (!opName) continue;
      let soapAction = '';
      let styleRaw = bindingStyle;
      for (const key of Object.keys(operation)) {
        if (localName(key) !== 'operation') continue;
        for (const marker of asArray(operation[key])) {
          const rec = asRecord(marker);
          const action = attr(rec, 'soapAction');
          if (action) soapAction = action;
          const style = attr(rec, 'style');
          if (style) styleRaw = style;
        }
      }
      // WSDL 1.1 section 3.4: soap:binding style defaults to "document".
      let style: 'document' | 'rpc' | undefined = soapVersion ? 'document' : undefined;
      if (styleRaw === 'document' || styleRaw === 'rpc') style = styleRaw;
      else if (styleRaw) {
        warnings.push(`SOAP_BINDING_STYLE_UNPARSEABLE: binding ${bindingName} operation ${opName} declares style "${styleRaw}" (expected document|rpc); style-specific assertions are skipped`);
        style = undefined;
      }
      const inputDirection = asRecord(child(operation, 'input'));
      const outputDirection = asRecord(child(operation, 'output'));
      const inputBody = bodyMarker(inputDirection);
      const outputBody = bodyMarker(outputDirection);
      const useRaw = attr(outputBody, 'use') || attr(inputBody, 'use');
      let use: 'literal' | 'encoded' | undefined;
      if (useRaw === 'literal' || useRaw === 'encoded') use = useRaw;
      else if (useRaw) warnings.push(`SOAP_BODY_USE_UNPARSEABLE: binding ${bindingName} operation ${opName} declares soap:body use "${useRaw}" (expected literal|encoded); use-specific assertions are skipped`);
      // WS-I Basic Profile 1.1 R2706: an omitted soap:body use defaults to literal.
      else if (inputBody || outputBody) use = 'literal';
      const bodyNamespace = attr(outputBody, 'namespace') || attr(inputBody, 'namespace') || undefined;
      const encodingStyle = attr(outputBody, 'encodingStyle') || attr(inputBody, 'encodingStyle') || undefined;
      const headerFaults = [
        ...headerFaultDecls(inputDirection, messages, [definitions, binding, operation]),
        ...headerFaultDecls(outputDirection, messages, [definitions, binding, operation])
      ];
      const outputBodyParts = hasLocalAttr(outputBody, 'parts') ? attr(outputBody, 'parts') : undefined;
      const inputHeaders = headerDecls(inputDirection, messages, [definitions, binding]);
      const outputHeaders = headerDecls(outputDirection, messages, [definitions, binding]);
      ops.set(opName, {
        soapAction,
        soapVersion: soapVersion ?? '1.1',
        style,
        use,
        bodyNamespace,
        outputBodyParts,
        inputHeaders: inputHeaders.length > 0 ? inputHeaders : undefined,
        outputHeaders: outputHeaders.length > 0 ? outputHeaders : undefined,
        headerFaults: headerFaults.length > 0 ? headerFaults : undefined,
        encodingStyle
      });
    }
    out.set(bindingName, ops);
  }
  return out;
}

function defaultSoapVersion(bindings: Map<string, Map<string, BindingOp11>>): SoapVersion {
  for (const ops of bindings.values()) {
    for (const op of ops.values()) return op.soapVersion;
  }
  return '1.1';
}

function lookupBindingOp(
  bindings: Map<string, Map<string, BindingOp11>>,
  operationName: string
): BindingOp11 | undefined {
  for (const ops of bindings.values()) {
    const found = ops.get(operationName);
    if (found) return found;
  }
  return undefined;
}

/** Resolve the response element local name + namespace from the output message. */
function resolveResponseElement(
  message: SoapMessage | undefined,
  scopes: JsonRecord[]
): { element?: string; namespace?: string; warning?: string } {
  if (!message) return {};
  const part = message.parts[0];
  if (!part) return {};
  if (part.element) {
    return { element: localName(part.element), namespace: namespaceForPrefix(scopes, prefixOf(part.element)) || undefined };
  }
  if (part.type) {
    // RPC/encoded or type-referenced part: the wrapper element is the message
    // part name, not the schema type; assert on the part name, warn on weakness.
    return {
      element: part.name || undefined,
      warning: `SOAP_RESPONSE_ELEMENT_FROM_TYPE: response part "${part.name}" references type ${part.type}; asserting on part name only`
    };
  }
  return {};
}

function parseServices11(
  definitions: JsonRecord,
  messages: Map<string, SoapMessage>,
  bindings: Map<string, Map<string, BindingOp11>>,
  warnings: string[]
): SoapService[] {
  const portTypes = new Map<string, JsonRecord>();
  for (const portType of children(definitions, 'portType')) {
    const name = attr(portType, 'name');
    if (name) portTypes.set(name, portType);
  }

  // Map binding name -> portType name for endpoint/operation correlation.
  const bindingToPortType = new Map<string, string>();
  for (const binding of children(definitions, 'binding')) {
    const name = attr(binding, 'name');
    const type = localName(attr(binding, 'type'));
    if (name && type) bindingToPortType.set(name, type);
  }

  const buildOperations = (portTypeName: string): SoapOperation[] => {
    const portType = portTypes.get(portTypeName);
    if (!portType) return [];
    return children(portType, 'operation').map((operation) => {
      const name = attr(operation, 'name');
      const opWarnings: string[] = [];
      const inputRecord = asRecord(child(operation, 'input'));
      const outputRecord = asRecord(child(operation, 'output'));
      const inputRef = localName(attr(inputRecord, 'message'));
      const outputRef = localName(attr(outputRecord, 'message'));
      const input = inputRef ? messages.get(inputRef) : undefined;
      const output = outputRef ? messages.get(outputRef) : undefined;
      if (inputRef && !input) opWarnings.push(`SOAP_MESSAGE_UNRESOLVED: input message ${inputRef} for operation ${name} not found`);
      if (outputRef && !output) opWarnings.push(`SOAP_MESSAGE_UNRESOLVED: output message ${outputRef} for operation ${name} not found`);
      if (!outputRef) opWarnings.push(`SOAP_OPERATION_ONE_WAY: operation ${name} declares no output message; response assertions limited to transport`);
      const bindingOp = lookupBindingOp(bindings, name);
      const resolved = resolveResponseElement(output, [definitions]);
      if (resolved.warning) opWarnings.push(resolved.warning);
      let outputBodyPartCount: number | undefined;
      const partsAttr = bindingOp?.outputBodyParts;
      if (partsAttr !== undefined) {
        const trimmed = partsAttr.trim();
        outputBodyPartCount = trimmed === '' ? 0 : trimmed.split(/\s+/).length;
      } else if (output) {
        outputBodyPartCount = output.parts.length;
      }
      return {
        name,
        soapAction: bindingOp?.soapAction ?? '',
        soapVersion: bindingOp?.soapVersion ?? defaultSoapVersion(bindings),
        style: bindingOp?.style,
        use: bindingOp?.use,
        bodyNamespace: bindingOp?.bodyNamespace,
        outputBodyParts: bindingOp?.outputBodyParts,
        outputBodyPartCount,
        inputHeaders: bindingOp?.inputHeaders,
        outputHeaders: bindingOp?.outputHeaders,
        headerFaults: bindingOp?.headerFaults,
        encodingStyle: bindingOp?.encodingStyle,
        portTypeName,
        inputName: attr(inputRecord, 'name') || undefined,
        inputAction: attr(inputRecord, 'Action') || undefined,
        outputName: attr(outputRecord, 'name') || undefined,
        outputAction: attr(outputRecord, 'Action') || undefined,
        input,
        output,
        expectedResponseElement: resolved.element,
        expectedResponseNamespace: resolved.namespace,
        warnings: opWarnings
      };
    });
  };

  const services: SoapService[] = [];
  for (const service of children(definitions, 'service')) {
    const serviceName = attr(service, 'name');
    const ports = children(service, 'port');
    let endpoint = '';
    const operationsByPortType: SoapOperation[] = [];
    const seenPortTypes = new Set<string>();
    for (const port of ports) {
      const bindingName = localName(attr(port, 'binding'));
      const address = asRecord(child(port, 'address'));
      const location = attr(address, 'location');
      if (location && !endpoint) endpoint = location;
      const portTypeName = bindingToPortType.get(bindingName);
      if (portTypeName && !seenPortTypes.has(portTypeName)) {
        seenPortTypes.add(portTypeName);
        operationsByPortType.push(...buildOperations(portTypeName));
      }
    }
    if (!endpoint) warnings.push(`SOAP_ENDPOINT_MISSING: service ${serviceName} has no soap:address location; request URL left as placeholder`);
    services.push({ name: serviceName, endpoint, operations: operationsByPortType });
  }

  // WSDL with no <service> still has portTypes/bindings; surface them as a
  // synthetic service so operations are never silently dropped.
  if (services.length === 0 && portTypes.size > 0) {
    const operations: SoapOperation[] = [];
    for (const portTypeName of portTypes.keys()) operations.push(...buildOperations(portTypeName));
    warnings.push('SOAP_SERVICE_MISSING: WSDL declares no <service>; emitting operations under a synthetic service with placeholder endpoint');
    services.push({ name: attr(definitions, 'name') || 'Service', endpoint: '', operations });
  }

  return services;
}

const WSDL20_SOAP_BINDING_TYPE = 'http://www.w3.org/ns/wsdl/soap';

interface BindingOp20 {
  action?: string;
  mep?: string;
  outputHttpHeaders?: string[];
  inputHeaders?: SoapHeaderDecl[];
  outputHeaders?: SoapHeaderDecl[];
}

interface Binding20 {
  interfaceName: string;
  soapVersion: SoapVersion;
  mepDefault?: string;
  ops: Map<string, BindingOp20>;
  faultCodes?: string[];
}

/** Parse WSDL 2.0 <binding> elements: SOAP version, per-operation MEPs and actions. */
function parseBindings20(description: JsonRecord, warnings: string[]): Map<string, Binding20> {
  const out = new Map<string, Binding20>();
  for (const binding of children(description, 'binding')) {
    const name = attr(binding, 'name');
    if (!name) continue;
    const type = attr(binding, 'type');
    if (type && type !== WSDL20_SOAP_BINDING_TYPE) {
      warnings.push(`SOAP_WSDL20_BINDING_TYPE_UNSUPPORTED: binding ${name} declares type "${type}"; only the WSDL 2.0 SOAP binding (${WSDL20_SOAP_BINDING_TYPE}) is generated as SOAP requests`);
    }
    // wsoap:version defaults to 1.2 (WSDL 2.0 Adjuncts section 5.10.1).
    const soapVersion: SoapVersion = attr(binding, 'version') === '1.1' ? '1.1' : '1.2';
    const ops = new Map<string, BindingOp20>();
    for (const operation of children(binding, 'operation')) {
      const ref = localName(attr(operation, 'ref'));
      if (!ref) continue;
      const headerDecls20 = (direction: 'input' | 'output'): SoapHeaderDecl[] => {
        const decls: SoapHeaderDecl[] = [];
        for (const dirNode of children(operation, direction)) {
          for (const header of children(dirNode, 'header')) {
            const element = attr(header, 'element');
            if (!element || element.startsWith('#')) continue;
            decls.push({ element: localName(element), namespace: namespaceForPrefix([description, binding, operation, dirNode, header], prefixOf(element)) || undefined });
          }
        }
        return decls;
      };
      const inputHeaders20 = headerDecls20('input');
      const outputHeaders20 = headerDecls20('output');
      // whttp:header shares the local name with wsoap:header but carries a
      // name attribute (HTTP field) instead of element (WSDL 2.0 Adjuncts 6.9).
      const outputHttpHeaders20: string[] = [];
      for (const dirNode of children(operation, 'output')) {
        for (const header of children(dirNode, 'header')) {
          const fieldName = attr(header, 'name');
          if (fieldName && /^(true|1)$/.test(attr(header, 'required'))) outputHttpHeaders20.push(fieldName);
        }
      }
      ops.set(ref, {
        action: attr(operation, 'action') || undefined,
        mep: attr(operation, 'mep') || undefined,
        inputHeaders: inputHeaders20.length > 0 ? inputHeaders20 : undefined,
        outputHeaders: outputHeaders20.length > 0 ? outputHeaders20 : undefined,
        outputHttpHeaders: outputHttpHeaders20.length > 0 ? outputHttpHeaders20 : undefined
      });
    }
    const faultCodes: string[] = [];
    for (const fault of children(binding, 'fault')) {
      const code = attr(fault, 'code');
      if (code && code !== '#any') faultCodes.push(localName(code));
    }
    out.set(name, {
      interfaceName: localName(attr(binding, 'interface')),
      soapVersion,
      mepDefault: attr(binding, 'mepDefault') || undefined,
      faultCodes: faultCodes.length > 0 ? faultCodes : undefined,
      ops
    });
  }
  return out;
}

function parseServices20(description: JsonRecord, warnings: string[]): SoapService[] {
  warnings.push('SOAP_WSDL20_PARTIAL: WSDL 2.0 support is partial; operations are derived from interface/binding but import resolution and full component-model validation are best-effort');
  const interfaces = new Map<string, JsonRecord>();
  for (const iface of children(description, 'interface')) {
    const name = attr(iface, 'name');
    if (name) interfaces.set(name, iface);
  }
  const bindings = parseBindings20(description, warnings);

  const buildOperations = (iface: JsonRecord, binding: Binding20 | undefined): SoapOperation[] =>
    children(iface, 'operation').map((operation) => {
      const name = attr(operation, 'name');
      const opWarnings: string[] = [];
      const inputRecord = asRecord(child(operation, 'input'));
      const outputRecord = asRecord(child(operation, 'output'));
      const inputElement = attr(inputRecord, 'element');
      const outputElement = attr(outputRecord, 'element');
      const outLocal = outputElement.startsWith('#') ? '' : localName(outputElement);
      if (!outputRecord) opWarnings.push(`SOAP_OPERATION_ONE_WAY: operation ${name} declares no output; response assertions limited to transport`);
      const bindingOp = binding?.ops.get(name);
      const ifaceFaultElements = new Map<string, string>();
      for (const fault of children(iface, 'fault')) {
        const faultName = attr(fault, 'name');
        const faultElement = attr(fault, 'element');
        if (faultName && faultElement && !faultElement.startsWith('#')) ifaceFaultElements.set(faultName, localName(faultElement));
      }
      const faultElements = [...children(operation, 'infault'), ...children(operation, 'outfault')]
        .map((faultRef) => ifaceFaultElements.get(localName(attr(faultRef, 'ref'))))
        .filter((element): element is string => Boolean(element));
      const inputAction = attr(inputRecord, 'Action') || undefined;
      // WS-Addressing Metadata section 4.4.1: an explicit wsam:Action and the
      // binding's wsoap:action must agree when both are declared.
      if (inputAction && bindingOp?.action && inputAction !== bindingOp.action) {
        opWarnings.push(`SOAP_WSDL20_ACTION_MISMATCH: operation ${name} declares wsam:Action "${inputAction}" but the binding declares wsoap:action "${bindingOp.action}"; WS-Addressing Metadata section 4.4.1 requires them to be identical`);
      }
      // The input message reference makes one-way shapes parse-confirmed
      // (input present, output absent) so the instrumenter can switch to the
      // one-way transport contract for WSDL 2.0 in-only operations.
      const input = inputRecord
        ? { name, parts: inputElement && !inputElement.startsWith('#') ? [{ name, element: inputElement }] : [] }
        : undefined;
      return {
        name,
        soapAction: bindingOp?.action ?? '',
        soapVersion: binding?.soapVersion ?? ('1.2' as SoapVersion),
        mepPattern: attr(operation, 'pattern') || undefined,
        soapMep: bindingOp?.mep ?? binding?.mepDefault,
        inputAction,
        inputHeaders: bindingOp?.inputHeaders,
        outputHeaders: bindingOp?.outputHeaders,
        outputHttpHeaders: bindingOp?.outputHttpHeaders,
        faultElements: faultElements.length > 0 ? faultElements : undefined,
        faultCodes: binding?.faultCodes,
        portTypeName: attr(iface, 'name') || undefined,
        input,
        output: outLocal ? { name, parts: [{ name, element: outputElement }] } : undefined,
        expectedResponseElement: outLocal || undefined,
        expectedResponseNamespace: outLocal
          ? namespaceForPrefix([description, iface, operation, outputRecord ?? {}], prefixOf(outputElement)) || undefined
          : undefined,
        warnings: opWarnings
      };
    });

  const services: SoapService[] = [];
  for (const service of children(description, 'service')) {
    const name = attr(service, 'name');
    const ifaceName = localName(attr(service, 'interface'));
    const iface = interfaces.get(ifaceName);
    let endpoint = '';
    let binding: Binding20 | undefined;
    for (const ep of children(service, 'endpoint')) {
      let address = attr(ep, 'address');
      if (!address) {
        // WSDL 2.0 endpoints may carry the address as a child wsa:EndpointReference.
        const epr = asRecord(child(ep, 'EndpointReference'));
        const addressNode = child(epr, 'Address');
        const addressRecord = asRecord(addressNode);
        address = addressRecord ? asString(addressRecord['#text']) : asString(addressNode);
        if (address) warnings.push(`SOAP_WSDL20_ENDPOINT_EPR: endpoint ${attr(ep, 'name')} address taken from its child wsa:EndpointReference/Address; reference parameters are not propagated`);
      }
      if (address && !endpoint) endpoint = address;
      if (!binding) binding = bindings.get(localName(attr(ep, 'binding')));
    }
    if (!endpoint) warnings.push(`SOAP_ENDPOINT_MISSING: service ${name} has no endpoint address; request URL left as placeholder`);
    if (!binding) binding = [...bindings.values()].find((candidate) => candidate.interfaceName === ifaceName);
    services.push({ name, endpoint, operations: iface ? buildOperations(iface, binding) : [] });
  }
  if (services.length === 0) {
    for (const iface of interfaces.values()) {
      const ifaceName = attr(iface, 'name');
      const binding = [...bindings.values()].find((candidate) => candidate.interfaceName === ifaceName);
      services.push({ name: ifaceName, endpoint: '', operations: buildOperations(iface, binding) });
    }
  }
  return services;
}

/**
 * True when the parsed document contains a wsaw:UsingAddressing element or a
 * wsam:/wsp: Addressing policy assertion anywhere (element local names only;
 * best-effort, prefix-agnostic).
 */
function detectAddressing(node: unknown): boolean {
  const record = asRecord(node);
  if (!record) return false;
  for (const key of Object.keys(record)) {
    if (key.startsWith('@_') || key === '#text') continue;
    const local = localName(key);
    if (local === 'UsingAddressing' || local === 'Addressing') return true;
    for (const entry of asArray(record[key])) {
      if (detectAddressing(entry)) return true;
    }
  }
  return false;
}

/**
 * WS-Addressing 1.0 WSDL Binding (section 4.4.4) default action pattern:
 * [target namespace][delimiter][port type name][delimiter][message name],
 * where the delimiter is ':' for URN target namespaces and '/' otherwise.
 * Returns '' when the WSDL lacks a piece needed for a deterministic IRI.
 */
export function defaultActionIri(targetNamespace: string, portTypeName: string | undefined, messageName: string): string {
  if (!targetNamespace || !portTypeName || !messageName) return '';
  const delimiter = /^urn:/i.test(targetNamespace) ? ':' : '/';
  const base = delimiter === '/' ? targetNamespace.replace(/\/+$/, '') : targetNamespace.replace(/:+$/, '');
  return `${base}${delimiter}${portTypeName}${delimiter}${messageName}`;
}

const SOAP_HTTP_TRANSPORT = 'http://schemas.xmlsoap.org/soap/http';

/** WSDL 2.0 Adjuncts section 5.10.3: the SOAP-response MEP binds to HTTP GET. */
export const SOAP_RESPONSE_MEP = 'http://www.w3.org/2003/05/soap/mep/soap-response/';
const ABSOLUTE_URI = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Message parts bound to the soap:body, honoring the body parts attribute. */
function boundParts(message: SoapMessage | undefined, body: JsonRecord | null): SoapMessagePart[] {
  if (!message) return [];
  if (body && hasLocalAttr(body, 'parts')) {
    const listed = attr(body, 'parts').trim();
    if (!listed) return [];
    const names = new Set(listed.split(/\s+/));
    return message.parts.filter((part) => names.has(part.name));
  }
  return message.parts;
}

/**
 * Generation-time WS-I Basic Profile 1.1 conformance lints over a WSDL 1.1
 * document. Advisory only: every finding is surfaced as a SOAP_LINT_* warning
 * (never a hard failure) so a non-conformant WSDL still yields a collection.
 */
function lintWsdl11(definitions: JsonRecord, messages: Map<string, SoapMessage>, warnings: string[]): void {
  const tns = attr(definitions, 'targetNamespace');
  if (!tns) warnings.push('SOAP_LINT_TARGET_NAMESPACE_MISSING: definitions declares no targetNamespace; namespace-anchored assertions cannot be derived (WSDL 1.1 section 2.1)');
  else if (!ABSOLUTE_URI.test(tns)) warnings.push(`SOAP_LINT_TARGET_NAMESPACE_RELATIVE: targetNamespace "${tns}" is not an absolute URI`);

  for (const message of children(definitions, 'message')) {
    const messageName = attr(message, 'name');
    const seen = new Set<string>();
    for (const part of children(message, 'part')) {
      const partName = attr(part, 'name');
      if (!partName) continue;
      if (seen.has(partName)) warnings.push(`SOAP_LINT_DUPLICATE_PART_NAME: message ${messageName} declares part name "${partName}" more than once; part names must be unique within a message (WSDL 1.1 section 2.3)`);
      seen.add(partName);
    }
  }

  for (const imported of children(definitions, 'import')) {
    const location = attr(imported, 'location');
    if (/\.xsd(?:[?#]|$)/i.test(location)) {
      warnings.push(`SOAP_LINT_IMPORT_NON_WSDL: wsdl:import location "${location}" appears to be an XML Schema document; wsdl:import is restricted to WSDL documents -- use xsd:import inside wsdl:types (WS-I Basic Profile 1.1 R2001/R2002; best-effort heuristic)`);
    }
  }

  const portTypes = new Map<string, JsonRecord>();
  for (const portType of children(definitions, 'portType')) {
    const name = attr(portType, 'name');
    if (name) portTypes.set(name, portType);
  }

  for (const binding of children(definitions, 'binding')) {
    const bindingName = attr(binding, 'name');
    const portTypeName = localName(attr(binding, 'type'));
    const portType = portTypes.get(portTypeName);
    if (portTypeName && !portType) warnings.push(`SOAP_LINT_PORTTYPE_UNRESOLVED: binding ${bindingName} references portType ${portTypeName}, which is not declared in this document`);

    let bindingStyle = '';
    for (const key of Object.keys(binding)) {
      if (key.startsWith('@_') || localName(key) !== 'binding') continue;
      const ns = namespaceForPrefix([definitions, binding], prefixOf(key));
      if (ns !== SOAP11_BINDING_NS && ns !== SOAP12_BINDING_NS) continue;
      for (const entry of asArray(binding[key])) {
        const marker = asRecord(entry);
        if (!marker) continue;
        const style = attr(marker, 'style');
        if (style) bindingStyle = style;
        const transport = attr(marker, 'transport');
        if (transport !== SOAP_HTTP_TRANSPORT) {
          warnings.push(`SOAP_LINT_TRANSPORT_NOT_HTTP: binding ${bindingName} declares transport "${transport || '<missing>'}"; WS-I Basic Profile 1.1 R2701/R2702 require ${SOAP_HTTP_TRANSPORT}`);
        }
      }
    }

    const portTypeOps = new Map<string, JsonRecord>();
    if (portType) {
      for (const operation of children(portType, 'operation')) {
        const name = attr(operation, 'name');
        if (name) portTypeOps.set(name, operation);
      }
    }

    const styles = new Set<string>();
    const wireSignatures = new Map<string, string>();
    const bindingOpNames = new Set<string>();

    for (const operation of children(binding, 'operation')) {
      const opName = attr(operation, 'name');
      if (!opName) continue;
      bindingOpNames.add(opName);

      let styleRaw = bindingStyle;
      for (const key of Object.keys(operation)) {
        if (localName(key) !== 'operation') continue;
        for (const entry of asArray(operation[key])) {
          const style = attr(asRecord(entry), 'style');
          if (style) styleRaw = style;
        }
      }
      const effStyle = styleRaw === 'rpc' ? 'rpc' : 'document';
      styles.add(effStyle);

      const inputDirection = asRecord(child(operation, 'input'));
      const outputDirection = asRecord(child(operation, 'output'));
      const inputBody = bodyMarker(inputDirection);
      const outputBody = bodyMarker(outputDirection);
      for (const [direction, body] of [['input', inputBody], ['output', outputBody]] as const) {
        const use = attr(body, 'use');
        if (use && use !== 'literal') {
          warnings.push(`SOAP_LINT_USE_NOT_LITERAL: binding ${bindingName} operation ${opName} ${direction} declares soap:body use="${use}"; WS-I Basic Profile 1.1 R2706 requires use="literal"`);
        }
      }
      const use = attr(outputBody, 'use') || attr(inputBody, 'use');
      // WS-I Basic Profile 1.1 R2706: an omitted soap:body use defaults to literal.
      const literal = use === 'literal' || (!use && Boolean(inputBody ?? outputBody));

      if (effStyle === 'document' && literal) {
        for (const [direction, body] of [['input', inputBody], ['output', outputBody]] as const) {
          if (body && hasLocalAttr(body, 'namespace')) {
            warnings.push(`SOAP_LINT_DOC_LITERAL_BODY_NAMESPACE: binding ${bindingName} operation ${opName} ${direction} soap:body carries a namespace attribute; WS-I Basic Profile 1.1 R2716 forbids it on doc-literal bindings`);
          }
        }
      }
      if (effStyle === 'rpc' && literal) {
        const ns = attr(outputBody, 'namespace') || attr(inputBody, 'namespace');
        if (!ns || !ABSOLUTE_URI.test(ns)) {
          warnings.push(`SOAP_LINT_RPC_LITERAL_BODY_NAMESPACE: binding ${bindingName} operation ${opName} soap:body ${ns ? `namespace "${ns}" is not an absolute URI` : 'declares no namespace attribute'}; WS-I Basic Profile 1.1 R2717 requires an absolute-URI namespace on rpc-literal bindings`);
        }
      }

      const portTypeOp = portTypeOps.get(opName);
      const inputMessage = portTypeOp ? messages.get(localName(attr(asRecord(child(portTypeOp, 'input')), 'message'))) : undefined;
      const outputMessage = portTypeOp ? messages.get(localName(attr(asRecord(child(portTypeOp, 'output')), 'message'))) : undefined;

      if (portTypeOp) {
        const bindingHasOutput = child(operation, 'output') !== undefined;
        const portTypeHasOutput = child(portTypeOp, 'output') !== undefined;
        if (bindingHasOutput !== portTypeHasOutput) {
          warnings.push(`SOAP_LINT_ONE_WAY_OUTPUT_MISMATCH: operation ${opName} declares an output in ${bindingHasOutput ? 'the binding but not the portType' : 'the portType but not the binding'}; one-way operations must not declare an output`);
        }
      }

      const boundInput = boundParts(inputMessage, inputBody);
      const boundOutput = boundParts(outputMessage, outputBody);
      if (effStyle === 'document' && literal) {
        for (const [direction, parts] of [['input', boundInput], ['output', boundOutput]] as const) {
          for (const part of parts) {
            if (part.type) warnings.push(`SOAP_LINT_DOC_LITERAL_PART_TYPE: binding ${bindingName} operation ${opName} ${direction} part "${part.name}" references a type; doc-literal body parts must reference an element (WS-I Basic Profile 1.1 R2204)`);
          }
          if (parts.length > 1) warnings.push(`SOAP_LINT_DOC_LITERAL_MULTIPART: binding ${bindingName} operation ${opName} binds ${parts.length} ${direction} parts to the soap:body; doc-literal bodies allow at most one part (WS-I Basic Profile 1.1 R2201/R2210)`);
        }
      }
      if (effStyle === 'rpc' && literal) {
        for (const [direction, parts] of [['input', boundInput], ['output', boundOutput]] as const) {
          for (const part of parts) {
            if (part.element) warnings.push(`SOAP_LINT_RPC_LITERAL_PART_ELEMENT: binding ${bindingName} operation ${opName} ${direction} part "${part.name}" references an element; rpc-literal body parts must reference a type (WS-I Basic Profile 1.1 R2203)`);
          }
        }
      }

      let signature = '';
      if (effStyle === 'rpc') signature = `rpc:${attr(inputBody, 'namespace')}#${opName}`;
      else if (boundInput[0]?.element) signature = `doc:${boundInput[0].element}`;
      if (signature) {
        const prior = wireSignatures.get(signature);
        if (prior) warnings.push(`SOAP_LINT_DUPLICATE_WIRE_SIGNATURE: operations ${prior} and ${opName} in binding ${bindingName} produce the same top-level Body element QName on the wire; WS-I Basic Profile 1.1 R2710 requires unique wire signatures`);
        else wireSignatures.set(signature, opName);
      }

      for (const wsdlFault of children(operation, 'fault')) {
        const faultName = attr(wsdlFault, 'name');
        for (const soapFault of children(wsdlFault, 'fault')) {
          const soapFaultName = attr(soapFault, 'name');
          if (faultName && soapFaultName && soapFaultName !== faultName) {
            warnings.push(`SOAP_LINT_FAULT_NAME_MISMATCH: binding ${bindingName} operation ${opName} soap:fault name "${soapFaultName}" does not match the enclosing wsdl:fault name "${faultName}" (WS-I Basic Profile 1.1 R2754)`);
          }
        }
      }

      if (effStyle === 'document' && literal && boundInput[0]?.element && localName(boundInput[0].element) === opName) {
        warnings.push(`SOAP_LINT_DOC_LITERAL_WRAPPED: operation ${opName} follows the doc-literal-wrapped convention (input wrapper element <${localName(boundInput[0].element)}> is named after the operation); advisory only -- convention-based detection, not a WS-I requirement`);
      }
    }

    if (styles.has('rpc') && styles.has('document')) {
      warnings.push(`SOAP_LINT_MIXED_STYLES: binding ${bindingName} mixes rpc and document operation styles; WS-I Basic Profile 1.1 R2705 requires a single style per binding`);
    }

    if (portType) {
      const missingInBinding = [...portTypeOps.keys()].filter((name) => !bindingOpNames.has(name));
      const missingInPortType = [...bindingOpNames].filter((name) => !portTypeOps.has(name));
      for (const name of missingInBinding) warnings.push(`SOAP_LINT_BINDING_PORTTYPE_MISMATCH: binding ${bindingName} does not bind portType operation ${name}; WS-I Basic Profile 1.1 R2718 requires the binding to mirror the portType operation list`);
      for (const name of missingInPortType) warnings.push(`SOAP_LINT_BINDING_PORTTYPE_MISMATCH: binding ${bindingName} binds operation ${name} that is not declared on portType ${portTypeName} (WS-I Basic Profile 1.1 R2718)`);
    }
  }

  const addressLocations = new Map<string, string>();
  for (const service of children(definitions, 'service')) {
    for (const port of children(service, 'port')) {
      const portName = attr(port, 'name');
      const location = attr(asRecord(child(port, 'address')), 'location');
      if (!location) continue;
      if (!/^https?:\/\//i.test(location)) warnings.push(`SOAP_LINT_ADDRESS_NOT_HTTP: port ${portName} soap:address location "${location}" is not an http(s) URL`);
      const prior = addressLocations.get(location);
      if (prior) warnings.push(`SOAP_LINT_DUPLICATE_ADDRESS: ports ${prior} and ${portName} share soap:address location ${location}; WS-I Basic Profile 1.1 R2711 says ports SHOULD NOT share an address`);
      else addressLocations.set(location, portName);
    }
  }
}

/**
 * Parse a WSDL 1.1 or 2.0 document into a typed SOAP contract index.
 * Deterministic: services and operations preserve document order.
 */
export function parseWsdl(content: string, opts?: { resolveImport?: WsdlImportResolver }): SoapContractIndex {
  const text = asString(content).trim();
  if (!text) throw new Error('SOAP_EMPTY_WSDL: WSDL content is empty');
  // Well-formedness gate: malformed XML fails fast with a line number. Full
  // WSDL/XSD schema validation needs a validator bundle and stays out of the
  // offline scope; structural conformance is covered by the SOAP_WSI_* lints.
  const validation = XMLValidator.validate(text);
  if (validation !== true) {
    throw new Error(`SOAP_WSDL_XML_INVALID: WSDL is not well-formed XML: ${validation.err.msg} (line ${validation.err.line})`);
  }
  const parser = createParser();
  let root: JsonRecord | null;
  try {
    root = asRecord(parser.parse(text));
  } catch (error) {
    throw new Error(`SOAP_WSDL_PARSE_ERROR: ${(error as Error).message}`, { cause: error });
  }
  if (!root) throw new Error('SOAP_WSDL_PARSE_ERROR: document did not parse to an element');

  const definitions = asRecord(child(root, 'definitions'));
  const description = asRecord(child(root, 'description'));
  if (!definitions && !description) {
    throw new Error('SOAP_WSDL_ROOT_INVALID: expected a WSDL <definitions> (1.1) or <description> (2.0) root element');
  }

  const wsdlVersion = detectWsdlVersion(definitions, description);
  const warnings: string[] = [];
  warnings.push(...lintWsiConformance(text, opts?.resolveImport));
  const docNode = (definitions ?? description) as JsonRecord;
  const targetNamespace = attr(docNode, 'targetNamespace');
  const declaresAddressing = detectAddressing(docNode);
  const schemaIndex = buildXsdIndex(docNode);

  let services: SoapService[];
  if (definitions) {
    const messages = parseMessages11(definitions);
    const bindings = parseSoapBindings11(definitions, messages, warnings);
    lintWsdl11(definitions, messages, warnings);
    services = parseServices11(definitions, messages, bindings, warnings);
  } else {
    services = parseServices20(description as JsonRecord, warnings);
  }

  const totalOperations = services.reduce((sum, service) => sum + service.operations.length, 0);
  if (totalOperations === 0) throw new Error('SOAP_NO_OPERATIONS: WSDL declares no operations to assert against');

  return { wsdlVersion, targetNamespace, declaresAddressing, schemaIndex, services, warnings };
}

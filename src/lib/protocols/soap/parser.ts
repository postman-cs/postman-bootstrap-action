import { XMLParser } from 'fast-xml-parser';

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

export interface SoapOperation {
  /** Local operation name as declared on the portType/interface. */
  name: string;
  /** SOAPAction URI from the binding (empty string when none declared). */
  soapAction: string;
  /** Resolved SOAP envelope version for the binding holding this operation. */
  soapVersion: SoapVersion;
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
}

function parseSoapBindings11(definitions: JsonRecord): Map<string, Map<string, BindingOp11>> {
  // bindingName -> operationName -> { soapAction, soapVersion }
  const out = new Map<string, Map<string, BindingOp11>>();
  for (const binding of children(definitions, 'binding')) {
    const bindingName = attr(binding, 'name');
    if (!bindingName) continue;
    let soapVersion: SoapVersion | null = null;
    for (const key of Object.keys(binding)) {
      if (localName(key) !== 'binding') continue;
      // soap:binding / soap12:binding marker child; resolve version by prefix ns.
      const ns = namespaceForPrefix([definitions, binding], prefixOf(key));
      if (ns === SOAP12_BINDING_NS) soapVersion = '1.2';
      else if (ns === SOAP11_BINDING_NS) soapVersion = '1.1';
    }
    const ops = new Map<string, BindingOp11>();
    for (const operation of children(binding, 'operation')) {
      const opName = attr(operation, 'name');
      if (!opName) continue;
      let soapAction = '';
      for (const key of Object.keys(operation)) {
        if (localName(key) !== 'operation') continue;
        for (const marker of asArray(operation[key])) {
          const rec = asRecord(marker);
          const action = attr(rec, 'soapAction');
          if (action) soapAction = action;
        }
      }
      ops.set(opName, { soapAction, soapVersion: soapVersion ?? '1.1' });
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
      const inputRef = localName(attr(asRecord(child(operation, 'input')), 'message'));
      const outputRef = localName(attr(asRecord(child(operation, 'output')), 'message'));
      const input = inputRef ? messages.get(inputRef) : undefined;
      const output = outputRef ? messages.get(outputRef) : undefined;
      if (inputRef && !input) opWarnings.push(`SOAP_MESSAGE_UNRESOLVED: input message ${inputRef} for operation ${name} not found`);
      if (!outputRef) opWarnings.push(`SOAP_OPERATION_ONE_WAY: operation ${name} declares no output message; response assertions limited to transport`);
      const bindingOp = lookupBindingOp(bindings, name);
      const resolved = resolveResponseElement(output, [definitions]);
      if (resolved.warning) opWarnings.push(resolved.warning);
      return {
        name,
        soapAction: bindingOp?.soapAction ?? '',
        soapVersion: bindingOp?.soapVersion ?? defaultSoapVersion(bindings),
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

function parseServices20(description: JsonRecord, warnings: string[]): SoapService[] {
  warnings.push('SOAP_WSDL20_PARTIAL: WSDL 2.0 support is partial; operations are derived from interface/binding but message element resolution is best-effort');
  const interfaces = new Map<string, JsonRecord>();
  for (const iface of children(description, 'interface')) {
    const name = attr(iface, 'name');
    if (name) interfaces.set(name, iface);
  }
  const buildOperations = (iface: JsonRecord): SoapOperation[] =>
    children(iface, 'operation').map((operation) => {
      const name = attr(operation, 'name');
      const opWarnings: string[] = [];
      const out = asRecord(child(operation, 'output'));
      const outElement = localName(attr(out, 'element'));
      if (!out) opWarnings.push(`SOAP_OPERATION_ONE_WAY: operation ${name} declares no output; response assertions limited to transport`);
      return {
        name,
        soapAction: '',
        soapVersion: '1.2' as SoapVersion,
        input: undefined,
        output: outElement ? { name, parts: [{ name, element: attr(out, 'element') }] } : undefined,
        expectedResponseElement: outElement || undefined,
        expectedResponseNamespace: namespaceForPrefix([description], prefixOf(attr(out, 'element'))) || undefined,
        warnings: opWarnings
      };
    });
  const services: SoapService[] = [];
  for (const service of children(description, 'service')) {
    const name = attr(service, 'name');
    const ifaceName = localName(attr(service, 'interface'));
    const iface = interfaces.get(ifaceName);
    let endpoint = '';
    for (const ep of children(service, 'endpoint')) {
      const address = attr(ep, 'address');
      if (address && !endpoint) endpoint = address;
    }
    if (!endpoint) warnings.push(`SOAP_ENDPOINT_MISSING: service ${name} has no endpoint address; request URL left as placeholder`);
    services.push({ name, endpoint, operations: iface ? buildOperations(iface) : [] });
  }
  if (services.length === 0) {
    for (const iface of interfaces.values()) {
      services.push({ name: attr(iface, 'name'), endpoint: '', operations: buildOperations(iface) });
    }
  }
  return services;
}

/**
 * Parse a WSDL 1.1 or 2.0 document into a typed SOAP contract index.
 * Deterministic: services and operations preserve document order.
 */
export function parseWsdl(content: string): SoapContractIndex {
  const text = asString(content).trim();
  if (!text) throw new Error('SOAP_EMPTY_WSDL: WSDL content is empty');
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
  const docNode = (definitions ?? description) as JsonRecord;
  const targetNamespace = attr(docNode, 'targetNamespace');

  const services = definitions
    ? parseServices11(definitions, parseMessages11(definitions), parseSoapBindings11(definitions), warnings)
    : parseServices20(description as JsonRecord, warnings);

  const totalOperations = services.reduce((sum, service) => sum + service.operations.length, 0);
  if (totalOperations === 0) throw new Error('SOAP_NO_OPERATIONS: WSDL declares no operations to assert against');

  return { wsdlVersion, targetNamespace, services, warnings };
}

import { createHash } from 'node:crypto';
import { defaultActionIri, localName, type SoapContractIndex, type SoapOperation, type SoapService, type SoapVersion } from './parser.js';

type JsonRecord = Record<string, unknown>;

export interface SoapBuilderOptions {
  /** Collection name; defaults to the first service name or "SOAP Service". */
  collectionName?: string;
  /** Postman Spec Hub specification id, threaded into extensions.schema. */
  specificationId?: string;
  apiId?: string;
  versionId?: string;
  /** Source of the schema (file path or URL) recorded in extensions.schema. */
  schemaLocation?: string;
  /** extensions.schema.source discriminator. */
  schemaSource?: 'file' | 'auto' | 'specification' | 'api';
}

export interface SoapHttpRequestItem extends JsonRecord {
  id: string;
  name: string;
  request: {
    method: 'POST';
    header: Array<{ key: string; value: string }>;
    body: { mode: 'raw'; raw: string; options: { raw: { language: 'xml' } } };
    url: { raw: string; host?: string[]; path?: string[] };
    auth: { type: 'noauth' };
  };
  event: JsonRecord[];
}

/** v2.1.0 Collection schema URL. SOAP runs as an ordinary raw-XML HTTP POST. */
export const COLLECTION_V210_SCHEMA =
  'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' as const;

const SOAP11_ENVELOPE_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
const SOAP12_ENVELOPE_NS = 'http://www.w3.org/2003/05/soap-envelope';
const SOAP11_CONTENT_TYPE = 'text/xml; charset=UTF-8';
const SOAP12_CONTENT_TYPE = 'application/soap+xml; charset=UTF-8';
const WSA_NS = 'http://www.w3.org/2005/08/addressing';

/** Stable hex id derived from the operation identity (deterministic builds). */
function stableId(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 32);
}

function envelopeNamespace(version: SoapVersion): string {
  return version === '1.2' ? SOAP12_ENVELOPE_NS : SOAP11_ENVELOPE_NS;
}

function contentType(version: SoapVersion): string {
  return version === '1.2' ? SOAP12_CONTENT_TYPE : SOAP11_CONTENT_TYPE;
}

/**
 * Build a minimal, well-formed SOAP envelope for the operation request. The
 * request body wrapper is the input message's first element local name (or the
 * operation name) so the envelope is valid even before parameters are filled in.
 * When the WSDL engages WS-Addressing the Header carries wsa:Action plus, for
 * request-response operations, a wsa:MessageID ({{$guid}}, unique per send) and
 * an anonymous wsa:ReplyTo, so a conformant server replies instead of faulting
 * with MissingAddressInHeader (WS-Addressing 1.0 SOAP Binding section 6.4.2).
 */
function buildEnvelope(operation: SoapOperation, targetNamespace: string, declaresAddressing: boolean): string {
  const version = operation.soapVersion;
  const envNs = envelopeNamespace(version);
  const part = operation.input?.parts[0];
  const wrapper = part?.element ? localName(part.element) : operation.name;
  const bodyNsAttr = targetNamespace ? ` xmlns:op="${targetNamespace}"` : '';
  const wrapperOpen = targetNamespace ? `op:${wrapper}` : wrapper;
  const action = declaresAddressing ? requestActionIri(operation, targetNamespace) : '';
  const wsaNsAttr = action ? ` xmlns:wsa="${WSA_NS}"` : '';
  const headerLines = action
    ? [
        '  <soap:Header>',
        `    <wsa:Action>${action}</wsa:Action>`,
        ...(operation.output
          ? [
              '    <wsa:MessageID>urn:uuid:{{$guid}}</wsa:MessageID>',
              '    <wsa:ReplyTo>',
              `      <wsa:Address>${WSA_NS}/anonymous</wsa:Address>`,
              '    </wsa:ReplyTo>'
            ]
          : []),
        '  </soap:Header>'
      ]
    : ['  <soap:Header/>'];
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<soap:Envelope xmlns:soap="${envNs}"${wsaNsAttr}${bodyNsAttr}>`,
    ...headerLines,
    '  <soap:Body>',
    `    <${wrapperOpen}>`,
    `      <!-- TODO: populate ${wrapper} parameters -->`,
    `    </${wrapperOpen.split(' ')[0]}>`,
    '  </soap:Body>',
    '</soap:Envelope>'
  ];
  return lines.join('\n');
}

/**
 * wsa:Action for the request message: an explicit wsaw:/wsam:Action wins, then
 * a non-empty SOAPAction (the WS-A SOAP 1.1 binding default), then the WSDL
 * default action pattern with the defaulted input name ([operation]Request,
 * WSDL 1.1 section 2.4.5).
 */
function requestActionIri(operation: SoapOperation, targetNamespace: string): string {
  return operation.inputAction || operation.soapAction || defaultActionIri(targetNamespace, operation.portTypeName, operation.inputName || `${operation.name}Request`);
}

function headersFor(operation: SoapOperation): Array<{ key: string; value: string }> {
  const headers: Array<{ key: string; value: string }> = [
    { key: 'Content-Type', value: contentType(operation.soapVersion) }
  ];
  // SOAP 1.1 carries SOAPAction as a header; SOAP 1.2 folds it into Content-Type
  // (action="..."). We always emit the header for 1.1 (even when empty: the
  // WS-I Basic Profile requires the SOAPAction HTTP header to be present).
  if (operation.soapVersion === '1.1') {
    headers.push({ key: 'SOAPAction', value: `"${operation.soapAction}"` });
  } else if (operation.soapAction) {
    headers[0] = {
      key: 'Content-Type',
      value: `${contentType(operation.soapVersion).replace(/; charset=UTF-8$/i, '')}; action="${operation.soapAction}"; charset=UTF-8`
    };
  }
  return headers;
}

/**
 * Split a (possibly variable-interpolated) URL string into the v2.1.0 url
 * descriptor. The raw form is preserved so Newman resolves it verbatim.
 */
function buildUrlDescriptor(raw: string): { raw: string; host?: string[]; path?: string[] } {
  const descriptor: { raw: string; host?: string[]; path?: string[] } = { raw };
  const withoutProtocol = raw.replace(/^[a-zA-Z][\w+.-]*:\/\//, '');
  const [hostAndPath] = withoutProtocol.split('?');
  const slash = hostAndPath.indexOf('/');
  const hostPart = slash === -1 ? hostAndPath : hostAndPath.slice(0, slash);
  const pathPart = slash === -1 ? '' : hostAndPath.slice(slash + 1);
  if (hostPart) descriptor.host = [hostPart];
  const segments = pathPart.split('/').filter((segment) => segment.length > 0);
  if (segments.length > 0) descriptor.path = segments;
  return descriptor;
}

function buildItem(
  service: SoapService,
  operation: SoapOperation,
  targetNamespace: string,
  declaresAddressing: boolean
): SoapHttpRequestItem {
  return {
    id: stableId(`${service.name}::${operation.name}`),
    name: operation.name,
    request: {
      method: 'POST',
      header: headersFor(operation),
      body: {
        mode: 'raw',
        raw: buildEnvelope(operation, targetNamespace, declaresAddressing),
        options: { raw: { language: 'xml' } }
      },
      url: buildUrlDescriptor(service.endpoint || '{{baseUrl}}'),
      auth: { type: 'noauth' }
    },
    event: []
  };
}

/**
 * Negative-probe item name recognized by the instrumenter. SOAP 1.2 Part 2
 * (section 7, HTTP binding) maps an unsupported request media type to HTTP
 * 415, not a 500 or a silent 200: the probe sends a valid envelope mislabeled
 * as text/plain and the instrumenter asserts the 415 classification.
 */
export const SOAP12_UNSUPPORTED_MEDIA_PROBE_NAME = 'Unsupported media type probe (SOAP 1.2)';

function buildUnsupportedMediaProbeItem(
  service: SoapService,
  operation: SoapOperation,
  targetNamespace: string
): SoapHttpRequestItem {
  return {
    id: stableId(`${service.name}::${SOAP12_UNSUPPORTED_MEDIA_PROBE_NAME}`),
    name: SOAP12_UNSUPPORTED_MEDIA_PROBE_NAME,
    request: {
      method: 'POST',
      header: [{ key: 'Content-Type', value: 'text/plain; charset=UTF-8' }],
      body: {
        mode: 'raw',
        raw: buildEnvelope(operation, targetNamespace, false),
        options: { raw: { language: 'xml' } }
      },
      url: buildUrlDescriptor(service.endpoint || '{{baseUrl}}'),
      auth: { type: 'noauth' }
    },
    event: []
  };
}

/**
 * Build a v2.1.0 collection JSON object from a SOAP contract index. One http
 * (`body.mode: raw`, language xml) item per operation grouped into a folder per
 * service, deterministic ordering by (service order, operation order). No
 * spec-hub generation is involved; SOAP runs over the plain HTTP path in the
 * Postman CLI / Newman runner.
 */
export function buildSoapCollection(index: SoapContractIndex, options: SoapBuilderOptions = {}): JsonRecord {
  const folders: JsonRecord[] = [];
  for (const service of index.services) {
    const items: SoapHttpRequestItem[] = [];
    for (const operation of service.operations) {
      items.push(buildItem(service, operation, index.targetNamespace, index.declaresAddressing));
    }
    const probeOperation = service.operations.find((operation) => operation.soapVersion === '1.2');
    if (probeOperation) {
      items.push(buildUnsupportedMediaProbeItem(service, probeOperation, index.targetNamespace));
    }
    folders.push({
      id: stableId(`folder::${service.name}`),
      name: service.name,
      item: items
    });
  }

  const collectionName = options.collectionName ?? index.services[0]?.name ?? 'SOAP Service';
  return {
    info: {
      name: collectionName,
      description: options.schemaLocation
        ? `SOAP contract assertions generated from ${options.schemaLocation}.`
        : 'SOAP contract assertions generated from WSDL.',
      schema: COLLECTION_V210_SCHEMA
    },
    item: folders
  };
}

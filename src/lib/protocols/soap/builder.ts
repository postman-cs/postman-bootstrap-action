import { createHash } from 'node:crypto';
import { localName, type SoapContractIndex, type SoapOperation, type SoapService, type SoapVersion } from './parser.js';

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
 */
function buildEnvelope(operation: SoapOperation, targetNamespace: string): string {
  const version = operation.soapVersion;
  const envNs = envelopeNamespace(version);
  const part = operation.input?.parts[0];
  const wrapper = part?.element ? localName(part.element) : operation.name;
  const bodyNsAttr = targetNamespace ? ` xmlns:op="${targetNamespace}"` : '';
  const wrapperOpen = targetNamespace ? `op:${wrapper}` : wrapper;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<soap:Envelope xmlns:soap="${envNs}"${bodyNsAttr}>`,
    '  <soap:Header/>',
    '  <soap:Body>',
    `    <${wrapperOpen}>`,
    `      <!-- TODO: populate ${wrapper} parameters -->`,
    `    </${wrapperOpen.split(' ')[0]}>`,
    '  </soap:Body>',
    '</soap:Envelope>'
  ];
  return lines.join('\n');
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
  targetNamespace: string
): SoapHttpRequestItem {
  return {
    id: stableId(`${service.name}::${operation.name}`),
    name: operation.name,
    request: {
      method: 'POST',
      header: headersFor(operation),
      body: {
        mode: 'raw',
        raw: buildEnvelope(operation, targetNamespace),
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
      items.push(buildItem(service, operation, index.targetNamespace));
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

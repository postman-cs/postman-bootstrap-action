import { localName, type SoapContractIndex, type SoapOperation } from './parser.js';

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

/** Build the afterResponse JavaScript for one SOAP operation. */
export function createSoapScript(operation: SoapOperation, warnings: string[] = []): string {
  const meta = {
    name: operation.name,
    soapVersion: operation.soapVersion,
    expectedResponseElement: operation.expectedResponseElement ?? '',
    hasOutput: Boolean(operation.output)
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
      '});'
    ] : [
      '',
      "pm.test('SOAP Fault is well-formed for SOAP 1.1', function () {",
      '  if (!matchTag("Fault").test(bodyText)) return;',
      '  if (!matchTag("faultcode").test(bodyText)) pm.expect.fail("a SOAP 1.1 Fault must carry a faultcode child (SOAP 1.1 section 4.4)");',
      '  if (!matchTag("faultstring").test(bodyText)) pm.expect.fail("a SOAP 1.1 Fault must carry a faultstring child (SOAP 1.1 section 4.4)");',
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
    const exec = createSoapScript(operation, warnings).split('\n');
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

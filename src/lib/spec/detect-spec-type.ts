type JsonRecord = Record<string, unknown>;

export type SpecType = 'openapi' | 'graphql' | 'grpc' | 'soap';

/**
 * Classify an API spec document into the protocol whose generator owns it.
 * Detection is content-first (so an explicit extension is not required) with
 * an optional filename hint used as a tie-breaker. OpenAPI is the default and
 * the only type that flows through the existing Spec-Hub pipeline; the other
 * three are handled by the multi-protocol dispatch.
 *
 * - grpc  -> Protocol Buffers `.proto` IDL
 * - soap  -> WSDL 1.1 / 2.0 XML
 * - graphql -> GraphQL SDL or introspection JSON (`__schema`)
 * - openapi -> OpenAPI 3.0 / 3.1 (or Swagger 2.0, rejected later by the loader)
 */
export function detectSpecType(content: string, fileName?: string): SpecType {
  const text = String(content ?? '');
  const trimmed = text.trim();
  const lowerName = (fileName ?? '').toLowerCase();

  // Extension hints are authoritative when unambiguous.
  if (lowerName.endsWith('.proto')) return 'grpc';
  if (lowerName.endsWith('.wsdl')) return 'soap';
  if (lowerName.endsWith('.graphql') || lowerName.endsWith('.graphqls') || lowerName.endsWith('.gql')) {
    return 'graphql';
  }

  // WSDL / SOAP: XML document with a WSDL definitions root.
  if (trimmed.startsWith('<')) {
    if (/<(?:[A-Za-z_][\w.-]*:)?(?:definitions|description)\b/.test(trimmed) && /wsdl/i.test(trimmed)) {
      return 'soap';
    }
    // A bare XML document with SOAP/WSDL namespaces still maps to soap.
    if (/schemas\.xmlsoap\.org\/wsdl|www\.w3\.org\/ns\/wsdl/i.test(trimmed)) {
      return 'soap';
    }
  }

  // JSON document: OpenAPI/Swagger vs GraphQL introspection.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = undefined;
    }
    const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonRecord) : null;
    if (record) {
      if (looksLikeIntrospection(record)) return 'graphql';
      if (typeof record.openapi === 'string' || record.swagger === '2.0') return 'openapi';
    }
    // Unrecognized JSON defaults to OpenAPI so the loader can produce its
    // canonical version-gate error rather than a vague protocol mismatch.
    return 'openapi';
  }

  // Protocol Buffers: `syntax = "proto3";` or a `service ... { rpc ... }` block.
  if (/^\s*syntax\s*=\s*["']proto[23]["']/m.test(text) || /\bservice\s+\w+\s*\{[\s\S]*\brpc\b/.test(text)) {
    return 'grpc';
  }

  // GraphQL SDL: a type-system definition. Match the DEFINITION syntax, not the
  // bare keyword: SDL writes `type Name`, `enum Name`, `schema {`, `directive @x`
  // -- keyword followed by an identifier, a brace, or `@`. A bare `\b` boundary
  // would also fire on a YAML mapping key (`type:`, `enum:`), which every OpenAPI
  // YAML spec has in abundance, misclassifying it as GraphQL. Requiring the
  // post-keyword name/brace/at keeps SDL matches while ignoring YAML keys.
  if (
    /^\s*(?:"""[\s\S]*?"""\s*)?(?:extend\s+)?(?:(?:type|interface|enum|union|scalar|input)\s+[A-Za-z_]|schema\s*\{|directive\s+@)/m.test(
      text
    )
  ) {
    return 'graphql';
  }

  // YAML OpenAPI (openapi:/swagger: key) or anything else falls back to OpenAPI.
  return 'openapi';
}

function looksLikeIntrospection(record: JsonRecord): boolean {
  if (record.__schema && typeof record.__schema === 'object') return true;
  const data = record.data;
  return Boolean(data && typeof data === 'object' && (data as JsonRecord).__schema);
}

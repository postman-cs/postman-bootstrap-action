// Minimal XSD component index over wsdl:types schemas. Deterministic and
// offline: with no resolver, xsd:import/include/redefine mark the index
// incomplete so consumers skip rather than guess. When a resolver is supplied
// (DefinitionBundle or legacy import resolver), relative schema locations are
// followed recursively and their global elements participate.
// Only plain xsd:sequence content models one level deep are indexed;
// all/choice/wildcard/derived content yields no child metadata so the
// generated assertions never fail on shapes the index cannot prove.
// Assertable extras carried per element: required/fixed attribute uses and
// enumeration facets of same-schema simple types.

import { XMLParser } from 'fast-xml-parser';

type JsonRecord = Record<string, unknown>;

const XSD_NS = 'http://www.w3.org/2001/XMLSchema';

export interface XsdAttributeUse {
  /** Local name of the attribute (ref targets contribute their local name). */
  name: string;
  /** True when use="required". */
  required: boolean;
  /** Fixed value constraint, when declared. */
  fixed?: string;
}

export interface XsdChildElement {
  /** Local name of the child element (ref targets contribute their local name). */
  name: string;
  minOccurs: number;
  maxOccurs: number | 'unbounded';
  nillable: boolean;
  /** XSD built-in simple type local name, when the child type resolves to one. */
  builtinType?: string;
  /** Enumeration facet values when the child type is a same-schema enumerated simpleType. */
  enumeration?: string[];
  /** True when the child is an element ref; its form follows the referenced declaration. */
  viaRef?: boolean;
}

export interface XsdElementDecl {
  name: string;
  namespace: string;
  nillable: boolean;
  /** Effective form for local child elements of this element's schema. */
  childrenQualified: boolean;
  /** Required or fixed attribute uses on the element's complexType. */
  attributes?: XsdAttributeUse[];
  /** Direct xsd:sequence children; undefined when the content model is not a plain sequence. */
  children?: XsdChildElement[];
}

export interface XsdSchemaIndex {
  /** False when any import/include/redefine leaves the inline picture partial. */
  complete: boolean;
  /** Global element declarations keyed by "namespace|localName". */
  elements: Map<string, XsdElementDecl>;
  /** Top-level complexType/simpleType local names (xsi:type checks). */
  typeLocalNames: Set<string>;
}

// Tree-walk helpers duplicated from parser.ts by design (shared helpers are
// intentionally duplicated per module in this codebase).
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

function localName(qname: string): string {
  const value = asString(qname);
  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(colon + 1);
}

function prefixOf(qname: string): string {
  const value = asString(qname);
  const colon = value.indexOf(':');
  return colon === -1 ? '' : value.slice(0, colon);
}

function child(record: JsonRecord | null, local: string): unknown {
  if (!record) return undefined;
  for (const key of Object.keys(record)) {
    if (key.startsWith('@_') || key === '#text') continue;
    if (localName(key) === local) return record[key];
  }
  return undefined;
}

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
  const direct = record['@_' + name];
  if (direct !== undefined) return asString(direct);
  for (const key of Object.keys(record)) {
    if (!key.startsWith('@_')) continue;
    if (localName(key.slice(2)) === name) return asString(record[key]);
  }
  return '';
}

function namespaceForPrefix(scopes: JsonRecord[], prefix: string): string {
  const attrName = prefix ? 'xmlns:' + prefix : 'xmlns';
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    const scope = scopes[i];
    if (!scope) continue;
    const value = attr(scope, attrName);
    if (value) return value;
  }
  return '';
}

function parseOccursMin(raw: string): number {
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? 1 : value;
}

function parseOccursMax(raw: string): number | 'unbounded' {
  if (raw === 'unbounded') return 'unbounded';
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? 1 : value;
}

interface SimpleTypeFacets {
  base?: string;
  enums?: string[];
}

/** Base builtin and enumeration facets of an xsd:simpleType restriction. */
function simpleTypeFacets(simpleType: JsonRecord, scopes: JsonRecord[]): SimpleTypeFacets {
  const restriction = asRecord(child(simpleType, 'restriction'));
  if (!restriction) return {};
  const baseQName = attr(restriction, 'base');
  const baseNs = baseQName ? namespaceForPrefix([...scopes, restriction], prefixOf(baseQName)) : '';
  const enums = children(restriction, 'enumeration').map((e) => attr(e, 'value')).filter((v) => v !== '');
  return {
    ...(baseQName && baseNs === XSD_NS ? { base: localName(baseQName) } : {}),
    ...(enums.length > 0 ? { enums } : {})
  };
}

/** Required or fixed attribute uses declared directly on a complexType. */
function attributeUses(complexType: JsonRecord | null): XsdAttributeUse[] | undefined {
  if (!complexType) return undefined;
  const out: XsdAttributeUse[] = [];
  for (const a of children(complexType, 'attribute')) {
    const name = attr(a, 'name') || localName(attr(a, 'ref'));
    if (!name) continue;
    const required = attr(a, 'use') === 'required';
    const fixed = attr(a, 'fixed');
    if (!required && !fixed) continue;
    out.push({ name, required, ...(fixed ? { fixed } : {}) });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Direct element children of a complexType when (and only when) its content
 * model is a single flat xsd:sequence. Derived, mixed-model, or grouped
 * content returns undefined so callers skip child assertions entirely.
 */
function sequenceChildren(complexType: JsonRecord | null, scopes: JsonRecord[], tns: string, simpleTypes: Map<string, SimpleTypeFacets>): XsdChildElement[] | undefined {
  if (!complexType) return undefined;
  if (child(complexType, 'complexContent') !== undefined || child(complexType, 'simpleContent') !== undefined) return undefined;
  if (child(complexType, 'choice') !== undefined || child(complexType, 'all') !== undefined || child(complexType, 'group') !== undefined) return undefined;
  const sequence = asRecord(child(complexType, 'sequence'));
  if (!sequence) return [];
  if (child(sequence, 'choice') !== undefined || child(sequence, 'sequence') !== undefined || child(sequence, 'any') !== undefined || child(sequence, 'group') !== undefined) return undefined;
  const out: XsdChildElement[] = [];
  for (const el of children(sequence, 'element')) {
    const ref = attr(el, 'ref');
    const name = attr(el, 'name') || localName(ref);
    if (!name) return undefined;
    const typeQName = attr(el, 'type');
    const typeNs = typeQName ? namespaceForPrefix([...scopes, el], prefixOf(typeQName)) : '';
    let builtinType = typeQName && typeNs === XSD_NS ? localName(typeQName) : undefined;
    let enumeration: string[] | undefined;
    if (typeQName && typeNs === tns) {
      const sameSchema = simpleTypes.get(localName(typeQName));
      if (sameSchema) {
        builtinType = sameSchema.base ?? builtinType;
        enumeration = sameSchema.enums;
      }
    }
    const inlineSimple = asRecord(child(el, 'simpleType'));
    if (inlineSimple) {
      const facets = simpleTypeFacets(inlineSimple, [...scopes, el]);
      builtinType = facets.base ?? builtinType;
      enumeration = facets.enums ?? enumeration;
    }
    out.push({
      name,
      minOccurs: parseOccursMin(attr(el, 'minOccurs')),
      maxOccurs: parseOccursMax(attr(el, 'maxOccurs')),
      nillable: /^(true|1)$/.test(attr(el, 'nillable')),
      ...(builtinType ? { builtinType } : {}),
      ...(enumeration && enumeration.length > 0 ? { enumeration } : {}),
      ...(ref ? { viaRef: true } : {})
    });
  }
  return out;
}

/**
 * Resolve an xsd:import/include/redefine schemaLocation relative to the file
 * that contains it. Returns the normalized resolved key (for visit tracking)
 * and document content. Legacy resolvers may echo the raw location as the key.
 */
export type XsdImportResolver = (
  location: string,
  fromKey: string
) => { key: string; content: string } | undefined;

function parseSchemaDocument(content: string): JsonRecord | null {
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      removeNSPrefix: false
    });
    return asRecord(parser.parse(content));
  } catch {
    return null;
  }
}

function schemaRootFromDocument(parsed: JsonRecord | null): JsonRecord | null {
  if (!parsed) return null;
  const direct = asRecord(child(parsed, 'schema'));
  if (direct) return direct;
  // Some parsers surface the schema as the document root under a namespaced key.
  for (const key of Object.keys(parsed)) {
    if (key.startsWith('@_') || key === '#text') continue;
    if (localName(key) === 'schema') {
      const record = asRecord(parsed[key]);
      if (record) return record;
    }
  }
  return null;
}

function indexSchemaNode(
  schema: JsonRecord,
  scopes: JsonRecord[],
  index: XsdSchemaIndex
): void {
  const tns = attr(schema, 'targetNamespace');
  const qualified = attr(schema, 'elementFormDefault') === 'qualified';
  const complexTypes = new Map<string, JsonRecord>();
  for (const complexType of children(schema, 'complexType')) {
    const name = attr(complexType, 'name');
    if (!name) continue;
    complexTypes.set(name, complexType);
    index.typeLocalNames.add(name);
  }
  const simpleTypes = new Map<string, SimpleTypeFacets>();
  for (const simpleType of children(schema, 'simpleType')) {
    const name = attr(simpleType, 'name');
    if (!name) continue;
    index.typeLocalNames.add(name);
    simpleTypes.set(name, simpleTypeFacets(simpleType, [...scopes, simpleType]));
  }
  for (const el of children(schema, 'element')) {
    const name = attr(el, 'name');
    if (!name) continue;
    const inline = asRecord(child(el, 'complexType'));
    const typeQName = attr(el, 'type');
    const named = typeQName && namespaceForPrefix([...scopes, el], prefixOf(typeQName)) !== XSD_NS
      ? complexTypes.get(localName(typeQName)) ?? null
      : null;
    index.elements.set(tns + '|' + name, {
      name,
      namespace: tns,
      nillable: /^(true|1)$/.test(attr(el, 'nillable')),
      childrenQualified: qualified,
      attributes: attributeUses(inline ?? named),
      children: sequenceChildren(inline ?? named, [...scopes, el], tns, simpleTypes)
    });
  }
}

function followSchemaImports(
  schema: JsonRecord,
  scopes: JsonRecord[],
  index: XsdSchemaIndex,
  resolveImport: XsdImportResolver | undefined,
  visited: Set<string>,
  strict: boolean,
  fromKey: string
): void {
  const locations: string[] = [];
  for (const kind of ['import', 'include', 'redefine'] as const) {
    for (const node of children(schema, kind)) {
      const location = attr(node, 'schemaLocation');
      if (location) locations.push(location);
    }
  }
  if (locations.length === 0) return;
  if (!resolveImport) {
    index.complete = false;
    return;
  }
  for (const location of locations) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(location)) {
      if (strict) {
        throw new Error(`CONTRACT_DEFINITION_CLOSURE_INCOMPLETE: Remote XSD reference is not allowed: ${location}`);
      }
      index.complete = false;
      continue;
    }
    const resolved = resolveImport(location, fromKey);
    if (resolved === undefined) {
      if (strict) {
        throw new Error(`CONTRACT_DEFINITION_CLOSURE_INCOMPLETE: Missing XSD member ${location}`);
      }
      index.complete = false;
      continue;
    }
    // Visit by normalized resolved path so the same relative schemaLocation from
    // two different importers is not collapsed, and cycles are keyed by identity.
    if (visited.has(resolved.key)) continue;
    visited.add(resolved.key);
    const schemaNode = schemaRootFromDocument(parseSchemaDocument(resolved.content));
    if (!schemaNode) {
      if (strict) {
        throw new Error(`CONTRACT_DEFINITION_CLOSURE_INCOMPLETE: XSD member ${location} is not a schema document`);
      }
      index.complete = false;
      continue;
    }
    indexSchemaNode(schemaNode, [...scopes, schemaNode], index);
    followSchemaImports(schemaNode, [...scopes, schemaNode], index, resolveImport, visited, strict, resolved.key);
  }
}

/**
 * Build the XSD index from a parsed WSDL definitions/description node.
 * Deterministic: schemas and elements preserve document order.
 * Nested xsd:import/include/redefine resolve relative to the containing file
 * (`originKey` for inline wsdl:types schemas; the resolved schema key thereafter).
 */
export function buildXsdIndex(
  docNode: JsonRecord,
  opts?: { resolveImport?: XsdImportResolver; strictClosure?: boolean; originKey?: string }
): XsdSchemaIndex {
  const index: XsdSchemaIndex = { complete: true, elements: new Map(), typeLocalNames: new Set() };
  const resolveImport = opts?.resolveImport;
  const strict = opts?.strictClosure === true;
  const originKey = opts?.originKey ?? '';
  const visited = new Set<string>();

  for (const types of children(docNode, 'types')) {
    for (const schema of children(types, 'schema')) {
      const scopes = [docNode, types, schema];
      indexSchemaNode(schema, scopes, index);
      followSchemaImports(schema, scopes, index, resolveImport, visited, strict, originKey);
    }
  }
  // wsdl:import at the top level can carry schemas this offline pass never sees
  // unless a resolver is supplied (WSDL merge happens in parseWsdl).
  if (!resolveImport && children(docNode, 'import').length > 0) index.complete = false;
  return index;
}

/** Look up a global element by namespace+local, falling back to a unique local-name match. */
export function lookupXsdElement(index: XsdSchemaIndex, namespace: string | undefined, name: string): XsdElementDecl | undefined {
  if (namespace) {
    const hit = index.elements.get(namespace + '|' + name);
    if (hit) return hit;
  }
  const matches = [...index.elements.values()].filter((el) => el.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

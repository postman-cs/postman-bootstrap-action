import { asRecord, asArray, resolveInternalRef } from './contract-index.js';

type Rec = NonNullable<ReturnType<typeof asRecord>>;

function typeNames(rec: Rec): string[] {
  const t = rec.type;
  return Array.isArray(t) ? t.map(String) : typeof t === 'string' ? [t] : [];
}
function isAbs(u: string): boolean {
  try { return !!new URL(u).protocol; } catch { return false; }
}
function isUriRef(u: string): boolean {
  try { new URL(u, 'https://placeholder.invalid/'); return true; } catch { return false; }
}
function mediaBase(ct: string): string {
  return (ct.toLowerCase().split(';')[0] ?? '').trim();
}
function isValidMediaType(t: string): boolean {
  const token = (t.split(';')[0] ?? '').trim();
  if (token.endsWith('/*') || token === '*/*') return true;
  return /^[!#$%&'*+.^_|~0-9A-Za-z-]+\/[!#$%&'*+.^_|~0-9A-Za-z-]+$/.test(token);
}
function isJsonMediaType(t: string): boolean {
  const base = mediaBase(t);
  return base === 'application/json' || base.endsWith('+json');
}
function mediaExampleCandidates(root: Rec, media: Rec): Array<{ label: string; value: unknown }> {
  const out: Array<{ label: string; value: unknown }> = [];
  if (Object.prototype.hasOwnProperty.call(media, 'example')) out.push({ label: 'example', value: media.example });
  for (const [name, rawEx] of Object.entries(asRecord(media.examples) ?? {})) {
    const ex = resolveInternalRef(root, rawEx) ?? asRecord(rawEx);
    if (ex && Object.prototype.hasOwnProperty.call(ex, 'value')) out.push({ label: `examples.${name}`, value: (ex as Rec).value });
  }
  return out;
}
function mergedParams(root: Rec, pathItem: Rec, operation: Rec): Rec[] {
  const seen = new Map<string, Rec>();
  const collect = (arr: unknown): void => {
    for (const raw of asArray(arr)) {
      const p = resolveInternalRef(root, raw) ?? asRecord(raw);
      if (!p) continue;
      seen.set(String((p as Rec).in ?? '').toLowerCase() + ':' + String((p as Rec).name ?? '').toLowerCase(), p as Rec);
    }
  };
  collect(pathItem.parameters);
  collect(operation.parameters);
  return [...seen.values()];
}

export function collectSchemaObjectLints(root: Rec, record: Rec, version: string, context: string): string[] {
  const out: string[] = [];
  const types = typeNames(record);

  // rows 8/9: discriminator inline branches, mapping membership + resolution
  const disc = asRecord(record.discriminator);
  if (disc) {
    const members = [...asArray(record.oneOf), ...asArray(record.anyOf)];
    for (const m of members) {
      const mr = asRecord(m);
      if (mr && typeof mr.$ref !== 'string') out.push('CONTRACT_DISCRIMINATOR_INVALID: ' + context + ' has an inline oneOf/anyOf branch that a discriminator mapping cannot reference; use a named $ref branch');
    }
    const memberRefs = new Set(members.map((m) => asRecord(m)?.$ref).filter((x): x is string => typeof x === 'string'));
    for (const [key, rawVal] of Object.entries(asRecord(disc.mapping) ?? {})) {
      if (typeof rawVal !== 'string') continue;
      const isName = !rawVal.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(rawVal) && !rawVal.includes('/');
      const target = isName ? '#/components/schemas/' + rawVal : rawVal;
      if (isName && asRecord(asRecord(asRecord(root.components)?.schemas))?.[rawVal] === undefined) out.push('CONTRACT_DISCRIMINATOR_INVALID: ' + context + ' discriminator mapping key ' + key + ' names schema ' + rawVal + ', which is not a component schema');
      if (memberRefs.size > 0 && !memberRefs.has(target)) out.push('CONTRACT_DISCRIMINATOR_INVALID: ' + context + ' discriminator mapping key ' + key + ' points to ' + rawVal + ', which is not one of the oneOf/anyOf branches');
      if (version === '3.1' && !rawVal.startsWith('#') && rawVal.includes('/') && !/^[a-z][a-z0-9+.-]*:/i.test(rawVal)) out.push('CONTRACT_DISCRIMINATOR_INVALID: ' + context + ' discriminator mapping ' + rawVal + ' is a relative URI whose base is ambiguous under OpenAPI 3.1');
    }
  }

  // rows 10-14: XML Object
  const xml = asRecord(record.xml);
  if (xml) {
    if (typeof xml.namespace === 'string' && xml.namespace !== '' && !isAbs(xml.namespace)) out.push('CONTRACT_XML_OBJECT_INVALID: ' + context + ' xml.namespace ' + xml.namespace + ' is not an absolute URI');
    if (typeof xml.prefix === 'string' && xml.prefix !== '' && xml.namespace === undefined) out.push('CONTRACT_XML_OBJECT_INVALID: ' + context + ' xml.prefix is set without an xml.namespace to bind it');
    for (const nm of ['name', 'prefix']) {
      const val = (xml as Rec)[nm];
      if (typeof val === 'string' && val !== '' && !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(val)) out.push('CONTRACT_XML_OBJECT_INVALID: ' + context + ' xml.' + nm + ' ' + val + ' is not a valid NCName');
    }
    if (xml.wrapped === true && !types.includes('array')) out.push('CONTRACT_XML_OBJECT_INVALID: ' + context + ' xml.wrapped applies only to array schemas');
    if (xml.attribute === true && (types.includes('object') || types.includes('array'))) out.push('CONTRACT_XML_OBJECT_INVALID: ' + context + ' xml.attribute cannot serialize an object or array as an XML attribute');
    if (types.includes('array') && xml.wrapped !== true) {
      const items = asRecord(record.items);
      if (items && asRecord(items.xml)?.name !== undefined) out.push('CONTRACT_XML_OBJECT_INVALID: ' + context + ' array item declares xml.name but the array is not xml.wrapped, so element naming is advisory only');
    }
  }

  // row 25: $id URI reference
  if (typeof record.$id === 'string' && record.$id !== '' && !isUriRef(record.$id)) out.push('CONTRACT_SCHEMA_ID_INVALID: ' + context + ' $id ' + record.$id + ' is not a valid URI reference');

  // row 26: contentMediaType/contentEncoding contradictions (3.1 only; 3.0 already flags them)
  if (version === '3.1' && types.length > 0 && !types.includes('string')) {
    if (record.contentMediaType !== undefined) out.push('CONTRACT_CONTENT_MEDIA_TYPE_INVALID: ' + context + ' contentMediaType applies only to string-typed schemas');
    if (record.contentEncoding !== undefined) out.push('CONTRACT_CONTENT_MEDIA_TYPE_INVALID: ' + context + ' contentEncoding applies only to string-typed schemas');
  }
  return out;
}

export function collectMediaParamLints(root: Rec, version: string, pathItem: Rec, operation: Rec, operationId: string): string[] {
  const out: string[] = [];
  const arrayObjectStyles: Record<string, string[]> = { spaceDelimited: ['array', 'object'], pipeDelimited: ['array', 'object'], deepObject: ['object'] };

  for (const p of mergedParams(root, pathItem, operation)) {
    const loc = String(p.in ?? '').toLowerCase();
    const name = String(p.name ?? '');
    const style = typeof p.style === 'string' ? p.style : '';
    const schema = resolveInternalRef(root, p.schema) ?? asRecord(p.schema);
    const ptypes = schema ? typeNames(schema as Rec) : [];
    // row 20: style/type matrix
    if (style && arrayObjectStyles[style] && ptypes.length > 0 && !ptypes.some((t) => arrayObjectStyles[style]!.includes(t))) {
      out.push('CONTRACT_PARAMETER_STYLE_TYPE_INVALID: ' + operationId + ' parameter ' + loc + ':' + name + ' style ' + style + ' applies only to ' + arrayObjectStyles[style]!.join('/') + ' typed parameters');
    }
    // row 21: deepObject explode:false / nested non-scalar
    if (style === 'deepObject') {
      if (p.explode === false) out.push('CONTRACT_PARAMETER_DEEPOBJECT_INVALID: ' + operationId + ' parameter ' + loc + ':' + name + ' deepObject requires explode: true');
      const props = schema ? asRecord((schema as Rec).properties) : null;
      if (props) for (const [pn, ps] of Object.entries(props)) {
        const pr = resolveInternalRef(root, ps) ?? asRecord(ps);
        const pt = pr ? typeNames(pr as Rec) : [];
        if (pt.some((t) => t === 'object' || t === 'array')) out.push('CONTRACT_PARAMETER_DEEPOBJECT_INVALID: ' + operationId + ' parameter ' + loc + ':' + name + ' deepObject property ' + pn + ' is not a scalar and is not supported');
      }
    }
    // row 22: header style + serialized example advisory
    if (loc === 'header' && style && style !== 'simple') out.push('CONTRACT_HEADER_STYLE_INVALID: ' + operationId + ' header parameter ' + name + ' must use style simple (found ' + style + ')');
    if ((p.example !== undefined || asRecord(p.examples)) && style && style !== 'simple' && style !== 'form') out.push('CONTRACT_PARAMETER_EXAMPLE_NOT_VALIDATED: ' + operationId + ' parameter ' + loc + ':' + name + ' example is a raw value; its serialized ' + style + ' form is not statically validated');
    // row 23: parameter Example Object shape
    for (const [en, rawEx] of Object.entries(asRecord(p.examples) ?? {})) {
      const ex = resolveInternalRef(root, rawEx) ?? asRecord(rawEx);
      if (!ex) continue;
      if ((ex as Rec).value !== undefined && (ex as Rec).externalValue !== undefined) out.push('CONTRACT_EXAMPLE_OBJECT_INVALID: ' + operationId + ' parameter ' + loc + ':' + name + ' example ' + en + ' sets both value and externalValue, which are mutually exclusive');
      const ev = (ex as Rec).externalValue;
      if (typeof ev === 'string' && !isUriRef(ev)) out.push('CONTRACT_EXAMPLE_OBJECT_INVALID: ' + operationId + ' parameter ' + loc + ':' + name + ' example ' + en + ' externalValue ' + ev + ' is not a valid URI reference');
    }
  }

  const mediaEntries: Array<{ ctx: string; ct: string; media: Rec; request: boolean }> = [];
  const rb = resolveInternalRef(root, operation.requestBody);
  for (const [ct, m] of Object.entries(asRecord(rb?.content) ?? {})) { const mm = asRecord(m); if (mm) mediaEntries.push({ ctx: operationId + ' request body', ct, media: mm, request: true }); }
  for (const [status, rr] of Object.entries(asRecord(operation.responses) ?? {})) {
    const resp = resolveInternalRef(root, rr) ?? asRecord(rr);
    for (const [ct, m] of Object.entries(asRecord(resp?.content) ?? {})) { const mm = asRecord(m); if (mm) mediaEntries.push({ ctx: operationId + ' response ' + status, ct, media: mm, request: false }); }
  }

  for (const { ctx, ct, media, request } of mediaEntries) {
    const base = mediaBase(ct);
    const isForm = base === 'application/x-www-form-urlencoded';
    const isMultipart = base.startsWith('multipart/');
    const encoding = asRecord(media.encoding);
    if (encoding) {
      // row 15: applicability
      if (!request || (!isForm && !isMultipart)) out.push('CONTRACT_ENCODING_APPLICABILITY_INVALID: ' + ctx + ' ' + ct + ' declares an encoding map, which applies only to request-body multipart or urlencoded media');
      for (const [field, rawEnc] of Object.entries(encoding)) {
        const enc = asRecord(rawEnc);
        if (!enc) continue;
        // row 16: contentType grammar
        if (typeof enc.contentType === 'string') for (const part of enc.contentType.split(',')) { const t = part.trim(); if (t && !isValidMediaType(t)) out.push('CONTRACT_ENCODING_CONTENT_TYPE_INVALID: ' + ctx + ' encoding.' + field + '.contentType ' + t + ' is not a valid media type'); }
        // row 17: ignored fields
        if ((enc.style !== undefined || enc.explode !== undefined || enc.allowReserved !== undefined) && !isForm) out.push('CONTRACT_ENCODING_FIELD_IGNORED: ' + ctx + ' encoding.' + field + ' style/explode/allowReserved are ignored outside application/x-www-form-urlencoded');
        if (asRecord(enc.headers) && !isMultipart) out.push('CONTRACT_ENCODING_FIELD_IGNORED: ' + ctx + ' encoding.' + field + '.headers are ignored outside multipart media');
        // row 18: 3.1 contentType precedence
        if (version === '3.1' && typeof enc.contentType === 'string' && (enc.style !== undefined || enc.explode !== undefined || enc.allowReserved !== undefined)) out.push('CONTRACT_ENCODING_CONTENT_TYPE_PRECEDENCE: ' + ctx + ' encoding.' + field + ' sets contentType and style/explode/allowReserved; OpenAPI 3.1 gives contentType precedence and ignores RFC 6570 serialization');
        // row 19: multipart RFC6570 advisory
        if (isMultipart && (enc.style !== undefined || enc.explode !== undefined || enc.allowReserved !== undefined)) out.push('CONTRACT_MULTIPART_SERIALIZATION_ADVISORY: ' + ctx + ' encoding.' + field + ' RFC 6570 serialization on multipart parts is advisory and not runtime-validated');
      }
    }
    // row 23: media Example Object shape
    const examples = asRecord(media.examples);
    for (const [en, rawEx] of Object.entries(examples ?? {})) {
      const ex = resolveInternalRef(root, rawEx) ?? asRecord(rawEx);
      if (!ex) continue;
      if ((ex as Rec).value !== undefined && (ex as Rec).externalValue !== undefined) out.push('CONTRACT_EXAMPLE_OBJECT_INVALID: ' + ctx + ' example ' + en + ' sets both value and externalValue, which are mutually exclusive');
      const ev = (ex as Rec).externalValue;
      if (typeof ev === 'string' && !isUriRef(ev)) out.push('CONTRACT_EXAMPLE_OBJECT_INVALID: ' + ctx + ' example ' + en + ' externalValue ' + ev + ' is not a valid URI reference');
    }
    // row 24: media examples vs encoding advisory
    if (encoding && (media.example !== undefined || examples)) {
      const candidates = mediaExampleCandidates(root, media);
      let fullyUnvalidated = candidates.length > 0;
      for (const candidate of candidates) {
        const candidateRecord = asRecord(candidate.value);
        if (!candidateRecord) continue;
        let checkedField = false;
        let invalidField = false;
        for (const [field, rawEnc] of Object.entries(encoding)) {
          const enc = asRecord(rawEnc);
          const encodedValue = candidateRecord[field];
          if (!enc || encodedValue === undefined || typeof enc.contentType !== 'string' || !isJsonMediaType(enc.contentType)) continue;
          checkedField = true;
          if (typeof encodedValue === 'string') {
            try {
              JSON.parse(encodedValue);
            } catch {
              out.push('CONTRACT_EXAMPLE_SCHEMA_MISMATCH: ' + ctx + ' ' + ct + ' ' + candidate.label + ' field ' + field + ' is not valid JSON for encoding.contentType ' + enc.contentType);
              invalidField = true;
            }
          }
        }
        if (checkedField && !invalidField) fullyUnvalidated = false;
      }
      if (fullyUnvalidated) out.push('CONTRACT_MEDIA_EXAMPLE_ENCODING_NOT_VALIDATED: ' + ctx + ' ' + ct + ' media example is not statically validated against the encoding map');
    }
  }
  return out;
}

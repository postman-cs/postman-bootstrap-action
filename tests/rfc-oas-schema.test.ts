import { describe, expect, it } from 'vitest';

import { buildContractIndex } from '../src/lib/spec/contract-index.js';
import { parseOpenApiDocument } from '../src/lib/spec/openapi-loader.js';

function opWarns(spec: string): string[] {
  return buildContractIndex(parseOpenApiDocument(spec)).operations[0]!.warnings;
}
function docWarns(spec: string): string[] {
  return buildContractIndex(parseOpenApiDocument(spec)).warnings;
}
function opHas(spec: string, code: string): boolean {
  return opWarns(spec).some((w) => w.indexOf(code) === 0);
}
function docHas(spec: string, code: string): boolean {
  return docWarns(spec).some((w) => w.indexOf(code) === 0);
}
function docMsg(spec: string, sub: string): boolean {
  return docWarns(spec).some((w) => w.indexOf(sub) >= 0);
}
function mk(body: string): string {
  return 'openapi: 3.1.0\ninfo: {title: T, version: 1}\npaths:\n  /a:\n' + body;
}
function mkComp(sInline: string): string {
  return 'openapi: 3.1.0\ninfo: {title: T, version: 1}\npaths:\n  /a:\n    get:\n      responses: {"200": {description: ok}}\ncomponents: {schemas: {S: ' + sInline + '}}';
}

describe('OAS schema-object static lints (document warnings)', () => {
  it('8 flags inline discriminator branches', () => {
    expect(docMsg(mkComp('{oneOf: [{type: object, properties: {petType: {type: string}}, required: [petType]}], discriminator: {propertyName: petType}}'), 'inline oneOf/anyOf branch')).toBe(true);
  });
  it('9 flags discriminator mapping outside the branch set', () => {
    const spec = 'openapi: 3.1.0\ninfo: {title: T, version: 1}\npaths:\n  /a:\n    get:\n      responses: {"200": {description: ok}}\ncomponents: {schemas: {Cat: {type: object}, Dog: {type: object}, Fish: {type: object}, S: {oneOf: [{$ref: "#/components/schemas/Cat"}, {$ref: "#/components/schemas/Dog"}], discriminator: {propertyName: t, mapping: {f: "#/components/schemas/Fish"}}}}}';
    expect(docMsg(spec, 'not one of the oneOf/anyOf branches')).toBe(true);
  });
  it('9 flags discriminator mapping name that is not a component schema', () => {
    const spec = 'openapi: 3.1.0\ninfo: {title: T, version: 1}\npaths:\n  /a:\n    get:\n      responses: {"200": {description: ok}}\ncomponents: {schemas: {Cat: {type: object}, Dog: {type: object}, S: {oneOf: [{$ref: "#/components/schemas/Cat"}, {$ref: "#/components/schemas/Dog"}], discriminator: {propertyName: t, mapping: {x: nope}}}}}';
    expect(docMsg(spec, 'is not a component schema')).toBe(true);
  });
  it('10 flags non-absolute xml.namespace', () => {
    expect(docMsg(mkComp('{type: string, xml: {namespace: "not-a-uri", name: n}}'), 'is not an absolute URI')).toBe(true);
  });
  it('11 flags xml.prefix without namespace', () => {
    expect(docMsg(mkComp('{type: string, xml: {prefix: p}}'), 'without an xml.namespace')).toBe(true);
  });
  it('11 flags xml name that is not an NCName', () => {
    expect(docMsg(mkComp('{type: string, xml: {name: "1bad"}}'), 'is not a valid NCName')).toBe(true);
  });
  it('12 flags xml.wrapped on a non-array', () => {
    expect(docMsg(mkComp('{type: object, xml: {wrapped: true}}'), 'xml.wrapped applies only to array')).toBe(true);
  });
  it('13 flags xml.attribute on an object', () => {
    expect(docMsg(mkComp('{type: object, xml: {attribute: true}}'), 'cannot serialize an object or array as an XML attribute')).toBe(true);
  });
  it('14 flags item xml.name on an unwrapped array', () => {
    expect(docMsg(mkComp('{type: array, items: {type: string, xml: {name: item}}, xml: {name: items}}'), 'element naming is advisory only')).toBe(true);
  });
  it('25 flags an invalid $id', () => {
    expect(docHas(mkComp('{type: object, $id: "http://["}'), 'CONTRACT_SCHEMA_ID_INVALID')).toBe(true);
  });
  it('26 flags contentMediaType on a non-string schema', () => {
    expect(docHas(mkComp('{type: integer, contentMediaType: "application/json"}'), 'CONTRACT_CONTENT_MEDIA_TYPE_INVALID')).toBe(true);
  });
  it('does not fire on a clean object schema', () => {
    const w = docWarns(mkComp('{type: object, properties: {a: {type: string}}}'));
    expect(w.some((x) => x.startsWith('CONTRACT_XML_OBJECT_INVALID') || x.startsWith('CONTRACT_SCHEMA_ID_INVALID') || x.startsWith('CONTRACT_CONTENT_MEDIA_TYPE_INVALID'))).toBe(false);
  });
});

describe('OAS media and parameter static lints (operation warnings)', () => {
  it('15 flags an encoding map on a response media', () => {
    expect(opHas(mk('    get:\n      responses:\n        "200": {description: ok, content: {application/json: {schema: {type: object}, encoding: {f: {contentType: application/json}}}}}'), 'CONTRACT_ENCODING_APPLICABILITY_INVALID')).toBe(true);
  });
  it('16 flags an invalid encoding.contentType', () => {
    expect(opHas(mk('    post:\n      requestBody: {content: {multipart/form-data: {schema: {type: object, properties: {f: {type: string}}}, encoding: {f: {contentType: notamediatype}}}}}\n      responses: {"200": {description: ok}}'), 'CONTRACT_ENCODING_CONTENT_TYPE_INVALID')).toBe(true);
  });
  it('17 flags ignored encoding style fields', () => {
    expect(opHas(mk('    post:\n      requestBody: {content: {multipart/form-data: {schema: {type: object, properties: {f: {type: string}}}, encoding: {f: {style: form}}}}}\n      responses: {"200": {description: ok}}'), 'CONTRACT_ENCODING_FIELD_IGNORED')).toBe(true);
  });
  it('18 flags encoding contentType precedence over style in 3.1', () => {
    expect(opHas(mk('    post:\n      requestBody: {content: {application/x-www-form-urlencoded: {schema: {type: object, properties: {f: {type: string}}}, encoding: {f: {contentType: text/plain, style: form}}}}}\n      responses: {"200": {description: ok}}'), 'CONTRACT_ENCODING_CONTENT_TYPE_PRECEDENCE')).toBe(true);
  });
  it('19 flags multipart RFC6570 serialization as advisory', () => {
    expect(opHas(mk('    post:\n      requestBody: {content: {multipart/form-data: {schema: {type: object, properties: {f: {type: string}}}, encoding: {f: {explode: true}}}}}\n      responses: {"200": {description: ok}}'), 'CONTRACT_MULTIPART_SERIALIZATION_ADVISORY')).toBe(true);
  });
  it('20 flags deepObject style on a non-object parameter', () => {
    expect(opHas(mk('    get:\n      parameters: [{name: q, in: query, style: deepObject, schema: {type: array, items: {type: string}}}]\n      responses: {"200": {description: ok}}'), 'CONTRACT_PARAMETER_STYLE_TYPE_INVALID')).toBe(true);
  });
  it('21 flags deepObject with explode false', () => {
    expect(opWarns(mk('    get:\n      parameters: [{name: q, in: query, style: deepObject, explode: false, schema: {type: object, properties: {a: {type: string}}}}]\n      responses: {"200": {description: ok}}')).some((w) => w.indexOf('deepObject requires explode: true') >= 0)).toBe(true);
  });
  it('22 flags non-simple header style', () => {
    expect(opHas(mk('    get:\n      parameters: [{name: X-Test, in: header, style: form, schema: {type: string}}]\n      responses: {"200": {description: ok}}'), 'CONTRACT_HEADER_STYLE_INVALID')).toBe(true);
  });
  it('22 flags unvalidated serialized parameter example', () => {
    expect(opHas(mk('    get:\n      parameters: [{name: q, in: query, style: spaceDelimited, explode: false, example: "a b", schema: {type: array, items: {type: string}}}]\n      responses: {"200": {description: ok}}'), 'CONTRACT_PARAMETER_EXAMPLE_NOT_VALIDATED')).toBe(true);
  });
  it('23 flags Example Object with both value and externalValue', () => {
    expect(opHas(mk('    get:\n      responses:\n        "200": {description: ok, content: {application/json: {schema: {type: object}, examples: {e: {value: {a: 1}, externalValue: "https://x/e.json"}}}}}'), 'CONTRACT_EXAMPLE_OBJECT_INVALID')).toBe(true);
  });
  it('24 flags media example not validated against encoding', () => {
    expect(opHas(mk('    post:\n      requestBody: {content: {application/x-www-form-urlencoded: {schema: {type: object, properties: {f: {type: string}}}, example: {f: x}, encoding: {f: {contentType: text/plain}}}}}\n      responses: {"200": {description: ok}}'), 'CONTRACT_MEDIA_EXAMPLE_ENCODING_NOT_VALIDATED')).toBe(true);
  });
});


import { describe, expect, it } from 'vitest';

import { lintAsyncApiBindingSurfaces } from '../../../src/lib/protocols/asyncapi/asyncapi-binding-lints.js';
import type { AsyncApiContractIndex } from '../../../src/lib/protocols/asyncapi/asyncapi-parser.js';

type JsonRecord = Record<string, unknown>;

function lint(documentJson: JsonRecord, channels: unknown[] = []): string[] {
  const index = { documentJson, channels, version: String(documentJson.asyncapi ?? '2.6.0'), warnings: [] } as unknown as AsyncApiContractIndex;
  return lintAsyncApiBindingSurfaces(index);
}

const wsServer = { production: { url: 'wss://example.com', protocol: 'wss' } };
const mqttServer = (extra: JsonRecord = {}): JsonRecord => ({ broker: { url: 'mqtt://example.com', protocol: 'mqtt', protocolVersion: '3.1.1', ...extra } });

function codes(warnings: string[]): Set<string> {
  return new Set(warnings.map((w) => w.split(':')[0]));
}

describe('asyncapi binding-surface lints', () => {
  it('flags non-canonical binding keys and accepts x- extensions', () => {
    const warnings = lint({ asyncapi: '2.6.0', servers: wsServer, channels: { c: { bindings: { websockets: {}, 'x-internal': {} } } } });
    expect(warnings.filter((w) => w.startsWith('ASYNCAPI_BINDING_KEY_UNKNOWN'))).toHaveLength(1);
    expect(warnings.join('\n')).toContain('"websockets"');
  });

  it('flags omitted and unknown bindingVersion values', () => {
    const warnings = lint({
      asyncapi: '2.6.0',
      servers: mqttServer(),
      channels: { c: { publish: { bindings: { mqtt: { qos: 1 } } } } },
      components: { operationBindings: { other: { mqtt: { qos: 1, bindingVersion: '9.9.9' } } } }
    });
    expect(codes(warnings)).toContain('ASYNCAPI_BINDING_VERSION_OMITTED');
    expect(codes(warnings)).toContain('ASYNCAPI_BINDING_VERSION_UNKNOWN');
  });

  it('flags reserved-empty scopes and unknown binding fields', () => {
    const warnings = lint({
      asyncapi: '2.6.0',
      servers: { s: { url: 'wss://example.com', protocol: 'wss', bindings: { ws: { method: 'GET' } } } },
      channels: { c: { bindings: { ws: { method: 'GET', frame: true, bindingVersion: '0.1.0' } } } }
    });
    expect(codes(warnings)).toContain('ASYNCAPI_BINDING_SCOPE_RESERVED');
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_BINDING_FIELD_UNKNOWN') && w.includes('"frame"'))).toBe(true);
  });

  it('flags multi-transport channel bindings and unreachable transports', () => {
    const warnings = lint({
      asyncapi: '2.6.0',
      servers: wsServer,
      channels: { c: { bindings: { ws: {}, mqtt: {} } } }
    });
    expect(codes(warnings)).toContain('ASYNCAPI_BINDING_TRANSPORT_AMBIGUOUS');
    expect(codes(warnings)).toContain('ASYNCAPI_BINDING_TRANSPORT_MISMATCH');
  });

  it('flags channel addresses with query/fragment parts and bad joined ws URLs', () => {
    const warnings = lint({ asyncapi: '2.6.0', servers: wsServer, channels: { 'updates?live=1': {} } });
    expect(codes(warnings)).toContain('ASYNCAPI_CHANNEL_ADDRESS_INVALID');
    const fragment = lint({ asyncapi: '2.6.0', servers: wsServer, channels: { 'updates#frag': {} } });
    expect(codes(fragment)).toContain('ASYNCAPI_WS_URL_INVALID');
  });

  it('audits ws channel binding handshake surfaces', () => {
    const warnings = lint({
      asyncapi: '2.6.0',
      servers: wsServer,
      channels: {
        c: {
          bindings: {
            ws: {
              method: 'POST',
              bindingVersion: '0.1.0',
              query: { type: 'object' },
              headers: {
                type: 'object',
                required: ['Sec-WebSocket-Key'],
                properties: {
                  'Sec-WebSocket-Key': { type: 'string', const: 'fixed-nonce' },
                  'Sec-WebSocket-Protocol': { type: 'string', const: 'not-a-registered-subprotocol' },
                  'Sec-WebSocket-Extensions': { type: 'string', const: ';;;' },
                  Origin: { type: 'string', const: 'not an origin' },
                  'Bad Header': { type: 'string' }
                }
              }
            }
          }
        }
      }
    });
    const seen = codes(warnings);
    expect(seen).toContain('ASYNCAPI_WS_METHOD_POST_UNSUPPORTED');
    expect(seen).toContain('ASYNCAPI_WS_BINDING_SCHEMA_NO_PROPERTIES');
    expect(seen).toContain('ASYNCAPI_WS_HEADER_RUNTIME_OWNED');
    expect(seen).toContain('ASYNCAPI_WS_KEY_FIXED_NONCE');
    expect(seen).toContain('ASYNCAPI_WS_SUBPROTOCOL_UNREGISTERED');
    expect(seen).toContain('ASYNCAPI_WS_EXTENSION_INVALID');
    expect(seen).toContain('ASYNCAPI_WS_ORIGIN_INVALID');
    expect(seen).toContain('ASYNCAPI_BINDING_HEADER_NAME_INVALID');
  });

  it('gates MQTT 5 binding fields when every MQTT server is 3.x', () => {
    const warnings = lint({
      asyncapi: '2.6.0',
      servers: mqttServer({ bindings: { mqtt: { sessionExpiryInterval: 60, bindingVersion: '0.2.0' } } }),
      channels: {}
    });
    expect(codes(warnings)).toContain('ASYNCAPI_MQTT5_FIELD_ON_MQTT3');
  });

  it('audits MQTT server clientId and lastWill semantics', () => {
    const warnings = lint({
      asyncapi: '2.6.0',
      servers: mqttServer({
        bindings: {
          mqtt: {
            clientId: '',
            cleanSession: false,
            lastWill: { qos: 1 },
            keepAlive: 700000,
            bindingVersion: '0.2.0'
          }
        }
      }),
      channels: {}
    });
    const seen = codes(warnings);
    expect(seen).toContain('ASYNCAPI_MQTT_CLIENT_ID_EMPTY_REQUIRES_CLEAN_SESSION');
    expect(seen).toContain('ASYNCAPI_MQTT_LAST_WILL_INVALID');
    const advisory = lint({
      asyncapi: '2.6.0',
      servers: mqttServer({ bindings: { mqtt: { clientId: 'a-client-id-well-beyond-twenty-three-bytes', bindingVersion: '0.2.0' } } }),
      channels: {}
    });
    expect(codes(advisory)).toContain('ASYNCAPI_MQTT_CLIENT_ID_LENGTH_ADVISORY');
  });

  it('flags publish-only MQTT operation fields on receive operations and range violations', () => {
    const warnings = lint({
      asyncapi: '2.6.0',
      servers: { broker: { url: 'mqtt://example.com', protocol: 'mqtt', protocolVersion: '5' } },
      channels: { c: { subscribe: { bindings: { mqtt: { retain: true, messageExpiryInterval: 5000000000, bindingVersion: '0.2.0' } } } } }
    });
    const seen = codes(warnings);
    expect(seen).toContain('ASYNCAPI_MQTT_PUBLISH_FIELD_ON_RECEIVE');
    expect(seen).toContain('ASYNCAPI_MQTT_VALUE_OUT_OF_RANGE');
  });

  it('flags MQTT message binding contentType conflicts, PFI/binary conflicts, and long correlationData', () => {
    const warnings = lint({
      asyncapi: '2.6.0',
      servers: { broker: { url: 'mqtt://example.com', protocol: 'mqtt', protocolVersion: '5' } },
      defaultContentType: 'application/json',
      channels: {
        c: {
          publish: {
            message: {
              contentType: 'application/octet-stream',
              payload: { type: 'object' },
              bindings: {
                mqtt: {
                  contentType: 'application/json',
                  payloadFormatIndicator: 1,
                  correlationData: { type: 'string', maxLength: 70000 },
                  bindingVersion: '0.2.0'
                }
              }
            }
          }
        }
      }
    });
    const seen = codes(warnings);
    expect(seen).toContain('ASYNCAPI_MQTT_CONTENT_TYPE_CONFLICT');
    expect(seen).toContain('ASYNCAPI_MQTT_PFI_UTF8_CONFLICT');
    expect(seen).toContain('ASYNCAPI_MQTT_CORRELATION_DATA_TOO_LONG');
  });

  it('flags the deprecated mqtt5 binding key', () => {
    const warnings = lint({
      asyncapi: '2.6.0',
      servers: { broker: { url: 'mqtt://example.com', protocol: 'mqtt5' } },
      channels: {},
      components: { serverBindings: { b: { mqtt5: { sessionExpiryInterval: 60 } } } }
    });
    expect(codes(warnings)).toContain('ASYNCAPI_MQTT5_BINDING_DEPRECATED');
  });

  it('requires http binding query/headers schemas to declare properties with token names', () => {
    const warnings = lint({
      asyncapi: '2.6.0',
      servers: { api: { url: 'https://example.com', protocol: 'https' } },
      channels: {
        c: {
          publish: { bindings: { http: { type: 'request', method: 'POST', query: { type: 'object' }, bindingVersion: '0.3.0' } } },
          subscribe: {
            message: { bindings: { http: { headers: { type: 'object', properties: { 'Bad Header': { type: 'string' } } }, bindingVersion: '0.3.0' } } }
          }
        }
      }
    });
    const seen = codes(warnings);
    expect(seen).toContain('ASYNCAPI_HTTP_BINDING_SCHEMA_NO_PROPERTIES');
    expect(seen).toContain('ASYNCAPI_BINDING_HEADER_NAME_INVALID');
  });

  it('detects duplicate messageIds introduced through traits', () => {
    const warnings = lint({
      asyncapi: '2.6.0',
      servers: wsServer,
      channels: {
        a: { publish: { message: { messageId: 'shared', payload: { type: 'object' } } } },
        b: { publish: { message: { traits: [{ messageId: 'shared' }], payload: { type: 'object' } } } }
      }
    });
    expect(codes(warnings)).toContain('ASYNCAPI_MESSAGE_ID_DUPLICATE');
  });

  it('audits trait forbidden fields, merge-order sensitivity, and 3.0 overrides', () => {
    const v2 = lint({
      asyncapi: '2.6.0',
      servers: wsServer,
      channels: {
        c: {
          publish: {
            traits: [{ message: {} }],
            message: { name: 'n', traits: [{ traits: [] }, { title: 'one' }, { title: 'two' }] }
          }
        }
      }
    });
    const seenV2 = codes(v2);
    expect(seenV2).toContain('ASYNCAPI_TRAIT_FORBIDDEN_FIELD');
    expect(seenV2).toContain('ASYNCAPI_TRAIT_MERGE_ORDER_SENSITIVE');
    const v3 = lint({
      asyncapi: '3.0.0',
      servers: wsServer,
      channels: { c: { address: '/c', messages: { m: { title: 'defined', traits: [{ title: 'other' }] } } } },
      operations: { op: { action: 'send', traits: [{ channel: {} }] } }
    });
    const seenV3 = codes(v3);
    expect(seenV3).toContain('ASYNCAPI_TRAIT_OVERRIDE');
    expect(seenV3).toContain('ASYNCAPI_TRAIT_FORBIDDEN_FIELD');
  });

  it('validates headers-only examples against the headers schema', () => {
    const warnings = lint({
      asyncapi: '2.6.0',
      servers: wsServer,
      channels: {
        c: {
          publish: {
            message: {
              headers: { type: 'object', properties: { 'x-tenant': { type: 'string' } }, required: ['x-tenant'] },
              examples: [{ headers: { 'x-tenant': 42 } }]
            }
          }
        }
      }
    });
    expect(codes(warnings)).toContain('ASYNCAPI_MESSAGE_HEADER_EXAMPLE_MISMATCH');
  });

  it('flags protocol-owned message headers on ws surfaces', () => {
    const warnings = lint({
      asyncapi: '2.6.0',
      servers: wsServer,
      channels: { c: { publish: { message: { headers: { type: 'object', properties: { Upgrade: { type: 'string' } } } } } } }
    });
    expect(codes(warnings)).toContain('ASYNCAPI_MESSAGE_HEADER_PROTOCOL_OWNED');
  });

  it('flags examples that validate against sibling channel messages', () => {
    const warnings = lint({
      asyncapi: '2.6.0',
      servers: wsServer,
      channels: {
        c: {
          publish: {
            message: {
              oneOf: [
                { name: 'a', payload: { type: 'object', properties: { kind: { type: 'string' } } }, examples: [{ payload: { kind: 'x' } }] },
                { name: 'b', payload: { type: 'object', properties: { kind: { type: 'string' } } } }
              ]
            }
          }
        }
      }
    });
    expect(codes(warnings)).toContain('ASYNCAPI_MESSAGE_EXAMPLE_AMBIGUOUS');
  });

  it('audits 3.0 operation channel/message subsets and reply rules', () => {
    const channelC: JsonRecord = { address: '/c', messages: { m: { name: 'm', payload: { type: 'object' } } } };
    const replyChannel: JsonRecord = { address: '/replies', messages: { r: { name: 'r' } } };
    const warnings = lint({
      asyncapi: '3.0.0',
      servers: wsServer,
      channels: { c: channelC, replies: replyChannel },
      operations: {
        op: {
          action: 'send',
          channel: channelC,
          messages: [{ name: 'foreign', payload: { type: 'string' } }],
          reply: {
            address: { location: '$message.header#/replyTo' },
            channel: replyChannel,
            messages: [{ name: 'not-in-reply-channel' }]
          }
        }
      }
    });
    const seen = codes(warnings);
    expect(seen).toContain('ASYNCAPI_OPERATION_MESSAGE_NOT_IN_CHANNEL');
    expect(seen).toContain('ASYNCAPI_REPLY_ADDRESS_CONFLICT');
    expect(seen).toContain('ASYNCAPI_REPLY_MESSAGE_NOT_IN_CHANNEL');
  });

  it('audits security schemes, flows, and requirement shapes', () => {
    const warnings = lint({
      asyncapi: '2.6.0',
      servers: {
        s: {
          url: 'wss://example.com',
          protocol: 'wss',
          security: [{ basic: ['read'] }, { oauth: 'not-an-array' }]
        }
      },
      channels: {},
      components: {
        securitySchemes: {
          basic: { type: 'http', scheme: 'basic auth' },
          key: { type: 'httpApiKey', name: 'k', in: 'body' },
          oauth: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'not-absolute', availableScopes: {} } } },
          oidc: { type: 'openIdConnect', openIdConnectUrl: 'ftp://x' },
          x509: { type: 'X509' }
        }
      }
    });
    const seen = codes(warnings);
    expect(seen).toContain('ASYNCAPI_SECURITY_SCHEME_INVALID');
    expect(seen).toContain('ASYNCAPI_SECURITY_URL_INVALID');
    expect(seen).toContain('ASYNCAPI_SECURITY_REQUIREMENT_INVALID');
    expect(seen).toContain('ASYNCAPI_SECURITY_NOT_SYNTHESIZED');
  });

  it('audits Socket.IO conventions against the generated v4 defaults', () => {
    const doc: JsonRecord = {
      asyncapi: '2.6.0',
      servers: wsServer,
      'x-socketio': { version: '3', path: '/custom-io/' },
      channels: {
        '/chat': {
          bindings: { ws: { query: { type: 'object', properties: { EIO: { type: 'string', const: '3' }, transport: { type: 'string', const: 'polling' } } }, bindingVersion: '0.1.0' } }
        },
        'no-slash': {}
      }
    };
    const channels = [
      {
        id: '/chat',
        transport: 'socketio',
        messages: [
          { id: 'empty', eventName: '   ', contentKind: 'json' },
          { id: 'bin', eventName: 'upload', contentKind: 'binary' },
          { id: 'acked', eventName: 'send', contentKind: 'json', ackSchema: { type: 'object' } }
        ]
      }
    ];
    const warnings = lint(doc, channels);
    const seen = codes(warnings);
    expect(seen).toContain('ASYNCAPI_SOCKETIO_VERSION_UNSUPPORTED');
    expect(seen).toContain('ASYNCAPI_SOCKETIO_PATH_UNSUPPORTED');
    expect(seen).toContain('ASYNCAPI_SOCKETIO_NAMESPACE_NOT_ROUTED');
    expect(seen).toContain('ASYNCAPI_SOCKETIO_NAMESPACE_INVALID');
    expect(seen).toContain('ASYNCAPI_SOCKETIO_QUERY_PINNED');
    expect(seen).toContain('ASYNCAPI_SOCKETIO_EVENT_NAME_EMPTY');
    expect(seen).toContain('ASYNCAPI_SOCKETIO_BINARY_NOT_SYNTHESIZED');
    expect(seen).toContain('ASYNCAPI_SOCKETIO_ACK_NOT_ARRAY');
  });

  it('emits nothing for a clean minimal ws document', () => {
    const warnings = lint({
      asyncapi: '2.6.0',
      servers: wsServer,
      channels: {
        updates: {
          bindings: { ws: { method: 'GET', headers: { type: 'object', properties: { 'x-trace': { type: 'string' } } }, bindingVersion: '0.1.0' } },
          publish: { message: { name: 'update', payload: { type: 'object' } } }
        }
      }
    });
    expect(warnings).toEqual([]);
  });
});

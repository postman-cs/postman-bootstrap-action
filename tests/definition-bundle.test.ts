import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { acquireDefinitionBundle } from '../src/lib/spec/acquire-definition-bundle.js';
import {
  computeDefinitionBundleDigest,
  createDefinitionFile,
  createDefinitionBundle,
  parseDefinitionInventoryJson,
  type DefinitionBundle,
  type DefinitionFile
} from '../src/lib/spec/definition-bundle.js';

const SINGLE_OPENAPI = `openapi: 3.0.3
info:
  title: Local Spec
  version: 1.0.0
paths:
  /ping:
    get:
      responses:
        '200':
          description: OK
`;

describe('definition bundle model', () => {
  it('computes a stable full-set digest', () => {
    const root = createDefinitionFile({
      path: 'openapi.yaml',
      role: 'root',
      bytes: Buffer.from(SINGLE_OPENAPI, 'utf8')
    });
    const dep = createDefinitionFile({
      path: 'components/pet.yaml',
      role: 'dependency',
      bytes: Buffer.from('type: object\nproperties:\n  id:\n    type: integer\n', 'utf8')
    });

    const forward = createDefinitionBundle({
      rootPath: 'openapi.yaml',
      format: 'openapi-yaml',
      completeness: 'full',
      provenance: { source: 'spec-path', evidence: ['order-a'] },
      files: [root, dep]
    });
    const reverse = createDefinitionBundle({
      rootPath: 'openapi.yaml',
      format: 'openapi-yaml',
      completeness: 'full',
      provenance: { source: 'spec-path', evidence: ['order-b-different'] },
      files: [dep, root]
    });

    expect(forward.digest).toBe(reverse.digest);
    expect(forward.digest).toBe(
      computeDefinitionBundleDigest({
        schemaVersion: 1,
        rootPath: 'openapi.yaml',
        format: 'openapi-yaml',
        files: new Map<string, DefinitionFile>([
          [dep.path, dep],
          [root.path, root]
        ])
      })
    );

    const expectedPayload = JSON.stringify({
      schemaVersion: 1,
      rootPath: 'openapi.yaml',
      format: 'openapi-yaml',
      files: [
        {
          path: 'components/pet.yaml',
          role: 'dependency',
          byteLength: dep.byteLength,
          sha256: dep.sha256
        },
        {
          path: 'openapi.yaml',
          role: 'root',
          byteLength: root.byteLength,
          sha256: root.sha256
        }
      ]
    });
    expect(forward.digest).toBe(createHash('sha256').update(expectedPayload, 'utf8').digest('hex'));
    expect(forward.digest).not.toBe(createHash('sha256').update(SINGLE_OPENAPI, 'utf8').digest('hex'));
  });

  it('rejects bundles that violate root/path invariants', () => {
    const root = createDefinitionFile({
      path: 'openapi.yaml',
      role: 'root',
      bytes: Buffer.from(SINGLE_OPENAPI, 'utf8')
    });
    const secondRoot = createDefinitionFile({
      path: 'other.yaml',
      role: 'root',
      bytes: Buffer.from(SINGLE_OPENAPI, 'utf8')
    });

    expect(() =>
      createDefinitionBundle({
        rootPath: 'openapi.yaml',
        format: 'openapi-yaml',
        completeness: 'full',
        provenance: { source: 'spec-path', evidence: [] },
        files: [root, secondRoot]
      })
    ).toThrow(/CONTRACT_DEFINITION_INVENTORY_INVALID|CONTRACT_DEFINITION_DUPLICATE_PATH|exactly one/);

    expect(() =>
      createDefinitionBundle({
        rootPath: 'missing.yaml',
        format: 'openapi-yaml',
        completeness: 'full',
        provenance: { source: 'spec-path', evidence: [] },
        files: [root]
      })
    ).toThrow(/CONTRACT_DEFINITION_ROOT_MISMATCH/);
  });
});

describe('definition inventory parsing', () => {
  it('parses a valid inventory and rejects malformed/unsorted/colliding inventories', () => {
    const rootSha = createHash('sha256').update(Buffer.from('root', 'utf8')).digest('hex');
    const depSha = createHash('sha256').update(Buffer.from('dep', 'utf8')).digest('hex');
    const valid = {
      schemaVersion: 1,
      root: 'apis/svc/openapi.yaml',
      format: 'openapi-yaml',
      completeness: 'full',
      provenance: { kind: 'provider', provider: 'gcp' },
      files: [
        { path: 'apis/svc/components/pet.yaml', role: 'dependency', bytes: 3, sha256: depSha },
        { path: 'apis/svc/openapi.yaml', role: 'root', bytes: 4, sha256: rootSha }
      ]
    };
    expect(parseDefinitionInventoryJson(JSON.stringify(valid)).root).toBe('apis/svc/openapi.yaml');

    expect(() => parseDefinitionInventoryJson('{')).toThrow(/CONTRACT_DEFINITION_INVENTORY_INVALID/);
    expect(() =>
      parseDefinitionInventoryJson(JSON.stringify({ ...valid, schemaVersion: 2 }))
    ).toThrow(/CONTRACT_DEFINITION_INVENTORY_INVALID/);
    expect(() =>
      parseDefinitionInventoryJson(
        JSON.stringify({
          ...valid,
          files: [
            { path: 'apis/svc/openapi.yaml', role: 'root', bytes: 4, sha256: rootSha },
            { path: 'apis/svc/components/pet.yaml', role: 'dependency', bytes: 3, sha256: depSha }
          ]
        })
      )
    ).toThrow(/CONTRACT_DEFINITION_INVENTORY_INVALID/);
    expect(() =>
      parseDefinitionInventoryJson(
        JSON.stringify({
          ...valid,
          root: 'apis/svc/other.yaml'
        })
      )
    ).toThrow(/CONTRACT_DEFINITION_ROOT_MISMATCH/);
    expect(() =>
      parseDefinitionInventoryJson(
        JSON.stringify({
          ...valid,
          files: [
            { path: 'apis/svc/Pet.yaml', role: 'dependency', bytes: 3, sha256: depSha },
            { path: 'apis/svc/openapi.yaml', role: 'root', bytes: 4, sha256: rootSha },
            { path: 'apis/svc/pet.yaml', role: 'dependency', bytes: 3, sha256: depSha }
          ]
        })
      )
    ).toThrow(/CONTRACT_DEFINITION_DUPLICATE_PATH/);
  });
});

describe('acquireDefinitionBundle confinement', () => {
  let workspaceDir = '';
  let originalWorkspace: string | undefined;

  beforeEach(() => {
    workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), 'def-bundle-')));
    originalWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = workspaceDir;
  });

  afterEach(() => {
    if (originalWorkspace === undefined) {
      delete process.env.GITHUB_WORKSPACE;
    } else {
      process.env.GITHUB_WORKSPACE = originalWorkspace;
    }
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  const writeRel = (relPath: string, body: string | Buffer): void => {
    const full = join(workspaceDir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  };

  it('rejects unsafe roots and members before dependencies run', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'def-outside-')));
    const onReadOutside = vi.fn();
    try {
      writeFileSync(join(outside, 'openapi.yaml'), SINGLE_OPENAPI);
      writeRel('apis/svc/openapi.yaml', SINGLE_OPENAPI);

      await expect(
        acquireDefinitionBundle({
          workspaceRoot: workspaceDir,
          specPath: '../../outside.yaml',
          onUnsafeReadAttempt: onReadOutside
        })
      ).rejects.toThrow(/CONTRACT_SPEC_PATH_ESCAPE/);
      expect(onReadOutside).not.toHaveBeenCalled();

      await expect(
        acquireDefinitionBundle({
          workspaceRoot: workspaceDir,
          specPath: join(outside, 'openapi.yaml'),
          onUnsafeReadAttempt: onReadOutside
        })
      ).rejects.toThrow(/CONTRACT_SPEC_PATH_ESCAPE/);
      expect(onReadOutside).not.toHaveBeenCalled();

      writeRel(
        'apis/svc/escape.yaml',
        `openapi: 3.0.3
info: { title: T, version: 1.0.0 }
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '../../../outside/secret.yaml'
`
      );
      await expect(
        acquireDefinitionBundle({
          workspaceRoot: workspaceDir,
          specPath: 'apis/svc/escape.yaml',
          onUnsafeReadAttempt: onReadOutside
        })
      ).rejects.toThrow(/CONTRACT_SPEC_PATH_ESCAPE|CONTRACT_DEFINITION_CLOSURE_INCOMPLETE/);
      expect(onReadOutside).not.toHaveBeenCalled();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects directory roots, symlinks, oversize members, and over-count closures', async () => {
    mkdirSync(join(workspaceDir, 'apis/svc'), { recursive: true });
    await expect(
      acquireDefinitionBundle({
        workspaceRoot: workspaceDir,
        specPath: 'apis/svc'
      })
    ).rejects.toThrow(/CONTRACT_SPEC_PATH_NOT_FILE/);

    writeRel('apis/svc/openapi.yaml', SINGLE_OPENAPI);
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'def-link-')));
    try {
      writeFileSync(join(outside, 'target.yaml'), SINGLE_OPENAPI);
      symlinkSync(join(outside, 'target.yaml'), join(workspaceDir, 'apis/svc/linked.yaml'));
      await expect(
        acquireDefinitionBundle({
          workspaceRoot: workspaceDir,
          specPath: 'apis/svc/linked.yaml'
        })
      ).rejects.toThrow(/CONTRACT_SPEC_PATH_SYMLINK/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }

    const oversized = Buffer.alloc(25 * 1024 * 1024 + 1, 0x61);
    writeRel('apis/svc/big.yaml', oversized);
    await expect(
      acquireDefinitionBundle({
        workspaceRoot: workspaceDir,
        specPath: 'apis/svc/big.yaml'
      })
    ).rejects.toThrow(/CONTRACT_REF_SIZE_EXCEEDED/);

    const rootLines = [
      'openapi: 3.0.3',
      'info: { title: T, version: 1.0.0 }',
      'paths:',
      '  /pets:',
      '    get:',
      '      responses:',
      "        '200':",
      '          description: OK',
      '          content:',
      '            application/json:',
      '              schema:',
      '                allOf:'
    ];
    for (let i = 0; i < 101; i += 1) {
      writeRel(`apis/many/d${i}.yaml`, 'type: object\n');
      rootLines.push(`                  - $ref: './d${i}.yaml'`);
    }
    writeRel('apis/many/openapi.yaml', `${rootLines.join('\n')}\n`);
    await expect(
      acquireDefinitionBundle({
        workspaceRoot: workspaceDir,
        specPath: 'apis/many/openapi.yaml'
      })
    ).rejects.toThrow(/CONTRACT_REF_COUNT_EXCEEDED/);
  });

  it('acquires a single local file with no refs as a one-file full bundle', async () => {
    writeRel('apis/svc/openapi.yaml', SINGLE_OPENAPI);
    const bundle = await acquireDefinitionBundle({
      workspaceRoot: workspaceDir,
      specPath: 'apis/svc/openapi.yaml'
    });
    expect(bundle.rootPath).toBe('openapi.yaml');
    expect(bundle.files.size).toBe(1);
    expect(bundle.completeness).toBe('full');
    expect(bundle.format).toBe('openapi-yaml');
    expect(bundle.files.get('openapi.yaml')?.content).toBe(SINGLE_OPENAPI);
    expect(bundle.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces identical digests for the same members regardless of acquisition order', async () => {
    writeRel(
      'apis/svc/openapi.yaml',
      `openapi: 3.0.3
info: { title: T, version: 1.0.0 }
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                allOf:
                  - $ref: './components/a.yaml'
                  - $ref: './components/b.yaml'
`
    );
    writeRel('apis/svc/components/a.yaml', 'type: object\nproperties:\n  a:\n    type: string\n');
    writeRel('apis/svc/components/b.yaml', 'type: object\nproperties:\n  b:\n    type: string\n');

    const first = await acquireDefinitionBundle({
      workspaceRoot: workspaceDir,
      specPath: 'apis/svc/openapi.yaml'
    });
    const second = await acquireDefinitionBundle({
      workspaceRoot: workspaceDir,
      specPath: 'apis/svc/openapi.yaml'
    });
    expect(first.digest).toBe(second.digest);
    expect([...first.files.keys()].sort()).toEqual(['components/a.yaml', 'components/b.yaml', 'openapi.yaml']);
    expect([...second.files.keys()].sort()).toEqual(['components/a.yaml', 'components/b.yaml', 'openapi.yaml']);
  });

  it('reopens inventory members and rejects hash/size mismatches', async () => {
    writeRel('apis/svc/openapi.yaml', SINGLE_OPENAPI);
    writeRel('apis/svc/components/pet.yaml', 'type: object\n');
    const rootBytes = Buffer.byteLength(SINGLE_OPENAPI, 'utf8');
    const rootSha = createHash('sha256').update(SINGLE_OPENAPI, 'utf8').digest('hex');
    const depBody = 'type: object\n';
    const depBytes = Buffer.byteLength(depBody, 'utf8');
    const depSha = createHash('sha256').update(depBody, 'utf8').digest('hex');

    const inventory = {
      schemaVersion: 1,
      root: 'apis/svc/openapi.yaml',
      format: 'openapi-yaml',
      completeness: 'full',
      provenance: { kind: 'provider', provider: 'aws' },
      files: [
        { path: 'apis/svc/components/pet.yaml', role: 'dependency', bytes: depBytes, sha256: depSha },
        { path: 'apis/svc/openapi.yaml', role: 'root', bytes: rootBytes, sha256: rootSha }
      ]
    };

    // Inventory lists an unreferenced companion: invalid for OpenAPI reachability.
    await expect(
      acquireDefinitionBundle({
        workspaceRoot: workspaceDir,
        specPath: 'apis/svc/openapi.yaml',
        specFilesJson: JSON.stringify(inventory)
      })
    ).rejects.toThrow(/CONTRACT_DEFINITION_INVENTORY_INVALID|CONTRACT_DEFINITION_CLOSURE_INCOMPLETE/);

    writeRel(
      'apis/svc/openapi.yaml',
      `openapi: 3.0.3
info: { title: T, version: 1.0.0 }
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: './components/pet.yaml'
`
    );
    const rootWithRef = await import('node:fs').then((fs) =>
      fs.readFileSync(join(workspaceDir, 'apis/svc/openapi.yaml'))
    );
    const matchingInventory = {
      schemaVersion: 1,
      root: 'apis/svc/openapi.yaml',
      format: 'openapi-yaml',
      completeness: 'full',
      provenance: { kind: 'provider', provider: 'aws' },
      files: [
        {
          path: 'apis/svc/components/pet.yaml',
          role: 'dependency',
          bytes: depBytes,
          sha256: depSha
        },
        {
          path: 'apis/svc/openapi.yaml',
          role: 'root',
          bytes: rootWithRef.byteLength,
          sha256: createHash('sha256').update(rootWithRef).digest('hex')
        }
      ]
    };
    const bundle = await acquireDefinitionBundle({
      workspaceRoot: workspaceDir,
      specPath: 'apis/svc/openapi.yaml',
      specFilesJson: JSON.stringify(matchingInventory)
    });
    expect(bundle.files.size).toBe(2);
    expect(bundle.provenance.source).toBe('discovery-inventory');

    const mismatch = {
      ...matchingInventory,
      files: matchingInventory.files.map((entry) =>
        entry.role === 'dependency'
          ? { ...entry, sha256: '0'.repeat(64) }
          : entry
      )
    };
    await expect(
      acquireDefinitionBundle({
        workspaceRoot: workspaceDir,
        specPath: 'apis/svc/openapi.yaml',
        specFilesJson: JSON.stringify(mismatch)
      })
    ).rejects.toThrow(/CONTRACT_DEFINITION_MEMBER_MISMATCH/);
  });

  it('keeps the source bundle immutable after creation', async () => {
    writeRel('apis/svc/openapi.yaml', SINGLE_OPENAPI);
    const bundle: DefinitionBundle = await acquireDefinitionBundle({
      workspaceRoot: workspaceDir,
      specPath: 'apis/svc/openapi.yaml'
    });
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(() => {
      (bundle as { digest: string }).digest = 'tampered';
    }).toThrow();
  });

  it('rejects inventory member count and declared aggregate size before opening members', async () => {
    // Paths are intentionally absent: if acquisition opened members before the
    // count/size gates, these would fail with READ_FAILED / PATH_NOT_FILE instead.
    const files = [];
    for (let i = 0; i < 102; i += 1) {
      const rel = i === 0 ? 'apis/many/openapi.yaml' : `apis/many/d${String(i).padStart(3, '0')}.yaml`;
      files.push({
        path: rel,
        role: i === 0 ? ('root' as const) : ('dependency' as const),
        bytes: 4,
        sha256: createHash('sha256').update(`x${i}`, 'utf8').digest('hex')
      });
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const inventory = {
      schemaVersion: 1 as const,
      root: 'apis/many/openapi.yaml',
      format: 'openapi-yaml' as const,
      completeness: 'full' as const,
      provenance: { kind: 'provider' as const, provider: 'aws' as const },
      files
    };

    await expect(
      acquireDefinitionBundle({
        workspaceRoot: workspaceDir,
        specPath: 'apis/many/openapi.yaml',
        specFilesJson: JSON.stringify(inventory)
      })
    ).rejects.toThrow(/CONTRACT_REF_COUNT_EXCEEDED/);

    const sizeInventory = {
      schemaVersion: 1 as const,
      root: 'apis/svc/huge.yaml',
      format: 'openapi-yaml' as const,
      completeness: 'full' as const,
      provenance: { kind: 'provider' as const, provider: 'gcp' as const },
      files: [
        {
          path: 'apis/svc/huge.yaml',
          role: 'root' as const,
          bytes: 25 * 1024 * 1024 + 1,
          sha256: 'b'.repeat(64)
        }
      ]
    };
    await expect(
      acquireDefinitionBundle({
        workspaceRoot: workspaceDir,
        specPath: 'apis/svc/huge.yaml',
        specFilesJson: JSON.stringify(sizeInventory)
      })
    ).rejects.toThrow(/CONTRACT_REF_SIZE_EXCEEDED/);

    // Declared aggregate across multiple under-limit members also rejects pre-read.
    const mid = Math.floor((25 * 1024 * 1024) / 2) + 1;
    const aggregateInventory = {
      schemaVersion: 1 as const,
      root: 'apis/svc/a.yaml',
      format: 'openapi-yaml' as const,
      completeness: 'full' as const,
      provenance: { kind: 'provider' as const, provider: 'azure' as const },
      files: [
        {
          path: 'apis/svc/a.yaml',
          role: 'root' as const,
          bytes: mid,
          sha256: 'c'.repeat(64)
        },
        {
          path: 'apis/svc/b.yaml',
          role: 'dependency' as const,
          bytes: mid,
          sha256: 'd'.repeat(64)
        }
      ]
    };
    await expect(
      acquireDefinitionBundle({
        workspaceRoot: workspaceDir,
        specPath: 'apis/svc/a.yaml',
        specFilesJson: JSON.stringify(aggregateInventory)
      })
    ).rejects.toThrow(/CONTRACT_REF_SIZE_EXCEEDED/);
  });

  it('acquires local protobuf, WSDL/XSD, and AsyncAPI transitive closures', async () => {
    writeRel(
      'apis/grpc/types.proto',
      `syntax = "proto3";
package payments.v1;
message ChargeRequest { string amount = 1; }
message ChargeResponse { string receipt_id = 1; }
`
    );
    writeRel(
      'apis/grpc/service.proto',
      `syntax = "proto3";
package payments.v1;
import "types.proto";
service Payments {
  rpc Charge(ChargeRequest) returns (ChargeResponse);
}
`
    );
    const protoBundle = await acquireDefinitionBundle({
      workspaceRoot: workspaceDir,
      specPath: 'apis/grpc/service.proto'
    });
    expect(protoBundle.format).toBe('protobuf');
    expect([...protoBundle.files.keys()].sort()).toEqual(['service.proto', 'types.proto']);
    expect(protoBundle.files.get('types.proto')?.content).toContain('ChargeRequest');

    const typesXsd = `<?xml version="1.0" encoding="UTF-8"?>
<schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:payments/types" elementFormDefault="qualified">
  <element name="Charge"><complexType><sequence>
    <element name="amount" type="string"/>
  </sequence></complexType></element>
  <element name="ChargeResponse"><complexType><sequence>
    <element name="receiptId" type="string"/>
  </sequence></complexType></element>
</schema>
`;
    const opsWsdl = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
    xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
    xmlns:tns="urn:payments/ops"
    xmlns:types="urn:payments/types"
    targetNamespace="urn:payments/ops">
  <types>
    <schema xmlns="http://www.w3.org/2001/XMLSchema">
      <import namespace="urn:payments/types" schemaLocation="types.xsd"/>
    </schema>
  </types>
  <message name="ChargeRequest"><part name="body" element="types:Charge"/></message>
  <message name="ChargeResponse"><part name="body" element="types:ChargeResponse"/></message>
  <portType name="PaymentsPortType">
    <operation name="Charge">
      <input message="tns:ChargeRequest"/>
      <output message="tns:ChargeResponse"/>
    </operation>
  </portType>
</definitions>
`;
    const rootWsdl = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
    xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
    xmlns:tns="urn:payments"
    xmlns:ops="urn:payments/ops"
    targetNamespace="urn:payments">
  <import namespace="urn:payments/ops" location="payments-ops.wsdl"/>
  <binding name="PaymentsBinding" type="ops:PaymentsPortType">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/>
    <operation name="Charge">
      <soap:operation soapAction="urn:payments/Charge"/>
      <input><soap:body use="literal"/></input>
      <output><soap:body use="literal"/></output>
    </operation>
  </binding>
  <service name="PaymentsService">
    <port name="PaymentsPort" binding="tns:PaymentsBinding">
      <soap:address location="https://payments.example.test/soap"/>
    </port>
  </service>
</definitions>
`;
    writeRel('apis/soap/types.xsd', typesXsd);
    writeRel('apis/soap/payments-ops.wsdl', opsWsdl);
    writeRel('apis/soap/payments.wsdl', rootWsdl);
    const wsdlBundle = await acquireDefinitionBundle({
      workspaceRoot: workspaceDir,
      specPath: 'apis/soap/payments.wsdl'
    });
    expect(wsdlBundle.format).toBe('wsdl');
    expect([...wsdlBundle.files.keys()].sort()).toEqual([
      'payments-ops.wsdl',
      'payments.wsdl',
      'types.xsd'
    ]);

    writeRel(
      'apis/async/messages.yaml',
      `ChatMessage:
  name: ChatMessage
  payload:
    type: object
    properties:
      text:
        type: string
`
    );
    writeRel(
      'apis/async/asyncapi.yaml',
      `asyncapi: 2.6.0
info:
  title: Chat
  version: 1.0.0
servers:
  production:
    url: wss://chat.example.test
    protocol: ws
channels:
  chat:
    publish:
      message:
        $ref: './messages.yaml#/ChatMessage'
`
    );
    const asyncBundle = await acquireDefinitionBundle({
      workspaceRoot: workspaceDir,
      specPath: 'apis/async/asyncapi.yaml'
    });
    expect(asyncBundle.format).toBe('asyncapi-yaml');
    expect([...asyncBundle.files.keys()].sort()).toEqual(['asyncapi.yaml', 'messages.yaml']);
    expect(asyncBundle.files.get('messages.yaml')?.content).toContain('ChatMessage');
  });

  it('rejects unreachable non-OpenAPI inventory members and keeps GraphQL/MCP root-only', async () => {
    writeRel(
      'apis/gql/schema.graphql',
      'type Query { ping: String }\n'
    );
    writeRel('apis/gql/extra.graphql', 'type Extra { x: String }\n');
    const rootBody = 'type Query { ping: String }\n';
    const extraBody = 'type Extra { x: String }\n';
    const gqlInventory = {
      schemaVersion: 1 as const,
      root: 'apis/gql/schema.graphql',
      format: 'graphql-sdl' as const,
      completeness: 'full' as const,
      provenance: { kind: 'provider' as const, provider: 'azure' as const },
      files: [
        {
          path: 'apis/gql/extra.graphql',
          role: 'dependency' as const,
          bytes: Buffer.byteLength(extraBody, 'utf8'),
          sha256: createHash('sha256').update(extraBody, 'utf8').digest('hex')
        },
        {
          path: 'apis/gql/schema.graphql',
          role: 'root' as const,
          bytes: Buffer.byteLength(rootBody, 'utf8'),
          sha256: createHash('sha256').update(rootBody, 'utf8').digest('hex')
        }
      ]
    };
    await expect(
      acquireDefinitionBundle({
        workspaceRoot: workspaceDir,
        specPath: 'apis/gql/schema.graphql',
        specFilesJson: JSON.stringify(gqlInventory)
      })
    ).rejects.toThrow(/CONTRACT_DEFINITION_INVENTORY_INVALID/);

    writeRel(
      'apis/grpc/service.proto',
      `syntax = "proto3";
package t;
import "missing.proto";
message M { string a = 1; }
service S { rpc G(M) returns (M); }
`
    );
    await expect(
      acquireDefinitionBundle({
        workspaceRoot: workspaceDir,
        specPath: 'apis/grpc/service.proto'
      })
    ).rejects.toThrow(/CONTRACT_DEFINITION_CLOSURE_INCOMPLETE/);
  });

  it('proves map and bytes mutation cannot change stored state or digest', async () => {
    writeRel(
      'apis/svc/openapi.yaml',
      `openapi: 3.0.3
info: { title: T, version: 1.0.0 }
paths:
  /pets:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: './components/pet.yaml'
`
    );
    writeRel('apis/svc/components/pet.yaml', 'type: object\nproperties:\n  id:\n    type: integer\n');
    const bundle = await acquireDefinitionBundle({
      workspaceRoot: workspaceDir,
      specPath: 'apis/svc/openapi.yaml'
    });
    const digestBefore = bundle.digest;
    const petBefore = bundle.files.get('components/pet.yaml')!;
    const originalSha = petBefore.sha256;
    const originalContent = petBefore.content;
    const originalByte = petBefore.bytes[0];

    const mutableBytes = petBefore.bytes;
    mutableBytes[0] = (originalByte! ^ 0xff) & 0xff;
    expect(bundle.files.get('components/pet.yaml')?.bytes[0]).toBe(originalByte);
    expect(bundle.files.get('components/pet.yaml')?.content).toBe(originalContent);
    expect(bundle.files.get('components/pet.yaml')?.sha256).toBe(originalSha);
    expect(bundle.digest).toBe(digestBefore);

    const filesAsAny = bundle.files as unknown as Map<string, DefinitionFile>;
    expect(typeof filesAsAny.set).not.toBe('function');
    expect(bundle.files.has('components/pet.yaml')).toBe(true);
    expect(bundle.files.size).toBe(2);
    expect(bundle.digest).toBe(
      computeDefinitionBundleDigest({
        schemaVersion: 1,
        rootPath: bundle.rootPath,
        format: bundle.format,
        files: bundle.files
      })
    );
  });
});

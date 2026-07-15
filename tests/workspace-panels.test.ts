import { describe, expect, it, vi } from 'vitest';

import {
  applyWorkspaceSections,
  panelTypeForElement,
  sectionNameForDecision,
  shouldApplySections,
  type WorkspacePanelsClient
} from '../src/lib/postman/workspace-panels-client.js';
import type { BranchDecision } from '../src/lib/repo/branch-decision.js';

function decision(overrides: Partial<BranchDecision> = {}): BranchDecision {
  return {
    tier: 'canonical',
    strategy: 'publish-gate',
    identity: {
      provider: 'github',
      headBranch: 'main',
      defaultBranch: 'main',
      refKind: 'default-branch',
      isPrContext: false,
      isForkPr: false
    },
    canonicalBranch: 'main',
    reason: 'test',
    ...overrides
  } as BranchDecision;
}

describe('workspace panels helpers', () => {
  it('names shelves by tier', () => {
    expect(sectionNameForDecision(decision({ tier: 'canonical' }))).toBe('Canonical');
    expect(sectionNameForDecision(decision({ tier: 'legacy' }))).toBe('Canonical');
    expect(
      sectionNameForDecision(decision({ tier: 'channel', channel: { pattern: 'develop', code: 'DEV' } }))
    ).toBe('Channel DEV');
    expect(sectionNameForDecision(decision({ tier: 'preview' }))).toBe('Previews');
  });

  it('maps element types to panel partitions', () => {
    expect(panelTypeForElement('collection')).toBe('1');
    expect(panelTypeForElement('specification')).toBe('1');
    expect(panelTypeForElement('environment')).toBe('1');
    expect(panelTypeForElement('mock')).toBe('2');
    expect(panelTypeForElement('monitor')).toBe('2');
  });

  it('skips gated and off modes', () => {
    expect(shouldApplySections('off', 'canonical')).toBe(false);
    expect(shouldApplySections('auto', 'gated')).toBe(false);
    expect(shouldApplySections('auto', 'preview')).toBe(true);
  });
});

describe('applyWorkspaceSections', () => {
  it('no-ops when sections=off', async () => {
    const client: WorkspacePanelsClient = {
      listPanels: vi.fn(),
      createPanel: vi.fn(),
      bulkMoveItems: vi.fn()
    };
    const result = await applyWorkspaceSections({
      mode: 'off',
      workspaceId: 'ws-1',
      decision: decision(),
      elements: [{ elementType: 'collection', elementId: 'c1' }],
      client
    });
    expect(result.status).toBe('skipped');
    expect(client.listPanels).not.toHaveBeenCalled();
  });

  it('creates the tier section and moves owned items fail-open on success', async () => {
    const client: WorkspacePanelsClient = {
      listPanels: vi
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'uncat-1',
            name: 'uncategorized',
            panelType: '1',
            isUncategorized: true,
            items: [{ id: 'item-1', elementType: 'collection', elementId: 'coll-1' }]
          }
        ])
        .mockResolvedValueOnce([
          {
            id: 'sec-1',
            name: 'Canonical',
            panelType: '1',
            isUncategorized: false,
            items: []
          },
          {
            id: 'uncat-1',
            name: 'uncategorized',
            panelType: '1',
            isUncategorized: true,
            items: [{ id: 'item-1', elementType: 'collection', elementId: 'coll-1' }]
          }
        ]),
      createPanel: vi.fn().mockResolvedValue({
        id: 'sec-1',
        name: 'Canonical',
        panelType: '1',
        isUncategorized: false
      }),
      bulkMoveItems: vi.fn().mockResolvedValue(undefined)
    };

    const result = await applyWorkspaceSections({
      mode: 'auto',
      workspaceId: 'ws-1',
      decision: decision({ tier: 'canonical' }),
      elements: [{ elementType: 'collection', elementId: 'coll-1' }],
      client
    });

    expect(result.status).toBe('applied');
    expect(result.sectionName).toBe('Canonical');
    expect(result.moved).toBe(1);
    expect(client.createPanel).toHaveBeenCalledWith('ws-1', {
      name: 'Canonical',
      panelType: '1',
      position: { type: 'end' }
    });
    expect(client.bulkMoveItems).toHaveBeenCalledWith('ws-1', {
      items: [{ itemId: 'item-1', sourcePanelId: 'uncat-1' }],
      targetPanelId: 'sec-1',
      position: { type: 'end' }
    });
  });

  it('degrades to warning on client errors and never throws', async () => {
    const warnings: string[] = [];
    const client: WorkspacePanelsClient = {
      listPanels: vi.fn().mockRejectedValue(new Error('Workspace panels are not available')),
      createPanel: vi.fn(),
      bulkMoveItems: vi.fn()
    };
    const result = await applyWorkspaceSections({
      mode: 'auto',
      workspaceId: 'ws-1',
      decision: decision(),
      elements: [{ elementType: 'specification', elementId: 'spec-1' }],
      client,
      log: { warning: (message) => warnings.push(message) }
    });
    expect(result.status).toBe('degraded');
    expect(result.reason).toMatch(/not available/);
    expect(warnings[0]).toMatch(/non-fatal/);
  });
});

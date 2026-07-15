/**
 * Cosmetic workspace Sections (panels) client — plan §6.8 / PRD R23.
 *
 * Identity and GC stay on prefixes/markers. Panel failures must never fail sync.
 * Live gate (2026-07-15): team allowlist + x-app-version >= 13.0.0 via bifrost.
 */

import type { AccessTokenGatewayClient } from './gateway-client.js';
import type { BranchDecision, BranchTier } from '../repo/branch-decision.js';

export const PANELS_MIN_APP_VERSION = '13.0.0';

export type SectionsMode = 'auto' | 'off';

export type PanelElementType =
  | 'collection'
  | 'specification'
  | 'environment'
  | 'mock'
  | 'monitor'
  | 'document'
  | 'api'
  | 'flow';

export interface PanelElementRef {
  elementType: PanelElementType;
  elementId: string;
}

export interface WorkspacePanel {
  id: string;
  name: string;
  panelType: string;
  isUncategorized: boolean;
  itemCount?: number;
  items?: Array<{ id: string; elementType: string; elementId: string }>;
}

export interface WorkspacePanelsClient {
  listPanels(workspaceId: string, options?: { includeItems?: boolean }): Promise<WorkspacePanel[]>;
  createPanel(
    workspaceId: string,
    body: { name: string; panelType: '1' | '2'; position?: { type: 'start' | 'end' } }
  ): Promise<WorkspacePanel>;
  bulkMoveItems(
    workspaceId: string,
    body: {
      items: Array<{ itemId: string; sourcePanelId: string }>;
      targetPanelId: string;
      position?: { type: 'start' | 'end' };
    }
  ): Promise<void>;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function panelsHeaders(teamId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'x-app-version': PANELS_MIN_APP_VERSION,
    'User-Agent': `Postman/${PANELS_MIN_APP_VERSION}`
  };
  const team = String(teamId || '').trim();
  if (team) headers['x-entity-team-id'] = team;
  return headers;
}

function mapPanel(raw: unknown): WorkspacePanel | null {
  const value = asRecord(raw);
  if (!value) return null;
  const id = String(value.id ?? '').trim();
  const name = String(value.name ?? '').trim();
  if (!id || !name) return null;
  const items = Array.isArray(value.items)
    ? value.items
        .map((entry) => {
          const item = asRecord(entry);
          if (!item) return null;
          const itemId = String(item.id ?? '').trim();
          const elementType = String(item.elementType ?? '').trim();
          const elementId = String(item.elementId ?? '').trim();
          if (!itemId || !elementType || !elementId) return null;
          return { id: itemId, elementType, elementId };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    : undefined;
  return {
    id,
    name,
    panelType: String(value.panelType ?? '1'),
    isUncategorized: Boolean(value.isUncategorized),
    itemCount: typeof value.itemCount === 'number' ? value.itemCount : undefined,
    items
  };
}

/** Section shelf name for the current branch tier (cosmetic only). */
export function sectionNameForDecision(decision: Pick<BranchDecision, 'tier' | 'channel'>): string {
  if (decision.tier === 'channel' && decision.channel?.code) {
    return `Channel ${decision.channel.code}`;
  }
  if (decision.tier === 'preview') return 'Previews';
  return 'Canonical';
}

/** Panel partition: specs/collections/envs = 1; mocks/monitors = 2. */
export function panelTypeForElement(elementType: PanelElementType): '1' | '2' {
  if (elementType === 'mock' || elementType === 'monitor') return '2';
  return '1';
}

export function createWorkspacePanelsClient(options: {
  gateway: AccessTokenGatewayClient;
  teamId?: string;
}): WorkspacePanelsClient {
  const { gateway, teamId } = options;

  return {
    async listPanels(workspaceId, listOptions = {}) {
      const query = listOptions.includeItems
        ? '?includeItems=true&includeItemCount=true'
        : '?includeItemCount=true';
      const response = await gateway.requestJson<JsonRecord>({
        service: 'workspaces',
        method: 'get',
        path: `/workspaces/${workspaceId}/panels${query}`,
        headers: panelsHeaders(teamId),
        retry: 'safe'
      });
      const data = asRecord(response?.data) ?? response;
      const panels = Array.isArray(asRecord(data)?.panels)
        ? (asRecord(data)!.panels as unknown[])
        : Array.isArray(response?.panels)
          ? (response.panels as unknown[])
          : [];
      return panels.map(mapPanel).filter((panel): panel is WorkspacePanel => panel !== null);
    },

    async createPanel(workspaceId, body) {
      const response = await gateway.requestJson<JsonRecord>({
        service: 'workspaces',
        method: 'post',
        path: `/workspaces/${workspaceId}/panels`,
        headers: panelsHeaders(teamId),
        body: {
          name: body.name,
          panelType: body.panelType,
          position: body.position ?? { type: 'end' }
        },
        retry: 'none'
      });
      const data = asRecord(response?.data) ?? response;
      const panel = mapPanel(asRecord(data)?.panel ?? data);
      if (!panel) throw new Error('createPanel did not return a panel id');
      return panel;
    },

    async bulkMoveItems(workspaceId, body) {
      if (body.items.length === 0) return;
      // Server max is 50; chunk defensively.
      for (let offset = 0; offset < body.items.length; offset += 50) {
        const chunk = body.items.slice(offset, offset + 50);
        await gateway.requestJson<JsonRecord>({
          service: 'workspaces',
          method: 'patch',
          path: `/workspaces/${workspaceId}/panels/items/move`,
          headers: panelsHeaders(teamId),
          body: {
            items: chunk,
            targetPanelId: body.targetPanelId,
            position: body.position ?? { type: 'end' }
          },
          retry: 'none'
        });
      }
    }
  };
}

export interface ApplyWorkspaceSectionsOptions {
  mode: SectionsMode;
  workspaceId: string;
  decision: Pick<BranchDecision, 'tier' | 'channel'>;
  elements: PanelElementRef[];
  client: WorkspacePanelsClient;
  log?: { info?: (message: string) => void; warning?: (message: string) => void };
}

/**
 * Ensure the tier section exists and move owned elements into it.
 * Fail-open: every error becomes a warning; never throws to the caller.
 */
export async function applyWorkspaceSections(options: ApplyWorkspaceSectionsOptions): Promise<{
  status: 'skipped' | 'applied' | 'degraded';
  sectionName?: string;
  moved?: number;
  reason?: string;
}> {
  const log = options.log ?? {};
  if (options.mode !== 'auto') {
    return { status: 'skipped', reason: 'sections=off' };
  }
  if (!options.workspaceId) {
    return { status: 'skipped', reason: 'no workspace id' };
  }
  const elements = options.elements.filter((entry) => entry.elementId);
  if (elements.length === 0) {
    return { status: 'skipped', reason: 'no elements to place' };
  }

  const sectionName = sectionNameForDecision(options.decision);
  try {
    let panels = await options.client.listPanels(options.workspaceId, { includeItems: true });
    // Group elements by panelType partition.
    const byType = new Map<'1' | '2', PanelElementRef[]>();
    for (const element of elements) {
      const panelType = panelTypeForElement(element.elementType);
      const list = byType.get(panelType) ?? [];
      list.push(element);
      byType.set(panelType, list);
    }

    let moved = 0;
    for (const [panelType, typedElements] of byType) {
      let target = panels.find(
        (panel) => !panel.isUncategorized && panel.panelType === panelType && panel.name.toLowerCase() === sectionName.toLowerCase()
      );
      if (!target) {
        target = await options.client.createPanel(options.workspaceId, {
          name: sectionName,
          panelType,
          position: { type: 'end' }
        });
        log.info?.(`sections: created "${sectionName}" (panelType ${panelType})`);
        panels = await options.client.listPanels(options.workspaceId, { includeItems: true });
        target =
          panels.find((panel) => panel.id === target!.id) ??
          panels.find(
            (panel) =>
              !panel.isUncategorized &&
              panel.panelType === panelType &&
              panel.name.toLowerCase() === sectionName.toLowerCase()
          ) ??
          target;
      }

      const uncategorized = panels.find((panel) => panel.isUncategorized && panel.panelType === panelType);
      const moves: Array<{ itemId: string; sourcePanelId: string }> = [];
      for (const element of typedElements) {
        const owner = panels.find((panel) =>
          (panel.items ?? []).some(
            (item) => item.elementType === element.elementType && item.elementId === element.elementId
          )
        );
        const item = (owner?.items ?? []).find(
          (entry) => entry.elementType === element.elementType && entry.elementId === element.elementId
        );
        if (!item || !owner) continue;
        if (owner.id === target.id) continue;
        moves.push({ itemId: item.id, sourcePanelId: owner.id });
      }
      // Fresh assets often land in uncategorized after list; if item not found yet,
      // a later repo-sync pass can place them. Do not invent item ids.
      if (moves.length === 0 && uncategorized) {
        log.info?.(
          `sections: no movable items for "${sectionName}" yet (assets may still be uncategorized-unindexed)`
        );
      }
      if (moves.length > 0) {
        await options.client.bulkMoveItems(options.workspaceId, {
          items: moves,
          targetPanelId: target.id,
          position: { type: 'end' }
        });
        moved += moves.length;
        log.info?.(`sections: moved ${moves.length} item(s) into "${sectionName}"`);
      }
    }

    return { status: 'applied', sectionName, moved };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warning?.(`sections: skipped (non-fatal): ${reason}`);
    return { status: 'degraded', sectionName, reason };
  }
}

export function isSectionsMode(value: string | undefined): value is SectionsMode {
  return value === 'auto' || value === 'off';
}

export function shouldApplySections(mode: SectionsMode, tier: BranchTier): boolean {
  // Gated runs mint nothing; legacy still may want cosmetic grouping when auto.
  return mode === 'auto' && tier !== 'gated';
}

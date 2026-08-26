import type { Cassette, CassetteInteraction } from '@postman-cs/automation-core/cassette';

/**
 * WS9 drift detection: structural "shape" comparison between a freshly
 * re-recorded (and sanitized) cassette and the committed baseline.
 *
 * A shape deliberately ignores volatile values (IDs, names, timestamps —
 * already parameterized by the sanitizer) and compares only the surfaces a
 * replay depends on:
 *  - the multiset of interaction keys (service/method/path + canonical query
 *    + request-body digest), i.e. the wire contract;
 *  - each interaction's response status;
 *  - each response body's JSON schema skeleton (key sets and value kinds,
 *    recursively; arrays collapse to the union of element schemas).
 *
 * Drift on any of those axes names the exact interaction key and path so the
 * nightly monitor fails loudly with an actionable message.
 */

export type BodySchema =
  | { kind: 'null' | 'boolean' | 'number' | 'string' | 'unknown' }
  | { kind: 'array'; items: BodySchema[] }
  | { kind: 'object'; entries: Readonly<Record<string, BodySchema>> };

export interface InteractionShape {
  key: string;
  status: number;
  bodySchema: BodySchema;
}

export interface CassetteShape {
  interactions: InteractionShape[];
}

export interface DriftFinding {
  /** Interaction key (or key prefix) the finding names. */
  key: string;
  /** Which contract axis drifted. */
  axis: 'key-set' | 'status' | 'body-schema';
  /** Human-actionable one-line description naming the exact difference. */
  detail: string;
}

function schemaOfValue(value: unknown): BodySchema {
  if (value === null) return { kind: 'null' };
  if (typeof value === 'boolean') return { kind: 'boolean' };
  if (typeof value === 'number') return { kind: 'number' };
  if (typeof value === 'string') return { kind: 'string' };
  if (Array.isArray(value)) {
    const seen: BodySchema[] = [];
    for (const item of value) {
      const schema = schemaOfValue(item);
      if (!seen.some((existing) => schemaEquals(existing, schema))) seen.push(schema);
    }
    return { kind: 'array', items: seen.sort((a, b) => schemaSignature(a).localeCompare(schemaSignature(b))) };
  }
  if (typeof value === 'object') {
    const entries: Record<string, BodySchema> = {};
    for (const [name, entry] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
      entries[name] = schemaOfValue(entry);
    }
    return { kind: 'object', entries };
  }
  return { kind: 'unknown' };
}

export function schemaSignature(schema: BodySchema): string {
  switch (schema.kind) {
    case 'array':
      return `array<${schema.items.map(schemaSignature).join('|')}>`;
    case 'object':
      return `{${Object.entries(schema.entries)
        .map(([name, entry]) => `${name}:${schemaSignature(entry)}`)
        .join(',')}}`;
    default:
      return schema.kind;
  }
}

export function schemaEquals(left: BodySchema, right: BodySchema): boolean {
  return schemaSignature(left) === schemaSignature(right);
}

function bodySchema(interaction: CassetteInteraction): BodySchema {
  const body = interaction.body;
  if (body === undefined || body === '') return { kind: 'unknown' };
  try {
    return schemaOfValue(JSON.parse(body));
  } catch {
    // Non-JSON bodies (YAML exports, plain text) compare as opaque strings.
    return { kind: 'string' };
  }
}

export function cassetteShape(cassette: Cassette): CassetteShape {
  return {
    interactions: cassette.interactions.map((interaction) => ({
      key: interaction.key,
      status: interaction.status,
      bodySchema: bodySchema(interaction)
    }))
  };
}

/**
 * Locate the first structural difference between two body schemas, returning a
 * dotted path plus a short description, or undefined when they match.
 */
function firstSchemaDifference(
  baseline: BodySchema,
  fresh: BodySchema,
  pathPrefix: string
): string | undefined {
  if (baseline.kind !== fresh.kind) {
    return `${pathPrefix || '$'}: ${baseline.kind} -> ${fresh.kind}`;
  }
  if (baseline.kind === 'object' && fresh.kind === 'object') {
    const baselineKeys = Object.keys(baseline.entries);
    const freshKeys = Object.keys(fresh.entries);
    for (const name of baselineKeys) {
      if (!(name in fresh.entries)) return `${pathPrefix || '$'}: key "${name}" removed`;
    }
    for (const name of freshKeys) {
      if (!(name in baseline.entries)) return `${pathPrefix || '$'}: key "${name}" added`;
    }
    for (const name of baselineKeys) {
      const difference = firstSchemaDifference(
        baseline.entries[name] as BodySchema,
        fresh.entries[name] as BodySchema,
        pathPrefix ? `${pathPrefix}.${name}` : name
      );
      if (difference) return difference;
    }
    return undefined;
  }
  if (baseline.kind === 'array' && fresh.kind === 'array') {
    if (!schemaEquals(baseline, fresh)) {
      return `${pathPrefix || '$'}[]: element schema ${baseline.items.map(schemaSignature).join('|') || 'empty'} -> ${
        fresh.items.map(schemaSignature).join('|') || 'empty'
      }`;
    }
  }
  return undefined;
}

/**
 * Compare a fresh cassette shape against the committed baseline shape.
 *
 * Key comparison is a multiset diff: missing keys, unexpected keys, and
 * repeated-count changes are each named. Interactions whose keys match are
 * then compared pairwise as an order-independent multiset on status and body
 * schema. This avoids treating recording-order changes among repeated keys as
 * response-contract drift.
 */
export function diffCassetteShapes(baseline: CassetteShape, fresh: CassetteShape): DriftFinding[] {
  const findings: DriftFinding[] = [];

  const countByKey = (shape: CassetteShape): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const { key } of shape.interactions) counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  };
  const baselineCounts = countByKey(baseline);
  const freshCounts = countByKey(fresh);

  for (const [key, count] of [...baselineCounts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const freshCount = freshCounts.get(key) ?? 0;
    if (freshCount === 0) {
      findings.push({ key, axis: 'key-set', detail: 'interaction missing from live re-recording' });
    } else if (freshCount !== count) {
      findings.push({
        key,
        axis: 'key-set',
        detail: `interaction count changed: baseline ${count} -> live ${freshCount}`
      });
    }
  }
  for (const [key] of [...freshCounts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!baselineCounts.has(key)) {
      findings.push({ key, axis: 'key-set', detail: 'unexpected new interaction in live re-recording' });
    }
  }

  const byKey = (shape: CassetteShape): Map<string, InteractionShape[]> => {
    const grouped = new Map<string, InteractionShape[]>();
    for (const interaction of shape.interactions) {
      const list = grouped.get(interaction.key) ?? [];
      list.push(interaction);
      grouped.set(interaction.key, list);
    }
    return grouped;
  };
  const baselineByKey = byKey(baseline);
  const freshByKey = byKey(fresh);

  const compareInteractions = (left: InteractionShape, right: InteractionShape): number => {
    const statusOrder = left.status - right.status;
    return statusOrder === 0
      ? schemaSignature(left.bodySchema).localeCompare(schemaSignature(right.bodySchema))
      : statusOrder;
  };

  for (const [key, baselineList] of [...baselineByKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const freshList = freshByKey.get(key) ?? [];
    const sortedBaselineList = [...baselineList].sort(compareInteractions);
    const sortedFreshList = [...freshList].sort(compareInteractions);
    const pairs = Math.min(baselineList.length, freshList.length);
    for (let index = 0; index < pairs; index += 1) {
      const baselineInteraction = sortedBaselineList[index] as InteractionShape;
      const freshInteraction = sortedFreshList[index] as InteractionShape;
      if (baselineInteraction.status !== freshInteraction.status) {
        findings.push({
          key,
          axis: 'status',
          detail: `status changed: baseline ${baselineInteraction.status} -> live ${freshInteraction.status}`
        });
      }
      const difference = firstSchemaDifference(
        baselineInteraction.bodySchema,
        freshInteraction.bodySchema,
        ''
      );
      if (difference) {
        findings.push({ key, axis: 'body-schema', detail: `response body schema drift at ${difference}` });
      }
    }
  }

  return findings;
}

/** Render findings as a loud, stable, one-finding-per-line report. */
export function formatDriftReport(findings: DriftFinding[]): string {
  return findings
    .map((finding) => `DRIFT [${finding.axis}] ${finding.key} — ${finding.detail}`)
    .join('\n');
}

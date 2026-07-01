import type { GraphQLContractIndex, GraphQLTypeRef } from './parser.js';

/**
 * Depth to which the generated GraphQL query expands nested object/interface
 * fields. At depth 1 the root selection contains only scalar/enum leaves of the
 * return type; nested composites are left unselected. The instrumenter consumes
 * the SAME selection, so it never asserts a field the query did not request.
 */
export const SELECTION_DEPTH = 1;

/**
 * One selected field of a GraphQL selection set. `selection` is the nested
 * selection when this field is an expanded object/interface, and `null` for a
 * scalar/enum leaf. An empty array means the object was selected but exposes no
 * scalar/enum leaves (`{ __typename }` only).
 */
export interface SelectedField {
  name: string;
  type: GraphQLTypeRef;
  selection: SelectedField[] | null;
}

/**
 * Compute the selected fields for an object/interface type at `depth`. Scalar
 * and enum fields become leaves; object/interface fields are expanded only while
 * `depth < SELECTION_DEPTH`. A union returns an empty selection (rendered as
 * `{ __typename }`, the minimal valid selection set a union field requires).
 * Returns `null` for scalars, enums, and unknowns, which need no selection set.
 *
 * This is the single source of truth shared by the builder (which renders the
 * query from it) and the instrumenter (which asserts only what it selects).
 */
export function selectFields(
  typeRef: GraphQLTypeRef,
  index: GraphQLContractIndex,
  depth: number
): SelectedField[] | null {
  // A union field still requires a selection set in the query, but its members
  // share no common fields to select, so emit the minimal valid selection
  // (rendered as { __typename } from an empty selection).
  if (typeRef.kind === 'union') return [];
  if (typeRef.kind !== 'object' && typeRef.kind !== 'interface') return null;
  const shape = index.objectShapes[typeRef.name];
  if (!shape) return [];
  const selected: SelectedField[] = [];
  for (const field of shape.fields) {
    if (field.type.kind === 'scalar' || field.type.kind === 'enum') {
      selected.push({ name: field.name, type: field.type, selection: null });
    } else if (
      (field.type.kind === 'object' || field.type.kind === 'interface') &&
      depth < SELECTION_DEPTH
    ) {
      selected.push({ name: field.name, type: field.type, selection: selectFields(field.type, index, depth + 1) ?? [] });
    }
  }
  return selected;
}

function indent(depth: number): string {
  return '  '.repeat(depth);
}

/**
 * Render a GraphQL selection-set string from a selection tree, byte-identical to
 * the document the builder emits. `null` (a scalar/enum leaf) renders no
 * sub-set; an empty selection renders `{ __typename }`.
 */
export function renderSelection(selection: SelectedField[] | null, depth: number): string {
  if (selection === null) return '';
  if (selection.length === 0) return ' { __typename }';
  const lines = selection.map(
    (field) => `${indent(depth + 1)}${field.name}${renderSelection(field.selection, depth + 1)}`
  );
  return ` {\n${lines.join('\n')}\n${indent(depth)}}`;
}

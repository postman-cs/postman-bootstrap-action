import { readFileSync } from 'node:fs';
import { buildProtocolCollection } from '../../src/lib/protocols/dispatch.js';
type J = Record<string, unknown>;

// EC documents root on 'children'; v2.1-wrapped EC roots on 'item'. Recurse on either.
function rootItems(c: J): J[] {
  const r = (c.item ?? c.children) as unknown;
  return Array.isArray(r) ? (r as J[]) : [];
}
function leaves(node: J[], acc: J[] = []): J[] {
  for (const it of node) {
    const kids = (it.children ?? it.item) as unknown;
    if (Array.isArray(kids) && kids.length) leaves(kids as J[], acc);
    else acc.push(it);
  }
  return acc;
}
function instrumented(l: J): boolean {
  const ext = l.extensions as J | undefined;
  if (ext && (ext.events || ext.event)) return true;
  if (Array.isArray(l.event) && (l.event as unknown[]).length > 0) return true;
  return !!l.extensions; // EC contract lints ride on the leaf's extensions block
}

const type = process.argv[2];
const fixture = process.argv[3];
(async () => {
  const r = await buildProtocolCollection(type as Parameters<typeof buildProtocolCollection>[0], readFileSync(fixture, 'utf8'), {});
  const lv = leaves(rootItems(r.collection as J));
  const kinds = [...new Set(lv.map((l) => String(l.$kind ?? l.type ?? '?')))];
  const inst = lv.filter(instrumented).length;
  const problems: string[] = [];
  if (lv.length === 0) problems.push('no leaves generated');
  if (lv.length !== r.operationCount) problems.push('leaf count ' + lv.length + ' != operationCount ' + r.operationCount);
  if (inst !== lv.length) problems.push('only ' + inst + '/' + lv.length + ' leaves carry contract assertions');
  const ok = problems.length === 0;
  console.log('  ' + type + ': format=' + r.format + ' runnableInCi=' + r.runnableInCi +
    ' opCount=' + r.operationCount + ' leaves=' + lv.length + ' kinds=' + JSON.stringify(kinds) +
    ' instrumented=' + inst + ' warnings=' + (r.warnings?.length ?? 0) + (ok ? '  OK' : '  FAIL'));
  for (const p of problems) console.log('    ! ' + p);
  process.exit(ok ? 0 : 1);
})();

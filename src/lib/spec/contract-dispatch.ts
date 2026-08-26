import { normalizePath, type ContractOperation } from './contract-index.js';

/**
 * Name marker of the optional secrets-resolver helper request. The collection
 * root `test` event fires for that item too (spike-proven), and it carries no
 * contract script today, so the dispatcher skips it by name instead of emitting
 * a mapping failure for it.
 */
export const CONTRACT_RESOLVER_ITEM_NAME = '00 - Resolve Secrets';

/** `[method, candidatePath, opKey, serverPrefixed]` — precomputed dispatch route. */
export type ContractDispatchRoute = [string, string, string, boolean];

/** Stable dispatch key for an operation (its contract-index operation id). */
export function contractOperationKey(operation: ContractOperation): string {
  return operation.id;
}

/**
 * Precompute the candidate table the runtime matcher walks. Mirrors the
 * generation-time candidate expansion in `matchOperation` exactly: one row per
 * (operation, candidate) pair, in operation order, flagged when the candidate is
 * a server-prefixed variant rather than the operation's own normalized path.
 */
export function buildDispatchRoutes(operations: readonly ContractOperation[]): ContractDispatchRoute[] {
  const routes: ContractDispatchRoute[] = [];
  for (const operation of operations) {
    const ownPath = normalizePath(operation.path);
    for (const candidate of operation.candidates) {
      routes.push([operation.method, candidate, contractOperationKey(operation), candidate !== ownPath]);
    }
  }
  return routes;
}

/** Exact text `instrumentContractCollection` emits for an ambiguous request. */
export function ambiguousMappingMessage(method: string, path: string, ids: readonly string[]): string {
  return `Ambiguous OpenAPI operation match for request ${method} ${path}: ${ids.join(', ')}`;
}

/** Exact text `instrumentContractCollection` emits for an unmatched request. */
export function unmatchedMappingMessage(method: string, path: string): string {
  return `No OpenAPI operation matched request ${method} ${path}`;
}

// Pure-JavaScript port of the generation-time segment matcher (`normalizePath`,
// `segments`, `isTemplateSegment`, `compoundSegmentMatches`, `matchCandidate`,
// `matchOperation` ranking). No `eval`, no `new Function`: the dispatch table is
// data and the matcher is ordinary code, so the consolidated root script stays
// inside the forbidden-construct gate.
const DISPATCHER_RUNTIME: readonly string[] = [
  'function __contractSafeDecodeSegment(segment) {',
  '  var preserved = String(segment).replace(/%2f/gi, "__encoded_slash__");',
  '  try { return decodeURIComponent(preserved).replace(/__encoded_slash__/g, "%2F"); } catch (ignored) { return segment; }',
  '}',
  'function __contractNormalizePath(path) {',
  '  var raw = String(path || "").split(/[?#]/)[0] || "/";',
  '  var withSlash = raw.charAt(0) === "/" ? raw : "/" + raw;',
  '  var normalized = withSlash.replace(/\\/+/g, "/");',
  '  var trimmed = normalized.length > 1 ? normalized.replace(/\\/+$/g, "") : normalized;',
  '  var parts = trimmed.split("/");',
  '  var out = [];',
  '  for (var i = 0; i < parts.length; i += 1) out.push(i === 0 ? "" : __contractSafeDecodeSegment(parts[i]));',
  '  return out.join("/") || "/";',
  '}',
  'function __contractSegments(path) {',
  '  var parts = __contractNormalizePath(path).split("/");',
  '  var out = [];',
  '  for (var i = 0; i < parts.length; i += 1) { if (parts[i]) out.push(parts[i]); }',
  '  return out;',
  '}',
  'function __contractIsTemplateSegment(segment) {',
  '  return /^\\{[^}]+\\}$/.test(segment) || /^:[^/]+$/.test(segment) || /^\\{\\{[^}]+\\}\\}$/.test(segment) || /^<[^>]+>$/.test(segment);',
  '}',
  'function __contractCompoundMatches(candidateSegment, requestSegment) {',
  '  var raw = candidateSegment.split(/(\\{[^}]+\\})/);',
  '  var parts = [];',
  '  for (var p = 0; p < raw.length; p += 1) { if (raw[p].length > 0) parts.push(raw[p]); }',
  '  var pos = 0;',
  '  for (var i = 0; i < parts.length; i += 1) {',
  '    var part = parts[i];',
  '    if (/^\\{[^}]+\\}$/.test(part)) {',
  '      var next = parts[i + 1];',
  '      if (next === undefined) return pos < requestSegment.length && requestSegment.slice(pos).indexOf("/") === -1;',
  '      if (/^\\{[^}]+\\}$/.test(next)) return false;',
  '      var idx = requestSegment.indexOf(next, pos + 1);',
  '      if (idx === -1) return false;',
  '      pos = idx;',
  '    } else if (requestSegment.indexOf(part, pos) === pos) {',
  '      pos += part.length;',
  '    } else {',
  '      return false;',
  '    }',
  '  }',
  '  return pos === requestSegment.length;',
  '}',
  'function __contractMatchCandidate(candidate, request) {',
  '  var candidateSegments = __contractSegments(candidate);',
  '  var requestSegments = __contractSegments(request);',
  '  if (candidateSegments.length !== requestSegments.length) return { matched: false, staticCount: 0, templateCount: 0 };',
  '  var staticCount = 0;',
  '  var templateCount = 0;',
  '  for (var index = 0; index < candidateSegments.length; index += 1) {',
  '    var candidateSegment = candidateSegments[index] === undefined ? "" : candidateSegments[index];',
  '    var requestSegment = requestSegments[index] === undefined ? "" : requestSegments[index];',
  '    if (__contractIsTemplateSegment(candidateSegment) || candidateSegment === "{serverVariable}") { templateCount += 1; continue; }',
  '    if (candidateSegment.indexOf("{") !== -1 && __contractCompoundMatches(candidateSegment, requestSegment)) { templateCount += 1; continue; }',
  '    if (candidateSegment !== requestSegment) return { matched: false, staticCount: 0, templateCount: 0 };',
  '    staticCount += 1;',
  '  }',
  '  return { matched: true, staticCount: staticCount, templateCount: templateCount };',
  '}',
  'function __contractRequestPath() {',
  '  var raw = "";',
  '  try { raw = typeof pm.request.url.getPath === "function" ? String(pm.request.url.getPath() || "") : ""; } catch (ignored) { raw = ""; }',
  '  if (!raw) {',
  '    var path = pm.request.url.path;',
  '    raw = Object.prototype.toString.call(path) === "[object Array]" ? "/" + path.join("/") : String(path || "");',
  '  }',
  '  return raw.replace(/^\\{\\{[^}]+\\}\\}/, "");',
  '}',
  'function __contractRequestName() {',
  '  try { return String(pm.info && pm.info.requestName ? pm.info.requestName : ""); } catch (ignored) { return ""; }',
  '}',
  'function __contractDispatch(routes) {',
  `  if (__contractRequestName() === ${JSON.stringify(CONTRACT_RESOLVER_ITEM_NAME)}) return { skip: true };`,
  '  var method = String(pm.request.method || "").toUpperCase();',
  '  var path = __contractNormalizePath(__contractRequestPath());',
  '  var matches = [];',
  '  for (var i = 0; i < routes.length; i += 1) {',
  '    var route = routes[i];',
  '    if (route[0] !== method) continue;',
  '    var score = __contractMatchCandidate(route[1], path);',
  '    if (!score.matched) continue;',
  '    matches.push({ opKey: route[2], score: [score.staticCount, route[3] ? 2 : 1, -score.templateCount] });',
  '  }',
  '  matches.sort(function (a, b) {',
  '    for (var k = 0; k < a.score.length; k += 1) { var delta = b.score[k] - a.score[k]; if (delta !== 0) return delta; }',
  '    return a.opKey.localeCompare(b.opKey);',
  '  });',
  '  var best = matches[0];',
  '  if (!best) return { method: method, path: path, error: "No OpenAPI operation matched request " + method + " " + path };',
  '  var tied = [];',
  '  for (var t = 0; t < matches.length; t += 1) {',
  '    var entry = matches[t];',
  '    var same = true;',
  '    for (var s = 0; s < entry.score.length; s += 1) { if (entry.score[s] !== best.score[s]) { same = false; break; } }',
  '    if (same && tied.indexOf(entry.opKey) === -1) tied.push(entry.opKey);',
  '  }',
  '  if (tied.length > 1) {',
  '    return { method: method, path: path, error: "Ambiguous OpenAPI operation match for request " + method + " " + path + ": " + tied.join(", ") };',
  '  }',
  '  return { method: method, path: path, opKey: best.opKey };',
  '}'
];

/** Emitted no-eval dispatcher source (matcher port + resolver skip + ranking). */
export function buildDispatcherRuntime(): string[] {
  return [...DISPATCHER_RUNTIME];
}
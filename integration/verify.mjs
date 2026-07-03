#!/usr/bin/env node
/**
 * Master integration gate for the bootstrap action's contract assertions.
 *
 * LIVE lanes (executable pm.test surface): build the instrumented collection
 * from the action's REAL generators (src/), stand up a spec-honoring mock on an
 * ephemeral port, run it through the Postman CLI (postman collection run -- NOT
 * Newman), and assert the runtime pm.tests pass green against the conforming
 * server AND fail against a deliberately non-conforming server (break mode),
 * proving the assertions are non-vacuous.
 *
 * STATIC lanes (generation-time contract surface): build the protocol collection
 * and assert structural invariants of the generated artifact (coverage:
 * one instrumented leaf per generated operation). Used where the emitted item
 * type has no CLI-executable test slot yet, or (AsyncAPI) is generation-time by
 * design.
 *
 *   node integration/verify.mjs                 # everything
 *   node integration/verify.mjs rest graphql    # named live lanes
 *   node integration/verify.mjs --static-only
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOT = dirname(HERE);
const WORK = join(HERE, '.work');
mkdirSync(WORK, { recursive: true });
const ESBUILD = join(BOOT, 'node_modules/.bin/esbuild');

function bundle(srcRel) {
  const src = join(HERE, srcRel);
  const out = join(WORK, srcRel.split('/').pop().replace(/\.mts$/, '.cjs'));
  execFileSync(ESBUILD, [src, '--bundle', '--platform=node', '--target=node24', '--format=cjs',
    '--alias:jsonc-parser=jsonc-parser/lib/esm/main.js', '--outfile=' + out], { cwd: BOOT, stdio: ['ignore', 'ignore', 'ignore'] });
  return out;
}

const LIVE = {
  rest: {
    generator: 'lib/generate-rest.mts',
    genArgs: [join(HERE, 'fixtures/rest/openapi.yaml'), join(WORK, 'rest-collection.json')],
    collection: join(WORK, 'rest-collection.json'),
    mock: join(HERE, 'lib/mock-rest.mjs'),
    argVars: {},
    knownLimited: []
  },
  graphql: {
    generator: 'lib/generate-graphql.mts',
    genArgs: [join(HERE, 'fixtures/graphql/telecom.graphql'), join(WORK, 'gql-collection.json')],
    collection: join(WORK, 'gql-collection.json'),
    mock: join(HERE, 'lib/mock-graphql.mjs'),
    argVars: {
      subscriber_id: 'sub-1',
      lineByMsisdn_msisdn: '+15551230001',
      suspendLine_id: 'line-1',
      lineStatusChanged_subscriberId: 'sub-1',
      provisionLine_input: JSON.stringify({ subscriberId: 'sub-1', planId: 'plan-1', msisdn: '+15551230009' })
    },
    knownLimited: []
  }
};

const STATIC = {
  soap: 'fixtures/soap/stockquote.wsdl',
  grpc: 'fixtures/grpc/routeguide.proto',
  mcp: 'fixtures/mcp/server.json',
  asyncapi: 'fixtures/asyncapi/ws.yaml'
};

function startMock(mockFile, mode) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [mockFile, mode], { cwd: BOOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const to = setTimeout(() => { child.kill(); reject(new Error('mock start timeout: ' + buf)); }, 6000);
    child.stdout.on('data', (d) => { buf += d; const m = buf.match(/READY (\d+)/); if (m) { clearTimeout(to); resolve({ child, port: Number(m[1]) }); } });
    child.stderr.on('data', (d) => process.stderr.write('[mock] ' + d));
  });
}
function runCli(lane, name, port, mode) {
  const values = [{ key: 'baseUrl', value: 'http://127.0.0.1:' + port, enabled: true, type: 'default' }];
  for (const [k, v] of Object.entries(lane.argVars)) values.push({ key: k, value: v, enabled: true, type: 'default' });
  const envPath = join(WORK, 'env-' + name + '-' + mode + '.json');
  const reportPath = join(WORK, 'report-' + name + '-' + mode + '.json');
  writeFileSync(envPath, JSON.stringify({ id: 'itg', name: 'itg', values }));
  try {
    execFileSync('postman', ['collection', 'run', lane.collection, '-e', envPath, '-r', 'json',
      '--reporter-json-export', reportPath, '--suppress-exit-code', '--timeout-request', '8000'],
      { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] });
  } catch { /* suppress-exit-code guards this */ }
  return JSON.parse(readFileSync(reportPath, 'utf8'));
}
function summarize(report) {
  const s = report?.run?.summary?.tests ?? {};
  const failing = new Set();
  for (const ex of (report?.run?.executions ?? [])) {
    const name = ex.requestExecuted?.name ?? '?';
    for (const t of (ex.tests ?? [])) if (t.error || t.status === 'failed') failing.add(name);
  }
  return { passed: s.passed ?? 0, failed: s.failed ?? 0, executed: s.executed ?? 0, failing: [...failing] };
}

async function runLive(name) {
  const lane = LIVE[name];
  process.stdout.write('\n=== LIVE ' + name + ' ===\n');
  bundle(lane.generator);
  execFileSync('node', [join(WORK, lane.generator.split('/').pop().replace(/\.mts$/, '.cjs')), ...lane.genArgs], { cwd: BOOT, stdio: ['ignore', 'ignore', 'ignore'] });

  const cm = await startMock(lane.mock, 'conform');
  let conform; try { conform = summarize(runCli(lane, name, cm.port, 'conform')); } finally { cm.child.kill(); }
  const unexpected = conform.failing.filter((i) => !lane.knownLimited.includes(i));
  const conformOk = unexpected.length === 0;
  process.stdout.write('  conform: passed=' + conform.passed + ' failed=' + conform.failed +
    (lane.knownLimited.length ? ' (known-limited: ' + lane.knownLimited.join(', ') + ')' : '') +
    (conformOk ? '  OK' : '  UNEXPECTED FAILURES: ' + unexpected.join(', ')) + '\n');

  const bm = await startMock(lane.mock, 'break');
  let broke; try { broke = summarize(runCli(lane, name, bm.port, 'break')); } finally { bm.child.kill(); }
  const breakOk = broke.failed > conform.failed;
  process.stdout.write('  break:   passed=' + broke.passed + ' failed=' + broke.failed +
    (breakOk ? '  OK (violations detected)' : '  BROKEN CONTRACT NOT DETECTED') + '\n');
  return conformOk && breakOk;
}

function runStatic(cjs, name, fixture) {
  try { execFileSync('node', [cjs, name, join(HERE, fixture)], { cwd: BOOT, stdio: ['ignore', 'inherit', 'inherit'] }); return true; }
  catch { return false; }
}

const argv = process.argv.slice(2);
const staticOnly = argv.includes('--static-only');
const liveOnly = argv.includes('--live-only');
const named = argv.filter((a) => !a.startsWith('--'));
let ok = true;

if (!staticOnly) {
  const liveNames = named.length ? named.filter((n) => LIVE[n]) : Object.keys(LIVE);
  for (const n of liveNames) { try { ok = (await runLive(n)) && ok; } catch (e) { process.stderr.write('live ' + n + ' errored: ' + (e?.stack || e) + '\n'); ok = false; } }
}
if (!liveOnly && !named.length || staticOnly) {
  process.stdout.write('\n=== STATIC (generation-time contract artifacts) ===\n');
  const cjs = bundle('lib/check-static.mts');
  for (const [n, fx] of Object.entries(STATIC)) ok = runStatic(cjs, n, fx) && ok;
}

process.stdout.write('\n' + (ok ? 'INTEGRATION PASS' : 'INTEGRATION FAIL') + '\n');
process.exit(ok ? 0 : 1);

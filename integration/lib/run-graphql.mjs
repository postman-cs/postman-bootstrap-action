import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
const HERE = new URL('.', import.meta.url).pathname;
const WORK = new URL('../.work/', import.meta.url).pathname;
const COLL = WORK + 'gql-collection.json';
const ARG_VARS = {
  subscriber_id: 'sub-1',
  lineByMsisdn_msisdn: '+15551230001',
  suspendLine_id: 'line-1',
  lineStatusChanged_subscriberId: 'sub-1',
  provisionLine_input: JSON.stringify({ subscriberId: 'sub-1', planId: 'plan-1', msisdn: '+15551230009' })
};
function startMock(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [HERE + 'mock-graphql.mjs', mode], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    let buf = '';
    const to = setTimeout(() => reject(new Error('mock start timeout: ' + buf)), 5000);
    child.stdout.on('data', (d) => { buf += d; const m = buf.match(/READY (\d+)/); if (m) { clearTimeout(to); resolve({ child, port: Number(m[1]) }); } });
    child.stderr.on('data', (d) => process.stderr.write('[mock] ' + d));
  });
}
function runCli(port, label) {
  const values = [{ key: 'baseUrl', value: 'http://127.0.0.1:' + port, enabled: true, type: 'default' }];
  for (const [k, v] of Object.entries(ARG_VARS)) values.push({ key: k, value: v, enabled: true, type: 'default' });
  const env = { id: 'itg', name: 'itg', values };
  const envPath = WORK + 'env-gql-' + label + '.json';
  const reportPath = WORK + 'report-gql-' + label + '.json';
  writeFileSync(envPath, JSON.stringify(env));
  try { execFileSync('postman', ['collection', 'run', COLL, '-e', envPath, '-r', 'json', '--reporter-json-export', reportPath, '--suppress-exit-code', '--timeout-request', '8000'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch { /* */ }
  try { return JSON.parse(readFileSync(reportPath, 'utf8')); } catch { return null; }
}
const mode = process.argv[2] || 'conform';
const { child, port } = await startMock(mode);
let report;
try { report = runCli(port, mode); } finally { child.kill(); }
const exs = report?.run?.executions ?? [];
const s = report?.run?.summary?.tests ?? {};
console.log('=== GQL MODE ' + mode + ' ===');
console.log('tests passed=' + s.passed + ' failed=' + s.failed + ' executed=' + s.executed);
const fails = [];
for (const ex of exs) {
  const name = ex.requestExecuted?.name ?? '?';
  for (const t of (ex.tests ?? [])) if (t.error || t.status === 'failed') fails.push(name + ' :: ' + t.name + ' :: ' + ((t.error?.message ?? t.error ?? '') + '').slice(0,180));
  for (const e of (ex.errors ?? [])) console.log('  [reqerror ' + name + '] ' + (e.message || e.code));
}
if (!fails.length) console.log('ALL GREEN'); else fails.forEach((f) => console.log('  FAIL ' + f));

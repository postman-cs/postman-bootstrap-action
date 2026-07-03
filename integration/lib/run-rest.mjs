import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';

const HERE = new URL('.', import.meta.url).pathname;
const WORK = new URL('../.work/', import.meta.url).pathname;
const COLL = WORK + 'rest-collection.json';

function startMock(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [HERE + 'mock-rest.mjs', mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const to = setTimeout(() => reject(new Error('mock start timeout')), 5000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/READY (\d+)/);
      if (m) { clearTimeout(to); resolve({ child, port: Number(m[1]) }); }
    });
    child.stderr.on('data', (d) => process.stderr.write('[mock] ' + d));
  });
}

function runCli(port, label) {
  const env = { id: 'itg-env', name: 'itg', values: [{ key: 'baseUrl', value: 'http://127.0.0.1:' + port, enabled: true, type: 'default' }] };
  const envPath = WORK + 'env-' + label + '.json';
  const reportPath = WORK + 'report-' + label + '.json';
  writeFileSync(envPath, JSON.stringify(env));
  let cliOut;
  try {
    cliOut = execFileSync('postman', ['collection', 'run', COLL, '-e', envPath, '-r', 'json', '--reporter-json-export', reportPath, '--suppress-exit-code', '--timeout-request', '8000'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { cliOut = String(e.stdout || '') + String(e.stderr || e.message); }
  let report = null;
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { /* */ }
  return { cliOut, report };
}

function summarize(mode, report) {
  const exs = report?.run?.executions ?? [];
  const s = report?.run?.summary?.tests ?? {};
  const fails = [];
  const reqErrors = [];
  for (const ex of exs) {
    const name = ex.requestExecuted?.name ?? ex.item?.name ?? '?';
    for (const t of (ex.tests ?? [])) {
      if (t.error || t.status === 'failed' || t.result === 'fail') fails.push({ req: name, test: t.name, err: (t.error?.message ?? t.error ?? '').toString().slice(0,300) });
    }
    for (const e of (ex.errors ?? [])) reqErrors.push(name + ':' + (e.message||e.code));
  }
  return { summary: s, fails, reqErrors };
}

const mode = process.argv[2] || 'conform';
const { child, port } = await startMock(mode);
let out;
try {
  const { report } = runCli(port, mode);
  out = summarize(mode, report);
} finally {
  child.kill();
}

console.log('=== MODE ' + mode + ' ===');
console.log('tests passed=' + out.summary.passed + ' failed=' + out.summary.failed + ' executed=' + out.summary.executed);
if (out.reqErrors.length) console.log('reqErrors: ' + out.reqErrors.join(' | '));
if (!out.fails.length) console.log('ALL GREEN');
else for (const f of out.fails) console.log('  FAIL [' + f.req + '] ' + f.test + '  :: ' + f.err);

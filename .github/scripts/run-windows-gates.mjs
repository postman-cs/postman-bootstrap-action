#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

const gateJson = readOption('--gate-json');
const maxParallelGates = Number.parseInt(readOption('--max-parallel-gates', '2'), 10);
const gateTimeoutSeconds = Number.parseInt(readOption('--gate-timeout-seconds', '900'), 10);

if (!gateJson) throw new Error('--gate-json is required');
if (!Number.isInteger(maxParallelGates) || maxParallelGates < 1 || maxParallelGates > 2) {
  throw new Error('--max-parallel-gates must be 1 or 2');
}
if (!Number.isInteger(gateTimeoutSeconds) || gateTimeoutSeconds < 1) {
  throw new Error('--gate-timeout-seconds must be a positive integer');
}

const definitions = JSON.parse(gateJson);
if (!Array.isArray(definitions)) throw new Error('--gate-json must contain an array');

const gates = definitions.map((definition) => {
  const parts = definition.split('|||');
  if (parts.length < 3 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid gate definition: ${definition}`);
  }
  return { name: parts[0], command: parts[1], args: parts.slice(2) };
});

if (new Set(gates.map(({ name }) => name)).size !== gates.length) {
  throw new Error('Gate names must be unique');
}

function killProcessTree(child) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
}

function runGate(gate) {
  return new Promise((resolve) => {
    const child = spawn(gate.command, gate.args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, gateTimeoutSeconds * 1_000);

    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) stderr += `${error.message}\n`;
      if (timedOut) stderr += `gate:${gate.name} timed out after ${gateTimeoutSeconds} seconds\n`;
      resolve({ name: gate.name, code: timedOut ? 1 : (code ?? 1), stdout, stderr });
    };

    child.once('error', (error) => finish(1, error));
    child.once('close', (code) => finish(code));
  });
}

const results = new Array(gates.length);
let nextGate = 0;
async function worker() {
  while (nextGate < gates.length) {
    const index = nextGate++;
    results[index] = await runGate(gates[index]);
  }
}

await Promise.all(Array.from({ length: Math.min(maxParallelGates, gates.length) }, () => worker()));

let failed = false;
for (const result of results) {
  process.stdout.write(`::group::${result.name}\n`);
  process.stdout.write(result.stdout);
  process.stdout.write(result.stderr);
  process.stdout.write('::endgroup::\n');
  if (result.code === 0) {
    process.stdout.write(`gate:${result.name}=pass\n`);
  } else {
    process.stdout.write(`gate:${result.name}=fail\n`);
    failed = true;
  }
}

if (failed) process.exitCode = 1;

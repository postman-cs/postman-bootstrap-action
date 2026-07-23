import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_CHARS = 4_096;
const MAX_OBSERVED = 32;

function appendCapped(current, chunk, max) {
  if (current.length >= max) return current;
  const next = current + chunk;
  return next.length > max ? next.slice(0, max) : next;
}

function formatObserved(observed) {
  if (observed.length === 0) return 'none';
  const listed = observed.join(', ');
  return observed.length >= MAX_OBSERVED ? `${listed}, …` : listed;
}

/**
 * Start a loopback HTTP proxy, spawn `binary` with hermetic env, and resolve only
 * when an exact CONNECT authority match for `expectedAuthority` is observed.
 *
 * @param {string} binary
 * @param {string} expectedAuthority host:port
 * @param {string[]} [binaryArgs]
 * @param {{ timeoutMs?: number }} [options]
 */
export async function assertSeaProxyRouting(binary, expectedAuthority, binaryArgs = [], options = {}) {
  if (!binary || !expectedAuthority) {
    throw new Error('usage: node scripts/assert-sea-proxy.mjs <binary> <host:port> [binary args...]');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const observed = [];
  let child;
  let stdout = '';
  let stderr = '';
  let childExited = false;
  let childExitError;

  await new Promise((resolvePromise, reject) => {
    let settled = false;
    const server = createServer((_request, response) => {
      response.writeHead(502);
      response.end();
    });
    const timer = setTimeout(() => {
      // If the child already exited, yield to the more specific exit error
      // rather than masking it with the generic "did not proxy" timeout.
      if (childExited) {
        fail(childExitError ?? new Error(`SEA did not proxy ${expectedAuthority}; observed: ${formatObserved(observed)}\n${stdout}${stderr}`));
        return;
      }
      fail(
        new Error(
          `SEA did not proxy ${expectedAuthority}; observed: ${formatObserved(observed)}\n${stdout}${stderr}`
        )
      );
    }, timeoutMs);

    function close(callback) {
      clearTimeout(timer);
      child?.kill('SIGKILL');
      server.close(callback);
    }

    function pass() {
      if (settled) return;
      settled = true;
      close(resolvePromise);
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      close(() => reject(error instanceof Error ? error : new Error(String(error))));
    }

    server.on('connect', (request, socket) => {
      const authority = request.url ?? '';
      if (observed.length < MAX_OBSERVED) observed.push(authority);
      socket.on('error', () => undefined);
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      if (authority === expectedAuthority) pass();
    });
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        fail(new Error('proxy smoke server did not expose a TCP port'));
        return;
      }

      const proxy = `http://127.0.0.1:${address.port}`;
      child = spawn(binary, binaryArgs, {
        env: {
          PATH: '/nonexistent',
          HOME: process.env.RUNNER_TEMP ?? '/tmp',
          TMPDIR: process.env.RUNNER_TEMP ?? '/tmp',
          NODE_USE_ENV_PROXY: '1',
          HTTP_PROXY: proxy,
          HTTPS_PROXY: proxy,
          POSTMAN_ACTIONS_TELEMETRY: 'off'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout = appendCapped(stdout, chunk, MAX_OUTPUT_CHARS);
      });
      child.stderr.on('data', (chunk) => {
        stderr = appendCapped(stderr, chunk, MAX_OUTPUT_CHARS);
      });
      child.on('error', fail);
      child.on('exit', (code, signal) => {
        childExited = true;
        childExitError = new Error(
          `SEA exited before proxying ${expectedAuthority} (code=${code}, signal=${signal}); observed: ${formatObserved(observed)}\n${stdout}${stderr}`
        );
        if (settled) return;
        fail(childExitError);
      });
    });
  });
}

const isCli =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isCli) {
  const [binary, expectedAuthority, ...binaryArgs] = process.argv.slice(2);
  await assertSeaProxyRouting(binary, expectedAuthority, binaryArgs);
  console.log(`SEA proxy routing verified: ${expectedAuthority}`);
}

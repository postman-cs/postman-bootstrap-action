import http from 'node:http';
import { buildSchema, graphql, subscribe, parse } from 'graphql';
import { readFileSync } from 'node:fs';

const MODE = process.argv[2] || 'conform';
const SDL = readFileSync(new URL('../fixtures/graphql/telecom.graphql', import.meta.url), 'utf8');
const schema = buildSchema(SDL);

function plan(over = {}) { return { id: 'plan-1', name: 'Unlimited', monthlyPriceCents: 4500, dataCapGb: 100, ...over }; }
function line(over = {}) { return { id: 'line-1', msisdn: '+15551230001', status: 'ACTIVE', activatedAt: '2026-01-01T00:00:00Z', plan: plan(), ...over }; }
function subscriber(id, over = {}) { return { id: id || 'sub-1', displayName: 'Ada Lovelace', email: 'ada@example.com', lines: [line()], ...over }; }

function root(mode) {
  const bad = mode === 'break';
  return {
    subscriber: ({ id }) => subscriber(id),
    subscribers: () => [subscriber('sub-1'), subscriber('sub-2')],
    plans: () => bad ? [plan({ monthlyPriceCents: 'free' })] : [plan(), plan({ id: 'plan-2', name: 'Basic', dataCapGb: null })],
    lineByMsisdn: ({ msisdn }) => line({ msisdn }),
    provisionLine: ({ input }) => line({ id: 'line-new', msisdn: input.msisdn, plan: plan({ id: input.planId }) }),
    suspendLine: ({ id }) => bad ? line({ id, status: 'BOGUS_STATUS' }) : line({ id, status: 'SUSPENDED' }),
    // subscription source: yield one event then complete
    lineStatusChanged: async function* ({ subscriberId }) {
      yield { lineStatusChanged: bad ? line({ status: 'BOGUS_STATUS' }) : line({ id: 'line-' + subscriberId, status: 'PORTING' }) };
    }
  };
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end(JSON.stringify({ errors: [{ message: 'method not allowed' }] })); }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    let payload;
    try { payload = JSON.parse(body || '{}'); } catch { res.writeHead(400, { 'Content-Type': 'application/graphql-response+json' }); return res.end(JSON.stringify({ errors: [{ message: 'invalid JSON' }] })); }
    const { query, variables, operationName } = payload;
    if (typeof query !== 'string' || !query.trim()) { res.writeHead(400, { 'Content-Type': 'application/graphql-response+json' }); return res.end(JSON.stringify({ errors: [{ message: 'missing query' }] })); }
    if (process.env.GQL_DEBUG) process.stderr.write('RECV ' + (operationName||'?') + ' vars=' + JSON.stringify(variables) + '\n');
    const isSub = /^\s*subscription\b/.test(query.replace(/^[\uFEFF\s]+/, ''));
    let result;
    try {
      if (isSub) {
        const iter = await subscribe({ schema, document: parse(query), rootValue: root(MODE), variableValues: variables });
        if (Symbol.asyncIterator in Object(iter)) { const first = await iter[Symbol.asyncIterator]().next(); result = first.value; }
        else result = iter; // request error (validation): ExecutionResult with errors, no data
      } else {
        result = await graphql({ schema, source: query, rootValue: root(MODE), variableValues: variables, operationName });
      }
    } catch (e) { result = { errors: [{ message: String(e && e.message || e) }] }; }
    // GraphQL-over-HTTP 6.4.2: request error (no data key) -> 4xx; execution result (data key present) -> 200
    const status = result && Object.prototype.hasOwnProperty.call(result, 'data') ? 200 : 400;
    res.writeHead(status, { 'Content-Type': 'application/graphql-response+json' });
    res.end(JSON.stringify(result));
  });
});
server.listen(0, '127.0.0.1', () => process.stdout.write('READY ' + server.address().port + '\n'));

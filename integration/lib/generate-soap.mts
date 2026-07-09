// WSDL -> instrumented v3/EC SOAP collection, via the action's REAL production
// path (parseWsdl + buildSoapCollection + instrumentSoapCollection +
// convertV2CollectionToEc), the same dispatch the bootstrap runs for a SOAP
// spec. esbuild resolves the `.js` import specifiers to their `.ts` sources.
//
// Writes the bare runtime-EC collection ({type:'collection',children}) that the
// Postman CLI executes. The lane runner rewrites the http-request leaf urls to
// the ephemeral mock before the run (the WSDL pins an example.com endpoint; the
// live lane points every leaf at 127.0.0.1 exactly as env baseUrl does for REST).
import { readFileSync, writeFileSync } from 'node:fs';
import { buildProtocolCollection } from '../../src/lib/protocols/dispatch.js';

const specPath = process.argv[2];
const outPath = process.argv[3];

(async () => {
  const r = await buildProtocolCollection('soap', readFileSync(specPath, 'utf8'), {});
  writeFileSync(outPath, JSON.stringify(r.collection, null, 2));
  console.error('[generate-soap] format=' + r.format + ' runnableInCi=' + r.runnableInCi + ' ops=' + r.operationCount + ' warnings=' + (r.warnings?.length ?? 0));
  if (r.warnings?.length) console.error(r.warnings.map((w) => '  ! ' + w).join('\n'));
})();

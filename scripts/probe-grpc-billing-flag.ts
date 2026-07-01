
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';

const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;
const FLAGS = ['grpc_protocol_execution_allowed', 'graphql_v2_protocol_execution_allowed'];

function snip(v){ const t = typeof v==='string'?v:JSON.stringify(v); return String(t??'').slice(0,900).replace(/\s+/g,' '); }

async function main(){
  const apiKey = process.env.PROBE_KEY || '';
  const label = process.env.PROBE_LABEL || '?';
  if(!apiKey){ console.log('[skip] no PROBE_KEY'); return; }
  const provider = new AccessTokenProvider({ apiKey, apiBaseUrl: API });
  await provider.refresh();
  const token = provider.current();

  // iapub session identity
  const sess = await fetch('https://iapub.postman.co/api/sessions/current', { headers: { 'x-access-token': token } });
  const sBody = await sess.text().catch(()=> '');
  let userId='', teamId='';
  try { const j = JSON.parse(sBody); const s = j.session ?? j; const id = s.identity ?? {}; userId = String(id.user ?? s?.data?.user?.id ?? ''); teamId = String(id.team ?? ''); } catch { /* non-JSON session body */ }
  console.log('== ' + label + ' == iapub[' + sess.status + '] userId=' + userId + ' teamId=' + teamId);

  const gw = new AccessTokenGatewayClient({ tokenProvider: provider });
  if (teamId) gw.configureTeamContext(teamId, label.includes('org'));

  const attempts = [
    { name: 'gw features user',  service: 'features', method: 'post', path: '/features/list?entityType=user&entityValue=' + userId, body: { features: FLAGS } },
    { name: 'gw features team',  service: 'features', method: 'post', path: '/features/list?entityType=team&entityValue=' + teamId, body: { features: FLAGS } },
  ];
  for (const a of attempts) {
    try {
      const res = await gw.request({ service: a.service, method: a.method, path: a.path, body: a.body });
      const b = await res.text().catch(()=> '');
      console.log('  [' + res.status + '] ' + a.name + ' :: ' + snip(b));
    } catch(e) { console.log('  [ERR] ' + a.name + ' :: ' + snip(e && e.message || String(e))); }
  }

  // direct REST fallbacks to the features host
  for (const host of ['https://features.postman.com','https://features.gw.postman.com']) {
    for (const [et,ev] of [['user',userId],['team',teamId]]) {
      if(!ev) continue;
      try {
        const res = await fetch(host + '/features/list?entityType=' + et + '&entityValue=' + ev, { method:'POST', headers:{'Content-Type':'application/json','x-access-token':token}, body: JSON.stringify({ features: FLAGS }) });
        const b = await res.text().catch(()=> '');
        console.log('  [' + res.status + '] direct ' + host + ' ' + et + ' :: ' + snip(b));
      } catch(e){ console.log('  [ERR] direct ' + host + ' ' + et + ' :: ' + snip(e && e.message || String(e))); }
    }
  }
}
main().catch(e=>{ console.error(e); process.exit(1); });


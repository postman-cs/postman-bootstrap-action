import http from 'node:http';

const MODE = process.argv[2] || 'conform';

function handler(mode) {
  return (req, res) => {
    const u = new URL(req.url, 'http://x');
    const seg = u.pathname.split('/').filter(Boolean);
    const send = (code, ct, obj, extra = {}) => {
      res.writeHead(code, { 'Content-Type': ct, ...extra });
      res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
    };
    const widget = (id) => ({ id, name: 'alpha', tag: 'blue' });
    if (seg[0] === 'widgets' && seg.length === 1) {
      if (req.method === 'GET') {
        if (mode === 'break') return send(200, 'application/json', { items: [{ id: 'not-an-int', tag: 'blue' }] });
        return send(200, 'application/json', { items: [widget(1), widget(2)] });
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          if (mode === 'break') return send(200, 'text/plain', 'created');
          return send(201, 'application/json', widget(2));
        });
        return;
      }
    }
    if (seg[0] === 'widgets' && seg.length === 2) {
      if (req.method === 'GET') {
        if (mode === 'break') return send(200, 'application/json', { id: 1 });
        return send(200, 'application/json', widget(Number(seg[1]) || 1));
      }
    }
    send(404, 'application/json', { code: 404, message: 'not found' });
  };
}

const server = http.createServer(handler(MODE));
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('READY ' + server.address().port + '\n');
});

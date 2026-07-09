// Spec-honoring SOAP 1.1 mock for the live SOAP lane. `conform` returns
// WSDL-honoring response envelopes; `break` returns the wrong response element
// so the generated expectedResponseElement / soap:Body direct-child assertions
// fire. Runs in its own process (execFileSync blocks the event loop, so an
// in-process server would never accept the CLI's connections) and prints
// `READY <port>` once bound, exactly like the REST/GraphQL mocks.
import http from 'node:http';

const MODE = process.argv[2] || 'conform';
const NS = 'http://example.com/stockquote';

function envelope(op, mode) {
  if (op === 'GetStockPrice') {
    const el = mode === 'break' ? 'WrongResponse' : 'GetStockPriceResponse';
    return `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${el} xmlns="${NS}"><price>42.5</price></${el}></soap:Body></soap:Envelope>`;
  }
  const el = mode === 'break' ? 'WrongResponse' : 'ListSymbolsResponse';
  return `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${el} xmlns="${NS}"><symbol>AAA</symbol><symbol>BBB</symbol></${el}></soap:Body></soap:Envelope>`;
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const action = (req.headers['soapaction'] || '').replace(/"/g, '');
    const op = /GetStockPrice/.test(action) || /GetStockPrice/.test(raw) ? 'GetStockPrice' : 'ListSymbols';
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=UTF-8' });
    res.end(envelope(op, MODE));
  });
});
server.listen(0, '127.0.0.1', () => process.stdout.write('READY ' + server.address().port + '\n'));

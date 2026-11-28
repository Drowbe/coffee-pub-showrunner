'use strict';
// Spike: serves sync.html on a port, optionally with a security policy that blocks worklets from blob: and data: addresses, so the
// sound copy's fallback can be tried: node scripts/spike/serve.js <port> [csp]. Reach it as http://localhost:<port> (a secure page)
// or through the computer's network address (an insecure page: no audio worklets at all).
const http = require('http');
const fs = require('fs');
const path = require('path');

const [port, mode] = [Number(process.argv[2] || 8099), process.argv[3] || ''];
http.createServer((req, res) => {
  const headers = { 'Content-Type': 'text/html' };
  if (mode === 'csp') headers['Content-Security-Policy'] = "default-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'";
  res.writeHead(200, headers);
  res.end(fs.readFileSync(path.join(__dirname, 'sync.html')));
}).listen(port, '0.0.0.0', () => console.log(`serving on ${port} ${mode}`));

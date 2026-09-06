/* Local dev server. Serves public/ and routes /api/* to the same handlers
 * Vercel will use in production, so what you test here is what deploys.
 *
 *   DATABASE_URL=postgres://... node server.js
 *   (no DATABASE_URL = in-memory, wiped on restart — fine for a quick play)
 */
'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROUTES = {
  '/api/room':       require('./api/room.js'),
  '/api/claim':      require('./api/claim.js'),
  '/api/peek':       require('./api/peek.js'),
  '/api/ready':      require('./api/ready.js'),
  '/api/state':      require('./api/state.js'),
  '/api/move':       require('./api/move.js'),
  '/api/next-round': require('./api/next-round.js'),
  '/api/replay':     require('./api/replay.js'),
  '/api/season':     require('./api/season.js'),
  '/api/recap':      require('./api/recap.js'),
  '/api/skip':       require('./api/skip.js'),
  '/api/seat-request': require('./api/seat-request.js'),
  '/api/seat-decide':  require('./api/seat-decide.js'),
  '/api/phone':      require('./api/phone.js')
};

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
               '.css':'text/css; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml' };

const PORT = Number(process.env.PORT || 3000);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (ROUTES[p]) return ROUTES[p](req, res);

  // /g/CODE is the room link everyone gets in WhatsApp — same page
  let file = p === '/' || p.startsWith('/g/') ? '/index.html' : p;
  const full = path.join(__dirname, 'public', file);
  if (!full.startsWith(path.join(__dirname, 'public'))) { res.statusCode = 403; return res.end('no'); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('Content-Type', MIME[path.extname(full)] || 'application/octet-stream');
    res.end(buf);
  });
}).listen(PORT, () => {
  console.log('The Bee\'s House on http://localhost:' + PORT);
  console.log('storage:', process.env.DATABASE_URL ? 'postgres' : 'in-memory (restart wipes it)');
});

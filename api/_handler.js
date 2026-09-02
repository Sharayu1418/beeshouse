/* Shared plumbing for the API routes. Vercel gives each file in api/ a
 * (req,res) handler; this wraps one service call in JSON + error mapping
 * so the route files stay three lines long. */
'use strict';
const { makeDb } = require('../lib/db.js');
const { makeService } = require('../lib/service.js');

let _db = null, _svc = null;
function svc() {
  if (!_svc) { _db = makeDb({}); _svc = makeService(_db); }
  return _svc;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}

function route(fn) {
  return async function (req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const body = req.method === 'GET' ? {} : await readBody(req);
      const url = new URL(req.url, 'http://x');
      const query = Object.fromEntries(url.searchParams);
      const out = await fn({ body, query, req, svc: svc() });
      res.statusCode = 200;
      res.end(JSON.stringify(out == null ? {} : out));
    } catch (e) {
      const status = e.status || 500;
      res.statusCode = status;
      if (status >= 500) console.error(e);
      res.end(JSON.stringify({ error: e.message || 'Something went wrong.', version: e.version }));
    }
  };
}

module.exports = { route, svc, readBody };

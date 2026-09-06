'use strict';
const { route } = require('./_handler.js');
/* POST /api/skip  { code, token }
   Somebody else has been sitting on the game for two days. Anyone but them
   can move it on. The service decides whether that is true; this file only
   carries the request. */
module.exports = route(async ({ body, svc }) => await svc.skipTurn(body.code, body.token));

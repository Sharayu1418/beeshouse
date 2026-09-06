'use strict';
const { route } = require('./_handler.js');
/* POST /api/seat-decide  { code, token, requestId, approve }
   Anybody in the room except the person whose seat it is. */
module.exports = route(async ({ body, svc }) =>
  await svc.decideSeat(body.code, body.token, body.requestId, body.approve !== false));

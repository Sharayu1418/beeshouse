'use strict';
const { route } = require('./_handler.js');
/* POST /api/move {code, token, move, expectedVersion} -> {view, reveal} */
module.exports = route(async ({ body, svc }) =>
  await svc.applyMove(body.code, body.token, body.move, body.expectedVersion));

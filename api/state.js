'use strict';
const { route } = require('./_handler.js');
/* GET /api/state?code=..&token=..  -> your redacted view. Never a reveal. */
module.exports = route(async ({ query, svc }) =>
  await svc.getState(query.code, query.token));

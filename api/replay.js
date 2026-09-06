'use strict';
const { route } = require('./_handler.js');
/* GET /api/replay?code=..&token=..&round=N -> everything that happened,
   but only for a round that has finished. */
module.exports = route(async ({ query, svc }) =>
  await svc.replay(query.code, query.token, query.round));

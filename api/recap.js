'use strict';
const { route } = require('./_handler.js');
/* GET /api/recap?code=..&token=..  -> what actually happened, once the match is over */
module.exports = route(async ({ query, svc }) => await svc.matchRecap(query.code, query.token));

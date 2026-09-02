'use strict';
const { route } = require('./_handler.js');
/* POST /api/peek {code, token, indices:[a,b]} -> your two cards, once */
module.exports = route(async ({ body, svc }) =>
  await svc.peek(body.code, body.token, body.indices));

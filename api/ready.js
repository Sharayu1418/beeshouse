'use strict';
const { route } = require('./_handler.js');
/* POST /api/ready  { code, token }
   You have looked as long as you want to. The round starts when everybody
   has said this. */
module.exports = route(async ({ body, svc }) => await svc.ready(body.code, body.token));

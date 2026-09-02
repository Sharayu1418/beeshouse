'use strict';
const { route } = require('./_handler.js');
module.exports = route(async ({ body, svc }) => await svc.nextRound(body.code, body.token));

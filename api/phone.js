'use strict';
const { route } = require('./_handler.js');
module.exports = route(async ({ body, svc }) =>
  await svc.setPhone(body.code, Number(body.seat), body.phone));

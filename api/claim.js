'use strict';
const { route } = require('./_handler.js');
/* POST /api/claim {code, seat, token?} -> mints this device's token, once */
module.exports = route(async ({ body, svc }) =>
  await svc.claimSeat(body.code, Number(body.seat), body.token));

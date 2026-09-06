'use strict';
const { route } = require('./_handler.js');
/* POST /api/seat-request  { code, seat }
   A new device asking for a seat somebody is already sitting in. It gets a
   token back, but that token does nothing until another player approves. */
module.exports = route(async ({ body, svc }) => await svc.requestSeat(body.code, body.seat));

'use strict';
const { route } = require('./_handler.js');
/* POST /api/next-match  { code, token }
   Deal the next match of the season this room belongs to. Safe to press on
   five phones at once: whoever is second lands in the room the first one
   dealt rather than dealing a second one. */
module.exports = route(async ({ body, svc }) => await svc.nextMatch(body.code, body.token));

'use strict';
const { route } = require('./_handler.js');
/* POST /api/room                  -> create a room
   GET  /api/room?code=AB12        -> who is in it, which seats are free */
module.exports = route(async ({ req, body, query, svc }) => {
  if (req.method === 'GET') return await svc.roomInfo(query.code);
  return await svc.createRoom({ players: body.players, turnClockHours: body.turnClockHours });
});

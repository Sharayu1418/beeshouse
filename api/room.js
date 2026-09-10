'use strict';
const { route } = require('./_handler.js');
/* POST /api/room                  -> open the room. If a game is already
                                      running you are taken to that one, with
                                      existing:true, rather than a second room
                                      being dealt behind the first.
   GET  /api/room?code=AB12        -> who is in it, which seats are free */
module.exports = route(async ({ req, body, query, svc }) => {
  if (req.method === 'GET') return await svc.roomInfo(query.code);
  return await svc.openRoom({ players: body.players, turnClockHours: body.turnClockHours,
                              seasonCode: body.seasonCode });
});

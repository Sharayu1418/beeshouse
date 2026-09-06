'use strict';
const { route } = require('./_handler.js');
/* POST /api/season          -> start a season
   GET  /api/season?code=..  -> standings across every match in it */
module.exports = route(async ({ req, body, query, svc }) => {
  if (req.method === 'GET') return await svc.seasonStandings(query.code);
  return await svc.createSeason({ name: body.name, matchTarget: body.matchTarget });
});

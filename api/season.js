'use strict';
const { route } = require('./_handler.js');
/* POST /api/season          -> start a season, or turn a finished match into
                                match 1 of one ({fromCode, token})
   GET  /api/season?code=..  -> standings, superlatives, and once it is over,
                                the settlement. `code` may be the season's own
                                code or that of any room inside it. */
module.exports = route(async ({ req, body, query, svc }) => {
  if (req.method === 'GET') return await svc.seasonStandings(query.code);
  return await svc.createSeason({ name: body.name, matchTarget: body.matchTarget,
                                  fromCode: body.fromCode, token: body.token });
});

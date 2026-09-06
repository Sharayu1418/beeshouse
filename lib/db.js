/* The Bee's House — storage adapter.
 *
 * Two implementations behind one interface:
 *
 *   memory  — used by the test suite. No setup, no network, instant.
 *   pg      — used in production. A plain Postgres connection string, so
 *             the identical code path runs against Supabase and against a
 *             local Postgres. No vendor SDK, nothing to mock.
 *
 * Everything here runs server-side only. If this file is ever imported by
 * the browser, something has gone badly wrong.
 */
'use strict';

var crypto = require('crypto');

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}
/* Room codes: no vowels (so no accidental words), no 0/O/1/I. */
var CODE_ALPHABET = '23456789BCDFGHJKLMNPQRSTVWXYZ';
function newCode(len) {
  var out = '';
  for (var i = 0; i < (len || 4); i++) {
    out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

/* =======================================================================
   memory
   ======================================================================= */
function memoryDb() {
  var games = new Map();      // id -> game
  var byCode = new Map();     // code -> id
  var players = [];           // rows
  var rounds = new Map();     // gameId+':'+n -> {state, version, updatedAt}
  var moves = [];
  var seasons = new Map();     // id -> season
  var seasonByCode = new Map();
  var scores = [];             // {game_id, player_id, round_n, score}
  var seq = 0;

  function uuid() { return crypto.randomUUID(); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  return {
    kind: 'memory',
    async init() {},
    async close() {},

    async createGame(g) {
      var row = { id: uuid(), code: g.code, host_player_id: null,
                  status: g.status || 'lobby', settings: g.settings || {},
                  created_at: new Date().toISOString() };
      games.set(row.id, row); byCode.set(row.code, row.id);
      return clone(row);
    },
    async getGameByCode(code) {
      var id = byCode.get(code);
      return id ? clone(games.get(id)) : null;
    },
    async updateGame(id, patch) {
      var g = games.get(id); if (!g) return null;
      Object.assign(g, patch); return clone(g);
    },

    async addPlayers(gameId, list) {
      var made = list.map(function (p) {
        var row = { id: uuid(), game_id: gameId, animal: p.animal,
                    display_name: p.name, seat: p.seat, phone: p.phone || null,
                    token_hash: null, claimed_at: null, last_seen_at: null };
        players.push(row); return row;
      });
      return clone(made);
    },
    async listPlayers(gameId) {
      return clone(players.filter(function (p) { return p.game_id === gameId; })
                          .sort(function (a, b) { return a.seat - b.seat; }));
    },
    async claimSeat(gameId, seat, tokenHash) {
      var p = players.find(function (r) { return r.game_id === gameId && r.seat === seat; });
      if (!p) return null;
      if (p.token_hash && p.token_hash !== tokenHash) return { taken: true };
      p.token_hash = tokenHash; p.claimed_at = new Date().toISOString();
      return clone(p);
    },
    async releaseSeat(gameId, seat) {
      var p = players.find(function (r) { return r.game_id === gameId && r.seat === seat; });
      if (!p) return null;
      p.token_hash = null; p.claimed_at = null; return clone(p);
    },
    async findPlayerByToken(gameId, tokenHash) {
      var p = players.find(function (r) { return r.game_id === gameId && r.token_hash === tokenHash; });
      return p ? clone(p) : null;
    },
    async touchPlayer(id) {
      var p = players.find(function (r) { return r.id === id; });
      if (p) p.last_seen_at = new Date().toISOString();
    },
    async setPhone(gameId, seat, phone) {
      var p = players.find(function (r) { return r.game_id === gameId && r.seat === seat; });
      if (p) p.phone = phone;
      return p ? clone(p) : null;
    },

    async putRound(gameId, n, state) {
      var key = gameId + ':' + n;
      var row = { state: clone(state), version: 0, updatedAt: new Date().toISOString() };
      rounds.set(key, row);
      return { version: 0 };
    },
    async getRound(gameId, n) {
      var row = rounds.get(gameId + ':' + n);
      return row ? { state: clone(row.state), version: row.version, updatedAt: row.updatedAt } : null;
    },
    async getLatestRound(gameId) {
      var best = null, bestN = -1;
      rounds.forEach(function (row, key) {
        var parts = key.split(':'); if (parts[0] !== gameId) return;
        var n = Number(parts[1]);
        if (n > bestN) { bestN = n; best = row; }
      });
      return best ? { n: bestN, state: clone(best.state), version: best.version, updatedAt: best.updatedAt } : null;
    },
    /* Optimistic concurrency: only writes if the version is still what the caller saw. */
    async saveRound(gameId, n, state, expectedVersion) {
      var key = gameId + ':' + n, row = rounds.get(key);
      if (!row) return { conflict: true, reason: 'no such round' };
      if (expectedVersion != null && row.version !== expectedVersion) {
        return { conflict: true, version: row.version };
      }
      row.state = clone(state); row.version += 1; row.updatedAt = new Date().toISOString();
      return { version: row.version };
    },

    async appendMoves(rows) {
      rows.forEach(function (r) {
        moves.push(Object.assign({ id: ++seq, created_at: new Date().toISOString() }, r));
      });
    },
    async listMoves(gameId, opts) {
      opts = opts || {};
      var out = moves.filter(function (m) { return m.game_id === gameId; });
      if (opts.sinceId) out = out.filter(function (m) { return m.id > opts.sinceId; });
      out.sort(function (a, b) { return a.id - b.id; });
      if (opts.limit) out = out.slice(-opts.limit);
      return clone(out);
    },
    async lastMoveIdForSeat(gameId, seat) {
      var mine = moves.filter(function (m) { return m.game_id === gameId && m.seat === seat; });
      return mine.length ? mine[mine.length - 1].id : 0;
    },

    /* ---- seasons ---- */
    async createSeason(sn) {
      var row = { id: uuid(), code: sn.code, name: sn.name || null,
                  match_target: sn.matchTarget || 5, status: 'open',
                  created_at: new Date().toISOString(), ended_at: null };
      seasons.set(row.id, row); seasonByCode.set(row.code, row.id);
      return clone(row);
    },
    async getSeasonByCode(code) {
      var id = seasonByCode.get(code);
      return id ? clone(seasons.get(id)) : null;
    },
    async getSeason(id) { return seasons.has(id) ? clone(seasons.get(id)) : null; },
    async countSeasons() { return seasons.size; },
    async updateSeason(id, patch) {
      var sn = seasons.get(id); if (!sn) return null;
      Object.assign(sn, patch); return clone(sn);
    },
    async listSeasonGames(seasonId) {
      var out = [];
      games.forEach(function (g) { if (g.season_id === seasonId) out.push(clone(g)); });
      return out.sort(function (a, b) { return (a.match_no || 0) - (b.match_no || 0); });
    },
    async recordScores(gameId, rows) {
      rows.forEach(function (r) {
        var i = scores.findIndex(function (x) {
          return x.game_id === gameId && x.player_id === r.player_id && x.round_n === r.round_n; });
        if (i >= 0) scores[i] = Object.assign({}, r, { game_id: gameId });
        else scores.push(Object.assign({}, r, { game_id: gameId }));
      });
    },
    async listScores(gameIds) {
      return clone(scores.filter(function (r) { return gameIds.indexOf(r.game_id) >= 0; })
        .map(function (r) {
          if (r.animal) return r;
          var p = players.find(function (x) { return x.id === r.player_id; });
          return Object.assign({}, r, { animal: p ? p.animal : null });
        }));
    }
  };
}

/* =======================================================================
   postgres
   ======================================================================= */
function pgDb(connectionString) {
  var Pool = require('pg').Pool;
  var pool = new Pool({
    connectionString: connectionString,
    ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
    max: 4
  });
  var q = function (text, params) { return pool.query(text, params); };

  return {
    kind: 'pg',
    async init() { await q('select 1'); },
    async close() { await pool.end(); },

    async createGame(g) {
      var r = await q(
        'insert into games (code, status, settings) values ($1,$2,$3) returning *',
        [g.code, g.status || 'lobby', g.settings || {}]);
      return r.rows[0];
    },
    async getGameByCode(code) {
      var r = await q('select * from games where code = $1', [code]);
      return r.rows[0] || null;
    },
    async updateGame(id, patch) {
      var keys = Object.keys(patch);
      if (!keys.length) return null;
      var sets = keys.map(function (k, i) { return k + ' = $' + (i + 2); });
      var r = await q('update games set ' + sets.join(', ') + ' where id = $1 returning *',
                      [id].concat(keys.map(function (k) { return patch[k]; })));
      return r.rows[0] || null;
    },

    async addPlayers(gameId, list) {
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        var r = await q(
          'insert into players (game_id, animal, display_name, seat, phone) values ($1,$2,$3,$4,$5) returning *',
          [gameId, p.animal, p.name, p.seat, p.phone || null]);
        out.push(r.rows[0]);
      }
      return out;
    },
    async listPlayers(gameId) {
      var r = await q('select * from players where game_id = $1 order by seat', [gameId]);
      return r.rows;
    },
    async claimSeat(gameId, seat, tokenHash) {
      // only claims a seat that is free, or already this device's
      var r = await q(
        `update players set token_hash = $3, claimed_at = now()
           where game_id = $1 and seat = $2 and (token_hash is null or token_hash = $3)
         returning *`, [gameId, seat, tokenHash]);
      if (r.rows[0]) return r.rows[0];
      var exists = await q('select 1 from players where game_id = $1 and seat = $2', [gameId, seat]);
      return exists.rows.length ? { taken: true } : null;
    },
    async releaseSeat(gameId, seat) {
      var r = await q(
        'update players set token_hash = null, claimed_at = null where game_id = $1 and seat = $2 returning *',
        [gameId, seat]);
      return r.rows[0] || null;
    },
    async findPlayerByToken(gameId, tokenHash) {
      var r = await q('select * from players where game_id = $1 and token_hash = $2', [gameId, tokenHash]);
      return r.rows[0] || null;
    },
    async touchPlayer(id) {
      await q('update players set last_seen_at = now() where id = $1', [id]);
    },
    async setPhone(gameId, seat, phone) {
      var r = await q('update players set phone = $3 where game_id = $1 and seat = $2 returning *',
                      [gameId, seat, phone]);
      return r.rows[0] || null;
    },

    async putRound(gameId, n, state) {
      var r = await q(
        `insert into rounds (game_id, n, state, version) values ($1,$2,$3,0)
           on conflict (game_id, n) do update set state = excluded.state, version = 0, updated_at = now()
         returning version`, [gameId, n, state]);
      return { version: r.rows[0].version };
    },
    async getRound(gameId, n) {
      var r = await q('select state, version, updated_at from rounds where game_id = $1 and n = $2', [gameId, n]);
      if (!r.rows[0]) return null;
      return { state: r.rows[0].state, version: Number(r.rows[0].version), updatedAt: r.rows[0].updated_at };
    },
    async getLatestRound(gameId) {
      var r = await q('select n, state, version, updated_at from rounds where game_id = $1 order by n desc limit 1', [gameId]);
      if (!r.rows[0]) return null;
      return { n: r.rows[0].n, state: r.rows[0].state,
               version: Number(r.rows[0].version), updatedAt: r.rows[0].updated_at };
    },
    /* The single UPDATE below is the whole concurrency story: the version
       predicate means two simultaneous moves cannot both win. */
    async saveRound(gameId, n, state, expectedVersion) {
      var sql = expectedVersion == null
        ? `update rounds set state = $3, version = version + 1, updated_at = now()
             where game_id = $1 and n = $2 returning version`
        : `update rounds set state = $3, version = version + 1, updated_at = now()
             where game_id = $1 and n = $2 and version = $4 returning version`;
      var params = expectedVersion == null ? [gameId, n, state] : [gameId, n, state, expectedVersion];
      var r = await q(sql, params);
      if (!r.rows[0]) {
        var cur = await q('select version from rounds where game_id = $1 and n = $2', [gameId, n]);
        return { conflict: true, version: cur.rows[0] ? Number(cur.rows[0].version) : null };
      }
      return { version: Number(r.rows[0].version) };
    },

    async appendMoves(rows) {
      for (var i = 0; i < rows.length; i++) {
        var m = rows[i];
        /* created_at is honoured when supplied and defaults to now() when it
           is not, which is what the memory adapter has always done. This one
           used to drop it on the floor. Nothing in the app passes it, so it
           was never a live bug, but it made the turn clock untestable against
           a real database and two adapters that disagree is how a live bug
           gets born. */
        await q(
          `insert into moves (game_id, round_n, seat, type, payload, public_text, actor_id, victim_ids, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8, coalesce($9::timestamptz, now()))`,
          [m.game_id, m.round_n, m.seat, m.type, m.payload || {},
           m.public_text || null, m.actor_id || null, m.victim_ids || [],
           m.created_at || null]);
      }
    },
    async listMoves(gameId, opts) {
      opts = opts || {};
      var r = opts.sinceId
        ? await q('select * from moves where game_id = $1 and id > $2 order by id', [gameId, opts.sinceId])
        : await q('select * from moves where game_id = $1 order by id', [gameId]);
      var rows = r.rows.map(function (x) { return Object.assign({}, x, { id: Number(x.id) }); });
      return opts.limit ? rows.slice(-opts.limit) : rows;
    },
    async lastMoveIdForSeat(gameId, seat) {
      var r = await q('select id from moves where game_id = $1 and seat = $2 order by id desc limit 1',
                      [gameId, seat]);
      return r.rows[0] ? Number(r.rows[0].id) : 0;
    },

    /* ---- seasons ---- */
    async createSeason(sn) {
      var r = await q('insert into seasons (code, name, match_target) values ($1,$2,$3) returning *',
                      [sn.code, sn.name || null, sn.matchTarget || 5]);
      return r.rows[0];
    },
    async getSeasonByCode(code) {
      var r = await q('select * from seasons where code = $1', [code]);
      return r.rows[0] || null;
    },
    async countSeasons() {
      var r = await q('select count(*)::int as n from seasons');
      return r.rows[0].n;
    },
    async getSeason(id) {
      var r = await q('select * from seasons where id = $1', [id]);
      return r.rows[0] || null;
    },
    async updateSeason(id, patch) {
      var keys = Object.keys(patch); if (!keys.length) return null;
      var sets = keys.map(function (k, i) { return k + ' = $' + (i + 2); });
      var r = await q('update seasons set ' + sets.join(', ') + ' where id = $1 returning *',
                      [id].concat(keys.map(function (k) { return patch[k]; })));
      return r.rows[0] || null;
    },
    async listSeasonGames(seasonId) {
      var r = await q('select * from games where season_id = $1 order by match_no', [seasonId]);
      return r.rows;
    },
    async recordScores(gameId, rows) {
      for (var i = 0; i < rows.length; i++) {
        var x = rows[i];
        await q(`insert into scores (game_id, player_id, round_n, score) values ($1,$2,$3,$4)
                 on conflict (game_id, player_id, round_n) do update set score = excluded.score`,
                [gameId, x.player_id, x.round_n, x.score]);
      }
    },
    async listScores(gameIds) {
      if (!gameIds.length) return [];
      // the animal is what makes a person the same person across matches
      var r = await q(
        `select s.*, p.animal
           from scores s join players p on p.id = s.player_id
          where s.game_id = any($1::uuid[])`, [gameIds]);
      return r.rows;
    }
  };
}

/* Accept whatever the host calls it. Vercel Postgres injects POSTGRES_URL,
   Supabase and Neon hand you a DATABASE_URL, Heroku-style hosts vary. Getting
   this wrong fails silently into in-memory storage, which on serverless means
   every request sees a different empty game — so check all of them. */
var CONN_VARS = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL',
                 'POSTGRES_URL_NON_POOLING', 'PG_CONNECTION_STRING'];

function envConnectionString() {
  for (var i = 0; i < CONN_VARS.length; i++) {
    var v = process.env[CONN_VARS[i]];
    if (v && v.trim()) return v.trim();
  }
  return null;
}

function makeDb(opts) {
  opts = opts || {};
  var conn = opts.connectionString || envConnectionString();
  if (opts.kind === 'memory') return memoryDb();
  if (!conn) {
    if (opts.kind === 'pg') throw new Error('pg storage requested but no connection string found.');
    // Loud, because silently running in memory on a real deployment looks
    // like the game randomly forgetting itself.
    if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
      console.warn('[beeshouse] No database connection string set (' + CONN_VARS.join(', ') +
                   '). Falling back to in-memory storage — games will NOT persist.');
    }
    return memoryDb();
  }
  return pgDb(conn);
}

module.exports = { makeDb: makeDb, memoryDb: memoryDb, pgDb: pgDb, envConnectionString: envConnectionString,
                   hashToken: hashToken, newToken: newToken, newCode: newCode };

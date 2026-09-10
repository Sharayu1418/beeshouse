/* The Bee's House, application service.
 *
 * All the game logic that isn't the engine and isn't storage. The HTTP
 * handlers in api/ are thin wrappers around this, so the whole server is
 * testable without a socket.
 *
 * Rules this file exists to enforce:
 *   - a token identifies a seat, and only that seat may move
 *   - only the player whose turn it is may move
 *   - a stale client cannot overwrite a newer state
 *   - nothing leaves without going through redact.js
 */
'use strict';

var Engine = require('./engine.js');
var Redact = require('./redact.js');
var DB = require('./db.js');

var TURN_CLOCK_HOURS = 24;
/* A room nobody has touched in this long has been abandoned, and stops
   holding the front door shut. Seven days rather than two, because the 48
   hour skip already exists for a game people are still playing: this is for
   one nobody opened again at all. */
var DEAD_ROOM_MS = 7 * 24 * 60 * 60 * 1000;

function err(code, message, extra) {
  var e = new Error(message);
  e.status = code;
  if (extra) Object.assign(e, extra);
  return e;
}

/* Actions a player may send. Anything not on this list is rejected before
   it reaches the engine, the engine is trusted, the network is not. */
var ALLOWED_MOVES = new Set([
  'DRAW', 'TAKE_DISCARD', 'PLACE', 'DISCARD_DRAWN',
  'PEEK_OWN', 'SPY', 'SWAP_DO', 'LISTEN_ANSWER',
  'SLAP_TOGGLE', 'SLAP_GO', 'SWEEP',
  'ABILITY', 'STING_DONE',
  'CABO', 'END_TURN', 'CLOSE_MODAL'
]);

/* Questions Listen is allowed to ask.
 *
 * The client sends an INDEX, never a card, so the answer is computed here
 * and the card itself never travels. With a real deck these got much better:
 * "Is it red?" is now the sharpest question in the game, because red is
 * where the -1 kings live. A yes means either a small heart or the single
 * best card on the table, and you have to decide which. */
var LISTEN_QUESTIONS = [
  { q: 'Is it red?',          f: function (c) { return Engine.isRed(c); } },
  { q: 'Is it under 5?',      f: function (c) { return Engine.valueOf(c) < 5 && Engine.valueOf(c) > 0; } },
  { q: 'Is it a face card?',  f: function (c) { return c.r === 'J' || c.r === 'Q' || c.r === 'K'; } },
  { q: 'Is it a power card?', f: function (c) { return !!Engine.powerOf(c.r); } }
];

/* Naming a person from an animal. A players row is per game, so the animal
   is the only identity that survives a match ending, and every season number
   below is keyed on it. */
function whoIs(animal) {
  var def = Engine.ROSTER.filter(function (r) { return r.id === animal; })[0];
  return def ? { animal: animal, name: def.name, emo: def.emo }
             : { animal: animal, name: animal, emo: '' };
}

/* The season at a glance: the match recap one layer up, counted over every
   match instead of one. Every line is a query over `moves`, whose actor_id
   and victim_ids have been animals since Phase 1, so nothing needs joining
   and no season number can disagree with the match it came from.

   Hushed rows carry no actor and no victims, which is the whole point of
   Hush, so they fall out of every tally here by themselves. */
function seasonExtras(tab, acts) {
  function tally(list, pick) {
    var c = {};
    list.forEach(function (m) {
      var k = pick(m);
      (Array.isArray(k) ? k : [k]).forEach(function (one) { if (one) c[one] = (c[one] || 0) + 1; });
    });
    return c;
  }
  function top(c) {
    var k = Object.keys(c).sort(function (a, b) { return c[b] - c[a]; })[0];
    if (!k) return null;
    var w = whoIs(k); w.n = c[k]; return w;
  }
  function byText(re) {
    return tally(tab.filter(function (m) { return re.test(m.public_text || ''); }),
                 function (m) { return m.actor_id; });
  }

  var cardsKilled = 0;
  tab.forEach(function (m) {
    var hit = /swept the floor\. (\d+) card/.exec(m.public_text || '');
    if (hit) cardsKilled += Number(hit[1]);
  });

  /* Called and missed are different accusations, and the second is the one
     worth printing: calling Cabo forty times is confidence, missing four is
     a personality. */
  var called = byText(/called Cabo/), missed = byText(/called Cabo and missed/);
  var worstCaller = null;
  Object.keys(missed).forEach(function (k) {
    if (!worstCaller || missed[k] > worstCaller.missed) {
      worstCaller = Object.assign(whoIs(k), { missed: missed[k], called: called[k] || missed[k] });
    }
  });

  return {
    swept:      top(tally(acts.filter(function (m) { return m.type === 'SWEEP'; }),
                          function (m) { return m.actor_id; })),
    cardsKilled: cardsKilled,
    pickedOn:   top(tally(tab, function (m) { return m.victim_ids || []; })),
    stung:      top(byText(/stung/)),
    caboCalled: top(called),
    worstCaller: worstCaller,
    skipped:    top(tally(acts.filter(function (m) { return m.type === 'SKIP_TURN'; }),
                          function (m) { return m.actor_id; })),
    emptied:    top(byText(/emptied their hand/)),
    hushes:     tab.filter(function (m) { return /Nobody heard what/.test(m.public_text || ''); }).length,
    totalTab:   tab.length,
    totalMoves: acts.length
  };
}

/* A season settles the way a match does, because that is the deal the table
   already understands: whoever is on the lowest total is ahead, and then
   everybody takes one point off for every single thing that person did to
   them, across every match rather than the last one.

   It counts the same Tab rows the match settlements counted, so a season
   cannot settle in a way that contradicts the matches inside it. And it can
   still flip the winner, which is the entire reason anybody keeps a tab. */
function settleSeason(table, tab) {
  if (!table.length) return null;
  var leader = table[0];
  var rows = table.map(function (r) {
    var owed = r.animal === leader.animal ? 0 : tab.filter(function (m) {
      return m.actor_id === leader.animal && (m.victim_ids || []).indexOf(r.animal) >= 0;
    }).length;
    return { animal: r.animal, name: r.name, emo: r.emo,
             base: r.total, owed: owed, final: r.total - owed };
  }).sort(function (a, b) { return a.final - b.final; });

  return {
    leader:  { animal: leader.animal, name: leader.name, emo: leader.emo, total: leader.total },
    rows:    rows,
    winner:  rows[0],
    changed: rows[0].animal !== leader.animal
  };
}

function makeService(db) {

  /* ------------------------------------------------------------- rooms */

  async function createRoom(opts) {
    opts = opts || {};
    var roster = opts.players && opts.players.length ? opts.players : Engine.ROSTER.map(function (r) {
      return { animal: r.id, name: r.name, phone: null };
    });
    if (roster.length < 2) throw err(400, 'Need at least two players.');
    if (roster.length > Engine.ROSTER.length) throw err(400, 'Too many players.');

    // a code nobody is using
    var code = null;
    for (var i = 0; i < 12 && !code; i++) {
      var c = DB.newCode(4);
      if (!(await db.getGameByCode(c))) code = c;
    }
    if (!code) throw err(500, 'Could not allocate a room code.');

    /* A room can belong to a season. Matches still settle their own Tab at
       the end; the season is the running total on top, which is what you
       asked for. */
    var season = null, matchNo = null;
    if (opts.seasonCode) {
      season = await db.getSeasonByCode(String(opts.seasonCode).toUpperCase());
      if (!season) throw err(404, 'No season with that code.');
      if (season.status !== 'open') throw err(409, 'That season is over.');
      var played = await db.listSeasonGames(season.id);
      if (played.length >= season.match_target) throw err(409, 'That season is already full.');
      matchNo = played.length + 1;
    }

    var game = await db.createGame({
      code: code,
      status: 'lobby',
      settings: {
        rounds: Engine.ROUNDS,
        turnClockHours: opts.turnClockHours || TURN_CLOCK_HOURS,
        peeked: [],
        groupInviteText: null
      }
    });

    if (season) await db.updateGame(game.id, { season_id: season.id, match_no: matchNo });

    await db.addPlayers(game.id, roster.map(function (p, i) {
      var def = Engine.ROSTER.filter(function (r) { return r.id === p.animal; })[0] || Engine.ROSTER[i];
      return { animal: def.id, name: p.name || def.name, seat: i, phone: p.phone || null };
    }));

    // deal round 1 immediately, there is no lobby to wait in
    var players = await db.listPlayers(game.id);
    var seats = players.map(function (p) {
      var def = Engine.ROSTER.filter(function (r) { return r.id === p.animal; })[0];
      return { id: p.animal, name: p.display_name, emo: def.emo,
               animal: def.animal, ability: def.ability, blurb: def.blurb };
    });
    var s = Engine.reducer(Engine.init(), { type: 'ACCEPT' });
    s = Engine.reducer(s, { type: 'SET_PLAYERS', players: seats });
    await db.putRound(game.id, 1, s);
    await db.updateGame(game.id, { status: 'playing' });

    return { code: code, gameId: game.id, players: players,
             season: season ? { code: season.code, matchNo: matchNo, target: season.match_target } : null };
  }

  /* The room the group is in the middle of, if there is one.

     Null when the last one finished, and null when nobody has touched a room
     in a week, so an abandoned game cannot lock the front door forever. The
     timestamp is the newest move in the room, falling back to when it was
     dealt, which is the same reading the turn clock uses. */
  async function liveRoom() {
    var g = await db.findOpenGame();
    if (!g) return null;
    var last = await db.lastMoveAt(g.id);
    var t = new Date(last || g.created_at).getTime();
    if (!t || (Date.now() - t) > DEAD_ROOM_MS) return null;
    return g;
  }

  /* What the front door does. One group, one game: pressing Yes while a game
     is running takes you to that game rather than dealing a second one and
     splitting five people across two rooms.

     This is policy, so it lives at the door. `createRoom` stays a primitive
     that deals a room when told to, which is what a season's next match
     needs: that one is allowed to open a new room precisely because the
     previous one has finished. */
  async function openRoom(opts) {
    var live = await liveRoom();
    if (live) {
      var players = await db.listPlayers(live.id);
      return { code: live.code, gameId: live.id, players: players,
               season: null, existing: true };
    }
    var made = await createRoom(opts);
    made.existing = false;
    return made;
  }

  async function roomInfo(code) {
    var game = await db.getGameByCode(code);
    if (!game) throw err(404, 'No room with that code.');
    var players = await db.listPlayers(game.id);
    return {
      code: game.code,
      status: game.status,
      settings: game.settings,
      seats: players.map(function (p) {
        var def = Engine.ROSTER.filter(function (r) { return r.id === p.animal; })[0] || {};
        return { seat: p.seat, animal: p.animal, name: p.display_name, emo: def.emo,
                 ability: def.ability, claimed: !!p.token_hash, phone: p.phone };
      })
    };
  }

  /* You claim a seat once, on your own device. The token never travels in
     a shared link, so nobody else's phone ever holds it. */
  async function claimSeat(code, seat, existingToken) {
    var game = await db.getGameByCode(code);
    if (!game) throw err(404, 'No room with that code.');
    var token = existingToken || DB.newToken();
    var res = await db.claimSeat(game.id, seat, DB.hashToken(token));
    if (!res) throw err(404, 'No such seat.');
    if (res.taken) throw err(409, 'That seat is already taken on another device.');
    return { token: token, seat: res.seat, animal: res.animal, name: res.display_name };
  }

  /* ------------------------------------------------------ seat recovery

     Somebody clears their browser, or gets a new phone, and their seat is
     gone. There is no password to reset, because there is no password.

     So the recovery is social, which is also the correct answer: four other
     people already know whether Sahil is Sahil. The new device asks for the
     seat, anybody else who is already in the room approves, and the seat
     moves. The old device is locked out by the same act, which is the point,
     since the usual reason for asking is that the old device is gone.

     Nothing is deleted. Requests keep their whole history in settings,
     approved, denied and pending alike, and every decision goes on the
     permanent record as a move. */

  function requestsOf(game) {
    return ((game.settings || {}).seatRequests || []).slice();
  }
  /* settings is one jsonb column shared with the opening peek, and both
     sides write it by merging onto a copy they read earlier. Re-reading the
     row immediately before the write shrinks that window to nothing that
     matters for five people, and stops a seat approval from quietly wiping
     who has already peeked. */
  async function writeRequests(game, list) {
    var fresh = await db.getGameByCode(game.code);
    var base = (fresh && fresh.settings) || game.settings || {};
    await db.updateGame(game.id, {
      settings: Object.assign({}, base, { seatRequests: list })
    });
  }
  function publicRequest(r) {
    // the candidate's token hash never leaves the server
    return { id: r.id, seat: r.seat, at: r.at, status: r.status,
             approvedBy: r.approvedBy == null ? null : r.approvedBy };
  }

  async function requestSeat(code, seat) {
    var game = await db.getGameByCode(code);
    if (!game) throw err(404, 'No room with that code.');
    var players = await db.listPlayers(game.id);
    var target = players.filter(function (p) { return p.seat === Number(seat); })[0];
    if (!target) throw err(404, 'No such seat.');
    if (!target.token_hash) throw err(409, 'That seat is free. Just take it.');

    var others = players.filter(function (p) { return p.token_hash && p.seat !== Number(seat); });
    if (!others.length) throw err(409, 'There is nobody else in the room to vouch for you yet.');

    var list = requestsOf(game);
    var pending = list.filter(function (r) { return r.status === 'pending' && r.seat === Number(seat); });
    if (pending.length >= 3) throw err(429, 'That seat already has requests waiting. Ask somebody to approve one.');

    var token = DB.newToken();
    var reqRow = { id: DB.newToken().slice(0, 10), seat: Number(seat),
                   hash: DB.hashToken(token), at: new Date().toISOString(),
                   status: 'pending', approvedBy: null, decidedAt: null };
    list.push(reqRow);
    await writeRequests(game, list);

    await db.appendMoves([{
      game_id: game.id, round_n: 0, seat: Number(seat), type: 'SEAT_REQUEST',
      payload: { id: reqRow.id }, public_text: null,
      actor_id: target.animal, victim_ids: []
    }]);

    return { requestId: reqRow.id, token: token, seat: Number(seat), name: target.display_name };
  }

  /* Any claimed player except whoever is sitting in that seat. The person
     asking cannot be the person approving, which is the only rule this
     needs. */
  async function decideSeat(code, token, requestId, approve) {
    var ctx = await resolve(code, token);
    var list = requestsOf(ctx.game);
    var req = list.filter(function (r) { return r.id === requestId; })[0];
    if (!req) throw err(404, 'No such request.');
    if (req.status !== 'pending') throw err(409, 'That one has already been decided.');
    if (req.seat === ctx.seat) throw err(403, 'You cannot approve your own seat.');

    req.status = approve ? 'approved' : 'denied';
    req.approvedBy = ctx.seat;
    req.decidedAt = new Date().toISOString();

    var players = await db.listPlayers(ctx.game.id);
    var target = players.filter(function (p) { return p.seat === req.seat; })[0];

    if (approve) {
      await db.releaseSeat(ctx.game.id, req.seat);
      var res = await db.claimSeat(ctx.game.id, req.seat, req.hash);
      if (!res || res.taken) { req.status = 'pending'; req.approvedBy = null; req.decidedAt = null;
        await writeRequests(ctx.game, list);
        throw err(409, 'The seat did not move. Try again.'); }
    }
    await writeRequests(ctx.game, list);

    var who = target ? target.display_name : ('seat ' + req.seat);
    var vouch = ctx.round.state.players[ctx.seat];
    await db.appendMoves([
      { game_id: ctx.game.id, round_n: ctx.round.n, seat: req.seat,
        type: approve ? 'SEAT_MOVED' : 'SEAT_DENIED',
        payload: { id: req.id, by: ctx.seat }, public_text: null,
        actor_id: target ? target.animal : null, victim_ids: [] },
      { game_id: ctx.game.id, round_n: ctx.round.n, seat: req.seat, type: 'TAB',
        payload: {}, public_text: approve
          ? who + ' came back on a new phone. ' + (vouch ? vouch.name : 'Somebody') + ' vouched for them.'
          : (vouch ? vouch.name : 'Somebody') + ' turned down a request to take over ' + who + "'s seat.",
        actor_id: null, victim_ids: [] }
    ]);

    return { ok: true, request: publicRequest(req) };
  }

  async function setPhone(code, seat, phone) {
    var game = await db.getGameByCode(code);
    if (!game) throw err(404, 'No room with that code.');
    return await db.setPhone(game.id, seat, phone);
  }

  /* ------------------------------------------------------- auth helper */

  async function resolve(code, token) {
    var game = await db.getGameByCode(code);
    if (!game) throw err(404, 'No room with that code.');
    if (!token) throw err(401, 'No seat claimed on this device yet.');
    var player = await db.findPlayerByToken(game.id, DB.hashToken(token));
    if (!player) throw err(401, 'This device is not holding a seat in that room.');
    await db.touchPlayer(player.id);
    var round = await db.getLatestRound(game.id);
    if (!round) throw err(500, 'Room has no round.');
    /* A round dealt with the old 0-13 deck would be silently misread by the
       new value rules, so stop rather than quietly score it wrong. */
    if ((round.state.deckVersion || 1) !== Engine.DECK_VERSION) {
      throw err(409, 'This game was dealt with the old deck. Start a new house, it plays with real cards now.');
    }
    return { game: game, player: player, seat: player.seat, round: round };
  }

  /* --------------------------------------------------- the opening peek
     Discovered while building this: the peek phase mutates no cards at all
    , SETUP_TOGGLE only writes a UI array and SETUP_NEXT clears it. So the
     peek can be parallel with no engine change. Each player asks for their
     two cards, gets them once as a reveal, and when everyone has looked the
     engine is walked forward to the first turn. */

  /* Reading the peek record. It used to be a plain list of seat numbers.
     It now carries WHICH two cards each person chose, because you may look
     at them as often as you like before the round starts and it has to be
     the same two every time. Old rooms stored bare numbers, so both shapes
     are read. */
  function peekRecord(game) {
    return ((game.settings || {}).peeked || []).map(function (e) {
      return (typeof e === 'number') ? { seat: e, idx: null } : e;
    });
  }
  function peekedBy(game, seat) {
    return peekRecord(game).filter(function (e) { return e.seat === seat; })[0] || null;
  }

  /* ------------------------------------------------------- the first look

     You get one look at two of your four, and before the round starts you
     may take that look as many times as you want. Nobody has played a card
     yet, so there is nothing to gain over anybody else, and you are allowed
     a private note about your own hand anyway. Making people rely on
     memory for a game that has not started was difficulty in the wrong
     place.

     The two are chosen once and then fixed. Without that you could look at
     1 and 2, look again at 3 and 4, and know your whole hand, which is a
     different game. */
  async function peek(code, token, indices) {
    var ctx = await resolve(code, token);
    var s = ctx.round.state;
    if (s.phase !== 'peek') throw err(409, 'The opening peek is over.');

    var me = s.players[ctx.seat];
    var already = peekedBy(ctx.game, ctx.seat);
    var uniq;

    if (already && already.idx) {
      // looking again: it is the same two, whatever the client asked for
      uniq = already.idx;
    } else {
      if (!Array.isArray(indices) || indices.length !== 2) throw err(400, 'Pick exactly two cards.');
      uniq = Array.from(new Set(indices));
      if (uniq.length !== 2 || uniq.some(function (i) { return !(i >= 0 && i < me.hand.length); })) {
        throw err(400, 'Pick two different cards from your own hand.');
      }
    }

    var settings = ctx.game.settings || {};
    var rec = peekRecord(ctx.game).filter(function (e) { return e.seat !== ctx.seat; });
    rec.push({ seat: ctx.seat, idx: uniq });
    await db.updateGame(ctx.game.id, { settings: Object.assign({}, settings, { peeked: rec }) });

    var cards = uniq.map(function (i) {
      var c = me.hand[i];
      return { slot: i, id: c.id, r: c.r, s: c.s, v: Engine.valueOf(c) };
    });

    return {
      reveal: { kind: 'cards',
                title: already ? 'The same two' : 'Your two cards',
                sub: already
                  ? 'Look as long as you like. Once the round starts this is gone.'
                  : 'These two are yours to know. You can come back to them until the round starts.',
                cards: cards },
      lookedAgain: !!already
    };
  }

  /* Done looking. The round starts when everybody has said so, which is
     what stops the last person to arrive getting a single glance while
     everybody else sat with theirs open. */
  async function ready(code, token) {
    var ctx = await resolve(code, token);
    var s = ctx.round.state;
    if (s.phase !== 'peek') throw err(409, 'The round has already started.');
    if (!peekedBy(ctx.game, ctx.seat)) throw err(409, 'Take your look first.');

    var settings = ctx.game.settings || {};
    var list = (settings.ready || []).slice();
    if (list.indexOf(ctx.seat) < 0) list.push(ctx.seat);
    await db.updateGame(ctx.game.id, { settings: Object.assign({}, settings, { ready: list }) });

    var players = await db.listPlayers(ctx.game.id);
    var everyoneSeated = players.every(function (p) { return !!p.token_hash; });
    var everyoneReady = list.length >= s.players.length;

    if (everyoneSeated && everyoneReady) {
      var next = s;
      for (var i = 0; i < s.players.length; i++) next = Engine.reducer(next, { type: 'SETUP_NEXT' });
      if (next.phase === 'curtain') next = Engine.reducer(next, { type: 'LIFT_CURTAIN' });
      await db.saveRound(ctx.game.id, ctx.round.n, next, ctx.round.version);
    }
    return await getState(code, token);
  }

  /* ---------------------------------------------------------- the clock

     When did this turn become somebody's problem? Not when they last
     touched it: a player who draws a card and then vanishes for two days
     has still held the game for two days. So the clock starts at the last
     move made by ANYBODY ELSE, which is the moment the seat passed to
     them. If nobody else has moved yet, the round starting is the start.

     Read off the move log, which is append-only, so the clock cannot be
     wound back by playing. */
  async function turnClock(game, round) {
    var st = round.state;
    if (!st || st.phase !== 'turn' || st.turn == null) return null;
    var moves = await db.listMoves(game.id, { limit: 400 });
    var startedAt = null;
    for (var i = moves.length - 1; i >= 0; i--) {
      if (moves[i].seat !== st.turn) { startedAt = moves[i].created_at; break; }
    }
    if (!startedAt) startedAt = round.updatedAt || game.created_at || null;
    if (!startedAt) return null;

    var hours = (Date.now() - new Date(startedAt).getTime()) / 3600000;
    if (!isFinite(hours) || hours < 0) hours = 0;
    var limit = (game.settings || {}).turnClockHours || TURN_CLOCK_HOURS;
    return {
      startedAt: startedAt,
      hours: Math.floor(hours * 10) / 10,
      limit: limit,
      overdue: hours >= limit,
      skippable: hours >= limit * 2
    };
  }

  /* Anyone but the person holding things up, once it has been two days.
     There is no host in this game and inventing one to press this button
     would be a worse answer than four people who can already see who is
     sitting on it. */
  async function skipTurn(code, token) {
    var ctx = await resolve(code, token);
    var st = ctx.round.state;
    if (st.phase !== 'turn') throw err(409, 'Nothing is waiting on anybody.');
    if (st.turn === ctx.seat) throw err(409, 'You cannot skip yourself. Play.');

    var clock = await turnClock(ctx.game, ctx.round);
    if (!clock || !clock.skippable) {
      throw err(409, 'Not yet. A turn can only be skipped after '
                     + (((ctx.game.settings || {}).turnClockHours || TURN_CLOCK_HOURS) * 2)
                     + ' hours.');
    }

    var before = st;
    var after = Engine.reducer(before, { type: 'SKIP_TURN' });
    // same as ending a turn online: there is no phone to pass
    if (after.phase === 'curtain') after = Engine.reducer(after, { type: 'LIFT_CURTAIN' });
    var newEntries = after.log.slice(0, Math.max(0, after.log.length - before.log.length));

    var saved = await db.saveRound(ctx.game.id, ctx.round.n, after, ctx.round.version);
    var rows = [{
      game_id: ctx.game.id, round_n: ctx.round.n, seat: before.turn, type: 'SKIP_TURN',
      payload: { by: ctx.seat, heldHours: clock.hours }, public_text: null,
      actor_id: before.players[before.turn].id, victim_ids: []
    }];
    newEntries.forEach(function (e) {
      rows.push({
        game_id: ctx.game.id, round_n: ctx.round.n, seat: before.turn, type: 'TAB',
        payload: {}, public_text: e.t, actor_id: e.by || null, victim_ids: e.to || []
      });
    });
    await db.appendMoves(rows);
    return await getState(code, token);
  }

  /* -------------------------------------------------------------- state */

  async function getState(code, token) {
    var ctx = await resolve(code, token);
    var players = await db.listPlayers(ctx.game.id);
    var view = Redact.viewFor(ctx.round.state, ctx.seat, {
      code: code, version: ctx.round.version, updatedAt: ctx.round.updatedAt
    });
    // GET never carries a reveal, that is what makes refresh non-cheaty
    Redact.assertNoLeak(view, ctx.round.state, ctx.seat);
    view.roster = players.map(function (p) {
      return { seat: p.seat, animal: p.animal, name: p.display_name,
               phone: p.phone, claimed: !!p.token_hash, lastSeen: p.last_seen_at };
    });
    view.settings = ctx.game.settings;

    /* Which match of which season this is, so the end of a match knows
       whether there is a next one. Nothing here is secret: it is the same
       thing written on the season link. */
    view.season = null;
    if (ctx.game.season_id) {
      var seas = await db.getSeason(ctx.game.season_id);
      if (seas) {
        var seasGames = await db.listSeasonGames(seas.id);
        view.season = {
          code: seas.code, name: seas.name, status: seas.status,
          matchNo: ctx.game.match_no, target: seas.match_target,
          played: seasGames.filter(function (g) { return g.status === 'done'; }).length
        };
      }
    }
    var unclaimed = players.filter(function (p) { return !p.token_hash; });
    view.allClaimed = unclaimed.length === 0;
    view.waitingFor = unclaimed.map(function (p) {
      var def = Engine.ROSTER.filter(function (r) { return r.id === p.animal; })[0] || {};
      return { seat: p.seat, name: p.display_name, emo: def.emo };
    });
    view.peekDone = !!peekedBy(ctx.game, ctx.seat);
    view.readyDone = ((ctx.game.settings || {}).ready || []).indexOf(ctx.seat) >= 0;
    view.readyCount = ((ctx.game.settings || {}).ready || []).length;
    view.turnClockHours = (ctx.game.settings || {}).turnClockHours || TURN_CLOCK_HOURS;
    /* The client sends a question INDEX, so if its list ever drifts from this
       one you get a true answer to a question you did not ask. It drifted
       once. Shipping the text with the view means it cannot happen again. */
    view.listenQuestions = LISTEN_QUESTIONS.map(function (q) { return q.q; });

    /* Who is actually looking at this right now. last_seen_at is bumped on
       every authenticated request, so with the client polling while its tab
       is open this is accurate to within one poll. Thirty seconds is the
       window: long enough to survive a slow request, short enough that a
       dot going out means they really did put the phone down. */
    var HERE_MS = 30000, now = Date.now();
    view.presence = players.map(function (p) {
      var t = p.last_seen_at ? new Date(p.last_seen_at).getTime() : 0;
      return { seat: p.seat, here: !!t && (now - t) < HERE_MS };
    });
    view.clock = await turnClock(ctx.game, ctx.round);
    // requests you are allowed to decide, which is any but your own seat
    view.seatRequests = requestsOf(ctx.game)
      .filter(function (r) { return r.status === 'pending' && r.seat !== ctx.seat; })
      .map(function (r) {
        var who = players.filter(function (p) { return p.seat === r.seat; })[0];
        return Object.assign(publicRequest(r), { name: who ? who.display_name : ('seat ' + r.seat) });
      });
    // you can never skip your own turn, so the button is never yours to see
    if (view.clock) view.clock.youMaySkip = view.clock.skippable && ctx.round.state.turn !== ctx.seat;
    view.briefing = await buildBriefing(ctx.game.id, ctx.seat, players);
    return view;
  }

  /* --------------------------------------------------------------- move */

  async function applyMove(code, token, move, expectedVersion) {
    var ctx = await resolve(code, token);
    if (!move || !ALLOWED_MOVES.has(move.type)) throw err(400, 'Not a move.');

    var before = ctx.round.state;
    if (before.phase !== 'turn') throw err(409, 'Not a playable phase right now.');
    if (before.turn !== ctx.seat) {
      throw err(409, 'It is ' + before.players[before.turn].name + "'s turn, not yours.");
    }
    if (expectedVersion != null && expectedVersion !== ctx.round.version) {
      throw err(409, 'The game moved on since you last looked.', { version: ctx.round.version });
    }

    // Listen answers are computed here so the card value never travels
    var action = Object.assign({}, move);
    if (action.type === 'LISTEN_ANSWER') {
      var q = LISTEN_QUESTIONS[action.qIndex];
      if (!q) throw err(400, 'No such question.');
      var target = before.players[action.seat];
      if (!target || !target.hand[action.idx]) throw err(400, 'No such card.');
      action.q = q.q;
      action.ans = q.f(target.hand[action.idx]) ? 'Yes.' : 'No.';
      action.who = action.seat === ctx.seat ? 'your own hand' : target.name;
      action.toId = action.seat === ctx.seat ? null : target.id;
    }

    var after = Engine.reducer(before, action);
    if (after === before) throw err(409, 'That move is not legal right now.');

    // ending a turn online skips the pass-the-phone curtain entirely
    if (after.phase === 'curtain') after = Engine.reducer(after, { type: 'LIFT_CURTAIN' });
    if (after.phase === 'score')   after = Engine.reducer(after, { type: 'SCORE' });

    var write = await db.saveRound(ctx.game.id, ctx.round.n, after, ctx.round.version);
    if (write.conflict) {
      throw err(409, 'Somebody else moved at the same moment. Reloading.', { version: write.version });
    }

    // append whatever the engine added to the Tab, plus the raw move
    var newEntries = (after.log || []).slice(0, Math.max(0, (after.log || []).length - (before.log || []).length));
    /* The full record.
     *
     * Every move was already being stored, but with an empty payload, which
     * made the log a list of verbs with no objects. Now it records which
     * card actually moved and where it went, so a finished round can be
     * replayed properly.
     *
     * This is safe because a move row NEVER reaches a browser through the
     * normal endpoints: the Tab and the briefing read `public_text` only,
     * which the engine writes with card values already stripped. Card
     * identities in `payload` are only ever served by replay(), and replay()
     * refuses any round that is still being played. */
    var detail = { move: move.type };
    (function () {
      var mine = before.players[ctx.seat];
      var card = null;
      if (move.type === 'PLACE' && mine.hand[move.idx]) card = mine.hand[move.idx];
      if (move.type === 'DISCARD_DRAWN' && before.drawn) card = before.drawn.card;
      if (move.type === 'PEEK_OWN' && mine.hand[move.idx]) card = mine.hand[move.idx];
      if (move.type === 'SPY' && before.players[move.seat]) card = before.players[move.seat].hand[move.idx];
      if (card) detail.card = { id: card.id, r: card.r, s: card.s, v: Engine.valueOf(card) };
      if (move.idx != null) detail.slot = move.idx;
      if (move.seat != null) detail.target = move.seat;
      if (move.type === 'SLAP_GO') detail.slapped = (before.sel || []).length;
      if (move.type === 'DRAW' && after.drawn) {
        detail.card = { id: after.drawn.card.id, r: after.drawn.card.r,
                        s: after.drawn.card.s, v: Engine.valueOf(after.drawn.card) };
        detail.from = after.drawn.from;
      }
      detail.hushed = before.hush === ctx.seat;
    })();

    var rows = [{
      game_id: ctx.game.id, round_n: ctx.round.n, seat: ctx.seat, type: move.type,
      payload: detail, public_text: null,
      actor_id: before.players[ctx.seat].id, victim_ids: []
    }];
    newEntries.forEach(function (e) {
      rows.push({
        game_id: ctx.game.id, round_n: ctx.round.n, seat: ctx.seat, type: 'TAB',
        payload: {}, public_text: e.t, actor_id: e.by || null, victim_ids: e.to || []
      });
    });
    await db.appendMoves(rows);

    // round finished → deal the next one
    if (after.phase === 'roundEnd' && after.round < Engine.ROUNDS) {
      // left for the client to confirm, so everybody sees the scores first
    }

    var players = await db.listPlayers(ctx.game.id);
    var view = Redact.viewFor(after, ctx.seat, { code: code, version: write.version });
    view.roster = players.map(function (p) {
      return { seat: p.seat, animal: p.animal, name: p.display_name,
               phone: p.phone, claimed: !!p.token_hash, lastSeen: p.last_seen_at };
    });
    view.settings = ctx.game.settings;
    Redact.assertNoLeak(view, after, ctx.seat);

    // the one-time reveal rides alongside the view, never inside it
    var reveal = Redact.revealFor(after, ctx.seat);
    return { view: view, reveal: reveal };
  }

  async function nextRound(code, token) {
    var ctx = await resolve(code, token);
    var s = ctx.round.state;
    if (s.phase !== 'roundEnd') throw err(409, 'The round is not over.');

    /* Persist this round's scores before moving on. Nothing is ever thrown
       away: every round of every match stays in `scores` for good. */
    var roster = await db.listPlayers(ctx.game.id);
    var byAnimal = {};
    roster.forEach(function (p) { byAnimal[p.animal] = p.id; });
    /* r.id is the animal; scores.player_id is a real players row. Player rows
       are per game, so the animal is what identifies a person ACROSS matches,
       and listScores() joins back to it for the season table. */
    await db.recordScores(ctx.game.id, (s.lastScores || [])
      .filter(function (r) { return byAnimal[r.id]; })
      .map(function (r) {
        return { player_id: byAnimal[r.id], animal: r.id, round_n: s.round, score: r.score };
      }));
    var after = Engine.reducer(s, { type: 'NEXT_ROUND' });
    if (after.phase === 'matchEnd') {
      await db.saveRound(ctx.game.id, ctx.round.n, after, ctx.round.version);
      await db.updateGame(ctx.game.id, { status: 'done', finished_at: new Date().toISOString() });
      // a season closes itself once its matches are played
      if (ctx.game.season_id) {
        var sn = await db.getSeason(ctx.game.season_id);
        if (sn) {
          var gs = await db.listSeasonGames(sn.id);
          var doneCount = gs.filter(function (g) { return g.status === 'done'; }).length;
          if (doneCount >= sn.match_target) {
            await db.updateSeason(sn.id, { status: 'done', ended_at: new Date().toISOString() });
          }
        }
      }
    } else {
      await db.putRound(ctx.game.id, after.round, after);
      var settings = ctx.game.settings || {};
      await db.updateGame(ctx.game.id, { settings: Object.assign({}, settings, { peeked: [], ready: [] }) });
    }
    return await getState(code, token);
  }

  /* ----------------------------------------------------- the briefing
     "It reminds you what you did. It never reminds you what you learned."
     Everything here comes from public_text, which the engine writes with
     values already stripped. No card value can reach this function. */

  async function buildBriefing(gameId, seat, players) {
    var moves = await db.listMoves(gameId, { limit: 400 });
    var tab = moves.filter(function (m) { return m.type === 'TAB'; });

    // Walk backwards to find the last *contiguous* block of my own entries.
    // That block is exactly my previous turn, not the last three things I
    // ever did, which could span several turns and read as nonsense.
    var myTurn = [], seenMine = false;
    for (var i = tab.length - 1; i >= 0; i--) {
      if (tab[i].seat === seat) { myTurn.unshift(tab[i]); seenMine = true; }
      else if (seenMine) break;
    }
    var lastMineId = myTurn.length ? myTurn[myTurn.length - 1].id : 0;

    var since = tab.filter(function (m) {
      return m.id > lastMineId && m.seat !== seat;
    });

    var meId = (players.filter(function (p) { return p.seat === seat; })[0] || {}).animal;
    var againstMe = {};
    tab.forEach(function (m) {
      if (!m.actor_id || m.actor_id === meId) return;
      if ((m.victim_ids || []).indexOf(meId) < 0) return;
      againstMe[m.actor_id] = (againstMe[m.actor_id] || 0) + 1;
    });
    var worst = Object.keys(againstMe).sort(function (a, b) { return againstMe[b] - againstMe[a]; })[0];
    var worstName = worst
      ? (players.filter(function (p) { return p.animal === worst; })[0] || {}).display_name
      : null;

    return {
      youDidLast: myTurn.map(function (m) { return m.public_text; }).filter(Boolean),
      sinceThen: since.map(function (m) { return m.public_text; }).filter(Boolean).slice(-8),
      worstOffender: worst && againstMe[worst] > 1
        ? { name: worstName, count: againstMe[worst] } : null
    };
  }

  /* -------------------------------------------------- the WhatsApp nudge
     No bot, no Cloud API, no template approval. The player who just moved
     opens the group chat with the message already written and presses send.
     Their phone never needs anybody else's token, the link is just the
     room, identical for everyone. */

  function nudgeLink(view, baseUrl) {
    if (!view || view.turn == null) return null;
    var next = view.players[view.turn];
    if (!next) return null;
    var url = (baseUrl || '') + '/g/' + view.code;
    var text = next.emo + ' ' + next.name + ", you're up in The Bee's House."
             + '\nRound ' + view.round + ' of ' + view.rounds + '.'
             + '\n' + url;
    return {
      whatsapp: 'https://wa.me/?text=' + encodeURIComponent(text),
      text: text,
      forSeat: view.turn,
      forName: next.name
    };
  }

  /* ----------------------------------------------------------- seasons */

  /* A season can be started cold, or declared over a match that has just
     finished. The second is the one people actually use: five friends who
     have played once and want the next few to count. That match becomes
     match 1 rather than sitting outside its own season, which also means
     nobody has to decide to run a season before they know they want one. */
  async function createSeason(opts) {
    opts = opts || {};

    var promote = null;
    if (opts.fromCode) {
      var ctx = await resolve(opts.fromCode, opts.token);
      if (ctx.game.season_id) throw err(409, 'That match already belongs to a season.');
      if (ctx.round.state.phase !== 'matchEnd') throw err(409, 'That match is not over yet.');
      promote = ctx.game;
    }

    var code = null;
    for (var i = 0; i < 12 && !code; i++) {
      var c = DB.newCode(5);
      if (!(await db.getSeasonByCode(c))) code = c;
    }
    if (!code) throw err(500, 'Could not allocate a season code.');

    var target = Math.max(1, Math.min(50, Number(opts.matchTarget) || 5));
    if (promote && target < 2) throw err(400, 'A season of one match is just a match.');

    /* Seasons are just numbered. Nobody is going to type a name into a
       phone on the way out of a match, and "Season 3" is what the group
       chat will call it anyway. The count is global rather than per group
       because there is exactly one group. */
    var seasonNo = (await db.countSeasons()) + 1;
    var sn = await db.createSeason({ code: code, name: opts.name || ('Season ' + seasonNo),
                                     matchTarget: target });
    if (promote) await db.updateGame(promote.id, { season_id: sn.id, match_no: 1 });

    return { code: sn.code, name: sn.name, matchTarget: sn.match_target,
             status: sn.status, matchesPlayed: promote ? 1 : 0 };
  }

  /* The next match in a season. The roster travels: same animals, same
     names, same phone numbers, same turn clock. Nobody re-enters anything,
     because the entire premise of a season is that it is the same people.

     Five phones will press this at once, so it is written to be pressed
     twice. If a later match already exists and is unfinished, that IS the
     next match and everybody lands in it rather than dealing a second one. */
  async function nextMatch(code, token) {
    var ctx = await resolve(code, token);
    if (!ctx.game.season_id) throw err(409, 'This match is not part of a season.');

    var sn = await db.getSeason(ctx.game.season_id);
    if (!sn) throw err(404, 'That season is gone.');
    if (sn.status !== 'open') throw err(409, 'That season is over.');

    var games = await db.listSeasonGames(sn.id);
    var open = games.filter(function (g) { return g.status !== 'done'; })
                    .sort(function (a, b) { return b.match_no - a.match_no; })[0];
    if (open) {
      return { code: open.code, matchNo: open.match_no, target: sn.match_target,
               season: sn.code, existing: true };
    }
    if (games.length >= sn.match_target) throw err(409, 'That season is already full.');

    var roster = await db.listPlayers(ctx.game.id);
    var made = await createRoom({
      seasonCode: sn.code,
      turnClockHours: (ctx.game.settings || {}).turnClockHours,
      players: roster.slice().sort(function (a, b) { return a.seat - b.seat; })
                     .map(function (p) {
                       return { animal: p.animal, name: p.display_name, phone: p.phone };
                     })
    });
    return { code: made.code, matchNo: made.season ? made.season.matchNo : null,
             target: sn.match_target, season: sn.code, existing: false };
  }

  /* Running totals across every match in a season, and what the season
     looked like from the outside. `scores` does the arithmetic, `moves`
     does everything else.

     The code may be a season code OR the code of any room inside it,
     because the people opening this are holding a game link in a group
     chat, not a season one. */
  async function seasonStandings(code) {
    var key = String(code || '').toUpperCase();
    var sn = await db.getSeasonByCode(key);
    if (!sn) {
      var g0 = await db.getGameByCode(key);
      if (g0 && g0.season_id) sn = await db.getSeason(g0.season_id);
    }
    if (!sn) throw err(404, 'No season with that code.');

    var games = await db.listSeasonGames(sn.id);
    var ids = games.map(function (g) { return g.id; });
    var rows = await db.listScores(ids);

    // aggregate by animal: player rows are per game, the animal is the person
    var byAnimal = {};
    rows.forEach(function (r) {
      var k = r.animal;
      if (!k) return;
      byAnimal[k] = byAnimal[k] || { animal: k, total: 0, rounds: 0, matches: {} };
      byAnimal[k].total += Number(r.score);
      byAnimal[k].rounds += 1;
      byAnimal[k].matches[r.game_id] = true;
    });

    var table = Object.keys(byAnimal).map(function (k) {
      var def = Engine.ROSTER.filter(function (x) { return x.id === k; })[0] || {};
      var e = byAnimal[k];
      return { animal: k, name: def.name, emo: def.emo,
               total: e.total, rounds: e.rounds, matches: Object.keys(e.matches).length };
    }).sort(function (a, b) { return a.total - b.total; });

    /* Only finished matches feed the superlatives. A match still being
       played would otherwise contribute half a Tab to a season number, and
       worse, the standings would move under people mid-round. */
    var tab = [], acts = [];
    for (var gi = 0; gi < games.length; gi++) {
      if (games[gi].status !== 'done') continue;
      var ms = await db.listMoves(games[gi].id, { limit: 4000 });
      for (var mi = 0; mi < ms.length; mi++) {
        (ms[mi].type === 'TAB' ? tab : acts).push(ms[mi]);
      }
    }

    var finished = games.filter(function (g) { return g.status === 'done'; }).length;

    return {
      code: sn.code, name: sn.name, status: sn.status,
      matchTarget: sn.match_target,
      matchesPlayed: finished,
      matchesStarted: games.length,
      standings: table,
      extras: seasonExtras(tab, acts),
      /* The settlement only exists once the season is closed. A provisional
         one every week would let people play the settlement instead of the
         game, which is the opposite of the point. */
      settlement: sn.status === 'done' ? settleSeason(table, tab) : null,
      games: games.map(function (g) {
        return { code: g.code, matchNo: g.match_no, status: g.status, finishedAt: g.finished_at };
      })
    };
  }

  /* ------------------------------------------------------------- recap
     What actually happened, rather than a column of numbers.
     Every line is a query over `moves`, which has carried an actor and a
     victim list on every row since Phase 1. No new storage, nothing to keep
     in sync, and it cannot disagree with the Tab because it IS the Tab. */

  async function matchRecap(code, token) {
    var ctx = await resolve(code, token);
    var st = ctx.round.state;
    if (st.phase !== 'matchEnd') throw err(409, 'The match is not over yet.');

    var moves = await db.listMoves(ctx.game.id, { limit: 4000 });
    var players = await db.listPlayers(ctx.game.id);
    var nameOf = {};
    st.players.forEach(function (p) { nameOf[p.id] = p.name; });
    var emoOf = {};
    st.players.forEach(function (p) { emoOf[p.id] = p.emo; });

    var tab = moves.filter(function (m) { return m.type === 'TAB'; });
    var acts = moves.filter(function (m) { return m.type !== 'TAB'; });

    function count(pred) {
      var c = {};
      acts.filter(pred).forEach(function (m) {
        var id = m.actor_id; if (!id) return;
        c[id] = (c[id] || 0) + 1;
      });
      return c;
    }
    function top(c) {
      var k = Object.keys(c).sort(function (a, b) { return c[b] - c[a]; })[0];
      return k ? { id: k, name: nameOf[k], emo: emoOf[k], n: c[k] } : null;
    }

    // who swept, and how many cards died doing it
    var sweeps = count(function (m) { return m.type === 'SWEEP'; });
    var swept = top(sweeps);
    var cardsKilled = 0;
    tab.forEach(function (m) {
      var hit = /swept the floor\. (\d+) card/.exec(m.public_text || '');
      if (hit) cardsKilled += Number(hit[1]);
    });

    // who spent the match being interfered with
    var against = {};
    tab.forEach(function (m) {
      (m.victim_ids || []).forEach(function (v) { against[v] = (against[v] || 0) + 1; });
    });
    var pickedOn = top(against) || null;
    if (pickedOn) pickedOn = { id: pickedOn.id, name: nameOf[pickedOn.id],
                               emo: emoOf[pickedOn.id], n: against[pickedOn.id] };

    // cabo: who called, and who paid for it
    var caboCalls = tab.filter(function (m) { return /called Cabo/.test(m.public_text || ''); }).length;
    var busts = tab.filter(function (m) { return /called Cabo and missed/.test(m.public_text || ''); })
                   .map(function (m) { return (m.public_text || '').split(' ')[0]; });

    // who was holding a red king when the hands flipped
    var redKings = [];
    st.players.forEach(function (p) {
      p.hand.forEach(function (c) {
        if (c.r === 'K' && Engine.isRed(c)) redKings.push({ name: p.name, emo: p.emo });
      });
    });

    // slowest player, from the timestamps already on every row
    var last = {}, gaps = {};
    acts.forEach(function (m) {
      var t = new Date(m.created_at).getTime();
      if (last[m.seat] != null) {
        var g = t - last[m.seat];
        if (g > (gaps[m.seat] || 0)) gaps[m.seat] = g;
      }
      last[m.seat] = t;
    });
    var slowSeat = Object.keys(gaps).sort(function (a, b) { return gaps[b] - gaps[a]; })[0];
    var slowest = slowSeat != null && st.players[slowSeat]
      ? { name: st.players[slowSeat].name, emo: st.players[slowSeat].emo,
          hours: +(gaps[slowSeat] / 3600000).toFixed(1) }
      : null;

    /* Who ran out of time. The skip row is recorded against the person who
       was skipped, not whoever pressed it, so this counts the right one. */
    var skipped = top(count(function (m) { return m.type === 'SKIP_TURN'; }));

    // the quiet one: Hush leaves a hole in the record, and the recap says so
    var hushes = tab.filter(function (m) { return /Nobody heard what/.test(m.public_text || ''); }).length;

    /* The single most obnoxious thing anybody did. Ranked, because a sweep
       is already the headline above it and quoting it twice reads like the
       recap ran out of material. Highest rank that actually occurred wins,
       most recent within that rank. */
    var WORST = [/called Cabo and missed/, /stung/, /emptied their hand/, /shed/,
                 /swept the floor/, /dumped/];
    var worst = null;
    for (var wi = 0; wi < WORST.length && !worst; wi++) {
      worst = tab.filter(function (m) { return WORST[wi].test(m.public_text || ''); }).slice(-1)[0] || null;
    }

    return {
      swept: swept, cardsKilled: cardsKilled,
      pickedOn: pickedOn,
      caboCalls: caboCalls, busts: busts,
      redKings: redKings,
      slowest: slowest,
      skipped: skipped,
      hushes: hushes,
      worstLine: worst ? worst.public_text : null,
      totalMoves: acts.length,
      totalTab: tab.length
    };
  }

  /* ------------------------------------------------------------ replay
     Everything that happened in a finished round, in order, with the cards.
     Refuses a round still in play: during a round the same data would tell
     you exactly where every known card sits, which is the whole game. */
  async function replay(code, token, roundN) {
    var ctx = await resolve(code, token);
    var n = roundN == null ? ctx.round.n : Number(roundN);

    var target = await db.getRound(ctx.game.id, n);
    if (!target) throw err(404, 'No such round.');
    var over = target.state.phase === 'roundEnd' || target.state.phase === 'matchEnd'
               || n < ctx.round.n;
    if (!over) throw err(409, 'That round is still being played. Nothing to read yet.');

    var all = await db.listMoves(ctx.game.id, { limit: 2000 });
    var names = {};
    ctx.round.state.players.forEach(function (p, i) { names[i] = p.name; });

    var steps = all
      .filter(function (m) { return m.round_n === n && m.type !== 'TAB'; })
      .map(function (m) {
        var d = m.payload || {};
        return {
          id: m.id, at: m.created_at, seat: m.seat, who: names[m.seat] || ('seat ' + m.seat),
          move: m.type,
          card: d.card || null,
          slot: d.slot == null ? null : d.slot,
          target: d.target == null ? null : names[d.target],
          slapped: d.slapped || null,
          hushed: !!d.hushed
        };
      });

    return { round: n, steps: steps,
             tab: all.filter(function (m) { return m.round_n === n && m.type === 'TAB'; })
                     .map(function (m) { return m.public_text; }).filter(Boolean) };
  }

  return {
    createRoom: createRoom, openRoom: openRoom, liveRoom: liveRoom,
    roomInfo: roomInfo, claimSeat: claimSeat, setPhone: setPhone,
    replay: replay, matchRecap: matchRecap, createSeason: createSeason, seasonStandings: seasonStandings, nextMatch: nextMatch,
    peek: peek, ready: ready, getState: getState, applyMove: applyMove, nextRound: nextRound,
    skipTurn: skipTurn, turnClock: turnClock,
    requestSeat: requestSeat, decideSeat: decideSeat,
    nudgeLink: nudgeLink, buildBriefing: buildBriefing,
    LISTEN_QUESTIONS: LISTEN_QUESTIONS
  };
}

module.exports = { makeService: makeService, LISTEN_QUESTIONS: LISTEN_QUESTIONS,
                   TURN_CLOCK_HOURS: TURN_CLOCK_HOURS };

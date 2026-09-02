/* The Bee's House — application service.
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

function err(code, message, extra) {
  var e = new Error(message);
  e.status = code;
  if (extra) Object.assign(e, extra);
  return e;
}

/* Actions a player may send. Anything not on this list is rejected before
   it reaches the engine — the engine is trusted, the network is not. */
var ALLOWED_MOVES = new Set([
  'DRAW', 'TAKE_DISCARD', 'PLACE', 'DISCARD_DRAWN',
  'PEEK_OWN', 'SPY', 'SWAP_DO', 'LISTEN_ANSWER',
  'SLAP_TOGGLE', 'SLAP_GO', 'SWEEP',
  'ABILITY', 'NECK_DONE', 'STING_DONE',
  'CABO', 'END_TURN', 'CLOSE_MODAL'
]);

/* Questions Listen is allowed to ask. The client sends an index, never a
   value, so the answer is computed server-side and the card never travels. */
var LISTEN_QUESTIONS = [
  { q: 'Is it even?',         f: function (v) { return v % 2 === 0; } },
  { q: 'Is it under 5?',      f: function (v) { return v < 5; } },
  { q: 'Is it over 9?',       f: function (v) { return v > 9; } },
  { q: 'Is it a power card?', f: function (v) { return !!Engine.powerOf(v); } }
];

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

    await db.addPlayers(game.id, roster.map(function (p, i) {
      var def = Engine.ROSTER.filter(function (r) { return r.id === p.animal; })[0] || Engine.ROSTER[i];
      return { animal: def.id, name: p.name || def.name, seat: i, phone: p.phone || null };
    }));

    // deal round 1 immediately — there is no lobby to wait in
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

    return { code: code, gameId: game.id, players: players };
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
    return { game: game, player: player, seat: player.seat, round: round };
  }

  /* --------------------------------------------------- the opening peek
     Discovered while building this: the peek phase mutates no cards at all
     — SETUP_TOGGLE only writes a UI array and SETUP_NEXT clears it. So the
     peek can be parallel with no engine change. Each player asks for their
     two cards, gets them once as a reveal, and when everyone has looked the
     engine is walked forward to the first turn. */

  async function peek(code, token, indices) {
    var ctx = await resolve(code, token);
    var s = ctx.round.state;
    if (s.phase !== 'peek') throw err(409, 'The opening peek is over.');
    var all = await db.listPlayers(ctx.game.id);
    var unclaimed = all.filter(function (p) { return !p.token_hash; });
    if (unclaimed.length) {
      throw err(409, 'Still waiting for ' + unclaimed.map(function (p) { return p.display_name; }).join(', ')
                     + ' to open the link.');
    }
    if (!Array.isArray(indices) || indices.length !== 2) throw err(400, 'Pick exactly two cards.');

    var me = s.players[ctx.seat];
    var uniq = Array.from(new Set(indices));
    if (uniq.length !== 2 || uniq.some(function (i) { return !(i >= 0 && i < me.hand.length); })) {
      throw err(400, 'Pick two different cards from your own hand.');
    }

    var settings = ctx.game.settings || {};
    var peeked = (settings.peeked || []).slice();
    if (peeked.indexOf(ctx.seat) < 0) peeked.push(ctx.seat);

    var cards = uniq.map(function (i) { return { slot: i, v: me.hand[i].v }; });

    // everyone has looked → walk the engine to the first turn
    if (peeked.length >= s.players.length) {
      var next = s;
      for (var i = 0; i < s.players.length; i++) {
        next = Engine.reducer(next, { type: 'SETUP_NEXT' });
      }
      if (next.phase === 'curtain') next = Engine.reducer(next, { type: 'LIFT_CURTAIN' });
      await db.saveRound(ctx.game.id, ctx.round.n, next, ctx.round.version);
    }
    await db.updateGame(ctx.game.id, { settings: Object.assign({}, settings, { peeked: peeked }) });

    return {
      reveal: { kind: 'cards', title: 'Your two cards',
                sub: 'Look properly. Neither the table nor this app will show them again.',
                cards: cards },
      waitingFor: Math.max(0, s.players.length - peeked.length)
    };
  }

  /* -------------------------------------------------------------- state */

  async function getState(code, token) {
    var ctx = await resolve(code, token);
    var players = await db.listPlayers(ctx.game.id);
    var view = Redact.viewFor(ctx.round.state, ctx.seat, {
      code: code, version: ctx.round.version, updatedAt: ctx.round.updatedAt
    });
    // GET never carries a reveal — that is what makes refresh non-cheaty
    Redact.assertNoLeak(view, ctx.round.state, ctx.seat);
    view.roster = players.map(function (p) {
      return { seat: p.seat, animal: p.animal, name: p.display_name,
               phone: p.phone, claimed: !!p.token_hash, lastSeen: p.last_seen_at };
    });
    view.settings = ctx.game.settings;
    var unclaimed = players.filter(function (p) { return !p.token_hash; });
    view.allClaimed = unclaimed.length === 0;
    view.waitingFor = unclaimed.map(function (p) {
      var def = Engine.ROSTER.filter(function (r) { return r.id === p.animal; })[0] || {};
      return { seat: p.seat, name: p.display_name, emo: def.emo };
    });
    view.peekDone = ((ctx.game.settings || {}).peeked || []).indexOf(ctx.seat) >= 0;
    view.turnClockHours = (ctx.game.settings || {}).turnClockHours || TURN_CLOCK_HOURS;
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
      action.ans = q.f(target.hand[action.idx].v) ? 'Yes.' : 'No.';
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
    var rows = [{
      game_id: ctx.game.id, round_n: ctx.round.n, seat: ctx.seat, type: move.type,
      payload: {}, public_text: null,
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
    var after = Engine.reducer(s, { type: 'NEXT_ROUND' });
    if (after.phase === 'matchEnd') {
      await db.saveRound(ctx.game.id, ctx.round.n, after, ctx.round.version);
      await db.updateGame(ctx.game.id, { status: 'done' });
    } else {
      await db.putRound(ctx.game.id, after.round, after);
      var settings = ctx.game.settings || {};
      await db.updateGame(ctx.game.id, { settings: Object.assign({}, settings, { peeked: [] }) });
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
    // That block is exactly my previous turn — not the last three things I
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
     Their phone never needs anybody else's token — the link is just the
     room, identical for everyone. */

  function nudgeLink(view, baseUrl) {
    if (!view || view.turn == null) return null;
    var next = view.players[view.turn];
    if (!next) return null;
    var url = (baseUrl || '') + '/g/' + view.code;
    var text = next.emo + ' ' + next.name + " — you're up in The Bee's House."
             + '\nRound ' + view.round + ' of ' + view.rounds + '.'
             + '\n' + url;
    return {
      whatsapp: 'https://wa.me/?text=' + encodeURIComponent(text),
      text: text,
      forSeat: view.turn,
      forName: next.name
    };
  }

  return {
    createRoom: createRoom, roomInfo: roomInfo, claimSeat: claimSeat, setPhone: setPhone,
    peek: peek, getState: getState, applyMove: applyMove, nextRound: nextRound,
    nudgeLink: nudgeLink, buildBriefing: buildBriefing,
    LISTEN_QUESTIONS: LISTEN_QUESTIONS
  };
}

module.exports = { makeService: makeService, LISTEN_QUESTIONS: LISTEN_QUESTIONS,
                   TURN_CLOCK_HOURS: TURN_CLOCK_HOURS };

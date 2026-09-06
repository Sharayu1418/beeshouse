/* The Bee's House — redaction layer.
 *
 * This is the security boundary. Full game state goes in, one player's
 * permitted view comes out. Nothing else in the codebase is allowed to
 * send game state to a browser.
 *
 * Two rules do most of the work:
 *
 *   1. Card values never leave here — not even your own. The game is
 *      memory; the app must not remember for you.
 *
 *   2. A value you have *earned* the right to see is returned exactly
 *      once, in a separate `reveal` envelope attached to the response of
 *      the move that earned it. GET /api/state never carries a reveal,
 *      so refreshing the page cannot re-show you a card.
 *
 * The only permanent exceptions are the top of the discard pile, which is
 * face up on the table and public by definition, and the card you are
 * currently holding mid-turn, which is in your hand and yours to look at.
 */
'use strict';

var Engine = require('./engine.js');

/* A card the whole table may see: rank, suit, and the value derived from
   them. Used only for the discard top, an earned reveal, and round-end hands. */
function publicCard(c) {
  return c ? { id: c.id, r: c.r, s: c.s, v: Engine.valueOf(c) } : null;
}

/* Card only its position is knowable — the shape the client renders as a back. */
function hiddenCard(c, slot) {
  return { id: c.id, slot: slot };
}

/**
 * Build one seat's view of the game.
 *
 * @param {object} state   full engine state
 * @param {number} seat    which player is asking
 * @param {object} meta    { code, version, updatedAt, phones }
 */
function viewFor(state, seat, meta) {
  meta = meta || {};
  var me = state.players[seat];
  var isMyTurn = state.turn === seat && state.phase === 'turn';

  var view = {
    code: meta.code || null,
    version: meta.version == null ? 0 : meta.version,
    phase: state.phase,
    round: state.round,
    rounds: Engine.ROUNDS,

    you: me ? {
      seat: seat,
      id: me.id,
      name: me.name,
      emo: me.emo,
      animal: me.animal,
      ability: me.ability,
      abilityUsed: !!me.abilityUsed,
      sweepUsed: !!me.sweepUsed,
      // ids and slots only. No values. This is the line that matters.
      hand: me.hand.map(hiddenCard)
    } : null,

    players: state.players.map(function (p, i) {
      return {
        seat: i,
        id: p.id,
        name: p.name,
        emo: p.emo,
        animal: p.animal,
        ability: p.ability,
        abilityUsed: !!p.abilityUsed,
        sweepUsed: !!p.sweepUsed,
        handCount: p.hand.length,
        // positions so the client can render backs to click, never values
        slots: p.hand.map(function (c, k) { return { id: c.id, slot: k }; }),
        isTurn: state.turn === i && state.phase === 'turn',
        calledCabo: state.caboBy === i
      };
    }),

    // public by definition — it is face up on the table
    discardTop: publicCard(state.discard.length ? state.discard[state.discard.length - 1] : null),
    discardCount: state.discard.length,
    deckCount: state.deck.length,

    turn: state.turn,
    caboBy: state.caboBy,
    finalLeft: state.finalLeft,
    yourTurn: isMyTurn,
    pendingEnd: !!state.pendingEnd,
    extra: state.extra || 0,
    sel: isMyTurn ? (state.sel || []) : [],

    // the *kind* of prompt open, never its secret contents
    modalKind: state.modal ? state.modal.kind : null,

    // a card in your hand mid-turn is yours to look at
    drawn: (isMyTurn && state.drawn)
      ? { id: state.drawn.card.id, r: state.drawn.card.r, s: state.drawn.card.s,
          v: Engine.valueOf(state.drawn.card), from: state.drawn.from }
      : null,

    // the Tab: text and attribution. The price stays hidden until settlement.
    tab: (state.log || []).map(function (e) {
      return { r: e.r, t: e.t, by: e.by || null, to: e.to || [] };
    }),

    totals: state.totals || {},
    lastScores: state.phase === 'roundEnd' || state.phase === 'matchEnd'
      ? (state.lastScores || []) : null,

    // hands are only ever revealed when the round is genuinely over
    reveal_all: (state.phase === 'roundEnd' || state.phase === 'matchEnd')
      ? state.players.map(function (p) {
          return { seat: p.seat, id: p.id, hand: p.hand.map(publicCard) };
        })
      : null,

    updatedAt: meta.updatedAt || null
  };

  return view;
}

/**
 * Pull out the one-time reveal earned by the move just played, if any.
 * Returned alongside the view from POST /api/move and NEVER from GET /api/state.
 * Returns null when the move earned nothing.
 */
function revealFor(state, seat) {
  if (state.turn !== seat) return null;
  var m = state.modal;
  if (!m) return null;

  if (m.kind === 'reveal') {
    return { kind: 'card', title: m.title, sub: m.sub, card: publicCard(m.card) };
  }
  if (m.kind === 'listenResult') {
    return { kind: 'answer', q: m.q, ans: m.ans, who: m.who };
  }
  return null;
}

/**
 * Belt and braces. Walks a response object and throws if any card value
 * that the seat is not entitled to has slipped through. Wired into every
 * API response in development and into the test suite always.
 */
function assertNoLeak(payload, state, seat) {
  var allowed = new Set();

  // the discard top is public
  if (state.discard.length) allowed.add(state.discard[state.discard.length - 1].id);
  // the card you are holding mid-turn
  if (state.turn === seat && state.drawn) allowed.add(state.drawn.card.id);
  // at round end every hand is on the table
  if (state.phase === 'roundEnd' || state.phase === 'matchEnd') {
    state.players.forEach(function (p) { p.hand.forEach(function (c) { allowed.add(c.id); }); });
  }
  // the whole discard pile is public history
  state.discard.forEach(function (c) { allowed.add(c.id); });

  var problems = [];
  (function walk(node, path) {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach(function (n, i) { walk(n, path + '[' + i + ']'); });
      return;
    }
    if (typeof node !== 'object') return;

    /* A card object is identifying if it carries ANY of the three things
       that reveal what it is. With a real deck, rank and suit give the card
       away just as completely as the value does — a leaked "K of hearts" is
       a leaked -1 — so all three are checked, not just the number. */
    var looksLikeCard = typeof node.id === 'string' && /^c\d+$|^p\d+$/.test(node.id);
    if (looksLikeCard) {
      var tells = [];
      if (typeof node.v === 'number') tells.push('value ' + node.v);
      if (typeof node.r === 'string') tells.push('rank ' + node.r);
      if (typeof node.s === 'string') tells.push('suit ' + node.s);
      if (tells.length && !allowed.has(node.id)) {
        problems.push(path + ' exposes card ' + node.id + ' (' + tells.join(', ') + ')');
      }
    }
    Object.keys(node).forEach(function (k) { walk(node[k], path + '.' + k); });
  })(payload, 'response');

  if (problems.length) {
    throw new Error('REDACTION LEAK for seat ' + seat + ':\n  ' + problems.join('\n  '));
  }
  return true;
}

module.exports = { viewFor: viewFor, revealFor: revealFor, assertNoLeak: assertNoLeak };

/* The Bee's House, motion.
 *
 * The client is a renderer: it gets a new view from the server and paints
 * it. Nothing in that loop knows a card *moved*, only that the screen looks
 * different. You cannot animate a difference you never computed.
 *
 * So this module does two things:
 *
 *   diff(prev, next)  what actually changed: two views and says what actually happened,
 *                       in terms of card ids: "c31 went from Sahil's slot 2
 *                       to the discard". That sentence is the animation.
 *
 *   flip(before)     the FLIP technique. Measure where cards are, let
 *                       React repaint, measure again, transform each card
 *                       back to where it was, then release. Elements glide
 *                       between two layouts without anyone hand-writing
 *                       coordinates, and it survives any screen size.
 *
 * Everything here is cosmetic. The server has already decided what
 * happened; this is a replay. If a frame drops the game is still correct.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Anim = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

var reduced = typeof matchMedia === 'function' &&
              matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------------------------------------------------------- diff */

/* Every card id in a view, mapped to where it currently sits. */
function placesIn(view) {
  var m = {};
  if (!view) return m;
  if (view.you) view.you.hand.forEach(function (c, i) {
    m[c.id] = { where: 'hand', seat: view.you.seat, slot: i };
  });
  (view.players || []).forEach(function (p) {
    (p.slots || []).forEach(function (c, i) {
      if (!m[c.id]) m[c.id] = { where: 'hand', seat: p.seat, slot: i };
    });
  });
  if (view.discardTop) m[view.discardTop.id] = { where: 'discard' };
  if (view.drawn) m[view.drawn.id] = { where: 'drawn' };
  return m;
}

function sameSpot(a, b) {
  if (!a || !b) return false;
  return a.where === b.where && a.seat === b.seat && a.slot === b.slot;
}

/**
 * What changed between two views.
 * @returns {{moved:Array, arrived:Array, left:Array, swept:boolean,
 *            dealt:boolean, cabo:boolean}}
 */
function diff(prev, next) {
  var out = { moved: [], arrived: [], left: [], swept: false, dealt: false, cabo: false };
  if (!prev || !next) { out.dealt = !!next; return out; }

  var a = placesIn(prev), b = placesIn(next);

  Object.keys(b).forEach(function (id) {
    if (!a[id]) out.arrived.push({ id: id, to: b[id] });
    else if (!sameSpot(a[id], b[id])) out.moved.push({ id: id, from: a[id], to: b[id] });
  });
  Object.keys(a).forEach(function (id) { if (!b[id]) out.left.push({ id: id, from: a[id] }); });

  // the discard pile emptying with nobody taking anything is a sweep
  if (prev.discardCount > 0 && next.discardCount === 0) out.swept = true;
  if (prev.round !== next.round || prev.phase !== next.phase && next.phase === 'turn') out.dealt = false;
  if (prev.caboBy === null && next.caboBy !== null) out.cabo = true;

  return out;
}

/* ---------------------------------------------------------------- FLIP */

function measure(container) {
  var boxes = {};
  if (!container) return boxes;
  var nodes = container.querySelectorAll('[data-card]');
  for (var i = 0; i < nodes.length; i++) {
    var id = nodes[i].getAttribute('data-card');
    if (id) boxes[id] = nodes[i].getBoundingClientRect();
  }
  return boxes;
}

/**
 * Run `apply` (which repaints the DOM), then glide every card that moved
 * from where it used to be to where it now is.
 */
function flip(container, before, opts) {
  if (reduced || !container) return;
  opts = opts || {};
  var after = measure(container);

  Object.keys(after).forEach(function (id) {
    var from = before[id], to = after[id];
    if (!from) return;
    var dx = from.left - to.left, dy = from.top - to.top;
    if (Math.abs(dx) < 1.5 && Math.abs(dy) < 1.5) return;

    var el = container.querySelector('[data-card="' + cssEscape(id) + '"]');
    if (!el) return;

    el.classList.remove('moving');
    el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    // force the browser to accept the start position before releasing
    void el.offsetWidth;
    el.classList.add('moving');
    el.style.transform = '';

    var done = function () {
      el.classList.remove('moving');
      el.removeEventListener('transitionend', done);
    };
    el.addEventListener('transitionend', done);
    setTimeout(done, 700);   // never leave a card stuck mid-move
  });
}

function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }

/* ------------------------------------------------------------ one-offs */

function flipCard(el) {
  if (reduced || !el) return;
  el.classList.remove('flipping');
  void el.offsetWidth;
  el.classList.add('flipping');
  setTimeout(function () { el.classList.remove('flipping'); }, 500);
}

function dealIn(container, stagger) {
  if (reduced || !container) return;
  var nodes = container.querySelectorAll('.hand .card');
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    el.style.setProperty('--delay', (i * (stagger || 60)) + 'ms');
    el.style.setProperty('--dr', ((Math.random() * 20) - 10).toFixed(1) + 'deg');
    el.classList.add('dealing');
    (function (n) { setTimeout(function () { n.classList.remove('dealing'); }, 900); })(el);
  }
}

/* The discard pile blowing off the table. */
function sweepAway(pileEl) {
  if (reduced || !pileEl) return;
  var cards = pileEl.querySelectorAll('.card');
  for (var i = 0; i < cards.length; i++) {
    var c = cards[i];
    var ang = Math.random() * Math.PI * 2;
    c.style.setProperty('--sx', (Math.cos(ang) * 260).toFixed(0) + 'px');
    c.style.setProperty('--sy', (Math.sin(ang) * 200 - 60).toFixed(0) + 'px');
    c.style.setProperty('--sr', ((Math.random() * 160) - 80).toFixed(0) + 'deg');
  }
  pileEl.classList.add('sweeping');
  setTimeout(function () { pileEl.classList.remove('sweeping'); }, 700);
}

function caboPulse(shellEl) {
  if (reduced || !shellEl) return;
  shellEl.classList.add('cabo');
  setTimeout(function () { shellEl.classList.remove('cabo'); }, 1100);
}

/* ---------------------------------------------------------- gestures
 *
 * Motion the diff cannot find, because nothing moved.
 *
 * Somebody looking at one of their own cards changes no position, so FLIP
 * has nothing to glide. But at a real table it is the most visible thing
 * anybody does: they pick a card up, tilt it toward their face, and put it
 * back, and four other people watch them do it. That is what these are.
 *
 * None of them can show a face. They act on the element that renders a
 * card BACK, and the back has no value in it to reveal.
 */

/* Picked up, tilted away from the table, set down again. */
function lookAt(el, delay) {
  if (reduced || !el) return;
  el.style.setProperty('--lookdelay', (delay || 0) + 'ms');
  el.classList.remove('looking');
  void el.offsetWidth;
  el.classList.add('looking');
  setTimeout(function () { el.classList.remove('looking'); }, 1100 + (delay || 0));
}

/* Two cards that just traded places. FLIP already carries them across; this
   says the movement was deliberate rather than a layout drift. */
function exchange(els) {
  if (reduced) return;
  (els || []).forEach(function (el) {
    if (!el) return;
    el.classList.remove('trading');
    void el.offsetWidth;
    el.classList.add('trading');
    setTimeout(function () { el.classList.remove('trading'); }, 760);
  });
}

/* A hand shuffled into itself. Deliberately unreadable: every card lifts at
   once, they all turn together, and they come down. There is no path to
   follow, because after a shed there is genuinely nothing to follow. */
function shedHand(els) {
  if (reduced) return;
  (els || []).forEach(function (el, i) {
    if (!el) return;
    el.style.setProperty('--shx', (((i % 2) ? 1 : -1) * (9 + Math.random() * 8)).toFixed(0) + 'px');
    el.style.setProperty('--shr', (((Math.random() * 36) - 18)).toFixed(0) + 'deg');
    el.classList.remove('shedding');
    void el.offsetWidth;
    el.classList.add('shedding');
    setTimeout(function () { el.classList.remove('shedding'); }, 820);
  });
}

/* Somebody took a card. No id, because a watcher is not entitled to one:
   just a back rising off the pile. */
function pickUp(pileEl) {
  if (reduced || !pileEl) return;
  pileEl.classList.remove('picking');
  void pileEl.offsetWidth;
  pileEl.classList.add('picking');
  setTimeout(function () { pileEl.classList.remove('picking'); }, 520);
}

function settle(el) {
  if (reduced || !el) return;
  el.classList.add('settling');
  setTimeout(function () { el.classList.remove('settling'); }, 320);
}

return { diff: diff, placesIn: placesIn, measure: measure, flip: flip,
         flipCard: flipCard, dealIn: dealIn, sweepAway: sweepAway,
         caboPulse: caboPulse, settle: settle, reduced: reduced,
         lookAt: lookAt, exchange: exchange, shedHand: shedHand, pickUp: pickUp };
}));

/* The Bee's House, card faces.
 *
 * Every card is drawn as SVG at render time. No images, no sprite sheet,
 * no Unicode playing-card glyphs (🂡 renders differently in every font and
 * is illegible at 64px). SVG means crisp at any size, themeable, nothing
 * to load, and nothing to 404.
 *
 * One rule the artwork obeys deliberately: a king shows nothing about its
 * value. A red king is worth -1 and a black king 13, and the only thing
 * that distinguishes them is the suit, which is exactly the trap the real
 * deck exists to create.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Cards = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

var W = 100, H = 140;                      // viewBox; the CSS scales it
var RED = '#C8102E', BLACK = '#15181E';

/* Suit paths, each drawn inside a 100x100 box centred on (50,50). */
var SUIT_PATH = {
  S: 'M50 12 C 36 30, 16 40, 16 57 C 16 70, 27 78, 37 78 C 43 78, 47 75, 50 71'
   + ' C 53 75, 57 78, 63 78 C 73 78, 84 70, 84 57 C 84 40, 64 30, 50 12 Z'
   + ' M50 68 C 48 78, 45 84, 40 88 L 60 88 C 55 84, 52 78, 50 68 Z',
  H: 'M50 88 C 30 72, 14 58, 14 41 C 14 28, 24 20, 34 20 C 42 20, 47 25, 50 31'
   + ' C 53 25, 58 20, 66 20 C 76 20, 86 28, 86 41 C 86 58, 70 72, 50 88 Z',
  D: 'M50 12 C 60 32, 72 44, 82 50 C 72 56, 60 68, 50 88 C 40 68, 28 56, 18 50'
   + ' C 28 44, 40 32, 50 12 Z',
  C: 'M50 16 C 41 16, 34 23, 34 32 C 34 36, 35 39, 37 42 C 34 40, 31 39, 27 39'
   + ' C 18 39, 11 46, 11 55 C 11 64, 18 71, 27 71 C 35 71, 41 66, 44 60'
   + ' C 45 68, 44 76, 40 88 L 60 88 C 56 76, 55 68, 56 60 C 59 66, 65 71, 73 71'
   + ' C 82 71, 89 64, 89 55 C 89 46, 82 39, 73 39 C 69 39, 66 40, 63 42'
   + ' C 65 39, 66 36, 66 32 C 66 23, 59 16, 50 16 Z'
};

/* Classic pip layouts, in fractions of the pip field. The bottom half of a
   real card is printed upside down, so anything below the midline is
   rotated 180 degrees, that flag is what makes these read as playing
   cards rather than as dot grids. */
var LAYOUT = {
  'A':  [[0.5, 0.5]],
  '2':  [[0.5, 0.16], [0.5, 0.84]],
  '3':  [[0.5, 0.16], [0.5, 0.50], [0.5, 0.84]],
  '4':  [[0.26, 0.16], [0.74, 0.16], [0.26, 0.84], [0.74, 0.84]],
  '5':  [[0.26, 0.16], [0.74, 0.16], [0.5, 0.50], [0.26, 0.84], [0.74, 0.84]],
  '6':  [[0.26, 0.16], [0.74, 0.16], [0.26, 0.50], [0.74, 0.50], [0.26, 0.84], [0.74, 0.84]],
  '7':  [[0.26, 0.16], [0.74, 0.16], [0.5, 0.33], [0.26, 0.50], [0.74, 0.50],
         [0.26, 0.84], [0.74, 0.84]],
  '8':  [[0.26, 0.16], [0.74, 0.16], [0.5, 0.33], [0.26, 0.50], [0.74, 0.50],
         [0.5, 0.67], [0.26, 0.84], [0.74, 0.84]],
  '9':  [[0.26, 0.14], [0.74, 0.14], [0.26, 0.38], [0.74, 0.38], [0.5, 0.50],
         [0.26, 0.62], [0.74, 0.62], [0.26, 0.86], [0.74, 0.86]],
  '10': [[0.26, 0.14], [0.74, 0.14], [0.5, 0.26], [0.26, 0.38], [0.74, 0.38],
         [0.26, 0.62], [0.74, 0.62], [0.5, 0.74], [0.26, 0.86], [0.74, 0.86]]
};

var FIELD = { x: 21, y: 19, w: 58, h: 103 };   // where pips live inside the card

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;'); }

function suitGlyph(suit, cx, cy, size, colour, rotate) {
  var k = size / 100;
  var t = 'translate(' + (cx - size / 2) + ',' + (cy - size / 2) + ') scale(' + k + ')';
  if (rotate) t = 'rotate(180 ' + cx + ' ' + cy + ') ' + t;
  return '<path d="' + SUIT_PATH[suit] + '" transform="' + t + '" fill="' + colour + '"/>';
}

/* The rank + suit block in the corner, mirrored bottom-right like a real card. */
function corner(rank, suit, colour, flip) {
  var x = flip ? W - 11 : 11, y = flip ? H - 12 : 12;
  var g = '<text x="' + x + '" y="' + y + '" fill="' + colour + '"'
        + ' font-family="Bricolage Grotesque, Arial Black, sans-serif" font-weight="800"'
        + ' font-size="' + (rank === '10' ? 17 : 20) + '" text-anchor="middle"'
        + ' dominant-baseline="middle">' + esc(rank) + '</text>'
        + suitGlyph(suit, x, y + 15, 13, colour, false);
  if (flip) g = '<g transform="rotate(180 ' + (W / 2) + ' ' + (H / 2) + ')">'
              + g.replace('x="' + x + '"', 'x="' + (W - x) + '"')
              + '</g>';
  return flip
    ? '<g transform="rotate(180 ' + (W/2) + ' ' + (H/2) + ')">'
      + '<text x="11" y="12" fill="' + colour + '"'
      + ' font-family="Bricolage Grotesque, Arial Black, sans-serif" font-weight="800"'
      + ' font-size="' + (rank === '10' ? 17 : 20) + '" text-anchor="middle"'
      + ' dominant-baseline="middle">' + esc(rank) + '</text>'
      + suitGlyph(suit, 11, 27, 13, colour, false) + '</g>'
    : g;
}

/* Pip size has to fall as the count rises or the crowded ranks collide.
   Row spacing on a nine is 24 units, so a 20-unit pip leaves a 4-unit gap
   and reads as a smudge. Tuned per rank by looking at the contact sheet. */
var PIP_SIZE = { 'A': 46, '2': 22, '3': 22, '4': 22, '5': 22,
                 '6': 20, '7': 19, '8': 18, '9': 16, '10': 16 };

function pips(rank, suit, colour) {
  var pts = LAYOUT[rank];
  if (!pts) return '';
  var size = PIP_SIZE[rank] || 20;
  return pts.map(function (p) {
    var cx = FIELD.x + p[0] * FIELD.w;
    var cy = FIELD.y + p[1] * FIELD.h;
    return suitGlyph(suit, cx, cy, size, colour, p[1] > 0.55);
  }).join('');
}

/* Court cards. Not illustrated figures, a bad line drawing of a jack at
   64px is worse than nothing. A large suit with the letter set over it,
   which reads instantly at any size. */
function court(rank, suit, colour) {
  return '<rect x="24" y="30" width="52" height="80" rx="5" fill="none"'
       + ' stroke="' + colour + '" stroke-opacity="0.28" stroke-width="1.5"/>'
       + suitGlyph(suit, 50, 70, 58, colour, false)
       + '<text x="50" y="74" text-anchor="middle" dominant-baseline="middle"'
       + ' font-family="Bricolage Grotesque, Arial Black, sans-serif" font-weight="800"'
       + ' font-size="34" fill="#FBF7EC" stroke="' + colour + '" stroke-width="1.2"'
       + ' paint-order="stroke">' + esc(rank) + '</text>';
}

/**
 * SVG markup for one card face.
 * @param {object} card  { r, s }
 */
function face(card) {
  if (!card || !card.r) return '';
  var suit = card.s, rank = card.r;
  var colour = (suit === 'H' || suit === 'D') ? RED : BLACK;
  var body = LAYOUT[rank] ? pips(rank, suit, colour) : court(rank, suit, colour);

  return '<svg class="cardface" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg"'
       + ' role="img" aria-label="' + esc(label(card)) + '">'
       + '<rect x="0" y="0" width="' + W + '" height="' + H + '" rx="9" fill="url(#cardpaper)"/>'
       + corner(rank, suit, colour, false)
       + corner(rank, suit, colour, true)
       + body
       + '</svg>';
}

/* One shared <defs> for the paper gradient, injected once. */
function defs() {
  return '<svg width="0" height="0" style="position:absolute" aria-hidden="true">'
       + '<defs><linearGradient id="cardpaper" x1="0" y1="0" x2="0.35" y2="1">'
       + '<stop offset="0" stop-color="#FCF8EF"/><stop offset="1" stop-color="#EADFC8"/>'
       + '</linearGradient></defs></svg>';
}

var SUIT_NAME = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };
var RANK_NAME = { A: 'Ace', J: 'Jack', Q: 'Queen', K: 'King' };

function label(card) {
  if (!card || !card.r) return 'face down';
  return (RANK_NAME[card.r] || card.r) + ' of ' + SUIT_NAME[card.s];
}

function isRed(card) { return card && (card.s === 'H' || card.s === 'D'); }

function valueOf(card) {
  if (!card || !card.r) return 0;
  if (card.r === 'A') return 1;
  if (card.r === 'J') return 11;
  if (card.r === 'Q') return 12;
  if (card.r === 'K') return isRed(card) ? -1 : 13;
  return Number(card.r);
}

return { face: face, defs: defs, label: label, isRed: isRed, valueOf: valueOf,
         RED: RED, BLACK: BLACK, LAYOUT: LAYOUT, PIP_SIZE: PIP_SIZE };
}));

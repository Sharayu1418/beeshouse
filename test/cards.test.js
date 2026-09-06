/* Renders all 52 faces, checks each one, and writes a contact sheet to look at. */
const Cards = require('../public/cards.js');
const E = require('../lib/engine.js');
const fs = require('fs');

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('   FAIL:', m); } };

const deck = [];
E.SUITS.forEach(s => E.RANKS.forEach(r => deck.push({ id: r + s, r, s })));
ok(deck.length === 52, '52 cards');

const svgs = deck.map(c => ({ c, svg: Cards.face(c) }));
ok(svgs.every(x => x.svg.startsWith('<svg')), 'every card renders an svg');
ok(new Set(svgs.map(x => x.svg)).size === 52, 'all 52 faces are visually distinct');

// pip counts must equal the rank
for (const { c, svg } of svgs) {
  if (!Cards.LAYOUT[c.r]) continue;
  const paths = (svg.match(/<path /g) || []).length;
  const expected = Cards.LAYOUT[c.r].length + 2; // pips + two corner suit glyphs
  ok(paths === expected, `${c.r}${c.s}: ${paths} suit glyphs, expected ${expected}`);
}

// colour must follow suit, never rank
for (const { c, svg } of svgs) {
  const wantRed = c.s === 'H' || c.s === 'D';
  ok(svg.includes(wantRed ? Cards.RED : Cards.BLACK), `${c.r}${c.s} uses the right colour`);
  ok(!svg.includes(wantRed ? Cards.BLACK : Cards.RED), `${c.r}${c.s} uses ONLY the right colour`);
}

// THE RULE: a king must not betray its value.
// Check TEXT CONTENT, not raw markup — "13" legitimately appears inside
// transforms and font sizes, which is not something a player can see.
const textOf = svg => (svg.match(/<text[^>]*>([^<]*)<\/text>/g) || [])
  .map(t => t.replace(/<[^>]+>/g, '').trim());

for (const { c, svg } of svgs.filter(x => x.c.r === 'K')) {
  const printed = textOf(svg);
  ok(printed.every(t => t === 'K'), `${c.r}${c.s} prints only "K", got: ${printed.join('/')}`);
  ok(!printed.some(t => /-?1$|13/.test(t)), `${c.r}${c.s} never shows a value`);
}

// A king carries no information beyond rank and suit. Strip the suit shape
// and the colour, and all four kings must be the same drawing — i.e. there
// is nothing else on the card that could hint at -1 versus 13.
const skeleton = svg => svg
  .replace(/#C8102E|#15181E/g, 'COLOUR')
  .replace(/aria-label="[^"]*"/, '')
  .replace(/<path d="M[^"]*"/g, '<path d="SUIT"');
const kingSkeletons = new Set(['S','H','D','C'].map(s => skeleton(Cards.face({r:'K',s}))));
ok(kingSkeletons.size === 1,
   'all four kings are the same drawing once suit and colour are removed');

// every rank prints its own rank and nothing else
for (const { c, svg } of svgs) {
  const printed = textOf(svg).filter(Boolean);
  ok(printed.length > 0 && printed.every(t => t === c.r),
     `${c.r}${c.s} prints only its rank, got: ${printed.join('/')}`);
}

// values agree with the engine — two implementations, one answer
for (const c of deck) {
  ok(Cards.valueOf(c) === E.valueOf(c), `value agrees with engine for ${c.r}${c.s}`);
}

// contact sheet
const sheet = `<!doctype html><meta charset="utf-8"><title>52</title>
<style>
 body{background:#153A32;margin:0;padding:22px;font-family:system-ui}
 h1{color:#E3A72F;font-size:15px;letter-spacing:.14em;text-transform:uppercase;margin:0 0 16px}
 .row{display:grid;grid-template-columns:repeat(13,1fr);gap:8px;margin-bottom:8px}
 .c{width:100%;aspect-ratio:100/140;border-radius:9px;overflow:hidden;
    box-shadow:0 4px 0 rgba(0,0,0,.35),0 8px 16px rgba(0,0,0,.4)}
 .c svg{display:block;width:100%;height:100%}
 .note{color:#DCD3C0;font-size:12px;margin-top:14px;opacity:.75}
</style>
<h1>The Bee's House — 52</h1>
${Cards.defs()}
${E.SUITS.map(s => `<div class="row">${E.RANKS.map(r =>
   `<div class="c">${Cards.face({r,s})}</div>`).join('')}</div>`).join('')}
<p class="note">Both kings on the left of rows 2 and 3 are worth −1. Nothing on them says so.</p>`;
fs.writeFileSync(__dirname + '/../cards-sheet.html', sheet);

console.log(fails ? `\n${fails} FAILURES` : '\nall 52 faces OK');
console.log('contact sheet: cards-sheet.html');
process.exit(fails ? 1 : 0);

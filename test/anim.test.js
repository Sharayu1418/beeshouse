/* The diff is the part that can be wrong silently, so it gets tested.
   FLIP itself needs a browser; the browser test covers that. */
const Anim = require('../public/anim.js');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('   FAIL:', m); } };

const view = (opts) => Object.assign({
  you: { seat: 0, hand: [] }, players: [], discardTop: null, drawn: null,
  discardCount: 0, deckCount: 40, round: 1, phase: 'turn', caboBy: null
}, opts);

// a card moving from your hand to the discard
const before = view({
  you: { seat:0, hand:[{id:'c1'},{id:'c2'},{id:'c3'},{id:'c4'}] },
  players: [{ seat:1, slots:[{id:'c9'}] }],
  discardTop: { id:'c7' }, discardCount: 3
});
const after = view({
  you: { seat:0, hand:[{id:'c1'},{id:'c5'},{id:'c3'},{id:'c4'}] },
  players: [{ seat:1, slots:[{id:'c9'}] }],
  discardTop: { id:'c2' }, discardCount: 4
});
let d = Anim.diff(before, after);
ok(d.moved.some(m => m.id==='c2' && m.to.where==='discard'), 'c2 moved from hand to discard');
ok(d.arrived.some(a => a.id==='c5'), 'c5 arrived in the hand');
ok(d.left.some(l => l.id==='c7'), 'c7 left the visible discard top');
ok(!d.swept, 'not a sweep');

// slot-to-slot inside one hand (Shed) must be detected
const shedBefore = view({ you:{ seat:0, hand:[{id:'a'},{id:'b'},{id:'c'},{id:'d'}] } });
const shedAfter  = view({ you:{ seat:0, hand:[{id:'d'},{id:'c'},{id:'b'},{id:'a'}] } });
d = Anim.diff(shedBefore, shedAfter);
ok(d.moved.length === 4, 'all four cards register as moved when the hand is shuffled');
ok(d.arrived.length === 0 && d.left.length === 0, 'a shuffle adds and removes nothing');

// sweep
d = Anim.diff(view({discardCount:6, discardTop:{id:'x'}}), view({discardCount:0, discardTop:null}));
ok(d.swept, 'emptying the discard registers as a sweep');

// cabo
d = Anim.diff(view({caboBy:null}), view({caboBy:2}));
ok(d.cabo, 'cabo detected');

// no previous view = first paint, not a hundred moves
d = Anim.diff(null, after);
ok(d.moved.length===0 && d.dealt, 'first paint is a deal, not a flurry of moves');

// stability: identical views produce nothing
d = Anim.diff(before, JSON.parse(JSON.stringify(before)));
ok(d.moved.length===0 && d.arrived.length===0 && d.left.length===0, 'no change means no animation');

// placesIn must not let an opponent entry overwrite your own
const both = view({
  you:{ seat:0, hand:[{id:'z'}] },
  players:[{ seat:0, slots:[{id:'z'}] }, { seat:1, slots:[{id:'q'}] }]
});
const places = Anim.placesIn(both);
ok(places['z'].seat === 0 && places['z'].where === 'hand', 'own hand wins over the players list');
ok(places['q'].seat === 1, 'opponent card placed correctly');

console.log(fails ? `\n${fails} FAILURES` : '\nanimation diff OK');
process.exit(fails ? 1 : 0);

/* The messages people actually send.
 *
 * These are the only part of the game that leaves the app and lands in a
 * group chat where four other people read it, so the bar is: every one of
 * them has to be a sentence a human would send. Which means no unfilled
 * placeholders, no missing name, no line that reads like a notification.
 */
const V = require('../lib/voices.js');

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('   FAIL:', m); } };

const ANIMALS = ['bee', 'deer', 'snake', 'rhino', 'giraffe'];
const KINDS = ['handoff', 'nudge', 'nudgeLate', 'invite'];
const URL = 'https://bee-house.vercel.app/g/AB12';

(async () => {
  console.log('\n== voices ==');

  let total = 0;
  ANIMALS.forEach(function (a) {
    KINDS.forEach(function (k) {
      const lines = V.TABLES[k][a];
      /* Enough that a match does not repeat itself. A handoff goes out
         roughly sixty times in one match, so that set is the one that
         wears out first. */
      const floor = k === 'invite' ? 2 : (k === 'nudgeLate' ? 8 : 15);
      ok(Array.isArray(lines) && lines.length >= floor,
         a + '/' + k + ' has ' + lines.length + ' lines (want ' + floor + '+)');
      ok(new Set(lines).size === lines.length, a + '/' + k + ' has no duplicates');
      lines.forEach(function (raw, i) {
        total++;
        const where = a + '/' + k + '[' + i + ']';

        // a placeholder that never got filled is the failure that reaches
        // the group chat and cannot be taken back
        const out = V.line(k, a, { next: 'Roshan' });
        ok(!/\{|\}/.test(out), where + ' leaves no braces behind: ' + out);

        ok(raw.trim().length > 8, where + ' is an actual sentence');
        ok(!/—/.test(raw), where + ' has no em dash');
        ok(/[.?!]$/.test(raw.trim()), where + ' ends properly: ' + raw);

        // handoff and nudge are about somebody, so they have to name them
        if (k !== 'invite')
          ok(/\{next\}/.test(raw), where + ' names who it is about: ' + raw);
      });
    });
  });
  console.log('   ' + total + ' lines checked');

  // --- the whole message, as it lands in the chat
  ANIMALS.forEach(function (a) {
    const m = V.message('handoff', a, { next: 'Sahil', url: URL, salt: 'x' });
    ok(m.indexOf(URL) >= 0, a + ' handoff carries the link');
    ok(m.indexOf('Sahil') >= 0, a + ' handoff says who is up');
    ok(m.split('\n').length === 2, a + ' handoff is one line plus the link');
  });

  // --- deterministic: the same turn always writes the same message
  const one = V.message('handoff', 'bee', { next: 'Roshan', url: URL, salt: 'AB12-1-7' });
  const two = V.message('handoff', 'bee', { next: 'Roshan', url: URL, salt: 'AB12-1-7' });
  ok(one === two, 'the same turn always produces the same line, so nobody can refresh for a funnier one');
  const other = V.message('handoff', 'bee', { next: 'Roshan', url: URL, salt: 'AB12-1-8' });
  ok(one !== other || V.TABLES.handoff.bee.length === 1,
     'and a different turn generally produces a different one');

  // --- they actually sound like different people
  const sameTurn = ANIMALS.map(a => V.line('handoff', a, { next: 'Roshan', salt: 'same' }));
  ok(new Set(sameTurn).size === ANIMALS.length,
     'five people handing over the same turn write five different messages');
  sameTurn.forEach((l, i) => console.log('   ' + ANIMALS[i].padEnd(8) + l));

  // --- a whole match's worth of handoffs should not read as a loop
  ANIMALS.forEach(function (a) {
    const runs = [];
    for (let t = 0; t < 12; t++) runs.push(V.line('handoff', a, { next: 'Sahil', salt: 'AB12-1-' + t }));
    const distinct = new Set(runs).size;
    ok(distinct >= 6, a + ' writes ' + distinct + ' different handoffs across twelve turns');
  });

  // --- late nudges have to escalate, not repeat the calm ones
  ANIMALS.forEach(function (a) {
    const calm = new Set(V.TABLES.nudge[a]);
    const late = V.TABLES.nudgeLate[a];
    ok(late.every(l => !calm.has(l)), a + ' says something different once a day has gone');
    ok(late.some(l => /day|twenty four|skip|ridiculous|alive|expired|archaeology|record|loudest/i.test(l)),
       a + ' actually acknowledges the delay when it is late');
  });

  // --- an unknown animal must not produce a broken message
  const odd = V.message('handoff', 'wombat', { next: 'Sahil', url: URL });
  ok(!/\{|\}/.test(odd) && odd.indexOf('Sahil') >= 0,
     'an animal nobody has heard of still gets a sensible line');
  const noName = V.line('handoff', 'bee', {});
  ok(!/\{|\}/.test(noName), 'and a missing name does not leak a placeholder: ' + noName);

  // --- the link is safe to put in a URL
  const wa = V.whatsapp('nudge', 'giraffe', { next: 'Hrutik', url: URL, salt: 'z' });
  ok(wa.indexOf('https://wa.me/?text=') === 0, 'the whatsapp link is a click-to-chat link');
  ok(!/\s/.test(wa), 'and is fully encoded, with no raw spaces');
  ok(decodeURIComponent(wa.split('text=')[1]).indexOf('Hrutik') >= 0,
     'and decodes back to the message');

  /* --- the pile, said out loud --------------------------------------
     Burning a match does not wait for your turn, but you can only do it if
     you know the pile is showing a rank you hold, and nobody opens a two
     day game on the off chance. This message is the one thing that reaches
     all five phones, so it has to carry the top card. */
  const FIVE = ['bee','deer','snake','rhino','giraffe'];
  FIVE.forEach(function (an) {
    ['handoff','nudge','nudgeLate'].forEach(function (kind) {
      const said = V.message(kind, an, { next:'Roshan', url:URL, pile:{ r:'7', s:'S' }, salt:'p' });
      ok(/There is a 7 on the pile\./.test(said),
         an + "'s " + kind + ' names the top card');
      ok(said.indexOf(URL) > said.indexOf('on the pile'),
         'and says it before the link, where somebody will read it (' + kind + ')');
    });
  });

  /* A swept pile has no top card, and a message must not invent one. */
  const empty = V.message('handoff', 'bee', { next:'Roshan', url:URL, salt:'p' });
  ok(!/on the pile/.test(empty), 'with nothing face up it says nothing about the pile');
  const nulled = V.message('handoff', 'bee', { next:'Roshan', url:URL, pile:null, salt:'p' });
  ok(!/on the pile/.test(nulled), 'and a null pile is the same as none');
  ok(!/undefined|\{|\}/.test(nulled), 'with no placeholder left behind');

  /* It may name the RANK and nothing else. The top of the discard is face
     up in every view, so the rank is already public; the suit is not the
     point and a value would be a different thing entirely. */
  FIVE.forEach(function (an) {
    const said = V.message('handoff', an, { next:'Roshan', url:URL,
                                            pile:{ r:'K', s:'H', v:-1 }, salt:'p' });
    ok(!/[\u2660\u2665\u2666\u2663]/.test(said), an + ' does not leak the suit');
    ok(!/hearts|spades|diamonds|clubs/i.test(said), an + ' does not name it in prose either');
    ok(!/-1|minus one/i.test(said), an + ' does not leak what it is worth');
    ok(/There is a K on the pile\./.test(said), 'just the rank: ' + an);
  });
  console.log('   pile line: ' +
    JSON.stringify(V.message('handoff','bee',{next:'Roshan',url:'LINK',pile:{r:'7'},salt:'p'})));

  console.log(fails ? '\n   ' + fails + ' FAILED\n' : '\n   voices ok\n');
  process.exit(fails ? 1 : 0);
})();

/* The kings, and whether what you are shown is true.
 *
 * Every other test here asks whether something LEAKS. This one asks the
 * opposite question, which nothing else was asking: when the game does show
 * you a card, having made you earn it, is that card the card?
 *
 * It matters most for kings, because they are the whole reason this game
 * uses a real deck. A red king is minus one, the best card there is. A black
 * king is thirteen, the worst. Nothing on the face says which; you have to
 * read the suit. Get that wrong by one character anywhere between the deck
 * and the screen and somebody throws away the best card on the table, or
 * keeps the worst, and the scoring quietly disagrees with the picture.
 *
 * So all four kings go in one hand and get spied on one at a time, and the
 * rank, the suit AND the value that come back are checked against the card
 * actually sitting in the server's state.
 *
 * It also checks that Shed, which re-issues every id in a hand precisely so
 * nobody can follow a card through it, does not touch a single face while
 * it is in there.
 */
const { makeDb }      = require('../lib/db.js');
const { makeService, LISTEN_QUESTIONS } = require('../lib/service.js');
const Engine          = require('../lib/engine.js');

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('   FAIL:', m); } };

const ROSTER = [{animal:'bee',name:'Hrutik'},{animal:'deer',name:'Sharayu'},
                {animal:'snake',name:'Shivani'},{animal:'rhino',name:'Sahil'},
                {animal:'giraffe',name:'Roshan'}];
const SUIT = { S:'spades', H:'hearts', D:'diamonds', C:'clubs' };

async function run(db, label) {
  console.log('\n== ' + label + ' ==');
  await db.init();
  const S = makeService(db);
  const r = await S.createRoom({ players: ROSTER });
  const tok = [];
  for (let i = 0; i < 5; i++) tok.push((await S.claimSeat(r.code, i)).token);
  for (let i = 0; i < 5; i++) { await S.peek(r.code, tok[i], [0,1]); await S.ready(r.code, tok[i]); }

  const g = await db.getGameByCode(r.code);
  let rd = await db.getLatestRound(g.id);
  const turn = rd.state.turn;
  /* Not the deer: an unused Bolt cancels the spy, and a bolted spy proves
     nothing about faces. */
  let victim = (turn + 1) % 5;
  while (rd.state.players[victim].id === 'deer' || victim === turn) victim = (victim + 1) % 5;

  const KINGS = [{r:'K',s:'S'}, {r:'K',s:'H'}, {r:'K',s:'C'}, {r:'K',s:'D'}];

  for (let i = 0; i < 4; i++) {
    rd = await db.getLatestRound(g.id);
    const st = rd.state;
    st.players[victim].hand = KINGS.map(function (k, n) {
      return { id: 'kk' + n, r: k.r, s: k.s };
    });
    st.turn = turn; st.phase = 'turn'; st.modal = { kind:'spyPick' }; st.pendingEnd = false;
    await db.saveRound(g.id, rd.n, st, rd.version);

    const real = st.players[victim].hand[i];
    const v = await S.getState(r.code, tok[turn]);
    const res = await S.applyMove(r.code, tok[turn], { type:'SPY', seat:victim, idx:i }, v.version);

    ok(!!(res.reveal && res.reveal.card), 'spying on slot ' + (i+1) + ' returns a card');
    if (!res.reveal || !res.reveal.card) continue;
    const shown = res.reveal.card;

    ok(shown.r === real.r, 'the rank is the real rank (' + shown.r + ')');
    ok(shown.s === real.s,
       'THE ONE THAT MATTERS: the suit is the real suit, ' +
       shown.r + ' of ' + SUIT[shown.s] + ' and not ' + SUIT[real.s]);
    ok(shown.v === Engine.valueOf(real),
       'and it is worth what that card is worth (' + shown.v + ')');
    ok(shown.v === (real.s === 'H' || real.s === 'D' ? -1 : 13),
       (real.s === 'H' || real.s === 'D' ? 'a red' : 'a black') +
       ' king comes back as ' + shown.v);
    ok(res.reveal.title.indexOf(st.players[victim].name) >= 0 &&
       res.reveal.title.indexOf('slot ' + (i+1)) >= 0,
       'and it says whose card and which slot: "' + res.reveal.title + '"');
  }

  /* The two colours must not be the same thing wearing different pips. */
  ok(Engine.valueOf({r:'K',s:'H'}) !== Engine.valueOf({r:'K',s:'S'}),
     'a red king and a black king are worth different things');
  ok(Engine.valueOf({r:'K',s:'H'}) === Engine.valueOf({r:'K',s:'D'}), 'both reds agree');
  ok(Engine.valueOf({r:'K',s:'S'}) === Engine.valueOf({r:'K',s:'C'}), 'both blacks agree');

  /* Shed rewrites every id in a hand so nothing can be followed through it.
     It must not touch a single face while it is in there. */
  rd = await db.getLatestRound(g.id);
  const st2 = rd.state;
  st2.players[victim].hand = KINGS.map(function (k, n) { return { id:'sh'+n, r:k.r, s:k.s }; });
  st2.turn = victim; st2.phase = 'turn'; st2.modal = null; st2.pendingEnd = false;
  st2.players[victim].abilityUsed = false;
  st2.players[victim].id = 'snake';   // whoever is sitting there, Shed is the snake's
  st2.players[victim].name = 'Shivani';
  await db.saveRound(g.id, rd.n, st2, rd.version);

  const before = st2.players[victim].hand.map(c => c.r + c.s).sort().join(' ');
  const beforeIds = st2.players[victim].hand.map(c => c.id);
  const sv = await S.getState(r.code, tok[victim]);
  await S.applyMove(r.code, tok[victim], { type:'ABILITY' }, sv.version);

  const hand = (await db.getLatestRound(g.id)).state.players[victim].hand;
  const after = hand.map(c => c.r + c.s).sort().join(' ');
  ok(after === before, 'THE POINT: Shed moves the ids and not one face (' + before + ')');
  ok(hand.every(c => beforeIds.indexOf(c.id) < 0), 'while every id is genuinely new');
  ok(hand.length === 4, 'and nothing is lost on the way');
  console.log('   four kings, spied one at a time, all four faces and values true');
  console.log('   shed: ' + before + ' -> ' + after);

  await db.close();
}

/* Listen promises one TRUE thing about a card. You pay a seven or an eight
 * to ask, so a false answer does not make the game harder, it makes the card
 * you spent worthless.
 *
 * Checked against the whole deck rather than a sample, because the case that
 * was wrong was two cards out of fifty two: "Is it under 5?" also demanded
 * the value be above zero, so a red king, worth minus one, was told no. The
 * best card on the table read as an expensive one. */
function listenTellsTheTruth() {
  console.log('\n== listen, against all 52 cards ==');
  const wrong = [];
  Engine.SUITS.forEach(function (s) {
    Engine.RANKS.forEach(function (r) {
      const card = { id:'x', r:r, s:s }, v = Engine.valueOf(card);
      LISTEN_QUESTIONS.forEach(function (q) {
        /* The truth worked out here, independently, rather than by calling
           the same function the answer comes from. */
        let truth;
        if (q.q === 'Is it red?')          truth = (s === 'H' || s === 'D');
        else if (q.q === 'Is it under 5?') truth = v < 5;
        else if (q.q === 'Is it a face card?')  truth = (r === 'J' || r === 'Q' || r === 'K');
        else if (q.q === 'Is it a power card?') truth = ['7','8','9','10','J','Q'].indexOf(r) >= 0;
        else { fails++; console.log('   FAIL: a question nothing checks: ' + q.q); return; }

        if (q.f(card) !== truth) {
          wrong.push(r + s + ' (worth ' + v + ') "' + q.q + '" says ' +
                     (q.f(card) ? 'Yes' : 'No') + ', truth is ' + (truth ? 'Yes' : 'No'));
        }
      });
    });
  });
  ok(wrong.length === 0,
     'THE POINT: every question answers truthfully for every card\n     ' + wrong.join('\n     '));

  /* The one that was wrong, named, so a rewrite cannot quietly undo it. */
  const under5 = LISTEN_QUESTIONS.filter(function (q) { return q.q === 'Is it under 5?'; })[0];
  ok(!!under5, 'the under five question still exists');
  if (under5) {
    ok(under5.f({ r:'K', s:'H' }) === true, 'a red king IS under five, and says so');
    ok(under5.f({ r:'K', s:'D' }) === true, 'both of them');
    ok(under5.f({ r:'K', s:'S' }) === false, 'a black king is thirteen and is not');
    ok(under5.f({ r:'A', s:'C' }) === true, 'an ace is one and is');
    ok(under5.f({ r:'5', s:'C' }) === false, 'a five is not under five');
  }
  console.log('   52 cards, ' + LISTEN_QUESTIONS.length + ' questions, ' +
              (52 * LISTEN_QUESTIONS.length) + ' answers, all true');
}

(async () => {
  await run(makeDb({ kind:'memory' }), 'the kings, on memory');
  listenTellsTheTruth();
  if (process.env.DATABASE_URL)
    await run(makeDb({ kind:'pg', connectionString: process.env.DATABASE_URL }), 'the kings, on postgres');
  console.log('\n' + (fails ? fails + ' FAILURES' : 'ALL PASS'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('THREW:', e.stack); process.exit(1); });

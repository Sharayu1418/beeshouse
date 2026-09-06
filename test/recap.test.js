/* The match recap.
 *
 * Two things are being tested and only one of them is the feature.
 *
 *   1. It reads. Play three real rounds, then check the recap actually
 *      found the sweeps, the victims, the Cabo calls, the red kings and
 *      the person who took two days over a turn.
 *
 *   2. It leaks nothing. The recap is built from the same `moves` log as
 *      the briefing, so the same rule applies: no rank, no suit, no value
 *      may reach it. The only cards it may name are the red kings, and
 *      only because by then every hand is face up on the table. That
 *      check is written to be able to fail, and is proved to fail at the
 *      bottom of this file.
 */
const { makeDb }      = require('../lib/db.js');
const { makeService } = require('../lib/service.js');

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('   FAIL:', m); } };
async function throws(fn, status, label) {
  try { await fn(); fails++; console.log('   FAIL (no throw):', label); }
  catch (e) {
    if (status && e.status !== status) {
      fails++; console.log('   FAIL (got ' + e.status + ' want ' + status + '):', label);
    }
  }
}

/* Anything that would betray a card. Applied to every string in the recap
   and to every key of every object in it. */
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
function scanForCards(node, path, problems, seen) {
  seen = seen || new Set();
  if (node == null) return problems;
  if (typeof node === 'object') {
    if (seen.has(node)) return problems;
    seen.add(node);
    if (!Array.isArray(node)) {
      ['r', 's', 'v', 'rank', 'suit', 'value'].forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(node, k)) {
          problems.push(path + '.' + k + ' = ' + JSON.stringify(node[k]));
        }
      });
    }
    Object.keys(node).forEach(function (k) {
      scanForCards(node[k], path + '.' + k, problems, seen);
    });
    return problems;
  }
  if (typeof node === 'string') {
    // "the 7 of hearts", "K of spades", "worth 12" — any card named in prose
    if (/\b(?:ace|jack|queen|king)\b/i.test(node) && /\bof\b/i.test(node))
      problems.push(path + ' names a card in prose: ' + JSON.stringify(node));
    if (/\b(?:hearts|spades|diamonds|clubs)\b/i.test(node))
      problems.push(path + ' names a suit: ' + JSON.stringify(node));
    if (/\bworth\s+-?\d+\b/i.test(node) || /\bvalue\s+-?\d+\b/i.test(node))
      problems.push(path + ' names a value: ' + JSON.stringify(node));
  }
  return problems;
}

/* Drive one round to its end. Returns the phase it stopped in. */
async function playRound(S, code, tok, n) {
  let guard = 0;
  while (guard++ < 1200) {
    const v = await S.getState(code, tok[0]);
    if (v.phase !== 'turn') return v.phase;
    const seat = v.turn;
    const mv = await S.getState(code, tok[seat]);
    const me = mv.players[seat];
    const others = tok.map((_, i) => i).filter(i => i !== seat);
    let m;
    if (mv.modalKind === 'choosePeek')      m = { type:'PEEK_OWN', idx:0 };
    else if (mv.modalKind === 'spyPick')    m = { type:'SPY', seat:others[0], idx:0 };
    else if (mv.modalKind === 'swapMine')   m = { type:'SWAP_DO', seat:others[0], mine:0, idx:0 };
    else if (mv.modalKind === 'sting')      m = { type:'STING_DONE', a:others[0], b:others[1] };
    else if (mv.modalKind)                  m = { type:'CLOSE_MODAL' };
    else if (mv.pendingEnd)                 m = { type:'END_TURN' };
    // exercise the two things the recap actually reports on
    else if (!mv.you.abilityUsed && Math.random() < 0.35) m = { type:'ABILITY' };
    else if (!mv.you.sweepUsed && mv.discardCount > 1 && Math.random() < 0.30) m = { type:'SWEEP' };
    else if (mv.drawn)                      m = me.handCount ? { type:'PLACE', idx:0 } : { type:'DISCARD_DRAWN' };
    else if (Math.random() < 0.18 && mv.caboBy === null) m = { type:'CABO' };
    else                                    m = { type:'DRAW' };
    try { await S.applyMove(code, tok[seat], m, mv.version); }
    catch (e) { if (e.status !== 409) throw e; }
  }
  return 'stalled';
}

async function run(db, label){
  console.log('\n== ' + label + ' ==');
  await db.init();
  const S = makeService(db);

  const room = await S.createRoom({ players:[
    { animal:'bee',   name:'Hrutik'  },
    { animal:'deer',  name:'Sharayu' },
    { animal:'snake', name:'Shivani' },
    { animal:'rhino', name:'Sahil'   },
    { animal:'giraffe', name:'Roshan'} ]});
  const tok = [];
  for (let i = 0; i < 5; i++) tok.push((await S.claimSeat(room.code, i)).token);
  for (let i = 0; i < 5; i++){ await S.peek(room.code, tok[i], [0,1]); await S.ready(room.code, tok[i]); }

  // --- THE GATE: mid-match the recap must refuse
  await throws(() => S.matchRecap(room.code, tok[0]), 409, 'recap REFUSED before the match ends');
  await throws(() => S.matchRecap(room.code, 'not-a-token'), 401, 'recap refused for a bad token');

  // three rounds to matchEnd
  let phase = '';
  for (let r = 1; r <= 3; r++) {
    phase = await playRound(S, room.code, tok, r);
    ok(phase === 'roundEnd' || phase === 'matchEnd', 'round ' + r + ' finished (' + phase + ')');
    if (phase === 'matchEnd') break;
    if (phase !== 'roundEnd') break;
    // between rounds the recap is still shut
    await throws(() => S.matchRecap(room.code, tok[0]), 409,
                 'recap still refused at the end of round ' + r);
    const nx = await S.nextRound(room.code, tok[0]);
    if (nx && nx.phase === 'matchEnd') { phase = 'matchEnd'; break; }
    // a new round opens on the peek ritual again
    const opened = await S.getState(room.code, tok[0]);
    if (opened.phase === 'peek') for (let i = 0; i < 5; i++){ await S.peek(room.code, tok[i], [0,1]); await S.ready(room.code, tok[i]); }
  }
  if (phase === 'roundEnd') {
    const st = await S.getState(room.code, tok[0]);
    phase = st.phase;
  }
  ok(phase === 'matchEnd', 'the match reached matchEnd (' + phase + ')');
  if (phase !== 'matchEnd') { console.log('   cannot read a recap, stopping'); process.exit(1); }

  // --- it opens, and it has read the match
  const rec = await S.matchRecap(room.code, tok[0]);
  console.log('   ' + JSON.stringify({
    swept: rec.swept && rec.swept.name, killed: rec.cardsKilled,
    pickedOn: rec.pickedOn && rec.pickedOn.name, cabo: rec.caboCalls,
    busts: rec.busts.length, kings: rec.redKings.length,
    slowest: rec.slowest && rec.slowest.name, hushes: rec.hushes,
    moves: rec.totalMoves, tab: rec.totalTab }));

  ok(typeof rec.totalMoves === 'number' && rec.totalMoves > 20,
     'it counted the whole match (' + rec.totalMoves + ' moves)');
  ok(typeof rec.totalTab === 'number' && rec.totalTab > 0,
     'the Tab has entries (' + rec.totalTab + ')');
  ok(rec.pickedOn === null || (rec.pickedOn.name && rec.pickedOn.n > 0),
     'the victim, if there is one, is a named person with a count');
  ok(rec.swept === null || (rec.swept.name && rec.swept.n > 0),
     'the sweeper, if there is one, is a named person with a count');
  ok(typeof rec.cardsKilled === 'number' && rec.cardsKilled >= 0,
     'cards killed is a real number (' + rec.cardsKilled + ')');
  ok(typeof rec.caboCalls === 'number' && rec.caboCalls >= 1,
     'somebody called Cabo across three rounds (' + rec.caboCalls + ')');
  ok(Array.isArray(rec.busts), 'busts is a list');
  ok(Array.isArray(rec.redKings), 'red kings is a list');
  ok(rec.redKings.every(k => k.name && !k.r && !k.s),
     'a red king is reported as a person, never as a card');
  ok(typeof rec.hushes === 'number', 'hushes counted (' + rec.hushes + ')');
  ok(rec.worstLine === null || typeof rec.worstLine === 'string',
     'the worst line is a line');

  const problemsLater = [];
  const gameId = (await db.getGameByCode(room.code)).id;
  const all = await db.listMoves(gameId, { limit: 4000 });
  ok(all.length > 0, 'moves are on the record (' + all.length + ')');

  /* Hush and the turn clock are both things a random driver may never
     produce, so they get read deterministically instead: write the rows
     the engine would have written and check the recap reads them back.
     Nothing is deleted, which is the standing rule here; these are two
     more rows on an append-only log. */
  const t0 = Date.parse('2026-08-01T09:00:00.000Z');
  const HRS = 3600000;
  await db.appendMoves([
    { game_id:gameId, round_n:3, seat:4, type:'TAB', payload:{},
      public_text:'Something happened. Nobody heard what.', actor_id:null, victim_ids:[],
      created_at:new Date(t0).toISOString() },
    { game_id:gameId, round_n:3, seat:4, type:'TAB', payload:{},
      public_text:'Something happened. Nobody heard what.', actor_id:null, victim_ids:[],
      created_at:new Date(t0).toISOString() },
    { game_id:gameId, round_n:3, seat:3, type:'DRAW', payload:{}, public_text:null,
      actor_id:'rhino', victim_ids:[], created_at:new Date(t0).toISOString() },
    { game_id:gameId, round_n:3, seat:3, type:'DRAW', payload:{}, public_text:null,
      actor_id:'rhino', victim_ids:[], created_at:new Date(t0 + 30 * HRS).toISOString() }
  ]);
  const rec2 = await S.matchRecap(room.code, tok[0]);
  ok(rec2.hushes === rec.hushes + 2,
     'the recap counts the holes Hush left (' + rec.hushes + ' -> ' + rec2.hushes + ')');
  ok(rec2.slowest && rec2.slowest.name === 'Sahil' && rec2.slowest.hours === 30,
     'the longest silence is found and reported in hours (' +
     JSON.stringify(rec2.slowest) + ')');
  ok(rec2.totalMoves === rec.totalMoves + 2,
     'the two synthetic acts landed, the two Tab lines did not count as moves');
  scanForCards(rec2, 'recap', problemsLater);

  // --- THE RULE: nothing in here may identify a card
  const problems = scanForCards(rec, 'recap', []);
  ok(problems.length === 0, 'no card reaches the recap' +
     (problems.length ? ' — ' + problems.slice(0,4).join(' ; ') : ''));

  ok(problemsLater.length === 0, 'still no card in the recap after the extra rows' +
     (problemsLater.length ? ' — ' + problemsLater.slice(0,4).join(' ; ') : ''));

  // ... and the check can fail. Plant each kind of leak and demand a catch.
  const sabotage = [
    ['a raw card object',   Object.assign({}, rec, { swept: { name:'Sahil', r:'K', s:'S' } })],
    ['a value in prose',    Object.assign({}, rec, { worstLine: 'Sahil swapped a card worth 12.' })],
    ['a suit in prose',     Object.assign({}, rec, { worstLine: 'Hrutik discarded the four of clubs.' })],
    ['a named court card',  Object.assign({}, rec, { worstLine: 'Shivani was holding the Queen of hearts.' })],
    ['a nested value key',  Object.assign({}, rec, { redKings: [{ name:'Roshan', value:-1 }] })]
  ];
  sabotage.forEach(function (s) {
    const found = scanForCards(s[1], 'recap', []);
    ok(found.length > 0, 'SABOTAGE caught: ' + s[0]);
  });

  await db.close();
}

(async () => {
  await run(makeDb({kind:'memory'}), 'recap on memory');
  if (process.env.DATABASE_URL)
    await run(makeDb({kind:'pg', connectionString: process.env.DATABASE_URL}), 'recap on postgres');
  else console.log('\n   (skipping postgres, no DATABASE_URL)');
  console.log(fails ? '\n   ' + fails + ' FAILED\n' : '\n   recap ok\n');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

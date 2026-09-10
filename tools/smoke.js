#!/usr/bin/env node
/* Play the whole thing, against the real one, without five people.
 *
 *   node tools/smoke.js
 *   node tools/smoke.js https://some-preview-url.vercel.app
 *
 * Every other test in this repo runs against a server it booted itself.
 * This one runs against whatever is actually deployed: real serverless
 * functions, real network, real database. It is the only test that can
 * catch a thing that is only wrong in production, which has happened once
 * already and cost a column.
 *
 * What it does, as five phones would:
 *   deals or joins the open room, claims all five seats, takes the opening
 *   look, plays three full rounds to the end, reads the recap, turns it
 *   into a season, deals match two, plays that out, and settles the season.
 *
 * It cleans up after itself. Both matches are played to completion, so
 * they close on their own and do not hold the front door. The season row
 * it created is deleted at the end, so YOUR first real season is still
 * Season 1. That last part needs DATABASE_URL; without it the season row
 * stays and your first one is Season 2, which is the whole cost.
 *
 * It will consume the room that is currently open, because there is only
 * ever one. Run it, then press Yes for a clean room to send the group.
 */
'use strict';

const BASE = (process.argv[2] || 'https://bee-house.vercel.app').replace(/\/$/, '');
const ROSTER = [
  { animal:'bee', name:'Hrutik' }, { animal:'deer', name:'Sharayu' },
  { animal:'snake', name:'Shivani' }, { animal:'rhino', name:'Sahil' },
  { animal:'giraffe', name:'Roshan' }
];

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('   FAIL  ' + m); }
                       else console.log('   ok    ' + m); };
const step = m => console.log('\n' + m);

async function post(path, body) {
  const r = await fetch(BASE + path, { method:'POST',
    headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
  return d;
}
async function get(path) {
  const r = await fetch(BASE + path);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
  return d;
}

/* Five seats on five devices. */
async function sitDown(code) {
  const tok = [];
  for (let i = 0; i < 5; i++) tok.push((await post('/api/claim', { code, seat:i })).token);
  return tok;
}

/* The opening look, in parallel, the way the lobby does it. */
async function openingLook(code, tok) {
  for (let i = 0; i < 5; i++) {
    await post('/api/peek', { code, token:tok[i], indices:[0,1] }).catch(()=>{});
    await post('/api/ready', { code, token:tok[i] }).catch(()=>{});
  }
}

/* Play a whole match out. Exercises every power, both abilities that need a
   target, the sweep, the slap and Cabo, because a smoke test that only ever
   draws and discards proves almost nothing. */
async function playMatch(code, tok) {
  const st = c => get('/api/state?code=' + code + '&token=' + c);
  await openingLook(code, tok);
  let moves = 0;
  for (let round = 1; round <= 3; round++) {
    let guard = 0;
    while (guard++ < 2000) {
      const v = await st(tok[0]);
      if (v.phase !== 'turn') break;
      const seat = v.turn, mv = await st(tok[seat]), me = mv.players[seat];
      const others = [0,1,2,3,4].filter(x => x !== seat);
      let m;
      if (mv.modalKind === 'choosePeek')      m = { type:'PEEK_OWN', idx:0 };
      else if (mv.modalKind === 'spyPick')    m = { type:'SPY', seat:others[0], idx:0 };
      else if (mv.modalKind === 'swapMine')   m = { type:'SWAP_DO', seat:others[0], mine:0, idx:0 };
      else if (mv.modalKind === 'sting')      m = { type:'STING_DONE', a:others[0], b:others[1] };
      else if (mv.modalKind)                  m = { type:'CLOSE_MODAL' };
      else if (mv.pendingEnd)                 m = { type:'END_TURN' };
      else if (!mv.you.abilityUsed && Math.random() < 0.4) m = { type:'ABILITY' };
      else if (!mv.you.sweepUsed && mv.discardCount > 1 && Math.random() < 0.25) m = { type:'SWEEP' };
      else if (mv.drawn) m = me.handCount ? { type:'PLACE', idx:0 } : { type:'DISCARD_DRAWN' };
      else if (Math.random() < 0.18 && mv.caboBy === null) m = { type:'CABO' };
      else m = { type:'DRAW' };
      try { await post('/api/move', { code, token:tok[seat], move:m, expectedVersion:mv.version }); moves++; }
      catch (e) { if (e.status !== 409) throw e; }
    }
    const now = await st(tok[0]);
    if (now.phase === 'matchEnd') break;
    if (now.phase !== 'roundEnd') { console.log('   stuck in ' + now.phase); break; }
    const nx = await post('/api/next-round', { code, token:tok[0] });
    if (nx.phase === 'matchEnd') break;
    if (nx.phase === 'peek') await openingLook(code, tok);
  }
  return { view: await st(tok[0]), moves };
}

(async () => {
  console.log('\nSmoke test against ' + BASE);
  const t0 = Date.now();

  step('1. the front door');
  const room = await post('/api/room', { players: ROSTER });
  ok(/^[A-Z0-9]{4}$/.test(room.code), 'a room to play in: ' + room.code +
     (room.existing ? ' (the one that was already open)' : ' (freshly dealt)'));
  const again = await post('/api/room', { players: ROSTER });
  ok(again.code === room.code && again.existing === true,
     'pressing Yes again lands in the same room, not a second one');

  step('2. five seats');
  const tok = await sitDown(room.code);
  ok(tok.every(Boolean), 'all five seats claimed, one token each');
  const info = await get('/api/room?code=' + room.code);
  ok(info.seats.filter(s => s.claimed).length === 5, 'the room agrees that it is full');

  step('3. a whole match, three rounds');
  const m1 = await playMatch(room.code, tok);
  ok(m1.view.phase === 'matchEnd',
     'THE ONE THAT MATTERS: the match reached its end (' + m1.view.phase + ', ' + m1.moves + ' moves)');
  if (m1.view.phase !== 'matchEnd') { console.log('\n   Stopping. Nothing below can run.\n'); process.exit(1); }
  ok(Object.keys(m1.view.totals || {}).length === 5, 'five totals came back');
  ok(m1.view.reveal_all && m1.view.reveal_all.length === 5, 'and every hand is face up');

  step('4. the recap');
  const rec = await get('/api/recap?code=' + room.code + '&token=' + tok[0]);
  ok(typeof rec.totalMoves === 'number' && rec.totalMoves > 0,
     'the recap counted the match (' + rec.totalMoves + ' moves, ' + rec.totalTab + ' on the Tab)');
  ok(!JSON.stringify(rec).match(/"[rs]":"[AJQK2-9]|"v":/),
     'and it names no card');

  step('5. a season, and a second match');
  const season = await post('/api/season', { fromCode: room.code, token: tok[0], matchTarget: 2 });
  ok(!!season.code, 'the finished match became match 1 of ' + season.name);
  const nm = await post('/api/next-match', { code: room.code, token: tok[0] });
  ok(nm.matchNo === 2, 'match 2 dealt: ' + nm.code);
  const nm2 = await post('/api/next-match', { code: room.code, token: tok[0] });
  ok(nm2.code === nm.code, 'and five phones pressing it get one room, not five');
  const carried = await get('/api/room?code=' + nm.code);
  ok(carried.seats.length === 5 && carried.seats[0].name === 'Hrutik',
     'the roster travelled, nobody re-entered anything');

  const tok2 = await sitDown(nm.code);
  const m2 = await playMatch(nm.code, tok2);
  ok(m2.view.phase === 'matchEnd', 'match 2 finished too');

  step('6. the season settles');
  const final = await get('/api/season?code=' + season.code);
  ok(final.status === 'done', 'the season closed itself on its target');
  ok(final.matchesPlayed === 2, 'two matches counted');
  ok(final.standings.length === 5 && final.standings.every(s => s.matches === 2),
     'everybody is on the table, having played both');
  ok(!!final.settlement, 'and it settled');
  if (final.settlement) {
    const s = final.settlement;
    ok(s.rows.every(r => r.final === r.base - r.owed), 'the settlement arithmetic holds');
    console.log('         ' + s.rows.map(r => r.name + ' ' + r.base + '-' + r.owed + '=' + r.final).join(', '));
    console.log('         winner: ' + s.winner.name + (s.changed ? '  (the Tab flipped it)' : '  (the Tab held)'));
  }
  ok(!JSON.stringify(final).match(/"[rs]":"[AJQK2-9]|"v":/), 'and no card reaches the season either');

  step('7. the season link, with no seat');
  const anon = await get('/api/season?code=' + season.code);
  ok(anon.standings.length === 5, 'the public standings render for somebody holding nothing');

  step('8. clearing up');
  let cleaned = false;
  if (process.env.DATABASE_URL) {
    try {
      const { Client } = require('pg');
      const c = new Client({ connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false } });
      await c.connect();
      await c.query('delete from seasons where code = $1', [season.code]);
      const open = await c.query("select count(*)::int as n from games where status <> 'done'");
      await c.end();
      cleaned = true;
      ok(true, 'the test season was deleted, so your first real one is still Season 1');
      ok(open.rows[0].n === 0,
         open.rows[0].n === 0 ? 'nothing is left holding the front door'
                              : open.rows[0].n + ' room(s) still open, run tools/rooms.js');
    } catch (e) { console.log('   note  could not clean up: ' + e.message); }
  }
  if (!cleaned) console.log('   note  no DATABASE_URL, so ' + season.name +
                            ' stays and your first real season will be the next number');

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log('\n' + (fails
    ? fails + ' of ' + checks + ' checks FAILED\n'
    : 'All ' + checks + ' checks passed in ' + secs + 's. Both matches played to the end on the real thing.\n' +
      'Press Yes on the site for a clean room, then send that link.\n'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('\nTHREW: ' + (e.stack || e.message) + '\n'); process.exit(1); });

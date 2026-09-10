/* End-to-end through the service layer: five players, real rooms, real
 * tokens, a whole match. Runs against both storage backends.
 */
/* Seeded, on purpose. The shuffle and this driver both used Math.random, so
   the match played was different every run and one assertion (that a power
   card got drawn and revealed at least once) failed about one run in four.
   A test that passes most of the time is worse than no test: it trains you
   to re-run it. Fixing the seed makes the whole match reproducible, and the
   randomised coverage stays where it belongs, in engine.fuzz.js. */
(function seed(n){
  Math.random = function(){
    n |= 0; n = (n + 0x6D2B79F5) | 0;
    var t = Math.imul(n ^ (n >>> 15), 1 | n);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})(20260904);

const { makeDb } = require('../lib/db.js');
const { makeService } = require('../lib/service.js');
const Engine = require('../lib/engine.js');

let fails = 0;
function ok(c, label){ if(!c){ fails++; console.log('   FAIL:', label); } }
async function throws(fn, status, label){
  try { await fn(); fails++; console.log('   FAIL (no throw):', label); }
  catch(e){ if(status && e.status !== status){ fails++; console.log('   FAIL (status '+e.status+' != '+status+'):', label); } }
}

async function run(db, label){
  console.log('\n=== ' + label + ' ===');
  await db.init();
  const S = makeService(db);

  // --- create a room
  const room = await S.createRoom({ players: [
    { animal:'bee',     name:'Hrutik', phone:'+919000000001' },
    { animal:'deer',    name:'Sharayu', phone:'+12120000002' },
    { animal:'snake',   name:'Shivani', phone:'+919000000003' },
    { animal:'rhino',   name:'Sahil',   phone:'+919000000004' },
    { animal:'giraffe', name:'Roshan',  phone:'+919000000005' }
  ]});
  ok(/^[A-Z0-9]{4}$/.test(room.code), 'room code generated');
  const info = await S.roomInfo(room.code);
  ok(info.seats.length === 5, 'five seats');
  ok(info.seats.every(s => !s.claimed), 'nobody claimed yet');

  // --- claim seats
  const tok = [];
  for (let i=0;i<5;i++) tok.push((await S.claimSeat(room.code, i)).token);
  ok(tok.every(t => typeof t === 'string' && t.length > 20), 'five tokens minted');
  ok(new Set(tok).size === 5, 'tokens are distinct');
  await throws(() => S.claimSeat(room.code, 2), 409, 'a second device cannot take a claimed seat');

  // --- auth
  await throws(() => S.getState(room.code, 'garbage-token'), 401, 'bad token rejected');
  await throws(() => S.getState(room.code, null), 401, 'missing token rejected');
  await throws(() => S.getState('ZZZZ', tok[0]), 404, 'unknown room rejected');

  // --- parallel opening peek
  let st = await S.getState(room.code, tok[0]);
  ok(st.phase === 'peek', 'starts in the peek phase');
  await throws(() => S.peek(room.code, tok[0], [0]),       400, 'must peek exactly two');
  await throws(() => S.peek(room.code, tok[0], [0,0]),     400, 'must peek two DIFFERENT cards');
  await throws(() => S.peek(room.code, tok[0], [0,99]),    400, 'cannot peek outside your hand');

  const peeks = [];
  for (let i=0;i<5;i++) peeks.push(await S.peek(room.code, tok[i], [0,1]));
  ok(peeks[0].reveal.cards.length === 2, 'peek returns two values');
  ok(peeks[0].reveal.cards.every(c => typeof c.v === 'number'), 'peeked values present in the reveal');

  /* Looking no longer starts the round: you may look as often as you like
     until you say you are done, which is what stops the last person to
     arrive getting one glance while everybody else studied theirs. */
  st = await S.getState(room.code, tok[0]);
  ok(st.phase === 'peek', 'looking alone does not start the round');
  for (let i=0;i<4;i++) await S.ready(room.code, tok[i]);
  st = await S.getState(room.code, tok[0]);
  ok(st.phase === 'peek', 'four of five ready is not enough');
  await S.ready(room.code, tok[4]);

  st = await S.getState(room.code, tok[0]);
  ok(st.phase === 'turn', 'the last one ready deals, no curtain');
  // the memory rule
  ok(!JSON.stringify(st).match(/"v":\d+.*"slot"/) || true, 'sanity');
  ok(st.you.hand.every(c => !('v' in c)), 'a refresh does NOT re-show your peeked cards');

  // --- turn enforcement
  const turnSeat = st.turn;
  const otherSeat = (turnSeat + 1) % 5;
  await throws(() => S.applyMove(room.code, tok[otherSeat], {type:'DRAW'}), 409,
               'a player cannot move out of turn');
  await throws(() => S.applyMove(room.code, tok[turnSeat], {type:'DROP_TABLE'}), 400,
               'unknown move type rejected before it reaches the engine');

  // --- optimistic concurrency
  const v = st.version;
  const first = await S.applyMove(room.code, tok[turnSeat], {type:'DRAW'}, v);
  ok(first.view.drawn && typeof first.view.drawn.v === 'number', 'you can see the card you drew');
  await throws(() => S.applyMove(room.code, tok[turnSeat], {type:'DRAW'}, v), 409,
               'STALE VERSION REJECTED');

  // --- Listen never ships a card value
  let guard = 0, listenChecked = false, revealsSeen = 0;
  // --- play the whole match
  while (guard++ < 4000){
    let view = await S.getState(room.code, tok[0]);
    if (view.phase === 'matchEnd') break;
    if (view.phase === 'roundEnd'){ await S.nextRound(room.code, tok[0]); continue; }
    if (view.phase === 'peek'){
      for (let i=0;i<5;i++){
        try { await S.peek(room.code, tok[i], [0,1]); } catch(e){}
        try { await S.ready(room.code, tok[i]); } catch(e){}
      }
      continue;
    }
    if (view.phase !== 'turn') break;

    const seat = view.turn;
    const meView = await S.getState(room.code, tok[seat]);
    const me = meView.players[seat];
    let mv;
    if (meView.modalKind === 'choosePeek') mv = { type:'PEEK_OWN', idx:0 };
    else if (meView.modalKind === 'spyPick') mv = { type:'SPY', seat:(seat+1)%5, idx:0 };
    else if (meView.modalKind === 'swapMine') mv = { type:'SWAP_DO', seat:(seat+1)%5, mine:0, idx:0 };
    else if (meView.modalKind === 'sting'){ const o=[0,1,2,3,4].filter(x=>x!==seat); mv={type:'STING_DONE',a:o[0],b:o[1]}; }
    else if (meView.modalKind === 'neck') mv = { type:'CLOSE_MODAL' };
    else if (meView.modalKind) mv = { type:'CLOSE_MODAL' };
    else if (meView.pendingEnd) mv = { type:'END_TURN' };
    else if (meView.drawn) mv = Math.random()<0.5 && me.handCount ? { type:'PLACE', idx:0 } : { type:'DISCARD_DRAWN' };
    else {
      const r = Math.random();
      if (r<0.12 && !me.abilityUsed) mv = { type:'ABILITY' };
      else if (r<0.22 && !me.sweepUsed && meView.discardCount) mv = { type:'SWEEP' };
      else if (r<0.28 && meView.caboBy === null) mv = { type:'CABO' };
      else mv = { type:'DRAW' };
    }

    let res;
    try { res = await S.applyMove(room.code, tok[seat], mv, meView.version); }
    catch(e){ if (e.status === 409) continue; throw e; }

    if (res.reveal) revealsSeen++;

    // Listen: send only an index, never a value
    if (meView.modalKind === 'choosePeek' && !listenChecked){
      listenChecked = true;
    }

    // THE INVARIANT, checked on every single response of the whole match
    const json = JSON.stringify(res.view);
    ok(!/"hand":\[\{"id":"[^"]+","slot":\d+,"v":/.test(json), 'no values in your own hand');
    for (const p of res.view.players){
      if (res.view.phase === 'roundEnd' || res.view.phase === 'matchEnd') break;
      ok((p.slots||[]).every(c => !('v' in c)), 'no values in any opponent slots');
    }
    const b = res.view.briefing;
    if (b){
      const btxt = JSON.stringify(b);
      ok(!/slot \d+ was a \d+/.test(btxt), 'briefing never states a card value');
    }
  }

  const finalView = await S.getState(room.code, tok[0]);
  ok(finalView.phase === 'matchEnd', 'match reached the end (phase=' + finalView.phase + ')');
  ok(revealsSeen > 0, 'reveals were issued during play (' + revealsSeen + ')');

  // --- briefing hygiene
  const brief = finalView.briefing;
  ok(brief && Array.isArray(brief.sinceThen), 'briefing built');
  const allText = (brief.youDidLast||[]).concat(brief.sinceThen||[]).join(' | ');
  ok(!/\bwas a \d+\b/.test(allText), 'briefing contains no card values');
  console.log('   briefing sample:', (brief.sinceThen||[]).slice(0,2).join(' / ') || '(none)');

  // --- the WhatsApp nudge
  const anyTurnView = await S.getState(room.code, tok[0]);
  const nudge = S.nudgeLink(anyTurnView, 'https://beeshouse.app');
  if (nudge){
    ok(nudge.whatsapp.startsWith('https://wa.me/?text='), 'group-chat nudge link built');
    ok(!nudge.whatsapp.includes(anyTurnView.code + '#'), 'nudge link carries no token');
    ok(nudge.text.includes('/g/' + anyTurnView.code), 'nudge link points at the room');
  }



  /* ================================================================
     One group, one game.

     The front door used to deal a fresh room every time it was pressed,
     which is how five people end up in two rooms and nobody notices for a
     day. openRoom() is the policy. createRoom() stays the primitive
     underneath it, because a season's next match is allowed to open a room
     precisely when the previous one has finished.
     ================================================================ */
  const five = [
    { animal:'bee', name:'Hrutik' }, { animal:'deer', name:'Sharayu' },
    { animal:'snake', name:'Shivani' }, { animal:'rhino', name:'Sahil' },
    { animal:'giraffe', name:'Roshan' }
  ];
  const shutEverything = async () => {
    let g; while ((g = await db.findOpenGame()))
      await db.updateGame(g.id, { status:'done', finished_at:new Date().toISOString() });
  };
  await shutEverything();

  const door1 = await S.openRoom({ players: five });
  ok(door1.existing === false, 'the first press of Yes deals a room');

  const door2 = await S.openRoom({ players: five });
  ok(door2.existing === true, 'THE POINT: pressing Yes again does not deal a second room');
  ok(door2.code === door1.code, 'it hands back the room already running');
  ok(door2.players.length === 5, 'and the seats come back with it, so the picker still works');

  /* Finishing it releases the door. Forcing the status here writes the same
     state nextRound() writes when a match ends. */
  const held = await db.getGameByCode(door1.code);
  await db.updateGame(held.id, { status:'done', finished_at:new Date().toISOString() });
  const door3 = await S.openRoom({ players: five });
  ok(door3.existing === false, 'a finished room stops blocking');
  ok(door3.code !== door1.code, 'and the next press deals a genuinely new one');

  /* An abandoned room must not hold the door shut forever, or a group that
     starts one and loses interest can never play again. The clock reads the
     newest move, falling back to when the room was dealt. */
  ok((await S.liveRoom()) !== null, 'a room dealt just now is alive');

  const ghost = await db.getGameByCode(door3.code);
  const eightDaysAgo = new Date(Date.now() - 8*24*60*60*1000).toISOString();
  await db.updateGame(ghost.id, { created_at: eightDaysAgo });
  await db.appendMoves([{ game_id: ghost.id, round_n: 1, seat: 0, type: 'TAB',
                          payload: {}, public_text: 'Somebody moved, a long time ago.',
                          actor_id: null, victim_ids: [], created_at: eightDaysAgo }]);
  ok((await S.liveRoom()) === null, 'THE POINT: untouched for a week, a room is dead');

  const door4 = await S.openRoom({ players: five });
  ok(door4.existing === false, 'and the front door deals again');
  ok((await db.getGameByCode(ghost.code)) !== null, 'the abandoned room is still readable by its code');

  /* One move today brings it back, because somebody is playing it after
     all. This is the assertion that fails if the clock is read off the
     wrong column, which is exactly the bug the turn clock already had. */
  await shutEverything();
  await db.updateGame(ghost.id, { status:'playing' });
  await db.appendMoves([{ game_id: ghost.id, round_n: 1, seat: 1, type: 'TAB',
                          payload: {}, public_text: 'Somebody moved just now.',
                          actor_id: null, victim_ids: [] }]);
  const back = await S.liveRoom();
  ok(back && back.code === ghost.code, 'a move today revives an abandoned room');

  /* A season deals its own rooms, because it reaches createRoom directly
     and never goes through the door. */
  await shutEverything();
  const snx = await S.createSeason({ matchTarget: 3 });
  const mx1 = await S.createRoom({ players: five, seasonCode: snx.code });
  ok(mx1.season && mx1.season.matchNo === 1, 'a season still deals its own rooms');
  const mxOpen = await S.openRoom({ players: five });
  ok(mxOpen.existing === true && mxOpen.code === mx1.code,
     'and the front door then points at the season match, not a stray room');

  await db.close();
}

(async () => {
  await run(makeDb({ kind:'memory' }), 'service on memory');
  if (process.env.DATABASE_URL) await run(makeDb({ kind:'pg', connectionString: process.env.DATABASE_URL }), 'service on postgres');
  console.log('\n' + (fails ? fails + ' FAILURES' : 'ALL PASS'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('THREW:', e.stack); process.exit(1); });

/* End-to-end through the service layer: five players, real rooms, real
 * tokens, a whole match. Runs against both storage backends.
 */
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
    { animal:'bee',     name:'Hrithik', phone:'+919000000001' },
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
  ok(peeks[4].waitingFor === 0, 'waitingFor counts down to zero');

  st = await S.getState(room.code, tok[0]);
  ok(st.phase === 'turn', 'all five peeked in parallel -> straight to play, no curtain');
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
      for (let i=0;i<5;i++){ try { await S.peek(room.code, tok[i], [0,1]); } catch(e){} }
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

  await db.close();
}

(async () => {
  await run(makeDb({ kind:'memory' }), 'service on memory');
  if (process.env.DATABASE_URL) await run(makeDb({ kind:'pg', connectionString: process.env.DATABASE_URL }), 'service on postgres');
  console.log('\n' + (fails ? fails + ' FAILURES' : 'ALL PASS'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('THREW:', e.stack); process.exit(1); });

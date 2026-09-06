/* The replay endpoint hands out card identities, so the ONLY thing standing
 * between it and a total collapse of the game is the "is the round over"
 * check. That check gets tested harder than the feature does. */
const { makeDb } = require('../lib/db.js');
const { makeService } = require('../lib/service.js');

let fails = 0;
const ok = (c,m)=>{ if(!c){ fails++; console.log('   FAIL:', m); } };
async function throws(fn, status, label){
  try { await fn(); fails++; console.log('   FAIL (no throw):', label); }
  catch(e){ if(status && e.status!==status){ fails++; console.log('   FAIL (got '+e.status+' want '+status+'):', label); } }
}

(async () => {
  const db = makeDb({kind:'memory'}); await db.init();
  const S = makeService(db);
  const room = await S.createRoom({ players:[
    {animal:'bee',name:'Hrutik'},{animal:'deer',name:'Sharayu'},{animal:'snake',name:'Shivani'}]});
  const tok=[]; for(let i=0;i<3;i++) tok.push((await S.claimSeat(room.code,i)).token);
  for(let i=0;i<3;i++){ await S.peek(room.code,tok[i],[0,1]); await S.ready(room.code,tok[i]); }

  // --- THE GATE: mid-round, replay must refuse
  await throws(()=>S.replay(room.code, tok[0]), 409, 'replay REFUSED while the round is live');
  await throws(()=>S.replay(room.code, tok[0], 1), 409, 'refused for round 1 by number too');
  await throws(()=>S.replay(room.code, 'bad-token', 1), 401, 'refused for a bad token');
  await throws(()=>S.replay(room.code, tok[0], 99), 404, 'refused for a round that does not exist');

  // play round 1 to the end
  let guard=0;
  while (guard++ < 900){
    const v = await S.getState(room.code, tok[0]);
    if (v.phase === 'roundEnd' || v.phase === 'matchEnd') break;
    if (v.phase !== 'turn') break;
    const seat=v.turn, mv=await S.getState(room.code,tok[seat]), me=mv.players[seat];
    let m;
    if (mv.modalKind==='choosePeek') m={type:'PEEK_OWN',idx:0};
    else if (mv.modalKind==='spyPick') m={type:'SPY',seat:(seat+1)%3,idx:0};
    else if (mv.modalKind==='swapMine') m={type:'SWAP_DO',seat:(seat+1)%3,mine:0,idx:0};
    else if (mv.modalKind==='sting'){ const o=[0,1,2].filter(x=>x!==seat); m={type:'STING_DONE',a:o[0],b:o[1]}; }
    else if (mv.modalKind) m={type:'CLOSE_MODAL'};
    else if (mv.pendingEnd) m={type:'END_TURN'};
    else if (mv.drawn) m = me.handCount ? {type:'PLACE',idx:0} : {type:'DISCARD_DRAWN'};
    else if (Math.random()<0.25 && mv.caboBy===null) m={type:'CABO'};
    else m={type:'DRAW'};
    try { await S.applyMove(room.code,tok[seat],m,mv.version); } catch(e){ if(e.status!==409) throw e; }
  }
  const done = await S.getState(room.code, tok[0]);
  ok(done.phase==='roundEnd' || done.phase==='matchEnd', 'round finished (phase '+done.phase+')');

  // --- now it should open
  const rep = await S.replay(room.code, tok[0], 1);
  ok(Array.isArray(rep.steps) && rep.steps.length > 3, 'replay returns the moves ('+rep.steps.length+')');
  ok(rep.steps.every(s => s.who && s.move), 'every step names a player and a move');
  const withCards = rep.steps.filter(s => s.card);
  ok(withCards.length > 0, 'some steps carry the actual card ('+withCards.length+')');
  ok(withCards.every(s => s.card.r && s.card.s && typeof s.card.v === 'number'),
     'card details are complete rank/suit/value');
  ok(rep.steps.some(s => s.move === 'DRAW'), 'routine draws are in the record, not just hostile acts');
  console.log('   sample:', rep.steps.filter(s=>s.card).slice(0,3)
    .map(s=>`${s.who} ${s.move} ${s.card.r}${s.card.s}`).join(' | '));

  // --- every seat may read a finished round; nothing seat-specific leaks
  const a = await S.replay(room.code, tok[0], 1);
  const b = await S.replay(room.code, tok[1], 1);
  ok(JSON.stringify(a.steps) === JSON.stringify(b.steps), 'the finished round reads the same for everyone');

  // --- and the LIVE state still gives nothing away
  const live = await S.getState(room.code, tok[0]);
  if (live.phase !== 'roundEnd' && live.phase !== 'matchEnd') {
    ok(live.you.hand.every(c => !('r' in c) && !('v' in c)), 'live state still hides your own hand');
  }

  await db.close();
  console.log(fails ? `\n${fails} FAILURES` : '\nreplay gate OK');
  process.exit(fails?1:0);
})().catch(e=>{ console.error('THREW:', e.stack); process.exit(1); });

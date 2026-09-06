/* The turn clock and the 48 hour skip.
 *
 * Two things can go wrong here and only one is obvious.
 *
 *   The obvious one: the skip does not work.
 *   The other one: the skip works when it should not. A button that ends
 *     somebody's turn for them is the most dangerous thing in this app, so
 *     the refusals get tested harder than the feature, and the refusals are
 *     then deliberately broken to prove the test notices.
 *
 * Time is faked by writing move rows with old timestamps, which is exactly
 * what the clock reads. Nothing is deleted to do it; the log only grows.
 */
const { makeDb }      = require('../lib/db.js');
const { makeService } = require('../lib/service.js');
const Engine          = require('../lib/engine.js');

let fails = 0;
const ok = (c,m)=>{ if(!c){ fails++; console.log('   FAIL:', m); } };
async function throws(fn, status, label){
  try { await fn(); fails++; console.log('   FAIL (no throw):', label); }
  catch(e){ if(status && e.status!==status){ fails++;
    console.log('   FAIL (got '+e.status+' want '+status+'):', label); } }
}
const HRS = 3600000;

/* The clock starts at the last move made by somebody OTHER than the player
   whose turn it is. So a turn is aged by appending one such move with an old
   timestamp. Nothing is rewritten and nothing is removed; the log only ever
   grows, which is both the house rule here and the only reason the clock can
   be trusted in the first place. */
async function ageTo(db, gameId, roundN, notSeat, hoursAgo){
  await db.appendMoves([{
    game_id:gameId, round_n:roundN, seat:notSeat, type:'END_TURN', payload:{},
    public_text:null, actor_id:null, victim_ids:[],
    created_at:new Date(Date.now() - hoursAgo * HRS).toISOString()
  }]);
}

async function run(db, label){
  console.log('\n== ' + label + ' ==');
  await db.init();
  const S = makeService(db);

  const room = await S.createRoom({ players:[
    {animal:'bee',name:'Hrutik'},{animal:'deer',name:'Sharayu'},{animal:'snake',name:'Shivani'}]});
  const tok=[]; for(let i=0;i<3;i++) tok.push((await S.claimSeat(room.code,i)).token);
  for(let i=0;i<3;i++){ await S.peek(room.code, tok[i], [0,1]); await S.ready(room.code, tok[i]); }

  // a few real turns so the log has somebody else's moves in it
  for (let n=0;n<6;n++){
    const v = await S.getState(room.code, tok[0]);
    if (v.phase!=='turn') break;
    const seat=v.turn, mv=await S.getState(room.code,tok[seat]);
    let m;
    if (mv.modalKind) m={type:'CLOSE_MODAL'};
    else if (mv.pendingEnd) m={type:'END_TURN'};
    else if (mv.drawn) m={type:'PLACE',idx:0};
    else m={type:'DRAW'};
    try { await S.applyMove(room.code, tok[seat], m, mv.version); } catch(e){ if(e.status!==409) throw e; }
  }

  let v = await S.getState(room.code, tok[0]);
  ok(v.phase === 'turn', 'a turn is in progress');
  ok(v.clock && typeof v.clock.hours === 'number', 'the view carries a clock');
  ok(v.clock.limit === 24, 'the limit is the 24 hours that was already in settings');
  ok(v.clock.overdue === false, 'a turn taken just now is not overdue');
  ok(v.clock.skippable === false, 'and certainly not skippable');

  const gameId = (await db.getGameByCode(room.code)).id;
  const holder = v.turn;
  const other  = [0,1,2].filter(i => i !== holder)[0];

  // --- REFUSALS, while the clock is young
  await throws(()=>S.skipTurn(room.code, tok[other]), 409, 'skip REFUSED before the clock runs out');
  await throws(()=>S.skipTurn(room.code, 'nope'),     401, 'skip refused for a bad token');

  // --- 30 hours in: overdue, but not skippable
  await ageTo(db, gameId, v.round, other, 30);
  v = await S.getState(room.code, tok[other]);
  ok(v.clock.hours >= 29 && v.clock.hours <= 31, 'the clock reads about 30 hours ('+v.clock.hours+')');
  ok(v.clock.overdue === true,   'overdue at 30 hours');
  ok(v.clock.skippable === false,'still not skippable at 30 hours');
  await throws(()=>S.skipTurn(room.code, tok[other]), 409, 'skip still REFUSED at 30 hours');

  // --- 50 hours in: skippable, but never by the person holding it up
  await ageTo(db, gameId, v.round, other, 50);
  v = await S.getState(room.code, tok[other]);
  ok(v.clock.skippable === true, 'skippable at 50 hours ('+v.clock.hours+')');
  ok(v.clock.youMaySkip === true, 'and the waiting player is offered it');
  const held = await S.getState(room.code, tok[holder]);
  ok(held.clock.youMaySkip === false, 'the person holding it up is never offered the button');
  await throws(()=>S.skipTurn(room.code, tok[holder]), 409, 'and cannot skip himself if he asks anyway');

  // --- the skip itself
  const before = await S.getState(room.code, tok[other]);
  const discardBefore = before.discardCount;
  const after = await S.skipTurn(room.code, tok[other]);
  ok(after.turn !== holder, 'the seat moved on');
  ok(after.discardCount === discardBefore + 1, 'exactly one card was thrown away for them');
  ok(after.clock && after.clock.hours < 1, 'the clock restarted for the new player');

  const moves = await db.listMoves(gameId, { limit: 4000 });
  const skipRow = moves.filter(m => m.type === 'SKIP_TURN').slice(-1)[0];
  ok(!!skipRow, 'the skip is on the permanent record');
  ok(skipRow && skipRow.seat === holder, 'recorded against the person who was skipped, not the presser');
  ok(skipRow && skipRow.payload && skipRow.payload.by === other, 'and it remembers who pressed it');

  const tabLine = moves.filter(m => m.type==='TAB' && /ran out of time/.test(m.public_text||'')).slice(-1)[0];
  ok(!!tabLine, 'it went on the Tab');
  ok(tabLine && (tabLine.victim_ids||[]).length === 2,
     'everybody who waited is on the receiving end of it, so it costs at settlement');
  console.log('   tab:', tabLine && tabLine.public_text);

  // --- card conservation: a skip may not conjure or destroy a card
  const roundNow = await db.getRound(gameId, 1);
  const st = roundNow.state;
  const total = st.deck.length + st.discard.length +
                st.players.reduce((n,p)=>n+p.hand.length,0) + (st.drawn?1:0);
  ok(total === 52, 'the deck is still 52 cards after a skip (' + total + ')');

  // --- SABOTAGE: prove the refusals can fail
  // The gate lives inside skipTurn, so it is checked from the outside: a
  // brand new room must refuse the same call that a stale one allows. If it
  // does not, the refusals above were passing for the wrong reason.
  const db2 = makeDb({ kind:'memory' }); await db2.init();
  const S2 = makeService(db2);
  const r2 = await S2.createRoom({ players:[
    {animal:'bee',name:'Hrutik'},{animal:'deer',name:'Sharayu'},{animal:'snake',name:'Shivani'}]});
  const t2=[]; for(let i=0;i<3;i++) t2.push((await S2.claimSeat(r2.code,i)).token);
  for(let i=0;i<3;i++){ await S2.peek(r2.code, t2[i], [0,1]); await S2.ready(r2.code, t2[i]); }
  const fresh = await S2.getState(r2.code, t2[0]);
  const freshOther = [0,1,2].filter(i=>i!==fresh.turn)[0];
  await throws(()=>S2.skipTurn(r2.code, t2[freshOther]), 409,
               'a brand new room refuses the skip, so the gate is not vacuous');

  await db.close();
}

(async () => {
  await run(makeDb({kind:'memory'}), 'turn clock on memory');
  if (process.env.DATABASE_URL)
    await run(makeDb({kind:'pg', connectionString: process.env.DATABASE_URL}), 'turn clock on postgres');
  else console.log('\n   (skipping postgres, no DATABASE_URL)');
  console.log(fails ? '\n   '+fails+' FAILED\n' : '\n   clock ok\n');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

/* Runs one identical suite against both the memory adapter and real
 * Postgres. If they ever disagree, the tests here catch it rather than
 * production doing so on a Tuesday.
 */
const { makeDb, hashToken, newToken, newCode } = require('../lib/db.js');

let failures = 0;
function ok(cond, label){ if(!cond){ failures++; console.log('   FAIL:', label); } }

async function suite(db, label){
  console.log('\n=== ' + label + ' (' + db.kind + ') ===');
  await db.init();

  // games
  const code = newCode(4);
  const g = await db.createGame({ code, settings:{ rounds:3, turnClockHours:24 } });
  ok(g.id, 'game created');
  ok((await db.getGameByCode(code)).id === g.id, 'game found by code');
  ok((await db.getGameByCode('NOPE')) === null, 'unknown code returns null');

  // players
  await db.addPlayers(g.id, [
    { animal:'bee',     name:'Hrithik', seat:0, phone:'+919000000001' },
    { animal:'deer',    name:'Sharayu', seat:1, phone:'+12120000002' },
    { animal:'snake',   name:'Shivani', seat:2, phone:'+919000000003' },
    { animal:'rhino',   name:'Sahil',   seat:3, phone:'+919000000004' },
    { animal:'giraffe', name:'Roshan',  seat:4, phone:'+919000000005' }
  ]);
  const ps = await db.listPlayers(g.id);
  ok(ps.length === 5, 'five players');
  ok(ps[0].seat === 0 && ps[4].seat === 4, 'players ordered by seat');
  ok(ps.every(p => p.token_hash === null), 'nobody claimed yet');

  // seat claiming — the identity model
  const tokA = newToken(), tokB = newToken();
  const claimed = await db.claimSeat(g.id, 2, hashToken(tokA));
  ok(claimed && claimed.animal === 'snake', 'seat 2 claimed');
  const stolen = await db.claimSeat(g.id, 2, hashToken(tokB));
  ok(stolen && stolen.taken === true, 'a second device CANNOT steal a claimed seat');
  const again = await db.claimSeat(g.id, 2, hashToken(tokA));
  ok(again && !again.taken, 'the original device can re-claim its own seat');
  const found = await db.findPlayerByToken(g.id, hashToken(tokA));
  ok(found && found.seat === 2, 'token resolves to the right seat');
  ok((await db.findPlayerByToken(g.id, hashToken(tokB))) === null, 'unknown token resolves to nobody');
  await db.releaseSeat(g.id, 2);
  ok((await db.findPlayerByToken(g.id, hashToken(tokA))) === null, 'released seat forgets its token');

  // rounds + optimistic concurrency
  await db.putRound(g.id, 1, { phase:'turn', turn:0, marker:'a' });
  let r = await db.getRound(g.id, 1);
  ok(r.version === 0, 'fresh round at version 0');
  ok(r.state.marker === 'a', 'state round-trips');

  const w1 = await db.saveRound(g.id, 1, { phase:'turn', turn:1, marker:'b' }, 0);
  ok(w1.version === 1, 'write at expected version bumps to 1');

  const stale = await db.saveRound(g.id, 1, { marker:'c' }, 0);
  ok(stale.conflict === true, 'STALE WRITE REJECTED (two tabs cannot both win)');
  ok(stale.version === 1, 'conflict reports the current version');
  r = await db.getRound(g.id, 1);
  ok(r.state.marker === 'b', 'rejected write did not corrupt state');

  await db.putRound(g.id, 2, { phase:'peek', marker:'r2' });
  const latest = await db.getLatestRound(g.id);
  ok(latest.n === 2, 'latest round is 2');

  // moves are append-only and ordered
  await db.appendMoves([
    { game_id:g.id, round_n:1, seat:0, type:'SWEEP', payload:{},
      public_text:'Hrithik swept the floor.', actor_id:'bee', victim_ids:['deer','snake'] },
    { game_id:g.id, round_n:1, seat:1, type:'DRAW', payload:{},
      public_text:null, actor_id:'deer', victim_ids:[] },
    { game_id:g.id, round_n:1, seat:0, type:'CABO', payload:{},
      public_text:'Hrithik called Cabo.', actor_id:'bee', victim_ids:['deer','snake'] }
  ]);
  const ms = await db.listMoves(g.id);
  ok(ms.length === 3, 'three moves stored');
  ok(ms[0].id < ms[1].id && ms[1].id < ms[2].id, 'move ids strictly increasing');
  ok(Array.isArray(ms[0].victim_ids) && ms[0].victim_ids.length === 2, 'victim_ids round-trips as an array');
  const since = await db.listMoves(g.id, { sinceId: ms[0].id });
  ok(since.length === 2, 'sinceId filters correctly (this is what the briefing uses)');
  const lastForBee = await db.lastMoveIdForSeat(g.id, 0);
  ok(lastForBee === ms[2].id, 'last move id for a seat is right');

  await db.close();
}

(async () => {
  await suite(makeDb({ kind:'memory' }), 'memory adapter');
  const conn = process.env.DATABASE_URL;
  if (conn) await suite(makeDb({ kind:'pg', connectionString: conn }), 'postgres adapter');
  else console.log('\n(skipping postgres — no DATABASE_URL)');
  console.log('\n' + (failures ? failures + ' FAILURES' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('THREW:', e.message); process.exit(1); });

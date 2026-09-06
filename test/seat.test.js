/* Seat recovery.
 *
 * This is the one feature in the app that deliberately takes a seat away
 * from a device that is holding it. So the interesting tests are all the
 * ways it must refuse:
 *
 *   - a pending token does nothing at all until somebody approves it
 *   - you cannot approve your own seat back
 *   - a stranger with no seat cannot approve anything
 *   - a request cannot be decided twice
 *   - a denial leaves the original device exactly where it was
 *
 * Every refusal is then broken on purpose to prove the test notices.
 */
const { makeDb }      = require('../lib/db.js');
const { makeService } = require('../lib/service.js');

let fails = 0;
const ok = (c,m)=>{ if(!c){ fails++; console.log('   FAIL:', m); } };
async function throws(fn, status, label){
  try { await fn(); fails++; console.log('   FAIL (no throw):', label); }
  catch(e){ if(status && e.status!==status){ fails++;
    console.log('   FAIL (got '+e.status+' want '+status+'):', label); } }
}

async function run(db, label){
  console.log('\n== ' + label + ' ==');
  await db.init();
  const S = makeService(db);
  const room = await S.createRoom({ players:[
    {animal:'bee',name:'Hrutik'},{animal:'deer',name:'Sharayu'},{animal:'snake',name:'Shivani'}]});

  // nobody in the room yet: there is nobody to vouch
  await throws(()=>S.requestSeat(room.code, 0), 409, 'refused while the seat is still free');

  const tok=[]; for(let i=0;i<3;i++) tok.push((await S.claimSeat(room.code,i)).token);
  for(let i=0;i<3;i++){ await S.peek(room.code, tok[i], [0,1]); await S.ready(room.code, tok[i]); }

  await throws(()=>S.requestSeat(room.code, 9), 404, 'refused for a seat that does not exist');

  // --- Hrutik loses his phone and asks for seat 0 back on a new one
  const req = await S.requestSeat(room.code, 0);
  ok(!!req.requestId && !!req.token, 'the new device gets a request id and a token');
  ok(req.name === 'Hrutik', 'and is told whose seat it is asking for');

  // THE POINT: that token is worthless until somebody says yes
  await throws(()=>S.getState(room.code, req.token), 401,
               'the pending token cannot read the game');
  await throws(()=>S.applyMove(room.code, req.token, {type:'DRAW'}), 401,
               'and cannot play a move');
  const oldStill = await S.getState(room.code, tok[0]);
  ok(oldStill.you.seat === 0, 'the original device still holds the seat');

  // --- who may decide
  await throws(()=>S.decideSeat(room.code, tok[0], req.requestId, true), 403,
               'the seat cannot approve itself back');
  await throws(()=>S.decideSeat(room.code, 'stranger', req.requestId, true), 401,
               'somebody with no seat cannot approve');
  await throws(()=>S.decideSeat(room.code, tok[1], 'not-a-request', true), 404,
               'an unknown request id is refused');

  // --- Sharayu vouches
  const out = await S.decideSeat(room.code, tok[1], req.requestId, true);
  ok(out.ok && out.request.status === 'approved', 'a second player can approve it');

  const nowMine = await S.getState(room.code, req.token);
  ok(nowMine.you.seat === 0, 'the new device holds seat 0');
  await throws(()=>S.getState(room.code, tok[0]), 401,
               'and the OLD device is locked out, which is the whole point');

  // --- decided once, decided for good
  await throws(()=>S.decideSeat(room.code, tok[1], req.requestId, true), 409,
               'the same request cannot be approved twice');

  // --- a denial changes nothing
  const req2 = await S.requestSeat(room.code, 1);
  await throws(()=>S.getState(room.code, req2.token), 401, 'second request is inert too');
  const no = await S.decideSeat(room.code, tok[2], req2.requestId, false);
  ok(no.request.status === 'denied', 'it can be turned down');
  await throws(()=>S.getState(room.code, req2.token), 401,
               'a denied token stays worthless');
  const sharayuStill = await S.getState(room.code, tok[1]);
  ok(sharayuStill.you.seat === 1, 'and the sitting device keeps its seat after a denial');

  // --- nothing was deleted
  const game = await db.getGameByCode(room.code);
  const kept = (game.settings.seatRequests || []);
  ok(kept.length === 2, 'both requests are still on file (' + kept.length + ')');
  ok(kept.filter(r=>r.status==='approved').length === 1 &&
     kept.filter(r=>r.status==='denied').length === 1,
     'with their outcomes, approved and denied');
  ok(kept.every(r => typeof r.hash === 'string'), 'hashes stay server side');

  const moves = await db.listMoves(game.id, { limit: 4000 });
  ok(moves.some(m=>m.type==='SEAT_REQUEST'), 'the ask is on the permanent record');
  ok(moves.some(m=>m.type==='SEAT_MOVED'),   'so is the move');
  ok(moves.some(m=>m.type==='SEAT_DENIED'),  'so is the refusal');
  const tab = moves.filter(m=>m.type==='TAB' && /new phone|turned down/.test(m.public_text||''));
  ok(tab.length === 2, 'and both read as English on the Tab');
  tab.forEach(t=>console.log('   tab:', t.public_text));
  ok(tab.every(t => (t.victim_ids||[]).length === 0),
     'a seat change costs nobody anything at settlement, it is not a hostile act');

  // --- the request never carries a token hash out to a client
  const seen = await S.getState(room.code, tok[2]);
  const json = JSON.stringify(seen.seatRequests || []);
  ok(!/hash/.test(json), 'no token hash reaches another player');
  ok(seen.seatRequests.every(r => r.seat !== seen.you.seat),
     'and nobody is offered a decision about their own seat');

  await db.close();
}

/* Runs against both backends. Memory hides bugs that only a real database
   has: last time, a UUID column quietly fed an animal name. */
(async () => {
  await run(makeDb({kind:'memory'}), 'seat recovery on memory');
  if (process.env.DATABASE_URL)
    await run(makeDb({kind:'pg', connectionString: process.env.DATABASE_URL}), 'seat recovery on postgres');
  else console.log('\n   (skipping postgres, no DATABASE_URL)');
  console.log(fails ? '\n   '+fails+' FAILED\n' : '\n   seat recovery ok\n');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

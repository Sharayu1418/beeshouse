/* Burning a card onto a matching discard, without waiting for your turn.
 *
 * This is the one move anybody may make while it is not their turn, which
 * is the rule in the physical game. ONE person gets it, and the first press
 * takes it: see the pile, call it, and somebody was quicker or they were
 * not. The go comes back when the game moves on.
 *
 * That cap is not decoration. Without it, somebody who never takes a turn
 * at all can burn wrong cards forever. Their hand is theirs to ruin, but
 * the DECK IS SHARED, and four hundred attempts leaves a hand holding 404
 * cards and the deck at zero. That is a measured number, and it is asserted
 * below.
 *
 * Four things are load bearing and each is proved able to fail at the
 * bottom of this file:
 *
 *   1. The seat comes from the token. A client cannot burn somebody else's
 *      cards by saying it is them.
 *   2. Out of turn you may burn to one card and never to none, because
 *      emptying a hand ends the round and a round must not end in the
 *      middle of somebody else's move.
 *   3. Somebody else's burn does not wind the turn clock back. If it did,
 *      anybody could keep the person sitting on the game from being
 *      skipped, forever.
 *   4. Everything else still waits its turn.
 */
const { makeDb }      = require('../lib/db.js');
const { makeService } = require('../lib/service.js');

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('   FAIL:', m); } };
async function throws(fn, status, label) {
  try { await fn(); fails++; console.log('   FAIL (no throw):', label); }
  catch (e) { if (status && e.status !== status) {
    fails++; console.log('   FAIL (got ' + e.status + ' want ' + status + '):', label); } }
}

const ROSTER = [{animal:'bee',name:'Hrutik'},{animal:'deer',name:'Sharayu'},
                {animal:'snake',name:'Shivani'},{animal:'rhino',name:'Sahil'},
                {animal:'giraffe',name:'Roshan'}];

async function table(db) {
  const S = makeService(db);
  const r = await S.createRoom({ players: ROSTER });
  const tok = [];
  for (let i = 0; i < 5; i++) tok.push((await S.claimSeat(r.code, i)).token);
  for (let i = 0; i < 5; i++) { await S.peek(r.code, tok[i], [0,1]); await S.ready(r.code, tok[i]); }
  return { S, code: r.code, tok };
}

/* Deal a known situation rather than waiting for one to happen. */
async function rig(db, code, fn) {
  const g = await db.getGameByCode(code);
  const rd = await db.getLatestRound(g.id);
  fn(rd.state);
  await db.saveRound(g.id, rd.n, rd.state, rd.version);
  return rd.state;
}

async function run(db, label) {
  console.log('\n=== ' + label + ' ===');
  await db.init();
  const { S, code, tok } = await table(db);

  const st = await rig(db, code, function (s) {
    const top = s.discard[s.discard.length - 1];
    const t = s.turn;
    s.players[(t+1)%5].hand[0] = { id:'cA', r: top.r, s:'H' };
    s.players[(t+2)%5].hand[1] = { id:'cB', r: top.r, s:'D' };
    s.players[(t+3)%5].hand[2] = { id:'cC', r: top.r === 'K' ? '2' : 'K', s:'C' };
  });
  const turn = st.turn, a = (turn+1)%5, b = (turn+2)%5, c = (turn+3)%5;
  const topRank = st.discard[st.discard.length - 1].r;

  const hand = async (seat) => (await S.getState(code, tok[seat])).players[seat].handCount;
  async function burn(seat, idx) {
    const v = await S.getState(code, tok[seat]);
    return await S.applyMove(code, tok[seat], { type:'SLAP_GO', idx: idx }, v.version);
  }

  // --- anybody, any time, and no race ---------------------------------
  ok(await hand(a) === 4 && await hand(b) === 4, 'everybody starts with four');
  await burn(a, [0]);
  ok(await hand(a) === 3, 'THE POINT: you can burn a match while it is not your turn');

  const mid = await S.getState(code, tok[b]);
  ok(mid.discardTop.r === topRank,
     'the burned card lands face up, so the rank on top is unchanged');
  ok(mid.burnedBy === a, 'and the table can see who took the go');
  await throws(() => burn(b, [1]), 409,
     'THE POINT: somebody else holding one is too late, the first press took it');
  ok(await hand(b) === 4, 'being second costs them nothing, it just does not happen');

  // --- but only ONE person gets a go, and the first one took it --------
  await throws(() => burn(c, [2]), 409, 'the third person is told somebody called it first');
  ok(await hand(c) === 4, 'and their hand is untouched, no penalty for being slow');

  /* THE ONE THAT MATTERS.
     Four hundred wrong burns, taking no turn at all, used to leave a hand
     holding 404 cards and the DECK AT ZERO. The hand is theirs to ruin; the
     deck is everybody's. That is the whole reason this is capped. */
  await rig(db, code, function (s) { s.burnedBy = null; });
  const deckBefore = (await S.getState(code, tok[a])).deckCount;
  let got = 0;
  for (let i = 0; i < 400; i++) {
    try { await burn(a, [0]); got++; } catch (e) { break; }
  }
  const after = await S.getState(code, tok[a]);
  ok(got === 1, 'THE POINT: four hundred attempts get through exactly once (' + got + ')');
  ok(after.deckCount >= deckBefore - 1,
     'so the shared deck cannot be drained by somebody who never takes a turn (' +
     deckBefore + ' -> ' + after.deckCount + ')');
  ok(after.players[a].handCount <= 5, 'and no hand ends up holding hundreds of cards');

  // --- and being wrong still costs, and still spends it ----------------
  await rig(db, code, function (s) {
    const t = s.discard[s.discard.length-1].r;
    s.burnedBy = null;
    s.players[c].hand[2] = { id:'cW', r: t === 'K' ? '2' : 'K', s:'C' };
  });
  const cBefore = await hand(c);
  await burn(c, [2]);
  ok(await hand(c) === cBefore + 1, 'a wrong burn takes a penalty card rather than doing nothing');
  ok((await S.getState(code, tok[c])).burnedBy === c, 'and being wrong still spends the go');
  await throws(() => burn(b, [1]), 409, 'so nobody else can try after a miss either');

  // --- the turn is untouched ------------------------------------------
  const v = await S.getState(code, tok[turn]);
  ok(v.turn === turn, 'it is still the same person to play');
  ok(v.yourTurn === true, 'and their screen still says so');
  await S.applyMove(code, tok[turn], { type:'DRAW' }, v.version);
  ok((await S.getState(code, tok[turn])).drawn != null, 'who can still play their turn');

  // --- the go comes back when the game moves on -----------------------
  /* Placed here on purpose: this ends a turn, and every assertion above
     depends on the same person still being up. */
  const tv2 = await S.getState(code, tok[turn]);
  await S.applyMove(code, tok[turn], { type:'PLACE', idx:0 }, tv2.version);
  const tv3 = await S.getState(code, tok[turn]);
  await S.applyMove(code, tok[turn], { type:'END_TURN' }, tv3.version);
  const fresh = await S.getState(code, tok[a]);
  ok(fresh.burnedBy === null, 'a turn going by gives the table its go back');
  ok(fresh.turn !== turn, 'because the turn has actually moved');

  /* Wind it back so the rest of the file can go on talking about the same
     people. Everything below is about who may do what out of turn, and it
     is clearer with one fixed cast than with the seat rotating underneath
     each assertion. */
  await rig(db, code, function (st2) { st2.turn = turn; st2.burnedBy = null; st2.drawn = null;
                                       st2.pendingEnd = false; });

  // --- one card must stay ---------------------------------------------
  await rig(db, code, function (s) {
    s.burnedBy = null;
    s.players[a].hand = [{ id:'cZ', r: s.discard[s.discard.length-1].r, s:'S' }];
  });
  await burn(a, [0]).catch(function(){});
  ok(await hand(a) === 1,
     'THE POINT: out of turn you cannot burn your last card, because that ends the round');

  await rig(db, code, function (s) {
    s.burnedBy = null;
    const t = s.discard[s.discard.length-1].r;
    s.players[a].hand = [{ id:'cY1', r:t, s:'S' }, { id:'cY2', r:t, s:'H' }];
  });
  await burn(a, [0]);
  ok(await hand(a) === 1, 'but you may burn down TO one');

  // --- the seat comes from the token, never the client -----------------
  await rig(db, code, function (s) {
    s.burnedBy = null;
    const t = s.discard[s.discard.length-1].r;
    s.players[a].hand = [{ id:'cP', r:t, s:'S' }, { id:'cQ', r:t, s:'H' }, { id:'cR', r:'4', s:'C' }];
    s.players[b].hand = [{ id:'cS', r:t, s:'D' }, { id:'cT', r:t, s:'C' }, { id:'cU', r:'5', s:'H' }];
  });
  const bBefore = await hand(b);
  const vv = await S.getState(code, tok[a]);
  await S.applyMove(code, tok[a], { type:'SLAP_GO', idx:[0], by: b, seat: b }, vv.version);
  ok(await hand(b) === bBefore,
     'THE POINT: claiming to be another seat burns nothing of theirs');
  ok(await hand(a) === 2, 'it burned the cards of whoever actually holds the token');

  // --- everything else still waits its turn ----------------------------
  const v2 = await S.getState(code, tok[a]);
  await throws(() => S.applyMove(code, tok[a], { type:'DRAW' }, v2.version), 409,
               'drawing out of turn is still refused');
  await throws(() => S.applyMove(code, tok[a], { type:'CABO' }, v2.version), 409,
               'calling Cabo out of turn is still refused');
  await throws(() => S.applyMove(code, tok[a], { type:'SWEEP' }, v2.version), 409,
               'sweeping out of turn is still refused');
  await throws(() => S.applyMove(code, tok[a], { type:'SLAP_TOGGLE', idx:0 }, v2.version), 409,
               'and the shared selection is still only for whoever is playing');
  await throws(() => S.applyMove(code, tok[a], { type:'SLAP_GO' }, v2.version), 400,
               'a burn with no selection is refused rather than guessing');

  /* The cap lives in the engine AND at the door, and the door was hiding
     the engine. Removing the reducer's guard left every assertion above
     still passing, because applyMove refuses it first. So the reducer is
     also checked on its own, with no service anywhere near it. */
  {
    const E = require('../lib/engine.js');
    const base = {
      phase:'turn', turn:0, burnedBy:2, discard:[{id:'c1',r:'7',s:'S'}], deck:[],
      sel:[], log:[], round:1, players:[
        { id:'bee', name:'Hrutik', hand:[{id:'h1',r:'7',s:'H'},{id:'h2',r:'2',s:'C'}] },
        { id:'deer', name:'Sharayu', hand:[{id:'d1',r:'7',s:'D'},{id:'d2',r:'3',s:'C'}] },
        { id:'snake', name:'Shivani', hand:[{id:'s1',r:'7',s:'C'},{id:'s2',r:'4',s:'C'}] }
      ]
    };
    const blocked = E.reducer(base, { type:'SLAP_GO', by:1, idx:[0] });
    ok(blocked.players[1].hand.length === 2,
       'the reducer refuses a second burn on its own, with no service involved');

    const open = E.reducer(Object.assign({}, base, { burnedBy:null }),
                           { type:'SLAP_GO', by:1, idx:[0] });
    ok(open.players[1].hand.length === 1, 'and allows the first one');
    ok(open.burnedBy === 1, 'recording who took it');
  }

  // --- a burn must not wind the turn clock back ------------------------
  const g = await db.getGameByCode(code);
  const long = new Date(Date.now() - 50 * 3600000).toISOString();
  await db.appendMoves([{ game_id:g.id, round_n:1, seat:(turn+4)%5, type:'END_TURN',
                          payload:{}, public_text:null, actor_id:null, victim_ids:[],
                          created_at: long }]);
  const beforeClock = (await S.getState(code, tok[a])).clock;
  ok(beforeClock && beforeClock.skippable,
     'after fifty hours the person holding the turn can be skipped (' +
     (beforeClock ? beforeClock.hours + 'h' : 'no clock') + ')');

  await rig(db, code, function (s) {
    s.burnedBy = null;
    s.players[a].hand = [{ id:'cW1', r:s.discard[s.discard.length-1].r, s:'S' },
                         { id:'cW2', r:'9', s:'H' }];
  });
  await burn(a, [0]);
  const afterClock = (await S.getState(code, tok[a])).clock;
  ok(afterClock && afterClock.skippable,
     'THE POINT: somebody burning a card does not rescue whoever is sitting on the game (' +
     (afterClock ? afterClock.hours + 'h' : 'no clock') + ')');

  await db.close();
}

(async () => {
  await run(makeDb({ kind:'memory' }), 'burning early, on memory');
  if (process.env.DATABASE_URL)
    await run(makeDb({ kind:'pg', connectionString: process.env.DATABASE_URL }), 'burning early, on postgres');
  console.log('\n' + (fails ? fails + ' FAILURES' : 'ALL PASS'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('THREW:', e.stack); process.exit(1); });

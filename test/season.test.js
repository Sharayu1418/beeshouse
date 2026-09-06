/* Seasons.
 *
 *   1. A running total across matches, with the Tab still settling per
 *      match. Real matches, played end to end, on both backends.
 *
 *   2. The things Phase 3 added on top: a finished match promoted into
 *      match 1 of a season, the next match dealing itself with the roster
 *      carried over, five phones pressing that button at once, the season
 *      closing on its target, and the settlement over all of it.
 *
 *   3. It leaks nothing. A season is a query over `moves` and `scores`, so
 *      the same rule as the recap applies: no rank, no suit, no value may
 *      reach it. That check is written to be able to fail and is proved to
 *      fail at the bottom of this file.
 */
const { makeDb } = require('../lib/db.js');
const { makeService } = require('../lib/service.js');

let fails=0;
const ok=(c,m)=>{ if(!c){ fails++; console.log('   FAIL:', m); } };
async function throws(fn,status,label){
  try{ await fn(); fails++; console.log('   FAIL (no throw):', label); }
  catch(e){ if(status && e.status!==status){ fails++; console.log('   FAIL (got '+e.status+'):', label); } }
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

async function playMatch(S, code, tok, n){
  for (let i=0;i<n;i++){ await S.peek(code, tok[i], [0,1]).catch(()=>{}); await S.ready(code, tok[i]).catch(()=>{}); }
  let guard=0;
  while (guard++ < 4000){
    const v = await S.getState(code, tok[0]);
    if (v.phase === 'matchEnd') return v;
    if (v.phase === 'roundEnd'){
      for (let i=0;i<n;i++){ await S.peek(code, tok[i], [0,1]).catch(()=>{}); await S.ready(code, tok[i]).catch(()=>{}); }
      await S.nextRound(code, tok[0]); continue;
    }
    if (v.phase === 'peek'){ for (let i=0;i<n;i++){ await S.peek(code, tok[i], [0,1]).catch(()=>{}); await S.ready(code, tok[i]).catch(()=>{}); } continue; }
    if (v.phase !== 'turn') break;
    const seat=v.turn, mv=await S.getState(code,tok[seat]), me=mv.players[seat];
    let m;
    if (mv.modalKind==='choosePeek') m={type:'PEEK_OWN',idx:0};
    else if (mv.modalKind==='spyPick') m={type:'SPY',seat:(seat+1)%n,idx:0};
    else if (mv.modalKind==='swapMine') m={type:'SWAP_DO',seat:(seat+1)%n,mine:0,idx:0};
    else if (mv.modalKind==='sting'){ const o=[...Array(n).keys()].filter(x=>x!==seat);
      m = o.length>=2 ? {type:'STING_DONE',a:o[0],b:o[1]} : {type:'CLOSE_MODAL'}; }
    else if (mv.modalKind) m={type:'CLOSE_MODAL'};
    else if (mv.pendingEnd) m={type:'END_TURN'};
    else if (mv.drawn) m = me.handCount ? {type:'PLACE',idx:0} : {type:'DISCARD_DRAWN'};
    else if (Math.random()<0.3 && mv.caboBy===null) m={type:'CABO'};
    else m={type:'DRAW'};
    try{ await S.applyMove(code,tok[seat],m,mv.version); }catch(e){ if(e.status!==409) throw e; }
  }
  return await S.getState(code, tok[0]);
}

async function run(db, label){
  console.log('\n=== ' + label + ' ===');
  await db.init();
  const S = makeService(db);
  const N = 3;
  const roster = [{animal:'bee',name:'Hrutik'},{animal:'deer',name:'Sharayu'},{animal:'snake',name:'Shivani'}];

  // --- start a season of 2 matches
  const season = await S.createSeason({ name:'September', matchTarget: 2 });
  ok(/^[A-Z0-9]{5}$/.test(season.code), 'season code minted');
  ok(season.matchTarget === 2, 'match target stored');
  await throws(()=>S.seasonStandings('NOPE1'), 404, 'unknown season rejected');

  let st = await S.seasonStandings(season.code);
  ok(st.matchesPlayed === 0 && st.standings.length === 0, 'a new season is empty');

  // --- match 1
  const r1 = await S.createRoom({ players: roster, seasonCode: season.code });
  ok(r1.season && r1.season.matchNo === 1, 'match 1 belongs to the season');
  const t1=[]; for(let i=0;i<N;i++) t1.push((await S.claimSeat(r1.code,i)).token);
  const end1 = await playMatch(S, r1.code, t1, N);
  ok(end1.phase === 'matchEnd', 'match 1 finished');

  st = await S.seasonStandings(season.code);
  ok(st.standings.length === N, 'all three players on the board after one match');
  ok(st.standings.every(p => typeof p.total === 'number'), 'everyone has a total');
  ok(st.standings[0].total <= st.standings[st.standings.length-1].total, 'sorted, lowest first');
  const afterOne = st.standings.reduce((a,p)=>a+p.total,0);
  console.log('   after match 1:', st.standings.map(p=>p.name+' '+p.total).join(', '));

  // --- match 2
  const r2 = await S.createRoom({ players: roster, seasonCode: season.code });
  ok(r2.season.matchNo === 2, 'match 2 numbered correctly');
  const t2=[]; for(let i=0;i<N;i++) t2.push((await S.claimSeat(r2.code,i)).token);
  await playMatch(S, r2.code, t2, N);

  st = await S.seasonStandings(season.code);
  const afterTwo = st.standings.reduce((a,p)=>a+p.total,0);
  ok(afterTwo !== afterOne, 'THE POINT: totals carried across matches (' + afterOne + ' -> ' + afterTwo + ')');
  ok(st.matchesPlayed === 2, 'two matches counted');
  ok(st.standings.every(p => p.matches === 2), 'everyone played both matches');
  console.log('   after match 2:', st.standings.map(p=>p.name+' '+p.total).join(', '));

  // --- the season closes itself and refuses a third
  ok(st.status === 'done', 'season closed itself at its match target');
  await throws(()=>S.createRoom({ players: roster, seasonCode: season.code }), 409,
               'a full season refuses another match');

  // --- nothing was deleted: every round of every match is still in scores
  const games = await db.listSeasonGames((await db.getSeasonByCode(season.code)).id);
  const all = await db.listScores(games.map(g=>g.id));
  ok(all.length >= N*2, 'every round of every match is still on record ('+all.length+' rows)');
  ok(all.every(r => r.round_n >= 1), 'each row knows which round it was');


  /* ================================================================
     Phase 3: the season as a thing people can actually see and run.
     ================================================================ */

  // --- a season declared over a match that has already finished ---------
  const solo = await S.createRoom({ players: roster });
  const ts = []; for (let i=0;i<N;i++) ts.push((await S.claimSeat(solo.code,i)).token);

  await throws(()=>S.createSeason({ fromCode: solo.code, token: ts[0], matchTarget: 3 }), 409,
               'a match still being played cannot become a season');

  const soloEnd = await playMatch(S, solo.code, ts, N);
  ok(soloEnd.phase === 'matchEnd', 'the standalone match finished');
  ok(soloEnd.season === null, 'a room with no season says so on the view');

  await throws(()=>S.createSeason({ fromCode: solo.code, token: 'not-a-token', matchTarget: 3 }), 401,
               'promoting needs a seat in the room');

  const s2 = await S.createSeason({ fromCode: solo.code, token: ts[0], matchTarget: 3, name:'October' });
  ok(s2.matchesPlayed === 1, 'the finished match became match 1');
  await throws(()=>S.createSeason({ fromCode: solo.code, token: ts[1], matchTarget: 3 }), 409,
               'a match cannot be promoted twice');
  await throws(()=>S.createSeason({ fromCode: solo.code, token: ts[0], matchTarget: 1 }), 409,
               'and a one-match season is refused (already in one, so 409 first)');

  const vSeason = await S.getState(solo.code, ts[0]);
  ok(vSeason.season && vSeason.season.code === s2.code, 'the view now carries the season');
  ok(vSeason.season.matchNo === 1 && vSeason.season.target === 3, 'match 1 of 3, on the view');

  // --- the standings answer to a ROOM code, which is the link people hold
  const byRoom = await S.seasonStandings(solo.code);
  ok(byRoom.code === s2.code, 'a room code finds its season');
  ok(byRoom.matchesPlayed === 1, 'one match counted');
  ok(byRoom.settlement === null, 'an open season has no settlement yet');
  ok(byRoom.standings.length === N, 'everybody is on the table');

  // --- next match: same people, no re-entry, and safe to press twice ----
  const nm1 = await S.nextMatch(solo.code, ts[0]);
  const nm2 = await S.nextMatch(solo.code, ts[1]);
  ok(nm1.code === nm2.code, 'THE POINT: five phones pressing at once get ONE room');
  ok(nm2.existing === true, 'the second press says it found the room rather than dealing one');
  ok(nm1.matchNo === 2, 'it is match 2');

  const carried = await S.roomInfo(nm1.code);
  ok(carried.seats.length === N, 'the roster travelled');
  ok(carried.seats.every((st,i)=> st.animal === roster[i].animal && st.name === roster[i].name),
     'same animals, same names, nobody re-entered anything');

  await throws(()=>S.nextMatch(nm1.code, 'nope'), 401, 'next match needs a seat');

  // --- play it out, then the last one, and watch the season close -------
  const tn = []; for (let i=0;i<N;i++) tn.push((await S.claimSeat(nm1.code,i)).token);
  await playMatch(S, nm1.code, tn, N);

  let mid = await S.seasonStandings(s2.code);
  ok(mid.matchesPlayed === 2 && mid.status === 'open', 'two down, one to go, still open');
  ok(mid.standings.every(p => p.matches === 2), 'both matches counted per player');

  const nm3 = await S.nextMatch(nm1.code, tn[0]);
  ok(nm3.matchNo === 3, 'match 3 dealt');
  const tl = []; for (let i=0;i<N;i++) tl.push((await S.claimSeat(nm3.code,i)).token);
  await playMatch(S, nm3.code, tl, N);

  const final = await S.seasonStandings(s2.code);
  ok(final.status === 'done', 'the season closed itself on its target');
  ok(final.matchesPlayed === 3, 'three matches played');
  await throws(()=>S.nextMatch(nm3.code, tl[0]), 409, 'a closed season deals no more matches');

  // --- the settlement -------------------------------------------------
  const set = final.settlement;
  ok(!!set, 'a closed season settles');
  ok(set.leader.animal === final.standings[0].animal, 'the leader is whoever is on the lowest total');
  ok(set.rows.length === N, 'everybody is settled');
  ok(set.rows.every(r => r.final === r.base - r.owed), 'settlement arithmetic holds for every row');
  ok(set.rows.find(r=>r.animal===set.leader.animal).owed === 0, 'the leader owes nobody');
  for (let i=1;i<set.rows.length;i++)
    ok(set.rows[i-1].final <= set.rows[i].final, 'settled rows are sorted, lowest first');
  ok(set.winner.animal === set.rows[0].animal, 'the winner is the top settled row');
  ok(set.changed === (set.winner.animal !== set.leader.animal), '`changed` agrees with the rows');
  console.log('   settled:', set.rows.map(r=>r.name+' '+r.base+'−'+r.owed+'='+r.final).join(', '),
              set.changed ? '  (the Tab flipped it)' : '');

  /* The debt is counted off the Tab, so it must equal the Tab. Recount it
     from the raw rows rather than trusting the number the service printed. */
  const allGames = await db.listSeasonGames((await db.getSeasonByCode(s2.code)).id);
  let allTab = [];
  for (const g of allGames) {
    const ms = await db.listMoves(g.id, { limit: 4000 });
    allTab = allTab.concat(ms.filter(m => m.type === 'TAB'));
  }
  set.rows.filter(r => r.animal !== set.leader.animal).forEach(r => {
    const hand = allTab.filter(m => m.actor_id === set.leader.animal &&
                                    (m.victim_ids||[]).indexOf(r.animal) >= 0).length;
    ok(hand === r.owed, 'the debt for ' + r.name + ' is exactly what the Tab says (' + hand + ' vs ' + r.owed + ')');
  });

  /* Hushed rows carry no actor, so they can never be counted at settlement.
     That is the entire promise of Hush and it is worth asserting, not
     assuming. */
  const hushed = allTab.filter(m => /Nobody heard what/.test(m.public_text||''));
  ok(hushed.every(m => !m.actor_id && (m.victim_ids||[]).length === 0),
     'every hushed row is anonymous, so nothing hushed can ever be billed (' + hushed.length + ' rows)');

  /* The recount above only bites if the leader actually aimed something at
     one person rather than the whole table, and three players playing at
     random will not reliably produce that. So plant one: a single Tab row
     where the leader hits exactly ONE other player, and demand that exactly
     one debt moves.

     Without this, a settlement that billed the leader's entire Tab to
     everybody passes, because a Cabo call lists every other player as a
     victim anyway and the two readings coincide. That version of the bug
     was written on purpose and got all the way through this file. */
  const victim = set.rows.find(r => r.animal !== set.leader.animal);
  const bystanders = set.rows.filter(r => r.animal !== set.leader.animal &&
                                          r.animal !== victim.animal);
  await db.appendMoves([{
    game_id: allGames[0].id, round_n: 1, seat: 0, type: 'TAB',
    payload: {}, public_text: 'A planted, precisely aimed grievance.',
    actor_id: set.leader.animal, victim_ids: [victim.animal]
  }]);
  const after = (await S.seasonStandings(s2.code)).settlement;
  const owedNow = a2 => after.rows.find(r => r.animal === a2).owed;
  ok(owedNow(victim.animal) === victim.owed + 1,
     'THE POINT: a grievance aimed at one person bills exactly that person');
  bystanders.forEach(bz => ok(owedNow(bz.animal) === bz.owed,
     'and nobody standing nearby is billed for it (' + bz.name + ')'));
  ok(owedNow(set.leader.animal) === 0, 'the leader still owes nobody');

  // --- the superlatives ------------------------------------------------
  const x = final.extras;
  ok(!!x, 'a season has extras');
  ok(x.totalTab === allTab.length, 'the Tab count matches the rows on record');
  ['swept','pickedOn','stung','caboCalled','skipped','emptied'].forEach(k => {
    if (x[k]) ok(typeof x[k].name === 'string' && x[k].n >= 1, k + ' names a person and a count');
  });
  if (x.worstCaller) ok(x.worstCaller.called >= x.worstCaller.missed,
                        'you cannot miss more Cabo calls than you made');

  /* Only finished matches feed any of this. Deal a fresh season, leave its
     one match unfinished, and nothing may be counted from it. */
  const halfSeason = await S.createSeason({ matchTarget: 2 });
  const hr = await S.createRoom({ players: roster, seasonCode: halfSeason.code });
  const th = []; for (let i=0;i<N;i++) th.push((await S.claimSeat(hr.code,i)).token);
  for (let i=0;i<N;i++){ await S.peek(hr.code, th[i], [0,1]).catch(()=>{}); await S.ready(hr.code, th[i]).catch(()=>{}); }
  const hv = await S.getState(hr.code, th[0]);
  await S.applyMove(hr.code, th[hv.turn], {type:'DRAW'}, hv.version);
  const half = await S.seasonStandings(halfSeason.code);
  ok(half.matchesStarted === 1 && half.matchesPlayed === 0, 'a match in progress is started, not played');
  ok(half.extras.totalMoves === 0 && half.extras.totalTab === 0,
     'THE POINT: an unfinished match contributes nothing to a season number');

  /* --- seasons name themselves ---------------------------------------
     Nobody types a name into a phone on the way out of a match, so they are
     numbered. The count is global because there is exactly one group. */
  const before = await db.countSeasons();
  const n1 = await S.createSeason({ matchTarget: 2 });
  const n2 = await S.createSeason({ matchTarget: 2 });
  ok(n1.name === 'Season ' + (before + 1), 'an unnamed season numbers itself (' + n1.name + ')');
  ok(n2.name === 'Season ' + (before + 2), 'and the next one takes the next number (' + n2.name + ')');
  ok((await S.seasonStandings(n1.code)).name === n1.name, 'the number comes back on the standings');
  const named = await S.createSeason({ matchTarget: 2, name: 'The Grudge' });
  ok(named.name === 'The Grudge', 'an explicit name still wins');

  // --- nothing that could betray a card may reach any of it ------------
  const leaked = scanForCards(final, 'season', []);
  ok(leaked.length === 0, 'no rank, suit or value reaches the season payload:\n     ' + leaked.join('\n     '));
  ok(scanForCards(byRoom, 'season', []).length === 0, 'nor the open-season payload');

  // ... and the check is able to fail. Plant each kind and demand a catch.
  [
    ['a raw card on a superlative', { ...final, extras: { ...x, swept: { name:'Sahil', r:'K', s:'S' } } }],
    ['a value key on a row',        { ...final, standings: [{ name:'Hrutik', value:-1 }] }],
    ['a suit in prose',             { ...final, name: 'The season of the four of clubs' }],
    ['a court card in prose',       { ...final, name: 'Shivani was holding the Queen of hearts' }],
    ['a value in prose',            { ...final, name: 'A card worth 12 decided it' }]
  ].forEach(s => ok(scanForCards(s[1], 'season', []).length > 0, 'SABOTAGE caught: ' + s[0]));

  await db.close();
}

(async () => {
  await run(makeDb({kind:'memory'}), 'seasons on memory');
  if (process.env.DATABASE_URL) await run(makeDb({kind:'pg', connectionString: process.env.DATABASE_URL}), 'seasons on postgres');
  console.log(fails ? `\n${fails} FAILURES` : '\nALL PASS');
  process.exit(fails?1:0);
})().catch(e=>{ console.error('THREW:', e.stack); process.exit(1); });

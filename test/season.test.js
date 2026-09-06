/* Seasons: a running total across matches, with the Tab still settling
   per match. Plays real matches end to end on both backends. */
const { makeDb } = require('../lib/db.js');
const { makeService } = require('../lib/service.js');

let fails=0;
const ok=(c,m)=>{ if(!c){ fails++; console.log('   FAIL:', m); } };
async function throws(fn,status,label){
  try{ await fn(); fails++; console.log('   FAIL (no throw):', label); }
  catch(e){ if(status && e.status!==status){ fails++; console.log('   FAIL (got '+e.status+'):', label); } }
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

  await db.close();
}

(async () => {
  await run(makeDb({kind:'memory'}), 'seasons on memory');
  if (process.env.DATABASE_URL) await run(makeDb({kind:'pg', connectionString: process.env.DATABASE_URL}), 'seasons on postgres');
  console.log(fails ? `\n${fails} FAILURES` : '\nALL PASS');
  process.exit(fails?1:0);
})().catch(e=>{ console.error('THREW:', e.stack); process.exit(1); });

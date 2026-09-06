/* The season on a real screen.
 *
 * The node test proves the arithmetic. This proves the two doors into it
 * work, which is a different failure: the button at the end of a match that
 * turns a match into a season, and /s/CODE, the link that goes in the group
 * chat and is opened by somebody holding no seat at all.
 *
 * Plays a whole match through the API, then drives the rest by clicking. */
const { chromium } = require('playwright');

process.env.PORT = process.env.PORT || '3319';
require('../server.js');
const base = 'http://localhost:' + process.env.PORT;

async function post(path, body){
  const r = await fetch(base+path, { method:'POST', headers:{'content-type':'application/json'},
                                     body: JSON.stringify(body) });
  const d = await r.json().catch(()=>({}));
  if (!r.ok) { const e = new Error(d.error||('HTTP '+r.status)); e.status = r.status; throw e; }
  return d;
}
async function get(path){
  const r = await fetch(base+path);
  const d = await r.json().catch(()=>({}));
  if (!r.ok) { const e = new Error(d.error||('HTTP '+r.status)); e.status = r.status; throw e; }
  return d;
}

let fails = 0;
const ok = (c,m)=>{ if(!c){ fails++; console.log('   FAIL:', m); } else console.log('   ok  ', m); };

const ROSTER = [{animal:'bee',name:'Hrutik'},{animal:'deer',name:'Sharayu'},
                {animal:'snake',name:'Shivani'},{animal:'rhino',name:'Sahil'},
                {animal:'giraffe',name:'Roshan'}];

/* Play a room out to matchEnd over HTTP, the way five phones would. */
async function playOut(code, tok){
  const st = c => get('/api/state?code='+code+'&token='+c);
  const peekAll = async () => { for (let i=0;i<5;i++){
    await post('/api/peek',{code, token:tok[i], indices:[0,1]}).catch(()=>{});
    await post('/api/ready',{code, token:tok[i]}).catch(()=>{}); } };
  await peekAll();
  for (let r=1;r<=3;r++){
    let guard=0;
    while (guard++ < 1500){
      const v = await st(tok[0]);
      if (v.phase !== 'turn') break;
      const seat = v.turn, mv = await st(tok[seat]), me = mv.players[seat];
      const others = [0,1,2,3,4].filter(x=>x!==seat);
      let m;
      if (mv.modalKind==='choosePeek') m={type:'PEEK_OWN',idx:0};
      else if (mv.modalKind==='spyPick') m={type:'SPY',seat:others[0],idx:0};
      else if (mv.modalKind==='swapMine') m={type:'SWAP_DO',seat:others[0],mine:0,idx:0};
      else if (mv.modalKind==='sting') m={type:'STING_DONE',a:others[0],b:others[1]};
      else if (mv.modalKind) m={type:'CLOSE_MODAL'};
      else if (mv.pendingEnd) m={type:'END_TURN'};
      else if (!mv.you.abilityUsed && Math.random()<0.4) m={type:'ABILITY'};
      else if (!mv.you.sweepUsed && mv.discardCount>1 && Math.random()<0.3) m={type:'SWEEP'};
      else if (mv.drawn) m = me.handCount ? {type:'PLACE',idx:0} : {type:'DISCARD_DRAWN'};
      else if (Math.random()<0.2 && mv.caboBy===null) m={type:'CABO'};
      else m={type:'DRAW'};
      try { await post('/api/move',{code, token:tok[seat], move:m, expectedVersion:mv.version}); }
      catch(e){ if(e.status!==409) throw e; }
    }
    const now = await st(tok[0]);
    if (now.phase === 'matchEnd') break;
    if (now.phase !== 'roundEnd') { console.log('   stuck in', now.phase); break; }
    const nx = await post('/api/next-round',{code, token:tok[0]});
    if (nx.phase === 'matchEnd') break;
    if (nx.phase === 'peek') await peekAll();
  }
  return await st(tok[0]);
}

async function newRoom(){
  const room = await post('/api/room', { players: ROSTER });
  const tok = [];
  for (let i=0;i<5;i++) tok.push((await post('/api/claim',{code:room.code, seat:i})).token);
  return { code: room.code, tok };
}

/* Walk the end-of-match screens: standings -> recap -> settlement. */
async function toSettlement(p){
  await p.waitForSelector('.title', { timeout:15000 });
  await p.click('text=What actually happened');
  await p.waitForSelector('text=WHAT ACTUALLY HAPPENED', { timeout:15000 });
  await p.click('text=Settle the Tab');
  await p.waitForSelector('text=The Tab settles', { timeout:15000 });
}

(async () => {
  console.log('\n== seasons in a browser ==');

  const m1 = await newRoom();
  const fin = await playOut(m1.code, m1.tok);
  ok(fin.phase === 'matchEnd', 'a match was played out ('+fin.phase+')');
  if (fin.phase !== 'matchEnd') process.exit(1);

  const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium', args:['--no-sandbox'] });
  const ctx = await b.newContext({ viewport:{width:400,height:880}, deviceScaleFactor:2 });
  await ctx.route('https://fonts.g**/**', r=>r.abort());
  await ctx.route('https://cdnjs.cloudflare.com/**', route => route.fulfill({
    path: route.request().url().includes('react-dom')
      ? '/home/claude/node_modules/react-dom/umd/react-dom.production.min.js'
      : '/home/claude/node_modules/react/umd/react.production.min.js',
    contentType:'text/javascript' }));
  await ctx.addInitScript(([c,t]) => {
    localStorage.setItem('beeshouse:'+c, JSON.stringify({ token:t, seat:0 }));
  }, [m1.code, m1.tok[0]]);

  const errs = [];
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push(e.message));

  /* ---- 1. the offer only exists once the Tab has settled -------------- */
  await p.goto(base + '/g/' + m1.code);
  await p.waitForSelector('.title', { timeout:15000 });
  ok(!(await p.textContent('.shell')).includes('Make this a season'),
     'the season is not offered before the Tab settles');

  await toSettlement(p);
  await p.waitForSelector('text=Make this a season', { timeout:15000 });
  ok(true, 'a finished match offers to become a season');
  await p.screenshot({ path:'/home/claude/s1-offer.png' });

  /* ---- 2. picking a length, and starting it --------------------------- */
  await p.click('text=Make this a season');
  await p.waitForSelector('text=Start a season of', { timeout:10000 });
  ok((await p.$$('.btn.ghost.sm')).length >= 3, 'three season lengths on offer');
  await p.click('text=3 matches');
  const picked = await p.textContent('.btn.primary');
  ok(/Start a season of 3/.test(picked), 'the button follows the length you picked');
  await p.screenshot({ path:'/home/claude/s2-pick.png' });

  await p.click('text=Start a season of 3');
  await p.waitForSelector('.scores', { timeout:15000 });
  const board = await p.textContent('.shell');
  ok(/1 of 3 matches played/.test(board), 'the season opened on match 1 of 3');
  ok((await p.$$('.pip.on')).length === 1, 'one pip lit for one match played');
  ok((await p.$$('.pip')).length === 3, 'three pips for three matches');
  ok(/Deal match 2/.test(board), 'and it offers the next match');
  ok(!/undefined|NaN|\[object/.test(board), 'nothing rendered as undefined or NaN');
  ok(!/—/.test(board), 'no em dashes');
  ok(!/ of (hearts|spades|diamonds|clubs)/i.test(board), 'no card is named on screen');
  const rows = await p.$$eval('.scores tbody tr', ns => ns.map(n => n.textContent.trim()));
  ok(rows.length === 5, 'all five are on the table ('+rows.length+')');
  rows.forEach(r => console.log('       ' + r.replace(/\s+/g,' ')));
  await p.screenshot({ path:'/home/claude/s3-standings.png', fullPage:true });

  /* the standings the screen shows must be the standings the server holds */
  const api = await get('/api/season?code=' + m1.code);
  const seasonCode = api.code;
  ok(api.standings.every(s => rows.some(r => r.includes(s.name) && r.includes(String(s.total)))),
     'every total on screen is the total the server computed');

  /* ---- 3. the season link, opened by somebody holding no seat --------- */
  const anon = await b.newContext({ viewport:{width:400,height:880} });
  await anon.route('https://fonts.g**/**', r=>r.abort());
  await anon.route('https://cdnjs.cloudflare.com/**', route => route.fulfill({
    path: route.request().url().includes('react-dom')
      ? '/home/claude/node_modules/react-dom/umd/react-dom.production.min.js'
      : '/home/claude/node_modules/react/umd/react.production.min.js',
    contentType:'text/javascript' }));
  const q = await anon.newPage();
  q.on('pageerror', e => errs.push('anon: ' + e.message));
  await q.goto(base + '/s/' + seasonCode);
  await q.waitForSelector('.scores', { timeout:15000 });
  const anonBody = await q.textContent('.shell');
  ok(/1 of 3 matches played/.test(anonBody), 'the season link renders for a stranger');
  ok(!/Deal match/.test(anonBody), 'THE POINT: no seat, no button that deals a match');
  ok(!/undefined|NaN|\[object/.test(anonBody), 'nothing undefined on the public link');
  await q.screenshot({ path:'/home/claude/s4-public.png', fullPage:true });

  /* a season code that does not exist says so instead of hanging */
  await q.goto(base + '/s/ZZZZZ');
  await q.waitForSelector('.err', { timeout:15000 });
  ok(/No season/.test(await q.textContent('.err')), 'an unknown season code says so');

  /* ---- 4. play the season out and settle it on screen ----------------- */
  const nm2 = await post('/api/next-match', { code:m1.code, token:m1.tok[0] });
  const t2 = []; for (let i=0;i<5;i++) t2.push((await post('/api/claim',{code:nm2.code, seat:i})).token);
  await playOut(nm2.code, t2);
  const nm3 = await post('/api/next-match', { code:nm2.code, token:t2[0] });
  const t3 = []; for (let i=0;i<5;i++) t3.push((await post('/api/claim',{code:nm3.code, seat:i})).token);
  const last = await playOut(nm3.code, t3);
  ok(last.phase === 'matchEnd', 'the third match finished');
  ok(last.season && last.season.status === 'done', 'the season closed itself');

  const ctx3 = await b.newContext({ viewport:{width:400,height:880}, deviceScaleFactor:2 });
  await ctx3.route('https://fonts.g**/**', r=>r.abort());
  await ctx3.route('https://cdnjs.cloudflare.com/**', route => route.fulfill({
    path: route.request().url().includes('react-dom')
      ? '/home/claude/node_modules/react-dom/umd/react-dom.production.min.js'
      : '/home/claude/node_modules/react/umd/react.production.min.js',
    contentType:'text/javascript' }));
  await ctx3.addInitScript(([c,t]) => {
    localStorage.setItem('beeshouse:'+c, JSON.stringify({ token:t, seat:0 }));
  }, [nm3.code, t3[0]]);
  const z = await ctx3.newPage();
  z.on('pageerror', e => errs.push('final: ' + e.message));

  await z.goto(base + '/g/' + nm3.code);
  await toSettlement(z);
  await z.waitForSelector('text=How the season ended', { timeout:15000 });
  ok(true, 'the last match offers the end of the season, not another match');
  ok(!(await z.textContent('.shell')).includes('Deal match 4'),
     'a full season does not offer a fourth match');

  await z.click('text=How the season ended');
  await z.waitForSelector('text=Settle the season', { timeout:15000 });
  const table = await z.textContent('.shell');
  ok(/3 of 3 matches played/.test(table), 'the season shows itself complete');
  ok((await z.$$('.pip.on')).length === 3, 'every pip lit');
  await z.screenshot({ path:'/home/claude/s5-full.png', fullPage:true });

  await z.click('text=Settle the season');
  await z.waitForSelector('text=The season settles', { timeout:15000 });
  const settled = await z.textContent('.shell');
  ok(/points after settlement/.test(settled), 'the season settlement rendered');
  ok(/The Tab (changed the season|held)/.test(settled), 'and it says whether the Tab moved it');
  ok(!/undefined|NaN|\[object/.test(settled), 'nothing undefined in the settlement');
  ok(!/—/.test(settled), 'no em dashes in the settlement');
  await z.screenshot({ path:'/home/claude/s6-settled.png', fullPage:true });

  /* the winner on screen is the winner the server settled on */
  const finalApi = await get('/api/season?code=' + seasonCode);
  ok(settled.includes(finalApi.settlement.winner.name.toUpperCase()),
     'the name on the screen is the name the server settled on');

  ok(errs.length === 0, 'no page errors' + (errs.length ? ': '+errs.join(' | ') : ''));
  await b.close();
  console.log(fails ? '\n   '+fails+' FAILED\n' : '\n   season screens ok\n');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

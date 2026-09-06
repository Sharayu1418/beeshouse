/* The recap on a real screen.
 *
 * The node test proves the recap reads the match correctly. This proves it
 * survives the trip through HTTP and renders, which is a different failure.
 * Drives a whole match through the API, then opens the finished room as one
 * of the five and walks standings -> recap -> settlement. */
const { chromium } = require('playwright');

/* Boots its own server so `npm run test:browser` needs nothing running. */
process.env.PORT = process.env.PORT || '3314';
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

(async () => {
  console.log('\n== recap in a browser ==');
  const room = await post('/api/room', { players:[
    {animal:'bee',name:'Hrutik'},{animal:'deer',name:'Sharayu'},{animal:'snake',name:'Shivani'},
    {animal:'rhino',name:'Sahil'},{animal:'giraffe',name:'Roshan'}]});
  const code = room.code;
  const tok = [];
  for (let i=0;i<5;i++) tok.push((await post('/api/claim',{code:code, seat:i})).token);
  const st = c => get('/api/state?code='+code+'&token='+c);
  const peekAll = async () => { for (let i=0;i<5;i++)
    { await post('/api/peek',{code:code, token:tok[i], indices:[0,1]});
      await post('/api/ready',{code:code, token:tok[i]}); } };

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
      else if (!mv.you.sweepUsed && mv.discardCount>1 && Math.random()<0.35) m={type:'SWEEP'};
      else if (mv.drawn) m = me.handCount ? {type:'PLACE',idx:0} : {type:'DISCARD_DRAWN'};
      else if (Math.random()<0.2 && mv.caboBy===null) m={type:'CABO'};
      else m={type:'DRAW'};
      try { await post('/api/move',{code:code, token:tok[seat], move:m, expectedVersion:mv.version}); }
      catch(e){ if(e.status!==409) throw e; }
    }
    const now = await st(tok[0]);
    if (now.phase === 'matchEnd') break;
    if (now.phase !== 'roundEnd') { console.log('   stuck in', now.phase); break; }
    const nx = await post('/api/next-round',{code:code, token:tok[0]});
    if (nx.phase === 'matchEnd') break;
    if (nx.phase === 'peek') await peekAll();
  }
  const fin = await st(tok[0]);
  ok(fin.phase === 'matchEnd', 'the match is over ('+fin.phase+')');
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
  }, [code, tok[0]]);
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));

  await p.goto(base + '/g/' + code);
  await p.waitForSelector('.title', { timeout:10000 });
  const standings = await p.textContent('.shell');
  ok(/IS AHEAD/.test(standings), 'standings first');
  await p.screenshot({ path:'/home/claude/x1-standings.png' });

  await p.click('text=What actually happened');
  await p.waitForSelector('text=WHAT ACTUALLY HAPPENED', { timeout:10000 });
  await p.waitForTimeout(700);
  const body = await p.textContent('.shell');
  await p.screenshot({ path:'/home/claude/x2-recap.png', fullPage:true });

  ok(/moves played/.test(body), 'the recap loaded from the server');
  ok(!/undefined|NaN|\[object/.test(body), 'nothing rendered as undefined or NaN');
  ok(!/—/.test(body), 'no em dashes');
  const lines = await p.$$eval('.tab-e', ns => ns.map(n => n.textContent.trim()));
  ok(lines.length > 0, 'it found something to report ('+lines.length+' lines)');
  lines.forEach(l => console.log('       ' + l));
  ok(!/ of (hearts|spades|diamonds|clubs)/i.test(body), 'no card is named on screen');

  await p.click('text=Settle the Tab');
  await p.waitForSelector('text=The Tab settles', { timeout:10000 });
  await p.screenshot({ path:'/home/claude/x3-settled.png' });
  ok(true, 'settlement still reachable after the recap');

  ok(errs.length === 0, 'no page errors' + (errs.length ? ': '+errs.join(' | ') : ''));
  await b.close();
  console.log(fails ? '\n   '+fails+' FAILED\n' : '\n   recap screen ok\n');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

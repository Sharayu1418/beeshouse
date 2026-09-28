/* The gestures, on a real screen.
 *
 * The diff finds cards that moved. These are the things that move nothing
 * and are the most visible thing at a real table: somebody picking up one
 * of their own cards and squinting at it, two cards trading, a hand being
 * shuffled into itself.
 *
 * Two things are being tested and only one of them is the feature.
 *
 *   1. It plays. The class lands on the right card, at the right seat, on
 *      the screens of people who are only watching.
 *
 *   2. It shows nothing. Every element a gesture touches is a card BACK.
 *      No rank, no suit, no value reaches the DOM while any of it runs,
 *      and that check is proved able to fail at the bottom of this file.
 */
const { chromium } = require('playwright');

process.env.PORT = process.env.PORT || '3321';
require('../server.js');
const { db } = require('../api/_handler.js');
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

/* Anything on screen that would betray a card. The backs carry an id and a
   slot number and nothing else, so a rank or a suit appearing anywhere in
   the table markup is a leak no matter how it got there. */
async function facesOnTable(page){
  return await page.$$eval('.roundtable, .hand', function (roots) {
    const bad = [];
    roots.forEach(function (root) {
      root.querySelectorAll('.card').forEach(function (c) {
        const t = (c.textContent || '').trim();
        // a slot number on your own card is fine; a rank or a suit is not
        if (/[♠♥♦♣]/.test(t)) bad.push('suit in "' + t + '"');
        if (/\b(?:A|J|Q|K)\b/.test(t)) bad.push('rank in "' + t + '"');
        ['r','s','v','rank','suit','value'].forEach(function (k) {
          if (c.dataset && c.dataset[k] != null) bad.push('data-' + k + '=' + c.dataset[k]);
        });
      });
    });
    return bad;
  });
}

(async () => {
  console.log('\n== gestures ==');

  const room = await post('/api/room', { players: ROSTER });
  const code = room.code, tok = [];
  for (let i=0;i<5;i++) tok.push((await post('/api/claim',{code, seat:i})).token);

  const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium', args:['--no-sandbox'] });
  async function phone(seat){
    const ctx = await b.newContext({ viewport:{width:400,height:880} });
    await ctx.route('https://fonts.g**/**', r=>r.abort());
    await ctx.route('https://cdnjs.cloudflare.com/**', route => route.fulfill({
      path: route.request().url().includes('react-dom')
        ? '/home/claude/node_modules/react-dom/umd/react-dom.production.min.js'
        : '/home/claude/node_modules/react/umd/react.production.min.js',
      contentType:'text/javascript' }));
    await ctx.addInitScript(([c,t]) => {
      localStorage.setItem('beeshouse:'+c, JSON.stringify({ token:t, seat:Number(t.slice(-1)) }));
    }, [code, tok[seat]]);
    await ctx.addInitScript(([c,t,s]) => {
      localStorage.setItem('beeshouse:'+c, JSON.stringify({ token:t, seat:s }));
    }, [code, tok[seat], seat]);
    const p = await ctx.newPage();
    p.on('pageerror', e => { fails++; console.log('   FAIL page error:', e.message); });
    return p;
  }

  /* ---- 1. the opening look, watched by somebody else ------------------ */
  // Hrutik is watching. Shivani takes her opening look at two of her own.
  const watcher = await phone(0);
  await watcher.goto(base + '/g/' + code);
  await watcher.waitForSelector('.roundtable', { timeout:15000 });

  await post('/api/peek', { code, token:tok[2], indices:[1,3] });
  const look = await watcher.waitForSelector('.card.looking', { timeout:15000 }).catch(()=>null);
  ok(!!look, 'THE POINT: a watcher sees Shivani pick up her own cards');

  const looking = await watcher.$$eval('.card.looking', ns =>
    ns.map(n => n.getAttribute('data-card')));
  const state0 = await get('/api/state?code='+code+'&token='+tok[0]);
  const shivani = state0.players.filter(p => p.seat === 2)[0];
  const expect = [shivani.slots[1].id, shivani.slots[3].id];
  ok(looking.every(id => expect.indexOf(id) >= 0) && looking.length > 0,
     'and it is the two she actually chose, not any other two');
  ok((await facesOnTable(watcher)).length === 0, 'no face turns while she looks');
  await watcher.screenshot({ path:'/home/claude/g1-look.png' });

  /* the same gesture must not replay on every poll for the rest of the day */
  await watcher.waitForTimeout(1400);
  ok((await watcher.$$('.card.looking')).length === 0, 'and the look ends rather than looping');

  /* ---- 2. a shed, which must be unreadable ---------------------------- */
  for (let i=0;i<5;i++){ await post('/api/peek',{code, token:tok[i], indices:[0,1]}).catch(()=>{});
                         await post('/api/ready',{code, token:tok[i]}).catch(()=>{}); }
  await watcher.waitForSelector('.roundtable', { timeout:15000 });

  // walk to Shivani's turn, then shed
  let guard = 0;
  while (guard++ < 60) {
    const v = await get('/api/state?code='+code+'&token='+tok[0]);
    if (v.phase !== 'turn' || v.turn === 2) break;
    const mv = await get('/api/state?code='+code+'&token='+tok[v.turn]);
    const m = mv.pendingEnd ? {type:'END_TURN'}
            : mv.modalKind ? {type:'CLOSE_MODAL'}
            : mv.drawn ? {type:'PLACE',idx:0} : {type:'DRAW'};
    await post('/api/move',{code, token:tok[v.turn], move:m, expectedVersion:mv.version}).catch(()=>{});
  }
  const pre = await get('/api/state?code='+code+'&token='+tok[0]);
  const beforeIds = pre.players.filter(p=>p.seat===2)[0].slots.map(s=>s.id);

  const sv = await get('/api/state?code='+code+'&token='+tok[2]);
  ok(sv.turn === 2, 'it is the snake to play');
  await post('/api/move',{code, token:tok[2], move:{type:'ABILITY'}, expectedVersion:sv.version});

  const shedEl = await watcher.waitForSelector('.card.shedding', { timeout:15000 }).catch(()=>null);
  ok(!!shedEl, 'a watcher sees the hand shuffle');

  const post0 = await get('/api/state?code='+code+'&token='+tok[0]);
  const afterIds = post0.players.filter(p=>p.seat===2)[0].slots.map(s=>s.id);
  const traceable = afterIds.filter(id => beforeIds.indexOf(id) >= 0);
  ok(traceable.length === 0,
     'THE POINT: not one card can be followed through the shed (' +
     beforeIds.join(',') + ' -> ' + afterIds.join(',') + ')');
  ok(afterIds.length === beforeIds.length, 'and she still holds the same number of cards');
  ok((await facesOnTable(watcher)).length === 0, 'no face turns during the shed either');
  await watcher.screenshot({ path:'/home/claude/g2-shed.png' });

  /* ---- 3. the leak check can fail ------------------------------------- */
  await watcher.evaluate(() => {
    const c = document.querySelector('.roundtable .card');
    if (c) c.textContent = 'K♠';
  });
  const planted = await facesOnTable(watcher);
  ok(planted.length > 0, 'SABOTAGE caught: a face planted on a back is noticed (' +
     (planted[0] || 'nothing') + ')');

  ok(fails === 0 || true, '');
  await b.close();
  console.log(fails ? '\n   ' + fails + ' FAILED\n' : '\n   gestures ok\n');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

/* Five independent browser contexts = five phones. One room, real HTTP.
 * Checks the whole loop AND what actually arrives over each wire. */
const { chromium } = require('playwright');

/* Boots its own server so `npm run test:browser` needs nothing running. */
process.env.PORT = process.env.PORT || '3310';
require('../server.js');

(async () => {
  const base = 'http://localhost:' + process.env.PORT;
  const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium', args:['--no-sandbox'] });
  async function phone(){
    const ctx = await b.newContext({ viewport:{width:400,height:880}, deviceScaleFactor:2 });
    await ctx.route('https://fonts.googleapis.com/**', r=>r.abort());
    await ctx.route('https://fonts.gstatic.com/**', r=>r.abort());
    await ctx.route('https://cdnjs.cloudflare.com/**', route => route.fulfill({
      path: route.request().url().includes('react-dom')
        ? '/home/claude/node_modules/react-dom/umd/react-dom.production.min.js'
        : '/home/claude/node_modules/react/umd/react.production.min.js',
      contentType:'text/javascript' }));
    const p = await ctx.newPage();
    return p;
  }

  const P = []; for (let i=0;i<5;i++) P.push(await phone());
  const errs = [], seen = [];
  P.forEach((p,i) => {
    p.on('pageerror', e => errs.push('phone'+i+': '+e.message));
    p.on('response', async res => {
      if (res.url().includes('/api/')) {
        try { seen.push({ phone:i, url:res.url().replace(base,'').split('?')[0], body: await res.text() }); } catch(e){}
      }
    });
  });

  // phone 0 creates the room
  await P[0].goto(base + '/');
  await P[0].waitForSelector('.title');
  // the Yes button is the one that works. The No button runs away, which is
  // why this clicks by class and not by text.
  await P[0].click('.yes-btn');
  await P[0].waitForSelector('.seat', { timeout:15000 });
  const code = P[0].url().split('/g/')[1].trim();
  console.log('room:', code);
  await P[0].screenshot({ path:'/home/claude/q1-seats.png' });

  // everyone claims their own seat
  await P[0].click('.seat >> nth=0');
  await P[0].waitForTimeout(600);
  await P[0].screenshot({ path:'/home/claude/q2-lobbywait.png' });

  for (let i=1;i<5;i++){
    await P[i].goto(base + '/g/' + code);
    await P[i].waitForSelector('.seat', { timeout:10000 });
    await P[i].click('.seat >> nth='+i);
    await P[i].waitForTimeout(500);
  }
  await P[0].reload(); await P[0].waitForTimeout(800);
  const peekVisible = (await P[0].$('.hand .card')) !== null;
  console.log('all five claimed -> peek phase reached:', peekVisible);
  await P[0].screenshot({ path:'/home/claude/r3-peek.png' });

  // everyone peeks
  for (const p of P){
    await p.reload();
    // the hand deals itself in with a stagger, so wait for the cards to
    // stop moving rather than clicking a handle mid-flight
    await p.waitForSelector('.hand .card', { timeout:10000 }).catch(()=>{});
    await p.waitForTimeout(1200);
    const n = (await p.$$('.hand .card')).length;
    if (n >= 2){
      await p.click('.hand .card >> nth=0');
      await p.waitForTimeout(250);
      await p.click('.hand .card >> nth=1');
      await p.waitForTimeout(250);
      const go = await p.$('text=Look at these two');
      if (go) await go.click();
      await p.waitForTimeout(900);
    }
  }

  /* Looking no longer starts the round: everybody has to say they are done
     looking, which is what lets you stare at your two for as long as you
     want without the last person to arrive getting a single glance. */
  for (const p of P){
    const got = await p.$('text=Got it'); if (got){ await got.click(); await p.waitForTimeout(250); }
    const again = await p.$('text=Look at them again');
    if (again){  // prove a second look is offered, then take it and move on
      await again.click(); await p.waitForTimeout(900);
      const g2 = await p.$('text=Got it'); if (g2){ await g2.click(); await p.waitForTimeout(250); }
    }
    const ready = await p.$('text=I have got them');
    if (ready){ await ready.click(); await p.waitForTimeout(600); }
  }
  for (const p of P){ await p.reload(); await p.waitForTimeout(500); }
  await P[0].screenshot({ path:'/home/claude/r4-reveal.png' });
  for (const p of P){ const g = await p.$('text=Got it'); if (g) await g.click(); await p.waitForTimeout(250); }

  // who is up?
  let activeIdx = -1;
  for (let i=0;i<5;i++){ await P[i].reload(); await P[i].waitForTimeout(500);
    if (await P[i].$('.act')) activeIdx = i; }
  console.log('phone with the turn:', activeIdx);
  const idleIdx = (activeIdx + 1) % 5;
  await P[activeIdx].screenshot({ path:'/home/claude/r5-board.png' });
  await P[idleIdx].screenshot({ path:'/home/claude/q6-wait.png' });
  console.log('idle phone has action buttons:', (await P[idleIdx].$('.act')) !== null, '(want false)');
  console.log('idle phone has a nudge button:', (await P[idleIdx].$('.btn.wa')) !== null, '(want true)');
  console.log('idle phone shows a briefing:',   (await P[idleIdx].$('.brief')) !== null);

  // take a turn
  await P[activeIdx].click('.act.gold');
  await P[activeIdx].waitForTimeout(600);
  await P[activeIdx].screenshot({ path:'/home/claude/r7-drawn.png' });
  const away = await P[activeIdx].$('.act.gold.wide');
  if (away){ await away.click(); await P[activeIdx].waitForTimeout(900); }
  let got = await P[activeIdx].$('text=Got it'); if (got){ await got.click(); await P[activeIdx].waitForTimeout(400); }
  const endB = await P[activeIdx].$('text=End turn');
  if (endB){ await endB.click(); await P[activeIdx].waitForTimeout(900); }
  await P[activeIdx].screenshot({ path:'/home/claude/r8-handoff.png' });
  console.log('WhatsApp handoff shown after ending turn:', (await P[activeIdx].$('.btn.wa')) !== null);

  // ---- the wire check, across every phone
  const leaks = [];
  for (const r of seen){
    let d; try { d = JSON.parse(r.body); } catch(e){ continue; }
    (function walk(n, path){
      if (n == null) return;
      if (Array.isArray(n)) return n.forEach((x,i)=>walk(x, path+'['+i+']'));
      if (typeof n !== 'object') return;
      if (typeof n.id === 'string' && /^c\d+$/.test(n.id)){
        const tells = [];
        if (typeof n.v === 'number') tells.push('v='+n.v);
        if (typeof n.r === 'string') tells.push('rank='+n.r);
        if (typeof n.s === 'string') tells.push('suit='+n.s);
        if (tells.length && !/discardTop|drawn|\.reveal|reveal_all|\.cards/.test(path))
          leaks.push('phone'+r.phone+' '+r.url+' '+path+' '+tells.join(','));
      }
      Object.keys(n).forEach(k => walk(n[k], path+'.'+k));
    })(d, 'body');
  }
  console.log('\nAPI responses observed across 5 phones:', seen.length);
  console.log('card values that should not be there:', leaks.length);
  leaks.slice(0,6).forEach(l => console.log('   ', l));
  console.log('page errors:', errs.length ? errs.slice(0,4) : 'NONE');

  await b.close();
  process.exit((leaks.length || errs.length) ? 1 : 0);
})();

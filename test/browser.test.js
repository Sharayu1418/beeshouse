/* Five independent browser contexts = five phones. One room, real HTTP.
 * Checks the whole loop AND what actually arrives over each wire. */
const { chromium } = require('playwright');

(async () => {
  const base = 'http://localhost:3210';
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
  await P[0].click('text=Start a new house');
  await P[0].waitForSelector('.codebox', { timeout:10000 });
  const code = (await P[0].textContent('.codebox')).trim();
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
  await P[0].screenshot({ path:'/home/claude/q3-peek.png' });

  // everyone peeks
  for (const p of P){
    await p.reload(); await p.waitForTimeout(500);
    const cs = await p.$$('.hand .card');
    if (cs.length >= 2){
      await cs[0].click(); await cs[1].click();
      const go = await p.$('text=Look at these two');
      if (go) await go.click();
      await p.waitForTimeout(700);
    }
  }
  await P[0].screenshot({ path:'/home/claude/q4-reveal.png' });
  for (const p of P){ const g = await p.$('text=Got it'); if (g) await g.click(); await p.waitForTimeout(250); }

  // who is up?
  let activeIdx = -1;
  for (let i=0;i<5;i++){ await P[i].reload(); await P[i].waitForTimeout(500);
    if (await P[i].$('.act')) activeIdx = i; }
  console.log('phone with the turn:', activeIdx);
  const idleIdx = (activeIdx + 1) % 5;
  await P[activeIdx].screenshot({ path:'/home/claude/q5-board.png' });
  await P[idleIdx].screenshot({ path:'/home/claude/q6-wait.png' });
  console.log('idle phone has action buttons:', (await P[idleIdx].$('.act')) !== null, '(want false)');
  console.log('idle phone has a nudge button:', (await P[idleIdx].$('.btn.wa')) !== null, '(want true)');
  console.log('idle phone shows a briefing:',   (await P[idleIdx].$('.brief')) !== null);

  // take a turn
  await P[activeIdx].click('.act.gold');
  await P[activeIdx].waitForTimeout(600);
  await P[activeIdx].screenshot({ path:'/home/claude/q7-drawn.png' });
  const away = await P[activeIdx].$('.act.gold.wide');
  if (away){ await away.click(); await P[activeIdx].waitForTimeout(900); }
  let got = await P[activeIdx].$('text=Got it'); if (got){ await got.click(); await P[activeIdx].waitForTimeout(400); }
  const endB = await P[activeIdx].$('text=End turn');
  if (endB){ await endB.click(); await P[activeIdx].waitForTimeout(900); }
  await P[activeIdx].screenshot({ path:'/home/claude/q8-handoff.png' });
  console.log('WhatsApp handoff shown after ending turn:', (await P[activeIdx].$('.btn.wa')) !== null);

  // ---- the wire check, across every phone
  const leaks = [];
  for (const r of seen){
    let d; try { d = JSON.parse(r.body); } catch(e){ continue; }
    (function walk(n, path){
      if (n == null) return;
      if (Array.isArray(n)) return n.forEach((x,i)=>walk(x, path+'['+i+']'));
      if (typeof n !== 'object') return;
      if (typeof n.v === 'number' && typeof n.id === 'string' && /^c\d+$/.test(n.id)){
        if (!/discardTop|drawn|\.reveal|reveal_all|\.cards/.test(path))
          leaks.push('phone'+r.phone+' '+r.url+' '+path+' = '+n.v);
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

/* The front door.
 *
 * "Hrutik wants to play Cabo. Yes / No." The No button runs away twice,
 * gets cornered and says Fine, and then gives up entirely and turns into a
 * second Yes. Both of them deal.
 *
 * This gets a test because it has silently disappeared once already: it was
 * dropped in a rewrite and nobody noticed for a week. It is the first thing
 * anybody sees, and it is the joke the whole thing opens on, so it is worth
 * one test that would notice.
 */
const { chromium } = require('playwright');
process.env.PORT = process.env.PORT || '3316';
require('../server.js');
const base = 'http://localhost:' + process.env.PORT;

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('   FAIL:', m); } else console.log('   ok  ', m); };

(async () => {
  console.log('\n== the front door ==');
  const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium', args:['--no-sandbox'] });

  async function phone(){
    const ctx = await b.newContext({ viewport:{width:400,height:880}, deviceScaleFactor:2 });
    await ctx.route('https://fonts.g**/**', r => r.abort());
    await ctx.route('https://cdnjs.cloudflare.com/**', route => route.fulfill({
      path: route.request().url().includes('react-dom')
        ? '/home/claude/node_modules/react-dom/umd/react-dom.production.min.js'
        : '/home/claude/node_modules/react/umd/react.production.min.js',
      contentType:'text/javascript' }));
    const p = await ctx.newPage();
    p.on('pageerror', e => { fails++; console.log('   FAIL page error:', e.message); });
    return p;
  }

  const label = async (p, sel) => (await p.textContent(sel)).trim();

  // ---------------------------------------------------------------- the gag
  const p = await phone();
  await p.goto(base + '/');
  await p.waitForSelector('.no-btn', { timeout:15000 });

  ok(await label(p, '.no-btn') === 'No', 'it starts as a No');
  ok(await label(p, '.yes-btn') === 'Yes', 'next to a Yes');

  /* The small print arrives a beat late on purpose, so it catches the eye
     on the way to the buttons instead of being part of the furniture. */
  ok((await p.$$('.smallprint')).length === 0, 'the disclaimer is not there immediately');
  await p.waitForSelector('.smallprint', { timeout:6000 });
  const sp = (await p.textContent('.smallprint')).replace(/\s+/g, ' ').trim();
  ok(/Hrutik/.test(sp), 'it turns up a moment later and names the culprit');
  ok(/appeal/i.test(sp), 'and the ruling ("' + sp + '")');
  await p.screenshot({ path:'/home/claude/h1-start.png' });

  // and it must not sit on top of the buttons
  const spBox = await p.$eval('.smallprint', n => n.getBoundingClientRect().bottom);
  const yesTop = await p.$eval('.yes-btn', n => n.getBoundingClientRect().top);
  ok(spBox <= yesTop + 1, 'and sits above the buttons rather than over them');

  /* It moves out from under the cursor, so every click is forced: a human
     with a thumb hits it, a Playwright stability check would not. */
  const box = async () => await p.$eval('.no-btn', n => {
    const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) };
  });
  const at0 = await box();
  await p.click('.no-btn', { force:true });
  await p.waitForTimeout(450);
  const at1 = await box();
  ok(at1.x !== at0.x || at1.y !== at0.y, 'it runs away when you say no');
  ok(await label(p, '.no-btn') === 'No', 'and is still a No after one refusal');
  await p.screenshot({ path:'/home/claude/h2-dodged.png' });

  await p.click('.no-btn', { force:true });
  await p.waitForTimeout(450);
  await p.click('.no-btn', { force:true });
  await p.waitForTimeout(450);

  ok(await label(p, '.no-btn') === 'Fine', 'after three refusals it gives in and says Fine');
  const cornered = await box();
  ok(Math.abs(cornered.x - at0.x) < 3 && Math.abs(cornered.y - at0.y) < 3,
     'and it stops running, back where it started');
  await p.screenshot({ path:'/home/claude/h3-fine.png' });

  // --- THE NEW BIT: Fine becomes a Yes
  await p.click('.no-btn', { force:true });
  await p.waitForTimeout(600);
  ok(await label(p, '.no-btn') === 'Yes', 'one more tap and it turns into a Yes');
  ok((await p.$$('.yes-btn')).length === 2, 'so there are now two Yes buttons');
  const caption = await label(p, '.refuse-count');
  ok(/Both of them work/.test(caption), 'and the caption says so ("' + caption + '")');
  await p.screenshot({ path:'/home/claude/h4-surrendered.png' });

  // --- and the turned one actually deals
  await p.click('.no-btn');
  await p.waitForURL(/\/g\/[A-Z0-9]+/, { timeout:15000 }).catch(()=>{});
  const url = p.url();
  ok(/\/g\/[A-Z0-9]{3,}/.test(url), 'clicking the turned button starts a game (' + url.split('/g/')[1] + ')');
  await p.waitForSelector('.seat', { timeout:15000 });
  ok((await p.$$('.seat')).length > 0, 'and it lands on the seat picker like any other new house');
  await p.screenshot({ path:'/home/claude/h5-dealt.png' });

  // ------------------------------------------------- the original still works
  const q = await phone();
  await q.goto(base + '/');
  await q.waitForSelector('.yes-btn', { timeout:15000 });
  await q.click('.yes-btn');
  await q.waitForURL(/\/g\/[A-Z0-9]+/, { timeout:15000 }).catch(()=>{});
  ok(/\/g\/[A-Z0-9]{3,}/.test(q.url()), 'and the original Yes still deals, which is the boring half');

  await b.close();
  console.log(fails ? '\n   ' + fails + ' FAILED\n' : '\n   front door ok\n');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

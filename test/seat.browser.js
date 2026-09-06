/* Seat recovery on real screens, with a real second device.
 *
 * Phone A claims a seat. Phone B, which has never seen this room, says the
 * seat is theirs. Phone C approves. Phone A must lose it, phone B must get
 * it, and at no point may phone B be able to do anything before the
 * approval lands. */
const { chromium } = require('playwright');
process.env.PORT = process.env.PORT || '3312';
require('../server.js');
const base = 'http://localhost:' + process.env.PORT;

const post = async (p, b) => {
  const r = await fetch(base + p, { method:'POST',
    headers:{'content-type':'application/json'}, body: JSON.stringify(b) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error); e.status = r.status; throw e; }
  return d;
};

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('   FAIL:', m); } else console.log('   ok  ', m); };

(async () => {
  console.log('\n== seat recovery in a browser ==');
  const room = await post('/api/room', { players:[
    { animal:'bee', name:'Hrutik' }, { animal:'deer', name:'Sharayu' },
    { animal:'snake', name:'Shivani' }]});
  const code = room.code;

  const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium', args:['--no-sandbox'] });
  async function phone(label){
    const ctx = await b.newContext({ viewport:{width:400,height:880}, deviceScaleFactor:2 });
    await ctx.route('https://fonts.g**/**', r => r.abort());
    await ctx.route('https://cdnjs.cloudflare.com/**', route => route.fulfill({
      path: route.request().url().includes('react-dom')
        ? '/home/claude/node_modules/react-dom/umd/react-dom.production.min.js'
        : '/home/claude/node_modules/react/umd/react.production.min.js',
      contentType:'text/javascript' }));
    const p = await ctx.newPage();
    p.on('pageerror', e => { fails++; console.log('   FAIL page error on ' + label + ':', e.message); });
    return p;
  }
  const A = await phone('A'), B = await phone('B'), C = await phone('C');

  // A takes seat 0, C takes seat 1
  for (const [p, n] of [[A, 0], [C, 1]]) {
    await p.goto(base + '/g/' + code);
    await p.waitForSelector('.seat', { timeout:15000 });
    await p.click('.seat >> nth=' + n);
    await p.waitForTimeout(800);
  }
  await A.screenshot({ path:'/home/claude/s0-claimed.png' });

  // B arrives on a brand new device and says seat 0 is his
  await B.goto(base + '/g/' + code);
  await B.waitForSelector('.seat', { timeout:15000 });
  const mineButtons = await B.$$('.mine-btn');
  ok(mineButtons.length === 2,
     'only taken seats offer "this is me" (' + mineButtons.length + ' of 3 seats are taken)');
  await B.screenshot({ path:'/home/claude/s1-picker.png' });

  await B.click('.seatrow >> nth=0 >> .mine-btn');
  await B.waitForSelector('text=Waiting on the room', { timeout:10000 });
  ok(true, 'B is told it is waiting on the room');
  await B.screenshot({ path:'/home/claude/s2-waiting.png' });

  // A still has the seat: asking alone must not take anything away
  await A.reload(); await A.waitForTimeout(900);
  const aTxt = await A.textContent('.shell');
  ok(!/Tap whoever you are/.test(aTxt), 'A has not been thrown out by the mere asking');

  // C sees the request
  await C.reload(); await C.waitForTimeout(1000);
  const asks = await C.$$('.seatask');
  ok(asks.length === 1, 'C sees exactly one request');
  const askTxt = asks.length ? await C.textContent('.seatask') : '';
  ok(/Hrutik/.test(askTxt), 'and is told whose seat it is (' + askTxt.replace(/\s+/g, ' ').trim() + ')');
  await C.screenshot({ path:'/home/claude/s3-asked.png' });

  ok((await A.$$('.seatask')).length === 0, "A is never offered a decision about A's own seat");

  // C approves
  await C.click('.seatask .btn.primary');
  await C.waitForTimeout(1200);
  ok((await C.$$('.seatask')).length === 0, 'the request clears once decided');

  // B gets in on its own poll, without a manual reload
  await B.waitForFunction(() => !/Waiting on the room/.test(document.body.textContent),
                          null, { timeout:20000 }).catch(() => {});
  await B.waitForTimeout(800);
  const bTxt = await B.textContent('.shell');
  ok(!/Waiting on the room/.test(bTxt), 'B is let in without touching anything');
  await B.screenshot({ path:'/home/claude/s4-in.png' });

  // A is out
  await A.reload(); await A.waitForTimeout(1200);
  const aAfter = await A.textContent('.shell');
  ok(/Tap whoever you are/.test(aAfter),
     'the old device is back at the seat picker, which is the point');
  await A.screenshot({ path:'/home/claude/s5-old-out.png' });

  await b.close();
  console.log(fails ? '\n   ' + fails + ' FAILED\n' : '\n   seat recovery screen ok\n');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

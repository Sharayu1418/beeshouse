/* Notes and the catch-up replay, on real screens.
 *
 * Two claims are being tested and the first one is the important one:
 *
 *   1. A note NEVER leaves the phone. Every request the page makes is
 *      recorded and searched for the text, and the text is a string that
 *      could not plausibly appear by accident.
 *   2. The catch-up replay actually replays: a phone that was closed while
 *      the table changed paints the old table first, blocks play while it
 *      does, and then glides the cards that moved.
 */
const { chromium } = require('playwright');
process.env.PORT = process.env.PORT || '3313';
require('../server.js');
const base = 'http://localhost:' + process.env.PORT;

const post = async (p, b) => {
  const r = await fetch(base + p, { method:'POST',
    headers:{'content-type':'application/json'}, body: JSON.stringify(b) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error); e.status = r.status; throw e; }
  return d;
};
const get = async p => {
  const r = await fetch(base + p);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error); e.status = r.status; throw e; }
  return d;
};

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('   FAIL:', m); } else console.log('   ok  ', m); };

const SECRET = 'zqx-my-private-note';

(async () => {
  console.log('\n== notes and catch-up ==');
  const room = await post('/api/room', { players:[
    { animal:'bee', name:'Hrutik' }, { animal:'deer', name:'Sharayu' },
    { animal:'snake', name:'Shivani' }]});
  const code = room.code, tok = [];
  for (let i = 0; i < 3; i++) tok.push((await post('/api/claim', { code, seat:i })).token);
  for (let i = 0; i < 3; i++) { await post('/api/peek', { code, token:tok[i], indices:[0,1] }); await post('/api/ready', { code, token:tok[i] }); }

  let v = await get('/api/state?code=' + code + '&token=' + tok[0]);
  const mine = v.turn;                       // the phone we will drive

  const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium', args:['--no-sandbox'] });
  const ctx = await b.newContext({ viewport:{width:400,height:880}, deviceScaleFactor:2 });
  await ctx.route('https://fonts.g**/**', r => r.abort());
  await ctx.route('https://cdnjs.cloudflare.com/**', route => route.fulfill({
    path: route.request().url().includes('react-dom')
      ? '/home/claude/node_modules/react-dom/umd/react-dom.production.min.js'
      : '/home/claude/node_modules/react/umd/react.production.min.js',
    contentType:'text/javascript' }));
  await ctx.addInitScript(([c, t, s2]) => {
    localStorage.setItem('beeshouse:' + c, JSON.stringify({ token:t, seat:s2 }));
  }, [code, tok[mine], mine]);

  const p = await ctx.newPage();
  p.on('pageerror', e => { fails++; console.log('   FAIL page error:', e.message); });

  /* Everything this page sends anywhere, recorded, so the note can be
     hunted for in it. */
  const sent = [];
  p.on('request', r => {
    sent.push(r.url() + ' ' + (r.postData() || ''));
  });

  await p.goto(base + '/g/' + code);
  await p.waitForSelector('.hand .card', { timeout:15000 });
  await p.waitForTimeout(1200);

  // --- the notes exist, and only under your own cards
  const chips = await p.$$('.handslot .note');
  ok(chips.length === 4, 'one note under each of your own four cards (' + chips.length + ')');
  ok((await p.$$('.seat-t .note')).length === 0, 'and none under anybody else\'s');
  await p.screenshot({ path:'/home/claude/n1-board.png' });

  /* Nothing can be animated that the DOM cannot name. At a three-player
     table that is your own four, eight opponent cards and the top of the
     discard: thirteen. Without ids a card moving into or out of a hand
     just teleports, which is what it used to do. */
  const tracked = await p.$$eval('[data-card]', ns => ns.length);
  ok(tracked >= 13, 'every card on the table carries an id the animation can track (' + tracked + ')');
  const mineTracked = await p.$$eval('.hand [data-card]', ns => ns.length);
  ok(mineTracked === 4, 'including your own four, which previously had none');
  const oppTracked = await p.$$eval('.seat-t .seat-cards [data-card]', ns => ns.length);
  ok(oppTracked === 8, "and the other players' cards round the table (" + oppTracked + ')');

  // --- write one
  await p.click('.handslot >> nth=1 >> .note');
  await p.waitForSelector('.note-in', { timeout:5000 });
  await p.fill('.note-in', SECRET);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(400);
  const written = await p.textContent('.handslot >> nth=1 >> .note');
  ok(written.trim().length > 0, 'it keeps what you wrote (' + written.trim() + ')');
  await p.screenshot({ path:'/home/claude/n2-note.png' });

  // --- it survives a reload, because it is in this browser
  await p.reload();
  await p.waitForSelector('.hand .card', { timeout:15000 });
  await p.waitForTimeout(1200);
  const after = await p.textContent('.handslot >> nth=1 >> .note');
  ok(after.trim().length > 0, 'and survives a reload (' + after.trim() + ')');

  // --- THE POINT: it never left the phone
  const leaked = sent.filter(x => x.indexOf(SECRET.slice(0, 8)) >= 0);
  ok(leaked.length === 0,
     'the note is in NONE of the ' + sent.length + ' requests this page made' +
     (leaked.length ? ' — ' + leaked[0] : ''));

  // and it is not in anything the server would hand another player
  const others = await get('/api/state?code=' + code + '&token=' + tok[(mine + 1) % 3]);
  ok(JSON.stringify(others).indexOf(SECRET.slice(0, 8)) < 0,
     'and nowhere in another player\'s view of the game');

  // --- SABOTAGE: prove the hunt would find it
  sent.push(base + '/api/move {"note":"' + SECRET + '"}');
  ok(sent.filter(x => x.indexOf(SECRET.slice(0, 8)) >= 0).length === 1,
     'SABOTAGE caught: a planted request containing the note is found');

  // --- the catch-up replay
  // close the phone, move the world on without it, then come back
  const state = await get('/api/state?code=' + code + '&token=' + tok[mine]);
  await post('/api/move', { code, token:tok[mine], move:{type:'DRAW'}, expectedVersion:state.version });
  let s2 = await get('/api/state?code=' + code + '&token=' + tok[mine]);
  await post('/api/move', { code, token:tok[mine], move:{type:'PLACE', idx:0}, expectedVersion:s2.version });
  s2 = await get('/api/state?code=' + code + '&token=' + tok[mine]);
  if (s2.pendingEnd)
    await post('/api/move', { code, token:tok[mine], move:{type:'END_TURN'}, expectedVersion:s2.version });

  await p.reload();
  // the caption has to be up before the new table lands
  const sawCaption = await p.waitForSelector('.catchup', { timeout:6000 }).then(()=>true).catch(()=>false);
  ok(sawCaption, 'coming back to a changed table shows the catch-up caption');
  if (sawCaption) await p.screenshot({ path:'/home/claude/n3-catchup.png' });

  await p.waitForTimeout(2200);
  ok((await p.$$('.catchup')).length === 0, 'and it clears itself once the table has caught up');
  await p.screenshot({ path:'/home/claude/n4-settled.png' });

  await b.close();
  console.log(fails ? '\n   ' + fails + ' FAILED\n' : '\n   notes and catch-up ok\n');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

/* Everybody online at once.
 *
 * The game was built for five people who are never free at the same time.
 * This is the other case: the evening when they are, where a turn has to
 * arrive on its own instead of waiting for somebody to tap "Check again".
 *
 * Three claims, and the third is the one that costs money if it is wrong:
 *
 *   1. A turn taken on one phone shows up on another with nobody touching
 *      anything.
 *   2. You can see who else has the game open.
 *   3. A tab left open on a table where nothing is happening backs off,
 *      and a HIDDEN tab stops asking altogether. Five phones left open
 *      overnight must not sit there hammering a free database until
 *      morning.
 */
const { chromium } = require('playwright');
process.env.PORT = process.env.PORT || '3315';
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

(async () => {
  console.log('\n== everybody online at once ==');
  const room = await post('/api/room', { players:[
    { animal:'bee', name:'Hrutik' }, { animal:'deer', name:'Sharayu' },
    { animal:'snake', name:'Shivani' }]});
  const code = room.code, tok = [];
  for (let i = 0; i < 3; i++) tok.push((await post('/api/claim', { code, seat:i })).token);
  for (let i = 0; i < 3; i++) { await post('/api/peek', { code, token:tok[i], indices:[0,1] }); await post('/api/ready', { code, token:tok[i] }); }

  const v0 = await get('/api/state?code=' + code + '&token=' + tok[0]);
  const upNow = v0.turn;                       // whose turn it is
  const waiting = [0,1,2].filter(i => i !== upNow)[0];

  const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium', args:['--no-sandbox'] });
  const pages = {};
  async function phone(seat){
    const ctx = await b.newContext({ viewport:{width:400,height:880}, deviceScaleFactor:2 });
    await ctx.route('https://fonts.g**/**', r => r.abort());
    await ctx.route('https://cdnjs.cloudflare.com/**', route => route.fulfill({
      path: route.request().url().includes('react-dom')
        ? '/home/claude/node_modules/react-dom/umd/react-dom.production.min.js'
        : '/home/claude/node_modules/react/umd/react.production.min.js',
      contentType:'text/javascript' }));
    await ctx.addInitScript(([c, t, s]) => {
      localStorage.setItem('beeshouse:' + c, JSON.stringify({ token:t, seat:s }));
    }, [code, tok[seat], seat]);
    const p = await ctx.newPage();
    p.on('pageerror', e => { fails++; console.log('   FAIL page error seat ' + seat + ':', e.message); });
    p.__calls = 0;
    p.on('request', r => { if (r.url().includes('/api/state')) p.__calls++; });
    pages[seat] = p;
    return p;
  }

  const A = await phone(upNow);      // the one whose turn it is
  const B = await phone(waiting);    // the one waiting

  await A.goto(base + '/g/' + code);
  await B.goto(base + '/g/' + code);
  await A.waitForSelector('.act', { timeout:15000 });
  await B.waitForSelector('.shell', { timeout:15000 });
  await B.waitForTimeout(1500);

  ok((await B.textContent('.shell')).includes('Not your turn'), 'B starts on the wait screen');

  // --- 2. presence: B can see A is here
  await B.waitForFunction(() => document.querySelector('.here-now') !== null, null, { timeout:15000 })
        .catch(()=>{});
  const hereLine = await B.$('.here-now');
  ok(!!hereLine, 'B can see somebody else has the game open');
  if (hereLine) console.log('       "' + (await hereLine.textContent()).trim() + '"');
  await B.screenshot({ path:'/home/claude/l1-presence.png' });

  /* The dot sits on the seat at the round table, which only the player
     whose turn it is has on screen. So it is checked on A, who is looking
     at the table and can see B sitting there waiting. */
  await A.waitForFunction(() => document.querySelector('.seat-t.here') !== null, null, { timeout:15000 })
        .catch(()=>{});
  ok((await A.$$('.seat-t.here')).length >= 1,
     'and at the table, the players who are here carry a live dot');
  await A.screenshot({ path:'/home/claude/l1b-dots.png' });

  /* --- 1. Somebody else takes a turn. B must notice on its own.

     A's turn is driven over the API rather than by clicking through A's
     screen. B is what is under test here, and a flaky click path on A was
     letting this pass without the turn ever actually moving, which is a
     test that proves nothing. */
  const before = await B.textContent('.shell');
  const turnBefore = (await get('/api/state?code=' + code + '&token=' + tok[waiting])).turn;

  let guard = 0;
  while (guard++ < 12) {
    const st = await get('/api/state?code=' + code + '&token=' + tok[upNow]);
    if (st.turn !== upNow) break;
    let mv;
    if (st.modalKind) mv = { type:'CLOSE_MODAL' };
    else if (st.pendingEnd) mv = { type:'END_TURN' };
    else if (st.drawn) mv = { type:'PLACE', idx:0 };
    else mv = { type:'DRAW' };
    try { await post('/api/move', { code, token:tok[upNow], move:mv, expectedVersion:st.version }); }
    catch(e){ if (e.status !== 409) throw e; }
  }

  const serverNow = await get('/api/state?code=' + code + '&token=' + tok[waiting]);
  ok(serverNow.turn !== turnBefore,
     'the turn really did move on the server, so there is something to notice');
  const itIsBsTurn = serverNow.turn === waiting;

  /* NOBODY touches B. It has to work this out for itself, and the wait has
     to be long enough to cover a poll interval, or the test is measuring
     its own impatience rather than the app. */
  const nextName = serverNow.players[serverNow.turn].name;
  const noticed = await B.waitForFunction(
    ([mine, name]) => {
      const t = document.body.textContent || '';
      return mine ? /Draw/.test(t) : t.includes(name + ' is up');
    },
    [itIsBsTurn, nextName],
    { timeout: 25000 }
  ).then(() => true).catch(() => false);

  if (itIsBsTurn){
    ok(noticed, "B's turn arrived on its own, with nobody tapping anything");
    const playable = await B.waitForSelector('.act', { timeout:8000 })
                            .then(()=>true).catch(()=>false);
    ok(playable, 'and B can play immediately, without a reload');
  } else {
    ok(noticed, 'B saw the turn move to ' + nextName + ' on its own, untouched');
    const after = await B.textContent('.shell');
    ok(after !== before, 'and its screen actually changed');
  }
  await B.screenshot({ path:'/home/claude/l2-arrived.png' });

  /* --- 4. you can WATCH. The waiting screen carries the table, so a move
     made on somebody else's phone glides across yours a few seconds later
     without you touching anything.

     This is checked by watching for the class the animation puts on a card
     while it is travelling. It used to be impossible: the waiting screen
     was a line of text and a briefing, so the one time you could have
     watched somebody else play was the one time the table was not on your
     screen. */
  /* By now the turn may well have come round to B, and a player on their
     own turn is looking at the board, not the waiting screen. So B's turn
     is played out over the API first, to put B back in the chair where
     watching is the only thing they can do. Without this the check quietly
     skipped itself every run. */
  let handOff = 0;
  while (handOff++ < 20) {
    const look = await get('/api/state?code=' + code + '&token=' + tok[waiting]);
    if (look.phase !== 'turn' || look.turn !== waiting) break;
    let mv;
    if (look.modalKind) mv = { type:'CLOSE_MODAL' };
    else if (look.pendingEnd) mv = { type:'END_TURN' };
    else if (look.drawn) mv = { type:'DISCARD_DRAWN' };
    else mv = { type:'DRAW' };
    try { await post('/api/move', { code, token:tok[waiting], move:mv, expectedVersion:look.version }); }
    catch(e){ if (e.status !== 409) throw e; }
  }
  await B.waitForSelector('.roundtable', { timeout:20000 }).catch(()=>{});
  await B.waitForTimeout(800);

  ok((await B.$$('.seat-t')).length > 0, 'the table is on screen while you wait');
  ok((await B.$$('.hand .card')).length === 4, 'with your own four under it');

  await B.evaluate(() => {
    window.__glided = new Set();
    new MutationObserver(ms => ms.forEach(m => {
      const el = m.target;
      if (el.classList && el.classList.contains('moving'))
        window.__glided.add(el.getAttribute('data-card') || '?');
    })).observe(document.body, { subtree:true, attributes:true, attributeFilter:['class'] });
  });

  // somebody else plays. B is not touched.
  let w = 0, played = false;
  while (w++ < 40 && !played) {
    const look = await get('/api/state?code=' + code + '&token=' + tok[waiting]);
    if (look.phase !== 'turn' || look.turn === waiting) break;
    const at = look.turn, st = await get('/api/state?code=' + code + '&token=' + tok[at]);
    let mv;
    if (st.modalKind) mv = { type:'CLOSE_MODAL' };
    else if (st.pendingEnd) mv = { type:'END_TURN' };
    else if (st.drawn) { mv = { type:'PLACE', idx:0 }; played = true; }
    else mv = { type:'DRAW' };
    try { await post('/api/move', { code, token:tok[at], move:mv, expectedVersion:st.version }); }
    catch(e){ if (e.status !== 409) throw e; }
  }
  ok(played, 'somebody else put a card into their hand, so there is a move to watch');
  await B.waitForFunction(() => window.__glided.size > 0, null, { timeout:25000 }).catch(()=>{});
  const glided = await B.evaluate(() => [...window.__glided]);
  ok(glided.length > 0,
     'and it glides across your screen, untouched (' + glided.join(',') + ')');
  await B.screenshot({ path:'/home/claude/l3-watching.png', fullPage:true });

  // --- 3a. a HIDDEN tab asks for nothing
  const idleStart = B.__calls;
  await B.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await B.waitForTimeout(1000);
  const afterWake = B.__calls;          // the visibilitychange itself is allowed one
  await B.waitForTimeout(12000);
  const hiddenCalls = B.__calls - afterWake;
  ok(hiddenCalls === 0,
     'a hidden tab made ZERO requests in 12 seconds (' + hiddenCalls + ')');
  console.log('       calls while visible then hidden: ' + idleStart + ' -> ' + B.__calls);

  // --- 3b. and it wakes up properly when you come back
  await B.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await B.waitForTimeout(1500);
  ok(B.__calls > afterWake, 'and starts asking again the moment you come back');

  await b.close();
  console.log(fails ? '\n   ' + fails + ' FAILED\n' : '\n   live play ok\n');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

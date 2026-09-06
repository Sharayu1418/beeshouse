/* The round table.
 *
 * Everybody's four cards are on one surface, and a power is aimed by
 * tapping the card you mean rather than walking through two menus that
 * describe it. So the things worth testing are:
 *
 *   1. Everybody is on the table, with four cards each, all the time.
 *   2. Aiming a Spy is one tap on the table, and it hits the card tapped.
 *   3. A Swap is two taps, yours then theirs, and it moves the right pair.
 *   4. Nothing on the table ever says what a card is. The whole point of
 *      putting 20 face-down cards on screen is that they stay face down.
 */
const { chromium } = require('playwright');
process.env.PORT = process.env.PORT || '3317';
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

const ROSTER = [
  { animal:'bee', name:'Hrutik' }, { animal:'deer', name:'Sharayu' },
  { animal:'snake', name:'Shivani' }, { animal:'rhino', name:'Sahil' },
  { animal:'giraffe', name:'Roshan' }];

(async () => {
  console.log('\n== the round table ==');
  const room = await post('/api/room', { players: ROSTER });
  const code = room.code, tok = [];
  for (let i = 0; i < 5; i++) tok.push((await post('/api/claim', { code, seat:i })).token);
  for (let i = 0; i < 5; i++) { await post('/api/peek', { code, token:tok[i], indices:[0,1] }); await post('/api/ready', { code, token:tok[i] }); }

  const v0 = await get('/api/state?code=' + code + '&token=' + tok[0]);
  const seat = v0.turn;

  const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium', args:['--no-sandbox'] });
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
  p.on('pageerror', e => { fails++; console.log('   FAIL page error:', e.message); });

  await p.goto(base + '/g/' + code);
  await p.waitForSelector('.roundtable', { timeout:15000 });
  await p.waitForTimeout(1200);

  // --- 1. everybody is at the table
  const seats = await p.$$('.seat-t');
  ok(seats.length === 4, 'the four other players are all at the table (' + seats.length + ')');
  const names = await p.$$eval('.seat-t .nm', ns => ns.map(n => n.textContent.trim()));
  const expected = ROSTER.filter((_, i) => i !== seat).map(r => r.name);
  ok(expected.every(n => names.includes(n)),
     'each by name: ' + names.join(', '));
  const counts = await p.$$eval('.seat-t', ns => ns.map(n => n.querySelectorAll('.card').length));
  ok(counts.every(c => c === 4), 'each with four cards (' + counts.join(',') + ')');
  ok((await p.$$('.hand .card')).length === 4, 'and your own four below it');
  ok((await p.$$('.table-piles .card')).length >= 2, 'with the deck and discard in the middle');
  await p.screenshot({ path:'/home/claude/t1-table.png' });

  // --- 4. nothing on the table gives a card away
  const tableText = await p.textContent('.roundtable');
  ok(!/ of (hearts|spades|diamonds|clubs)/i.test(tableText), 'no card is named on the table');
  const faces = await p.$$eval('.seat-t .card', ns => ns.filter(n => n.className.includes('face')).length);
  ok(faces === 0, 'not one of the sixteen opponent cards is face up');
  const domLeak = await p.$$eval('.seat-t .card', ns =>
    ns.filter(n => /[2-9]|10|[AJQK]/.test((n.textContent || '').trim())).length);
  ok(domLeak === 0, 'and none of them has a rank hidden in the markup');

  /* Play the game over the API, every seat, until the named modal lands on
     OUR seat. Powers only appear when the right rank comes off the deck, so
     waiting for one on a single turn made this skip itself most runs, which
     is a test that quietly tests nothing. */
  async function driveUntil(want){
    let guard = 0;
    while (guard++ < 500){
      const look = await get('/api/state?code=' + code + '&token=' + tok[seat]);
      if (look.phase !== 'turn') return false;
      if (look.modalKind === want && look.turn === seat) return true;

      const at = look.turn;
      const st = await get('/api/state?code=' + code + '&token=' + tok[at]);
      if (at === seat && st.modalKind && st.modalKind !== want){
        // a power we are not hunting for, get rid of it and carry on
        try { await post('/api/move', { code, token:tok[at],
              move:{type:'CLOSE_MODAL'}, expectedVersion:st.version }); } catch(e){}
        continue;
      }
      let mv;
      if (st.modalKind === 'spyPick')       mv = { type:'SPY', seat:(at+1)%5, idx:0 };
      else if (st.modalKind === 'swapMine') mv = { type:'SWAP_DO', seat:(at+1)%5, mine:0, idx:0 };
      else if (st.modalKind === 'choosePeek') mv = { type:'PEEK_OWN', idx:0 };
      else if (st.modalKind)                mv = { type:'CLOSE_MODAL' };
      else if (st.pendingEnd)               mv = { type:'END_TURN' };
      else if (st.drawn)                    mv = { type:'DISCARD_DRAWN' };
      else                                  mv = { type:'DRAW' };
      try { await post('/api/move', { code, token:tok[at], move:mv, expectedVersion:st.version }); }
      catch(e){ if (e.status !== 409) throw e; }
    }
    return false;
  }

  /* --- 2. a Spy, aimed by tapping.
     A spy only happens when a nine or a ten comes off the deck, so the game
     is played over the API, every seat, until one lands on OUR seat. Then
     the aiming is done by hand, which is the part under test. Waiting for
     one to turn up by luck on a single turn made this skip itself most
     runs, which is a test that quietly tests nothing. */
  const spied = await driveUntil('spyPick');

  if (spied){
    await p.reload();
    await p.waitForSelector('.aiming-bar', { timeout:15000 });
    const say = (await p.textContent('.aiming-bar')).trim();
    ok(/Tap the card/.test(say), 'a Spy asks you to tap a card, not to read a menu ("' + say + '")');
    const live = await p.$$('.seat-t .card.targetable');
    ok(live.length === 16, 'all sixteen opponent cards light up as targets (' + live.length + ')');
    ok((await p.$$('.hand .card.targetable')).length === 0, 'and your own do not, since you cannot spy yourself');
    await p.screenshot({ path:'/home/claude/t2-aiming.png' });

    /* Tap one, and check the card that comes back is the one tapped.

       Not just any one: the deer's Bolt cancels the first power aimed at
       her, so a test that always tapped the first card on screen kept
       spying Sharayu, getting correctly bolted, and reporting a broken
       reveal. Pick somebody who cannot bounce it.

       The reveal is a .ovl and it closes itself after four seconds, so it
       is read straight away rather than after a long selector wait. */
    const live0 = await get('/api/state?code=' + code + '&token=' + tok[seat]);
    const victim = live0.players.filter(function(pl){
      return pl.seat !== seat && !(pl.id === 'deer' && !pl.abilityUsed);
    })[0];
    ok(!!victim, 'there is somebody who cannot Bolt it away');
    const wanted = victim.slots[0].id;
    const whoName = victim.name, whichSlot = 1;

    await p.click('[data-card="' + wanted + '"]');
    await p.waitForSelector('.ovl', { timeout:8000 });
    await p.screenshot({ path:'/home/claude/t3-revealed.png' });
    const shown = (await p.textContent('.ovl')).trim();
    ok(new RegExp(whoName).test(shown) && new RegExp('slot ' + whichSlot).test(shown),
       'and the card that comes back is the one tapped (' + whoName + ' slot ' + whichSlot + ')');
    /* Check for a real rendered face, not for rank text. Matching on
       characters made this fail whenever the card was a 10, because "10"
       contains no character in [AJQK2-9]. A card face is the actual claim
       anyway. */
    const faceUp = await p.$$eval('.ovl .card.face', ns => ns.length);
    ok(faceUp >= 1, 'with a real card face on it (' + faceUp + ')');
    const named = await p.$eval('.ovl .card.face .cardface',
      n => n.getAttribute('aria-label')).catch(()=>null);
    ok(!!named, 'and the face says which card it is (' + named + ')');
    console.log('       tapped ' + wanted + ' -> "' + shown.replace(/\s+/g,' ').slice(0,60) + '"');
  } else {
    fails++;
    console.log('   FAIL: no Spy came up in 400 moves, so the aiming path went untested');
  }

  /* --- 3. a Swap: two taps, yours then theirs, and the right pair moves. */
  const swapping = await driveUntil('swapMine');
  if (swapping){
    await p.reload();
    await p.waitForSelector('.aiming-bar', { timeout:15000 });
    await p.waitForTimeout(900);

    const first = (await p.textContent('.aiming-bar')).trim();
    ok(/Tap one of yours/.test(first), 'a Swap asks for one of yours first ("' + first + '")');
    ok((await p.$$('.hand .card.targetable')).length === 4, 'your four light up');
    ok((await p.$$('.seat-t .card.targetable')).length === 0, 'and theirs do not, yet');
    await p.screenshot({ path:'/home/claude/t4-swap-mine.png' });

    const mineId = await p.$eval('.hand .card', n => n.getAttribute('data-card'));
    await p.click('.hand .card >> nth=0');
    await p.waitForTimeout(500);

    const second = (await p.textContent('.aiming-bar')).trim();
    ok(/Now tap the card/.test(second), 'then for theirs ("' + second.split('Back')[0].trim() + '")');
    ok((await p.$$('.seat-t .card.targetable')).length === 16, 'and now all sixteen of theirs light up');
    await p.screenshot({ path:'/home/claude/t5-swap-theirs.png' });

    // again, not the deer: a bolted swap moves nothing, correctly
    const liveS = await get('/api/state?code=' + code + '&token=' + tok[seat]);
    const mark = liveS.players.filter(function(pl){
      return pl.seat !== seat && !(pl.id === 'deer' && !pl.abilityUsed);
    })[0];
    const theirsId = mark.slots[0].id;
    const where = (v, id) => {
      let out = null;
      (v.you.hand || []).forEach((c,i) => { if (c.id === id) out = 'mine:' + i; });
      v.players.forEach(pl => (pl.slots||[]).forEach((c,k) => { if (c.id === id) out = pl.name + ':' + k; }));
      return out;
    };
    const beforeV = await get('/api/state?code=' + code + '&token=' + tok[seat]);
    const mineWas = where(beforeV, mineId), theirsWas = where(beforeV, theirsId);

    await p.click('[data-card="' + theirsId + '"]');
    await p.waitForTimeout(1400);

    const afterV = await get('/api/state?code=' + code + '&token=' + tok[seat]);
    const mineNow = where(afterV, mineId), theirsNow = where(afterV, theirsId);
    ok(mineNow === theirsWas && theirsNow === mineWas,
       'the two cards actually changed places (' + mineWas + ' <-> ' + theirsWas + ')');
    ok((await p.$$('.aiming-bar')).length === 0, 'and the table stops asking once it is done');
    await p.screenshot({ path:'/home/claude/t6-swapped.png' });
  } else {
    fails++;
    console.log('   FAIL: no Swap came up, so two-tap targeting went untested');
  }

  /* --- 5. the lobby is the same table, with the empty seats named.
     A separate room, because this one has everybody in it already. */
  const room2 = await post('/api/room', { players: ROSTER });
  const t2 = (await post('/api/claim', { code: room2.code, seat: 0 })).token;
  const ctx2 = await b.newContext({ viewport:{width:400,height:880}, deviceScaleFactor:2 });
  await ctx2.route('https://fonts.g**/**', r => r.abort());
  await ctx2.route('https://cdnjs.cloudflare.com/**', route => route.fulfill({
    path: route.request().url().includes('react-dom')
      ? '/home/claude/node_modules/react-dom/umd/react-dom.production.min.js'
      : '/home/claude/node_modules/react/umd/react.production.min.js',
    contentType:'text/javascript' }));
  await ctx2.addInitScript(([c, t]) => {
    localStorage.setItem('beeshouse:' + c, JSON.stringify({ token:t, seat:0 }));
  }, [room2.code, t2]);
  const q = await ctx2.newPage();
  q.on('pageerror', e => { fails++; console.log('   FAIL page error (lobby):', e.message); });

  await q.goto(base + '/g/' + room2.code);
  await q.waitForSelector('.roundtable', { timeout:15000 });
  await q.waitForTimeout(900);

  ok((await q.$$('.seat-t')).length === 4, 'the lobby shows the same table, not a list');
  ok((await q.$$('.seat-t.empty')).length === 4, 'with all four seats empty');
  ok((await q.$$('.ghost-card')).length === 16, 'and their cards greyed out (16 outlines)');
  const lobbyNames = await q.$$eval('.seat-t .nm', ns => ns.map(n => n.textContent.trim()));
  ok(ROSTER.slice(1).every(r => lobbyNames.includes(r.name)),
     'every empty seat still carries its name: ' + lobbyNames.join(', '));
  ok((await q.$$('.table-piles .card.tap')).length === 0,
     'and nothing on the table pretends to be tappable yet');

  /* Your own four are on screen from the lobby onward, in the same place
     they will be all game. They used to appear for the first time on the
     peek screen, in a different layout, and then move again at the table:
     three positions for the four cards you are supposed to be memorising
     the position of. */
  ok((await q.$$('.hand .card')).length === 4, 'and your own four are already on screen');
  const lobbyHandY = await q.$eval('.hand .card', n => Math.round(n.getBoundingClientRect().top));
  ok(lobbyHandY > 0, 'below the table, where they stay');

  /* And you can take your opening look while you wait. Your four are dealt
     when the room is made, so nothing about looking at two of them depends
     on anybody else turning up. */
  ok((await q.$$('.hand .card.tap')).length === 4, 'your four are tappable while you wait alone');
  await q.click('.hand .card >> nth=1');
  await q.waitForTimeout(200);
  await q.click('.hand .card >> nth=3');
  await q.waitForTimeout(250);
  ok((await q.$$('.hand .card.sel')).length === 2, 'you can choose two of them');
  await q.click('.btn.primary');
  await q.waitForSelector('.ovl', { timeout:10000 });
  ok((await q.$$eval('.ovl .card.face', ns => ns.length)) === 2,
     'and both are shown, alone in an empty room');
  await q.screenshot({ path:'/home/claude/t12-lobby-peek.png', fullPage:true });

  // and it must NOT start the round with four seats still empty
  const stillLobby = await get('/api/state?code=' + room2.code + '&token=' + t2);
  ok(stillLobby.phase === 'peek' && stillLobby.allClaimed === false,
     'looking early does not start the round (' + stillLobby.phase + ')');
  await q.waitForTimeout(4600);
  ok(/had your two|have looked/i.test(await q.textContent('.shell')),
     'and afterwards it says so rather than offering another look');
  await q.screenshot({ path:'/home/claude/t7-lobby.png', fullPage:true });

  /* People arrive, and the room fills in without a reload. Their four
     cards are dealt in rather than blinking on, which is the difference
     between a table filling up and a number changing. */
  await q.evaluate(() => {
    window.__dealtIn = 0;
    new MutationObserver(ms => ms.forEach(m => {
      const el = m.target;
      if (el.classList && el.classList.contains('arriving')) window.__dealtIn++;
    })).observe(document.body, { subtree:true, attributes:true, attributeFilter:['class'] });
  });
  await post('/api/claim', { code: room2.code, seat: 1 });
  await post('/api/claim', { code: room2.code, seat: 3 });
  const filled = await q.waitForFunction(
    () => document.querySelectorAll('.seat-t.empty').length === 2,
    null, { timeout:20000 }).then(()=>true).catch(()=>false);
  ok(filled, 'seats fill in on their own as people arrive, with nobody tapping anything');
  ok((await q.$$('.seat-t:not(.empty) .card')).length === 8,
     'their outlines become real cards (8 of them)');
  ok((await q.$$('.ghost-card')).length === 8, 'and the two still missing keep their outlines');
  ok(await q.evaluate(() => window.__dealtIn) > 0,
     'and the new hands are dealt in rather than just appearing');
  await q.waitForTimeout(1400);
  ok((await q.$$('.seat-t.arriving')).length === 0, 'the arrival settles once it has landed');
  const stillNamed = await q.$$eval('.seat-t.empty .nm', ns => ns.map(n => n.textContent.trim()));
  ok(stillNamed.length === 2, 'and the ones still missing are named: ' + stillNamed.join(', '));
  await q.screenshot({ path:'/home/claude/t8-lobby-filling.png', fullPage:true });

  /* --- 6. the peek is at the table too, and the drawn card comes to your
     hand rather than sitting out with the piles. */
  const room3 = await post('/api/room', { players: ROSTER });
  const t3 = [];
  for (let i = 0; i < 5; i++) t3.push((await post('/api/claim', { code: room3.code, seat:i })).token);
  const ctx3 = await b.newContext({ viewport:{width:400,height:900}, deviceScaleFactor:2 });
  await ctx3.route('https://fonts.g**/**', r => r.abort());
  await ctx3.route('https://cdnjs.cloudflare.com/**', route => route.fulfill({
    path: route.request().url().includes('react-dom')
      ? '/home/claude/node_modules/react-dom/umd/react-dom.production.min.js'
      : '/home/claude/node_modules/react/umd/react.production.min.js',
    contentType:'text/javascript' }));
  await ctx3.addInitScript(([c, t]) => {
    localStorage.setItem('beeshouse:' + c, JSON.stringify({ token:t, seat:0 }));
  }, [room3.code, t3[0]]);
  const r3 = await ctx3.newPage();
  r3.on('pageerror', e => { fails++; console.log('   FAIL page error (peek):', e.message); });

  await r3.goto(base + '/g/' + room3.code);
  await r3.waitForSelector('.hand .card', { timeout:15000 });
  await r3.waitForTimeout(900);
  ok((await r3.$$('.seat-t')).length === 4, 'the opening peek happens at the table');
  ok((await r3.$$('.hand .card')).length === 4, 'with your four in their usual place');
  await r3.click('.hand .card >> nth=0');
  await r3.waitForTimeout(250);
  await r3.click('.hand .card >> nth=2');
  await r3.waitForTimeout(250);
  ok((await r3.$$('.hand .card.sel')).length === 2, 'tapping two marks exactly those two');
  await r3.screenshot({ path:'/home/claude/t9-peek.png', fullPage:true });

  await r3.click('text=Look at these two');
  await r3.waitForSelector('.ovl', { timeout:10000 });
  const peeked = await r3.$$eval('.ovl .card.face', ns => ns.length);
  ok(peeked === 2, 'and both of them are shown, once (' + peeked + ')');
  const firstIds = await r3.$$eval('.ovl .card.face .cardface',
    ns => ns.map(n => n.getAttribute('aria-label')).sort().join('|'));
  await r3.screenshot({ path:'/home/claude/t10-peeked.png', fullPage:true });

  /* You may look again for as long as you like before the round starts,
     and it has to be the SAME two, or you could learn your whole hand by
     asking twice. */
  await r3.waitForSelector('text=Look at them again', { timeout:10000 });
  await r3.click('text=Look at them again');
  await r3.waitForSelector('.ovl', { timeout:10000 });
  const againIds = await r3.$$eval('.ovl .card.face .cardface',
    ns => ns.map(n => n.getAttribute('aria-label')).sort().join('|'));
  ok(againIds === firstIds, 'looking again shows the very same two (' + againIds + ')');
  await r3.screenshot({ path:'/home/claude/t13-look-again.png', fullPage:true });
  await r3.waitForTimeout(4600);

  const beforeReady = await get('/api/state?code=' + room3.code + '&token=' + t3[0]);
  ok(beforeReady.phase === 'peek', 'and looking never starts the round');
  await r3.click('text=I have got them');
  await r3.waitForTimeout(900);

  // everyone else peeks, then drive to our turn and draw
  for (let i = 1; i < 5; i++) { await post('/api/peek', { code: room3.code, token:t3[i], indices:[0,1] }); await post('/api/ready', { code: room3.code, token:t3[i] }); }
  let g3 = 0;
  while (g3++ < 40) {
    const st = await get('/api/state?code=' + room3.code + '&token=' + t3[0]);
    if (st.phase === 'turn' && st.turn === 0) break;
    if (st.phase !== 'turn') break;
    const at = st.turn, mine = await get('/api/state?code=' + room3.code + '&token=' + t3[at]);
    let mv;
    if (mine.modalKind) mv = { type:'CLOSE_MODAL' };
    else if (mine.pendingEnd) mv = { type:'END_TURN' };
    else if (mine.drawn) mv = { type:'DISCARD_DRAWN' };
    else mv = { type:'DRAW' };
    try { await post('/api/move', { code: room3.code, token:t3[at], move:mv, expectedVersion:mine.version }); }
    catch(e){ if (e.status !== 409) throw e; }
  }
  await r3.reload();
  await r3.waitForSelector('.act', { timeout:15000 });
  await r3.waitForTimeout(900);
  await r3.click('.act.gold');
  await r3.waitForSelector('.drawn-row .card', { timeout:10000 });
  ok(true, 'the card you draw appears beside your own hand');
  ok((await r3.$$('.table-piles .card')).length === 2,
     'and not out in the middle with the piles');

  const drawnY = await r3.$eval('.drawn-row .card', n => n.getBoundingClientRect().top);
  const handY  = await r3.$eval('.hand .card', n => n.getBoundingClientRect().top);
  const pileY  = await r3.$eval('.table-piles .card', n => n.getBoundingClientRect().top);
  ok(drawnY > pileY && drawnY < handY,
     'sitting between the table and your four, which is where it is going');
  await r3.screenshot({ path:'/home/claude/t11-drawn.png', fullPage:true });

  await b.close();
  console.log(fails ? '\n   ' + fails + ' FAILED\n' : '\n   round table ok\n');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

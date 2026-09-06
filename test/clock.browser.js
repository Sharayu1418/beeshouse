/* The clock on a real screen, at all three stages: fresh, overdue, and
 * two days gone. The waiting player's phone is the one that has to change,
 * and the person holding things up must never see a button that skips
 * himself. */
const { chromium } = require('playwright');

/* The server runs INSIDE this process. That is the whole trick: the clock
   is read off created_at in the move log, and no endpoint writes an old
   row (correctly, since one that did would be a way to skip anybody at
   will). Sharing the process means the test can append an old row to the
   very storage the routes are reading, and everything else still goes over
   real HTTP through the real handlers. */
process.env.PORT = process.env.PORT || '3311';
require('../server.js');
const { db } = require('../api/_handler.js');
const base = 'http://localhost:' + process.env.PORT;
const HRS = 3600000;

/* Age a room by appending one move by somebody other than the player whose
   turn it is, dated in the past. Append only, same as everything else. */
async function ageRoom(code, hoursAgo, notSeat){
  const store = db();
  const game = await store.getGameByCode(code);
  const round = await store.getRound(game.id, game.round_n || 1);
  await store.appendMoves([{
    game_id: game.id, round_n: (round && round.n) || 1, seat: notSeat,
    type:'END_TURN', payload:{}, public_text:null, actor_id:null, victim_ids:[],
    created_at: new Date(Date.now() - hoursAgo * HRS).toISOString()
  }]);
}

const post = async (p,b)=>{ const r=await fetch(base+p,{method:'POST',
  headers:{'content-type':'application/json'},body:JSON.stringify(b)});
  const d=await r.json().catch(()=>({})); if(!r.ok){const e=new Error(d.error);e.status=r.status;throw e;} return d; };
const get = async p => { const r=await fetch(base+p); const d=await r.json().catch(()=>({}));
  if(!r.ok){const e=new Error(d.error);e.status=r.status;throw e;} return d; };

let fails=0; const ok=(c,m)=>{ if(!c){fails++;console.log('   FAIL:',m);} else console.log('   ok  ',m); };

(async () => {
  console.log('\n== turn clock in a browser ==');
  const room = await post('/api/room',{players:[
    {animal:'bee',name:'Hrutik'},{animal:'deer',name:'Sharayu'},{animal:'snake',name:'Shivani'}]});
  const code = room.code, tok=[];
  for(let i=0;i<3;i++) tok.push((await post('/api/claim',{code,seat:i})).token);
  for(let i=0;i<3;i++){ await post('/api/peek',{code, token:tok[i], indices:[0,1]});
    await post('/api/ready',{code, token:tok[i]}); }

  let v = await get('/api/state?code='+code+'&token='+tok[0]);
  const holder = v.turn, other = [0,1,2].filter(i=>i!==holder)[0];

  const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium', args:['--no-sandbox'] });
  async function phoneFor(seat){
    const ctx = await b.newContext({ viewport:{width:400,height:880}, deviceScaleFactor:2 });
    await ctx.route('https://fonts.g**/**', r=>r.abort());
    await ctx.route('https://cdnjs.cloudflare.com/**', route => route.fulfill({
      path: route.request().url().includes('react-dom')
        ? '/home/claude/node_modules/react-dom/umd/react-dom.production.min.js'
        : '/home/claude/node_modules/react/umd/react.production.min.js',
      contentType:'text/javascript' }));
    await ctx.addInitScript(([c,t,s2]) => {
      localStorage.setItem('beeshouse:'+c, JSON.stringify({ token:t, seat:s2 }));
    }, [code, tok[seat], seat]);
    const p = await ctx.newPage();
    p.on('pageerror', e => { fails++; console.log('   FAIL page error:', e.message); });
    return p;
  }
  const waiter = await phoneFor(other);
  const slow   = await phoneFor(holder);

  // --- stage 1, fresh
  await waiter.goto(base+'/g/'+code);
  await waiter.waitForSelector('.eyebrow', { timeout:10000 });
  await waiter.waitForTimeout(400);
  let txt = await waiter.textContent('.shell');
  ok(/Not your turn/.test(txt), 'the waiting phone is on the wait screen');
  ok(/Up for just now/.test(txt), 'a fresh turn reads as just now');
  ok((await waiter.$$('.btn.ghost.danger')).length === 0, 'no skip button on a fresh turn');
  ok((await waiter.$$('.btn.wa.loud')).length === 0, 'and the nudge is not shouting yet');
  await waiter.screenshot({ path:'/home/claude/c1-fresh.png' });

  // --- stage 2, 30 hours
  await ageRoom(code, 30, other);
  await waiter.reload();
  await waiter.waitForSelector('.eyebrow', { timeout:10000 });
  await waiter.waitForTimeout(400);
  txt = await waiter.textContent('.shell');
  ok(/SITTING ON IT FOR|Sitting on it for/i.test(txt), 'past a day it says how long ('+/Sitting on it for [^\n]*/i.exec(txt)+')');
  ok((await waiter.$$('.btn.wa.loud')).length === 1, 'the nudge gets louder');
  ok((await waiter.$$('.btn.ghost.danger')).length === 0, 'still no skip at 30 hours');
  await waiter.screenshot({ path:'/home/claude/c2-overdue.png' });

  // --- stage 3, 50 hours
  await ageRoom(code, 50, other);
  await waiter.reload();
  await waiter.waitForSelector('.eyebrow', { timeout:10000 });
  await waiter.waitForTimeout(400);
  ok((await waiter.$$('.btn.ghost.danger')).length === 1, 'the skip appears after two days');
  await waiter.screenshot({ path:'/home/claude/c3-skippable.png' });

  // the slow one must not be offered it
  await slow.goto(base+'/g/'+code);
  await slow.waitForTimeout(900);
  const slowTxt = await slow.textContent('.shell');
  ok(!/Skip /.test(slowTxt), 'the person holding it up is never offered the button');

  // --- press it
  const nameBefore = (await get('/api/state?code='+code+'&token='+tok[other])).players[holder].name;
  await waiter.click('.btn.ghost.danger');
  await waiter.waitForTimeout(300);
  const armedTxt = await waiter.textContent('.btn.ghost.danger');
  ok(/Tap again/.test(armedTxt), 'one tap only arms it (\''+armedTxt.trim()+'\')');
  const stillHis = await get('/api/state?code='+code+'&token='+tok[other]);
  ok(stillHis.turn === holder, 'and one tap changes nothing on the server');
  await waiter.screenshot({ path:'/home/claude/c3b-armed.png' });
  await waiter.click('.btn.ghost.danger');
  await waiter.waitForTimeout(1200);
  const after = await get('/api/state?code='+code+'&token='+tok[other]);
  ok(after.turn !== holder, 'pressing it moved the game on');
  await waiter.screenshot({ path:'/home/claude/c4-after.png' });
  console.log('       skipped:', nameBefore, '-> now', after.players[after.turn].name);

  await b.close();
  console.log(fails ? '\n   '+fails+' FAILED\n' : '\n   clock screen ok\n');
  process.exit(fails?1:0);
})().catch(e => { console.error(e); process.exit(1); });

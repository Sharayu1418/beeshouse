#!/usr/bin/env node
/* Four friends who are always free.
 *
 *   npm run dev                      in one terminal
 *   node tools/play.js               in another
 *
 * Leaves one seat empty for you, sits in the other four, and plays them.
 * You open the link it prints, take your seat, and the table moves around
 * you: people look at their own cards, swap, sting, shed, burn a match off
 * turn, call Cabo. Which is the only way to see any of the motion, because
 * all of it is somebody ELSE doing something while you watch.
 *
 *   node tools/play.js --seat 0      leave Hrutik for you instead
 *   node tools/play.js --fast        stop pausing between moves
 *   node tools/play.js --quiet       one line per turn instead of each move
 *   node tools/play.js http://localhost:3000
 *
 * It waits when the turn is yours and picks up when you have played. Stop
 * it with Ctrl-C; restart the dev server for a clean table, since in-memory
 * storage is wiped every time it boots.
 *
 * Local by default, and it refuses the live site: there is only ever one
 * room, so pointing this at production would take the group's game.
 */
'use strict';

const args = process.argv.slice(2);
const flag = n => args.includes('--' + n);
const val  = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i+1] : d; };
const BASE = (args.find(a => /^https?:\/\//.test(a)) || 'http://localhost:3000').replace(/\/$/, '');
const HUMAN = Number(val('seat', 1));            // deer, Sharayu, by default
const FAST = flag('fast'), QUIET = flag('quiet');
const PAUSE = FAST ? 0 : Number(val('pause', 1400));

if (/bee-house\.vercel\.app/.test(BASE) && !flag('force')) {
  console.error('\n  Not against the live site. There is only ever one room, so this would\n' +
                '  take whatever game the group is in the middle of.\n\n' +
                '  Run `npm run dev` and point it at http://localhost:3000.\n');
  process.exit(1);
}

const ROSTER = [{animal:'bee',name:'Hrutik'},{animal:'deer',name:'Sharayu'},
                {animal:'snake',name:'Shivani'},{animal:'rhino',name:'Sahil'},
                {animal:'giraffe',name:'Roshan'}];

async function post(path, body){
  const r = await fetch(BASE+path, { method:'POST', headers:{'content-type':'application/json'},
                                     body: JSON.stringify(body) });
  const d = await r.json().catch(()=>({}));
  if (!r.ok) { const e = new Error(d.error||('HTTP '+r.status)); e.status = r.status; throw e; }
  return d;
}
async function get(path){
  const r = await fetch(BASE+path);
  const d = await r.json().catch(()=>({}));
  if (!r.ok) { const e = new Error(d.error||('HTTP '+r.status)); e.status = r.status; throw e; }
  return d;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = (s) => console.log('   ' + s);

/* What each of them thinks they know about their own hand.
 *
 * They are playing the same game you are: they cannot see their own cards
 * and the server will not tell them. So they remember the two they looked
 * at, and any card they drew and placed themselves, and nothing else.
 *
 * Kept as {slot: {id, r, s}} and checked by ID on every use. If the card at
 * that slot is no longer the one they remember, the memory is wrong and is
 * thrown away. Somebody swapped with them, or stung them, or the snake
 * shed and every id in her hand changed. That last one is Shed working: her
 * own memory of her hand empties along with everyone else's.
 *
 * Without this they burned blind, were wrong about ninety four times in a
 * hundred, and turned the table into a penalty machine. Which is a fair
 * description of what happens to a person who slaps without looking. */
const brain = {};
function remember(seat, slot, card){
  brain[seat] = brain[seat] || {};
  brain[seat][slot] = { id: card.id, r: card.r, s: card.s };
}
function recall(seat, slot, hand){
  const m = brain[seat] && brain[seat][slot];
  if (!m) return null;
  const now = hand[slot];
  if (!now || now.id !== m.id) { delete brain[seat][slot]; return null; }   // not theirs any more
  return m;
}
/* Which of their own cards they are confident match the pile. */
function knownMatches(seat, v){
  if (!v.discardTop) return [];
  const out = [];
  v.you.hand.forEach(function(c, i){
    const m = recall(seat, i, v.you.hand);
    if (m && m.r === v.discardTop.r) out.push(i);
  });
  return out;
}

/* What each of them is likely to do, so the table has some character rather
   than five people drawing and discarding at each other for an hour. */
function choose(v, me, seat){
  const others = [0,1,2,3,4].filter(x => x !== seat && x !== undefined);
  if (v.modalKind === 'choosePeek')  return { type:'PEEK_OWN', idx: Math.floor(Math.random()*me.handCount) };
  if (v.modalKind === 'spyPick')     return { type:'SPY', seat: others[0], idx:0 };
  if (v.modalKind === 'swapMine')    return { type:'SWAP_DO', seat: others[0], mine:0, idx:0 };
  if (v.modalKind === 'sting')       return { type:'STING_DONE', a: others[0], b: others[1] };
  if (v.modalKind)                   return { type:'CLOSE_MODAL' };
  if (v.pendingEnd)                  return { type:'END_TURN' };

  // the abilities are the interesting part, so they get used early and often
  if (!v.you.abilityUsed && Math.random() < 0.45) return { type:'ABILITY' };
  if (!v.you.sweepUsed && v.discardCount > 2 && Math.random() < 0.15) return { type:'SWEEP' };
  if (v.drawn) {
    if (!me.handCount) return { type:'DISCARD_DRAWN' };
    /* Putting a card you have just looked at into a slot you have chosen is
       the other half of how anybody knows anything in this game. */
    const idx = Math.floor(Math.random()*me.handCount);
    return { type:'PLACE', idx: idx, _learn: { slot: idx, card: v.drawn } };
  }
  if (v.caboBy === null && v.round >= 2 && Math.random() < 0.08) return { type:'CABO' };
  return Math.random() < 0.15 && v.discardTop ? { type:'TAKE_DISCARD' } : { type:'DRAW' };
}

const HOW = {
  DRAW:'took one off the deck', TAKE_DISCARD:'took the face up card',
  PLACE:'put it in their hand', DISCARD_DRAWN:'threw it away',
  PEEK_OWN:'looked at one of their own', SPY:'spied on somebody',
  SWAP_DO:'swapped blind', STING_DONE:'stung two people',
  ABILITY:'used their animal', SWEEP:'swept the floor',
  CABO:'called CABO', END_TURN:'ended their turn', CLOSE_MODAL:''
};

(async () => {
  console.log('\n  The Bee\'s House, with four stand ins.\n  ' + BASE + '\n');

  const room = await post('/api/room', { players: ROSTER });
  const seats = await get('/api/room?code=' + room.code);
  const taken = seats.seats.filter(s => s.claimed);
  if (room.existing && taken.length) {
    console.error('  ' + room.code + ' already has people in it: ' +
                  taken.map(s => s.name).join(', ') +
                  '\n  Restart the dev server for a clean table.\n');
    process.exit(1);
  }

  const tok = {};
  for (let i = 0; i < 5; i++) {
    if (i === HUMAN) continue;
    tok[i] = (await post('/api/claim', { code: room.code, seat: i })).token;
  }
  const any = tok[Object.keys(tok)[0]];
  const mine = ROSTER[HUMAN];

  console.log('  Room ' + room.code + '. You are ' + mine.name + '.\n');
  console.log('      ' + BASE + '/g/' + room.code + '\n');
  console.log('  Open that, tap ' + mine.name + ', take your opening look.');
  console.log('  The other four are already sitting down.\n');

  /* Their opening looks, spread out, so you can watch them happen from your
     own screen. This is the gesture that has no motion of its own. */
  for (const i of Object.keys(tok)) {
    const look = await post('/api/peek', { code: room.code, token: tok[i],
                     indices:[0, 1+Math.floor(Math.random()*3)] }).catch(()=>null);
    if (look && look.reveal && look.reveal.cards)
      look.reveal.cards.forEach(function(c){ remember(i, c.slot, c); });
    await sleep(PAUSE);
    await post('/api/ready', { code: room.code, token: tok[i] }).catch(()=>{});
    if (!QUIET) say(ROSTER[i].name + ' looked at two of their own');
  }
  console.log('\n  Waiting for you to say you are ready.\n');

  let waiting = false, lastTurn = -1, guard = 0, burnedThisTurn = false;
  while (guard++ < 20000) {
    let v;
    try { v = await get('/api/state?code=' + room.code + '&token=' + any); }
    catch (e) { say('lost the server: ' + e.message); await sleep(2000); continue; }

    if (v.phase === 'matchEnd') { console.log('\n  The match is over. Your screen has the recap.\n'); break; }
    if (v.phase === 'roundEnd') {
      say('round ' + v.round + ' done, dealing the next one');
      await post('/api/next-round', { code: room.code, token: any }).catch(()=>{});
      await sleep(PAUSE); continue;
    }
    if (v.phase === 'peek') { await sleep(1200); continue; }
    if (v.phase !== 'turn') { await sleep(1200); continue; }

    if (v.turn === HUMAN) {
      if (!waiting) { console.log('\n  Your turn. Go on.\n'); waiting = true; burnedThisTurn = false; }
      await sleep(1200);

      /* While they wait, somebody occasionally burns a match off turn, which
         is the one thing anybody may do at any time. Worth seeing from your
         seat: it happens while you are still deciding. */
      /* One attempt per turn of yours, and only on a card they believe they
         are holding. A bot that burns blind is not a player, it is a
         penalty machine, and the Tab fills up with nothing but its mistakes. */
      if (!burnedThisTurn) {
        burnedThisTurn = true;
        for (const i of Object.keys(tok)) {
          const bv = await get('/api/state?code=' + room.code + '&token=' + tok[i]);
          if (bv.you.hand.length <= 1) continue;
          const sure = knownMatches(i, bv);
          if (!sure.length) continue;
          try {
            await post('/api/move', { code: room.code, token: tok[i],
                        move:{ type:'SLAP_GO', idx: [sure[0]] }, expectedVersion: bv.version });
            delete brain[i][sure[0]];
            say(ROSTER[i].name + ' burned a ' + bv.discardTop.r + ' while you were thinking');
          } catch(e){}
          break;
        }
      }
      continue;
    }
    waiting = false;

    const seat = v.turn;
    if (QUIET && seat !== lastTurn) say(ROSTER[seat].name + ' is playing');
    lastTurn = seat;

    const mv = await get('/api/state?code=' + room.code + '&token=' + tok[seat]);
    const move = choose(mv, mv.players[seat], seat);
    try {
      await post('/api/move', { code: room.code, token: tok[seat], move: move,
                                expectedVersion: mv.version });
      if (move._learn) {
        /* They saw the card go in, so from here they know that slot until
           somebody takes it off them. */
        const now = await get('/api/state?code=' + room.code + '&token=' + tok[seat]);
        const landed = now.you.hand[move._learn.slot];
        if (landed) remember(seat, move._learn.slot,
                             { id: landed.id, r: move._learn.card.r, s: move._learn.card.s });
      }
      if (!QUIET && HOW[move.type]) say(ROSTER[seat].name + ' ' + HOW[move.type]);
    } catch (e) { if (e.status !== 409) say(ROSTER[seat].name + ': ' + e.message); }
    await sleep(PAUSE);
  }
})().catch(e => {
  if (/ECONNREFUSED|fetch failed/.test(e.message))
    console.error('\n  Nothing is listening on ' + BASE + '. Run `npm run dev` first.\n');
  else console.error('\n  ' + (e.stack || e.message) + '\n');
  process.exit(1);
});

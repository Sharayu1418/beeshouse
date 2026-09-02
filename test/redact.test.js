/* The test that matters.
 *
 * Plays thousands of real matches and, at every single state, builds the
 * view for every seat and asserts that no card value the seat has not
 * earned appears anywhere in it. Also asserts the memory rule: that a
 * reveal never survives into GET /api/state.
 */
const E = require('../lib/engine.js');
const R = require('../lib/redact.js');
const { reducer, init, ROSTER } = E;

let checks = 0, leaks = 0, revealLeaks = 0, ownValueLeaks = 0, sampled = [];

function checkAllSeats(s){
  for (let seat = 0; seat < s.players.length; seat++){
    const view = R.viewFor(s, seat, { code:'TEST', version:1 });
    checks++;

    // 1. nothing unearned anywhere in the view
    try { R.assertNoLeak(view, s, seat); }
    catch (e) { leaks++; if (sampled.length < 3) sampled.push(e.message); }

    // 2. your OWN hand must come back valueless — the app must not remember for you
    if (view.you && s.phase !== 'roundEnd' && s.phase !== 'matchEnd'){
      for (const c of view.you.hand){
        if ('v' in c) { ownValueLeaks++; if (sampled.length<3) sampled.push('own hand carried a value: '+JSON.stringify(c)); }
      }
    }

    // 3. every other player's slots must be valueless too
    for (const p of view.players){
      if (s.phase === 'roundEnd' || s.phase === 'matchEnd') break;
      for (const c of (p.slots||[])){
        if ('v' in c) { leaks++; if (sampled.length<3) sampled.push('opponent slot carried a value'); }
      }
    }

    // 4. THE MEMORY RULE: a reveal may exist on the move response, but a
    //    fresh GET of the same state must never contain that value.
    const rev = R.revealFor(s, seat);
    if (rev && (rev.kind === 'card' || rev.kind === 'cards')){
      const values = rev.kind === 'card' ? [rev.v] : rev.cards.map(c=>c.v);
      const ids    = rev.kind === 'card' ? [rev.id] : rev.cards.map(c=>c.id);
      const json = JSON.stringify(view);
      ids.forEach((id,i) => {
        // the id may legitimately appear (it's a position on the table);
        // the VALUE paired with it must not.
        if (json.includes('"id":"'+id+'","v":'+values[i])) {
          revealLeaks++;
          if (sampled.length<3) sampled.push('reveal '+id+'='+values[i]+' survived into GET /state');
        }
      });
    }
  }
}

function seats(n){
  return ROSTER.slice(0,n).map(r => ({ id:r.id,name:r.name,emo:r.emo,animal:r.animal,ability:r.ability,blurb:r.blurb }));
}

const N = Number(process.env.N || 600);
for (let g=0; g<N; g++){
  let s = reducer(init(), {type:'ACCEPT'});
  s = reducer(s, {type:'SET_PLAYERS', players: seats(2 + Math.floor(Math.random()*4))});
  let steps = 0;
  while (s.phase !== 'matchEnd' && steps < 5000){
    steps++;
    checkAllSeats(s);
    if (s.phase==='peek'){ s=reducer(s,{type:'SETUP_TOGGLE',idx:0}); s=reducer(s,{type:'SETUP_TOGGLE',idx:1}); s=reducer(s,{type:'SETUP_NEXT'}); continue; }
    if (s.phase==='curtain'){ s=reducer(s,{type:'LIFT_CURTAIN'}); continue; }
    if (s.phase==='score'){ s=reducer(s,{type:'SCORE'}); continue; }
    if (s.phase==='roundEnd'){ s=reducer(s,{type:'NEXT_ROUND'}); continue; }
    if (s.phase!=='turn') break;
    const me = s.players[s.turn];
    if (s.modal){
      const k=s.modal.kind;
      if(k==='choosePeek') s=reducer(s,{type:'PEEK_OWN',idx:0});
      else if(k==='spyPick') s=reducer(s,{type:'SPY',seat:(s.turn+1)%s.players.length,idx:0});
      else if(k==='swapMine'){ const st=(s.turn+1)%s.players.length;
        s=(me.hand.length&&s.players[st].hand.length)?reducer(s,{type:'SWAP_DO',seat:st,mine:0,idx:0}):reducer(s,{type:'CLOSE_MODAL'}); }
      else if(k==='sting'){ const o=s.players.map((p,i)=>i).filter(i=>i!==s.turn);
        s=o.length>=2?reducer(s,{type:'STING_DONE',a:o[0],b:o[1]}):reducer(s,{type:'CLOSE_MODAL'}); }
      else if(k==='neck'){ const t=s.deck.slice(0,3); s=t.length===3?reducer(s,{type:'NECK_DONE',order:t}):reducer(s,{type:'CLOSE_MODAL'}); }
      else s=reducer(s,{type:'CLOSE_MODAL'});
      continue;
    }
    if (s.pendingEnd){ s=reducer(s,{type:'END_TURN'}); continue; }
    if (s.sel.length){ s=reducer(s,{type:'SLAP_GO'}); continue; }
    const r=Math.random();
    if (r<0.16 && !me.abilityUsed) s=reducer(s,{type:'ABILITY'});
    else if (r<0.28 && !me.sweepUsed && s.discard.length) s=reducer(s,{type:'SWEEP'});
    else if (r<0.38 && s.discard.length && me.hand.length) s=reducer(s,{type:'SLAP_TOGGLE',idx:0});
    else if (r<0.43 && s.caboBy===null) s=reducer(s,{type:'CABO'});
    else { s=reducer(s,{type:'DRAW'});
           if (s.drawn) s=(Math.random()<0.5&&s.players[s.turn].hand.length)?reducer(s,{type:'PLACE',idx:0}):reducer(s,{type:'DISCARD_DRAWN'}); }
  }
}

console.log(`views checked: ${checks}`);
console.log(`unearned values exposed: ${leaks}`);
console.log(`own-hand values exposed: ${ownValueLeaks}`);
console.log(`reveals surviving into GET /state: ${revealLeaks}`);
if (sampled.length) console.log('samples:\n  ' + sampled.join('\n  '));
const fail = leaks || ownValueLeaks || revealLeaks;
console.log(fail ? 'FAIL' : 'PASS');
process.exit(fail ? 1 : 0);

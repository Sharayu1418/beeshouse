/* Fuzz the shared engine. Same harness that cleared Phase 0, now pointed at lib/engine.js. */
const E = require('../lib/engine.js');
const { reducer, init, ROSTER, settleTab } = E;

function seats(n){
  return ROSTER.slice(0,n).map(r => ({
    id:r.id, name:r.name, emo:r.emo, animal:r.animal, ability:r.ability, blurb:r.blurb }));
}

function drive(s, rng){
  let steps = 0;
  while (s.phase !== 'matchEnd' && steps < 8000) {
    steps++;
    if (s.phase === 'peek'){
      s = reducer(s,{type:'SETUP_TOGGLE', idx:0});
      s = reducer(s,{type:'SETUP_TOGGLE', idx:1});
      s = reducer(s,{type:'SETUP_NEXT'});
      continue;
    }
    if (s.phase === 'curtain'){ s = reducer(s,{type:'LIFT_CURTAIN'}); continue; }
    if (s.phase === 'score'){   s = reducer(s,{type:'SCORE'});        continue; }
    if (s.phase === 'roundEnd'){s = reducer(s,{type:'NEXT_ROUND'});   continue; }
    if (s.phase !== 'turn') break;

    const me = s.players[s.turn];
    if (s.modal){
      const k = s.modal.kind;
      if (k==='choosePeek')      s = reducer(s,{type:'PEEK_OWN', idx:0});
      else if (k==='spyPick')    s = reducer(s,{type:'SPY', seat:(s.turn+1)%s.players.length, idx:0});
      else if (k==='swapMine'){
        const seat=(s.turn+1)%s.players.length;
        s = (me.hand.length && s.players[seat].hand.length)
          ? reducer(s,{type:'SWAP_DO', seat, mine:0, idx:0})
          : reducer(s,{type:'CLOSE_MODAL'});
      }
      else if (k==='sting'){
        const o = s.players.map((p,i)=>i).filter(i=>i!==s.turn);
        s = o.length>=2 ? reducer(s,{type:'STING_DONE', a:o[0], b:o[1]}) : reducer(s,{type:'CLOSE_MODAL'});
      }
      else if (k==='neck'){
        const t = s.deck.slice(0,3);
        s = t.length===3 ? reducer(s,{type:'NECK_DONE', order:t}) : reducer(s,{type:'CLOSE_MODAL'});
      }
      else s = reducer(s,{type:'CLOSE_MODAL'});
      continue;
    }
    if (s.pendingEnd){ s = reducer(s,{type:'END_TURN'}); continue; }
    if (s.sel.length){ s = reducer(s,{type:'SLAP_GO'}); continue; }

    const r = rng();
    if      (r<0.15 && !me.abilityUsed)                        s = reducer(s,{type:'ABILITY'});
    else if (r<0.26 && !me.sweepUsed && s.discard.length)      s = reducer(s,{type:'SWEEP'});
    else if (r<0.36 && s.discard.length && me.hand.length)     s = reducer(s,{type:'SLAP_TOGGLE', idx:0});
    else if (r<0.41 && s.caboBy===null)                        s = reducer(s,{type:'CABO'});
    else {
      s = reducer(s,{type:'DRAW'});
      if (s.drawn) s = (rng()<0.5 && s.players[s.turn].hand.length)
        ? reducer(s,{type:'PLACE', idx:0})
        : reducer(s,{type:'DISCARD_DRAWN'});
    }

    // invariants, every single step
    for (const p of s.players){
      if (p.hand.some(c => c==null))              throw new Error('null card in '+p.name+"'s hand");
      if (p.hand.some(c => typeof c.v!=='number')) throw new Error('non-numeric card value');
      if (p.hand.some(c => c.v<0 || c.v>13))       throw new Error('card value out of range: '+p.hand.map(c=>c.v));
    }
    if (s.discard.some(c=>c==null)) throw new Error('null in discard');
    if (s.deck.some(c=>c==null))    throw new Error('null in deck');
    const all = [...s.deck, ...s.discard, ...s.players.flatMap(p=>p.hand)].map(c=>c.id);
    if (new Set(all).size !== all.length) throw new Error('duplicate card id in play');
  }
  return { s, steps };
}

let ok=0, crashed=0, stalled=0, settlementErrors=0, flips=0;
const N = Number(process.env.N || 4000);
for (let g=0; g<N; g++){
  try{
    let s = reducer(init(), {type:'ACCEPT'});
    s = reducer(s, {type:'SET_PLAYERS', players: seats(2 + Math.floor(Math.random()*4))});
    const out = drive(s, Math.random);
    if (out.steps >= 8000) { stalled++; continue; }
    s = out.s;
    if (s.phase !== 'matchEnd') { stalled++; continue; }
    ok++;

    const st = settleTab(s);
    for (const r of st.rows){
      const expect = r.p.id === st.leader.id ? r.base
        : r.base - s.log.filter(e => e.by===st.leader.id && e.to && e.to.indexOf(r.p.id)>=0).length;
      if (r.final !== expect) settlementErrors++;
    }
    const pre = s.players.map(p=>({p, t:s.totals[p.id]||0})).sort((a,b)=>a.t-b.t)[0].p.id;
    if (st.rows[0].p.id !== pre) flips++;
  }catch(e){
    crashed++;
    if (crashed<=3) console.error('  CRASH:', e.message);
  }
}
const fail = crashed || stalled || settlementErrors;
console.log(`matches: ${ok}/${N}  crashes: ${crashed}  stalled: ${stalled}  settlement errors: ${settlementErrors}`);
console.log(`Tab changed the winner in ${flips} matches (${(100*flips/Math.max(ok,1)).toFixed(1)}%)`);
console.log(fail ? 'FAIL' : 'PASS');
process.exit(fail ? 1 : 0);

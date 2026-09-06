/* The Bee's House, game engine.
 *
 * Pure. No DOM, no network, no clock, no randomness beyond makeDeck().
 * The browser loads it with a <script> tag; the server require()s it.
 * Both run the identical code, which is the whole point: the client can
 * predict, but the server decides.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* ============================================================
   2. rules / constants
   ============================================================ */
var ROSTER = [
  { id:'bee',     name:'Hrutik', emo:'\u{1F41D}', animal:'Bee',     ability:'Sting',
    blurb:'Force two others to blind-swap a card. You learn nothing.', host:true },
  { id:'deer',    name:'Sharayu', emo:'\u{1F98C}', animal:'Deer',    ability:'Bolt',
    blurb:'Cancel one power aimed at you. It simply does not happen.' },
  { id:'snake',   name:'Shivani', emo:'\u{1F40D}', animal:'Snake',   ability:'Shed',
    blurb:'Secretly shuffle your own four positions. Their memory is now wrong.' },
  { id:'rhino',   name:'Sahil',   emo:'\u{1F98F}', animal:'Rhino',   ability:'Charge',
    blurb:'Take two actions back to back instead of one.' },
  { id:'giraffe', name:'Roshan',  emo:'\u{1F992}', animal:'Giraffe', ability:'Hush',
    blurb:'Nothing you do for the rest of this turn goes on the Tab.' }
];

var HAND = 4, ROUNDS = 3, CABO_PENALTY = 10, REVEAL_MS = 3400;
var DISH = { 2:{n:'Vada Pav', b:'A free peek at one of your own.'},
             3:{n:'Misal',    b:'Force one player to show a card to the table.'},
             4:{n:'Thali',    b:'Minus three on this round.'} };

/* A real 52-card deck.
 *
 * A card is { id, r, s }, rank and suit, and deliberately NO value.
 * The value is computed by valueOf(), which means a card object literally
 * cannot leak its score by being serialised carelessly: the number does
 * not exist until something asks for it.
 *
 * The rule that matters:
 *   black king (spades, clubs) = 13, the worst card in the deck
 *   red king  (hearts, diamonds) = -1, the best card in the deck
 *
 * Nothing on the face says which. A king looks like a king, so a player
 * who spies one and does not register the suit will happily throw away
 * the best card on the table. That trap is the whole reason for a real
 * deck, and it is why suit is now something you have to remember.
 */
var RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
var SUITS = ['S','H','D','C'];              // spades, hearts, diamonds, clubs
var SUIT_CHAR = { S:'\u2660', H:'\u2665', D:'\u2666', C:'\u2663' };
var DECK_VERSION = 2;                        // 1 was the old 0-13 deck

function isRed(card){ return card.s === 'H' || card.s === 'D'; }

function valueOf(card){
  if (!card) return 0;
  switch (card.r) {
    case 'A': return 1;
    case 'J': return 11;
    case 'Q': return 12;
    case 'K': return isRed(card) ? -1 : 13;
    default:  return Number(card.r);
  }
}

var uid = 0;
function makeDeck(){
  var d = [];
  for (var si = 0; si < SUITS.length; si++)
    for (var ri = 0; ri < RANKS.length; ri++)
      d.push({ id: 'c' + (++uid), r: RANKS[ri], s: SUITS[si] });
  for (var i = d.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = d[i]; d[i] = d[j]; d[j] = t;
  }
  return d;
}

/* Powers hang off rank, so all four of a rank behave alike. */
function powerOf(rank){
  if (rank && typeof rank === 'object') rank = rank.r;   // tolerate a whole card
  if (rank === '7'  || rank === '8')  return 'peek';
  if (rank === '9'  || rank === '10') return 'spy';
  if (rank === 'J'  || rank === 'Q')  return 'swap';
  return null;
}

function sum(hand){ return hand.reduce(function(a,c){ return a + valueOf(c); }, 0); }

/* Human-readable, for logs and tests. Never sent to a client. */
function cardLabel(c){ return c ? (c.r + SUIT_CHAR[c.s]) : '--'; }

/* ============================================================
   3. reducer
   ============================================================ */
function newRound(state, roundNo){
  var deck = makeDeck();
  var players = state.players.map(function(p){
    return Object.assign({}, p, {
      hand: deck.splice(0,HAND),
      abilityUsed:false, sweepUsed:false, listenUsed:false, bolt:false,
      setupPeeked:[], out:false, bonus:0
    });
  });
  return Object.assign({}, state, {
    deck:deck, discard:[deck.shift()], players:players, round:roundNo,
    turn:0, seatOrder:0, drawn:null, caboBy:null, finalLeft:null,
    extra:0, phase:'peek', peekIdx:0, modal:null, sel:[], flash:null,
    lastScores:null, pendingEnd:false, emptied:false, hush:null, deckVersion:DECK_VERSION
  });
}

function init(){
  return { phase:'invite', refusals:0, players:[], deck:[], discard:[], turn:0,
           round:0, totals:{}, log:[], drawn:null, caboBy:null, finalLeft:null,
           extra:0, modal:null, sel:[], peekIdx:0, flash:null, lastScores:null, muted:false };
}

/* Giraffes are all but silent. They talk below the range human ears pick up,
   so a whole conversation can happen in a room and nobody hears a thing.
   Hush is that: the Tab still notices something occurred, but records no
   actor and no victims, so it can never be counted at settlement, and the
   briefing can never say who did it. */
function log(state, text, by, to){
  var vic = to==null ? [] : (Object.prototype.toString.call(to)==='[object Array]' ? to : [to]);
  if (state.hush != null && by && state.players[state.hush] && state.players[state.hush].id === by) {
    return [{ r:state.round, t:'Something happened. Nobody heard what.', by:null, to:[], hushed:true }]
           .concat(state.log).slice(0,400);
  }
  return [{ r:state.round, t:text, by:by||null, to:vic }].concat(state.log).slice(0,400);
}
function othersOf(state, seat){
  return state.players.filter(function(p,i){ return i!==seat; }).map(function(p){ return p.id; });
}
function alive(state){ return state.players; }
function nextSeat(state, from){
  return (from + 1) % state.players.length;
}

function reducer(s, a){
  switch(a.type){

  case 'REFUSE': return Object.assign({},s,{ refusals:s.refusals+1 });

  case 'ACCEPT': {
    var line = s.refusals>0
      ? 'The table said no ' + s.refusals + (s.refusals===1?' time':' times') + ' before sitting down.'
      : 'The table sat down without complaining. Suspicious.';
    return Object.assign({},s,{ phase:'lobby', log:[{ r:0, t:line, by:null, to:[] }] });
  }

  case 'SET_PLAYERS': {
    var picked = a.players;
    var totals = {}; picked.forEach(function(p){ totals[p.id]=0; });
    var base = Object.assign({},s,{ players:picked, totals:totals });
    return newRound(base, 1);
  }

  /* ---- setup peek ---- */
  case 'SETUP_TOGGLE': {
    var ps = s.players.slice(), me = Object.assign({}, ps[s.peekIdx]);
    var arr = me.setupPeeked.slice(), i = arr.indexOf(a.idx);
    if(i>=0) arr.splice(i,1); else if(arr.length<2) arr.push(a.idx); else return s;
    me.setupPeeked = arr; ps[s.peekIdx]=me;
    return Object.assign({},s,{ players:ps });
  }
  case 'SETUP_NEXT': {
    var ps2 = s.players.slice(), m2 = Object.assign({}, ps2[s.peekIdx]);
    m2.setupPeeked=[]; ps2[s.peekIdx]=m2;
    var n = s.peekIdx+1;
    if(n >= s.players.length) return Object.assign({},s,{ players:ps2, phase:'curtain', turn:0, peekIdx:0 });
    return Object.assign({},s,{ players:ps2, peekIdx:n });
  }

  case 'LIFT_CURTAIN': return Object.assign({},s,{ phase:'turn' });

  /* ---- turn actions ---- */
  case 'DRAW': {
    if(s.drawn) return s;
    var deck = s.deck.slice();
    if(!deck.length){
      // recycle the discard, keeping its top card in place
      var d2 = s.discard.slice();
      if(d2.length < 2) return Object.assign({},s,{ phase:'score' }); // nothing left to play with
      var top = d2.pop();
      for(var x=d2.length-1;x>0;x--){ var y=Math.floor(Math.random()*(x+1)); var tt=d2[x]; d2[x]=d2[y]; d2[y]=tt; }
      var first = d2.shift();
      return Object.assign({},s,{ deck:d2, discard:[top], drawn:{ card:first, from:'deck' },
        log: log(s, 'Deck ran out. The discard was shuffled back in.') });
    }
    var c = deck.shift();
    return Object.assign({},s,{ deck:deck, drawn:{ card:c, from:'deck' } });
  }
  case 'TAKE_DISCARD': {
    if(s.drawn || !s.discard.length) return s;
    var dd = s.discard.slice(), cc = dd.pop();
    return Object.assign({},s,{ discard:dd, drawn:{ card:cc, from:'discard' } });
  }
  case 'PLACE': {
    if(!s.drawn) return s;
    var pl = s.players.slice(), cur = Object.assign({}, pl[s.turn]);
    var hand = cur.hand.slice();
    var out = hand[a.idx];
    hand[a.idx] = s.drawn.card;
    cur.hand = hand; pl[s.turn]=cur;
    return Object.assign({},s,{
      players:pl, discard:s.discard.concat([out]), drawn:null,
      modal:null, pendingEnd:true
    });
  }
  case 'DISCARD_DRAWN': {
    if(!s.drawn) return s;
    var pw = s.drawn.from==='deck' ? powerOf(s.drawn.card.r) : null;
    var st = Object.assign({},s,{ discard:s.discard.concat([s.drawn.card]), drawn:null });
    if(pw==='peek') return Object.assign({},st,{ modal:{ kind:'choosePeek' } });
    if(pw==='spy')  return Object.assign({},st,{ modal:{ kind:'spyPick' } });
    if(pw==='swap') return Object.assign({},st,{ modal:{ kind:'swapMine' } });
    return Object.assign({},st,{ pendingEnd:true });
  }

  /* ---- powers ---- */
  case 'PEEK_OWN':
    return Object.assign({},s,{ modal:{ kind:'reveal', card:s.players[s.turn].hand[a.idx],
      title:'Your card, slot '+(a.idx+1), sub:'The house does not remember this for you.' }, pendingEnd:true });

  case 'SPY': {
    var tgt = s.players[a.seat];
    if(tgt.id==='deer' && !tgt.abilityUsed){
      var pl3=s.players.slice(); pl3[a.seat]=Object.assign({},tgt,{abilityUsed:true});
      return Object.assign({},s,{ players:pl3, modal:null, pendingEnd:true,
        flash:{ tone:'good', text:tgt.name+' BOLTED it. Nothing happened.' },
        log: log(s, s.players[s.turn].name+' tried to spy on '+tgt.name+'. Bolted.', s.players[s.turn].id, tgt.id) });
    }
    return Object.assign({},s,{
      modal:{ kind:'reveal', card:tgt.hand[a.idx], title:tgt.name+', slot '+(a.idx+1), sub:'Remember it. It will not be shown again.' },
      pendingEnd:true,
      log: log(s, s.players[s.turn].name+' spied on '+tgt.name+'.', s.players[s.turn].id, tgt.id) });
  }
  case 'SWAP_DO': {
    var t2 = s.players[a.seat];
    if(t2.id==='deer' && !t2.abilityUsed){
      var pl4=s.players.slice(); pl4[a.seat]=Object.assign({},t2,{abilityUsed:true});
      return Object.assign({},s,{ players:pl4, modal:null, pendingEnd:true,
        flash:{ tone:'good', text:t2.name+' BOLTED it. Nothing happened.' },
        log: log(s, s.players[s.turn].name+' tried to swap with '+t2.name+'. Bolted.', s.players[s.turn].id, t2.id) });
    }
    var pls = s.players.slice();
    var meC = Object.assign({}, pls[s.turn]), thC = Object.assign({}, t2);
    var mh = meC.hand.slice(), th = thC.hand.slice();
    var tmp = mh[a.mine]; mh[a.mine]=th[a.idx]; th[a.idx]=tmp;
    meC.hand=mh; thC.hand=th; pls[s.turn]=meC; pls[a.seat]=thC;
    return Object.assign({},s,{ players:pls, modal:null, pendingEnd:true,
      flash:{ tone:'', text:'Swapped blind with '+thC.name+'.' },
      log: log(s, meC.name+' swapped a card with '+thC.name+'.', meC.id, thC.id) });
  }
  case 'LISTEN_ANSWER': {
    return Object.assign({},s,{ modal:{ kind:'listenResult', q:a.q, ans:a.ans, who:a.who },
      pendingEnd:true,
      log: log(s, s.players[s.turn].name+' listened in on '+a.who+'.', s.players[s.turn].id, a.toId||null) });
  }

  /* ---- slap / feast ---- */
  case 'SLAP_TOGGLE': {
    var sel=s.sel.slice(), k=sel.indexOf(a.idx);
    if(k>=0) sel.splice(k,1); else sel.push(a.idx);
    return Object.assign({},s,{ sel:sel });
  }
  case 'SLAP_GO': {
    if(!s.sel.length || !s.discard.length) return s;
    /* Match on RANK. All four kings match each other even though a red one
       is -1 and a black one is 13, which is exactly the trap. */
    var topRank = s.discard[s.discard.length-1].r;
    var meP = s.players[s.turn];
    var wrong = s.sel.filter(function(i){ return meP.hand[i].r !== topRank; });
    var pls5 = s.players.slice(), cur5 = Object.assign({}, meP);
    if(wrong.length){
      var deck5 = s.deck.slice();
      var pen = deck5.shift() || { id:'p'+(++uid), r:'K', s:'S' };  // worst card in the deck
      cur5.hand = cur5.hand.concat([pen]);
      pls5[s.turn]=cur5;
      return Object.assign({},s,{
        players:pls5, deck:deck5, sel:[], pendingEnd:true,
        modal:{ kind:'slapBad', n:wrong.length },
        log: log(s, cur5.name+' slapped wrong and took a penalty card.') });
    }
    var keep = cur5.hand.filter(function(_,i){ return s.sel.indexOf(i)<0; });
    var gone = cur5.hand.filter(function(_,i){ return s.sel.indexOf(i)>=0; });
    var n = gone.length;
    cur5.hand = keep;
    if(n>=4) cur5.bonus = (cur5.bonus||0) - 3;
    pls5[s.turn]=cur5;
    var dish = DISH[n];
    var cleared = keep.length===0;
    return Object.assign({},s,{
      players:pls5, discard:s.discard.concat(gone), sel:[], pendingEnd:true, emptied:cleared,
      modal:{ kind:'slapGood', n:n, dish:dish, cleared:cleared },
      log: log(s, cleared
        ? cur5.name+' emptied their hand completely. Round over, and they score nothing.'
        : cur5.name+' dumped '+n+(n===1?' card':' cards')+(dish?', '+dish.n:'')+'.',
        cur5.id, cleared ? othersOf(s, s.turn) : null) });
  }

  /* ---- sweep ---- */
  case 'SWEEP': {
    var pls6 = s.players.slice(), c6 = Object.assign({}, pls6[s.turn], { sweepUsed:true });
    pls6[s.turn]=c6;
    var lost = s.discard.length;
    return Object.assign({},s,{
      players:pls6, discard:[], pendingEnd:true,
      flash:{ tone:'', text:'Swept. '+lost+' card'+(lost===1?'':'s')+' gone. Nobody gets them.' },
      log: log(s, c6.name+' swept the floor. '+lost+' card'+(lost===1?'':'s')+' removed. Everyone lost their match.',
        c6.id, othersOf(s, s.turn)) });
  }

  /* ---- abilities ---- */
  case 'ABILITY': {
    var meA = s.players[s.turn];
    if(meA.abilityUsed) return s;
    if(meA.id==='deer')
      return Object.assign({},s,{ modal:{ kind:'note', title:'Bolt is passive',
        sub:'It fires by itself the next time somebody aims a power at you. Nothing to do now.' } });
    if(meA.id==='rhino'){
      var pr=s.players.slice(); pr[s.turn]=Object.assign({},meA,{abilityUsed:true});
      return Object.assign({},s,{ players:pr, extra:s.extra+1, pendingEnd:false,
        flash:{ tone:'good', text:'CHARGE. You get another action.' },
        log: log(s, meA.name+' charged. Two actions in one turn.') });
    }
    if(meA.id==='snake'){
      var pn=s.players.slice(), sn=Object.assign({},meA,{abilityUsed:true});
      var hh=sn.hand.slice();
      for(var q=hh.length-1;q>0;q--){ var w=Math.floor(Math.random()*(q+1)); var z=hh[q]; hh[q]=hh[w]; hh[w]=z; }
      sn.hand=hh; pn[s.turn]=sn;
      return Object.assign({},s,{ players:pn, pendingEnd:true,
        flash:{ tone:'good', text:'Shed. Your cards moved. Only you know.' },
        log: log(s, sn.name+' shed, every spy on her is now holding wrong information.',
          sn.id, othersOf(s, s.turn)) });
    }
    if(meA.id==='giraffe'){
      var pg2=s.players.slice(); pg2[s.turn]=Object.assign({},meA,{abilityUsed:true});
      return Object.assign({},s,{ players:pg2, hush:s.turn, pendingEnd:false,
        flash:{ tone:'good', text:'Hush. Nothing you do this turn will be written down.' } });
    }
    if(meA.id==='bee')     return Object.assign({},s,{ modal:{ kind:'sting' } });
    return s;
  }
  case 'STING_DONE': {
    var pb=s.players.slice();
    pb[s.turn]=Object.assign({},pb[s.turn],{abilityUsed:true});
    var A=Object.assign({},pb[a.a]), B=Object.assign({},pb[a.b]);
    var ai=Math.floor(Math.random()*A.hand.length), bi=Math.floor(Math.random()*B.hand.length);
    var ah=A.hand.slice(), bh=B.hand.slice();
    var sw=ah[ai]; ah[ai]=bh[bi]; bh[bi]=sw;
    A.hand=ah; B.hand=bh; pb[a.a]=A; pb[a.b]=B;
    return Object.assign({},s,{ players:pb, modal:null, pendingEnd:true,
      flash:{ tone:'bad', text:'STING. '+A.name+' and '+B.name+' just traded a card at random.' },
      log: log(s, pb[s.turn].name+' stung '+A.name+' and '+B.name+', random cards traded. He gained nothing.',
        pb[s.turn].id, [A.id, B.id]) });
  }

  /* ---- cabo ---- */
  case 'CABO': {
    return Object.assign({},s,{
      caboBy:s.turn, finalLeft:s.players.length-1, pendingEnd:true,
      flash:{ tone:'good', text:'CABO! Everyone else gets one last turn.' },
      log: log(s, s.players[s.turn].name+' called Cabo, and nobody was ready.',
        s.players[s.turn].id, othersOf(s, s.turn)) });
  }

  /* ---- end turn ---- */
  case 'END_TURN': {
    if(s.emptied) return Object.assign({},s,{ phase:'score', modal:null, sel:[], pendingEnd:false, drawn:null });
    if(s.extra>0) return Object.assign({},s,{ extra:s.extra-1, pendingEnd:false, modal:null, sel:[] });
    var fl = s.finalLeft;
    if(fl !== null){
      fl = fl - (s.turn===s.caboBy ? 0 : 1);
      if(fl<=0) return Object.assign({},s,{ phase:'score', modal:null, sel:[], pendingEnd:false });
    }
    return Object.assign({},s,{
      turn: nextSeat(s, s.turn), finalLeft:fl, phase:'curtain',
      modal:null, sel:[], pendingEnd:false, flash:null, drawn:null, hush:null });
  }

  case 'CLOSE_MODAL': return Object.assign({},s,{ modal:null });
  case 'CLEAR_FLASH': return Object.assign({},s,{ flash:null });

  /* ---- scoring ---- */
  case 'SCORE': {
    var rows = s.players.map(function(p,i){
      return { id:p.id, name:p.name, emo:p.emo, seat:i,
               raw: p.hand.length===0 ? 0 : sum(p.hand)+(p.bonus||0),
               clean: p.hand.length===0 };
    });
    var low = Math.min.apply(null, rows.map(function(r){ return r.raw; }));
    rows.forEach(function(r){
      if(s.caboBy===r.seat){
        r.called = true;
        r.score = (r.raw<=low) ? 0 : r.raw + CABO_PENALTY;
        r.busted = r.raw>low;
      } else r.score = r.raw;
    });
    var totals = Object.assign({}, s.totals);
    rows.forEach(function(r){ totals[r.id] = (totals[r.id]||0) + r.score; });
    var extra = [];
    var buster = rows.filter(function(r){ return r.busted; })[0];
    if(buster) extra.push(buster.name+' called Cabo and missed. Plus '+CABO_PENALTY+'.');
    return Object.assign({},s,{
      totals:totals, lastScores:rows, phase:'roundEnd',
      log: extra.length ? log(s, extra[0]) : s.log });
  }
  case 'NEXT_ROUND': {
    if(s.round >= ROUNDS) return Object.assign({},s,{ phase:'matchEnd' });
    return newRound(s, s.round+1);
  }
  case 'REMATCH': {
    var t0={}; s.players.forEach(function(p){ t0[p.id]=0; });
    return newRound(Object.assign({},s,{ totals:t0, log:[] }), 1);
  }
  default: return s;
  }
}


function settleTab(s){
  var rows = s.players.map(function(p){ return { p:p, base:(s.totals[p.id]||0) }; });
  var leader = rows.slice().sort(function(a,b){ return a.base-b.base; })[0].p;
  rows.forEach(function(r){
    if(r.p.id===leader.id){ r.owed=0; r.final=r.base; return; }
    r.owed = s.log.filter(function(e){
      return e.by===leader.id && e.to && e.to.indexOf(r.p.id)>=0;
    }).length;
    r.final = r.base - r.owed;
  });
  return { leader:leader, rows:rows.sort(function(a,b){ return a.final-b.final; }) };
}


return {
  ROSTER: ROSTER, HAND: HAND, ROUNDS: ROUNDS, CABO_PENALTY: CABO_PENALTY, DISH: DISH,
  makeDeck: makeDeck, powerOf: powerOf, sum: sum, valueOf: valueOf, isRed: isRed,
  cardLabel: cardLabel, RANKS: RANKS, SUITS: SUITS, SUIT_CHAR: SUIT_CHAR, DECK_VERSION: DECK_VERSION,
  newRound: newRound, init: init, reducer: reducer,
  log: log, othersOf: othersOf, settleTab: settleTab
};
}));

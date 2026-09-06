/* The opening look.
 *
 * You may take it as many times as you like before the round starts. That
 * is a kindness, not a loophole, and the difference between the two is one
 * rule: it has to be the SAME two cards every time.
 *
 * Without that you look at slots 1 and 2, look again at 3 and 4, and know
 * your whole hand before a card is played. So that is what most of this
 * file is about, and it is broken on purpose at the end to prove the check
 * would notice.
 */
const { makeDb }      = require('../lib/db.js');
const { makeService } = require('../lib/service.js');

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('   FAIL:', m); } };
async function throws(fn, status, label){
  try { await fn(); fails++; console.log('   FAIL (no throw):', label); }
  catch(e){ if (status && e.status !== status) { fails++;
    console.log('   FAIL (got ' + e.status + ' want ' + status + '):', label); } }
}

const ROSTER = [
  { animal:'bee', name:'Hrutik' }, { animal:'deer', name:'Sharayu' },
  { animal:'snake', name:'Shivani' }];

async function run(db, label){
  console.log('\n== ' + label + ' ==');
  await db.init();
  const S = makeService(db);
  const room = await S.createRoom({ players: ROSTER });
  const tok = [];
  for (let i = 0; i < 3; i++) tok.push((await S.claimSeat(room.code, i)).token);

  // --- look once
  const first = await S.peek(room.code, tok[0], [0, 2]);
  ok(first.reveal.cards.length === 2, 'the look returns two cards');
  ok(first.lookedAgain === false, 'and knows it is the first one');
  const got = first.reveal.cards.map(c => c.slot).sort().join(',');
  ok(got === '0,2', 'the two you asked for (' + got + ')');
  const ids = first.reveal.cards.map(c => c.id).sort().join(',');

  // --- look again, and again
  const again = await S.peek(room.code, tok[0], [0, 2]);
  ok(again.lookedAgain === true, 'looking again is allowed and says so');
  ok(again.reveal.cards.map(c => c.id).sort().join(',') === ids,
     'and shows the very same cards');
  for (let n = 0; n < 5; n++) await S.peek(room.code, tok[0], [0, 2]);
  const fifth = await S.peek(room.code, tok[0], [0, 2]);
  ok(fifth.reveal.cards.map(c => c.id).sort().join(',') === ids,
     'still the same two after eight looks, because forgetting is the point');

  // --- THE LOOPHOLE: asking for the other two must change nothing
  const sneaky = await S.peek(room.code, tok[0], [1, 3]);
  ok(sneaky.reveal.cards.map(c => c.id).sort().join(',') === ids,
     'asking for the OTHER two returns your original two, not a second pair');
  ok(sneaky.reveal.cards.every(c => c.slot === 0 || c.slot === 2),
     'so no third or fourth card can ever be learned this way');

  // --- the round does not start until everybody says they are done
  let st = await S.getState(room.code, tok[0]);
  ok(st.phase === 'peek', 'looking does not start the round');
  ok(st.peekDone === true, 'your own look is recorded');
  ok(st.readyDone === false, 'and you are not marked ready by looking');

  await throws(() => S.ready(room.code, tok[1]), 409, 'you cannot be ready before you have looked');

  await S.ready(room.code, tok[0]);
  st = await S.getState(room.code, tok[0]);
  ok(st.readyDone === true, 'saying you are ready is recorded');
  ok(st.phase === 'peek', 'and one person being ready does not start it');

  await S.peek(room.code, tok[1], [1, 3]);
  await S.ready(room.code, tok[1]);
  st = await S.getState(room.code, tok[0]);
  ok(st.phase === 'peek', 'two of three ready is still not enough');

  await S.peek(room.code, tok[2], [0, 1]);
  const after = await S.ready(room.code, tok[2]);
  ok(after.phase === 'turn', 'the last one to say so starts the round (' + after.phase + ')');

  // --- and the look is gone for good
  await throws(() => S.peek(room.code, tok[0], [0, 2]), 409,
               'once the round starts you cannot look again');
  await throws(() => S.ready(room.code, tok[0]), 409, 'and there is nothing left to be ready for');

  // --- everybody got their own two, nobody got anybody else's
  const seen = await S.getState(room.code, tok[0]);
  const json = JSON.stringify(seen);
  ok(!/"v":/.test(json.replace(/"discardTop":\{[^}]*\}/, '')),
     'no card value is sitting in the state afterwards');

  await db.close();
}

(async () => {
  await run(makeDb({kind:'memory'}), 'the opening look, on memory');
  if (process.env.DATABASE_URL)
    await run(makeDb({kind:'pg', connectionString: process.env.DATABASE_URL}),
              'the opening look, on postgres');
  else console.log('\n   (skipping postgres, no DATABASE_URL)');
  console.log(fails ? '\n   ' + fails + ' FAILED\n' : '\n   opening look ok\n');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

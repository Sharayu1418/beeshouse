#!/usr/bin/env node
/* What is holding the front door.
 *
 *   node tools/rooms.js                 list every room that has not finished
 *   node tools/rooms.js close ABCD      mark one finished, releasing the door
 *   node tools/rooms.js close-all       finish every unfinished room at once
 *   node tools/rooms.js delete ABCD --yes   erase one room and everything in it

 * close-all is for clearing up after a test run that was pointed at a real
 * database. It does not ask, and it cannot tell a test room from a game five
 * people are in the middle of, so read the list first.
 *
 * There is exactly one group, so "a game is running" is a fact about the
 * whole app: while one room is open the front door sends everybody into it
 * rather than dealing a second. That is the feature, and it means a single
 * stuck room can quietly stop five people playing. This is the way to look
 * at it, which otherwise would not exist.
 *
 * A room nobody has touched in seven days stops blocking by itself, so this
 * is for the impatient case and for clearing rooms a test run left behind.
 */
'use strict';
const { Client } = require('pg');

const DEAD_MS = 7 * 24 * 60 * 60 * 1000;
const conn = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!conn) { console.error('\nNo DATABASE_URL.\n'); process.exit(1); }

const [cmd, arg] = process.argv.slice(2);

function ago(ms) {
  if (ms == null) return 'never';
  const h = ms / 3600000;
  if (h < 1) return Math.round(h * 60) + 'm ago';
  if (h < 48) return h.toFixed(1) + 'h ago';
  return (h / 24).toFixed(1) + ' days ago';
}

(async () => {
  const c = new Client({ connectionString: conn,
    ssl: /localhost|127\.0\.0\.1/.test(conn) ? false : { rejectUnauthorized: false } });
  await c.connect();

  /* Erasing a room, which this app otherwise never does.
   *
   * `moves` is append only, seat requests keep their denials, and every
   * round of every match stays in `scores` precisely so nothing can quietly
   * rewrite what happened. This is the one door out of that, and it exists
   * because sometimes a room was dealt on a build you have since replaced
   * and you would rather start clean than explain the difference to four
   * other people.
   *
   * Closing a room with `close` does everything this does except forget:
   * the door opens, the next Yes deals fresh, and the match stays readable
   * at its own link forever. Prefer it unless you actually want the history
   * gone.
   *
   * The foreign keys cascade, so the players, rounds, moves and scores go
   * with it. --yes is required because there is no undo. */
  if (cmd === 'delete') {
    if (!arg) { console.error('\n  node tools/rooms.js delete ABCD --yes\n'); process.exit(1); }
    const g = (await c.query('select id, code, status from games where upper(code)=upper($1)', [arg])).rows[0];
    if (!g) { console.log('\nNo room with that code.\n'); await c.end(); return; }

    const counts = {};
    for (const t of ['players', 'rounds', 'moves', 'scores']) {
      counts[t] = (await c.query('select count(*)::int as n from ' + t + ' where game_id = $1', [g.id])).rows[0].n;
    }
    const summary = Object.keys(counts).map(function (k) { return counts[k] + ' ' + k; }).join(', ');

    if (!process.argv.includes('--yes')) {
      console.log('\n  ' + g.code + ' (' + g.status + ') holds ' + summary + '.');
      console.log('  Deleting it erases all of that. There is no undo.');
      console.log('\n  If you only want the front door free, this is gentler:');
      console.log('      node tools/rooms.js close ' + g.code);
      console.log('\n  To go ahead:');
      console.log('      node tools/rooms.js delete ' + g.code + ' --yes\n');
      await c.end();
      return;
    }

    await c.query('delete from games where id = $1', [g.id]);
    console.log('\n  ' + g.code + ' is gone, along with ' + summary + '.');
    const open = (await c.query("select count(*)::int as n from games where status <> 'done'")).rows[0].n;
    console.log('  ' + (open === 0 ? 'Nothing is open. The next Yes deals a fresh room.'
                                   : open + ' room(s) still open, run tools/rooms.js') + '\n');
    await c.end();
    return;
  }

  if (cmd === 'close-all') {
    const r = await c.query(
      `update games set status='done', finished_at=now()
        where status <> 'done' returning code`);
    console.log(r.rowCount
      ? '\nClosed ' + r.rowCount + ': ' + r.rows.map(function (x) { return x.code; }).join(', ') +
        '\n\nThe door is free. The next Yes deals a fresh room.\n'
      : '\nNothing was open.\n');
    await c.end();
    return;
  }

  if (cmd === 'close') {
    if (!arg) { console.error('\n  node tools/rooms.js close ABCD\n'); process.exit(1); }
    const r = await c.query(
      `update games set status='done', finished_at=now()
        where upper(code)=upper($1) and status <> 'done' returning code`, [arg]);
    console.log(r.rowCount ? '\nClosed ' + r.rows[0].code + '. The door is free.\n'
                           : '\nNo open room with that code.\n');
    await c.end();
    return;
  }

  const rows = (await c.query(
    `select g.code, g.status, g.created_at, g.season_id, g.match_no,
            (select max(m.created_at) from moves m where m.game_id = g.id) as last_move,
            (select count(*)::int from players p where p.game_id = g.id) as seats,
            (select count(*)::int from players p where p.game_id = g.id and p.token_hash is not null) as claimed
       from games g where g.status <> 'done' order by g.created_at desc`)).rows;

  if (!rows.length) { console.log('\nNothing open. The next Yes deals a fresh room.\n'); await c.end(); return; }

  const now = Date.now();
  console.log('\n' + rows.length + ' room' + (rows.length === 1 ? '' : 's') + ' not finished:\n');
  let blocker = null;
  rows.forEach(function (g) {
    const t = new Date(g.last_move || g.created_at).getTime();
    const dead = (now - t) > DEAD_MS;
    if (!dead && !blocker) blocker = g.code;
    console.log('  ' + g.code + '  ' + g.status.padEnd(8) +
      'dealt ' + ago(now - new Date(g.created_at).getTime()).padEnd(14) +
      'last move ' + ago(g.last_move ? now - new Date(g.last_move).getTime() : null).padEnd(14) +
      g.claimed + '/' + g.seats + ' seats' +
      (g.season_id ? '  season match ' + g.match_no : '') +
      (dead ? '   (dead, not blocking)' : ''));
  });
  console.log('\n' + (blocker
    ? 'The front door sends everybody to ' + blocker + '.\n  Release it with:  node tools/rooms.js close ' + blocker + '\n'
    : 'All of them are dead, so the next Yes deals a fresh room.\n'));
  await c.end();
})().catch(e => { console.error('\nFailed: ' + e.message + '\n'); process.exit(1); });

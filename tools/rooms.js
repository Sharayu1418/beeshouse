#!/usr/bin/env node
/* What is holding the front door.
 *
 *   node tools/rooms.js                 list every room that has not finished
 *   node tools/rooms.js close ABCD      mark one finished, releasing the door
 *   node tools/rooms.js close-all       finish every unfinished room at once

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

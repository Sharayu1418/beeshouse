#!/usr/bin/env node
/* One-shot database setup.
 *
 *   node setup-db.js "postgres://..."
 *   DATABASE_URL="postgres://..." node setup-db.js
 *
 * Applies schema.sql, then verifies the tables exist and that row-level
 * security is actually on. Safe to run more than once — every statement
 * is CREATE TABLE IF NOT EXISTS.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const conn = process.argv[2] || process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!conn) {
  console.error('\nNo connection string.\n\n  node setup-db.js "postgres://..."\n');
  process.exit(1);
}

const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

(async () => {
  const client = new Client({
    connectionString: conn,
    ssl: /localhost|127\.0\.0\.1/.test(conn) ? false : { rejectUnauthorized: false }
  });

  console.log('connecting…');
  await client.connect();

  // Supabase ships anon/authenticated roles; Vercel Postgres and Neon do not,
  // and the REVOKE would abort the whole script. Create them if missing so the
  // same schema.sql works everywhere.
  for (const role of ['anon', 'authenticated']) {
    try { await client.query(`create role ${role} nologin`); console.log('  created role ' + role); }
    catch (e) { if (e.code !== '42710') console.log('  role ' + role + ': ' + e.message); }
  }

  console.log('applying schema…');
  await client.query(sql);

  const tables = await client.query(
    `select tablename from pg_tables where schemaname='public' order by 1`);
  const rls = await client.query(
    `select relname, relrowsecurity from pg_class
      where relname in ('games','players','rounds','moves','scores') order by 1`);
  const policies = await client.query(
    `select count(*)::int as n from pg_policies where schemaname='public'`);

  console.log('\ntables:   ' + tables.rows.map(r => r.tablename).join(', '));
  console.log('RLS on:   ' + rls.rows.map(r => r.relname + '=' + (r.relrowsecurity ? 'yes' : 'NO')).join('  '));
  console.log('policies: ' + policies.rows[0].n + ' (0 is correct — the API is the only reader)');

  const bad = rls.rows.filter(r => !r.relrowsecurity);
  await client.end();

  if (tables.rows.length < 5 || bad.length) {
    console.error('\nSomething is off. Expected 5 tables with RLS enabled.');
    process.exit(1);
  }
  console.log('\nDatabase ready. Now run:  npx vercel --prod\n');
})().catch(e => { console.error('\nFailed: ' + e.message + '\n'); process.exit(1); });

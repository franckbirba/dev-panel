#!/usr/bin/env node
// scripts/migrate.mjs — applique infra/migrations/*.sql dans l'ordre, une fois.
//
// Pourquoi : les tables Postgres (workflow_instances, memories, dev_bots,
// shelly_transcript…) n'étaient créées nulle part par le code — elles avaient
// été appliquées à la main sur la prod. Impossible de monter une stack neuve
// (locale ou de test) sans ce runner. Idempotent : une table `schema_migrations`
// enregistre ce qui a déjà tourné.
//
// usage:
//   node scripts/migrate.mjs            # applique les migrations manquantes
//   node scripts/migrate.mjs --status   # liste appliquées / en attente
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'infra', 'migrations');

const pool = new pg.Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  user: process.env.PG_USER || 'devpanl',
  password: process.env.PG_PASSWORD || 'devpanl',
  database: process.env.PG_DATABASE || 'agent_memory',
});

// Migrations SQLite (appliquées à la master db du worker, pas à Postgres).
// 002 est la version SQLite de workflow_instances (`AUTOINCREMENT`, invalide
// en PG) ; sa version Postgres est 003-orchestration-pg.sql, qui l'a
// remplacée. Le dossier mélange les deux cibles depuis l'origine — on
// enregistre 002 comme "skipped" pour que le runner converge.
const SQLITE_ONLY = new Set(['002-workflow-instances.sql']);

const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

// Les migrations historiques ont été écrites pour être passées à la main dans
// `psql` sur un serveur vierge : elles contiennent des instructions
// server-level (CREATE DATABASE) et des méta-commandes psql (\c) qu'un client
// applicatif ne peut pas exécuter — la connexion cible LA base, elle existe
// déjà. On les retire, et on rend CREATE TABLE/INDEX idempotent pour qu'un
// re-run sur une base partiellement peuplée (cas prod : schéma appliqué à la
// main avant l'existence de ce runner) converge au lieu d'échouer.
function sanitize(sql) {
  return sql
    .split('\n')
    .filter((l) => !/^\s*CREATE\s+DATABASE\b/i.test(l) && !/^\s*\\c\b/.test(l))
    .join('\n')
    .replace(/CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/gi, 'CREATE TABLE IF NOT EXISTS ')
    .replace(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/gi, (_, u) => `CREATE ${u || ''}INDEX IF NOT EXISTS `);
}

async function applied() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  return new Set(rows.map((r) => r.filename));
}

const done = await applied();

if (process.argv.includes('--status')) {
  for (const f of files) console.log(`${done.has(f) ? '✓' : '·'} ${f}`);
  await pool.end();
  process.exit(0);
}

let count = 0;
for (const f of files) {
  if (done.has(f)) continue;
  if (SQLITE_ONLY.has(f)) {
    await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [f]);
    console.log(`− ${f} (SQLite-only, sans objet sur Postgres)`);
    continue;
  }
  const sql = sanitize(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
    await client.query('COMMIT');
    console.log(`✓ ${f}`);
    count++;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // process.exit direct : un pool.end() peut pendre sur une connexion
    // encore occupée et masquer l'erreur (vécu au bootstrap local du 20/08 —
    // le runner sortait sans rien afficher). Le `finally` libère le client.
    console.error(`✗ ${f}: ${err.message}`);
    process.exitCode = 1;
    break;
  } finally {
    client.release();
  }
}
console.log(count ? `${count} migration(s) appliquée(s).` : 'Schéma déjà à jour.');
await pool.end();

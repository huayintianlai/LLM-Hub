#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import { loadEnvFiles } from '../lib/env.mjs';
import { loadGatewayConfig } from '../lib/config-loader.mjs';

loadEnvFiles();
const config = loadGatewayConfig();

const consoleLogger = {
  info: (...args) => console.log('[db:migrate]', ...args),
  warn: (...args) => console.warn('[db:migrate]', ...args),
  error: (...args) => console.error('[db:migrate]', ...args),
};

const migrationsDir = path.resolve(process.cwd(), 'db', 'migrations');
if (!fs.existsSync(migrationsDir)) {
  consoleLogger.warn('no migrations directory found, exiting');
  process.exit(0);
}

const files = fs
  .readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

if (!files.length) {
  consoleLogger.info('no migration files to apply');
  process.exit(0);
}

async function migratePostgres() {
  if (!config.database.url) {
    throw new Error('database.url is required for postgres migrations');
  }
  const pool = new Pool({ connectionString: config.database.url });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id TEXT PRIMARY KEY,
        applied_at BIGINT NOT NULL
      );
    `);

    for (const fileName of files) {
      const migrationId = path.basename(fileName, '.sql');
      const exists = await pool.query('SELECT id FROM migrations WHERE id = $1', [migrationId]);
      if (exists.rowCount) {
        consoleLogger.info('skipping already applied migration', migrationId);
        continue;
      }
      const contents = fs.readFileSync(path.join(migrationsDir, fileName), 'utf8');
      if (!contents.trim()) {
        consoleLogger.warn('empty migration file, skipping', migrationId);
        continue;
      }
      consoleLogger.info('applying migration', migrationId);
      await pool.query('BEGIN');
      await pool.query(contents);
      await pool.query('INSERT INTO migrations (id, applied_at) VALUES ($1, $2)', [migrationId, Date.now()]);
      await pool.query('COMMIT');
    }
  } finally {
    await pool.end();
  }
}

function migrateSqlite() {
  const dbPath = path.resolve(process.cwd(), config.database.path || './data/llmhub.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  for (const fileName of files) {
    const migrationId = path.basename(fileName, '.sql');
    const exists = db
      .prepare('SELECT id FROM migrations WHERE id = ?')
      .get(migrationId);
    if (exists) {
      consoleLogger.info('skipping already applied migration', migrationId);
      continue;
    }
    const contents = fs.readFileSync(path.join(migrationsDir, fileName), 'utf8');
    if (!contents.trim()) {
      consoleLogger.warn('empty migration file, skipping', migrationId);
      continue;
    }
    consoleLogger.info('applying migration', migrationId);
    db.exec(contents);
    db.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)').run(migrationId, Date.now());
  }
}

if (config.database.type === 'postgres') {
  await migratePostgres();
} else {
  migrateSqlite();
}

consoleLogger.info('migrations complete');

import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const PORT = 54330;
let server: EmbeddedPostgres | undefined;
let dir: string | undefined;

export const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

// يشغّل PostgreSQL محليًا مؤقتًا، ويطبق المحاكاة + كل المهاجرات من الصفر على قاعدة قالب.
export default async function setup() {
  dir = mkdtempSync(join(tmpdir(), 'gold-ledger-pg-'));
  server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'local-test-only', port: PORT, persistent: false, onLog: () => {}, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
  await server.initialise();
  await server.start();
  const admin = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', password: 'local-test-only', database: 'postgres' });
  await admin.connect();
  await admin.query('create database gl_template');
  await admin.end();

  const c = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', password: 'local-test-only', database: 'gl_template' });
  await c.connect();
  await c.query(readFileSync(join(process.cwd(), 'tests', 'db', 'supabase_stub.sql'), 'utf8'));
  for (const f of migrationFiles()) {
    await c.query(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  }
  await c.end();
  process.env.GL_PG_PORT = String(PORT);

  return async () => {
    await server?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  };
}

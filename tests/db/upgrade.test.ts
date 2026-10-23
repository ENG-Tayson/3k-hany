import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrationFiles, MIGRATIONS_DIR } from './globalSetup';
import { Db, Ledger } from './helpers';

// T21: نسخة تطوير بها بيانات قبل المهاجرة اللاحقة (20261023000000_review_fixes) ثم تطبيقها والتحقق من بقاء البيانات والنتائج.
const base = { host: 'localhost', port: Number(process.env.GL_PG_PORT ?? 54330), user: 'postgres', password: 'local-test-only' };
let db: Db;
const name = 'gl_up_' + randomUUID().replace(/-/g, '').slice(0, 12);
const all = migrationFiles();
const later = all.filter((f) => f >= '20261023000000');
beforeAll(async () => {
  const a = new pg.Client({ ...base, database: 'postgres' });
  await a.connect(); await a.query(`create database ${name}`); await a.end();
  db = new Db(name, new pg.Pool({ ...base, database: name }));
  await db.admin(readFileSync(join(process.cwd(), 'tests', 'db', 'supabase_stub.sql'), 'utf8'));
  for (const f of all.filter((f) => !later.includes(f))) await db.admin(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
});
afterAll(async () => db?.close());

it('بيانات T05 + حسبة محفوظة + ديون تبقى كما هي بعد المهاجرة اللاحقة', async () => {
  expect(later.length).toBeGreaterThan(0);
  const L = new Ledger(db.session(await db.createUser()));
  await L.setup();
  await L.opening('qat', '2026-10-14', '100000', '0');
  await L.opening('insta', '2026-10-14', '20000');
  await L.buy('2026-10-15', '10', '5000', { p_note: 'قبل الترقية' });
  await L.sell('2026-10-15', '4', '5000');
  await L.insta('2026-10-15', 'in', '30000');
  await L.insta('2026-10-15', 'out', '10000');
  await L.daily('2026-10-15', 'cash', '70000');
  await L.daily('2026-10-15', 'price', '5000');
  await L.saveCalc('2026-10-15');
  const p = (await L.person('هاني')).id;
  await L.debt(p, '2026-10-15', 'sent', '20000');
  const before = { r: await L.report('2026-10-15'), a: await L.s.rpc('list_calc_snapshots', {}), pp: await L.people(), au: await L.s.rpc('list_audit', {}) };
  for (const f of later) await db.admin(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  const r = await L.report('2026-10-15');
  expect({ ...r, snapshots: undefined }).toEqual({ ...before.r, snapshots: undefined });
  expect(r.snapshots.map((s: any) => [s.id, s.d, s.grams, s.stale])).toEqual(before.r.snapshots.map((s: any) => [s.id, s.d, s.grams, s.stale]));
  expect((await L.s.rpc('list_calc_snapshots', {})).rows.map((s: any) => s.grams)).toEqual(before.a.rows.map((s: any) => s.grams));
  expect(await L.people()).toEqual(before.pp);
  expect((await L.s.rpc('list_audit', {})).total).toBe(before.au.total);
  // وبعد الترقية الكتابة تعمل
  await L.insta('2026-10-16', 'in', '1');
  expect((await L.report('2026-10-16')).insta.i).toBe('40001.00');
});

import { afterAll, beforeAll, expect, it } from 'vitest';
import { Db, freshDb } from './helpers';

// المهاجرات لا تغيّر كائنات المنصة الموجودة مسبقًا في public (مثل rls_auto_enable)، وتبقى وظيفتها تعمل.
let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => db?.close());

it('public.rls_auto_enable يبقى بمالكه postgres وصلاحياته الافتراضية ويعمل بعد المهاجرات', async () => {
  const [f] = await db.admin(`select pg_get_userbyid(proowner) owner, proacl::text acl from pg_proc where oid = 'public.rls_auto_enable'::regproc`);
  expect(f.owner).toBe('postgres');
  for (const r of ['anon=X', 'authenticated=X', 'service_role=X', 'postgres=X']) expect(f.acl).toContain(r);
  expect(f.acl).not.toContain('ledger_writer');
  await db.admin('create table public._probe_rls (x int)');
  const [t] = await db.admin(`select relrowsecurity from pg_class where oid = 'public._probe_rls'::regclass`);
  expect(t.relrowsecurity).toBe(true);
  await db.admin('drop table public._probe_rls');
});

it('T21 مهاجرة لاحقة (20261022210200) فوق قاعدة بها بيانات: تصلح rls_auto_enable والبيانات تبقى كما هي', async () => {
  const { readFileSync } = await import('node:fs');
  const { Ledger } = await import('./helpers');
  const L = new Ledger(db.session(await db.createUser()));
  await L.setup();
  await L.opening('qat', '2026-10-14', '100000', '0');
  await L.opening('insta', '2026-10-14', '20000');
  await L.buy('2026-10-15', '10', '5000', { p_note: 'قبل المهاجرة' });
  const before = await L.exportBackup();
  // محاكاة الحالة التي تركتها النسخة الأولى من مهاجرة الدوال على السحابة
  await db.admin(`grant create on schema public to ledger_writer`);
  await db.admin(`alter function public.rls_auto_enable() owner to ledger_writer`);
  await db.admin(`revoke all on function public.rls_auto_enable() from public, anon, authenticated, service_role`);
  await db.admin(`grant execute on function public.rls_auto_enable() to authenticated`);
  await db.admin(`revoke create on schema public from ledger_writer`);
  await db.admin(readFileSync('supabase/migrations/20261022210200_restore_rls_auto_enable.sql', 'utf8'));
  const [f] = await db.admin(`select pg_get_userbyid(proowner) owner, proacl::text acl from pg_proc where oid = 'public.rls_auto_enable'::regproc`);
  expect(f.owner).toBe('postgres');
  for (const r of ['=X/postgres', 'anon=X', 'authenticated=X', 'service_role=X', 'postgres=X']) expect(f.acl).toContain(r);
  const after = await L.exportBackup();
  expect(after.checksum).toBe(before.checksum);
  // إعادة تطبيقها لا تفعل شيئًا
  await db.admin(readFileSync('supabase/migrations/20261022210200_restore_rls_auto_enable.sql', 'utf8'));
  expect((await L.exportBackup()).checksum).toBe(before.checksum);
});

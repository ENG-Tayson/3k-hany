import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db, dec, freshDb, Ledger, RpcError } from './helpers';

let db: Db;
const newLedger = async () => {
  const L = new Ledger(db.session(await db.createUser()));
  await L.setup();
  await L.opening('qat', '2026-01-01', '100', '0');
  await L.opening('insta', '2026-01-01', '0');
  return L;
};
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => db?.close());

async function rejects(p: Promise<unknown>, code?: string) {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(RpcError);
    if (code) expect((e as RpcError).code).toBe(code);
    return e as RpcError;
  }
  throw new Error('expected rejection ' + (code ?? ''));
}
const count = async (table: string, owner: string) =>
  Number((await db.admin(`select count(*)::int n from public.${table} where owner_id = $1`, [owner]))[0].n);

describe('T13/T20 منع التكرار بمعرف الطلب', () => {
  it('نفس request_id مرتين (ضغط مزدوج/رد مفقود) = حركة واحدة؛ محتوى مختلف بنفس المعرف مرفوض', async () => {
    const L = await newLedger();
    const rid = randomUUID();
    const args = { p_request_id: rid, p_entry_date: '2026-01-02', p_entry_type: 'in', p_amount: '50', p_note: 'x' };
    const a = await L.s.rpc('add_insta_entry', args);
    const b = await L.s.rpc('add_insta_entry', args);
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(b.entry.id).toBe(a.entry.id);
    expect(await count('insta_entries', L.s.uid!)).toBe(1);
    await rejects(L.s.rpc('add_insta_entry', { ...args, p_amount: '51' }), 'request_id_reused');
    expect(await count('insta_entries', L.s.uid!)).toBe(1);
    // حركتان متطابقتان مقصودتان بمعرفين مختلفين مسموحتان
    await L.s.rpc('add_insta_entry', { ...args, p_request_id: randomUUID() });
    expect(await count('insta_entries', L.s.uid!)).toBe(2);
    expect(dec((await L.report('2026-01-02')).insta.i)).toBe('100');
  });

  it('طلبان متزامنان بنفس request_id ينتجان حركة واحدة', async () => {
    const L = await newLedger();
    const rid = randomUUID();
    const args = { p_request_id: rid, p_entry_date: '2026-01-02', p_entry_type: 'buy', p_weight: '1', p_unit_price: '10' };
    const res = await Promise.all([L.s.rpc('add_qat_entry', args), L.s.rpc('add_qat_entry', args), L.s.rpc('add_qat_entry', args)]);
    expect(new Set(res.map((r: any) => r.entry.id)).size).toBe(1);
    expect(await count('qat_entries', L.s.uid!)).toBe(1);
  });
});

describe('T14 فشل الحفظ في منتصف العملية', () => {
  it('فشل بعد إدراج الحركة وقبل اكتمال المراجعة: لا حركة ولا مراجعة ولا أثر؛ إعادة المحاولة تنجح مرة واحدة', async () => {
    const L = await newLedger();
    const uid = L.s.uid!;
    const dv0 = (await L.state()).account.data_version;
    await db.admin(`create or replace function public._test_fail_audit() returns trigger language plpgsql as $$
      begin if new.new_data ->> 'note' = 'FAIL_MID' then raise exception 'simulated storage failure'; end if; return new; end $$`);
    await db.admin(`create trigger _test_fail before insert on public.audit_log for each row execute function public._test_fail_audit()`);
    const rid = randomUUID();
    const args = { p_request_id: rid, p_entry_date: '2026-01-03', p_entry_type: 'in', p_amount: '70', p_note: 'FAIL_MID' };
    await rejects(L.s.rpc('add_insta_entry', args));
    expect(await count('insta_entries', uid)).toBe(0);
    expect(await count('save_requests', uid)).toBe(3); // setup + افتتاحيتان فقط
    expect((await L.state()).account.data_version).toBe(dv0);
    expect(dec((await L.report('2026-01-03')).insta.i)).toBe('0');
    await db.admin('drop trigger _test_fail on public.audit_log');
    await db.admin('drop function public._test_fail_audit()');
    const ok = await L.s.rpc('add_insta_entry', args);
    expect(ok.replayed).toBe(false);
    const again = await L.s.rpc('add_insta_entry', args);
    expect(again.replayed).toBe(true);
    expect(await count('insta_entries', uid)).toBe(1);
    expect(dec((await L.report('2026-01-03')).insta.i)).toBe('70');
  });
});

describe('T20 التزامن', () => {
  it('سدادان متزامنان من جلستين لا يتجاوزان الباقي', async () => {
    const L = await newLedger();
    const p = (await L.person('هاني')).id;
    await L.debt(p, '2026-01-01', 'sent', '1000');
    const t1 = await L.s.open();
    const t2 = await L.s.open();
    await t1.rpc('add_debt_entry', { p_request_id: randomUUID(), p_person_id: p, p_entry_date: '2026-01-02', p_entry_type: 'repaid', p_amount: '600' });
    const second = t2.rpc('add_debt_entry', { p_request_id: randomUUID(), p_person_id: p, p_entry_date: '2026-01-02', p_entry_type: 'repaid', p_amount: '600' })
      .then(() => 'ok', (e) => e);
    await new Promise((r) => setTimeout(r, 300)); // الثانية محجوزة على قفل الحساب
    await t1.commit();
    const out = await second;
    await t2.rollback();
    expect(out).toBeInstanceOf(RpcError);
    expect((out as RpcError).code).toBe('overpayment');
    expect(dec((await L.people()).total_outstanding)).toBe('400');
  });

  it('تعديل نفس الحركة من تبويبين بنسخة قديمة: الثاني يحصل على تعارض ولا يضيع الأول', async () => {
    const L = await newLedger();
    const e = await L.buy('2026-01-02', '1', '100');
    const base = { p_id: e.entry.id, p_expected_version: 1, p_entry_date: '2026-01-02', p_entry_type: 'buy', p_unit_price: '100', p_change_reason: 'تصحيح' };
    await L.s.rpc('update_qat_entry', { ...base, p_request_id: randomUUID(), p_weight: '2' });
    await rejects(L.s.rpc('update_qat_entry', { ...base, p_request_id: randomUUID(), p_weight: '3' }), 'conflict');
    expect(dec((await L.report('2026-01-02')).qat.buy_weight)).toBe('2');
    const audit = await L.s.rpc('list_audit', { p_entity: 'qat_entries', p_record_id: e.entry.id });
    const u = audit.rows.find((a: any) => a.action === 'update');
    expect(dec(u.old_data.weight)).toBe('1');
    expect(dec(u.new_data.weight)).toBe('2');
    expect(u.reason).toBe('تصحيح');
  });

  it('حفظ الحسبة ينتظر الكتابة الجارية ولا يجمع Q من لحظة وI من أخرى', async () => {
    const L = await newLedger();
    await L.daily('2026-01-05', 'cash', '0');
    await L.daily('2026-01-05', 'price', '10');
    const t1 = await L.s.open();
    await t1.rpc('add_insta_entry', { p_request_id: randomUUID(), p_entry_date: '2026-01-05', p_entry_type: 'in', p_amount: '30' });
    const save = L.saveCalc('2026-01-05');
    await new Promise((r) => setTimeout(r, 300));
    await t1.commit();
    await save;
    const arch = await L.s.rpc('list_calc_snapshots', {});
    expect(dec(arch.rows[0].i)).toBe('30');
    expect(dec(arch.rows[0].d)).toBe('70');
    expect(arch.rows[0].stale).toBe(false);
  });
});

describe('T19 العزل وRLS (أدوار authenticated/anon حقيقية في PostgreSQL)', () => {
  it('بدون جلسة (anon): لا قراءة ولا تنفيذ ولا كتابة', async () => {
    const A = await newLedger();
    await A.buy('2026-01-02', '1', '1');
    const anon = db.session(null);
    for (const fn of ['get_state', 'export_backup', 'list_qat_entries']) {
      const e = await rejects(anon.rpc(fn));
      expect(e.sqlstate).toBe('42501');
    }
    for (const t of ['qat_entries', 'ledger_accounts', 'audit_log', 'calc_snapshots', 'people', 'debt_entries']) {
      const e = await rejects(anon.sql(`select * from public.${t}`));
      expect(e.sqlstate).toBe('42501');
    }
    const fns = await db.admin(`select p.oid::regprocedure::text sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','ledger_private') and p.prorettype <> 'event_trigger'::regtype and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'))`);
    expect(fns).toEqual([]);
  });

  it('مستخدم A لا يقرأ ولا يعدل ولا يلغي بيانات B حتى بمعرفاتها', async () => {
    const A = await newLedger();
    const B = await newLedger();
    const bq = await B.buy('2026-01-02', '5', '100', { p_note: 'سر B' });
    const bi = await B.insta('2026-01-02', 'in', '10');
    const bp = (await B.person('عميل B')).id;
    await B.debt(bp, '2026-01-02', 'sent', '100');
    await B.daily('2026-01-02', 'cash', '1');
    await B.daily('2026-01-02', 'price', '1');
    await B.saveCalc('2026-01-02');
    const bBackup = await B.exportBackup();

    for (const t of ['qat_entries', 'insta_entries', 'people', 'debt_entries', 'calc_snapshots', 'audit_log', 'daily_values', 'book_openings', 'save_requests', 'ledger_accounts']) {
      const rows = await A.s.sql(`select owner_id from public.${t}`);
      expect(rows.every((r: any) => r.owner_id === A.s.uid)).toBe(true);
      const leak = await A.s.sql(`select count(*)::int n from public.${t} where owner_id = $1`, [B.s.uid]);
      expect(leak[0].n).toBe(0);
    }
    await rejects(A.s.rpc('update_qat_entry', { p_request_id: randomUUID(), p_id: bq.entry.id, p_expected_version: 1,
      p_entry_date: '2026-01-02', p_entry_type: 'buy', p_weight: '1', p_unit_price: '1', p_change_reason: 'x' }), 'not_found');
    await rejects(A.s.rpc('cancel_qat_entry', { p_request_id: randomUUID(), p_id: bq.entry.id, p_expected_version: 1, p_reason: 'x' }), 'not_found');
    await rejects(A.s.rpc('cancel_insta_entry', { p_request_id: randomUUID(), p_id: bi.entry.id, p_expected_version: 1, p_reason: 'x' }), 'not_found');
    await rejects(A.s.rpc('add_debt_entry', { p_request_id: randomUUID(), p_person_id: bp, p_entry_date: '2026-01-03', p_entry_type: 'repaid', p_amount: '1' }), 'not_found');
    await rejects(A.s.rpc('get_person', { p_id: bp }), 'not_found');
    await rejects(A.s.rpc('update_person', { p_request_id: randomUUID(), p_id: bp, p_expected_version: 1, p_name: 'x' }), 'not_found');
    // كتابة مباشرة على الجداول (تزوير owner_id) ممنوعة بالصلاحيات
    const direct = [
      [`insert into public.qat_entries(owner_id, seq, entry_date, entry_type, amount, reason) values ($1, 999, '2026-01-02', 'cash_add', 1, 'x')`, [B.s.uid]],
      [`insert into public.qat_entries(owner_id, seq, entry_date, entry_type, amount, reason) values ($1, 999, '2026-01-02', 'cash_add', 1, 'x')`, [A.s.uid]],
      [`update public.qat_entries set amount = 1`, []],
      [`update public.calc_snapshots set d = 0`, []],
      [`delete from public.audit_log`, []],
      [`delete from public.calc_snapshots`, []],
      [`update public.ledger_accounts set data_version = 1`, []],
      [`insert into public.save_requests(owner_id, request_id, op, params_hash, result) values ($1, gen_random_uuid(), 'x', 'x', '{}')`, [A.s.uid]],
    ] as const;
    for (const [sql, params] of direct) {
      const e = await rejects(A.s.sql(sql, params as unknown as unknown[]));
      expect(e.sqlstate).toBe('42501');
    }
    // تصدير A لا يحتوي شيئًا من B
    const aBackup = JSON.stringify(await A.exportBackup());
    expect(aBackup).not.toContain(B.s.uid);
    expect(aBackup).not.toContain('سر B');
    expect(aBackup).not.toContain(bq.entry.id);
    const bAfter = await B.exportBackup();
    expect(bAfter.checksum).toBe(bBackup.checksum);
    expect(bAfter.data).toEqual(bBackup.data);
  });

  it('سياسات WITH CHECK/USING تقيد دور الكتابة نفسه (دفاع إضافي داخل الدوال)', async () => {
    const A = await newLedger();
    const B = await newLedger();
    await B.buy('2026-01-02', '1', '1');
    const c = await db.pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role ledger_writer');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: A.s.uid, role: 'authenticated' })]);
      await expect(c.query(`insert into public.qat_entries(owner_id, seq, entry_date, entry_type, amount, reason) values ($1, 999, '2026-01-02', 'cash_add', 1, 'x')`, [B.s.uid]))
        .rejects.toThrow(/row-level security/);
      await c.query('rollback');
      await c.query('begin');
      await c.query('set local role ledger_writer');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: A.s.uid, role: 'authenticated' })]);
      const u = await c.query(`update public.qat_entries set note = 'hacked' where owner_id = $1`, [B.s.uid]);
      expect(u.rowCount).toBe(0);
      const d = await c.query(`delete from public.qat_entries where owner_id = $1`, [B.s.uid]);
      expect(d.rowCount).toBe(0);
      // تغيير ملكية صف A إلى B مرفوض (WITH CHECK)
      await A.buy('2026-01-02', '1', '1');
      await expect(c.query(`update public.qat_entries set owner_id = $1 where owner_id = $2`, [B.s.uid, A.s.uid])).rejects.toThrow();
      await c.query('rollback');
      // claims دور anon لا تعطي هوية حتى لو احتوت sub
      await c.query('begin');
      await c.query('set local role ledger_writer');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: A.s.uid, role: 'anon' })]);
      const r = await c.query(`select count(*)::int n from public.qat_entries`);
      expect(r.rows[0].n).toBe(0);
      await c.query('rollback');
    } finally {
      c.release();
    }
  });

  it('كل الجداول RLS مفعلة ومفروضة؛ لا views؛ authenticated له SELECT فقط؛ دوال الكتابة يملكها ledger_writer بـ search_path ثابت', async () => {
    const tabs = await db.admin(`select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'`);
    expect(tabs.length).toBe(11);
    expect(tabs.every((t: any) => t.relrowsecurity && t.relforcerowsecurity)).toBe(true);
    expect(await db.admin(`select * from pg_views where schemaname = 'public'`)).toEqual([]);
    const grants = await db.admin(`select grantee, privilege_type, table_name from information_schema.role_table_grants
      where table_schema = 'public' and grantee in ('anon','authenticated','PUBLIC')`);
    expect(grants.every((g: any) => g.grantee === 'authenticated' && g.privilege_type === 'SELECT')).toBe(true);
    const defs = await db.admin(`select p.proname, pg_get_userbyid(p.proowner) owner, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef and p.prorettype <> 'event_trigger'::regtype`);
    expect(defs.length).toBeGreaterThan(10);
    expect(defs.every((d: any) => d.owner === 'ledger_writer' && String(d.proconfig).includes('search_path=""'))).toBe(true);
    const lw = await db.admin(`select rolbypassrls, rolcanlogin, rolsuper from pg_roles where rolname = 'ledger_writer'`);
    expect(lw[0]).toEqual({ rolbypassrls: false, rolcanlogin: false, rolsuper: false });
  });
});

describe('T21 ضوابط القاعدة', () => {
  it('الدقة numeric تنتقل كنص دون فقد عبر الحدود القصوى', async () => {
    const L = await newLedger();
    const e = await L.buy('2026-01-02', '999999.999999', '9999999999.99');
    // حساب مستقل بالأعداد الصحيحة: 999999999999 ميكروجرام × 999999999999 قرش / 10^6 ثم HALF_UP
    const prod = 999999999999n * 999999999999n; // وحدة 10^-8 جنيه
    const cents = (prod + 500000n) / 1000000n;
    expect(e.entry.amount).toBe(`${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`);
    expect(e.entry.weight).toBe('999999.999999');
    const back = await L.s.sql(`select amount::text a from public.qat_entries where id = $1`, [e.entry.id]);
    expect(back[0].a).toBe(e.entry.amount);
  });

  it('قيد CHECK في الجدول يمنع قيمة لا تساوي الوزن × السعر حتى من مستخدم إداري؛ النسخ المحفوظة وسجل المراجعة غير قابلة للتعديل', async () => {
    const L = await newLedger();
    const e = await L.buy('2026-01-02', '1', '100');
    await expect(db.admin(`update public.qat_entries set amount = 99 where id = $1`, [e.entry.id])).rejects.toThrow(/check/);
    await L.daily('2026-01-02', 'cash', '0');
    await L.daily('2026-01-02', 'price', '10');
    await L.saveCalc('2026-01-02');
    await expect(db.admin(`update public.calc_snapshots set d = 0 where owner_id = $1`, [L.s.uid])).rejects.toThrow(/غير قابل للتعديل/);
    await expect(db.admin(`update public.audit_log set reason = 'x' where owner_id = $1`, [L.s.uid])).rejects.toThrow(/غير قابل للتعديل/);
  });

  it('نوع التاريخ DATE لا يتحرك مع المنطقة الزمنية للجلسة', async () => {
    const L = await newLedger();
    const e = await L.insta('2026-01-31', 'in', '1');
    const c = await db.pool.connect();
    try {
      for (const tz of ['UTC', 'Africa/Cairo', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
        await c.query(`set timezone = '${tz}'`);
        const r = await c.query(`select entry_date::text d from public.insta_entries where id = $1`, [e.entry.id]);
        expect(r.rows[0].d).toBe('2026-01-31');
      }
      await c.query('reset timezone');
    } finally {
      c.release();
    }
  });
});

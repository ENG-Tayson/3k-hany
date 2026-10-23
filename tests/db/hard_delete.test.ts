import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db, dec, freshDb, Ledger, RpcError } from './helpers';

// الحذف النهائي بطلب المالك: يُفرض على الخادم أن الجلسة أُعيدت مصادقتها بكلمة المرور خلال 180 ثانية.
let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => db?.close());

const amrAt = (secondsAgo: number) => ({ amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) - secondsAgo }] });
async function err(p: Promise<unknown>) { try { await p; return null; } catch (e) { return e as RpcError; } }

async function setup() {
  const uid = await db.createUser();
  const L = new Ledger(db.session(uid));                // جلسة قديمة بلا إعادة مصادقة
  const fresh = new Ledger(db.session(uid, amrAt(5)));  // بعد إدخال كلمة المرور الآن
  await L.setup();
  await L.opening('qat', '2026-01-01', '1000', '0');
  await L.opening('insta', '2026-01-01', '0');
  return { uid, L, fresh };
}

describe('الحذف النهائي بكلمة المرور', () => {
  it('بدون إعادة مصادقة أو بمصادقة قديمة يُرفض ولا يُحذف شيء', async () => {
    const { L } = await setup();
    const e = await L.buy('2026-01-02', '1', '100');
    expect((await err(L.s.rpc('delete_qat_entry', { p_request_id: randomUUID(), p_id: e.entry.id, p_expected_version: 1 })))?.code).toBe('reauth_required');
    const stale = new Ledger(db.session(L.s.uid, amrAt(600)));
    expect((await err(stale.s.rpc('delete_qat_entry', { p_request_id: randomUUID(), p_id: e.entry.id, p_expected_version: 1 })))?.code).toBe('reauth_required');
    const otp = new Ledger(db.session(L.s.uid, { amr: [{ method: 'otp', timestamp: Math.floor(Date.now() / 1000) }] }));
    expect((await err(otp.s.rpc('delete_qat_entry', { p_request_id: randomUUID(), p_id: e.entry.id, p_expected_version: 1 })))?.code).toBe('reauth_required');
    expect((await L.s.rpc('list_qat_entries', {})).rows).toHaveLength(1);
  });

  it('بعد كلمة المرور: تُحذف القطعية نهائيًا، يتغير الرصيد، يبقى أثر في السجل، والحسبة المحفوظة تُعلَّم', async () => {
    const { L, fresh } = await setup();
    const keep = await L.buy('2026-01-02', '1', '100');
    const gone = await L.buy('2026-01-02', '2', '100');
    await L.daily('2026-01-02', 'cash', '0');
    await L.daily('2026-01-02', 'price', '100');
    await L.saveCalc('2026-01-02');
    expect(dec((await L.report('2026-01-02')).qat.q)).toBe('1300');
    const rid = randomUUID();
    const r = await fresh.s.rpc('delete_qat_entry', { p_request_id: rid, p_id: gone.entry.id, p_expected_version: 1 });
    expect(r.ok).toBe(true);
    // رد مفقود ثم إعادة بنفس المعرّف: لا خطأ ولا حذف مزدوج
    expect((await fresh.s.rpc('delete_qat_entry', { p_request_id: rid, p_id: gone.entry.id, p_expected_version: 1 })).replayed).toBe(true);
    const rep = await L.report('2026-01-02');
    expect(dec(rep.qat.q)).toBe('1100');
    expect(rep.snapshots[0].stale).toBe(true);
    const rows = await L.s.sql('select id from public.qat_entries');
    expect(rows.map((x: any) => x.id)).toEqual([keep.entry.id]);
    const a = await L.s.rpc('list_audit', { p_entity: 'qat_entries', p_record_id: gone.entry.id });
    const del = a.rows.find((x: any) => x.action === 'delete');
    expect(dec(del.old_data.weight)).toBe('2');
    expect(del.new_data).toBeNull();
    // حذفه مرة أخرى بمعرّف جديد: غير موجود
    expect((await err(fresh.s.rpc('delete_qat_entry', { p_request_id: randomUUID(), p_id: gone.entry.id, p_expected_version: 1 })))?.code).toBe('not_found');
  });

  it('إنستا: الحذف بنسخة قديمة يعطي تعارضًا؛ والحركة الملغاة يمكن حذفها', async () => {
    const { L, fresh } = await setup();
    const i = await L.insta('2026-01-02', 'in', '50');
    await L.s.rpc('update_insta_entry', { p_request_id: randomUUID(), p_id: i.entry.id, p_expected_version: 1, p_entry_date: '2026-01-02',
      p_entry_type: 'in', p_amount: '50', p_note: 'ملاحظة' });
    expect((await err(fresh.s.rpc('delete_insta_entry', { p_request_id: randomUUID(), p_id: i.entry.id, p_expected_version: 1 })))?.code).toBe('conflict');
    await L.s.rpc('cancel_insta_entry', { p_request_id: randomUUID(), p_id: i.entry.id, p_expected_version: 2, p_reason: 'خطأ' });
    await fresh.s.rpc('delete_insta_entry', { p_request_id: randomUUID(), p_id: i.entry.id, p_expected_version: 3 });
    expect((await L.s.rpc('list_insta_entries', {})).rows).toHaveLength(0);
  });

  it('الباقي على الناس: حذف «بعت له» عليه سداد يُرفض بالكامل؛ حذف السداد مسموح', async () => {
    const { L, fresh } = await setup();
    const p = (await L.person('هاني')).id;
    const sent = await L.debt(p, '2026-01-01', 'sent', '100');
    const paid = await L.debt(p, '2026-01-02', 'repaid', '40');
    expect((await err(fresh.s.rpc('delete_debt_entry', { p_request_id: randomUUID(), p_id: sent.entry.id, p_expected_version: 1 })))?.code).toBe('overpayment');
    expect(dec((await L.s.rpc('get_person', { p_id: p })).remaining)).toBe('60');
    await fresh.s.rpc('delete_debt_entry', { p_request_id: randomUUID(), p_id: paid.entry.id, p_expected_version: 1 });
    expect(dec((await L.s.rpc('get_person', { p_id: p })).remaining)).toBe('100');
  });

  it('مستخدم آخر بكلمة مرور حديثة لا يحذف حركة غيره، وبدون جلسة لا تنفيذ', async () => {
    const { L } = await setup();
    const e = await L.buy('2026-01-02', '1', '100');
    const other = new Ledger(db.session(await db.createUser(), amrAt(1)));
    await other.setup();
    expect((await err(other.s.rpc('delete_qat_entry', { p_request_id: randomUUID(), p_id: e.entry.id, p_expected_version: 1 })))?.code).toBe('not_found');
    const anon = db.session(null, amrAt(1));
    expect((await err(anon.rpc('delete_qat_entry', { p_request_id: randomUUID(), p_id: e.entry.id, p_expected_version: 1 })))?.sqlstate).toBe('42501');
    expect((await L.s.rpc('list_qat_entries', {})).rows).toHaveLength(1);
  });
});

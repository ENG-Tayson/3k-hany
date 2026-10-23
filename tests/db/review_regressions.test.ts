import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db, dec, freshDb, Ledger, RpcError } from './helpers';

// اختبارات رجوع لنتائج المراجعة المستقلة (REVIEW_REPORT.md). كل اختبار كان يفشل قبل الإصلاح.
let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db?.close(); });

async function newLedger() {
  const L = new Ledger(db.session(await db.createUser()));
  await L.setup();
  return L;
}
async function err(p: Promise<unknown>): Promise<RpcError | null> {
  try { await p; return null; } catch (e) { return e as RpcError; }
}
const recheck = async (file: any) => { file.checksum = (await db.admin('select md5($1::jsonb::text) m', [JSON.stringify(file.data)]))[0].m; return file; };

describe('R2–R7 إصلاحات المراجعة', () => {
  it('R2 نسخة الحسبة المحفوظة في حسبة اليوم تحمل علم «أقل من 0.000001» و«تقريبي»', async () => {
    const L = await newLedger();
    await L.opening('qat', '2026-01-01', '0.01', '0');
    await L.opening('insta', '2026-01-01', '0');
    await L.daily('2026-01-01', 'cash', '0');
    await L.daily('2026-01-01', 'price', '100000');
    await L.saveCalc('2026-01-01');
    const s = (await L.report('2026-01-01')).snapshots[0];
    expect(s.grams_below_min).toBe(true);
    expect(s.grams_approx).toBe(true);
    expect(s.decision).toBe('sell');
  });

  it('R3 قيم قصوى مقبولة لا تكسر حسبة اليوم ولا الحفظ ولا الأرشيف', async () => {
    const L = await newLedger();
    await L.opening('qat', '2026-01-01', '999999999999.99', '0');
    await L.opening('insta', '2026-01-01', '-999999999999.99');
    await L.daily('2026-01-01', 'cash', '0');
    await L.daily('2026-01-01', 'price', '0.01');
    const r = await L.report('2026-01-01');
    // D = 999999999999.99 + 999999999999.99 = 1999999999999.98 ؛ ÷ 0.01 = 199999999999998
    expect(dec(r.result.d)).toBe('1999999999999.98');
    expect(dec(r.result.grams)).toBe('199999999999998');
    await L.saveCalc('2026-01-01');
    const a = await L.s.rpc('list_calc_snapshots', {});
    expect(dec(a.rows[0].grams)).toBe('199999999999998');
  });

  it('R4 استعادة ملف بحسبة محفوظة متناقضة (قرار/جرامات لا تطابق D) تُرفض ولا يتغير شيء؛ سجل الملف يُوسم مستوردًا', async () => {
    const L = await newLedger();
    await L.opening('qat', '2026-01-01', '1000', '0');
    await L.opening('insta', '2026-01-01', '0');
    await L.daily('2026-01-01', 'cash', '0');
    await L.daily('2026-01-01', 'price', '100');
    await L.saveCalc('2026-01-01');
    const orig = JSON.parse(JSON.stringify(await L.exportBackup()));
    const v = Number((await L.state()).account.data_version);
    for (const forge of [(s: any) => { s.decision = 'buy'; }, (s: any) => { s.grams = '999.000000'; }, (s: any) => { s.grams_below_min = true; }, (s: any) => { s.d = '1'; s.a = '999'; s.c = '999'; }]) {
      const f = structuredClone(orig);
      forge(f.data.calc_snapshots[0]);
      await recheck(f);
      const e = await err(L.s.rpc('restore_backup', { p_request_id: L.rid(), p_expected_data_version: v, p_file: f }));
      expect(e?.code).toBe('invalid_backup');
    }
    expect((await L.exportBackup()).checksum).toBe(orig.checksum);
    // سجل مضاف في الملف يُستعاد موسومًا imported=true (يُعرض «مستورد من نسخة»)
    const f = structuredClone(orig);
    f.data.audit_log.push({ id: randomUUID(), at: '2025-01-01T00:00:00Z', entity: 'qat_entries', record_id: 'fake', action: 'update',
      old_data: { amount: '1' }, new_data: { amount: '2' }, reason: 'من الملف', request_id: null });
    await recheck(f);
    await L.s.rpc('restore_backup', { p_request_id: L.rid(), p_expected_data_version: v, p_file: f });
    const rows = await L.s.sql(`select imported from public.audit_log where record_id = 'fake'`);
    expect(rows).toEqual([{ imported: true }]);
    const own = await L.s.sql(`select count(*)::int n from public.audit_log where imported = false and action <> 'restore'`);
    expect(own[0].n).toBeGreaterThan(0); // السجل الأصلي للحساب باق وغير موسوم
  });

  it('R5 الاستعادة لا تمحو سجل المراجعة الحالي، والنسخة السابقة قابلة للتنزيل', async () => {
    const L = await newLedger();
    await L.opening('qat', '2026-01-01', '1000', '0');
    const file = JSON.parse(JSON.stringify(await L.exportBackup()));
    const e = await L.adjust('2026-01-02', 'cash_add', '5', 'بعد التصدير');
    const v = Number((await L.state()).account.data_version);
    await L.s.rpc('restore_backup', { p_request_id: L.rid(), p_expected_data_version: v, p_file: file });
    const after = await L.s.rpc('list_audit', { p_record_id: e.entry.id });
    expect(after.rows.length).toBe(1);
    expect((await L.s.rpc('list_qat_entries', {})).rows).toHaveLength(0); // البيانات استُبدلت فعلًا
    const ev = await L.s.rpc('list_restore_events');
    const prev = await L.s.rpc('get_restore_backup', { p_id: ev[0].id });
    expect(prev.data.qat_entries.map((x: any) => x.id)).toEqual([e.entry.id]);
    // استعادة نفس الملف مرتين لا تكرر سجل المراجعة
    const n1 = (await L.s.rpc('list_audit', {})).total;
    const v2 = Number((await L.state()).account.data_version);
    await L.s.rpc('restore_backup', { p_request_id: L.rid(), p_expected_data_version: v2, p_file: file });
    expect(Number((await L.s.rpc('list_audit', {})).total)).toBe(Number(n1) + 1); // فقط سجل الاستعادة الجديد
    // شخص آخر لا يستطيع تنزيل نسخة سابقة لغيره
    const B = await newLedger();
    expect((await err(B.s.rpc('get_restore_backup', { p_id: ev[0].id })))?.code).toBe('not_found');
  });

  it('R6 طلب رده مفقود ثم استعادة: إعادة نفس الطلب لا تعطي «تم الحفظ» كاذبًا', async () => {
    const L = await newLedger();
    await L.opening('qat', '2026-01-01', '1000', '0');
    const file = JSON.parse(JSON.stringify(await L.exportBackup()));
    const args = { p_request_id: randomUUID(), p_entry_date: '2026-01-02', p_entry_type: 'cash_add', p_amount: '7', p_reason: 'r' };
    await L.s.rpc('add_qat_entry', args);
    const v = Number((await L.state()).account.data_version);
    await L.s.rpc('restore_backup', { p_request_id: L.rid(), p_expected_data_version: v, p_file: file });
    expect((await err(L.s.rpc('add_qat_entry', args)))?.code).toBe('request_superseded');
    // الطلبات الجديدة وإعادة طلب الاستعادة نفسه تعمل
    const rr = randomUUID();
    const v2 = Number((await L.state()).account.data_version);
    await L.s.rpc('restore_backup', { p_request_id: rr, p_expected_data_version: v2, p_file: file });
    expect((await L.s.rpc('restore_backup', { p_request_id: rr, p_expected_data_version: v2, p_file: file })).replayed).toBe(true);
    const n = await L.adjust('2026-01-02', 'cash_add', '7', 'جديد');
    expect(n.ok).toBe(true);
  });
});

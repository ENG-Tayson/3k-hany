import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db, dec, freshDb, Ledger, RpcError } from './helpers';

// T15 + T22: التصدير والاستعادة. الاستعادة تتم في قاعدة اختبار جديدة منفصلة.
let src: Db;
let dst: Db;
let A: Ledger;
let backup: any;
const DATES = ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];

async function rejects(p: Promise<unknown>, code?: string) {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(RpcError);
    if (code) expect((e as RpcError).code).toBe(code);
    return e as RpcError;
  }
  throw new Error('expected rejection ' + (code ?? ''));
}

async function buildT05(L: Ledger) {
  await L.setup();
  await L.opening('qat', '2026-10-14', '100000', '0');
  await L.opening('insta', '2026-10-14', '20000');
  await L.buy('2026-10-15', '10', '5000', { p_trader_name: 'الحاج علي', p_note: 'دفعة <أولى>' });
  await L.sell('2026-10-15', '4', '5000', { p_trader_name: 'الحاج علي' });
  await L.insta('2026-10-15', 'in', '30000', { p_person_name: 'أحمد' });
  await L.insta('2026-10-15', 'out', '10000', { p_person_name: 'سعيد', p_note: 'تم السداد', p_marked_paid: true });
  await L.daily('2026-10-15', 'cash', '70000');
  await L.daily('2026-10-15', 'price', '5000');
  await L.saveCalc('2026-10-15');
  const late = await L.insta('2026-10-15', 'in', '1000', { p_note: 'متأخرة' });
  await L.saveCalc('2026-10-15');
  await L.s.rpc('cancel_insta_entry', { p_request_id: L.rid(), p_id: late.entry.id, p_expected_version: 1, p_reason: 'خطأ' });
  const s16 = await L.sell('2026-10-16', '5', '5000');
  await L.s.rpc('update_qat_entry', { p_request_id: L.rid(), p_id: s16.entry.id, p_expected_version: 1, p_entry_date: '2026-10-16',
    p_entry_type: 'sell', p_weight: '6', p_unit_price: '5000', p_change_reason: 'الوزن الصحيح 6' });
  await L.insta('2026-10-16', 'in', '5000');
  await L.insta('2026-10-16', 'out', '15000');
  await L.daily('2026-10-16', 'cash', '90000');
  await L.daily('2026-10-16', 'price', '5000');
  await L.daily('2026-10-17', 'cash', '70000');
  await L.daily('2026-10-17', 'price', '6000');
  await L.saveCalc('2026-10-17');
  await L.adjust('2026-10-17', 'cash_add', '0.01', 'قرش');
  const ids: Record<string, string> = {};
  for (const n of ['ريمون', 'محمود', 'هاني']) ids[n] = (await L.person(n)).id;
  await L.debt(ids['ريمون'], '2026-10-15', 'sent', '1000');
  await L.debt(ids['محمود'], '2026-10-15', 'sent', '5000', 'سلفة');
  await L.debt(ids['هاني'], '2026-10-15', 'sent', '20000');
  await L.debt(ids['هاني'], '2026-10-16', 'repaid', '5000');
  await L.debt(ids['ريمون'], '2026-10-17', 'repaid', '1000');
}

async function fullView(L: Ledger) {
  const out: any = { reports: {}, archive: null, people: null, peoplePast: null, qat: null, insta: null };
  for (const d of DATES) {
    const r = await L.report(d);
    delete r.snapshots; delete r.data_version;
    out.reports[d] = r;
  }
  out.archive = (await L.s.rpc('list_calc_snapshots', {})).rows;
  out.people = await L.people();
  out.peoplePast = await L.people('2026-10-16');
  out.qat = await L.s.rpc('list_qat_entries', { p_order: 'asc', p_limit: 500 });
  out.insta = await L.s.rpc('list_insta_entries', { p_order: 'asc', p_limit: 500 });
  return out;
}

async function recheck(db: Db, file: any) {
  file.checksum = (await db.admin('select md5($1::jsonb::text) m', [JSON.stringify(file.data)]))[0].m;
  return file;
}

beforeAll(async () => {
  src = await freshDb();
  dst = await freshDb();
  A = new Ledger(src.session(await src.createUser('a@test.local')));
  await buildT05(A);
  backup = JSON.parse(JSON.stringify(await A.exportBackup())); // كما ينزل في المتصفح
});
afterAll(async () => { await src?.close(); await dst?.close(); });

describe('T15 النسخ والاستعادة', () => {
  it('التصدير يشمل كل الكيانات، بلا أسرار ولا هوية المالك', async () => {
    expect(backup.format).toBe('gold-ledger-backup');
    expect(backup.schema_version).toBe(1);
    expect(backup.counts).toMatchObject({ qat_entries: 4, insta_entries: 5, daily_values: 3, calc_snapshots: 3, people: 3, debt_entries: 5 });
    expect(backup.data.book_openings).toHaveLength(2);
    expect(backup.data.audit_log.length).toBeGreaterThan(20);
    const text = JSON.stringify(backup);
    expect(text).not.toContain(A.s.uid);
    expect(text).not.toMatch(/password|access_token|refresh_token|service_role|sb_secret|apikey/i);
    expect(text).not.toContain('a@test.local');
    // لا أرقام JSON كسرية يمكن أن يغيرها المتصفح
    const floats: string[] = [];
    JSON.stringify(backup, (_k, v) => { if (typeof v === 'number' && !Number.isInteger(v)) floats.push(String(v)); return v; });
    expect(floats).toEqual([]);
  });

  it('الاستعادة في قاعدة جديدة تعطي نفس السجلات والنسخ وكل النتائج الرقمية', async () => {
    const before = await fullView(A);
    const R = new Ledger(dst.session(await dst.createUser()));
    const st = await R.state();
    expect(st.account).toBeNull();
    const res = await R.s.rpc('restore_backup', { p_request_id: randomUUID(), p_expected_data_version: 0, p_file: backup });
    expect(res.ok).toBe(true);
    const after = await fullView(R);
    expect(after).toEqual(before);
    // نفس المعرفات والأسماء والملاحظات
    const exp2 = await R.exportBackup();
    for (const k of ['book_openings', 'qat_entries', 'insta_entries', 'daily_values', 'calc_snapshots', 'people', 'debt_entries']) {
      expect(exp2.data[k]).toEqual(backup.data[k]);
    }
    // سجل المراجعة الأصلي محفوظ + أثر الاستعادة
    expect(exp2.data.audit_log.length).toBe(backup.data.audit_log.length + 1);
    expect(exp2.data.audit_log.at(-1).action).toBe('restore');
    // الحسبات المحفوظة كما هي: الأولى 4 جرام وتنبيه تعديل
    const arch = after.archive.filter((x: any) => x.calc_date === '2026-10-15');
    expect(arch.map((x: any) => dec(x.grams)).sort()).toEqual(['3.8', '4']);
    expect(dec(after.reports['2026-10-16'].result.d)).toBe('-20000');
    expect(dec(after.people.total_outstanding)).toBe('20000');
    // الحركة الجديدة بعد الاستعادة تأخذ ترتيبًا بعد الحركات المستعادة
    const n = await R.buy('2026-10-15', '1', '1');
    expect(BigInt(n.entry.seq)).toBeGreaterThan(BigInt(backup.data.qat_entries.at(-1).seq));
  });

  it('استعادة نفس الملف مرتين لا تضاعف شيئًا (الاستبدال لا الدمج)', async () => {
    const R = new Ledger(dst.session(await dst.createUser()));
    await R.s.rpc('restore_backup', { p_request_id: randomUUID(), p_expected_data_version: 0, p_file: backup });
    const v = (await R.state()).account.data_version;
    await R.s.rpc('restore_backup', { p_request_id: randomUUID(), p_expected_data_version: Number(v), p_file: backup });
    const e = await R.exportBackup();
    expect(e.counts.qat_entries).toBe(4);
    expect(e.counts.debt_entries).toBe(5);
    expect(dec((await R.report('2026-10-17')).qat.q)).toBe('100000.01');
    const events = await R.s.rpc('list_restore_events');
    expect(events).toHaveLength(2);
    // إعادة إرسال نفس طلب الاستعادة (رد مفقود) لا يعيد التنفيذ
    const rid = randomUUID();
    const v2 = Number((await R.state()).account.data_version);
    await R.s.rpc('restore_backup', { p_request_id: rid, p_expected_data_version: v2, p_file: backup });
    const again = await R.s.rpc('restore_backup', { p_request_id: rid, p_expected_data_version: v2, p_file: backup });
    expect(again.replayed).toBe(true);
    expect(await R.s.rpc('list_restore_events')).toHaveLength(3);
  });

  it('ملف تالف/إصدار غير مدعوم/ناقص/قيمة غير صالحة: يُرفض والبيانات الحالية لا تتغير', async () => {
    const R = new Ledger(dst.session(await dst.createUser()));
    await R.s.rpc('restore_backup', { p_request_id: randomUUID(), p_expected_data_version: 0, p_file: backup });
    const snap = async () => { const e = await R.exportBackup(); return { checksum: e.checksum, dv: e.data_version }; };
    const before = await snap();
    const v = Number(before.dv);
    const bad1 = structuredClone(backup); bad1.data.qat_entries[0].amount = '1.00';           // تعديل بدون تحديث البصمة
    await rejects(R.s.rpc('restore_backup', { p_request_id: randomUUID(), p_expected_data_version: v, p_file: bad1 }), 'checksum_mismatch');
    const bad2 = structuredClone(backup); bad2.schema_version = 2;
    await rejects(R.s.rpc('restore_backup', { p_request_id: randomUUID(), p_expected_data_version: v, p_file: bad2 }), 'unsupported_version');
    const bad3 = structuredClone(backup); delete bad3.data.people; await recheck(dst, bad3);
    await rejects(R.s.rpc('restore_backup', { p_request_id: randomUUID(), p_expected_data_version: v, p_file: bad3 }), 'invalid_backup');
    const bad4 = structuredClone(backup); bad4.data.insta_entries[0].amount = '10.001'; await recheck(dst, bad4);
    await rejects(R.s.rpc('restore_backup', { p_request_id: randomUUID(), p_expected_data_version: v, p_file: bad4 }), 'invalid_backup');
    const bad5 = { hello: 'world' };
    await rejects(R.s.rpc('restore_backup', { p_request_id: randomUUID(), p_expected_data_version: v, p_file: bad5 }), 'invalid_backup');
    // فشل جزئي في المرحلة الأخيرة (سداد غير مغطى في نهاية الملف) يلغي الاستبدال كله
    const bad6 = structuredClone(backup);
    bad6.data.debt_entries.push({ ...bad6.data.debt_entries[0], id: randomUUID(), seq: '9999', entry_type: 'repaid', amount: '999999' });
    await recheck(dst, bad6);
    await rejects(R.s.rpc('restore_backup', { p_request_id: randomUUID(), p_expected_data_version: v, p_file: bad6 }), 'restore_failed');
    // قطعية قبل بداية الدفتر
    const bad7 = structuredClone(backup); bad7.data.qat_entries[0].entry_date = '2026-10-01'; await recheck(dst, bad7);
    await rejects(R.s.rpc('restore_backup', { p_request_id: randomUUID(), p_expected_data_version: v, p_file: bad7 }), 'restore_failed');
    // قيمة لا تساوي الوزن × السعر
    const bad8 = structuredClone(backup); bad8.data.qat_entries[0].amount = '1.00'; await recheck(dst, bad8);
    await rejects(R.s.rpc('restore_backup', { p_request_id: randomUUID(), p_expected_data_version: v, p_file: bad8 }), 'restore_failed');
    expect(await snap()).toEqual(before);
    expect(await R.s.rpc('list_restore_events')).toHaveLength(1);
  });
});

describe('T22 الاستعادة مع Supabase (عزل، تزوير مالك، تعارض، اتساق اللقطة)', () => {
  it('ملف يزوّر owner_id لا ينقل بيانات لحساب آخر، وبيانات B لا تتغير', async () => {
    const R = new Ledger(dst.session(await dst.createUser()));
    const B = new Ledger(dst.session(await dst.createUser()));
    await B.setup();
    await B.opening('insta', '2026-01-01', '5');
    const bBefore = await B.exportBackup();
    const forged = structuredClone(backup);
    for (const k of ['qat_entries', 'insta_entries', 'people', 'debt_entries', 'calc_snapshots', 'audit_log', 'daily_values', 'book_openings']) {
      for (const row of forged.data[k]) row.owner_id = B.s.uid;
    }
    forged.data.account.owner_id = B.s.uid;
    forged.owner_id = B.s.uid;
    await recheck(dst, forged);
    await R.s.rpc('restore_backup', { p_request_id: randomUUID(), p_expected_data_version: 0, p_file: forged });
    const bAfter = await B.exportBackup();
    expect(bAfter.checksum).toBe(bBefore.checksum);
    const owners = await dst.admin(`select distinct owner_id from public.qat_entries where id = any($1::uuid[])`, [backup.data.qat_entries.map((x: any) => x.id)]);
    expect(owners.some((o: any) => o.owner_id === R.s.uid)).toBe(true);
    expect(owners.some((o: any) => o.owner_id === B.s.uid)).toBe(false);
    expect((await R.exportBackup()).counts.qat_entries).toBe(4);
    // B يستطيع استعادة نسخة A في حسابه دون المساس بحساب A (نفس المعرفات لا تتعارض)
    const aBefore = await A.exportBackup();
    const B2 = new Ledger(src.session(await src.createUser()));
    await B2.s.rpc('restore_backup', { p_request_id: randomUUID(), p_expected_data_version: 0, p_file: backup });
    expect((await A.exportBackup()).checksum).toBe(aBefore.checksum);
    expect((await B2.exportBackup()).counts).toEqual({ ...aBefore.counts, audit_log: aBefore.counts.audit_log + 1 });
  });

  it('حركة سجلتها جلسة أخرى بعد تجهيز الاستعادة: الاستعادة القديمة تُرفض ولا تضيع الحركة', async () => {
    const R = new Ledger(dst.session(await dst.createUser()));
    await R.s.rpc('restore_backup', { p_request_id: randomUUID(), p_expected_data_version: 0, p_file: backup });
    const prepared = Number((await R.state()).account.data_version);   // المستخدم راجع المعاينة عند هذه النسخة
    const other = new Ledger(dst.session(R.s.uid));                    // تبويب/جهاز آخر
    const added = await other.insta('2026-10-18', 'in', '777', { p_note: 'حركة متزامنة' });
    await rejects(R.s.rpc('restore_backup', { p_request_id: randomUUID(), p_expected_data_version: prepared, p_file: backup }), 'conflict');
    const l = await R.s.rpc('list_insta_entries', { p_search: 'حركة متزامنة' });
    expect(l.rows.map((x: any) => x.id)).toEqual([added.entry.id]);
  });

  it('استعادة أثناء كتابة جارية تنتظر القفل ثم ترفض لأن الحالة تغيرت', async () => {
    const R = new Ledger(dst.session(await dst.createUser()));
    await R.s.rpc('restore_backup', { p_request_id: randomUUID(), p_expected_data_version: 0, p_file: backup });
    const prepared = Number((await R.state()).account.data_version);
    const tx = await R.s.open();
    await tx.rpc('add_insta_entry', { p_request_id: randomUUID(), p_entry_date: '2026-10-18', p_entry_type: 'in', p_amount: '1' });
    const restore = R.s.rpc('restore_backup', { p_request_id: randomUUID(), p_expected_data_version: prepared, p_file: backup }).then(() => 'ok', (e) => e);
    await new Promise((r) => setTimeout(r, 300));
    await tx.commit();
    const out = await restore;
    expect((out as RpcError).code).toBe('conflict');
    expect((await R.exportBackup()).counts.insta_entries).toBe(6);
  });

  it('التصدير أثناء كتابات متزامنة لقطة متسقة (كل حركة معها سجل مراجعتها، والعدادات تطابق)', async () => {
    const W = new Ledger(src.session(await src.createUser()));
    await W.setup();
    await W.opening('insta', '2026-01-01', '0');
    await W.opening('qat', '2026-01-01', '0', '0');
    let stop = false;
    const writers = [0, 1, 2].map(async (k) => {
      let n = 0;
      while (!stop && n < 60) {
        await (k === 0 ? W.insta('2026-01-02', 'in', '1.11') : W.buy('2026-01-02', '0.1', '10'));
        n++;
      }
    });
    const exports: any[] = [];
    for (let k = 0; k < 15; k++) exports.push(await W.exportBackup());
    stop = true;
    await Promise.all(writers);
    for (const e of exports) {
      const created = new Set(e.data.audit_log.filter((a: any) => a.action === 'create').map((a: any) => a.record_id));
      for (const k of ['insta_entries', 'qat_entries']) {
        expect(e.counts[k]).toBe(e.data[k].length);
        for (const row of e.data[k]) expect(created.has(row.id)).toBe(true);
      }
      expect(e.data.audit_log.filter((a: any) => a.entity === 'insta_entries').length).toBe(e.data.insta_entries.length);
      expect(e.data.audit_log.filter((a: any) => a.entity === 'qat_entries').length).toBe(e.data.qat_entries.length);
    }
    const sizes = exports.map((e) => e.data.insta_entries.length + e.data.qat_entries.length);
    expect(Math.max(...sizes)).toBeGreaterThan(Math.min(...sizes)); // فعلًا تم التصدير أثناء الكتابة
  });
});

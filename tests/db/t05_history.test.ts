import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db, dec, freshDb, Ledger } from './helpers';

// T05 — تاريخ كامل متصل + T06 الماضي والتصحيح. التوقعات مكتوبة يدويًا من المواصفات.
let db: Db;
let L: Ledger;

beforeAll(async () => {
  db = await freshDb();
  L = new Ledger(db.session(await db.createUser()));
  await L.setup();
  await L.opening('qat', '2026-10-14', '100000', '0');
  await L.opening('insta', '2026-10-14', '20000');
  // 15
  await L.buy('2026-10-15', '10', '5000');
  await L.sell('2026-10-15', '4', '5000');
  await L.insta('2026-10-15', 'in', '30000');
  await L.insta('2026-10-15', 'out', '10000');
  await L.daily('2026-10-15', 'cash', '70000');
  await L.daily('2026-10-15', 'price', '5000');
  // 16
  await L.sell('2026-10-16', '6', '5000');
  await L.insta('2026-10-16', 'in', '5000');
  await L.insta('2026-10-16', 'out', '15000');
  await L.daily('2026-10-16', 'cash', '90000');
  await L.daily('2026-10-16', 'price', '5000');
  // 17
  await L.daily('2026-10-17', 'cash', '70000');
  await L.daily('2026-10-17', 'price', '6000');
});
afterAll(async () => db?.close());

describe('T05 تاريخ كامل', () => {
  it('يوم 14 (الافتتاحية): Q=100000 I=20000 وزن 0، والخزنة غير مسجلة', async () => {
    const r = await L.report('2026-10-14');
    expect(dec(r.qat.q)).toBe('100000');
    expect(dec(r.insta.i)).toBe('20000');
    expect(dec(r.qat.net_weight)).toBe('0');
    expect(r.cash).toBeNull();
    expect(r.result.status).toBe('incomplete');
    expect(r.result.missing).toContain('cash_missing');
    expect(r.result.decision).toBeNull();
  });

  it('يوم 15: Q=130000 I=40000 وزن 6 A=110000 D=20000 بيع 4 جرام', async () => {
    const r = await L.report('2026-10-15');
    expect(dec(r.qat.q)).toBe('130000');
    expect(dec(r.insta.i)).toBe('40000');
    expect(dec(r.qat.net_weight)).toBe('6');
    expect(dec(r.result.a)).toBe('110000');
    expect(dec(r.result.d)).toBe('20000');
    expect(r.result.decision).toBe('sell');
    expect(dec(r.result.grams)).toBe('4');
    expect(r.result.grams_approx).toBe(false);
    expect(dec(r.price.value)).toBe('5000');
    expect(r.day_entries.qat).toHaveLength(2);
    expect(r.day_entries.insta).toHaveLength(2);
  });

  it('يوم 16: Q=100000 I=30000 وزن 0 A=120000 D=-20000 شراء 4 جرام، شراء 10 بيع 10', async () => {
    const r = await L.report('2026-10-16');
    expect(dec(r.qat.q)).toBe('100000');
    expect(dec(r.insta.i)).toBe('30000');
    expect(dec(r.qat.net_weight)).toBe('0');
    expect(dec(r.qat.buy_weight)).toBe('10');
    expect(dec(r.qat.sell_weight)).toBe('10');
    expect(dec(r.result.a)).toBe('120000');
    expect(dec(r.result.d)).toBe('-20000');
    expect(r.result.decision).toBe('buy');
    expect(dec(r.result.grams)).toBe('4');
  });

  it('يوم 17 بلا حركات: Q=100000 I=30000 A=100000 متوازن وزن 0، سعر 6000', async () => {
    const r = await L.report('2026-10-17');
    expect(dec(r.qat.q)).toBe('100000');
    expect(dec(r.insta.i)).toBe('30000');
    expect(dec(r.result.a)).toBe('100000');
    expect(dec(r.result.d)).toBe('0');
    expect(r.result.decision).toBe('balanced');
    expect(dec(r.result.grams)).toBe('0');
    expect(dec(r.price.value)).toBe('6000');
    expect(r.day_entries.qat).toHaveLength(0);
  });

  it('مراجعة يوم 15 بعد إدخال 16 و17 تظل بقيم يوم 15 وسعره', async () => {
    const r = await L.report('2026-10-15');
    expect(dec(r.result.d)).toBe('20000');
    expect(dec(r.price.value)).toBe('5000');
    expect(dec(r.cash.value)).toBe('70000');
  });

  it('يوم 18 بلا خزنة: لا يرث خزنة 17، والأرصدة التراكمية مستمرة', async () => {
    const r = await L.report('2026-10-18');
    expect(r.cash).toBeNull();
    expect(r.price).toBeNull();
    expect(dec(r.qat.q)).toBe('100000');
    expect(r.result.status).toBe('incomplete');
  });

  it('يوم 13 قبل بداية الدفترين: لم يبدأ بعد', async () => {
    const r = await L.report('2026-10-13');
    expect(r.qat.status).toBe('not_started');
    expect(r.insta.status).toBe('not_started');
    expect(r.qat.q).toBeNull();
    expect(r.result.status).toBe('incomplete');
  });
});

describe('T06 الماضي والتصحيح', () => {
  it('حفظ حسبة 15 ثم وارد 1000 بتاريخ 15: المصحح I=41000 D=19000 بيع 3.8، الأصل يبقى 4 مع تنبيه، الإلغاء يعيد الأصل', async () => {
    const saved = await L.saveCalc('2026-10-15');
    expect(saved.ok).toBe(true);
    const before14 = await L.report('2026-10-14');

    const added = await L.insta('2026-10-15', 'in', '1000', { p_note: 'تصحيح متأخر' });
    const r = await L.report('2026-10-15');
    expect(dec(r.insta.i)).toBe('41000');
    expect(dec(r.result.d)).toBe('19000');
    expect(r.result.decision).toBe('sell');
    expect(dec(r.result.grams)).toBe('3.8');

    const r14 = await L.report('2026-10-14');
    expect(r14.qat).toEqual(before14.qat);
    expect(r14.insta).toEqual(before14.insta);

    let arch = await db.session(L.s.uid).rpc('list_calc_snapshots', {});
    expect(arch.rows).toHaveLength(1);
    expect(dec(arch.rows[0].grams)).toBe('4');
    expect(dec(arch.rows[0].d)).toBe('20000');
    expect(arch.rows[0].stale).toBe(true);
    expect(dec(arch.rows[0].current.result.d)).toBe('19000');

    // حفظ نسخة جديدة لا يمحو القديمة
    await L.saveCalc('2026-10-15');
    arch = await L.s.rpc('list_calc_snapshots', {});
    expect(arch.rows).toHaveLength(2);
    const old = arch.rows.find((x: any) => dec(x.grams) === '4');
    const neu = arch.rows.find((x: any) => dec(x.grams) === '3.8');
    expect(old.stale).toBe(true);
    expect(neu.stale).toBe(false);

    // إلغاء الحركة يعيد التقرير الأصلي، مع بقاء أثر المراجعة
    await L.s.rpc('cancel_insta_entry', { p_request_id: L.rid(), p_id: added.entry.id, p_expected_version: 1, p_reason: 'أُدخلت بالخطأ' });
    const r2 = await L.report('2026-10-15');
    expect(dec(r2.insta.i)).toBe('40000');
    expect(dec(r2.result.d)).toBe('20000');
    expect(dec(r2.result.grams)).toBe('4');
    const audit = await L.s.rpc('list_audit', { p_entity: 'insta_entries', p_record_id: added.entry.id });
    expect(audit.rows.map((a: any) => a.action).sort()).toEqual(['cancel', 'create']);
    arch = await L.s.rpc('list_calc_snapshots', {});
    expect(arch.rows.find((x: any) => dec(x.grams) === '4').stale).toBe(false);
    expect(arch.rows.find((x: any) => dec(x.grams) === '3.8').stale).toBe(true);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db, dec, freshDb, Ledger, RpcError } from './helpers';

let db: Db;
const newLedger = async () => {
  const L = new Ledger(db.session(await db.createUser()));
  await L.setup();
  return L;
};
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => db?.close());

async function rejects(p: Promise<unknown>, code?: string) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RpcError);
    if (code) expect((e as RpcError).code).toBe(code);
    return e as RpcError;
  }
  throw new Error('expected rejection' + (code ? ` (${code})` : ''));
}

describe('T01 رصيد القطعيات', () => {
  it('افتتاحي 100000، شراء 10×5000، بيع 4×5000، إضافة 1000، خصم 500 → 130500، شراء 10 بيع 4 صافي 6', async () => {
    const L = await newLedger();
    await L.opening('qat', '2026-01-01', '100000', '0');
    await L.opening('insta', '2026-01-01', '0');
    const b = await L.buy('2026-01-02', '10', '5000');
    expect(dec(b.entry.amount)).toBe('50000');
    const s = await L.sell('2026-01-02', '4', '5000');
    expect(dec(s.entry.amount)).toBe('20000');
    await L.adjust('2026-01-02', 'cash_add', '1000', 'فرق حساب');
    await L.adjust('2026-01-02', 'cash_deduct', '500', 'خصم');
    const r = await L.report('2026-01-02');
    expect(dec(r.qat.q)).toBe('130500');
    expect(dec(r.qat.buy_weight)).toBe('10');
    expect(dec(r.qat.sell_weight)).toBe('4');
    expect(dec(r.qat.net_weight)).toBe('6');
    expect(dec(r.qat.buy_value)).toBe('50000');
    expect(dec(r.qat.sell_value)).toBe('20000');
    expect(dec(r.qat.cash_add)).toBe('1000');
    expect(dec(r.qat.cash_deduct)).toBe('500');
    const list = await L.s.rpc('list_qat_entries', { p_order: 'asc' });
    expect(list.rows.map((x: any) => dec(x.running_money))).toEqual(['150000', '130000', '131000', '130500']);
    expect(list.rows.map((x: any) => dec(x.running_weight))).toEqual(['10', '6', '6', '6']);
    expect(dec(list.book.money)).toBe('130500');
  });

  it('التسوية بلا سبب مرفوضة، والتسوية لا تقبل وزنًا', async () => {
    const L = await newLedger();
    await L.opening('qat', '2026-01-01', '0', '0');
    await rejects(L.s.rpc('add_qat_entry', { p_request_id: L.rid(), p_entry_date: '2026-01-01', p_entry_type: 'cash_add', p_amount: '10' }), 'required');
    await rejects(L.s.rpc('add_qat_entry', { p_request_id: L.rid(), p_entry_date: '2026-01-01', p_entry_type: 'cash_add', p_amount: '10', p_weight: '1', p_reason: 'x' }), 'invalid_fields');
  });
});

describe('T02 إنستا', () => {
  it('100 + 300 − 80 = 320؛ اليوم التالي +200 −50 = 470؛ مراجعة اليوم الأول 320؛ تم السداد والاسم لا يغيران', async () => {
    const L = await newLedger();
    await L.opening('qat', '2026-02-01', '0', '0');
    await L.opening('insta', '2026-02-01', '100');
    await L.insta('2026-02-01', 'in', '300', { p_person_name: 'أحمد' });
    const out = await L.insta('2026-02-01', 'out', '80', { p_person_name: 'سعيد' });
    expect(dec((await L.report('2026-02-01')).insta.i)).toBe('320');
    await L.insta('2026-02-02', 'in', '200');
    await L.insta('2026-02-02', 'out', '50');
    expect(dec((await L.report('2026-02-02')).insta.i)).toBe('470');
    expect(dec((await L.report('2026-02-01')).insta.i)).toBe('320');
    // تعديل الاسم + الملاحظة «تم السداد» + العلامة: بلا سبب لأنه غير مالي، ولا يغير الرصيد
    const upd = await L.s.rpc('update_insta_entry', { p_request_id: L.rid(), p_id: out.entry.id, p_expected_version: 1,
      p_entry_date: '2026-02-01', p_entry_type: 'out', p_amount: '80', p_person_name: 'سعيد محمود', p_note: 'تم السداد', p_marked_paid: true });
    expect(upd.entry.marked_paid).toBe(true);
    expect(dec((await L.report('2026-02-01')).insta.i)).toBe('320');
    expect(dec((await L.report('2026-02-02')).insta.i)).toBe('470');
    const list = await L.s.rpc('list_insta_entries', { p_search: 'سعيد' });
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0].note).toBe('تم السداد');
    expect(dec(list.book.total_out)).toBe('130');
  });

  it('تعديل مالي (المبلغ) يتطلب سبب تصحيح', async () => {
    const L = await newLedger();
    await L.opening('insta', '2026-02-01', '0');
    const e = await L.insta('2026-02-01', 'in', '10');
    await rejects(L.s.rpc('update_insta_entry', { p_request_id: L.rid(), p_id: e.entry.id, p_expected_version: 1,
      p_entry_date: '2026-02-01', p_entry_type: 'in', p_amount: '11' }), 'required');
  });
});

describe('T03 الخزنة غير التراكمية', () => {
  it('1000 ثم 1500 → 1500؛ تعديل إلى 1700 مع بقاء 1500 في المراجعة؛ حركات أخرى لا تغيرها', async () => {
    const L = await newLedger();
    await L.opening('qat', '2026-03-01', '0', '0');
    await L.opening('insta', '2026-03-01', '0');
    await L.daily('2026-03-01', 'cash', '1000');
    await L.daily('2026-03-02', 'cash', '1500');
    expect(dec((await L.report('2026-03-02')).cash.value)).toBe('1500');
    expect(dec((await L.report('2026-03-01')).cash.value)).toBe('1000');
    await L.insta('2026-03-01', 'in', '999');
    await L.buy('2026-03-02', '1', '100');
    expect(dec((await L.report('2026-03-02')).cash.value)).toBe('1500');
    expect(dec((await L.report('2026-03-01')).cash.value)).toBe('1000');
    await L.daily('2026-03-02', 'cash', '1700', 'عدّ ثاني');
    const r = await L.report('2026-03-02');
    expect(dec(r.cash.value)).toBe('1700');
    const audit = await L.s.rpc('list_audit', { p_entity: 'daily_values', p_record_id: '2026-03-02' });
    const upd = audit.rows.find((a: any) => a.action === 'update');
    expect(dec(upd.old_data.cash)).toBe('1500');
    expect(dec(upd.new_data.cash)).toBe('1700');
    expect(upd.reason).toBe('عدّ ثاني');
    const vals = await L.s.rpc('list_daily_values', {});
    expect(vals.filter((v: any) => v.value_date === '2026-03-02')).toHaveLength(1);
  });

  it('تعديل بنسخة قديمة (تبويبان) يعطي تعارضًا', async () => {
    const L = await newLedger();
    await L.daily('2026-03-05', 'cash', '10');
    await L.s.rpc('set_daily_value', { p_request_id: L.rid(), p_value_date: '2026-03-05', p_field: 'cash', p_value: '20', p_expected_version: 1 });
    await rejects(L.s.rpc('set_daily_value', { p_request_id: L.rid(), p_value_date: '2026-03-05', p_field: 'cash', p_value: '30', p_expected_version: 1 }), 'conflict');
    // إنشاء يوم من تبويبين بدون نسخة
    await rejects(L.s.rpc('set_daily_value', { p_request_id: L.rid(), p_value_date: '2026-03-05', p_field: 'price', p_value: '30', p_expected_version: null }), 'conflict');
  });
});

describe('T04 اتجاه القرار', () => {
  // Q=100000 (افتتاحي)، I=20000، P=5000
  it.each([
    ['60000', '20000', 'sell', '4'],
    ['100000', '-20000', 'buy', '4'],
    ['80000', '0', 'balanced', '0'],
  ])('C=%s → D=%s %s %s جرام', async (c, d, decision, grams) => {
    const L = await newLedger();
    await L.opening('qat', '2026-04-01', '100000', '0');
    await L.opening('insta', '2026-04-01', '20000');
    await L.daily('2026-04-01', 'cash', c);
    await L.daily('2026-04-01', 'price', '5000');
    const r = await L.report('2026-04-01');
    expect(dec(r.result.d)).toBe(d);
    expect(r.result.decision).toBe(decision);
    expect(dec(r.result.grams)).toBe(grams);
  });

  it('مثال صاحب الدفتر: عليه 100000 ومعه 80000 → بيع بقيمة 20000؛ والشراء يزيد Q والبيع ينقصه', async () => {
    const L = await newLedger();
    await L.opening('qat', '2026-04-01', '100000', '0');
    await L.opening('insta', '2026-04-01', '30000');
    await L.daily('2026-04-01', 'cash', '50000');
    await L.daily('2026-04-01', 'price', '4000');
    let r = await L.report('2026-04-01');
    expect(r.result.decision).toBe('sell');
    expect(dec(r.result.abs_d)).toBe('20000');
    expect(dec(r.result.grams)).toBe('5');
    await L.buy('2026-04-01', '1', '1000');
    r = await L.report('2026-04-01');
    expect(dec(r.qat.q)).toBe('101000');
    await L.sell('2026-04-01', '2', '1000');
    r = await L.report('2026-04-01');
    expect(dec(r.qat.q)).toBe('99000');
  });
});

describe('T11 الإشارات', () => {
  it('Q=-1000 I=0 C=0 P=5000 → D=-1000 شراء 0.2 جرام', async () => {
    const L = await newLedger();
    await L.opening('qat', '2026-05-01', '-1000', '0');
    await L.opening('insta', '2026-05-01', '0');
    await L.daily('2026-05-01', 'cash', '0');
    await L.daily('2026-05-01', 'price', '5000');
    const r = await L.report('2026-05-01');
    expect(dec(r.qat.q)).toBe('-1000');
    expect(dec(r.result.a)).toBe('0');
    expect(dec(r.result.d)).toBe('-1000');
    expect(r.result.decision).toBe('buy');
    expect(dec(r.result.grams)).toBe('0.2');
  });

  it('رصيد إنستا سالب: Q=1000 I=-500 C=0 → A=-500 D=1500 بيع', async () => {
    const L = await newLedger();
    await L.opening('qat', '2026-05-01', '1000', '0');
    await L.opening('insta', '2026-05-01', '0');
    await L.insta('2026-05-01', 'out', '500');
    await L.daily('2026-05-01', 'cash', '0');
    await L.daily('2026-05-01', 'price', '100');
    const r = await L.report('2026-05-01');
    expect(dec(r.insta.i)).toBe('-500');
    expect(dec(r.result.a)).toBe('-500');
    expect(dec(r.result.d)).toBe('1500');
    expect(r.result.decision).toBe('sell');
    expect(dec(r.result.grams)).toBe('15');
  });

  it('رصيد قطعيات يصبح سالبًا بالبيع ولا يُحوَّل لقيمة مطلقة', async () => {
    const L = await newLedger();
    await L.opening('qat', '2026-05-01', '0', '0');
    await L.sell('2026-05-01', '1', '700');
    const list = await L.s.rpc('list_qat_entries', {});
    expect(dec(list.book.money)).toBe('-700');
    expect(dec(list.book.net_weight)).toBe('-1');
  });
});

describe('T07 البيانات الناقصة والافتتاحيات', () => {
  it('خزنة غير مسجلة ≠ صفر ولا خزنة أمس؛ صفر صريح صحيح', async () => {
    const L = await newLedger();
    await L.opening('qat', '2026-06-01', '100', '0');
    await L.opening('insta', '2026-06-01', '0');
    await L.daily('2026-06-01', 'cash', '50');
    await L.daily('2026-06-02', 'price', '10');
    const r2 = await L.report('2026-06-02');
    expect(r2.cash).toBeNull();
    expect(r2.result.status).toBe('incomplete');
    expect(r2.result.d).toBeNull();
    await L.daily('2026-06-02', 'cash', '0');
    const r2b = await L.report('2026-06-02');
    expect(dec(r2b.cash.value)).toBe('0');
    expect(dec(r2b.result.d)).toBe('100');
    expect(dec(r2b.result.grams)).toBe('10');
  });

  it('سعر مفقود: الفرق يظهر بدون وزن؛ سعر صفر/سالب مرفوض عند الإدخال؛ الحسبة لا تُحفظ', async () => {
    const L = await newLedger();
    await L.opening('qat', '2026-06-01', '100', '0');
    await L.opening('insta', '2026-06-01', '0');
    await L.daily('2026-06-01', 'cash', '40');
    const r = await L.report('2026-06-01');
    expect(dec(r.result.d)).toBe('60');
    expect(r.result.grams_status).toBe('price_missing');
    expect(r.result.grams).toBeNull();
    await rejects(L.daily('2026-06-01', 'price', '0'), 'must_be_positive');
    await rejects(L.daily('2026-06-01', 'price', '-5'), 'negative_not_allowed');
    await rejects(L.saveCalc('2026-06-01'), 'price_missing');
    expect((await L.s.rpc('list_calc_snapshots', {})).rows).toHaveLength(0);
  });

  it('رفض إضافة/نقل حركة قبل البداية، ورفض نقل البداية بعد حركة، والافتتاحية لا تتكرر', async () => {
    const L = await newLedger();
    await rejects(L.buy('2026-06-10', '1', '1'), 'book_not_configured');
    const o = await L.opening('qat', '2026-06-10', '1000', '2');
    await rejects(L.buy('2026-06-09', '1', '1'), 'before_book_start');
    const e = await L.buy('2026-06-10', '1', '100');
    await rejects(L.s.rpc('update_qat_entry', { p_request_id: L.rid(), p_id: e.entry.id, p_expected_version: 1,
      p_entry_date: '2026-06-09', p_entry_type: 'buy', p_weight: '1', p_unit_price: '100', p_change_reason: 'x' }), 'before_book_start');
    await rejects(L.opening('qat', '2026-06-11', '1000', '2', o.version, 'نقل'), 'entries_before_start');
    // تعديل الافتتاحية بلا سبب مرفوض، وبنسخة قديمة تعارض
    await rejects(L.opening('qat', '2026-06-10', '2000', '2', o.version), 'required');
    await rejects(L.opening('qat', '2026-06-10', '2000', '2', 99, 'x'), 'conflict');
    // نقل البداية أبكر مسموح، والافتتاحية تدخل مرة واحدة
    await L.opening('qat', '2026-06-01', '1000', '2', o.version, 'تصحيح تاريخ البداية');
    await L.opening('insta', '2026-06-01', '0');
    for (const d of ['2026-06-01', '2026-06-10', '2026-06-30']) {
      const r = await L.report(d);
      expect(dec(r.qat.q)).toBe(d === '2026-06-01' ? '1000' : '1100');
      expect(dec(r.qat.net_weight)).toBe(d === '2026-06-01' ? '2' : '3');
    }
    const list = await L.s.rpc('list_qat_entries', { p_from: '2026-06-05', p_to: '2026-06-30' });
    expect(dec(list.period.before_money)).toBe('1000');
    expect(dec(list.period.end_money)).toBe('1100');
    // الحركة الملغاة قبل البداية لا تمنع نقل البداية
    await L.s.rpc('cancel_qat_entry', { p_request_id: L.rid(), p_id: e.entry.id, p_expected_version: 1, p_reason: 'خطأ' });
    const st = await L.state();
    await L.opening('qat', '2026-06-20', '1000', '2', st.openings.qat.version, 'نقل بعد الإلغاء');
  });

  it('الحركة المستقبلية لا تتسرب للماضي، والبداية من الصفر اختيار صريح', async () => {
    const L = await newLedger();
    await rejects(L.opening('qat', '2026-07-01', '', '0'), 'required');
    await rejects(L.opening('qat', '2026-07-01', '0', null), 'required');
    await L.opening('qat', '2026-07-01', '0', '0');
    await L.buy('2026-07-20', '1', '100');
    expect(dec((await L.report('2026-07-19')).qat.q)).toBe('0');
    expect(dec((await L.report('2026-07-20')).qat.q)).toBe('100');
  });
});

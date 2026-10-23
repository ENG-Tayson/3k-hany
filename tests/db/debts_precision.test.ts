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
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(RpcError);
    if (code) expect((e as RpcError).code).toBe(code);
    return e as RpcError;
  }
  throw new Error('expected rejection ' + (code ?? ''));
}

async function shopSnapshot(L: Ledger, date: string) {
  const r = await L.report(date);
  return { qat: r.qat, insta: r.insta, cash: r.cash, price: r.price, result: r.result, fp: r.fingerprint };
}

describe('T08 الفلوس اللي برّه', () => {
  it('ريمون 1000 محمود 5000 هاني 20000 = 26000؛ سداد هاني 5000 → 21000؛ ريمون 1000 → 20000 مسدد بالكامل؛ المحل لم يتغير', async () => {
    const L = await newLedger();
    await L.opening('qat', '2026-08-01', '100000', '0');
    await L.opening('insta', '2026-08-01', '20000');
    await L.daily('2026-08-01', 'cash', '60000');
    await L.daily('2026-08-01', 'price', '5000');
    const shopBefore = await shopSnapshot(L, '2026-08-01');
    const shopBefore2 = await shopSnapshot(L, '2026-08-10');

    const raymond = (await L.person('ريمون')).id;
    const mahmoud = (await L.person('محمود')).id;
    const hany = (await L.person('هاني')).id;
    await L.debt(raymond, '2026-08-01', 'sent', '1000');
    await L.debt(mahmoud, '2026-08-01', 'sent', '5000');
    await L.debt(hany, '2026-08-01', 'sent', '20000');
    expect(dec((await L.people()).total_outstanding)).toBe('26000');

    await L.debt(hany, '2026-08-03', 'repaid', '5000');
    let p = await L.people();
    expect(dec(p.total_outstanding)).toBe('21000');
    const h = p.rows.find((x: any) => x.id === hany);
    expect(dec(h.remaining)).toBe('15000');
    expect(h.status).toBe('partial');

    const rr = await L.debt(raymond, '2026-08-04', 'repaid', '1000');
    p = await L.people();
    expect(dec(p.total_outstanding)).toBe('20000');
    expect(p.rows.find((x: any) => x.id === raymond).status).toBe('paid');
    expect(p.rows.find((x: any) => x.id === mahmoud).status).toBe('unpaid');
    // المسددون يظلون في السجل ويمكن فلترتهم
    expect((await L.s.rpc('list_people', { p_status: 'paid' })).rows.map((x: any) => x.name)).toEqual(['ريمون']);
    expect((await L.s.rpc('list_people', { p_status: 'open' })).rows).toHaveLength(2);

    // مراجعة تاريخ قبل السداد
    const past = await L.people('2026-08-02');
    expect(dec(past.total_outstanding)).toBe('26000');
    expect(past.rows.find((x: any) => x.id === raymond).status).toBe('unpaid');

    // سداد أكبر من الباقي مرفوض مع شرح
    const err = await rejects(L.debt(hany, '2026-08-05', 'repaid', '15000.01'), 'overpayment');
    expect(err.message).toContain('15000');
    // سداد بتاريخ قبل وجود الدين مرفوض
    await rejects(L.debt(mahmoud, '2026-07-31', 'repaid', '1'), 'overpayment');

    // إلغاء سداد
    await L.s.rpc('cancel_debt_entry', { p_request_id: L.rid(), p_id: rr.entry.id, p_expected_version: 1, p_reason: 'لم يصل' });
    expect(dec((await L.people()).total_outstanding)).toBe('21000');
    // سداد كامل ثم مبلغ جديد بعد التسديد
    await L.debt(raymond, '2026-08-06', 'repaid', '1000');
    await L.debt(raymond, '2026-08-07', 'sent', '300');
    p = await L.people();
    expect(dec(p.rows.find((x: any) => x.id === raymond).remaining)).toBe('300');
    expect(p.rows.find((x: any) => x.id === raymond).status).toBe('partial');

    // إلغاء/تأريخ رجعي ينتج سدادًا غير مغطى مرفوض
    const person = await L.s.rpc('get_person', { p_id: raymond });
    const firstSent = person.entries.find((x: any) => x.entry_type === 'sent' && dec(x.amount) === '1000');
    await rejects(L.s.rpc('cancel_debt_entry', { p_request_id: L.rid(), p_id: firstSent.id, p_expected_version: 1, p_reason: 'x' }), 'overpayment');
    await rejects(L.s.rpc('update_debt_entry', { p_request_id: L.rid(), p_id: firstSent.id, p_expected_version: 1,
      p_entry_date: '2026-08-10', p_entry_type: 'sent', p_amount: '1000', p_change_reason: 'تاريخ' }), 'overpayment');

    // الاسم المتشابه في إنستا لا ينشئ ربطًا، والمحل لم يتغير إطلاقًا
    await L.insta('2026-08-02', 'in', '0.01', { p_person_name: 'هاني' });
    const ins = await L.s.rpc('list_insta_entries', {});
    await L.s.rpc('cancel_insta_entry', { p_request_id: L.rid(), p_id: ins.rows[0].id, p_expected_version: 1, p_reason: 'اختبار' });
    expect(dec((await L.people()).total_outstanding)).toBe(dec(p.total_outstanding));
    const shopAfter = await shopSnapshot(L, '2026-08-01');
    expect(shopAfter).toEqual(shopBefore);
    const shopAfter2 = await shopSnapshot(L, '2026-08-10');
    expect(shopAfter2).toEqual(shopBefore2);
    // لا قطعيات ولا إنستا نشطة أُنشئت
    expect((await L.s.rpc('list_qat_entries', {})).rows).toHaveLength(0);
    // شخصان بنفس الاسم لا يُدمجان
    await L.person('هاني');
    expect((await L.s.rpc('list_people', { p_search: 'هاني' })).rows).toHaveLength(2);
  });

  it('الرصيد الجاري لكل شخص بالتاريخ', async () => {
    const L = await newLedger();
    const id = (await L.person('س')).id;
    await L.debt(id, '2026-09-01', 'sent', '100');
    await L.debt(id, '2026-09-02', 'repaid', '30');
    await L.debt(id, '2026-09-03', 'sent', '50');
    const g = await L.s.rpc('get_person', { p_id: id });
    expect(g.entries.map((x: any) => dec(x.running))).toEqual(['100', '70', '120']);
    expect(dec(g.remaining)).toBe('120');
    const g2 = await L.s.rpc('get_person', { p_id: id, p_as_of: '2026-09-02' });
    expect(dec(g2.remaining)).toBe('70');
    expect(g2.entries).toHaveLength(2);
  });
});

describe('T09 الدقة', () => {
  it('قيم القطعيات بالتقريب المعتمد ROUND_HALF_UP لقرش', async () => {
    const L = await newLedger();
    await L.opening('qat', '2026-01-01', '0', '0');
    expect(dec((await L.buy('2026-01-01', '0.001', '5000')).entry.amount)).toBe('5');
    expect((await L.buy('2026-01-01', '0.001', '5000')).entry.amount).toBe('5.00');
    expect(dec((await L.buy('2026-01-01', '1.001', '12.34')).entry.amount)).toBe('12.35');
    expect(dec((await L.buy('2026-01-01', '0.005', '1.00')).entry.amount)).toBe('0.01');
    // أقل من قرش مرفوض بدل الحفظ صفرًا
    await rejects(L.buy('2026-01-01', '0.004', '1.00'), 'amount_too_small');
    // preview مختلف من العميل مرفوض
    await rejects(L.buy('2026-01-01', '1.001', '12.34', { p_amount: '12.34' }), 'amount_mismatch');
    expect(dec((await L.buy('2026-01-01', '1.001', '12.34', { p_amount: '12.35' })).entry.amount)).toBe('12.35');
    const r = await L.report('2026-01-01');
    // 5 + 5 + 12.35 + 0.01 + 12.35 = 34.71 (مجموع المبالغ المقربة، لا الوزن × سعر اليوم)
    expect(dec(r.qat.q)).toBe('34.71');
    expect(dec(r.qat.buy_weight)).toBe('2.009');
  });

  it('0.1 + 0.2 = 0.3 بالضبط، والجمع المتكرر لكسور كثيرة', async () => {
    const L = await newLedger();
    await L.opening('insta', '2026-01-01', '0');
    await L.opening('qat', '2026-01-01', '0', '0');
    await L.insta('2026-01-01', 'in', '0.1');
    await L.insta('2026-01-01', 'in', '0.2');
    expect((await L.report('2026-01-01')).insta.i).toBe('0.30');
    for (let k = 0; k < 300; k++) await L.insta('2026-01-02', 'in', '0.01');
    expect(dec((await L.report('2026-01-02')).insta.i)).toBe('3.3');
    for (let k = 0; k < 100; k++) await L.buy('2026-01-03', '0.000001', '10000');  // 0.01 لكل حركة
    const r = await L.report('2026-01-03');
    expect(dec(r.qat.buy_weight)).toBe('0.0001');
    expect(dec(r.qat.q)).toBe('1');
  });

  it('1000 ÷ 3000 = 0.333333 تقريبي؛ 0.01 ÷ 100000 أقل من 0.000001 دون تغيير القرار', async () => {
    const L = await newLedger();
    await L.opening('qat', '2026-01-01', '1000', '0');
    await L.opening('insta', '2026-01-01', '0');
    await L.daily('2026-01-01', 'cash', '0');
    await L.daily('2026-01-01', 'price', '3000');
    let r = await L.report('2026-01-01');
    expect(dec(r.result.d)).toBe('1000');
    expect(r.result.decision).toBe('sell');
    expect(r.result.grams).toBe('0.333333');
    expect(r.result.grams_approx).toBe(true);
    expect(r.result.grams_below_min).toBe(false);

    const M = await newLedger();
    await M.opening('qat', '2026-01-01', '0.01', '0');
    await M.opening('insta', '2026-01-01', '0');
    await M.daily('2026-01-01', 'cash', '0');
    await M.daily('2026-01-01', 'price', '100000');
    r = await M.report('2026-01-01');
    expect(dec(r.result.d)).toBe('0.01');
    expect(r.result.decision).toBe('sell');
    expect(r.result.grams_below_min).toBe(true);
    expect(r.result.grams_approx).toBe(true);
    // 2/3 → 0.666667 (HALF_UP)
    const N = await newLedger();
    await N.opening('qat', '2026-01-01', '2', '0');
    await N.opening('insta', '2026-01-01', '0');
    await N.daily('2026-01-01', 'cash', '0');
    await N.daily('2026-01-01', 'price', '3');
    expect((await N.report('2026-01-01')).result.grams).toBe('0.666667');
  });
});

describe('T10 الإدخال على الخادم', () => {
  it('يرفض الكسور الزائدة بدل تقريبها، والسالب، والفارغ، والنص، والحدود القصوى', async () => {
    const L = await newLedger();
    await L.opening('qat', '2026-01-01', '0', '0');
    await L.opening('insta', '2026-01-01', '0');
    await rejects(L.insta('2026-01-01', 'in', '10.001'), 'too_many_decimals');
    await rejects(L.buy('2026-01-01', '1.0000001', '10'), 'too_many_decimals');
    await rejects(L.buy('2026-01-01', '1', '10.005'), 'too_many_decimals');
    await rejects(L.insta('2026-01-01', 'in', '-5'), 'negative_not_allowed');
    await rejects(L.insta('2026-01-01', 'in', '0'), 'must_be_positive');
    await rejects(L.insta('2026-01-01', 'in', ''), 'required');
    await rejects(L.insta('2026-01-01', 'in', '   '), 'required');
    await rejects(L.insta('2026-01-01', 'in', 'abc'), 'invalid_number');
    await rejects(L.insta('2026-01-01', 'in', '1,000'), 'invalid_number');
    await rejects(L.insta('2026-01-01', 'in', '١٠'), 'invalid_number'); // العميل يطبّع؛ الخادم يقبل ASCII فقط
    await rejects(L.insta('2026-01-01', 'in', '1e5'), 'invalid_number');
    await rejects(L.insta('2026-01-01', 'in', 'NaN'), 'invalid_number');
    await rejects(L.insta('2026-01-01', 'in', 'Infinity'), 'invalid_number');
    await rejects(L.insta('2026-01-01', 'in', '1000000000000'), 'too_large');
    expect(dec((await L.insta('2026-01-01', 'in', '999999999999.99')).entry.amount)).toBe('999999999999.99');
    await rejects(L.buy('2026-01-01', '1000000', '1'), 'too_large');
    await rejects(L.daily('2026-01-01', 'cash', '-1'), 'negative_not_allowed');
    await rejects(L.insta('2026-13-01', 'in', '1'), 'invalid_date');
    await rejects(L.insta('2026-02-30', 'in', '1'), 'invalid_date');
    await rejects(L.insta('26-1-1', 'in', '1'), 'invalid_date');
    await rejects(L.s.rpc('add_qat_entry', { p_request_id: L.rid(), p_entry_date: '2026-01-01', p_entry_type: 'gift', p_weight: '1', p_unit_price: '1' }), 'invalid_type');
    await rejects(L.insta('2026-01-01', 'in', '1', { p_person_name: 'x'.repeat(101) }), 'too_long');
  });

  it('حقن HTML/SQL في الاسم والملاحظة يُحفظ نصًا حرفيًا ولا يُنفّذ', async () => {
    const L = await newLedger();
    await L.opening('insta', '2026-01-01', '0');
    const evil = `<img src=x onerror=alert(1)>'); drop table public.insta_entries; --`;
    const e = await L.insta('2026-01-01', 'in', '5', { p_person_name: evil.slice(0, 100), p_note: evil });
    expect(e.entry.note).toBe(evil);
    const l = await L.s.rpc('list_insta_entries', { p_search: '<img' });
    expect(l.rows).toHaveLength(1);
    expect(l.rows[0].note).toBe(evil);
    // البحث بحروف % و _ لا يطابق كل شيء
    expect((await L.s.rpc('list_insta_entries', { p_search: '%' })).rows).toHaveLength(0);
  });
});

describe('T12 كشف الفترة والفلترة', () => {
  it('رصيد البداية + صافي الفترة = رصيد النهاية؛ الفلترة والصفحات لا تغير الإجمالي العام؛ ترتيب ثابت في نفس اليوم', async () => {
    const L = await newLedger();
    await L.opening('qat', '2026-01-01', '1000', '1');
    await L.opening('insta', '2026-01-01', '0');
    await L.buy('2026-01-01', '1', '100', { p_trader_name: 'الحاج علي' });
    await L.buy('2026-01-05', '2', '100', { p_trader_name: 'الحاج علي', p_note: 'دفعة أولى' });
    await L.sell('2026-01-05', '1', '100', { p_trader_name: 'مينا' });
    await L.adjust('2026-01-05', 'cash_add', '7', 'فرق');
    await L.buy('2026-01-05', '3', '100', { p_trader_name: 'مينا' });
    await L.sell('2026-01-09', '1', '50');
    await L.buy('2026-01-12', '1', '100');
    const all = await L.s.rpc('list_qat_entries', { p_order: 'asc' });
    expect(dec(all.book.money)).toBe('1557');
    expect(dec(all.book.net_weight)).toBe('6');
    // ترتيب ثابت لحركات 01-05 حسب الإدخال
    const day5 = all.rows.filter((r: any) => r.entry_date === '2026-01-05').map((r: any) => r.entry_type);
    expect(day5).toEqual(['buy', 'sell', 'cash_add', 'buy']);

    const per = await L.s.rpc('list_qat_entries', { p_from: '2026-01-05', p_to: '2026-01-09', p_order: 'asc' });
    expect(dec(per.period.before_money)).toBe('1100');
    expect(dec(per.period.period_money)).toBe('357');
    expect(dec(per.period.end_money)).toBe('1457');
    expect(dec(per.period.before_weight)).toBe('2');
    expect(dec(per.period.end_weight)).toBe('5');
    expect(per.rows).toHaveLength(5);
    expect(dec(per.book.money)).toBe('1557');
    // الفترة التي تبدأ عند/قبل البداية لا تكرر الافتتاحية
    const fromStart = await L.s.rpc('list_qat_entries', { p_from: '2025-12-01', p_to: '2026-01-01' });
    expect(dec(fromStart.period.before_money)).toBe('1000');
    expect(dec(fromStart.period.end_money)).toBe('1100');

    // البحث: مجموع النتائج منفصل عن إجمالي الدفتر
    const s = await L.s.rpc('list_qat_entries', { p_search: 'مينا' });
    expect(s.filtered.count).toBe('2');
    expect(dec(s.filtered.buy_weight)).toBe('3');
    expect(dec(s.filtered.sell_weight)).toBe('1');
    expect(dec(s.book.money)).toBe('1557');
    // الصفحات: page 1 و 2 لا تغير المجموع
    const p1 = await L.s.rpc('list_qat_entries', { p_limit: 2, p_offset: 0 });
    const p2 = await L.s.rpc('list_qat_entries', { p_limit: 2, p_offset: 2 });
    expect(p1.rows).toHaveLength(2);
    expect(p2.rows).toHaveLength(2);
    expect(p1.filtered).toEqual(p2.filtered);
    expect(p1.filtered.count).toBe('7');
    expect(p1.rows[0].entry_date).toBe('2026-01-12');
    // الرصيد الجاري في الصفحة الثانية محسوب من كل الدفتر
    expect(dec(p2.rows[0].running_money)).toBe('1507');
    // فلترة بالنوع
    const adj = await L.s.rpc('list_qat_entries', { p_type: 'adjust' });
    expect(adj.rows).toHaveLength(1);
    // حسبة اليوم لا تتأثر
    expect(dec((await L.report('2026-01-12')).qat.q)).toBe('1557');
  });
});

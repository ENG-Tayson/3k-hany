import Decimal from 'decimal.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db, dec, freshDb, Ledger } from './helpers';

// مرجع مستقل: decimal.js (وليس محرك الإنتاج) لإعادة حساب النتائج.
Decimal.set({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => db?.close());

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const addDays = (d: string, n: number) => {
  const [y, m, dd] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, dd + n));
  return t.toISOString().slice(0, 10);
};
const fix = (r: () => number, min: number, max: number, scale: number) => new Decimal(min + r() * (max - min)).toDecimalPlaces(scale, Decimal.ROUND_DOWN);

type Q = { date: string; type: 'buy' | 'sell' | 'cash_add' | 'cash_deduct'; weight?: string; price?: string; amount: string; trader?: string };
type I = { date: string; type: 'in' | 'out'; amount: string; person?: string };

function reference(qOpen: Decimal, wOpen: Decimal, iOpen: Decimal, qat: Q[], insta: I[], d: string, cash: Decimal | null, price: Decimal | null) {
  let q = qOpen, w = wOpen, i = iOpen;
  for (const e of qat) if (e.date <= d) {
    const a = new Decimal(e.amount);
    if (e.type === 'buy') { q = q.plus(a); w = w.plus(e.weight!); }
    if (e.type === 'sell') { q = q.minus(a); w = w.minus(e.weight!); }
    if (e.type === 'cash_add') q = q.plus(a);
    if (e.type === 'cash_deduct') q = q.minus(a);
  }
  for (const e of insta) if (e.date <= d) i = e.type === 'in' ? i.plus(e.amount) : i.minus(e.amount);
  const out: any = { q, w, i };
  if (cash) {
    out.d = q.minus(cash.plus(i));
    if (price) out.grams = out.d.abs().div(price).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
  }
  return out;
}

describe('T18 حجم واقعي: 10,000 حركة', () => {
  it('أرصدة صحيحة، تصفح وبحث، وانتقال بين الأيام مع قياس الزمن', async () => {
    const r = rng(20261022);
    const traders = Array.from({ length: 25 }, (_, k) => `تاجر ${k + 1}`);
    const start = '2025-01-01';
    const qat: Q[] = [];
    const insta: I[] = [];
    for (let k = 0; k < 6000; k++) {
      const date = addDays(start, Math.floor(r() * 365));
      const x = r();
      if (x < 0.85) {
        const weight = fix(r, 0.001, 50, 3).toFixed(6);
        const price = fix(r, 3000, 6000, 2).toFixed(2);
        const amount = new Decimal(weight).times(price).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
        qat.push({ date, type: x < 0.45 ? 'buy' : 'sell', weight, price, amount, trader: traders[Math.floor(r() * traders.length)] });
      } else {
        qat.push({ date, type: x < 0.93 ? 'cash_add' : 'cash_deduct', amount: fix(r, 0.01, 5000, 2).toFixed(2) });
      }
    }
    for (let k = 0; k < 4000; k++) {
      insta.push({ date: addDays(start, Math.floor(r() * 365)), type: r() < 0.55 ? 'in' : 'out', amount: fix(r, 0.01, 50000, 2).toFixed(2), person: `عميل ${k % 300}` });
    }
    const sortKey = (a: { date: string }, b: { date: string }) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    qat.sort(sortKey); insta.sort(sortKey);
    const daily: { date: string; cash: string; price: string }[] = [];
    for (let k = 0; k < 365; k++) daily.push({ date: addDays(start, k), cash: fix(r, 0, 900000, 2).toFixed(2), price: fix(r, 3000, 6000, 2).toFixed(2) });
    let seq = 1;
    const now = new Date().toISOString();
    const data = {
      account: { weight_basis: 'عيار 21', created_at: now },
      book_openings: [
        { book: 'insta', start_date: start, opening_money: '12345.67', opening_weight: null, version: 1, created_at: now, updated_at: now },
        { book: 'qat', start_date: start, opening_money: '-50000.00', opening_weight: '100.000000', version: 1, created_at: now, updated_at: now },
      ],
      qat_entries: qat.map((e) => ({ id: randomUUID(), seq: String(seq++), entry_date: e.date, entry_type: e.type, weight: e.weight ?? null,
        unit_price: e.price ?? null, amount: e.amount, trader_name: e.trader ?? null, note: null, reason: e.weight ? null : 'تسوية',
        status: 'active', cancel_reason: null, cancelled_at: null, version: 1, created_at: now, updated_at: now })),
      insta_entries: insta.map((e) => ({ id: randomUUID(), seq: String(seq++), entry_date: e.date, entry_type: e.type, amount: e.amount,
        person_name: e.person ?? null, note: null, marked_paid: false, status: 'active', cancel_reason: null, cancelled_at: null, version: 1, created_at: now, updated_at: now })),
      daily_values: daily.map((v) => ({ value_date: v.date, cash: v.cash, cash_set_at: now, price: v.price, price_set_at: now, version: 1, created_at: now, updated_at: now })),
      calc_snapshots: [], people: [], debt_entries: [], audit_log: [],
    };
    const checksum = (await db.admin('select md5($1::jsonb::text) m', [JSON.stringify(data)]))[0].m;
    const L = new Ledger(db.session(await db.createUser()));
    const timings: Record<string, number> = {};
    const time = async <T>(k: string, f: () => Promise<T>) => { const t = performance.now(); const v = await f(); timings[k] = Math.round(performance.now() - t); return v; };

    await time('restore_10000', () => L.s.rpc('restore_backup', { p_request_id: randomUUID(), p_expected_data_version: 0,
      p_file: { format: 'gold-ledger-backup', schema_version: 1, checksum, data } }));

    const qOpen = new Decimal('-50000'), wOpen = new Decimal('100'), iOpen = new Decimal('12345.67');
    const sample = Array.from({ length: 25 }, () => daily[Math.floor(r() * daily.length)]);
    const t0 = performance.now();
    for (const v of sample) {
      const rep = await L.report(v.date);
      const ref = reference(qOpen, wOpen, iOpen, qat, insta, v.date, new Decimal(v.cash), new Decimal(v.price));
      expect(dec(rep.qat.q)).toBe(dec(ref.q.toFixed(2)));
      expect(dec(rep.qat.net_weight)).toBe(dec(ref.w.toFixed(6)));
      expect(dec(rep.insta.i)).toBe(dec(ref.i.toFixed(2)));
      expect(dec(rep.result.d)).toBe(dec(ref.d.toFixed(2)));
      expect(dec(rep.result.grams)).toBe(dec(ref.grams.toFixed(6)));
      expect(rep.result.decision).toBe(ref.d.gt(0) ? 'sell' : ref.d.lt(0) ? 'buy' : 'balanced');
    }
    timings.day_report_avg = Math.round((performance.now() - t0) / sample.length);

    // تصفح كل الصفحات: مجموعها = إجمالي الدفتر، والإجمالي لا يساوي مجموع الصفحة الظاهرة
    let pages = 0; let sumMoney = new Decimal(0); let seen = 0; let firstPage: any;
    const tp = performance.now();
    for (let off = 0; ; off += 500) {
      const pg = await L.s.rpc('list_qat_entries', { p_limit: 500, p_offset: off, p_order: 'asc' });
      if (!firstPage) firstPage = pg;
      if (pg.rows.length === 0) break;
      pages++; seen += pg.rows.length;
      for (const row of pg.rows) sumMoney = sumMoney.plus(['buy', 'cash_add'].includes(row.entry_type) ? row.amount : new Decimal(row.amount).neg());
    }
    timings.qat_page_avg = Math.round((performance.now() - tp) / (pages + 1));
    expect(seen).toBe(6000);
    expect(pages).toBe(12);
    const refEnd = reference(qOpen, wOpen, iOpen, qat, insta, '2100-01-01', null, null);
    expect(dec(firstPage.book.money)).toBe(dec(refEnd.q.toFixed(2)));
    expect(dec(qOpen.plus(sumMoney).toFixed(2))).toBe(dec(refEnd.q.toFixed(2)));
    expect(firstPage.filtered.count).toBe('6000');
    const lastRunning = (await L.s.rpc('list_qat_entries', { p_limit: 1 })).rows[0].running_money;
    expect(dec(lastRunning)).toBe(dec(refEnd.q.toFixed(2)));

    // البحث بالاسم: مجموع النتائج كلها وليس الصفحة
    const s = await time('search_trader', () => L.s.rpc('list_qat_entries', { p_search: 'تاجر 7', p_limit: 20 }));
    const match = qat.filter((e) => e.trader && e.trader.includes('تاجر 7'));
    expect(s.filtered.count).toBe(String(match.length));
    expect(dec(s.filtered.buy_weight)).toBe(dec(match.filter((e) => e.type === 'buy').reduce((a, e) => a.plus(e.weight!), new Decimal(0)).toFixed(6)));
    expect(s.rows).toHaveLength(20);
    // كشف فترة
    const per = await time('period_statement', () => L.s.rpc('list_insta_entries', { p_from: '2025-03-01', p_to: '2025-03-31', p_limit: 50 }));
    const before = reference(qOpen, wOpen, iOpen, qat, insta, '2025-02-28', null, null).i;
    const end = reference(qOpen, wOpen, iOpen, qat, insta, '2025-03-31', null, null).i;
    expect(dec(per.period.before_money)).toBe(dec(before.toFixed(2)));
    expect(dec(per.period.end_money)).toBe(dec(end.toFixed(2)));
    expect(dec(new Decimal(per.period.before_money).plus(per.period.period_money).toFixed(2))).toBe(dec(per.period.end_money));
    await time('export_10000', () => L.exportBackup());
    // كتابة 200 حركة عبر RPC
    const tw = performance.now();
    for (let k = 0; k < 200; k++) await L.insta('2025-12-31', 'in', '1.00');
    timings.rpc_write_avg = Math.round((performance.now() - tw) / 200);
    console.log('T18_TIMINGS_MS', JSON.stringify(timings));
    expect(timings.day_report_avg).toBeLessThan(2000);
  });
});

describe('خصائص (Property tests) ببيانات متعددة', () => {
  it('ترتيب إدخال الحركات لا يغير الإجماليات؛ إضافة وتسوية عكسية تعيد الرصيد؛ الحركات المستقبلية لا تؤثر على الماضي', async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = rng(seed * 7919);
      const entries: (Q | I)[] = [];
      for (let k = 0; k < 30; k++) {
        const date = addDays('2026-01-01', Math.floor(r() * 10));
        if (r() < 0.6) {
          const weight = fix(r, 0.001, 20, 6).toFixed(6), price = fix(r, 1, 7000, 2).toFixed(2);
          const amount = new Decimal(weight).times(price).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
          if (amount === '0.00') continue;
          entries.push({ date, type: r() < 0.5 ? 'buy' : 'sell', weight, price, amount } as Q);
        } else {
          entries.push({ date, type: r() < 0.5 ? 'in' : 'out', amount: fix(r, 0.01, 9999, 2).toFixed(2) } as I);
        }
      }
      const results: any[] = [];
      for (const order of [0, 1, 2]) {
        const list = [...entries];
        if (order === 1) list.reverse();
        if (order === 2) list.sort(() => r() - 0.5);
        const L = new Ledger(db.session(await db.createUser()));
        await L.setup();
        await L.opening('qat', '2026-01-01', '1000.50', '3.5');
        await L.opening('insta', '2026-01-01', '-20');
        for (const e of list) {
          if (e.type === 'in' || e.type === 'out') await L.insta(e.date, e.type, e.amount);
          else await L.s.rpc('add_qat_entry', { p_request_id: L.rid(), p_entry_date: e.date, p_entry_type: e.type, p_weight: (e as Q).weight, p_unit_price: (e as Q).price });
        }
        await L.daily('2026-01-10', 'cash', '500');
        await L.daily('2026-01-10', 'price', '3333.33');
        const day5Before = await L.report('2026-01-05');
        const rep = await L.report('2026-01-10');
        // مستقبل: حركة بتاريخ 2026-01-20 لا تغير تقرير يوم 5 و10
        await L.buy('2026-01-20', '5', '100');
        await L.insta('2026-01-20', 'out', '99');
        const day5After = await L.report('2026-01-05');
        expect({ ...day5After, snapshots: 0, data_version: 0 }).toEqual({ ...day5Before, snapshots: 0, data_version: 0 });
        expect((await L.report('2026-01-10')).result).toEqual(rep.result);
        // إضافة ثم تسوية عكسية مساوية
        await L.adjust('2026-01-10', 'cash_add', '123.45');
        await L.adjust('2026-01-10', 'cash_deduct', '123.45');
        await L.insta('2026-01-10', 'in', '77.77');
        await L.insta('2026-01-10', 'out', '77.77');
        expect((await L.report('2026-01-10')).result.d).toBe(rep.result.d);
        results.push({ q: rep.qat.q, w: rep.qat.net_weight, i: rep.insta.i, d: rep.result.d, g: rep.result.grams });
      }
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toEqual(results[0]);
      const ref = reference(new Decimal('1000.50'), new Decimal('3.5'), new Decimal('-20'), entries.filter((e) => 'weight' in e) as Q[],
        entries.filter((e) => e.type === 'in' || e.type === 'out') as I[], '2026-01-10', new Decimal(500), new Decimal('3333.33'));
      expect(dec(results[0].q)).toBe(dec(ref.q.toFixed(2)));
      expect(dec(results[0].w)).toBe(dec(ref.w.toFixed(6)));
      expect(dec(results[0].i)).toBe(dec(ref.i.toFixed(2)));
      expect(dec(results[0].d)).toBe(dec(ref.d.toFixed(2)));
      expect(dec(results[0].g)).toBe(dec(ref.grams.toFixed(6)));
    }
  });

  it('أي تغيير في «الباقي على الناس» لا يغير Q/I/C/D؛ والتصحيح لا يمحو النسخ المحفوظة', async () => {
    const r = rng(99);
    const L = new Ledger(db.session(await db.createUser()));
    await L.setup();
    await L.opening('qat', '2026-01-01', '5000', '0');
    await L.opening('insta', '2026-01-01', '100');
    await L.daily('2026-01-03', 'cash', '1000');
    await L.daily('2026-01-03', 'price', '2500');
    const e = await L.buy('2026-01-02', '1', '2500');
    await L.saveCalc('2026-01-03');
    const snapBefore = (await L.s.rpc('list_calc_snapshots', {})).rows[0];
    const shop = async () => { const x = await L.report('2026-01-03'); return [x.qat, x.insta, x.cash, x.price, x.result, x.fingerprint]; };
    const before = await shop();
    const ids: string[] = [];
    for (let k = 0; k < 5; k++) ids.push((await L.person(`شخص ${k}`)).id);
    for (let k = 0; k < 40; k++) {
      const p = ids[Math.floor(r() * ids.length)];
      const bal = new Decimal((await L.s.rpc('get_person', { p_id: p })).remaining);
      if (bal.gt(0) && r() < 0.5) await L.debt(p, '2026-01-03', 'repaid', Decimal.min(bal, fix(r, 0.01, 500, 2)).toFixed(2));
      else await L.debt(p, '2026-01-02', 'sent', fix(r, 0.01, 1000, 2).toFixed(2));
    }
    expect(await shop()).toEqual(before);
    // تصحيحات متعددة للقطعية بعد الحفظ
    let v = 1;
    for (const w of ['2', '3', '1.5']) {
      await L.s.rpc('update_qat_entry', { p_request_id: L.rid(), p_id: e.entry.id, p_expected_version: v++, p_entry_date: '2026-01-02',
        p_entry_type: 'buy', p_weight: w, p_unit_price: '2500', p_change_reason: 'تصحيح ' + w });
    }
    const rows = (await L.s.rpc('list_calc_snapshots', {})).rows;
    expect(rows).toHaveLength(1);
    const { stale, current, ...orig } = rows[0];
    const { stale: s0, current: c0, ...orig0 } = snapBefore;
    expect(orig).toEqual(orig0);
    expect(stale).toBe(true);
    expect((await L.s.rpc('list_audit', { p_entity: 'qat_entries', p_record_id: e.entry.id })).rows).toHaveLength(4);
  });
});

describe('T17 حدود التاريخ', () => {
  it('منتصف الليل بتوقيت القاهرة مع/بدون التوقيت الصيفي، ونهاية شهر/سنة، واختلاف تاريخ الإدخال عن العملية', async () => {
    const conv = async (ts: string) => (await db.admin(`select ($1::timestamptz at time zone 'Africa/Cairo')::date::text d`, [ts]))[0].d;
    // صيف 2026 (UTC+3): 21:00Z = منتصف الليل
    expect(await conv('2026-10-22T20:59:59Z')).toBe('2026-10-22');
    expect(await conv('2026-10-22T21:00:00Z')).toBe('2026-10-23');
    // بعد انتهاء التوقيت الصيفي (UTC+2)
    expect(await conv('2026-11-15T21:59:59Z')).toBe('2026-11-15');
    expect(await conv('2026-11-15T22:00:00Z')).toBe('2026-11-16');
    // نهاية سنة
    expect(await conv('2026-12-31T21:59:59Z')).toBe('2026-12-31');
    expect(await conv('2026-12-31T22:00:00Z')).toBe('2027-01-01');
    const L = new Ledger(db.session(await db.createUser()));
    await L.setup();
    await L.opening('insta', '2026-01-01', '0');
    await L.opening('qat', '2026-01-01', '0', '0');
    await L.insta('2026-01-31', 'in', '1');
    await L.insta('2026-02-01', 'in', '2');
    await L.insta('2026-12-31', 'in', '4');
    await L.insta('2027-01-01', 'in', '8');
    await L.insta('2028-02-29', 'in', '16');
    expect(dec((await L.report('2026-01-31')).insta.i)).toBe('1');
    expect(dec((await L.report('2026-02-01')).insta.i)).toBe('3');
    expect(dec((await L.report('2026-12-31')).insta.i)).toBe('7');
    expect(dec((await L.report('2027-01-01')).insta.i)).toBe('15');
    expect(dec((await L.report('2028-02-29')).insta.i)).toBe('31');
    // تاريخ الإدخال (created_at = الآن) مختلف عن تاريخ العملية؛ حركات اليوم تعتمد تاريخ العملية
    const st = await L.state();
    const today = st.cairo_today;
    const rep = await L.report(today);
    expect(rep.day_entries.insta.every((x: any) => x.entry_date === today)).toBe(true);
    const jan = await L.report('2026-01-31');
    expect(jan.day_entries.insta).toHaveLength(1);
    expect(jan.day_entries.insta[0].created_at.slice(0, 10)).not.toBe('2026-01-31');
  });
});

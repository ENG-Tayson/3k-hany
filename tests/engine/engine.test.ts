import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { addDays, cairoToday, isValidDate } from '../../src/lib/dates';
import { decide, formatMoney, formatWeight, fromUnits, gramsText, lineAmount, parseMoney, parsePrice, parseUserNumber, parseWeight, sumMoney, toUnits } from '../../src/lib/money';

// كل التوقعات مكتوبة يدويًا من المواصفات، ولا تُشتق من دوال الإنتاج.

describe('T04 اتجاه القرار (محرك الواجهة)', () => {
  it('Q=100000 I=20000 P=5000', () => {
    expect(decide('100000', '20000', '60000', '5000')).toMatchObject({ d: '20000.00', decision: 'sell', grams: '4.000000', gramsApprox: false });
    expect(decide('100000', '20000', '100000', '5000')).toMatchObject({ d: '-20000.00', absD: '20000.00', decision: 'buy', grams: '4.000000' });
    expect(decide('100000', '20000', '80000', '5000')).toMatchObject({ d: '0.00', decision: 'balanced', grams: '0.000000', gramsBelowMin: false });
  });
  it('T05 الأيام 15/16/17', () => {
    expect(decide('130000', '40000', '70000', '5000')).toMatchObject({ a: '110000.00', d: '20000.00', decision: 'sell', grams: '4.000000' });
    expect(decide('100000', '30000', '90000', '5000')).toMatchObject({ a: '120000.00', d: '-20000.00', decision: 'buy', grams: '4.000000' });
    expect(decide('100000', '30000', '70000', '6000')).toMatchObject({ a: '100000.00', d: '0.00', decision: 'balanced' });
    expect(decide('130000', '41000', '70000', '5000')).toMatchObject({ d: '19000.00', decision: 'sell', grams: '3.800000' });
  });
});

describe('T11 الإشارات', () => {
  it('Q=-1000 I=0 C=0 P=5000 → D=-1000 شراء 0.2', () => {
    expect(decide('-1000', '0', '0', '5000')).toMatchObject({ d: '-1000.00', decision: 'buy', grams: '0.200000' });
  });
  it('I سالب', () => {
    expect(decide('1000', '-500', '0', '100')).toMatchObject({ a: '-500.00', d: '1500.00', decision: 'sell', grams: '15.000000' });
  });
});

describe('T07 السعر المفقود/غير الصالح', () => {
  it('لا وزن ولا NaN/Infinity', () => {
    expect(decide('100', '0', '40', null)).toMatchObject({ d: '60.00', grams: null, gramsStatus: 'price_missing' });
    expect(decide('100', '0', '40', '0')).toMatchObject({ grams: null, gramsStatus: 'price_invalid' });
    expect(decide('100', '0', '40', '-5')).toMatchObject({ grams: null, gramsStatus: 'price_invalid' });
  });
});

describe('T09 الدقة', () => {
  it('قيم القطعيات HALF_UP', () => {
    expect(lineAmount('0.001', '5000')).toBe('5.00');
    expect(lineAmount('1.001', '12.34')).toBe('12.35');
    expect(lineAmount('0.005', '1.00')).toBe('0.01');
    expect(lineAmount('0.004', '1.00')).toBe('0.00');
    expect(lineAmount('10', '5000')).toBe('50000.00');
    expect(lineAmount('999999.999999', '9999999999.99')).toBe('9999999999980000.00') // (10^6 − 10^-6)(10^10 − 0.01) = 10^16 − 20000 + 10^-8;
  });
  it('0.1 + 0.2 = 0.3 بالضبط، وجمع متكرر', () => {
    expect(sumMoney(['0.1', '0.2'])).toBe('0.30');
    expect(sumMoney(Array(1000).fill('0.01'))).toBe('10.00');
    expect(sumMoney(Array(100000).fill('0.07'))).toBe('7000.00');
    expect(sumMoney(['99999999999.99', '0.01', '-100000000000.00'])).toBe('0.00');
  });
  it('1000 / 3000 = 0.333333 تقريبي؛ 0.01 / 100000 أقل من 0.000001', () => {
    const a = decide('1000', '0', '0', '3000');
    expect(a).toMatchObject({ d: '1000.00', decision: 'sell', grams: '0.333333', gramsApprox: true, gramsBelowMin: false });
    expect(gramsText(a.grams, a.gramsApprox, a.gramsBelowMin)).toBe('تقريبًا 0.333333 جرام');
    const b = decide('0.01', '0', '0', '100000');
    expect(b).toMatchObject({ d: '0.01', decision: 'sell', grams: '0.000000', gramsApprox: true, gramsBelowMin: true });
    expect(gramsText(b.grams, b.gramsApprox, b.gramsBelowMin)).toBe('أقل من 0.000001 جرام');
    expect(decide('2', '0', '0', '3').grams).toBe('0.666667');
    expect(decide('0.06', '0', '0', '100000').grams).toBe('0.000001'); // 0.0000006 → HALF_UP
    expect(decide('0.05', '0', '0', '100000').grams).toBe('0.000001'); // 0.0000005 → HALF_UP
    expect(decide('0.04', '0', '0', '100000').gramsBelowMin).toBe(true);
  });
  it('تحويل الوحدات بدون فقد', () => {
    expect(toUnits('123.45', 2)).toBe(12345n);
    expect(toUnits('-0.01', 2)).toBe(-1n);
    expect(fromUnits(-1n, 2)).toBe('-0.01');
    expect(toUnits('5.000000', 6)).toBe(5000000n);
    expect(() => toUnits('1.001', 2)).toThrow();
    expect(toUnits('1.000', 2)).toBe(100n);
  });
});

describe('T10 الإدخال', () => {
  const m = (s: string, sign: 'positive' | 'nonneg' | 'any' = 'positive') => parseMoney(s, sign);
  it('أرقام عربية وإنجليزية وفاصل عشري عربي', () => {
    expect(m('١٢٣٤٫٥')).toEqual({ ok: true, value: '1234.5' });
    expect(m('۱۲۳')).toEqual({ ok: true, value: '123' });
    expect(m('1234.50')).toEqual({ ok: true, value: '1234.50' });
    expect(m('  ٥٠٠٠  ')).toEqual({ ok: true, value: '5000' });
    expect(parseWeight('٠٫٠٠١')).toEqual({ ok: true, value: '0.001' });
  });
  it('فواصل الآلاف الصحيحة والخاطئة', () => {
    expect(m('1,250,000.50')).toEqual({ ok: true, value: '1250000.50' });
    expect(m('١٬٢٥٠٬٠٠٠')).toEqual({ ok: true, value: '1250000' });
    expect(m('1,25,000').ok).toBe(false);
    expect(m('1,5').ok).toBe(false);
    expect(m('12,34.5').ok).toBe(false);
    expect(m('1،5').ok).toBe(false);
  });
  it('الفارغ والنص والسالب والكسور الزائدة والحدود', () => {
    for (const s of ['', '   ', 'abc', '1e5', 'NaN', 'Infinity', '1.2.3', '--1', '١٠ جنيه', '0x10', '.5', '5.']) expect(m(s).ok, s).toBe(false);
    expect(parseMoney(null)).toEqual({ ok: false, error: 'القيمة مطلوبة' });
    expect(m('-5').ok).toBe(false);
    expect(m('0').ok).toBe(false);
    expect(m('0', 'nonneg')).toEqual({ ok: true, value: '0' });
    expect(m('-0', 'nonneg')).toEqual({ ok: true, value: '0' });
    expect(m('-1000', 'any')).toEqual({ ok: true, value: '-1000' });
    expect(m('−1000', 'any')).toEqual({ ok: true, value: '-1000' }); // علامة ناقص يونيكود
    expect(m('10.001')).toEqual({ ok: false, error: 'الحد الأقصى 2 منازل عشرية' });
    expect(parseWeight('1.0000001').ok).toBe(false);
    expect(parseWeight('1.000001')).toEqual({ ok: true, value: '1.000001' });
    expect(m('999999999999.99')).toEqual({ ok: true, value: '999999999999.99' });
    expect(m('1000000000000').ok).toBe(false);
    expect(parsePrice('10000000000').ok).toBe(false);
    expect(parseUserNumber('007', { scale: 0, maxIntDigits: 3, sign: 'positive' })).toEqual({ ok: true, value: '7' });
  });
  it('علامات اتجاه النص المخفية تُزال ولا تمر نصوص HTML', () => {
    expect(m('‏1500‎')).toEqual({ ok: true, value: '1500' });
    expect(m('<b>5</b>').ok).toBe(false);
  });
});

describe('التنسيق', () => {
  it('المال والوزن', () => {
    expect(formatMoney('130500')).toBe('130,500.00');
    expect(formatMoney('-1000.5')).toBe('-1,000.50');
    expect(formatMoney('0.00')).toBe('0.00');
    expect(formatMoney(null)).toBe('—');
    expect(formatWeight('6.000000')).toBe('6');
    expect(formatWeight('0.333333')).toBe('0.333333');
    expect(formatWeight('-1234.5')).toBe('-1,234.5');
  });
});

describe('T17 التاريخ بتوقيت القاهرة في الواجهة', () => {
  it('منتصف الليل والتوقيت الصيفي ونهاية السنة', () => {
    expect(cairoToday(new Date('2026-10-22T20:59:59Z'))).toBe('2026-10-22');
    expect(cairoToday(new Date('2026-10-22T21:00:00Z'))).toBe('2026-10-23');
    expect(cairoToday(new Date('2026-11-15T21:59:59Z'))).toBe('2026-11-15');
    expect(cairoToday(new Date('2026-11-15T22:00:00Z'))).toBe('2026-11-16');
    expect(cairoToday(new Date('2026-12-31T22:00:00Z'))).toBe('2027-01-01');
    expect(cairoToday(new Date('2026-04-30T21:30:00Z'))).toBe('2026-05-01'); // بعد بدء الصيفي
  });
  it('التاريخ النصي لا ينتقل بسبب UTC', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(isValidDate('2028-02-29')).toBe(true);
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate('2026-13-01')).toBe(false);
    expect(isValidDate('1999-12-31')).toBe(false);
  });
});

describe('خصائص بمرجع مستقل (decimal.js)', () => {
  function rng(seed: number) {
    return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  }
  it('lineAmount وdecide تطابق decimal.js على 20,000 حالة عشوائية', () => {
    Decimal.set({ precision: 80 });
    const r = rng(42);
    for (let k = 0; k < 20000; k++) {
      const w = new Decimal(Math.floor(r() * 1e9)).div(1e6).toFixed(6);
      const p = new Decimal(Math.floor(r() * 1e9) + 1).div(100).toFixed(2);
      expect(lineAmount(w, p)).toBe(new Decimal(w).times(p).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2));
      const q = new Decimal(Math.floor((r() - 0.5) * 1e12)).div(100).toFixed(2);
      const i = new Decimal(Math.floor((r() - 0.5) * 1e10)).div(100).toFixed(2);
      const c = new Decimal(Math.floor(r() * 1e11)).div(100).toFixed(2);
      const res = decide(q, i, c, p);
      const D = new Decimal(q).minus(new Decimal(c).plus(i));
      expect(res.d).toBe(D.toFixed(2));
      expect(res.decision).toBe(D.gt(0) ? 'sell' : D.lt(0) ? 'buy' : 'balanced');
      expect(res.grams).toBe(D.abs().div(p).toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6));
    }
  });
  it('ترتيب الجمع لا يغير الإجمالي؛ إضافة ثم عكسها تعيد الرصيد', () => {
    const r = rng(7);
    const vals = Array.from({ length: 500 }, () => new Decimal(Math.floor((r() - 0.5) * 1e8)).div(100).toFixed(2));
    const total = sumMoney(vals);
    expect(sumMoney([...vals].reverse())).toBe(total);
    expect(sumMoney([...vals].sort())).toBe(total);
    expect(sumMoney([...vals, '123.45', '-123.45'])).toBe(total);
    expect(total).toBe(vals.reduce((a, v) => a.plus(v), new Decimal(0)).toFixed(2));
  });
});

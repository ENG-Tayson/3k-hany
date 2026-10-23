// محرك الأرقام في الواجهة: أعداد صحيحة BigInt فقط (قروش للمال بمنزلتين، ميكروجرام للوزن بـ6 منازل).
// لا floating-point في أي حساب مالي. المصدر المعتمد للأرصدة هو قاعدة البيانات؛ هنا المعاينة والتنسيق والتحقق.

export const MONEY_SCALE = 2;
export const WEIGHT_SCALE = 6;

export type Sign = 'positive' | 'nonneg' | 'any';
export type ParseResult = { ok: true; value: string } | { ok: false; error: string };

const ARABIC_DIGITS = /[٠-٩]/g;
const PERSIAN_DIGITS = /[۰-۹]/g;
const BIDI_MARKS = /[‎‏؜‪-‮⁦-⁩]/g;

/**
 * يحلل رقمًا كتبه المستخدم: أرقام عربية أو إنجليزية، الفاصل العشري «.» أو «٫»،
 * وفواصل آلاف «,» أو «٬» بمجموعات صحيحة من 3 أرقام. يرفض الغموض بدل التخمين،
 * ويرفض الكسور الزائدة بدل التقريب. لا يحوّل الفارغ إلى صفر.
 */
export function parseUserNumber(input: string | null | undefined, opts: { scale: number; maxIntDigits: number; sign: Sign }): ParseResult {
  if (input === null || input === undefined) return { ok: false, error: 'القيمة مطلوبة' };
  let s = String(input)
    .replace(BIDI_MARKS, '')
    .replace(ARABIC_DIGITS, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(PERSIAN_DIGITS, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',')
    .replace(/−/g, '-')
    .trim();
  if (s === '') return { ok: false, error: 'القيمة مطلوبة' };
  if (s.includes('،')) return { ok: false, error: 'الفاصلة «،» غير واضحة: استخدم «.» أو «٫» للكسور' };
  const m = /^([+-])?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) {
    if (/^[+-]?[\d,]+(\.\d+)?$/.test(s)) return { ok: false, error: 'فواصل الآلاف غير صحيحة (مثال صحيح: 1,250,000.50)' };
    if (/\d\.\d*\./.test(s)) return { ok: false, error: 'رقم غير صالح: أكثر من فاصل عشري' };
    return { ok: false, error: 'رقم غير صالح' };
  }
  const neg = m[1] === '-';
  const intPart = m[2].replace(/,/g, '').replace(/^0+(?=\d)/, '');
  const frac = m[3] ?? '';
  if (frac.length > opts.scale) return { ok: false, error: `الحد الأقصى ${opts.scale} منازل عشرية` };
  if (intPart.replace(/^0+/, '').length > opts.maxIntDigits) return { ok: false, error: 'الرقم أكبر من الحد المسموح' };
  const isZero = /^0*$/.test(intPart) && /^0*$/.test(frac);
  if (neg && !isZero && opts.sign !== 'any') return { ok: false, error: 'القيمة السالبة غير مسموحة' };
  if (opts.sign === 'positive' && (isZero || neg)) return { ok: false, error: 'يجب أن تكون القيمة أكبر من صفر' };
  const value = (neg && !isZero ? '-' : '') + intPart + (frac ? '.' + frac : '');
  return { ok: true, value };
}

export const parseMoney = (s: string | null | undefined, sign: Sign = 'positive') => parseUserNumber(s, { scale: 2, maxIntDigits: 12, sign });
export const parsePrice = (s: string | null | undefined) => parseUserNumber(s, { scale: 2, maxIntDigits: 10, sign: 'positive' });
export const parseWeight = (s: string | null | undefined, sign: Sign = 'positive') => parseUserNumber(s, { scale: 6, maxIntDigits: sign === 'any' ? 8 : 6, sign });

/** نص عشري → عدد صحيح بوحدات 10^-scale (يرفض الكسور الزائدة) */
export function toUnits(s: string, scale: number): bigint {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`invalid decimal: ${s}`);
  const frac = m[3] ?? '';
  if (frac.length > scale) {
    if (/[1-9]/.test(frac.slice(scale))) throw new Error(`too many decimals: ${s}`);
  }
  const v = BigInt(m[2] + frac.slice(0, scale).padEnd(scale, '0'));
  return m[1] ? -v : v;
}

export function fromUnits(v: bigint, scale: number): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(scale);
  const i = a / base;
  const f = a % base;
  const s = scale > 0 ? `${i}.${f.toString().padStart(scale, '0')}` : `${i}`;
  return neg && a !== 0n ? '-' + s : s;
}

/** قسمة موجبة مع تقريب HALF_UP */
export function divHalfUp(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error('divisor must be positive');
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = (2n * a + d) / (2n * d);
  return neg ? -q : q;
}

/** قيمة القطعية = الوزن × السعر مقربة HALF_UP لقرش واحد */
export function lineAmount(weight: string, price: string): string {
  const w = toUnits(weight, WEIGHT_SCALE);
  const p = toUnits(price, MONEY_SCALE);
  return fromUnits(divHalfUp(w * p, 10n ** BigInt(WEIGHT_SCALE)), MONEY_SCALE);
}

export function sumMoney(values: string[]): string {
  return fromUnits(values.reduce((a, v) => a + toUnits(v, MONEY_SCALE), 0n), MONEY_SCALE);
}

export type Decision = 'sell' | 'buy' | 'balanced';
export type DecisionResult = {
  a: string; d: string; absD: string; decision: Decision;
  grams: string | null; gramsApprox: boolean; gramsBelowMin: boolean;
  gramsStatus: 'ok' | 'price_missing' | 'price_invalid';
};

/** D = Q − (C + I). موجب: بيع؛ سالب: شراء؛ صفر: متوازن. الجرامات = |D| / P (6 منازل HALF_UP) */
export function decide(q: string, i: string, c: string, p: string | null): DecisionResult {
  const Q = toUnits(q, MONEY_SCALE), I = toUnits(i, MONEY_SCALE), C = toUnits(c, MONEY_SCALE);
  const A = C + I;
  const D = Q - A;
  const absD = D < 0n ? -D : D;
  const decision: Decision = D > 0n ? 'sell' : D < 0n ? 'buy' : 'balanced';
  let grams: string | null = null, gramsApprox = false, gramsBelowMin = false;
  let gramsStatus: DecisionResult['gramsStatus'] = 'ok';
  if (p === null || p === undefined || p === '') gramsStatus = 'price_missing';
  else {
    const P = toUnits(p, MONEY_SCALE);
    if (P <= 0n) gramsStatus = 'price_invalid';
    else {
      const g6 = divHalfUp(absD * 1_000_000n, P);
      grams = fromUnits(g6, WEIGHT_SCALE);
      gramsApprox = (absD * 1_000_000n) % P !== 0n;
      gramsBelowMin = absD > 0n && g6 === 0n;
    }
  }
  return { a: fromUnits(A, 2), d: fromUnits(D, 2), absD: fromUnits(absD, 2), decision, grams, gramsApprox, gramsBelowMin, gramsStatus };
}

// ---------------------------------------------------------------- تنسيق العرض
function group(intDigits: string) {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 130500 → "130,500.00" ؛ يحافظ على الإشارة */
export function formatMoney(v: string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const s = fromUnits(toUnits(v, 2), 2);
  const neg = s.startsWith('-');
  const [i, f] = s.replace('-', '').split('.');
  return (neg ? '-' : '') + group(i) + '.' + f;
}

/** وزن حتى 6 منازل بدون أصفار زائدة: 6.000000 → "6" ؛ 0.333333 → "0.333333" */
export function formatWeight(v: string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const s = fromUnits(toUnits(v, 6), 6);
  const neg = s.startsWith('-');
  let [i, f] = s.replace('-', '').split('.');
  f = f.replace(/0+$/, '');
  return (neg ? '-' : '') + group(i) + (f ? '.' + f : '');
}

export function isNegative(v: string | null | undefined) {
  return !!v && v.trim().startsWith('-') && toUnits(v, 6) !== 0n;
}
export function isZero(v: string | null | undefined) {
  return !!v && toUnits(v, 6) === 0n;
}
export function absStr(v: string) {
  return v.trim().replace(/^-/, '');
}

/** نص الوزن للعرض في نتيجة الحسبة */
export function gramsText(grams: string | null, approx: boolean, belowMin: boolean): string {
  if (grams === null) return '';
  if (belowMin) return 'أقل من 0.000001 جرام';
  return `${approx ? 'تقريبًا ' : ''}${formatWeight(grams)} جرام`;
}

// تواريخ العمل LocalDate نصية YYYY-MM-DD بتوقيت Africa/Cairo. لا new Date('YYYY-MM-DD') لأنه يُفسَّر UTC.

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' });

export function cairoToday(now: Date = new Date()): string {
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function isValidDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return d <= days && y >= 2000 && y <= 2100;
}

/** يضيف أيامًا لتاريخ نصي بحساب تقويمي بحت (UTC داخليًا للحساب فقط) */
export function addDays(s: string, n: number): string {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const AR_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
export function formatDateAr(s: string | null | undefined): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${AR_DAYS[dow]} ${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
}

/** تاريخ العمل للعرض والإدخال: سنة/شهر/يوم (2026/10/15) */
export function toDisplayDate(iso: string): string {
  return iso ? iso.replace(/-/g, '/') : '';
}

/** يقبل ما يكتبه المستخدم: 2026/10/15 أو 2026-10-15 أو ٢٠٢٦/١٠/١٥ (وبدون أصفار: 2026/1/5) → 2026-10-15، أو '' إذا لم يكن تاريخًا صالحًا */
export function parseDisplayDate(input: string): string {
  const s = input.trim()
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
  const m = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/.exec(s);
  if (!m) return '';
  const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return isValidDate(iso) ? iso : '';
}

/** وقت الإدخال (timestamptz) معروضًا بتوقيت القاهرة */
export function formatTimestamp(ts: string | null | undefined): string {
  if (!ts) return '—';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ts));
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${g('year')}/${g('month')}/${g('day')} ${g('hour')}:${g('minute')}`;
}

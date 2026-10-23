import { useState, type ReactNode } from 'react';
import type { SaveState } from './lib/api';
import { cairoToday, formatDateAr, isValidDate } from './lib/dates';
import { absStr, formatMoney, formatWeight, isNegative } from './lib/money';

export function SaveStatus({ state, onRetry }: { state: SaveState; onRetry?: () => void }) {
  if (state.status === 'idle') return null;
  if (state.status === 'saving') return <div className="status saving" role="status">جارٍ الحفظ…</div>;
  if (state.status === 'saved') return <div className="status ok" role="status">✔ تم الحفظ في قاعدة البيانات{state.replayed ? ' (تأكد من الطلب السابق، لم يُكرر)' : ''}</div>;
  const title = state.kind === 'unknown' ? 'تعذر تأكيد الحفظ' : 'لم يتم الحفظ';
  return (
    <div className="status fail" role="alert">
      <strong>✖ {title}:</strong> {state.message}
      {state.kind === 'unknown' && <div className="hint">ربما وصل الطلب للخادم. «إعادة المحاولة» تستخدم نفس معرّف الطلب فلا تتكرر الحركة.</div>}
      {state.kind === 'offline' && <div className="hint">البيانات ما زالت في النموذج. أعد المحاولة بعد عودة الاتصال.</div>}
      {onRetry && state.kind !== 'server' && <button type="button" className="btn small" onClick={onRetry}>إعادة المحاولة</button>}
    </div>
  );
}

export function Field({ label, error, children, hint }: { label: string; error?: string | null; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className={'field' + (error ? ' has-error' : '')}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
      {error && <span className="error" role="alert">{error}</span>}
    </label>
  );
}

export function NumInput(props: { value: string; onChange: (v: string) => void; name: string; placeholder?: string }) {
  return <input className="num" inputMode="decimal" dir="ltr" autoComplete="off" name={props.name} value={props.value}
    placeholder={props.placeholder} onChange={(e) => props.onChange(e.target.value)} />;
}

export function DateInput({ value, onChange, name }: { value: string; onChange: (v: string) => void; name: string }) {
  return <input type="date" name={name} value={value} min="2000-01-01" max="2100-12-31" onChange={(e) => onChange(e.target.value)} />;
}

export function Money({ v, signed }: { v: string | null | undefined; signed?: boolean }) {
  if (v === null || v === undefined) return <span className="muted">—</span>;
  return <span className={'money' + (signed && isNegative(v) ? ' neg' : '')} dir="ltr">{formatMoney(v)}</span>;
}
export function Weight({ v }: { v: string | null | undefined }) {
  if (v === null || v === undefined) return <span className="muted">—</span>;
  return <span className="money" dir="ltr">{formatWeight(v)}</span>;
}

/** رصيد القطعيات بالوصف: موجب = «عليك للتاجر»، سالب = «لك عند التاجر» */
export function TraderBalance({ v }: { v: string | null | undefined }) {
  if (v === null || v === undefined) return <span className="muted">—</span>;
  const neg = isNegative(v);
  return <span><span className="money" dir="ltr">{formatMoney(absStr(v))}</span> <span className="tag">{neg ? 'لك عند التاجر' : 'عليك للتاجر'}</span></span>;
}

/** تأكيد قبل الحفظ بتاريخ غير اليوم */
export function useRetroConfirm(date: string) {
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const today = cairoToday();
  const needs = isValidDate(date) && date !== today && confirmed !== date;
  const box = needs ? (
    <div className="retro" role="alert">
      ⚠ تاريخ العملية <strong>{formatDateAr(date)}</strong> وليس اليوم ({formatDateAr(today)}). ستؤثر الحركة في تقارير هذا التاريخ وما بعده.
      <button type="button" className="btn small" onClick={() => setConfirmed(date)}>نعم، الحفظ بتاريخ {date}</button>
    </div>
  ) : null;
  return { needsConfirm: needs, box, reset: () => setConfirmed(null) };
}

export function Pager({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (o: number) => void }) {
  if (total <= limit) return null;
  const page = Math.floor(offset / limit) + 1, pages = Math.ceil(total / limit);
  return (
    <div className="pager no-print">
      <button className="btn small" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>السابق</button>
      <span>صفحة {page} من {pages} ({total} حركة)</span>
      <button className="btn small" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>التالي</button>
    </div>
  );
}

export function Stale({ loadedAt, error }: { loadedAt: number | null; error: string | null }) {
  if (!error) return null;
  return <div className="status fail" role="alert">تعذر التحديث من الخادم: {error}{loadedAt ? ` — المعروض من آخر تحديث ${new Date(loadedAt).toLocaleTimeString('ar-EG')} وغير مؤكد` : ''}</div>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label={title} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="modal">
        <div className="modal-head"><h3>{title}</h3><button className="btn small ghost" onClick={onClose} aria-label="إغلاق">✕</button></div>
        {children}
      </div>
    </div>
  );
}

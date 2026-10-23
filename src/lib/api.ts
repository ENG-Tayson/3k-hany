import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';

// أنواع الفشل:
// - server: الخادم رفض الطلب برسالة واضحة (لم يُحفظ شيء).
// - offline: لا اتصال قبل الإرسال (لم يُحفظ شيء).
// - unknown: انقطع الاتصال أثناء الطلب؛ ربما وصل للخادم. إعادة المحاولة بنفس request_id آمنة ولا تكرر الحركة.
export type FailKind = 'server' | 'offline' | 'unknown' | 'auth';
export class ApiError extends Error {
  constructor(public kind: FailKind, message: string, public code?: string) { super(message); }
}

export async function rpc<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new ApiError('offline', 'لا يوجد اتصال بالإنترنت');
  }
  let res;
  try {
    res = await supabase.rpc(fn, args);
  } catch {
    throw new ApiError('unknown', 'انقطع الاتصال أثناء الطلب');
  }
  const { data, error, status } = res as any;
  if (error) {
    const msg = String(error.message ?? '');
    // لا رد، أو خطأ من البوابة/الخادم (5xx): ربما اعتُمد الحفظ قبل ضياع الرد → «تعذر التأكيد» مع إعادة بنفس المعرّف
    if (!status || status >= 500 || /Failed to fetch|NetworkError|fetch failed|Load failed|TypeError/i.test(msg)) {
      throw new ApiError('unknown', status >= 500 ? `خطأ من الخادم (${status}) ولا يمكن تأكيد النتيجة` : 'انقطع الاتصال أثناء الطلب');
    }
    if (status === 401 || error.code === '42501' || error.code === 'PGRST301' || error.code === 'PGRST303') {
      throw new ApiError('auth', 'انتهت الجلسة أو لا توجد صلاحية. سجّل الدخول مرة أخرى.', error.code);
    }
    throw new ApiError('server', msg || 'تعذر تنفيذ الطلب', error.details || error.code);
  }
  return data as T;
}

/** حالة حفظ لعملية مالية واحدة، بمعرّف طلب ثابت لإعادة المحاولة. */
export type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved'; at: number; replayed: boolean }
  | { status: 'failed'; kind: FailKind; message: string };

export function useSaver() {
  const [state, setState] = useState<SaveState>({ status: 'idle' });
  const pending = useRef<{ fp: string; id: string; unknown?: boolean } | null>(null);
  const busy = useRef(false);

  /**
   * ينفذ الحفظ. fingerprint = محتوى الطلب؛ إذا لم يتغير بعد فشل غير مؤكد يُعاد استخدام نفس request_id،
   * فلا تتكرر الحركة لو كانت المحاولة الأولى قد وصلت فعلًا.
   */
  const save = useCallback(async <T,>(fingerprint: string, run: (requestId: string) => Promise<T>): Promise<T | null> => {
    if (busy.current) return null; // منع النقر المزدوج (الحماية الحقيقية في الخادم بـ request_id)
    // بعد «تعذر تأكيد الحفظ» لا نرسل محتوى مختلفًا بمعرّف جديد: ربما وصلت المحاولة الأولى فتتكرر الحركة.
    if (pending.current?.unknown && pending.current.fp !== fingerprint) {
      setState({ status: 'failed', kind: 'unknown', message: 'آخر محاولة حفظ لم يتأكد مصيرها. أعد البيانات كما كانت واضغط «إعادة المحاولة» للتأكد، أو حدّث الصفحة وراجع الجدول قبل إدخال الحركة من جديد.' });
      return null;
    }
    busy.current = true;
    if (!pending.current || pending.current.fp !== fingerprint) {
      pending.current = { fp: fingerprint, id: crypto.randomUUID() };
    }
    setState({ status: 'saving' });
    try {
      const out: any = await run(pending.current.id);
      pending.current = null;
      setState({ status: 'saved', at: Date.now(), replayed: !!out?.replayed });
      return out as T;
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError('unknown', String((e as Error)?.message ?? e));
      // رفض الخادم نهائي لهذا المحتوى ولم يُحفظ شيء: المحاولة التالية بمعرّف جديد.
      // offline/unknown: نحتفظ بنفس المعرّف حتى لا تتكرر الحركة إن كانت قد وصلت.
      if (err.kind === 'server') pending.current = null;
      else if (err.kind === 'unknown' && pending.current) pending.current.unknown = true;
      setState({ status: 'failed', kind: err.kind, message: err.message });
      return null;
    } finally {
      busy.current = false;
    }
  }, []);

  const reset = useCallback(() => { setState({ status: 'idle' }); }, []);
  return { state, save, reset };
}

/** تحميل بيانات من الخادم مع إعادة جلب عند العودة للتبويب أو عودة الشبكة */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const d = await fn();
      if (my === seq.current) { setData(d); setError(null); setLoadedAt(Date.now()); }
    } catch (e) {
      if (my === seq.current) setError((e as Error).message);
    } finally {
      if (my === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const on = () => { void reload(); };
    const vis = () => { if (document.visibilityState === 'visible') void reload(); };
    window.addEventListener('online', on);
    window.addEventListener('focus', on);
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('ledger:changed', on);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('focus', on);
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('ledger:changed', on);
    };
  }, [reload]);
  return { data, error, loading, loadedAt, reload };
}

/** يبلغ كل الشاشات المفتوحة أن البيانات تغيرت لتعيد الجلب من الخادم */
export function notifyChanged() {
  window.dispatchEvent(new Event('ledger:changed'));
}

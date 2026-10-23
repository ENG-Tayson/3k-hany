import { useState } from 'react';
import { Money, Pager, SaveStatus } from '../components';
import { notifyChanged, rpc, useLoad, useSaver } from '../lib/api';
import { formatDateAr, formatTimestamp } from '../lib/dates';
import { absStr, formatMoney, gramsText } from '../lib/money';
import { DecisionText } from './Day';

const LIMIT = 20;
const DEC_AR: Record<string, string> = { sell: 'بيع دهب', buy: 'شراء دهب', balanced: 'متوازن' };

export function ArchivePage({ go }: { go: (tab: any, date?: string) => void }) {
  const [offset, setOffset] = useState(0);
  const l = useLoad(() => rpc('list_calc_snapshots', { p_limit: LIMIT, p_offset: offset }), [offset]);
  return (
    <section>
      <h2>أرشيف الحسبات المحفوظة</h2>
      <p className="hint">كل سطر هو النسخة كما حُفظت فعلًا وقت الحفظ ولا تتغير. إذا تغيّرت مدخلاتها لاحقًا تظهر علامة وتُعرض النتيجة المصححة بجانبها.</p>
      {l.error && <div className="status fail">{l.error}</div>}
      {l.data?.rows.length === 0 && <p className="muted">لا توجد حسبات محفوظة بعد.</p>}
      {l.data?.rows.map((s: any) => <SnapshotRow key={s.id} s={s} go={go} />)}
      {l.data && <Pager total={Number(l.data.total)} limit={LIMIT} offset={offset} onChange={setOffset} />}
    </section>
  );
}

function SnapshotRow({ s, go }: { s: any; go: (tab: any, date?: string) => void }) {
  const saver = useSaver();
  const saveNew = async () => {
    const out = await saver.save(`calc:${s.calc_date}:${s.id}`, (id) => rpc('save_calc', { p_request_id: id, p_calc_date: s.calc_date }));
    if (out) notifyChanged();
  };
  return (
    <div className={'card snap' + (s.stale ? ' stale' : '')} data-testid="snapshot">
      <div className="row wrap">
        <strong>{formatDateAr(s.calc_date)}</strong><span className="muted">حُفظت {formatTimestamp(s.saved_at)}</span>
        <span>Q <Money v={s.q} signed /></span><span>I <Money v={s.i} signed /></span><span>C <Money v={s.c} /></span><span>P <Money v={s.p} /></span>
        <span>D <Money v={s.d} signed /></span>
        <span className="tag">{DEC_AR[s.decision]} {s.decision !== 'balanced' && <>بقيمة <span dir="ltr">{formatMoney(absStr(s.d))}</span> — {gramsText(s.grams, s.grams_approx, s.grams_below_min)}</>}</span>
        <button className="btn small ghost no-print" onClick={() => go('day', s.calc_date)}>فتح اليوم</button>
      </div>
      {s.stale && (
        <div className="stale-box">
          <strong>⚠ توجد تعديلات بعد حفظ هذه الحسبة.</strong> الحساب المصحح حسب الحركات الحالية:
          <div className="row wrap"><span>Q <Money v={s.current.q} signed /></span><span>I <Money v={s.current.i} signed /></span>
            <span>C <Money v={s.current.c} /></span><span>P <Money v={s.current.p} /></span></div>
          {s.current.result?.status === 'complete' ? <DecisionText result={s.current.result} /> : <div className="muted">الحساب المصحح ناقص (خزنة أو افتتاحية غير مسجلة)</div>}
          <div className="row no-print">
            <button className="btn small" onClick={saveNew} disabled={s.current.result?.status !== 'complete' || s.current.result?.grams_status !== 'ok' || saver.state.status === 'saving'}>حفظ نسخة جديدة مصححة (تبقى هذه النسخة)</button>
            <SaveStatus state={saver.state} onRetry={saveNew} />
          </div>
        </div>
      )}
    </div>
  );
}

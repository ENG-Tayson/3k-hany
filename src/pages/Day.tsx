import { useEffect, useState } from 'react';
import { DateInput, Field, Money, NumInput, SaveStatus, TraderBalance, Weight } from '../components';
import { notifyChanged, rpc, useLoad, useSaver } from '../lib/api';
import { addDays, cairoToday, formatDateAr, formatTimestamp, isValidDate } from '../lib/dates';
import { absStr, formatMoney, gramsText, parseMoney, parsePrice } from '../lib/money';

const TYPE_AR: Record<string, string> = { buy: 'شراء من التاجر', sell: 'بيع للتاجر', cash_add: 'إضافة مالية', cash_deduct: 'خصم مالي', in: 'تحويل وارد', out: 'سحب/استلام' };
const MISSING_AR: Record<string, string> = {
  qat_not_configured: 'لم تُسجَّل افتتاحية دفتر القطعيات بعد',
  qat_not_started: 'دفتر القطعيات لم يبدأ بعد في هذا التاريخ',
  insta_not_configured: 'لم تُسجَّل افتتاحية دفتر إنستا بعد',
  insta_not_started: 'دفتر إنستا لم يبدأ بعد في هذا التاريخ',
  cash_missing: 'رصيد الخزنة غير مسجل لهذا اليوم',
};

export function DecisionText({ result }: { result: any }) {
  if (!result || result.status !== 'complete') return null;
  const g = result.grams_status === 'ok' ? gramsText(result.grams, result.grams_approx, result.grams_below_min) : null;
  const priceMsg = result.grams_status === 'price_missing' ? 'سعر الجرام غير مسجل لهذا اليوم؛ لا يمكن حساب الوزن' : result.grams_status === 'price_invalid' ? 'سعر الجرام غير صالح؛ لا يمكن حساب الوزن' : null;
  if (result.decision === 'balanced') return <div className="decision balanced" data-testid="decision">⚖ الحساب متوازن — وزن العملية صفر</div>;
  return (
    <div className={'decision ' + result.decision} data-testid="decision">
      {result.decision === 'sell' ? '⬇ بيع دهب' : '⬆ شراء دهب'} بقيمة <span dir="ltr">{formatMoney(result.abs_d)}</span> جنيه
      {g && <> — يعادل {g}</>}
      {priceMsg && <div className="hint">{priceMsg}</div>}
    </div>
  );
}

export function DayPage({ date: initial, go }: { date?: string; go: (tab: any, date?: string) => void }) {
  const [date, setDateState] = useState(initial && isValidDate(initial) ? initial : cairoToday());
  // الرابط (#day/YYYY-MM-DD) هو مصدر التاريخ المختار عند التنقل من صفحات أخرى أو من شريط العنوان
  useEffect(() => { if (initial && isValidDate(initial) && initial !== date) setDateState(initial); }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps
  const setDate = (d: string) => { if (isValidDate(d)) { setDateState(d); go('day', d); } };
  const rep = useLoad(() => rpc('get_day_report', { p_date: date }), [date]);
  // لا نعرض ولا نستخدم تقريرًا ليوم آخر أثناء تحميل اليوم الجديد (رقم نسخة الخزنة يخص يومه فقط)
  const r = rep.data && rep.data.date === date ? rep.data : null;
  const saveCalc = useSaver();
  useEffect(() => { saveCalc.reset(); }, [date]); // eslint-disable-line react-hooks/exhaustive-deps
  const doSaveCalc = async () => {
    const out = await saveCalc.save(`calc:${date}:${r?.fingerprint}`, (id) => rpc('save_calc', { p_request_id: id, p_calc_date: date }));
    if (out) { notifyChanged(); }
  };
  const res = r?.result;
  const hasSnap = r?.snapshots?.length > 0;

  return (
    <section>
      <div className="toolbar no-print">
        <button className="btn small" onClick={() => setDate(addDays(date, -1))} aria-label="اليوم السابق">→ السابق</button>
        <Field label="تاريخ الحسبة"><DateInput name="calc_date" value={date} onChange={setDate} /></Field>
        <button className="btn small" onClick={() => setDate(addDays(date, 1))} aria-label="اليوم التالي">التالي ←</button>
        <button className="btn small ghost" onClick={() => setDate(cairoToday())}>اليوم</button>
      </div>
      <h2>حسبة يوم {formatDateAr(date)}</h2>
      {rep.error && <div className="status fail" role="alert">تعذر التحميل من الخادم: {rep.error} <button className="btn small" onClick={rep.reload}>إعادة</button></div>}
      {!r && !rep.error && <p>جارٍ التحميل…</p>}
      {r && (
        <>
          <div className="grid2">
            <DailyValueCard key={'cash' + date} date={date} field="cash" report={r} onSaved={rep.reload} />
            <DailyValueCard key={'price' + date} date={date} field="price" report={r} onSaved={rep.reload} />
          </div>

          <h3>الإجمالي حتى نهاية {formatDateAr(date)}</h3>
          <div className="cards">
            <div className="card stat"><div className="k">رصيد فلوس القطعيات (Q)</div>
              {r.qat.status === 'ok' ? <div className="v" data-testid="q"><TraderBalance v={r.qat.q} /></div> : <div className="v muted">{MISSING_AR['qat_' + r.qat.status]}</div>}
            </div>
            <div className="card stat"><div className="k">توتال إنستا حتى اليوم (I)</div>
              {r.insta.status === 'ok' ? <div className="v" data-testid="i"><Money v={r.insta.i} signed /></div> : <div className="v muted">{MISSING_AR['insta_' + r.insta.status]}</div>}
            </div>
            <div className="card stat"><div className="k">صافي وزن دفتر القطعيات</div>
              <div className="v" data-testid="net_weight">{r.qat.status === 'ok' ? <><Weight v={r.qat.net_weight} /> جرام</> : '—'}</div>
              {r.qat.status === 'ok' && <div className="hint">شراء <Weight v={r.qat.buy_weight} /> − بيع <Weight v={r.qat.sell_weight} /> + افتتاحي <Weight v={r.qat.opening_weight} /></div>}
            </div>
          </div>

          <h3>خطوات الحساب</h3>
          {res.status === 'complete' ? (
            <div className="card steps" data-testid="steps">
              <div>1) الخزنة + إنستا = <span dir="ltr">{formatMoney(r.cash.value)} + ({formatMoney(r.insta.i)}) = {formatMoney(res.a)}</span></div>
              <div>2) القطعيات − الناتج = <span dir="ltr">{formatMoney(r.qat.q)} − ({formatMoney(res.a)}) = {formatMoney(res.d)}</span></div>
              {res.grams_status === 'ok'
                ? <div>3) مقدار الفرق ÷ سعر اليوم = <span dir="ltr">{formatMoney(res.abs_d)} ÷ {formatMoney(r.price.value)}</span> = {gramsText(res.grams, res.grams_approx, res.grams_below_min)}</div>
                : <div>3) الوزن: لا يمكن حسابه بدون سعر جرام صالح لهذا اليوم</div>}
              <DecisionText result={res} />
            </div>
          ) : (
            <div className="card warn-card" data-testid="incomplete">
              <strong>لا توجد نتيجة شراء/بيع نهائية لهذا اليوم:</strong>
              <ul>{res.missing.map((m: string) => <li key={m}>{MISSING_AR[m] ?? m}</li>)}</ul>
            </div>
          )}

          <div className="card">
            {hasSnap ? (
              <>
                <strong>حسبات محفوظة لهذا اليوم:</strong>
                <ul className="snaps">{r.snapshots.map((s: any) => (
                  <li key={s.id}>حُفظت {formatTimestamp(s.saved_at)} — {s.decision === 'sell' ? 'بيع' : s.decision === 'buy' ? 'شراء' : 'متوازن'} <span dir="ltr">{formatMoney(absStr(s.d))}</span>، {gramsText(s.grams, s.grams_approx, s.grams_below_min)}
                    {s.stale && <span className="tag warn"> توجد تعديلات بعد حفظ هذه الحسبة</span>}</li>
                ))}</ul>
              </>
            ) : <div className="muted" data-testid="not-saved">حساب مستخرج من الحركات — لم تُحفظ نسخة لهذا اليوم</div>}
            <div className="row no-print">
              <button className="btn primary" onClick={doSaveCalc} disabled={res.status !== 'complete' || res.grams_status !== 'ok' || saveCalc.state.status === 'saving'}>حفظ حسبة اليوم</button>
              <SaveStatus state={saveCalc.state} onRetry={doSaveCalc} />
            </div>
            <div className="hint">حفظ الحسبة لا ينشئ أي حركة مالية؛ تسجيل البيع/الشراء الفعلي يتم يدويًا في دفتر القطعيات.</div>
          </div>

          <h3>حركات اليوم وحدها</h3>
          <DayEntries r={r} />
        </>
      )}
    </section>
  );
}

function DayEntries({ r }: { r: any }) {
  const rows = [...r.day_entries.qat.map((e: any) => ({ ...e, book: 'القطعيات' })), ...r.day_entries.insta.map((e: any) => ({ ...e, book: 'إنستا' }))];
  if (!rows.length) return <p className="muted">لا توجد حركات بتاريخ هذا اليوم.</p>;
  return (
    <table className="tbl">
      <thead><tr><th>الدفتر</th><th>النوع</th><th>الوزن</th><th>السعر</th><th>المبلغ</th><th>الاسم</th><th>ملاحظة</th><th>الحالة</th></tr></thead>
      <tbody>{rows.map((e: any) => (
        <tr key={e.id} className={e.status === 'cancelled' ? 'cancelled' : ''}>
          <td>{e.book}</td><td>{TYPE_AR[e.entry_type]}</td><td><Weight v={e.weight} /></td><td><Money v={e.unit_price} /></td>
          <td><Money v={e.amount} /></td><td>{e.trader_name ?? e.person_name ?? ''}</td><td>{e.note ?? e.reason ?? ''}</td>
          <td>{e.status === 'cancelled' ? 'ملغاة' : 'معتمدة'}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

function DailyValueCard({ date, field, report, onSaved }: { date: string; field: 'cash' | 'price'; report: any; onSaved: () => void }) {
  const cur = report[field];
  const [val, setVal] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const saver = useSaver();
  const label = field === 'cash' ? 'رصيد الخزنة لهذا اليوم' : 'سعر الجرام اليدوي لهذا اليوم';
  const submit = async () => {
    const p = field === 'cash' ? parseMoney(val, 'nonneg') : parsePrice(val);
    if (!p.ok) { setErr(p.error); return; }
    setErr(null);
    const args = { p_value_date: date, p_field: field, p_value: p.value, p_expected_version: report.daily_version ?? null, p_reason: reason || null };
    const out = await saver.save(JSON.stringify(args), (id) => rpc('set_daily_value', { p_request_id: id, ...args }));
    if (out) { setVal(''); setReason(''); onSaved(); notifyChanged(); }
  };
  return (
    <div className="card">
      <div className="k">{label}</div>
      {cur ? <div className="v big" data-testid={field}><Money v={cur.value} /> <span className="hint">سُجّل {formatTimestamp(cur.set_at)}</span></div>
        : <div className="v muted" data-testid={field + '-missing'}>{field === 'cash' ? 'رصيد الخزنة غير مسجل لهذا اليوم' : 'سعر الجرام غير مسجل لهذا اليوم'}</div>}
      <div className="row no-print">
        <Field label={cur ? 'قيمة جديدة (تحل محل الحالية)' : 'القيمة'} error={err}><NumInput name={field + '_value'} value={val} onChange={setVal} /></Field>
        {cur && <Field label="سبب التعديل (اختياري)"><input name={field + '_reason'} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
        <button className="btn" onClick={submit} disabled={saver.state.status === 'saving'}>{cur ? 'تعديل' : 'تسجيل'}</button>
      </div>
      <SaveStatus state={saver.state} onRetry={submit} />
      {field === 'cash' && <div className="hint">الخزنة رقم مستقل لكل يوم: لا يُرحَّل من الأمس ولا تغيّره أي حركة. الصفر المُدخل قيمة صحيحة.</div>}
    </div>
  );
}

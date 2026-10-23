import { useState } from 'react';
import { DateInput, Field, Money } from '../components';
import { rpc, useLoad } from '../lib/api';
import { addDays, cairoToday, formatDateAr, formatTimestamp } from '../lib/dates';

export function DailyPage({ go }: { go: (tab: any, date?: string) => void }) {
  const [from, setFrom] = useState(addDays(cairoToday(), -30));
  const [to, setTo] = useState(cairoToday());
  const l = useLoad(() => rpc('list_daily_values', { p_from: from || null, p_to: to || null }), [from, to]);
  return (
    <section>
      <h2>الخزنة وسعر اليوم</h2>
      <p className="hint">لكل يوم رقم خزنة وسعر جرام مستقلان، ولا يُرحَّل أي منهما لليوم التالي. للتسجيل أو التعديل افتح اليوم من «حسبة اليوم».</p>
      <div className="row no-print">
        <Field label="من"><DateInput name="d_from" value={from} onChange={setFrom} /></Field>
        <Field label="إلى"><DateInput name="d_to" value={to} onChange={setTo} /></Field>
        <button className="btn" onClick={() => go('day', cairoToday())}>تسجيل خزنة/سعر اليوم</button>
      </div>
      {l.error && <div className="status fail">{l.error}</div>}
      {l.data && (
        <table className="tbl"><thead><tr><th>التاريخ</th><th>الخزنة</th><th>وقت التسجيل</th><th>سعر الجرام</th><th>وقت التسجيل</th><th></th></tr></thead>
          <tbody>{l.data.map((v: any) => (
            <tr key={v.value_date}>
              <td>{formatDateAr(v.value_date)}</td>
              <td>{v.cash !== null ? <Money v={v.cash} /> : <span className="muted">غير مسجل</span>}</td><td>{formatTimestamp(v.cash_set_at)}</td>
              <td>{v.price !== null ? <Money v={v.price} /> : <span className="muted">غير مسجل</span>}</td><td>{formatTimestamp(v.price_set_at)}</td>
              <td><button className="btn small ghost" onClick={() => go('day', v.value_date)}>فتح اليوم</button></td>
            </tr>))}</tbody></table>
      )}
      {l.data?.length === 0 && <p className="muted">لا توجد قيم مسجلة في هذه الفترة.</p>}
    </section>
  );
}

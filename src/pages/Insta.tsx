import { useState } from 'react';
import { DateInput, Field, Modal, Money, NumInput, Pager, SaveStatus, useRetroConfirm } from '../components';
import { notifyChanged, rpc, useLoad, useSaver } from '../lib/api';
import { cairoToday, formatDateAr, isValidDate } from '../lib/dates';
import { parseMoney } from '../lib/money';
import { AuditModal, CancelModal, OpeningCard, PeriodBox } from './shared';

const TYPE_AR: Record<string, string> = { in: 'تحويل وارد', out: 'سحب/استلام فلوس' };
const LIMIT = 50;
type Form = { date: string; type: string; amount: string; person: string; note: string; paid: boolean };
const emptyForm = (): Form => ({ date: cairoToday(), type: 'in', amount: '', person: '', note: '', paid: false });

function InstaForm({ initial, onSubmit, submitLabel, extraArgs }: { initial: Form; submitLabel: string; onSubmit: (args: Record<string, unknown>, id: string) => Promise<any>; extraArgs?: () => Record<string, unknown> }) {
  const [f, setF] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const saver = useSaver();
  const retro = useRetroConfirm(f.date);
  const submit = async () => {
    const e: Record<string, string> = {};
    if (!isValidDate(f.date)) e.date = 'تاريخ غير صالح';
    const a = parseMoney(f.amount); if (!a.ok) e.amount = a.error;
    setErrors(e);
    if (Object.keys(e).length || retro.needsConfirm) return;
    const args = { p_entry_date: f.date, p_entry_type: f.type, p_amount: (a as any).value, p_person_name: f.person || null, p_note: f.note || null, p_marked_paid: f.paid, ...(extraArgs?.() ?? {}) };
    const out = await saver.save(JSON.stringify(args), (id) => onSubmit(args, id));
    if (out) { setF({ ...emptyForm(), date: f.date, type: f.type }); retro.reset(); notifyChanged(); }
  };
  return (
    <div className="form">
      <div className="row wrap">
        <Field label="النوع"><select name="insta_type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
          <option value="in">تحويل وارد (يزيد إنستا)</option><option value="out">سحب/استلام فلوس (ينقص إنستا)</option></select></Field>
        <Field label="تاريخ العملية الفعلي" error={errors.date}><DateInput name="insta_date" value={f.date} onChange={(v) => setF({ ...f, date: v })} /></Field>
        <Field label="المبلغ" error={errors.amount}><NumInput name="insta_amount" value={f.amount} onChange={(v) => setF({ ...f, amount: v })} /></Field>
        <Field label="اسم الشخص (اختياري)"><input name="insta_person" value={f.person} onChange={(e) => setF({ ...f, person: e.target.value })} /></Field>
        <Field label="ملاحظة (اختياري)"><input name="insta_note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        <label className="check"><input type="checkbox" name="insta_paid" checked={f.paid} onChange={(e) => setF({ ...f, paid: e.target.checked })} /> تم السداد (وصف فقط)</label>
      </div>
      <div className="hint">«تم السداد» وصف للحركة ولا يخصم أي مبلغ إضافي. السحب لا يزيد الخزنة تلقائيًا؛ اكتب رصيد الخزنة بنفسك.</div>
      {retro.box}
      <div className="row"><button className="btn primary" onClick={submit} disabled={saver.state.status === 'saving' || retro.needsConfirm}>{submitLabel}</button></div>
      <SaveStatus state={saver.state} onRetry={submit} />
    </div>
  );
}

export function InstaPage({ state, reloadState }: { state: any; reloadState: () => void }) {
  const opening = state.openings?.insta;
  const [filters, setFilters] = useState({ from: '', to: '', type: '', search: '' });
  const [applied, setApplied] = useState(filters);
  const [offset, setOffset] = useState(0);
  const list = useLoad(() => rpc('list_insta_entries', { p_from: applied.from || null, p_to: applied.to || null, p_type: applied.type || null,
    p_search: applied.search || null, p_limit: LIMIT, p_offset: offset }), [applied, offset]);
  const [editing, setEditing] = useState<any>(null);
  const [cancelling, setCancelling] = useState<any>(null);
  const [history, setHistory] = useState<string | null>(null);
  const d = list.data;
  const filtered = !!(applied.from || applied.to || applied.type || applied.search);
  return (
    <section>
      <h2>دفتر إنستا</h2>
      <OpeningCard key={opening?.version ?? 'new'} book="insta" opening={opening} onSaved={() => { reloadState(); list.reload(); }} />
      {opening && <div className="card no-print"><h3>تسجيل حركة</h3>
        <InstaForm initial={emptyForm()} submitLabel="حفظ الحركة" onSubmit={(args, id) => rpc('add_insta_entry', { p_request_id: id, ...args })} /></div>}
      {d && (
        <div className="cards">
          <div className="card stat"><div className="k">الافتتاحي</div><div className="v"><Money v={d.book.opening_money} signed /></div></div>
          <div className="card stat"><div className="k">إجمالي الوارد</div><div className="v"><Money v={d.book.total_in} /></div></div>
          <div className="card stat"><div className="k">إجمالي المسحوب</div><div className="v"><Money v={d.book.total_out} /></div></div>
          <div className="card stat"><div className="k">المتبقي (كل الدفتر)</div><div className="v" data-testid="insta-book-money"><Money v={d.book.money} signed /></div></div>
        </div>
      )}
      <div className="card filters no-print"><div className="row wrap">
        <Field label="من تاريخ"><DateInput name="if_from" value={filters.from} onChange={(v) => setFilters({ ...filters, from: v })} /></Field>
        <Field label="إلى تاريخ"><DateInput name="if_to" value={filters.to} onChange={(v) => setFilters({ ...filters, to: v })} /></Field>
        <Field label="النوع"><select name="if_type" value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })}><option value="">الكل</option><option value="in">وارد</option><option value="out">مسحوب</option></select></Field>
        <Field label="بحث بالاسم/الملاحظة"><input name="if_search" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} /></Field>
        <button className="btn" onClick={() => { setOffset(0); setApplied(filters); }}>عرض</button>
        <button className="btn ghost" onClick={() => { const z = { from: '', to: '', type: '', search: '' }; setFilters(z); setApplied(z); setOffset(0); }}>مسح</button>
        <button className="btn ghost" onClick={() => window.print()}>طباعة</button>
      </div></div>
      {d && <PeriodBox startDate={d.book.start_date} period={d.period} />}
      {list.error && <div className="status fail">تعذر التحميل: {list.error}</div>}
      {d && (<>
        {filtered && <div className="card filtered-totals">مجموع نتائج الفلترة ({d.filtered.count} حركة) — ليس إجمالي الدفتر: وارد <Money v={d.filtered.total_in} />، مسحوب <Money v={d.filtered.total_out} /></div>}
        <table className="tbl" data-testid="insta-table">
          <thead><tr><th>التاريخ</th><th>النوع</th><th>المبلغ</th><th>الاسم</th><th>ملاحظة</th><th>الرصيد بعد الحركة</th><th className="no-print"></th></tr></thead>
          <tbody>{d.rows.map((e: any) => (
            <tr key={e.id} className={e.status === 'cancelled' ? 'cancelled' : ''}>
              <td>{formatDateAr(e.entry_date)}</td><td>{TYPE_AR[e.entry_type]}{e.status === 'cancelled' && <span className="tag"> ملغاة: {e.cancel_reason}</span>}</td>
              <td><Money v={e.amount} /></td><td>{e.person_name}</td>
              <td>{e.note}{e.marked_paid && <span className="tag ok"> تم السداد</span>}</td>
              <td><Money v={e.running_money} signed /></td>
              <td className="no-print actions">
                {e.status === 'active' && <button className="btn small ghost" onClick={() => setEditing(e)}>تصحيح</button>}
                {e.status === 'active' && <button className="btn small ghost" onClick={() => setCancelling(e)}>إلغاء</button>}
                <button className="btn small ghost" onClick={() => setHistory(e.id)}>السجل</button>
              </td>
            </tr>
          ))}</tbody>
        </table>
        <Pager total={Number(d.filtered.count)} limit={LIMIT} offset={offset} onChange={setOffset} />
      </>)}
      {editing && <Modal title="تصحيح حركة إنستا" onClose={() => setEditing(null)}><EditInsta e={editing} onDone={() => setEditing(null)} /></Modal>}
      {cancelling && <CancelModal title="إلغاء حركة إنستا" onClose={() => setCancelling(null)}
        onConfirm={(reason, id) => rpc('cancel_insta_entry', { p_request_id: id, p_id: cancelling.id, p_expected_version: cancelling.version, p_reason: reason })} />}
      {history && <AuditModal entity="insta_entries" recordId={history} onClose={() => setHistory(null)} />}
    </section>
  );
}

function EditInsta({ e, onDone }: { e: any; onDone: () => void }) {
  const [reason, setReason] = useState('');
  return (<>
    <Field label="سبب التصحيح (مطلوب عند تغيير التاريخ/النوع/المبلغ)"><input name="change_reason" value={reason} onChange={(x) => setReason(x.target.value)} /></Field>
    <InstaForm initial={{ date: e.entry_date, type: e.entry_type, amount: e.amount, person: e.person_name ?? '', note: e.note ?? '', paid: e.marked_paid }}
      submitLabel="حفظ التصحيح" extraArgs={() => ({ p_change_reason: reason || null })}
      onSubmit={async (args, id) => { const r = await rpc('update_insta_entry', { p_request_id: id, p_id: e.id, p_expected_version: e.version, ...args }); onDone(); return r; }} />
  </>);
}

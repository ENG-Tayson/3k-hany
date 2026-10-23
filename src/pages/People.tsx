import { useState } from 'react';
import { DateInput, Field, Modal, Money, NumInput, SaveStatus, useRetroConfirm } from '../components';
import { notifyChanged, rpc, useLoad, useSaver } from '../lib/api';
import { cairoToday, formatDateAr, isValidDate } from '../lib/dates';
import { parseMoney } from '../lib/money';
import { AuditModal, CancelModal, DeleteModal } from './shared';

const STATUS_AR: Record<string, string> = { unpaid: 'لم يسدد', partial: 'سداد جزئي', paid: 'تم السداد بالكامل', none: 'لا يوجد مبلغ' };

export function PeoplePage() {
  const [asOf, setAsOf] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const l = useLoad(() => rpc('list_people', { p_as_of: asOf || null, p_status: status || null, p_search: search || null }), [asOf, status, search]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section>
      <h2>الباقي على الناس</h2>
      <p className="hint">حساب مستقل تمامًا عن المحل: لا يدخل في حسبة الذهب ولا ينشئ حركة إنستا أو خزنة أو قطعيات.</p>
      <div className="card stat big-total"><div className="k">إجمالي الفلوس اللي ليا برّه{asOf ? ` حتى ${formatDateAr(asOf)}` : ''}</div>
        <div className="v" data-testid="outstanding"><Money v={l.data?.total_outstanding} /></div></div>
      <AddPerson onAdded={l.reload} />
      <div className="row wrap no-print">
        <Field label="المراجعة بتاريخ سابق (اختياري)"><DateInput name="p_asof" value={asOf} onChange={setAsOf} /></Field>
        <Field label="الحالة"><select name="p_status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">الكل</option><option value="open">عليه باقي</option><option value="unpaid">لم يسدد</option><option value="partial">سداد جزئي</option><option value="paid">تم السداد بالكامل</option></select></Field>
        <Field label="بحث بالاسم"><input name="p_search" value={search} onChange={(e) => setSearch(e.target.value)} /></Field>
      </div>
      {l.error && <div className="status fail">{l.error}</div>}
      {l.data && (
        <table className="tbl" data-testid="people-table"><thead><tr><th>الاسم</th><th>إجمالي ما أُرسل</th><th>إجمالي ما سدده</th><th>الباقي عليه</th><th>الحالة</th><th></th></tr></thead>
          <tbody>{l.data.rows.map((p: any) => (
            <tr key={p.id}><td>{p.name}</td><td><Money v={p.sent} /></td><td><Money v={p.repaid} /></td><td><Money v={p.remaining} /></td>
              <td><span className={'tag ' + (p.status === 'paid' ? 'ok' : p.status === 'partial' ? 'warn' : '')}>{STATUS_AR[p.status]}</span></td>
              <td><button className="btn small ghost" onClick={() => setOpen(p.id)}>فتح</button></td></tr>))}</tbody></table>
      )}
      {open && <Modal title="حساب الشخص" onClose={() => { setOpen(null); l.reload(); }}><PersonDetail id={open} asOf={asOf} /></Modal>}
    </section>
  );
}

function AddPerson({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState('');
  const saver = useSaver();
  const submit = async () => {
    if (!name.trim()) return;
    const out = await saver.save('person:' + name, (id) => rpc('create_person', { p_request_id: id, p_name: name }));
    if (out) { setName(''); onAdded(); }
  };
  return (
    <div className="card row no-print">
      <Field label="إضافة شخص جديد"><input name="new_person" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <button className="btn" onClick={submit} disabled={!name.trim() || saver.state.status === 'saving'}>إضافة</button>
      <SaveStatus state={saver.state} onRetry={submit} />
      <span className="hint">الأسماء المتشابهة لا تُدمج تلقائيًا.</span>
    </div>
  );
}

function PersonDetail({ id, asOf }: { id: string; asOf: string }) {
  const p = useLoad(() => rpc('get_person', { p_id: id, p_as_of: asOf || null }), [id, asOf]);
  const [date, setDate] = useState(cairoToday());
  const [type, setType] = useState('sent');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<any>(null);
  const [editing, setEditing] = useState<any>(null);
  const [deleting, setDeleting] = useState<any>(null);
  const [history, setHistory] = useState<string | null>(null);
  const saver = useSaver();
  const retro = useRetroConfirm(date);
  const submit = async () => {
    const a = parseMoney(amount);
    if (!isValidDate(date)) { setErr('تاريخ غير صالح'); return; }
    if (!a.ok) { setErr(a.error); return; }
    setErr(null);
    if (retro.needsConfirm) return;
    const args = { p_person_id: id, p_entry_date: date, p_entry_type: type, p_amount: a.value, p_note: note || null };
    const out = await saver.save(JSON.stringify(args), (rid) => rpc('add_debt_entry', { p_request_id: rid, ...args }));
    if (out) { setAmount(''); setNote(''); retro.reset(); p.reload(); notifyChanged(); }
  };
  const d = p.data;
  return (
    <div>
      {d && <>
        <RenamePerson key={d.version} p={d} onDone={p.reload} />
        <div className="row wrap"><span>أُرسل له: <Money v={d.sent} /></span><span>سدد: <Money v={d.repaid} /></span><span>الباقي عليه: <strong data-testid="person-remaining"><Money v={d.remaining} /></strong></span></div>
        <table className="tbl small"><thead><tr><th>التاريخ</th><th>النوع</th><th>المبلغ</th><th>ملاحظة</th><th>الباقي بعدها</th><th></th></tr></thead>
          <tbody>{d.entries.map((e: any) => (
            <tr key={e.id} className={e.status === 'cancelled' ? 'cancelled' : ''}><td>{formatDateAr(e.entry_date)}</td>
              <td>{e.entry_type === 'sent' ? 'بعت له فلوس' : 'استلمت منه سداد'}{e.status === 'cancelled' && <span className="tag"> ملغاة: {e.cancel_reason}</span>}</td>
              <td><Money v={e.amount} /></td><td>{e.note}</td><td><Money v={e.running} /></td>
              <td className="actions">{e.status === 'active' && <button className="btn small ghost" onClick={() => setEditing(e)}>تصحيح</button>}{e.status === 'active' && <button className="btn small ghost" onClick={() => setCancelling(e)}>إلغاء</button>}
                <button className="btn small ghost" onClick={() => setHistory(e.id)}>السجل</button>
                <button className="btn small ghost danger-text" onClick={() => setDeleting(e)}>مسح</button></td></tr>))}</tbody></table>
      </>}
      {p.error && <div className="status fail">{p.error}</div>}
      <div className="form">
        <div className="row wrap">
          <Field label="النوع"><select name="debt_type" value={type} onChange={(e) => setType(e.target.value)}><option value="sent">بعت له فلوس (يزيد اللي عليه)</option><option value="repaid">استلمت منه سداد (ينقص اللي عليه)</option></select></Field>
          <Field label="التاريخ"><DateInput name="debt_date" value={date} onChange={setDate} /></Field>
          <Field label="المبلغ" error={err}><NumInput name="debt_amount" value={amount} onChange={setAmount} /></Field>
          <Field label="ملاحظة"><input name="debt_note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
        {retro.box}
        <button className="btn primary" onClick={submit} disabled={saver.state.status === 'saving' || retro.needsConfirm}>حفظ</button>
        <SaveStatus state={saver.state} onRetry={submit} />
      </div>
      {cancelling && <CancelModal title="إلغاء حركة" onClose={() => { setCancelling(null); p.reload(); }}
        onConfirm={(reason, rid) => rpc('cancel_debt_entry', { p_request_id: rid, p_id: cancelling.id, p_expected_version: cancelling.version, p_reason: reason })} />}
      {deleting && <DeleteModal title="مسح حركة نهائيًا" onClose={() => { setDeleting(null); p.reload(); }}
        summary={<>{deleting.entry_type === 'sent' ? 'بعت له فلوس' : 'استلمت منه سداد'} — {formatDateAr(deleting.entry_date)} — <Money v={deleting.amount} /></>}
        onDelete={(rid) => rpc('delete_debt_entry', { p_request_id: rid, p_id: deleting.id, p_expected_version: deleting.version })} />}
      {editing && <EditDebt e={editing} onDone={() => { setEditing(null); p.reload(); }} />}
      {history && <AuditModal entity="debt_entries" recordId={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function RenamePerson({ p, onDone }: { p: any; onDone: () => void }) {
  const [name, setName] = useState(p.name);
  const [edit, setEdit] = useState(false);
  const saver = useSaver();
  const submit = async () => {
    if (!name.trim()) return;
    const out = await saver.save('rename:' + name, (id) => rpc('update_person', { p_request_id: id, p_id: p.id, p_expected_version: p.version, p_name: name, p_note: p.note }));
    if (out) { setEdit(false); onDone(); notifyChanged(); }
  };
  if (!edit) return <h3>{p.name} <button className="btn small ghost" onClick={() => setEdit(true)}>تعديل الاسم</button></h3>;
  return (
    <div className="row"><Field label="الاسم"><input name="person_name_edit" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <button className="btn" onClick={submit} disabled={saver.state.status === 'saving'}>حفظ الاسم</button>
      <button className="btn ghost" onClick={() => setEdit(false)}>إلغاء</button><SaveStatus state={saver.state} onRetry={submit} /></div>
  );
}

function EditDebt({ e, onDone }: { e: any; onDone: () => void }) {
  const [date, setDate] = useState(e.entry_date);
  const [type, setType] = useState(e.entry_type);
  const [amount, setAmount] = useState(e.amount);
  const [note, setNote] = useState(e.note ?? '');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const saver = useSaver();
  const submit = async () => {
    const a = parseMoney(amount);
    if (!isValidDate(date)) { setErr('تاريخ غير صالح'); return; }
    if (!a.ok) { setErr(a.error); return; }
    setErr(null);
    const args = { p_id: e.id, p_expected_version: e.version, p_entry_date: date, p_entry_type: type, p_amount: a.value, p_note: note || null, p_change_reason: reason || null };
    const out = await saver.save(JSON.stringify(args), (rid) => rpc('update_debt_entry', { p_request_id: rid, ...args }));
    if (out) { notifyChanged(); onDone(); }
  };
  return (
    <Modal title="تصحيح حركة" onClose={onDone}>
      <div className="row wrap">
        <Field label="النوع"><select name="edit_debt_type" value={type} onChange={(x) => setType(x.target.value)}><option value="sent">بعت له فلوس</option><option value="repaid">استلمت منه سداد</option></select></Field>
        <Field label="التاريخ"><DateInput name="edit_debt_date" value={date} onChange={setDate} /></Field>
        <Field label="المبلغ" error={err}><NumInput name="edit_debt_amount" value={amount} onChange={setAmount} /></Field>
        <Field label="ملاحظة"><input name="edit_debt_note" value={note} onChange={(x) => setNote(x.target.value)} /></Field>
        <Field label="سبب التصحيح (مطلوب عند تغيير التاريخ/النوع/المبلغ)"><input name="edit_debt_reason" value={reason} onChange={(x) => setReason(x.target.value)} /></Field>
      </div>
      <button className="btn primary" onClick={submit} disabled={saver.state.status === 'saving'}>حفظ التصحيح</button>
      <SaveStatus state={saver.state} onRetry={submit} />
    </Modal>
  );
}

import { useState } from 'react';
import { DateInput, Field, Modal, Money, NumInput, Pager, SaveStatus, TraderBalance, useRetroConfirm, Weight } from '../components';
import { notifyChanged, rpc, useLoad, useSaver } from '../lib/api';
import { cairoToday, formatDateAr, isValidDate } from '../lib/dates';
import { formatMoney, lineAmount, parseMoney, parsePrice, parseWeight } from '../lib/money';
import { AuditModal, CancelModal, OpeningCard, PeriodBox } from './shared';

const TYPES = [
  { v: 'buy', l: 'شراء من التاجر (يزيد اللي عليك)' },
  { v: 'sell', l: 'بيع للتاجر (ينقص اللي عليك)' },
  { v: 'cash_add', l: 'إضافة مالية (تسوية)' },
  { v: 'cash_deduct', l: 'خصم مالي (تسوية)' },
];
const TYPE_AR: Record<string, string> = { buy: 'شراء من التاجر', sell: 'بيع للتاجر', cash_add: 'إضافة مالية', cash_deduct: 'خصم مالي' };
const LIMIT = 50;

type Form = { date: string; type: string; weight: string; price: string; amount: string; trader: string; note: string; reason: string };
const emptyForm = (): Form => ({ date: cairoToday(), type: 'buy', weight: '', price: '', amount: '', trader: '', note: '', reason: '' });

function validate(f: Form) {
  const e: Record<string, string> = {};
  if (!isValidDate(f.date)) e.date = 'تاريخ غير صالح';
  let args: Record<string, unknown> = { p_entry_date: f.date, p_entry_type: f.type, p_trader_name: f.trader || null, p_note: f.note || null };
  if (f.type === 'buy' || f.type === 'sell') {
    const w = parseWeight(f.weight), p = parsePrice(f.price);
    if (!w.ok) e.weight = w.error;
    if (!p.ok) e.price = p.error;
    if (w.ok && p.ok) {
      const amount = lineAmount(w.value, p.value);
      if (amount === '0.00') e.weight = 'قيمة القطعية أقل من قرش واحد';
      args = { ...args, p_weight: w.value, p_unit_price: p.value, p_amount: amount, p_reason: f.reason || null };
    }
  } else {
    const a = parseMoney(f.amount);
    if (!a.ok) e.amount = a.error;
    if (!f.reason.trim()) e.reason = 'سبب الإضافة/الخصم مطلوب';
    args = { ...args, p_amount: a.ok ? a.value : null, p_reason: f.reason || null };
  }
  return { errors: e, args };
}

function QatForm({ initial, onSubmit, submitLabel, extra }: { initial: Form; onSubmit: (args: Record<string, unknown>, id: string) => Promise<any>; submitLabel: string; extra?: (f: Form) => Record<string, unknown> | string }) {
  const [f, setF] = useState<Form>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const saver = useSaver();
  const retro = useRetroConfirm(f.date);
  const set = (k: keyof Form) => (v: string) => setF({ ...f, [k]: v });
  const isTrade = f.type === 'buy' || f.type === 'sell';
  const w = parseWeight(f.weight), p = parsePrice(f.price);
  const preview = isTrade && w.ok && p.ok ? lineAmount(w.value, p.value) : null;
  const submit = async () => {
    const v = validate(f);
    let more: Record<string, unknown> = {};
    if (extra) { const x = extra(f); if (typeof x === 'string') { v.errors.change_reason = x; } else more = x; }
    setErrors(v.errors);
    if (Object.keys(v.errors).length || retro.needsConfirm) return;
    const args = { ...v.args, ...more };
    const out = await saver.save(JSON.stringify(args), (id) => onSubmit(args, id));
    if (out) { setF({ ...emptyForm(), date: f.date, type: f.type }); retro.reset(); notifyChanged(); }
  };
  return (
    <div className="form">
      <div className="row wrap">
        <Field label="النوع"><select name="qat_type" value={f.type} onChange={(e) => set('type')(e.target.value)}>{TYPES.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}</select></Field>
        <Field label="تاريخ العملية الفعلي" error={errors.date}><DateInput name="qat_date" value={f.date} onChange={set('date')} /></Field>
        {isTrade ? (<>
          <Field label="الوزن (جرام)" error={errors.weight}><NumInput name="qat_weight" value={f.weight} onChange={set('weight')} /></Field>
          <Field label="سعر الجرام لهذه القطعية" error={errors.price}><NumInput name="qat_price" value={f.price} onChange={set('price')} /></Field>
          <div className="field"><span className="label">قيمة الحركة = الوزن × السعر</span><span className="v" data-testid="qat-preview" dir="ltr">{preview ? formatMoney(preview) : '—'}</span></div>
        </>) : (
          <Field label="المبلغ (موجب)" error={errors.amount}><NumInput name="qat_amount" value={f.amount} onChange={set('amount')} /></Field>
        )}
      </div>
      <div className="row wrap">
        <Field label="اسم التاجر (اختياري)"><input name="qat_trader" value={f.trader} onChange={(e) => set('trader')(e.target.value)} /></Field>
        <Field label="ملاحظة (اختياري)"><input name="qat_note" value={f.note} onChange={(e) => set('note')(e.target.value)} /></Field>
        <Field label={isTrade ? 'سبب (اختياري)' : 'سبب الإضافة/الخصم (مطلوب)'} error={errors.reason}><input name="qat_reason" value={f.reason} onChange={(e) => set('reason')(e.target.value)} /></Field>
      </div>
      {errors.change_reason && <div className="error">{errors.change_reason}</div>}
      {retro.box}
      <div className="row"><button className="btn primary" onClick={submit} disabled={saver.state.status === 'saving' || retro.needsConfirm}>{submitLabel}</button></div>
      <SaveStatus state={saver.state} onRetry={submit} />
    </div>
  );
}

export function QatPage({ state, reloadState }: { state: any; reloadState: () => void }) {
  const opening = state.openings?.qat;
  const [filters, setFilters] = useState({ from: '', to: '', type: '', search: '' });
  const [applied, setApplied] = useState(filters);
  const [offset, setOffset] = useState(0);
  const [order, setOrder] = useState<'desc' | 'asc'>('desc');
  const list = useLoad(() => rpc('list_qat_entries', { p_from: applied.from || null, p_to: applied.to || null, p_type: applied.type || null,
    p_search: applied.search || null, p_limit: LIMIT, p_offset: offset, p_order: order }), [applied, offset, order]);
  const [editing, setEditing] = useState<any>(null);
  const [cancelling, setCancelling] = useState<any>(null);
  const [history, setHistory] = useState<string | null>(null);
  const d = list.data;
  const filtered = !!(applied.from || applied.to || applied.type || applied.search);

  return (
    <section>
      <h2>دفتر القطعيات</h2>
      <OpeningCard key={opening?.version ?? 'new'} book="qat" opening={opening} onSaved={() => { reloadState(); list.reload(); }} />
      {opening && (
        <div className="card no-print"><h3>تسجيل حركة</h3>
          <QatForm initial={emptyForm()} submitLabel="حفظ الحركة" onSubmit={(args, id) => rpc('add_qat_entry', { p_request_id: id, ...args })} />
        </div>
      )}

      {d && (
        <div className="cards">
          <div className="card stat"><div className="k">رصيد الفلوس النهائي مع التاجر (كل الدفتر)</div><div className="v" data-testid="qat-book-money"><TraderBalance v={d.book.money} /></div></div>
          <div className="card stat"><div className="k">صافي وزن دفتر القطعيات</div><div className="v"><Weight v={d.book.net_weight} /> جرام</div>
            <div className="hint">إجمالي وزن المشتريات <Weight v={d.book.buy_weight} /> — المبيعات <Weight v={d.book.sell_weight} /></div></div>
          <div className="card stat"><div className="k">القيم (كل الدفتر)</div>
            <div className="hint">مشتريات <Money v={d.book.buy_value} /> — مبيعات <Money v={d.book.sell_value} /> — إضافات <Money v={d.book.cash_add} /> — خصومات <Money v={d.book.cash_deduct} /></div></div>
        </div>
      )}

      <div className="card filters no-print">
        <div className="row wrap">
          <Field label="من تاريخ"><DateInput name="f_from" value={filters.from} onChange={(v) => setFilters({ ...filters, from: v })} /></Field>
          <Field label="إلى تاريخ"><DateInput name="f_to" value={filters.to} onChange={(v) => setFilters({ ...filters, to: v })} /></Field>
          <Field label="النوع"><select name="f_type" value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })}>
            <option value="">الكل</option><option value="buy">شراء</option><option value="sell">بيع</option><option value="adjust">تسويات</option></select></Field>
          <Field label="بحث بالاسم/الملاحظة"><input name="f_search" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} /></Field>
          <button className="btn" onClick={() => { setOffset(0); setApplied(filters); }}>عرض</button>
          <button className="btn ghost" onClick={() => { const z = { from: '', to: '', type: '', search: '' }; setFilters(z); setApplied(z); setOffset(0); }}>مسح</button>
          <button className="btn ghost" onClick={() => setOrder(order === 'desc' ? 'asc' : 'desc')}>{order === 'desc' ? 'الأحدث أولًا' : 'الأقدم أولًا'}</button>
          <button className="btn ghost" onClick={() => window.print()}>طباعة الكشف</button>
        </div>
      </div>
      <div className="print-only"><h2>كشف حساب القطعيات — أساس الوزن {state.account.weight_basis}</h2></div>
      {d && <PeriodBox startDate={d.book.start_date} period={d.period} weight />}
      {list.error && <div className="status fail">تعذر التحميل: {list.error}</div>}
      {d && (
        <>
          {filtered && <div className="card filtered-totals" data-testid="filtered-totals">
            <strong>مجموع نتائج الفلترة/البحث ({d.filtered.count} حركة) — ليس إجمالي الدفتر:</strong> وزن شراء <Weight v={d.filtered.buy_weight} />، وزن بيع <Weight v={d.filtered.sell_weight} />،
            قيمة شراء <Money v={d.filtered.buy_value} />، قيمة بيع <Money v={d.filtered.sell_value} />، تسويات +<Money v={d.filtered.cash_add} /> −<Money v={d.filtered.cash_deduct} />
          </div>}
          <table className="tbl" data-testid="qat-table">
            <thead><tr><th>التاريخ</th><th>النوع</th><th>الوزن</th><th>سعر الجرام</th><th>القيمة</th><th>التاجر</th><th>ملاحظة/سبب</th><th>الرصيد بعد الحركة</th><th>الوزن بعد الحركة</th><th className="no-print"></th></tr></thead>
            <tbody>{d.rows.map((e: any) => (
              <tr key={e.id} className={e.status === 'cancelled' ? 'cancelled' : ''}>
                <td>{formatDateAr(e.entry_date)}</td>
                <td>{TYPE_AR[e.entry_type]}{e.status === 'cancelled' && <span className="tag"> ملغاة: {e.cancel_reason}</span>}</td>
                <td><Weight v={e.weight} /></td><td><Money v={e.unit_price} /></td><td><Money v={e.amount} /></td>
                <td>{e.trader_name}</td><td>{[e.note, e.reason].filter(Boolean).join(' — ')}</td>
                <td>{e.running_money !== null ? <TraderBalance v={e.running_money} /> : '—'}</td><td><Weight v={e.running_weight} /></td>
                <td className="no-print actions">
                  {e.status === 'active' && <button className="btn small ghost" onClick={() => setEditing(e)}>تصحيح</button>}
                  {e.status === 'active' && <button className="btn small ghost" onClick={() => setCancelling(e)}>إلغاء</button>}
                  <button className="btn small ghost" onClick={() => setHistory(e.id)}>السجل</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
          {d.rows.length === 0 && <p className="muted">لا توجد حركات مطابقة.</p>}
          <Pager total={Number(d.filtered.count)} limit={LIMIT} offset={offset} onChange={setOffset} />
        </>
      )}
      {editing && (
        <Modal title="تصحيح حركة قطعيات" onClose={() => setEditing(null)}>
          <EditQat e={editing} onDone={() => setEditing(null)} />
        </Modal>
      )}
      {cancelling && <CancelModal title={`إلغاء ${TYPE_AR[cancelling.entry_type]} بتاريخ ${cancelling.entry_date}`} onClose={() => setCancelling(null)}
        onConfirm={(reason, id) => rpc('cancel_qat_entry', { p_request_id: id, p_id: cancelling.id, p_expected_version: cancelling.version, p_reason: reason })} />}
      {history && <AuditModal entity="qat_entries" recordId={history} onClose={() => setHistory(null)} />}
    </section>
  );
}

function EditQat({ e, onDone }: { e: any; onDone: () => void }) {
  const [changeReason, setChangeReason] = useState('');
  const init: Form = { date: e.entry_date, type: e.entry_type, weight: e.weight ?? '', price: e.unit_price ?? '', amount: e.weight ? '' : e.amount,
    trader: e.trader_name ?? '', note: e.note ?? '', reason: e.reason ?? '' };
  return (
    <>
      <p className="hint">التصحيح يحفظ القيم السابقة والجديدة والسبب. نسخة الحسبات المحفوظة لا تتغير، وتظهر عليها علامة «توجد تعديلات».</p>
      <Field label="سبب التصحيح (مطلوب عند تغيير التاريخ/النوع/الوزن/السعر/المبلغ)"><input name="change_reason" value={changeReason} onChange={(x) => setChangeReason(x.target.value)} /></Field>
      <QatForm initial={init} submitLabel="حفظ التصحيح"
        extra={() => ({ p_change_reason: changeReason || null })}
        onSubmit={async (args, id) => { const r = await rpc('update_qat_entry', { p_request_id: id, p_id: e.id, p_expected_version: e.version, ...args }); onDone(); return r; }} />
    </>
  );
}

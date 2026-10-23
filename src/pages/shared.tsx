import { useState, type ReactNode } from 'react';
import { DateInput, Field, Modal, NumInput, SaveStatus, TraderBalance, Weight, Money } from '../components';
import { notifyChanged, rpc, useLoad, useSaver } from '../lib/api';
import { formatDateAr, formatTimestamp, isValidDate } from '../lib/dates';
import { supabase } from '../lib/supabase';
import { parseMoney, parseWeight } from '../lib/money';

export function OpeningCard({ book, opening, onSaved }: { book: 'qat' | 'insta'; opening: any; onSaved: () => void }) {
  const [edit, setEdit] = useState(!opening);
  const [start, setStart] = useState(opening?.start_date ?? '');
  const [money, setMoney] = useState(opening?.opening_money ?? '');
  const [weight, setWeight] = useState(opening?.opening_weight ?? '');
  const [reason, setReason] = useState('');
  const [errs, setErrs] = useState<Record<string, string>>({});
  const saver = useSaver();
  const submit = async () => {
    const e: Record<string, string> = {};
    if (!isValidDate(start)) e.start = 'تاريخ البداية مطلوب';
    const m = parseMoney(money, 'any'); if (!m.ok) e.money = m.error;
    const w = book === 'qat' ? parseWeight(weight, 'any') : null; if (w && !w.ok) e.weight = w.error;
    if (opening && !reason.trim()) e.reason = 'سبب تعديل الافتتاحية مطلوب';
    setErrs(e);
    if (Object.keys(e).length) return;
    const args = { p_book: book, p_start_date: start, p_opening_money: (m as any).value, p_opening_weight: w ? (w as any).value : null,
      p_expected_version: opening?.version ?? null, p_reason: reason || null };
    const out = await saver.save(JSON.stringify(args), (id) => rpc('set_opening', { p_request_id: id, ...args }));
    if (out) { setEdit(false); setReason(''); onSaved(); notifyChanged(); }
  };
  return (
    <div className="card opening">
      <h3>افتتاحية {book === 'qat' ? 'دفتر القطعيات' : 'دفتر إنستا'}</h3>
      {opening && !edit && (
        <div className="row">
          <span>تاريخ البداية: <strong>{formatDateAr(opening.start_date)}</strong></span>
          <span>الرصيد الافتتاحي: <strong data-testid={book + '-opening-money'}>{book === 'qat' ? <TraderBalance v={opening.opening_money} /> : <Money v={opening.opening_money} signed />}</strong></span>
          {book === 'qat' && <span>صافي الوزن الافتتاحي: <strong><Weight v={opening.opening_weight} /></strong> جرام</span>}
          <button className="btn small ghost no-print" onClick={() => setEdit(true)}>تعديل الافتتاحية</button>
        </div>
      )}
      {(!opening || edit) && (
        <div className="form no-print">
          {!opening && <p className="hint">أدخل تاريخ البداية والرصيد الافتتاحي صراحةً. البداية من الصفر اختيار صريح: اكتب 0. الأرصدة الافتتاحية تدخل مرة واحدة قبل حركات تاريخ البداية.</p>}
          <Field label="تاريخ بداية الدفتر" error={errs.start}><DateInput name={book + '_start'} value={start} onChange={setStart} /></Field>
          <Field label={book === 'qat' ? 'رصيد الفلوس الافتتاحي مع التاجر (موجب = عليك، سالب = لك)' : 'رصيد إنستا الافتتاحي'} error={errs.money}><NumInput name={book + '_opening_money'} value={money} onChange={setMoney} /></Field>
          {book === 'qat' && <Field label="صافي الوزن الافتتاحي (جرام)" error={errs.weight}><NumInput name="qat_opening_weight" value={weight} onChange={setWeight} /></Field>}
          {opening && <Field label="سبب التعديل" error={errs.reason}><input name={book + '_opening_reason'} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
          <div className="row">
            <button className="btn primary" onClick={submit} disabled={saver.state.status === 'saving'}>حفظ الافتتاحية</button>
            {opening && <button className="btn ghost" onClick={() => setEdit(false)}>إلغاء</button>}
          </div>
          <SaveStatus state={saver.state} onRetry={submit} />
        </div>
      )}
    </div>
  );
}

const ACTION_AR: Record<string, string> = { create: 'إنشاء', update: 'تعديل', cancel: 'إلغاء', restore: 'استعادة', delete: 'حذف نهائي' };
const FIELD_AR: Record<string, string> = {
  entry_date: 'التاريخ', entry_type: 'النوع', weight: 'الوزن', unit_price: 'السعر', amount: 'المبلغ', trader_name: 'التاجر', person_name: 'الاسم',
  note: 'الملاحظة', reason: 'السبب', status: 'الحالة', marked_paid: 'تم السداد', cash: 'الخزنة', price: 'السعر', name: 'الاسم',
  start_date: 'تاريخ البداية', opening_money: 'الرصيد الافتتاحي', opening_weight: 'الوزن الافتتاحي',
};
const IGNORE = new Set(['version', 'updated_at', 'created_at', 'cancelled_at', 'cash_set_at', 'price_set_at', 'seq', 'id']);

export function AuditModal({ entity, recordId, onClose }: { entity: string; recordId: string; onClose: () => void }) {
  const a = useLoad(() => rpc('list_audit', { p_entity: entity, p_record_id: recordId }), [entity, recordId]);
  return (
    <Modal title="سجل التعديلات" onClose={onClose}>
      {a.loading && <p>جارٍ التحميل…</p>}
      {a.data && (
        <ul className="audit">{a.data.rows.map((r: any) => {
          const keys = Object.keys({ ...(r.old_data ?? {}), ...(r.new_data ?? {}) }).filter((k) => !IGNORE.has(k));
          const changed = keys.filter((k) => JSON.stringify(r.old_data?.[k]) !== JSON.stringify(r.new_data?.[k]));
          return (
            <li key={r.id}>
              <strong>{ACTION_AR[r.action] ?? r.action}</strong> — {formatTimestamp(r.at)} {r.reason && <span>— السبب: {r.reason}</span>}
              {r.imported && <span className="tag warn"> مستورد من نسخة احتياطية</span>}
              {r.action !== 'create' && changed.length > 0 && (
                <table className="tbl small"><thead><tr><th>الحقل</th><th>قبل</th><th>بعد</th></tr></thead>
                  <tbody>{changed.map((k) => <tr key={k}><td>{FIELD_AR[k] ?? k}</td><td dir="auto">{String(r.old_data?.[k] ?? '—')}</td><td dir="auto">{String(r.new_data?.[k] ?? '—')}</td></tr>)}</tbody></table>
              )}
            </li>
          );
        })}</ul>
      )}
    </Modal>
  );
}

export function CancelModal({ title, onConfirm, onClose }: { title: string; onConfirm: (reason: string, requestId: string) => Promise<any>; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const saver = useSaver();
  const submit = async () => {
    if (!reason.trim()) return;
    const out = await saver.save(reason, (id) => onConfirm(reason, id));
    if (out) { notifyChanged(); onClose(); }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <p>الإلغاء لا يحذف السجل؛ يبقى ظاهرًا كملغى ويُستبعد من الحساب مرة واحدة، مع حفظ السبب في المراجعة.</p>
      <Field label="سبب الإلغاء (مطلوب)"><input name="cancel_reason" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
      <div className="row"><button className="btn danger" onClick={submit} disabled={!reason.trim() || saver.state.status === 'saving'}>تأكيد الإلغاء</button></div>
      <SaveStatus state={saver.state} onRetry={submit} />
    </Modal>
  );
}

export function PeriodBox({ period, weight, startDate }: { period: any; weight?: boolean; startDate?: string | null }) {
  if (!period) return null;
  if (startDate && period.to && period.to < startDate) {
    return <div className="card period" data-testid="period">الدفتر لم يبدأ بعد في هذه الفترة (تاريخ بداية الدفتر {formatDateAr(startDate)}).</div>;
  }
  return (
    <div className="card period" data-testid="period">
      <h4>كشف الفترة {period.from ? `من ${formatDateAr(period.from)}` : 'من البداية'} {period.to ? `إلى ${formatDateAr(period.to)}` : 'حتى الآن'}</h4>
      <div className="row">
        <span>رصيد ما قبل الفترة{period.from_before_start ? ' (الافتتاحي)' : ''}: <strong><Money v={period.before_money} signed /></strong>{weight && <> — وزن <Weight v={period.before_weight} /></>}</span>
        <span>صافي حركات الفترة: <strong><Money v={period.period_money} signed /></strong>{weight && <> — وزن <Weight v={period.period_weight} /></>}</span>
        <span>رصيد نهاية الفترة: <strong><Money v={period.end_money} signed /></strong>{weight && <> — وزن <Weight v={period.end_weight} /></>}</span>
      </div>
    </div>
  );
}

// زر «مسح» النهائي مخفي حتى تُطبَّق مهاجرة 20261023010000_hard_delete على Supabase.
export const HARD_DELETE_ENABLED = false;

/** حذف نهائي: يعيد التحقق من كلمة مرور الدخول عبر Supabase Auth، والخادم يرفض الحذف بدون مصادقة حديثة. */
export function DeleteModal({ title, summary, onDelete, onClose }: { title: string; summary: ReactNode; onDelete: (requestId: string) => Promise<any>; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const saver = useSaver();
  const submit = async () => {
    if (!password) { setPwError('أدخل كلمة المرور'); return; }
    setPwError(null);
    setChecking(true);
    const { data } = await supabase.auth.getUser();
    const email = data.user?.email;
    const { error } = email ? await supabase.auth.signInWithPassword({ email, password }) : { error: new Error('no user') };
    setChecking(false);
    if (error) { setPwError(/Invalid login/i.test(error.message) ? 'كلمة المرور غير صحيحة' : `تعذر التحقق: ${error.message}`); return; }
    setPassword('');
    const out = await saver.save('delete', (id) => onDelete(id));
    if (out) { notifyChanged(); onClose(); }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <div className="status fail" role="alert"><strong>حذف نهائي:</strong> الحركة ستُمسح من قاعدة البيانات ولن تدخل في أي حساب. يبقى سطر واحد في سجل التعديلات بقيمها. لا يمكن التراجع إلا باستعادة نسخة احتياطية.</div>
      <div className="card">{summary}</div>
      <Field label="كلمة مرور الدخول للتأكيد" error={pwError}>
        <input name="delete_password" type="password" dir="ltr" autoComplete="current-password" value={password}
          onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} autoFocus />
      </Field>
      <div className="row"><button className="btn danger" onClick={submit} disabled={checking || saver.state.status === 'saving'}>{checking ? 'جارٍ التحقق…' : 'مسح نهائي'}</button></div>
      <SaveStatus state={saver.state} onRetry={submit} />
    </Modal>
  );
}

import { useState } from 'react';
import { SaveStatus } from '../components';
import { notifyChanged, rpc, useLoad, useSaver } from '../lib/api';
import { formatTimestamp } from '../lib/dates';

const COUNT_AR: Record<string, string> = { qat_entries: 'قطعيات', insta_entries: 'حركات إنستا', daily_values: 'أيام خزنة/سعر', calc_snapshots: 'حسبات محفوظة', people: 'أشخاص', debt_entries: 'حركات الباقي على الناس', audit_log: 'سجل تعديلات' };

function download(name: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export async function exportToFile() {
  const data = await rpc('export_backup');
  const stamp = String(data.exported_at).slice(0, 16).replace(/[:T]/g, '-');
  download(`gold-ledger-backup-${stamp}.json`, JSON.stringify(data, null, 1));
  return data;
}

export function BackupPage({ state, reloadState }: { state: any; reloadState: () => void }) {
  const exp = useSaver();
  const res = useSaver();
  const [file, setFile] = useState<{ name: string; json: any; error?: string } | null>(null);
  const [prepared, setPrepared] = useState<string | null>(null);
  const events = useLoad(() => rpc('list_restore_events'), []);
  const doExport = () => exp.save('export:' + Date.now(), async () => { await exportToFile(); return { ok: true }; });

  const onFile = async (f: File | undefined) => {
    setFile(null); setPrepared(null); res.reset();
    if (!f) return;
    try {
      const json = JSON.parse(await f.text());
      let error: string | undefined;
      if (json?.format !== 'gold-ledger-backup') error = 'هذا الملف ليس نسخة احتياطية لدفاتر الذهب';
      else if (json.schema_version !== 1) error = `إصدار الملف (${json.schema_version}) غير مدعوم`;
      else if (!json.data || !json.checksum) error = 'الملف ناقص';
      setFile({ name: f.name, json, error });
      const st = await rpc('get_state');
      setPrepared(st.account?.data_version ?? '0');
    } catch {
      setFile({ name: f.name, json: null, error: 'الملف تالف أو ليس JSON' });
    }
  };
  const doRestore = async () => {
    if (!file?.json || file.error || prepared === null) return;
    const out = await res.save(`restore:${file.json.checksum}:${prepared}`, (id) =>
      rpc('restore_backup', { p_request_id: id, p_expected_data_version: Number(prepared), p_file: file.json }));
    if (out) { reloadState(); events.reload(); notifyChanged(); setPrepared(null); }
  };

  return (
    <section>
      <h2>النسخ الاحتياطي والإعدادات</h2>
      <div className="card">
        <h3>مكان حفظ البيانات</h3>
        <p>كل البيانات المعتمدة محفوظة في مشروع Supabase الخاص بك (PostgreSQL) وليس في المتصفح. أساس الوزن للدفتر: <strong>{state.account.weight_basis}</strong>.</p>
        <p className="hint">نسخ Supabase المُدارة تعتمد على خطة المشروع (الخطة المجانية لا تضمن نسخًا يمكنك استعادتها بنفسك). لذلك نزّل نسخة مستقلة بانتظام واحتفظ بها خارج الجهاز.</p>
      </div>
      <div className="card">
        <h3>تنزيل نسخة احتياطية كاملة</h3>
        <p>لقطة واحدة متسقة من قاعدة البيانات لكل دفاترك: الحركات، الافتتاحيات، الخزنة والأسعار، الحسبات المحفوظة، الباقي على الناس، وسجل التعديلات. لا تحتوي كلمات مرور أو مفاتيح.</p>
        <button className="btn primary" onClick={doExport} disabled={exp.state.status === 'saving'}>تنزيل النسخة الآن</button>
        {exp.state.status === 'saving' && <span className="status saving">جارٍ التجهيز…</span>}
        {exp.state.status === 'saved' && <span className="status ok">تم تجهيز الملف وتنزيله</span>}
        {exp.state.status === 'failed' && <span className="status fail">تعذر التصدير: {exp.state.message}</span>}
      </div>
      <div className="card">
        <h3>استعادة من ملف</h3>
        <p className="warn-text">⚠ الاستعادة <strong>تستبدل</strong> كل بيانات دفاترك في هذا الحساب ببيانات الملف (لا دمج). تُحفظ نسخة من بياناتك الحالية تلقائيًا في سجل الاستعادة قبل الاستبدال، ويُنصح بتنزيل نسخة أولًا.</p>
        <input type="file" accept="application/json,.json" name="restore_file" onChange={(e) => onFile(e.target.files?.[0])} />
        {file && (
          <div className="preview" data-testid="restore-preview">
            <div>الملف: <span dir="ltr">{file.name}</span></div>
            {file.error ? <div className="status fail" role="alert">{file.error} — لن يتغير شيء.</div> : (
              <>
                <div>تاريخ النسخة: {formatTimestamp(file.json.exported_at)}</div>
                <ul>{Object.entries(file.json.counts ?? {}).map(([k, v]) => <li key={k}>{COUNT_AR[k] ?? k}: {String(v)}</li>)}</ul>
                <button className="btn small" onClick={async () => { await exportToFile(); }}>تنزيل نسخة من الوضع الحالي أولًا</button>{' '}
                <button className="btn danger" onClick={doRestore} disabled={res.state.status === 'saving' || prepared === null}>تأكيد الاستبدال بهذه النسخة</button>
              </>
            )}
          </div>
        )}
        <SaveStatus state={res.state} onRetry={doRestore} />
        {res.state.status === 'failed' && res.state.kind === 'server' && <div className="hint">لم يتغير أي شيء في بياناتك. إن كان السبب تعارضًا فاختر الملف مرة أخرى لمراجعة الحالة الأحدث.</div>}
      </div>
      <div className="card">
        <h3>سجل عمليات الاستعادة</h3>
        {events.data?.length === 0 && <p className="muted">لا توجد عمليات استعادة.</p>}
        <ul>{events.data?.map((e: any) => <li key={e.id}>{formatTimestamp(e.restored_at)} — نسخة بتاريخ {formatTimestamp(e.file_exported_at)} — {e.counts.qat_entries} قطعية، {e.counts.insta_entries} إنستا
          {' '}<button className="btn small ghost" onClick={async () => { const prev = await rpc('get_restore_backup', { p_id: e.id }); download(`gold-ledger-before-restore-${String(e.restored_at).slice(0, 16).replace(/[:T]/g, '-')}.json`, JSON.stringify(prev, null, 1)); }}>تنزيل البيانات كما كانت قبل هذه الاستعادة</button></li>)}</ul>
      </div>
    </section>
  );
}

import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { Field, SaveStatus } from './components';
import { rpc, useLoad, useSaver } from './lib/api';
import { configError, supabase } from './lib/supabase';
import { ArchivePage } from './pages/Archive';
import { BackupPage } from './pages/Backup';
import { DailyPage } from './pages/Daily';
import { DayPage } from './pages/Day';
import { InstaPage } from './pages/Insta';
import { PeoplePage } from './pages/People';
import { QatPage } from './pages/Qat';

const TABS = [
  { id: 'day', label: 'حسبة اليوم' },
  { id: 'qat', label: 'القطعيات' },
  { id: 'insta', label: 'إنستا' },
  { id: 'daily', label: 'الخزنة والسعر' },
  { id: 'archive', label: 'أرشيف الحسبات' },
  { id: 'people', label: 'الباقي على الناس' },
  { id: 'backup', label: 'النسخ والإعدادات' },
] as const;
type TabId = (typeof TABS)[number]['id'];

function readHash(): { tab: TabId; date?: string } {
  const [t, d] = location.hash.replace(/^#/, '').split('/');
  const tab = (TABS.find((x) => x.id === t)?.id ?? 'day') as TabId;
  return { tab, date: d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined };
}

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  if (configError) return <div className="center"><div className="card"><h1>دفاتر الذهب</h1><p className="status fail">{configError}</p></div></div>;
  if (session === undefined) return <div className="center">جارٍ التحميل…</div>;
  if (!session) return <Login />;
  return <Shell session={session} />;
}

function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="center">
      <form className="card login" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        setBusy(false);
        if (error) setErr(error.message === 'Invalid login credentials' ? 'البريد أو كلمة المرور غير صحيحة' : `تعذر الدخول: ${error.message}`);
      }}>
        <h1>دفاتر الذهب</h1>
        <p className="muted">تسجيل دخول صاحب الدفتر</p>
        <Field label="البريد الإلكتروني"><input name="email" type="email" dir="ltr" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <Field label="كلمة المرور"><input name="password" type="password" dir="ltr" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        {err && <div className="status fail" role="alert">{err}</div>}
        <button className="btn primary" disabled={busy}>{busy ? 'جارٍ الدخول…' : 'دخول'}</button>
      </form>
    </div>
  );
}

function Shell({ session }: { session: Session }) {
  const [route, setRoute] = useState(readHash());
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const h = () => setRoute(readHash());
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('hashchange', h);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('hashchange', h); window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  const state = useLoad(() => rpc('get_state'), []);
  const go = (tab: TabId, date?: string) => { location.hash = date ? `${tab}/${date}` : tab; };
  const isTest = /gl-test-|@example\.test$/.test(session.user.email ?? '');

  return (
    <div className="app">
      <header className="top no-print">
        <div className="brand">دفاتر الذهب {state.data?.account && <span className="tag">أساس الوزن: {state.data.account.weight_basis}</span>}</div>
        <div className="who">
          {isTest && <span className="tag warn">حساب اختبار — ليس الدفتر الحقيقي</span>}
          <span className={'net ' + (online ? 'on' : 'off')}>{online ? 'متصل' : 'غير متصل — لن يتم الحفظ'}</span>
          <span dir="ltr" className="muted">{session.user.email}</span>
          <button className="btn small ghost" onClick={() => supabase.auth.signOut()}>خروج</button>
        </div>
      </header>
      {state.error && !state.data && <div className="status fail">تعذر الاتصال بالخادم: {state.error} <button className="btn small" onClick={state.reload}>إعادة</button></div>}
      {state.data && !state.data.account && <Setup onDone={state.reload} />}
      {state.data?.account && (
        <>
          <nav className="tabs no-print" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={route.tab === t.id} className={route.tab === t.id ? 'active' : ''} onClick={() => go(t.id)}>{t.label}</button>
            ))}
          </nav>
          <main>
            {route.tab === 'day' && <DayPage date={route.date} go={go} />}
            {route.tab === 'qat' && <QatPage state={state.data} reloadState={state.reload} />}
            {route.tab === 'insta' && <InstaPage state={state.data} reloadState={state.reload} />}
            {route.tab === 'daily' && <DailyPage go={go} />}
            {route.tab === 'archive' && <ArchivePage go={go} />}
            {route.tab === 'people' && <PeoplePage />}
            {route.tab === 'backup' && <BackupPage state={state.data} reloadState={state.reload} />}
          </main>
        </>
      )}
    </div>
  );
}

function Setup({ onDone }: { onDone: () => void }) {
  const [basis, setBasis] = useState('');
  const saver = useSaver();
  const submit = async () => {
    if (!basis.trim()) return;
    const r = await saver.save(basis, (id) => rpc('setup_account', { p_request_id: id, p_weight_basis: basis }));
    if (r) onDone();
  };
  return (
    <div className="card setup">
      <h2>إعداد الدفتر لأول مرة</h2>
      <p>اكتب عيار/أساس الوزن المرجعي لدفتر القطعيات. كل الأوزان وسعر اليوم ستكون على هذا الأساس، ولا يقوم التطبيق بتحويل العيارات.</p>
      <Field label="أساس الوزن (مثال: عيار 21)"><input name="weight_basis" value={basis} onChange={(e) => setBasis(e.target.value)} /></Field>
      <button className="btn primary" onClick={submit} disabled={!basis.trim() || saver.state.status === 'saving'}>حفظ</button>
      <SaveStatus state={saver.state} onRetry={submit} />
    </div>
  );
}

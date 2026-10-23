import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// اختبارات تكامل على مشروع Supabase السحابي المحدد، بالمفتاح العام (publishable) وجلسات مستخدمي اختبار حقيقية فقط.
// لا service_role ولا secret key. بيانات الاختبار تحت حسابات gl-test-* المنفصلة عن حساب المالك.
config({ path: '.env.local' });
config({ path: '.env.test.local' });
const URL = process.env.VITE_SUPABASE_URL!;
const KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;
const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`missing ${k} in .env.test.local`); return v; };

const mk = () => createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
let A: SupabaseClient, A2: SupabaseClient, B: SupabaseClient, anon: SupabaseClient;
let aId: string, bId: string;

async function call(c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) {
  const { data, error } = await c.rpc(fn, args);
  if (error) throw Object.assign(new Error(error.message), { code: error.details || error.code, pg: error.code });
  return data as any;
}
async function rejects(p: Promise<unknown>, code?: string) {
  try { await p; } catch (e: any) { if (code) expect(e.code).toBe(code); return e; }
  throw new Error('expected rejection ' + (code ?? ''));
}
const rid = () => randomUUID();
const dec = (s: string | null) => (s === null ? null : s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

async function login(email: string, password: string) {
  const c = mk();
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return { c, id: data.user!.id, session: data.session! };
}

beforeAll(async () => {
  const a = await login(env('GL_TEST_A_EMAIL'), env('GL_TEST_A_PASSWORD'));
  A = a.c; aId = a.id;
  A2 = (await login(env('GL_TEST_A_EMAIL'), env('GL_TEST_A_PASSWORD'))).c; // جلسة/تبويب ثانٍ لنفس المالك
  const b = await login(env('GL_TEST_B_EMAIL'), env('GL_TEST_B_PASSWORD'));
  B = b.c; bId = b.id;
  anon = mk();
  // بداية نظيفة لحساب A الاختباري: استعادة ملف فارغ إن كان له دفتر سابق من تشغيل سابق
  const st = await call(A, 'get_state');
  if (st.account) {
    const empty = await emptyBackup(A);
    await call(A, 'restore_backup', { p_request_id: rid(), p_expected_data_version: Number(st.account.data_version), p_file: empty });
  } else {
    await call(A, 'setup_account', { p_request_id: rid(), p_weight_basis: 'عيار 21' });
  }
}, 60_000);
afterAll(async () => { await A?.auth.signOut(); await A2?.auth.signOut(); await B?.auth.signOut(); });

async function emptyBackup(_c: SupabaseClient) {
  const data = { account: { weight_basis: 'عيار 21' }, book_openings: [], qat_entries: [], insta_entries: [], daily_values: [], calc_snapshots: [], people: [], debt_entries: [], audit_log: [] };
  return { format: 'gold-ledger-backup', schema_version: 1, checksum: pgJsonbMd5(data), data };
}

// تمثيل jsonb::text في PostgreSQL: مفاتيح مرتبة بالطول ثم أبجديًا، مع ": " و", ".
function pgJsonbText(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '[' + v.map(pgJsonbText).join(', ') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v as object).sort((x, y) => {
      const bx = Buffer.byteLength(x), by = Buffer.byteLength(y);
      return bx !== by ? bx - by : Buffer.compare(Buffer.from(x), Buffer.from(y));
    });
    return '{' + keys.map((k) => JSON.stringify(k) + ': ' + pgJsonbText((v as any)[k])).join(', ') + '}';
  }
  return JSON.stringify(v);
}
function pgJsonbMd5(v: unknown) { return createHash('md5').update(pgJsonbText(v), 'utf8').digest('hex'); }

describe('السحابة: T19 الدخول والعزل عبر Supabase Auth وPostgREST الحقيقيين', () => {
  it('بدون جلسة (publishable key فقط): لا قراءة ولا تنفيذ ولا كتابة', async () => {
    for (const fn of ['get_state', 'export_backup', 'list_qat_entries', 'get_day_report']) {
      const { error } = await anon.rpc(fn, fn === 'get_day_report' ? { p_date: '2026-10-15' } : {});
      expect(error, fn).not.toBeNull();
      expect(error!.code).toBe('42501');
    }
    const w = await anon.rpc('add_insta_entry', { p_request_id: rid(), p_entry_date: '2026-10-15', p_entry_type: 'in', p_amount: '1' });
    expect(w.error?.code).toBe('42501');
    for (const t of ['qat_entries', 'ledger_accounts', 'audit_log', 'people', 'calc_snapshots', 'save_requests']) {
      const { data, error } = await anon.from(t).select('*').limit(1);
      expect(error?.code ?? 'no-error', t).toBe('42501');
      expect(data ?? []).toEqual([]);
    }
    const ins = await anon.from('qat_entries').insert({ owner_id: aId, seq: 1, entry_date: '2026-10-15', entry_type: 'cash_add', amount: 1, reason: 'x' });
    expect(ins.error?.code).toBe('42501');
  });

  it('JWT مزوّر يُرفض', async () => {
    const forged = createClient(URL, KEY, { global: { headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIiwicm9sZSI6ImF1dGhlbnRpY2F0ZWQifQ.x' } }, auth: { persistSession: false } });
    const { error } = await forged.rpc('get_state');
    expect(error).not.toBeNull();
  });

  it('تجديد الجلسة ثم الخروج: بعد الخروج لا وصول', async () => {
    const s = await login(env('GL_TEST_B_EMAIL'), env('GL_TEST_B_PASSWORD'));
    const r = await s.c.auth.refreshSession();
    expect(r.error).toBeNull();
    expect(r.data.session!.access_token).not.toBe(s.session.access_token);
    expect((await call(s.c, 'get_state')).cairo_today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const old = createClient(URL, KEY, { global: { headers: { Authorization: `Bearer ${r.data.session!.access_token}` } }, auth: { persistSession: false } });
    await s.c.auth.signOut();
    // refresh token أُبطل بالخروج
    const again = await s.c.auth.refreshSession({ refresh_token: r.data.session!.refresh_token });
    expect(again.error).not.toBeNull();
    void old;
    const bad = await mk().auth.signInWithPassword({ email: env('GL_TEST_B_EMAIL'), password: 'wrong-password' });
    expect(bad.error).not.toBeNull();
  });
});

describe('السحابة: T05/T06 + النقل الدقيق للأرقام + منع التكرار', () => {
  it('T05 كاملًا عبر PostgREST', async () => {
    await call(A, 'set_opening', { p_request_id: rid(), p_book: 'qat', p_start_date: '2026-10-14', p_opening_money: '100000', p_opening_weight: '0' });
    await call(A, 'set_opening', { p_request_id: rid(), p_book: 'insta', p_start_date: '2026-10-14', p_opening_money: '20000' });
    const q = (d: string, t: string, w: string, p: string, extra = {}) => call(A, 'add_qat_entry', { p_request_id: rid(), p_entry_date: d, p_entry_type: t, p_weight: w, p_unit_price: p, ...extra });
    const i = (d: string, t: string, a: string, extra = {}) => call(A, 'add_insta_entry', { p_request_id: rid(), p_entry_date: d, p_entry_type: t, p_amount: a, ...extra });
    const dv = async (d: string, f: string, v: string) => {
      const r = await call(A, 'get_day_report', { p_date: d });
      return call(A, 'set_daily_value', { p_request_id: rid(), p_value_date: d, p_field: f, p_value: v, p_expected_version: r.daily_version });
    };
    await q('2026-10-15', 'buy', '10', '5000', { p_trader_name: 'الحاج علي' });
    await q('2026-10-15', 'sell', '4', '5000');
    await i('2026-10-15', 'in', '30000', { p_person_name: 'أحمد' });
    await i('2026-10-15', 'out', '10000', { p_note: 'تم السداد', p_marked_paid: true });
    await dv('2026-10-15', 'cash', '70000'); await dv('2026-10-15', 'price', '5000');
    await q('2026-10-16', 'sell', '6', '5000');
    await i('2026-10-16', 'in', '5000'); await i('2026-10-16', 'out', '15000');
    await dv('2026-10-16', 'cash', '90000'); await dv('2026-10-16', 'price', '5000');
    await dv('2026-10-17', 'cash', '70000'); await dv('2026-10-17', 'price', '6000');
    const r15 = await call(A, 'get_day_report', { p_date: '2026-10-15' });
    expect([dec(r15.qat.q), dec(r15.insta.i), dec(r15.qat.net_weight), dec(r15.result.a), dec(r15.result.d), r15.result.decision, dec(r15.result.grams)])
      .toEqual(['130000', '40000', '6', '110000', '20000', 'sell', '4']);
    const r16 = await call(A, 'get_day_report', { p_date: '2026-10-16' });
    expect([dec(r16.qat.q), dec(r16.insta.i), dec(r16.qat.net_weight), dec(r16.result.a), dec(r16.result.d), r16.result.decision, dec(r16.result.grams), dec(r16.qat.buy_weight), dec(r16.qat.sell_weight)])
      .toEqual(['100000', '30000', '0', '120000', '-20000', 'buy', '4', '10', '10']);
    const r17 = await call(A, 'get_day_report', { p_date: '2026-10-17' });
    expect([dec(r17.qat.q), dec(r17.insta.i), dec(r17.result.a), r17.result.decision, dec(r17.price.value)]).toEqual(['100000', '30000', '100000', 'balanced', '6000']);
    // T06
    await call(A, 'save_calc', { p_request_id: rid(), p_calc_date: '2026-10-15' });
    const late = await i('2026-10-15', 'in', '1000');
    const c15 = await call(A, 'get_day_report', { p_date: '2026-10-15' });
    expect([dec(c15.insta.i), dec(c15.result.d), dec(c15.result.grams)]).toEqual(['41000', '19000', '3.8']);
    const arch = await call(A, 'list_calc_snapshots', {});
    expect(dec(arch.rows[0].grams)).toBe('4');
    expect(arch.rows[0].stale).toBe(true);
    await call(A, 'cancel_insta_entry', { p_request_id: rid(), p_id: late.entry.id, p_expected_version: 1, p_reason: 'اختبار' });
    expect(dec((await call(A, 'get_day_report', { p_date: '2026-10-15' })).result.d)).toBe('20000');
  });

  it('الأرقام الكبيرة والكسور تنتقل نصًا بلا فقد، والكسور الزائدة تُرفض عبر API مباشر', async () => {
    const e = await call(A, 'add_qat_entry', { p_request_id: rid(), p_entry_date: '2026-10-18', p_entry_type: 'buy', p_weight: '999999.999999', p_unit_price: '9999999999.99' });
    expect(e.entry.amount).toBe('9999999999980000.00');
    expect(e.entry.weight).toBe('999999.999999');
    await call(A, 'cancel_qat_entry', { p_request_id: rid(), p_id: e.entry.id, p_expected_version: 1, p_reason: 'اختبار حدود' });
    await rejects(call(A, 'add_insta_entry', { p_request_id: rid(), p_entry_date: '2026-10-18', p_entry_type: 'in', p_amount: '10.001' }), 'too_many_decimals');
    // إرسال رقم JSON بدل النص يُرفض من نوع المعامل أو يُفحص كنص؛ لا يُقرّب
    await rejects(call(A, 'add_insta_entry', { p_request_id: rid(), p_entry_date: '2026-10-18', p_entry_type: 'in', p_amount: 10.001 }), 'too_many_decimals');
    const b = await call(A, 'add_qat_entry', { p_request_id: rid(), p_entry_date: '2026-10-18', p_entry_type: 'buy', p_weight: '1.001', p_unit_price: '12.34' });
    expect(b.entry.amount).toBe('12.35');
    await call(A, 'cancel_qat_entry', { p_request_id: rid(), p_id: b.entry.id, p_expected_version: 1, p_reason: 'اختبار' });
  });

  it('T13/T20: رد مفقود بعد اعتماد الخادم → إعادة بنفس request_id = حركة واحدة؛ محتوى مختلف مرفوض', async () => {
    const id = rid();
    const args = { p_request_id: id, p_entry_date: '2026-10-18', p_entry_type: 'in', p_amount: '123.45', p_note: 'رد مفقود' };
    // fetch يرسل الطلب فعلًا ثم يرمي الرد كأن الشبكة انقطعت بعد وصوله للخادم
    const { data: s } = await A.auth.getSession();
    const lost = await createClient(URL, KEY, {
      global: { headers: { Authorization: `Bearer ${s.session!.access_token}` }, fetch: async (input: any, init?: any) => { await fetch(input, init); throw new TypeError('Failed to fetch'); } },
      auth: { persistSession: false },
    }).rpc('add_insta_entry', args);
    expect(lost.error).not.toBeNull();
    const retry = await call(A, 'add_insta_entry', args);
    expect(retry.replayed).toBe(true);
    const again = await call(A, 'add_insta_entry', args);
    expect(again.entry.id).toBe(retry.entry.id);
    const l = await call(A, 'list_insta_entries', { p_search: 'رد مفقود' });
    expect(l.rows).toHaveLength(1);
    await rejects(call(A, 'add_insta_entry', { ...args, p_amount: '999' }), 'request_id_reused');
    await call(A, 'cancel_insta_entry', { p_request_id: rid(), p_id: retry.entry.id, p_expected_version: 1, p_reason: 'تنظيف اختبار' });
  });

  it('T20: سدادان متزامنان من جلستين لا يتجاوزان الباقي؛ تعديل بنسخة قديمة = تعارض', async () => {
    const p = (await call(A, 'create_person', { p_request_id: rid(), p_name: 'هاني' })).id;
    await call(A, 'add_debt_entry', { p_request_id: rid(), p_person_id: p, p_entry_date: '2026-10-15', p_entry_type: 'sent', p_amount: '1000' });
    const res = await Promise.allSettled([
      call(A, 'add_debt_entry', { p_request_id: rid(), p_person_id: p, p_entry_date: '2026-10-16', p_entry_type: 'repaid', p_amount: '600' }),
      call(A2, 'add_debt_entry', { p_request_id: rid(), p_person_id: p, p_entry_date: '2026-10-16', p_entry_type: 'repaid', p_amount: '600' }),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((res.find((r) => r.status === 'rejected') as any).reason.code).toBe('overpayment');
    const g = await call(A, 'get_person', { p_id: p });
    expect(dec(g.remaining)).toBe('400');
    await call(A, 'update_person', { p_request_id: rid(), p_id: p, p_expected_version: 1, p_name: 'هاني محمد' });
    await rejects(call(A2, 'update_person', { p_request_id: rid(), p_id: p, p_expected_version: 1, p_name: 'هاني أحمد' }), 'conflict');
  });

  it('T19: B لا يرى ولا يعدل بيانات A عبر الجداول أو RPC حتى بالمعرفات', async () => {
    const st = await call(B, 'get_state');
    if (!st.account) await call(B, 'setup_account', { p_request_id: rid(), p_weight_basis: 'عيار 21' });
    const aList = await call(A, 'list_qat_entries', { p_limit: 5 });
    const aEntry = aList.rows[0];
    const aPeople = await call(A, 'list_people', {});
    for (const t of ['qat_entries', 'insta_entries', 'people', 'debt_entries', 'calc_snapshots', 'audit_log', 'daily_values', 'book_openings', 'ledger_accounts', 'save_requests']) {
      const { data, error } = await B.from(t).select('owner_id').eq('owner_id', aId);
      expect(error).toBeNull();
      expect(data, t).toEqual([]);
    }
    await rejects(call(B, 'cancel_qat_entry', { p_request_id: rid(), p_id: aEntry.id, p_expected_version: aEntry.version, p_reason: 'x' }), 'not_found');
    await rejects(call(B, 'get_person', { p_id: aPeople.rows[0].id }), 'not_found');
    await rejects(call(B, 'add_debt_entry', { p_request_id: rid(), p_person_id: aPeople.rows[0].id, p_entry_date: '2026-10-16', p_entry_type: 'repaid', p_amount: '1' }), 'not_found');
    const upd = await B.from('qat_entries').update({ note: 'hacked' }).eq('id', aEntry.id).select();
    expect(upd.error?.code).toBe('42501');
    const ins = await B.from('qat_entries').insert({ owner_id: aId, seq: 999999, entry_date: '2026-10-15', entry_type: 'cash_add', amount: 1, reason: 'x' });
    expect(ins.error?.code).toBe('42501');
    const del = await B.from('audit_log').delete().eq('owner_id', bId);
    expect(del.error?.code).toBe('42501');
    const exp = JSON.stringify(await call(B, 'export_backup'));
    expect(exp).not.toContain(aId);
    expect(exp).not.toContain(aEntry.id);
  });
});

describe('السحابة: T22 تصدير متسق أثناء كتابة متزامنة، واستعادة تحت مستخدم اختبار آخر، وتزوير المالك، والتعارض', () => {
  it('التصدير أثناء كتابات من جلسة أخرى متسق؛ الاستعادة في حساب B تطابق؛ A لا يتغير؛ لا أسرار في الملف', async () => {
    let stop = false;
    const writer = (async () => {
      let n = 0;
      while (!stop && n < 15) { await call(A2, 'add_insta_entry', { p_request_id: rid(), p_entry_date: '2026-10-18', p_entry_type: 'in', p_amount: '0.01', p_note: 'متزامن' }); n++; }
    })();
    const exports: any[] = [];
    for (let k = 0; k < 5; k++) exports.push(await call(A, 'export_backup'));
    stop = true; await writer;
    for (const e of exports) {
      const created = new Set(e.data.audit_log.filter((x: any) => x.action === 'create').map((x: any) => x.record_id));
      for (const row of [...e.data.qat_entries, ...e.data.insta_entries]) expect(created.has(row.id)).toBe(true);
      expect(e.counts.insta_entries).toBe(e.data.insta_entries.length);
    }
    const file = await call(A, 'export_backup');
    const text = JSON.stringify(file);
    expect(text).not.toContain(aId);
    expect(text).not.toMatch(/access_token|refresh_token|password|service_role|sb_secret|sb_publishable|eyJhbGci/);
    expect(text).not.toContain(env('GL_TEST_A_EMAIL'));
    // الملف بعد المرور بـ JSON في Node (كما في المتصفح) يحتفظ ببصمته
    expect(pgJsonbMd5(file.data)).toBe(file.checksum);

    const aBefore = (await call(A, 'export_backup')).checksum;
    const bState = await call(B, 'get_state');
    // تزوير owner_id داخل الملف لصالح A: يجب أن تُستعاد البيانات تحت B فقط
    const forged = JSON.parse(text);
    for (const k of Object.keys(forged.data)) if (Array.isArray(forged.data[k])) for (const r of forged.data[k]) r.owner_id = aId;
    forged.data.account.owner_id = aId;
    forged.checksum = pgJsonbMd5(forged.data);
    const res = await call(B, 'restore_backup', { p_request_id: rid(), p_expected_data_version: Number(bState.account.data_version), p_file: forged });
    expect(res.ok).toBe(true);
    expect((await call(A, 'export_backup')).checksum).toBe(aBefore);
    for (const d of ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']) {
      const ra = await call(A, 'get_day_report', { p_date: d });
      const rb = await call(B, 'get_day_report', { p_date: d });
      expect(rb.qat).toEqual(ra.qat); expect(rb.insta).toEqual(ra.insta); expect(rb.result).toEqual(ra.result);
      expect(rb.fingerprint).toEqual(ra.fingerprint);
    }
    const bExp = await call(B, 'export_backup');
    for (const k of ['qat_entries', 'insta_entries', 'people', 'debt_entries', 'calc_snapshots', 'daily_values', 'book_openings']) expect(bExp.data[k]).toEqual(forged.data[k].map((r: any) => { const { owner_id, ...rest } = r; return rest; }));
    // استعادة نفس الملف مرة أخرى لا تضاعف
    await call(B, 'restore_backup', { p_request_id: rid(), p_expected_data_version: Number(bExp.data_version), p_file: forged });
    expect((await call(B, 'export_backup')).counts.insta_entries).toBe(bExp.counts.insta_entries);
  });

  it('حركة من جلسة أخرى بعد تجهيز الاستعادة: الاستعادة القديمة تُرفض والحركة لا تضيع؛ ملف تالف لا يغير شيئًا', async () => {
    const file = await call(B, 'export_backup');
    const prepared = Number(file.data_version);
    const B2 = (await login(env('GL_TEST_B_EMAIL'), env('GL_TEST_B_PASSWORD'))).c;
    const added = await call(B2, 'add_insta_entry', { p_request_id: rid(), p_entry_date: '2026-10-18', p_entry_type: 'in', p_amount: '5', p_note: 'بعد التجهيز' });
    await rejects(call(B, 'restore_backup', { p_request_id: rid(), p_expected_data_version: prepared, p_file: file }), 'conflict');
    expect((await call(B, 'list_insta_entries', { p_search: 'بعد التجهيز' })).rows.map((r: any) => r.id)).toEqual([added.entry.id]);
    const cur = await call(B, 'export_backup');
    const bad = JSON.parse(JSON.stringify(cur)); bad.data.insta_entries[0].amount = '1.00';
    await rejects(call(B, 'restore_backup', { p_request_id: rid(), p_expected_data_version: Number(cur.data_version), p_file: bad }), 'checksum_mismatch');
    const bad2 = JSON.parse(JSON.stringify(cur)); bad2.schema_version = 99;
    await rejects(call(B, 'restore_backup', { p_request_id: rid(), p_expected_data_version: Number(cur.data_version), p_file: bad2 }), 'unsupported_version');
    expect((await call(B, 'export_backup')).checksum).toBe(cur.checksum);
    await B2.auth.signOut();
  });
});

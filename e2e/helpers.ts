import { expect, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { createHash, randomUUID } from 'node:crypto';

config({ path: '.env.local' });
config({ path: '.env.test.local' });
export const E2E_EMAIL = process.env.GL_TEST_E2E_EMAIL!;
export const E2E_PASSWORD = process.env.GL_TEST_E2E_PASSWORD!;
export const EVIDENCE = 'e2e/evidence';

/** عميل API موثق بنفس حساب الاختبار، للتحقق أن السجلات وصلت لقاعدة البيانات فعلًا (وليس cache المتصفح). */
export async function apiClient() {
  const c = createClient(process.env.VITE_SUPABASE_URL!, process.env.VITE_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email: E2E_EMAIL, password: E2E_PASSWORD });
  if (error) throw error;
  const call = async (fn: string, args: Record<string, unknown> = {}) => {
    const { data, error: e } = await c.rpc(fn, args);
    if (e) throw new Error(`${fn}: ${e.message}`);
    return data as any;
  };
  return { c, call };
}

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

/** يعيد حساب E2E لدفتر فارغ (استعادة نسخة فارغة) — بيانات اختبار فقط */
export async function resetE2EAccount() {
  const { call } = await apiClient();
  const st = await call('get_state');
  if (!st.account) return;
  const data = { account: { weight_basis: 'عيار 21' }, book_openings: [], qat_entries: [], insta_entries: [], daily_values: [], calc_snapshots: [], people: [], debt_entries: [], audit_log: [] };
  const checksum = createHash('md5').update(pgJsonbText(data), 'utf8').digest('hex');
  await call('restore_backup', { p_request_id: randomUUID(), p_expected_data_version: Number(st.account.data_version), p_file: { format: 'gold-ledger-backup', schema_version: 1, checksum, data } });
}

export async function login(page: Page) {
  await page.goto('/');
  await page.fill('input[name=email]', E2E_EMAIL);
  await page.fill('input[name=password]', E2E_PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page.getByText('خروج')).toBeVisible();
}

export async function tab(page: Page, name: string) {
  await page.getByRole('tab', { name }).click();
}

/** يملأ التاريخ ويؤكد الحفظ بتاريخ سابق إذا طُلب */
export async function fillDate(page: Page, selector: string, date: string) {
  await page.fill(selector, date);
}
export async function confirmRetroIfAsked(page: Page) {
  const btn = page.getByRole('button', { name: /نعم، الحفظ بتاريخ/ });
  if (await btn.isVisible().catch(() => false)) await btn.click();
}
export async function expectSaved(page: Page, scope = page.locator('body')) {
  await expect(scope.locator('.status.ok').filter({ hasText: 'تم الحفظ' }).first()).toBeVisible();
}

import { expect, test, type Page } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { apiClient, confirmRetroIfAsked, EVIDENCE, expectSaved, login, resetE2EAccount, tab } from './helpers';

// T16: التدفقات الكاملة من الواجهة الحقيقية على مشروع Supabase السحابي (حساب اختبار E2E).
test.describe.configure({ mode: 'serial' });
mkdirSync(EVIDENCE, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: `${EVIDENCE}/${name}.png`, fullPage: true });

test.beforeAll(async () => { await resetE2EAccount(); });

async function qatEntry(page: Page, o: { type: string; date: string; weight?: string; price?: string; amount?: string; trader?: string; note?: string; reason?: string }) {
  await page.selectOption('select[name=qat_type]', o.type);
  await page.fill('input[name=qat_date]', o.date);
  if (o.weight) await page.fill('input[name=qat_weight]', o.weight);
  if (o.price) await page.fill('input[name=qat_price]', o.price);
  if (o.amount) await page.fill('input[name=qat_amount]', o.amount);
  await page.fill('input[name=qat_trader]', o.trader ?? '');
  await page.fill('input[name=qat_note]', o.note ?? '');
  await page.fill('input[name=qat_reason]', o.reason ?? '');
  await confirmRetroIfAsked(page);
  await page.getByRole('button', { name: 'حفظ الحركة' }).click();
  await expectSaved(page);
}
async function instaEntry(page: Page, o: { type: 'in' | 'out'; date: string; amount: string; person?: string; note?: string; paid?: boolean }) {
  await page.selectOption('select[name=insta_type]', o.type);
  await page.fill('input[name=insta_date]', o.date);
  await page.fill('input[name=insta_amount]', o.amount);
  await page.fill('input[name=insta_person]', o.person ?? '');
  await page.fill('input[name=insta_note]', o.note ?? '');
  await page.setChecked('input[name=insta_paid]', !!o.paid);
  await confirmRetroIfAsked(page);
  await page.getByRole('button', { name: 'حفظ الحركة' }).click();
  await expectSaved(page);
}
async function openDay(page: Page, date: string) {
  await page.goto(`/#day/${date}`);
  await expect(page.getByRole('heading', { name: /حسبة يوم/ })).toBeVisible();
  await expect(page.locator('input[name=calc_date]')).toHaveValue(date.replace(/-/g, '/'));
}
async function setDaily(page: Page, field: 'cash' | 'price', value: string) {
  const card = page.locator('.card', { has: page.locator(`input[name=${field}_value]`) });
  await card.locator(`input[name=${field}_value]`).fill(value);
  await card.getByRole('button', { name: /تسجيل|تعديل/ }).click();
  await expect(card.locator('.status.ok')).toBeVisible();
  await expect(page.getByTestId(field)).toBeVisible();
}

test('T16 التدفق الكامل: افتتاحيات، شراء، بيع، تسوية، إنستا، خزنة وسعر يومين، حسبة، ماضٍ، تصحيح، ناس، طباعة، تصدير واستعادة', async ({ page }) => {
  await login(page);
  await test.step('إعداد أساس الوزن (أول مرة فقط)', async () => {
    const setup = page.getByRole('heading', { name: 'إعداد الدفتر لأول مرة' });
    if (await setup.isVisible().catch(() => false)) {
      await page.fill('input[name=weight_basis]', 'عيار 21');
      await page.getByRole('button', { name: 'حفظ' }).click();
    }
    await expect(page.getByRole('tab', { name: 'القطعيات' })).toBeVisible();
  });

  await test.step('افتتاحيات القطعيات وإنستا', async () => {
    await tab(page, 'القطعيات');
    await page.fill('input[name=qat_start]', '2026-10-14');
    await page.fill('input[name=qat_opening_money]', '100,000');
    await page.fill('input[name=qat_opening_weight]', '0');
    await page.getByRole('button', { name: 'حفظ الافتتاحية' }).click();
    await expect(page.getByTestId('qat-opening-money')).toContainText('100,000.00');
    await tab(page, 'إنستا');
    await page.fill('input[name=insta_start]', '2026-10-14');
    await page.fill('input[name=insta_opening_money]', '٢٠٠٠٠');   // أرقام عربية
    await page.getByRole('button', { name: 'حفظ الافتتاحية' }).click();
    await expect(page.getByTestId('insta-opening-money')).toContainText('20,000.00');
  });

  await test.step('قطعيات يوم 15: شراء 10×5000، بيع 4×5000، إضافة وخصم متساويان', async () => {
    await tab(page, 'القطعيات');
    await page.selectOption('select[name=qat_type]', 'buy');
    await page.fill('input[name=qat_weight]', '10');
    await page.fill('input[name=qat_price]', '5000');
    await expect(page.getByTestId('qat-preview')).toHaveText('50,000.00');
    // الحفظ بتاريخ سابق يطلب تأكيدًا صريحًا
    await page.fill('input[name=qat_date]', '2026-10-15');
    await expect(page.getByText(/وليس اليوم/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'حفظ الحركة' })).toBeDisabled();
    await qatEntry(page, { type: 'buy', date: '2026-10-15', weight: '10', price: '5000', trader: 'الحاج علي', note: '<b>دفعة</b> أولى' });
    await qatEntry(page, { type: 'sell', date: '2026-10-15', weight: '4', price: '5000', trader: 'الحاج علي' });
    await qatEntry(page, { type: 'cash_add', date: '2026-10-15', amount: '1000', reason: 'فرق حساب' });
    await qatEntry(page, { type: 'cash_deduct', date: '2026-10-15', amount: '1000', reason: 'رد الفرق' });
    await expect(page.getByTestId('qat-book-money')).toContainText('130,000.00');
    await expect(page.getByText('<b>دفعة</b> أولى')).toBeVisible(); // HTML يظهر نصًا حرفيًا
    // إدخال غير صالح يُرفض برسالة ولا يُرسل
    await page.selectOption('select[name=qat_type]', 'buy');
    await page.fill('input[name=qat_weight]', '1.0000001');
    await page.fill('input[name=qat_price]', '5000');
    await confirmRetroIfAsked(page);
    await page.getByRole('button', { name: 'حفظ الحركة' }).click();
    await expect(page.getByText('الحد الأقصى 6 منازل عشرية')).toBeVisible();
    await page.fill('input[name=qat_weight]', '');
    await page.fill('input[name=qat_price]', '');
    await shot(page, '01-qat-day15');
  });

  await test.step('إنستا يوم 15 باسم وسحب بملاحظة تم السداد', async () => {
    await tab(page, 'إنستا');
    await instaEntry(page, { type: 'in', date: '2026-10-15', amount: '30000', person: 'أحمد' });
    await instaEntry(page, { type: 'out', date: '2026-10-15', amount: '10000', person: 'سعيد', note: 'تم السداد', paid: true });
    await expect(page.getByTestId('insta-book-money')).toContainText('40,000.00');
  });

  await test.step('خزنة وسعر يوم 15 → بيع 4 جرام، وحفظ الحسبة', async () => {
    await openDay(page, '2026-10-15');
    await expect(page.getByTestId('cash-missing')).toHaveText('رصيد الخزنة غير مسجل لهذا اليوم');
    await expect(page.getByTestId('incomplete')).toBeVisible();
    await setDaily(page, 'cash', '70000');
    await setDaily(page, 'price', '5000');
    await expect(page.getByTestId('q')).toContainText('130,000.00');
    await expect(page.getByTestId('i')).toContainText('40,000.00');
    await expect(page.getByTestId('net_weight')).toContainText('6');
    await expect(page.getByTestId('steps')).toContainText('70,000.00 + (40,000.00) = 110,000.00');
    await expect(page.getByTestId('steps')).toContainText('130,000.00 − (110,000.00) = 20,000.00');
    await expect(page.getByTestId('decision')).toHaveText(/بيع دهب بقيمة\s*20,000.00\s*جنيه — يعادل 4 جرام/);
    await expect(page.getByTestId('not-saved')).toBeVisible();
    await page.getByRole('button', { name: 'حفظ حسبة اليوم' }).click();
    await expectSaved(page);
    await expect(page.getByText(/حسبات محفوظة لهذا اليوم/)).toBeVisible();
    await shot(page, '02-day15-saved');
  });

  await test.step('يوم 16: بيع 6، إنستا +5000 −15000، خزنة 90000 → شراء 4 جرام', async () => {
    await tab(page, 'القطعيات');
    await qatEntry(page, { type: 'sell', date: '2026-10-16', weight: '6', price: '5000' });
    await tab(page, 'إنستا');
    await instaEntry(page, { type: 'in', date: '2026-10-16', amount: '5000' });
    await instaEntry(page, { type: 'out', date: '2026-10-16', amount: '15000' });
    await openDay(page, '2026-10-16');
    await setDaily(page, 'cash', '90000');
    await setDaily(page, 'price', '5000');
    await expect(page.getByTestId('decision')).toHaveText(/شراء دهب بقيمة\s*20,000.00\s*جنيه — يعادل 4 جرام/);
    await expect(page.getByTestId('net_weight')).toContainText('0');
  });

  await test.step('يوم 17 بلا حركات: خزنة 70000 سعر 6000 → متوازن؛ يوم 18 لا يرث الخزنة', async () => {
    await openDay(page, '2026-10-17');
    await setDaily(page, 'cash', '70000');
    await setDaily(page, 'price', '6000');
    await expect(page.getByTestId('decision')).toHaveText(/الحساب متوازن/);
    await page.getByRole('button', { name: /التالي/ }).click();
    await expect(page.locator('input[name=calc_date]')).toHaveValue('2026/10/18');
    await expect(page.getByTestId('cash-missing')).toBeVisible();
    await expect(page.getByTestId('incomplete')).toBeVisible();
    await shot(page, '03-day18-no-cash');
  });

  await test.step('مراجعة الماضي: يوم 15 بعد إدخال 16 و17 ما زال بيع 4 بسعر 5000', async () => {
    await openDay(page, '2026-10-15');
    await expect(page.getByTestId('decision')).toHaveText(/بيع دهب بقيمة\s*20,000.00/);
    await expect(page.getByTestId('price')).toContainText('5,000.00');
  });

  await test.step('تصحيح متأخر: وارد 1000 بتاريخ 15 → 19000 بيع 3.8، والأرشيف يحتفظ بالأصل مع تنبيه', async () => {
    await tab(page, 'إنستا');
    await instaEntry(page, { type: 'in', date: '2026-10-15', amount: '1000', note: 'تحويل متأخر' });
    await openDay(page, '2026-10-15');
    await expect(page.getByTestId('decision')).toHaveText(/بيع دهب بقيمة\s*19,000.00\s*جنيه — يعادل 3.8 جرام/);
    await expect(page.getByText('توجد تعديلات بعد حفظ هذه الحسبة')).toBeVisible();
    await tab(page, 'أرشيف الحسبات');
    const snap = page.getByTestId('snapshot').first();
    await expect(snap).toContainText('4 جرام');
    await expect(snap).toContainText('توجد تعديلات بعد حفظ هذه الحسبة');
    await expect(snap.getByTestId('decision')).toContainText('3.8 جرام');
    await snap.getByRole('button', { name: /حفظ نسخة جديدة مصححة/ }).click();
    await expect(page.getByTestId('snapshot')).toHaveCount(2);
    await shot(page, '04-archive-stale');
  });

  await test.step('تصحيح وزن قطعية مع سبب ثم عرض السجل', async () => {
    await tab(page, 'القطعيات');
    const row = page.getByTestId('qat-table').locator('tr', { hasText: 'بيع للتاجر' }).filter({ hasText: '6' }).first();
    await row.getByRole('button', { name: 'تصحيح' }).click();
    const modal = page.getByRole('dialog');
    await modal.locator('input[name=change_reason]').fill('مراجعة الميزان');
    await modal.locator('input[name=qat_weight]').fill('6.5');
    await confirmRetroIfAsked(page);
    await modal.getByRole('button', { name: 'حفظ التصحيح' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('qat-book-money')).toContainText('97,500.00');
    const row2 = page.getByTestId('qat-table').locator('tr', { hasText: '6.5' }).first();
    await row2.getByRole('button', { name: 'السجل' }).click();
    await expect(page.getByRole('dialog')).toContainText('مراجعة الميزان');
    await expect(page.getByRole('dialog')).toContainText('6.000000');
    await expect(page.getByRole('dialog')).toContainText('6.500000');
    await page.getByRole('button', { name: 'إغلاق' }).click();
    // إعادة الوزن الأصلي لاستكمال أرقام T05
    const row3 = page.getByTestId('qat-table').locator('tr', { hasText: '6.5' }).first();
    await row3.getByRole('button', { name: 'تصحيح' }).click();
    await page.getByRole('dialog').locator('input[name=change_reason]').fill('رجوع للوزن الصحيح');
    await page.getByRole('dialog').locator('input[name=qat_weight]').fill('6');
    await confirmRetroIfAsked(page);
    await page.getByRole('dialog').getByRole('button', { name: 'حفظ التصحيح' }).click();
    await expect(page.getByTestId('qat-book-money')).toContainText('100,000.00');
  });

  await test.step('الباقي على الناس: هاني 20000، سداد 5000، سداد زائد مرفوض، والمحل لم يتغير', async () => {
    await tab(page, 'الباقي على الناس');
    for (const n of ['ريمون', 'محمود', 'هاني']) {
      await page.fill('input[name=new_person]', n);
      await page.getByRole('button', { name: 'إضافة' }).click();
      await expect(page.getByTestId('people-table')).toContainText(n);
    }
    const add = async (name: string, type: 'sent' | 'repaid', amount: string, expectOk = true) => {
      await page.getByTestId('people-table').locator('tr', { hasText: name }).getByRole('button', { name: 'فتح' }).click();
      const m = page.getByRole('dialog');
      await m.locator('select[name=debt_type]').selectOption(type);
      await m.locator('input[name=debt_amount]').fill(amount);
      await m.getByRole('button', { name: 'حفظ' }).click();
      if (expectOk) await expect(m.locator('.status.ok')).toBeVisible();
      else await expect(m.locator('.status.fail')).toContainText('أكبر من المتبقي');
      await m.getByRole('button', { name: 'إغلاق' }).click();
    };
    await add('ريمون', 'sent', '1000');
    await add('محمود', 'sent', '5000');
    await add('هاني', 'sent', '20000');
    await expect(page.getByTestId('outstanding')).toContainText('26,000.00');
    await add('هاني', 'repaid', '5000');
    await expect(page.getByTestId('outstanding')).toContainText('21,000.00');
    await add('ريمون', 'repaid', '1000');
    await expect(page.getByTestId('outstanding')).toContainText('20,000.00');
    await expect(page.getByTestId('people-table').locator('tr', { hasText: 'ريمون' })).toContainText('تم السداد بالكامل');
    await add('هاني', 'repaid', '15000.01', false);
    await shot(page, '05-people');
    await openDay(page, '2026-10-17');
    await expect(page.getByTestId('decision')).toHaveText(/متوازن|بيع|شراء/);
  });

  await test.step('طباعة كشف القطعيات لفترة (PDF كدليل)', async () => {
    await tab(page, 'القطعيات');
    await page.fill('input[name=f_from]', '2026-10-15');
    await page.fill('input[name=f_to]', '2026-10-16');
    await page.getByRole('button', { name: 'عرض' }).click();
    await expect(page.getByTestId('period')).toContainText('100,000.00');
    await page.emulateMedia({ media: 'print' });
    await page.pdf({ path: `${EVIDENCE}/06-qat-statement.pdf`, format: 'A4' });
    await page.emulateMedia({ media: 'screen' });
  });

  await test.step('التحقق عبر API موثق أن السجلات في قاعدة البيانات فعلًا', async () => {
    const { call } = await apiClient();
    const r15 = await call('get_day_report', { p_date: '2026-10-15' });
    expect(r15.result.d).toBe('19000.00');
    expect(r15.snapshots).toHaveLength(2);
    const ins = await call('list_insta_entries', { p_search: 'سعيد' });
    expect(ins.rows[0].note).toBe('تم السداد');
    expect(ins.rows[0].marked_paid).toBe(true);
    const ppl = await call('list_people', {});
    expect(ppl.total_outstanding).toBe('20000.00');
  });

  await test.step('تصدير ثم استعادة من الواجهة، ثم التحقق من الأرقام', async () => {
    await tab(page, 'النسخ والإعدادات');
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'تنزيل النسخة الآن' }).click();
    const file = await dl;
    const path = `${EVIDENCE}/backup-from-ui.json`;
    await file.saveAs(path);
    const json = JSON.parse(readFileSync(path, 'utf8'));
    expect(json.format).toBe('gold-ledger-backup');
    expect(json.counts.qat_entries).toBe(5);
    // تعديل بعد التصدير ثم استعادة → يرجع للحالة المصدرة
    await tab(page, 'إنستا');
    await instaEntry(page, { type: 'in', date: '2026-10-17', amount: '777', note: 'بعد التصدير' });
    await tab(page, 'النسخ والإعدادات');
    // ملف تالف أولًا
    const bad = `${EVIDENCE}/bad.json`; writeFileSync(bad, '{"format": "gold-ledger-backup", "schema_version": 9}');
    await page.setInputFiles('input[name=restore_file]', bad);
    await expect(page.getByTestId('restore-preview')).toContainText('غير مدعوم');
    await page.setInputFiles('input[name=restore_file]', path);
    await expect(page.getByTestId('restore-preview')).toContainText('قطعيات: 5');
    await page.getByRole('button', { name: 'تأكيد الاستبدال بهذه النسخة' }).click();
    await expectSaved(page);
    await shot(page, '07-restored');
    await openDay(page, '2026-10-17');
    await expect(page.getByTestId('i')).toContainText('31,000.00'); // 777 اختفت لأنها بعد النسخة
    const { call } = await apiClient();
    expect((await call('list_insta_entries', { p_search: 'بعد التصدير' })).rows).toHaveLength(0);
    expect((await call('list_restore_events')).length).toBeGreaterThanOrEqual(1);
  });

  await test.step('إعادة تحميل الصفحة: البيانات باقية', async () => {
    await page.reload();
    await openDay(page, '2026-10-15');
    await expect(page.getByTestId('decision')).toHaveText(/19,000.00/);
  });
});

test('T13 إغلاق المتصفح وفتحه: سياق جديد يسجل الدخول ويجد نفس البيانات', async ({ browser }) => {
  const ctx = await browser.newContext({ locale: 'ar-EG', timezoneId: 'Africa/Cairo' });
  const page = await ctx.newPage();
  await login(page);
  await openDay(page, '2026-10-16');
  // بعد الاستعادة: يوم 16 يشمل وارد 1000 المتأخر بتاريخ 15 → I=31000، A=121000، D=-21000
  await expect(page.getByTestId('decision')).toHaveText(/شراء دهب بقيمة\s*21,000.00\s*جنيه — يعادل 4.2 جرام/);
  await tab(page, 'الباقي على الناس');
  await expect(page.getByTestId('outstanding')).toContainText('20,000.00');
  await shot(page, '08-reopen');
  await ctx.close();
});

test('T20 الشبكة: انقطاع قبل الحفظ، رد مفقود بعد الحفظ، ضغط مزدوج', async ({ page, context }) => {
  await login(page);
  const { call } = await apiClient();
  await tab(page, 'إنستا');
  await test.step('انقطاع قبل الحفظ: لم يتم الحفظ والبيانات باقية في النموذج', async () => {
    await context.setOffline(true);
    await page.selectOption('select[name=insta_type]', 'in');
    await page.fill('input[name=insta_date]', '2026-10-17');
    await page.fill('input[name=insta_amount]', '11.11');
    await page.fill('input[name=insta_note]', 'اختبار انقطاع');
    await confirmRetroIfAsked(page);
    await page.getByRole('button', { name: 'حفظ الحركة' }).click();
    await expect(page.locator('.form .status.fail')).toContainText('لم يتم الحفظ');
    await expect(page.getByText('غير متصل — لن يتم الحفظ')).toBeVisible();
    await expect(page.locator('input[name=insta_amount]')).toHaveValue('11.11');
    await shot(page, '09-offline');
    await context.setOffline(false);
    expect((await call('list_insta_entries', { p_search: 'اختبار انقطاع' })).rows).toHaveLength(0);
    await page.getByRole('button', { name: 'إعادة المحاولة' }).click();
    await expectSaved(page);
    expect((await call('list_insta_entries', { p_search: 'اختبار انقطاع' })).rows).toHaveLength(1);
  });
  await test.step('رد مفقود بعد اعتماد الخادم: تعذر تأكيد الحفظ، وإعادة المحاولة لا تكرر', async () => {
    let dropped = 0;
    await page.route('**/rest/v1/rpc/add_insta_entry', async (route) => {
      if (dropped === 0) { dropped++; await route.fetch(); await route.abort('connectionreset'); } else await route.continue();
    });
    await page.fill('input[name=insta_amount]', '22.22');
    await page.fill('input[name=insta_note]', 'اختبار رد مفقود');
    await confirmRetroIfAsked(page);
    await page.getByRole('button', { name: 'حفظ الحركة' }).click();
    await expect(page.locator('.form .status.fail')).toContainText('تعذر تأكيد الحفظ');
    expect((await call('list_insta_entries', { p_search: 'اختبار رد مفقود' })).rows).toHaveLength(1); // وصل فعلًا
    await shot(page, '10-lost-response');
    await page.getByRole('button', { name: 'إعادة المحاولة' }).click();
    await expect(page.locator('.form .status.ok')).toContainText('لم يُكرر');
    expect((await call('list_insta_entries', { p_search: 'اختبار رد مفقود' })).rows).toHaveLength(1);
    await page.unroute('**/rest/v1/rpc/add_insta_entry');
  });
  await test.step('ضغط مزدوج سريع = حركة واحدة', async () => {
    await page.fill('input[name=insta_amount]', '33.33');
    await page.fill('input[name=insta_note]', 'اختبار ضغط مزدوج');
    await confirmRetroIfAsked(page);
    const b = page.getByRole('button', { name: 'حفظ الحركة' });
    await b.dblclick();
    await expectSaved(page);
    await page.waitForTimeout(1500);
    expect((await call('list_insta_entries', { p_search: 'اختبار ضغط مزدوج' })).rows).toHaveLength(1);
  });
});

test('T13 تعارض تعديل من تبويبين', async ({ browser }) => {
  const ctx = await browser.newContext({ locale: 'ar-EG', timezoneId: 'Africa/Cairo' });
  const p1 = await ctx.newPage();
  await login(p1);
  const p2 = await ctx.newPage();
  await p2.goto('/');
  for (const p of [p1, p2]) { await p.goto('/#day/2026-10-17'); await expect(p.getByTestId('cash')).toBeVisible(); }
  const set = async (p: Page, v: string) => {
    const card = p.locator('.card', { has: p.locator('input[name=cash_value]') });
    await card.locator('input[name=cash_value]').fill(v);
    await card.getByRole('button', { name: 'تعديل' }).click();
    return card;
  };
  const c1 = await set(p1, '71000');
  await expect(c1.locator('.status.ok')).toBeVisible();
  // التبويب الثاني ما زال يحمل النسخة القديمة (لم يُعد التحميل)
  const c2 = await set(p2, '72000');
  await expect(c2.locator('.status.fail')).toContainText('من مكان آخر');
  await p2.screenshot({ path: `${EVIDENCE}/11-conflict.png`, fullPage: true });
  const { call } = await apiClient();
  expect((await call('get_day_report', { p_date: '2026-10-17' })).cash.value).toBe('71000.00');
  // إرجاع القيمة الأصلية
  await p1.reload(); await expect(p1.getByTestId('cash')).toContainText('71,000.00');
  await set(p1, '70000');
  await ctx.close();
});

test('R8 تعديل الافتتاحية من تبويب قديم لا يكتب فوق تعديل تبويب آخر', async ({ browser }) => {
  const ctx = await browser.newContext({ locale: 'ar-EG', timezoneId: 'Africa/Cairo' });
  const p1 = await ctx.newPage();
  await login(p1);
  const p2 = await ctx.newPage();
  for (const p of [p1, p2]) { await p.goto('/#insta'); await expect(p.getByTestId('insta-opening-money')).toContainText('20,000.00'); }
  await p2.getByRole('button', { name: 'تعديل الافتتاحية' }).click();
  await p2.fill('input[name=insta_opening_money]', '21000');
  await p2.fill('input[name=insta_opening_reason]', 'تعديل من التبويب الثاني');
  await p2.getByRole('button', { name: 'حفظ الافتتاحية' }).click();
  await expect(p2.getByTestId('insta-opening-money')).toContainText('21,000.00');
  await p1.bringToFront();
  await p1.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(p1.getByTestId('insta-opening-money')).toContainText('21,000.00');
  await p1.getByRole('button', { name: 'تعديل الافتتاحية' }).click();
  await expect(p1.locator('input[name=insta_opening_money]')).toHaveValue('21000.00');
  // إرجاع القيمة
  await p1.fill('input[name=insta_opening_money]', '20000');
  await p1.fill('input[name=insta_opening_reason]', 'إرجاع');
  await p1.getByRole('button', { name: 'حفظ الافتتاحية' }).click();
  await expect(p1.getByTestId('insta-opening-money')).toContainText('20,000.00');
  await ctx.close();
});

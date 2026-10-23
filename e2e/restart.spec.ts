import { expect, test } from '@playwright/test';
import { EVIDENCE, login, tab } from './helpers';

// يُشغَّل في تشغيل Playwright منفصل بعد flows.spec.ts: خادم الويب (vite) يُوقف ويُشغَّل من جديد بين التشغيلين،
// والمتصفح جديد بلا أي حالة محفوظة. البيانات يجب أن تأتي من Supabase كما هي.
test('T13 بعد إيقاف تطبيق الويب وتشغيله: الحركات والأسماء والملاحظات والأرصدة والأسعار والحسبات كما هي', async ({ page }) => {
  await login(page);
  await page.goto('/#day/2026-10-15');
  await expect(page.locator('input[name=calc_date]')).toHaveValue('2026/10/15');
  await expect(page.getByTestId('price')).toContainText('5,000.00');
  await expect(page.getByTestId('cash')).toContainText('70,000.00');
  await expect(page.getByTestId('decision')).toHaveText(/بيع دهب بقيمة\s*19,000.00\s*جنيه — يعادل 3.8 جرام/);
  await expect(page.getByText('توجد تعديلات بعد حفظ هذه الحسبة')).toBeVisible();
  await tab(page, 'إنستا');
  await expect(page.getByTestId('insta-table')).toContainText('تم السداد');
  await expect(page.getByTestId('insta-table')).toContainText('سعيد');
  await tab(page, 'القطعيات');
  await expect(page.getByTestId('qat-table')).toContainText('<b>دفعة</b> أولى');
  await expect(page.getByTestId('qat-table')).toContainText('الحاج علي');
  await tab(page, 'أرشيف الحسبات');
  await expect(page.getByTestId('snapshot')).toHaveCount(2);
  await tab(page, 'الباقي على الناس');
  await expect(page.getByTestId('outstanding')).toContainText('20,000.00');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#day/2026-10-16');
  await expect(page.getByTestId('decision')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
  await page.screenshot({ path: `${EVIDENCE}/12-mobile-day16.png`, fullPage: true });
});

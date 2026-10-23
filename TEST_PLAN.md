# خريطة المتطلبات والاختبارات

البيئات المستخدمة:
- **E (محرك)**: `npm run test:engine` — TypeScript بلا قاعدة بيانات.
- **L (محلي)**: `npm run test:db` — PostgreSQL 17.10 حقيقي مؤقت، مع محاكاة أدوار وauth لـ Supabase. تُطبَّق المهاجرات من الصفر في كل تشغيل، والاختبارات المدمرة هنا فقط.
- **C (سحابي)**: `npm run test:cloud` — مشروع Supabase الحقيقي عبر PostgREST وAuth، بالمفتاح العام وحسابات اختبار.
- **B (متصفح)**: `npm run test:e2e` ثم `GL_E2E_RESTART=1 npx playwright test` — الواجهة الحقيقية مع Supabase السحابي.

| الاختبار | المحتوى | الملفات / السيناريو | البيئة |
|---|---|---|---|
| T01 | رصيد القطعيات 130500، وأوزان 10/4/6، والتسويات لا تغير الوزن، والرصيد الجاري | `tests/db/rules.test.ts` «T01» | L |
| T02 | إنستا 320 ثم 470، وماضٍ 320، وتم السداد والاسم لا يغيران | `rules.test.ts` «T02» | L، B |
| T03 | الخزنة غير تراكمية، وتعديل 1700 مع المراجعة، وتعارض تبويبين | `rules.test.ts` «T03»، `e2e/flows.spec.ts` «تعارض» | L، B |
| T04 | اتجاه القرار للحالات الثلاث | `rules.test.ts` «T04»، `tests/engine` «T04» | L، E |
| T05 | التاريخ المتصل 14–18 | `tests/db/t05_history.test.ts`، `tests/cloud` «T05»، `e2e` T16 | L، C، B |
| T06 | حسبة محفوظة + وارد متأخر: 19000 و3.8، والنسخة القديمة 4 مع تنبيه، والإلغاء يعيد الأصل | `t05_history.test.ts` «T06»، cloud، e2e | L، C، B |
| T07 | نقص البيانات، والافتتاحيات، وما قبل البداية، والمستقبل | `rules.test.ts` «T07» | L، B |
| T08 | الباقي على الناس: 26000→21000→20000، والإلغاء، والزيادة، والماضي، واستقلال المحل | `tests/db/debts_precision.test.ts` «T08»، e2e | L، B |
| T09 | الدقة والتقريب والجرامات الصغيرة والجمع المتكرر | `debts_precision.test.ts` «T09»، engine «T09» | L، E |
| T10 | الإدخال: عربي/إنجليزي، فواصل، فارغ، نص، سالب، كسور، حدود، HTML | engine «T10»، `debts_precision.test.ts` «T10»، e2e | E، L، B |
| T11 | الإشارات: Q سالب، I سالب | `rules.test.ts` «T11»، engine | L، E |
| T12 | كشف الفترة، والفلترة، والصفحات، والترتيب الثابت | `debts_precision.test.ts` «T12»، `volume_props_dates.test.ts` T18 | L |
| T13 | تخزين حقيقي، وإعادة تحميل، وإغلاق المتصفح، وإعادة تشغيل الخادم، وضغط مزدوج، ورد مفقود، وتعارض | `security_atomic.test.ts`، cloud، `e2e/flows.spec.ts`، `e2e/restart.spec.ts` | L، C، B |
| T14 | فشل في منتصف الحفظ (trigger يفشل بعد الإدراج) | `security_atomic.test.ts` «T14» | L |
| T15 | تصدير واستعادة في قاعدة جديدة، وملف تالف، وإصدار، ومرتين | `tests/db/backup.test.ts` «T15»، e2e | L، B |
| T16 | التدفقات الكاملة من الواجهة | `e2e/flows.spec.ts` | B |
| T17 | منتصف الليل بالقاهرة، والتوقيت الصيفي، ونهاية الشهر/السنة، وتاريخ الإدخال ≠ العملية | engine «T17»، `volume_props_dates.test.ts` «T17» | E، L |
| T18 | 10,000 حركة مع قياس الزمن | `volume_props_dates.test.ts` «T18» | L |
| T19 | الدخول والخروج والتجديد، وanon، والعزل A/B، والتزوير، وWITH CHECK | `security_atomic.test.ts` «T19»، cloud «T19» | L، C |
| T20 | الشبكة، وإعادة المحاولة بنفس request_id، وسداد متزامن | `security_atomic.test.ts`، cloud، `e2e` «T20» | L، C، B |
| T21 | المهاجرات من الصفر، و numeric، والقيود، والثبات، ومهاجرة لاحقة فوق بيانات | `globalSetup.ts`، `security_atomic.test.ts` «T21»، `platform_objects.test.ts`، بصمة المخطط | L، C |
| T22 | تصدير متسق أثناء الكتابة، واستعادة تحت مستخدم آخر، وتزوير owner_id، وتعارض، وفشل جزئي، ولا أسرار | `backup.test.ts` «T22»، cloud «T22» | L، C |
| خصائص | ترتيب الإدخال، والإضافة والعكس، واستقلال التاب، والتصحيح لا يمحو النسخ، والمستقبل لا يؤثر | `volume_props_dates.test.ts` «خصائص»، engine «خصائص» | L، E |

التوقعات الرقمية مكتوبة يدويًا في الاختبارات. المرجع المستقل في اختبارات الخصائص وT18 هو decimal.js، وليس دوال الإنتاج.

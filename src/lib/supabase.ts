import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const configError = !url || !key
  ? 'إعدادات الاتصال ناقصة: VITE_SUPABASE_URL و VITE_SUPABASE_PUBLISHABLE_KEY غير مضبوطين (ملف .env.local محليًا، أو متغيرات البناء في Cloudflare).'
  : null;

// جلسة Supabase Auth فقط تُحفظ في المتصفح (ليست بيانات مالية). كل الأرقام تُقرأ من الخادم.
export const supabase = createClient(url ?? 'http://invalid.local', key ?? 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

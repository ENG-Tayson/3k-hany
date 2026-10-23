@echo off
chcp 65001 >nul
title دفاتر الذهب
cd /d "%~dp0"
if not exist ".env.local" (
  echo [!] ملف .env.local غير موجود. أنشئه واكتب فيه VITE_SUPABASE_URL و VITE_SUPABASE_PUBLISHABLE_KEY (راجع README).
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo تثبيت الاعتمادات لأول مرة...
  call npm ci || (echo فشل التثبيت & pause & exit /b 1)
)
echo تجهيز نسخة التشغيل...
call npm run build || (echo فشل البناء & pause & exit /b 1)
echo.
echo التطبيق يعمل على: http://127.0.0.1:5173
echo البيانات محفوظة في Supabase وليست في هذا الجهاز. أغلق هذه النافذة لإيقاف التطبيق.
start "" http://127.0.0.1:5173
call npm run preview

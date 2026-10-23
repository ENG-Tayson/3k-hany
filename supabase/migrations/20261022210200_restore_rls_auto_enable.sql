-- إصلاح: النسخة الأولى من مهاجرة الدوال (كما طُبقت على المشروع السحابي في 2026-10-22) كانت تمر على كل دوال public،
-- فغيّرت مالك دالة المنصة public.rls_auto_enable (دالة event trigger «ensure_rls») إلى ledger_writer وعدّلت صلاحياتها.
-- هذه المهاجرة تعيدها لحالتها الأصلية: المالك postgres والصلاحيات الافتراضية لمخطط public. لا تفعل شيئًا إن كانت سليمة.
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'rls_auto_enable' and pg_get_userbyid(p.proowner) = 'ledger_writer') then
    alter function public.rls_auto_enable() owner to postgres;
    grant execute on function public.rls_auto_enable() to public, postgres, anon, authenticated, service_role;
  end if;
end $$;

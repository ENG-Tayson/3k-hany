-- بصمة المخطط: تُشغَّل على المحلي والسحابي للتأكد من تطابق ما طُبّق فعلًا مع الملفات المختبرة.
select
  (select md5(string_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):'
          || md5(pg_get_functiondef(p.oid)) || ':' || pg_get_userbyid(p.proowner) || ':' || coalesce(p.proacl::text, ''), ','
          order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'ledger_private') and p.proname <> 'rls_auto_enable') as functions_md5,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'ledger_private') and p.proname <> 'rls_auto_enable') as function_count,
  (select md5(string_agg(table_name || '.' || column_name || ':' || data_type || ':' || coalesce(numeric_precision::text, '') || ','
          || coalesce(numeric_scale::text, '') || ':' || is_nullable || ':' || coalesce(column_default, ''), ',' order by table_name, ordinal_position))
     from information_schema.columns where table_schema = 'public') as columns_md5,
  (select md5(string_agg(tablename || ':' || policyname || ':' || cmd || ':' || array_to_string(roles, '+') || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), ','
          order by tablename, policyname)) from pg_policies where schemaname = 'public') as policies_md5,
  (select md5(string_agg(conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid), ',' order by conrelid::regclass::text, conname))
     from pg_constraint where connamespace = 'public'::regnamespace) as constraints_md5,
  (select md5(string_agg(c.relname || ':' || coalesce(c.relacl::text, '') || ':' || c.relrowsecurity || c.relforcerowsecurity, ',' order by c.relname))
     from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r') as table_acl_md5;

-- حذف نهائي للحركات بطلب المالك (2026-10-23)، بشرط إعادة إدخال كلمة مرور الدخول.
-- يُفرض على الخادم: يجب أن تحمل الجلسة مصادقة بكلمة المرور (amr.method = 'password') حديثة (≤ 180 ثانية).
-- الحذف يُسجَّل في audit_log بالقيم القديمة (action = 'delete')، والحسبات المحفوظة المتأثرة تظهر «توجد تعديلات» تلقائيًا.

create function ledger_private.require_recent_password(p_max_age_seconds int default 180) returns void
language plpgsql stable set search_path = '' as $$
declare v_ts numeric; v_amr jsonb;
begin
  v_amr := nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'amr';
  if v_amr is not null and jsonb_typeof(v_amr) = 'array' then
    select max((e ->> 'timestamp')::numeric) into v_ts
      from jsonb_array_elements(v_amr) e
     where e ->> 'method' = 'password';
  end if;
  if v_ts is null or extract(epoch from now()) - v_ts > p_max_age_seconds then
    perform ledger_private.fail('reauth_required', 'المسح النهائي يحتاج إدخال كلمة المرور مرة أخرى');
  end if;
end $$;

create function public.delete_qat_entry(p_request_id uuid, p_id uuid, p_expected_version int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_params jsonb; v_prev jsonb; old public.qat_entries;
begin
  perform ledger_private.require_recent_password();
  v_params := jsonb_build_object('id', p_id, 'expected_version', p_expected_version);
  v_prev := ledger_private.begin_write(v_owner, p_request_id, 'delete_qat_entry', v_params);
  if v_prev is not null then return v_prev; end if;
  select * into old from public.qat_entries where owner_id = v_owner and id = p_id for update;
  if not found then perform ledger_private.fail('not_found', 'الحركة غير موجودة'); end if;
  if p_expected_version is null or old.version <> p_expected_version then
    perform ledger_private.fail('conflict', 'تم تعديل هذه الحركة من مكان آخر؛ أعد التحميل');
  end if;
  delete from public.qat_entries where owner_id = v_owner and id = p_id;
  perform ledger_private.audit(v_owner, 'qat_entries', p_id::text, 'delete', to_jsonb(old), null,
    'حذف نهائي بعد تأكيد كلمة المرور', p_request_id);
  return ledger_private.finish_write(v_owner, p_request_id, 'delete_qat_entry', v_params,
    jsonb_build_object('ok', true, 'deleted', p_id));
end $$;

create function public.delete_insta_entry(p_request_id uuid, p_id uuid, p_expected_version int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_params jsonb; v_prev jsonb; old public.insta_entries;
begin
  perform ledger_private.require_recent_password();
  v_params := jsonb_build_object('id', p_id, 'expected_version', p_expected_version);
  v_prev := ledger_private.begin_write(v_owner, p_request_id, 'delete_insta_entry', v_params);
  if v_prev is not null then return v_prev; end if;
  select * into old from public.insta_entries where owner_id = v_owner and id = p_id for update;
  if not found then perform ledger_private.fail('not_found', 'الحركة غير موجودة'); end if;
  if p_expected_version is null or old.version <> p_expected_version then
    perform ledger_private.fail('conflict', 'تم تعديل هذه الحركة من مكان آخر؛ أعد التحميل');
  end if;
  delete from public.insta_entries where owner_id = v_owner and id = p_id;
  perform ledger_private.audit(v_owner, 'insta_entries', p_id::text, 'delete', to_jsonb(old), null,
    'حذف نهائي بعد تأكيد كلمة المرور', p_request_id);
  return ledger_private.finish_write(v_owner, p_request_id, 'delete_insta_entry', v_params,
    jsonb_build_object('ok', true, 'deleted', p_id));
end $$;

create function public.delete_debt_entry(p_request_id uuid, p_id uuid, p_expected_version int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_params jsonb; v_prev jsonb; old public.debt_entries;
begin
  perform ledger_private.require_recent_password();
  v_params := jsonb_build_object('id', p_id, 'expected_version', p_expected_version);
  v_prev := ledger_private.begin_write(v_owner, p_request_id, 'delete_debt_entry', v_params);
  if v_prev is not null then return v_prev; end if;
  select * into old from public.debt_entries where owner_id = v_owner and id = p_id for update;
  if not found then perform ledger_private.fail('not_found', 'الحركة غير موجودة'); end if;
  if p_expected_version is null or old.version <> p_expected_version then
    perform ledger_private.fail('conflict', 'تم تعديل هذه الحركة من مكان آخر؛ أعد التحميل');
  end if;
  delete from public.debt_entries where owner_id = v_owner and id = p_id;
  -- حذف «بعت له» عليه سداد يجعل السداد غير مغطى → يُرفض ويُلغى الحذف
  perform ledger_private.assert_debt_timeline(v_owner, old.person_id);
  perform ledger_private.audit(v_owner, 'debt_entries', p_id::text, 'delete', to_jsonb(old), null,
    'حذف نهائي بعد تأكيد كلمة المرور', p_request_id);
  return ledger_private.finish_write(v_owner, p_request_id, 'delete_debt_entry', v_params,
    jsonb_build_object('ok', true, 'deleted', p_id));
end $$;

revoke all on function ledger_private.require_recent_password(int) from public, anon, authenticated, service_role;
grant execute on function ledger_private.require_recent_password(int) to ledger_writer;

grant create on schema public to ledger_writer;
do $$
declare f text;
begin
  foreach f in array array['public.delete_qat_entry(uuid, uuid, int)', 'public.delete_insta_entry(uuid, uuid, int)',
                           'public.delete_debt_entry(uuid, uuid, int)'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('alter function %s owner to ledger_writer', f);
  end loop;
end $$;
revoke create on schema public from ledger_writer;

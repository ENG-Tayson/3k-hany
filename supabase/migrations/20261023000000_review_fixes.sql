-- إصلاحات المراجعة المستقلة (REVIEW_REPORT.md):
-- R2: نسخ الحسبة في حسبة اليوم تعيد علمي «تقريبي/أقل من 0.000001».
-- R3: الجرامات بلا حد دقة ثابت (كان numeric(20,6) ينفجر مع قيم قصوى مقبولة).
-- R4: الاستعادة ترفض حسبة محفوظة غير متسقة مع D/P، وسجل الملف يُوسم «مستورد».
-- R5: الاستعادة لا تحذف سجل المراجعة الحالي، ويمكن تنزيل النسخة السابقة لأي استعادة.
-- R6: إعادة طلب قديم بعد استعادة لا تعطي «تم الحفظ» كاذبًا (restore_epoch).
alter table public.calc_snapshots alter column grams type numeric;
alter table public.audit_log add column imported boolean not null default false;
alter table public.ledger_accounts add column restore_epoch bigint not null default 0;
alter table public.save_requests add column epoch bigint not null default 0;
-- لا حذف لسجل المراجعة لأي دور تطبيقي بعد الآن
revoke delete on public.audit_log from ledger_writer;

create or replace function ledger_private.day_report(p_owner uuid, p_date date) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  oq public.book_openings; oi public.book_openings; dv public.daily_values;
  qs text; ist text;
  buy_w numeric := 0; sell_w numeric := 0; buy_v numeric := 0; sell_v numeric := 0;
  add_v numeric := 0; ded_v numeric := 0; in_v numeric := 0; out_v numeric := 0;
  q numeric; i numeric; c numeric; p numeric; a numeric; d numeric;
  num numeric; den numeric; g6 numeric; g_approx boolean; g_below boolean;
  missing text[] := '{}'; decision text; result_status text; grams_status text;
  v_qat jsonb; v_insta jsonb;
begin
  select * into oq from public.book_openings where owner_id = p_owner and book = 'qat';
  select * into oi from public.book_openings where owner_id = p_owner and book = 'insta';
  select * into dv from public.daily_values where owner_id = p_owner and value_date = p_date;

  qs := case when oq.owner_id is null then 'not_configured' when p_date < oq.start_date then 'not_started' else 'ok' end;
  ist := case when oi.owner_id is null then 'not_configured' when p_date < oi.start_date then 'not_started' else 'ok' end;

  if qs = 'ok' then
    select coalesce(sum(weight) filter (where entry_type = 'buy'), 0),
           coalesce(sum(weight) filter (where entry_type = 'sell'), 0),
           coalesce(sum(amount) filter (where entry_type = 'buy'), 0),
           coalesce(sum(amount) filter (where entry_type = 'sell'), 0),
           coalesce(sum(amount) filter (where entry_type = 'cash_add'), 0),
           coalesce(sum(amount) filter (where entry_type = 'cash_deduct'), 0)
      into buy_w, sell_w, buy_v, sell_v, add_v, ded_v
      from public.qat_entries
     where owner_id = p_owner and status = 'active' and entry_date <= p_date;
    q := oq.opening_money + buy_v - sell_v + add_v - ded_v;
  else
    missing := missing || ('qat_' || qs);
  end if;

  if ist = 'ok' then
    select coalesce(sum(amount) filter (where entry_type = 'in'), 0),
           coalesce(sum(amount) filter (where entry_type = 'out'), 0)
      into in_v, out_v
      from public.insta_entries
     where owner_id = p_owner and status = 'active' and entry_date <= p_date;
    i := oi.opening_money + in_v - out_v;
  else
    missing := missing || ('insta_' || ist);
  end if;

  c := dv.cash;
  p := dv.price;
  if c is null then missing := missing || 'cash_missing'::text; end if;

  if qs = 'ok' and ist = 'ok' and c is not null then
    result_status := 'complete';
    a := c + i;
    d := q - a;
    decision := case when d > 0 then 'sell' when d < 0 then 'buy' else 'balanced' end;
    if p is null then
      grams_status := 'price_missing';
    elsif p <= 0 then
      grams_status := 'price_invalid';
    else
      grams_status := 'ok';
      num := abs(d) * 100;          -- قروش (عدد صحيح لأن المبالغ بمنزلتين)
      den := p * 100;               -- قروش
      g6 := div(2 * num * 1000000 + den, 2 * den);   -- round half up لـ |D|/P × 10^6
      g_approx := mod(num * 1000000, den) <> 0;
      g_below := num > 0 and g6 = 0;
    end if;
  else
    result_status := 'incomplete';
  end if;

  select coalesce(jsonb_agg(ledger_private.qat_entry_json(e) order by e.seq), '[]'::jsonb) into v_qat
    from public.qat_entries e where e.owner_id = p_owner and e.entry_date = p_date;
  select coalesce(jsonb_agg(ledger_private.insta_entry_json(e) order by e.seq), '[]'::jsonb) into v_insta
    from public.insta_entries e where e.owner_id = p_owner and e.entry_date = p_date;

  return jsonb_build_object(
    'date', p_date,
    'rule_version', 1,
    'qat', jsonb_build_object('status', qs, 'start_date', oq.start_date,
        'opening_money', oq.opening_money::text, 'opening_weight', oq.opening_weight::text,
        'buy_weight', case when qs = 'ok' then buy_w::text end,
        'sell_weight', case when qs = 'ok' then sell_w::text end,
        'net_weight', case when qs = 'ok' then (oq.opening_weight + buy_w - sell_w)::text end,
        'buy_value', case when qs = 'ok' then buy_v::text end,
        'sell_value', case when qs = 'ok' then sell_v::text end,
        'cash_add', case when qs = 'ok' then add_v::text end,
        'cash_deduct', case when qs = 'ok' then ded_v::text end,
        'q', q::text),
    'insta', jsonb_build_object('status', ist, 'start_date', oi.start_date,
        'opening_money', oi.opening_money::text,
        'total_in', case when ist = 'ok' then in_v::text end,
        'total_out', case when ist = 'ok' then out_v::text end,
        'i', i::text),
    'cash', case when c is not null then jsonb_build_object('value', c::text, 'set_at', dv.cash_set_at) end,
    'price', case when p is not null then jsonb_build_object('value', p::text, 'set_at', dv.price_set_at) end,
    'daily_version', dv.version,
    'result', jsonb_build_object('status', result_status, 'missing', to_jsonb(missing),
        'a', a::text, 'd', d::text, 'abs_d', abs(d)::text, 'decision', decision,
        'grams_status', grams_status,
        'grams', case when g6 is not null then round(g6 / 1000000, 6)::text end,
        'grams_approx', g_approx, 'grams_below_min', g_below),
    'day_entries', jsonb_build_object('qat', v_qat, 'insta', v_insta),
    'fingerprint', ledger_private.inputs_fingerprint(p_owner, p_date));
end $$;

create or replace function public.get_day_report(p_date text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_date date; v_rep jsonb;
begin
  v_date := ledger_private.parse_date(p_date, 'التاريخ');
  v_rep := ledger_private.day_report(v_owner, v_date);
  return v_rep || jsonb_build_object(
    'snapshots', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'saved_at', saved_at, 'd', d::text,
        'decision', decision, 'grams', grams::text, 'grams_approx', grams_approx, 'grams_below_min', grams_below_min, 'stale', inputs_fingerprint <> (v_rep ->> 'fingerprint'))
        order by saved_at), '[]'::jsonb)
      from public.calc_snapshots where owner_id = v_owner and calc_date = v_date),
    'data_version', (select data_version::text from public.ledger_accounts where owner_id = v_owner));
end $$;

create or replace function ledger_private.begin_write(p_owner uuid, p_request_id uuid, p_op text, p_params jsonb)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare r public.save_requests; v_epoch bigint;
begin
  if p_request_id is null then
    perform ledger_private.fail('missing_request_id', 'معرّف الطلب مطلوب');
  end if;
  select restore_epoch into v_epoch from public.ledger_accounts where owner_id = p_owner for update;
  if not found then
    perform ledger_private.fail('account_not_setup', 'لم يتم إعداد الدفتر بعد');
  end if;
  select * into r from public.save_requests where owner_id = p_owner and request_id = p_request_id;
  if found then
    if r.op <> p_op or r.params_hash <> md5(p_params::text) then
      perform ledger_private.fail('request_id_reused', 'معرّف الطلب استُخدم من قبل لعملية بمحتوى مختلف؛ لم يتم الحفظ');
    end if;
    if r.epoch <> v_epoch then
      perform ledger_private.fail('request_superseded',
        'تمت استعادة نسخة احتياطية بعد هذا الطلب، فلا يمكن تأكيد نتيجته. راجع البيانات الحالية وأعد الإدخال إن لزم.');
    end if;
    return r.result || jsonb_build_object('replayed', true);
  end if;
  return null;
end $$;

create or replace function ledger_private.finish_write(p_owner uuid, p_request_id uuid, p_op text, p_params jsonb, p_result jsonb)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare v_version bigint; v_result jsonb; v_epoch bigint;
begin
  update public.ledger_accounts set data_version = data_version + 1, updated_at = now()
   where owner_id = p_owner returning data_version, restore_epoch into v_version, v_epoch;
  v_result := p_result || jsonb_build_object('data_version', v_version::text, 'replayed', false);
  insert into public.save_requests(owner_id, request_id, op, params_hash, result, epoch)
  values (p_owner, p_request_id, p_op, md5(p_params::text), v_result, v_epoch);
  return v_result;
end $$;

create or replace function ledger_private.export_data(p_owner uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v_data jsonb; acc public.ledger_accounts;
begin
  select * into acc from public.ledger_accounts where owner_id = p_owner;
  if not found then return null; end if;
  v_data := jsonb_build_object(
    'account', jsonb_build_object('weight_basis', acc.weight_basis, 'created_at', acc.created_at),
    'book_openings', (select coalesce(jsonb_agg(jsonb_build_object('book', book, 'start_date', start_date,
        'opening_money', opening_money::text, 'opening_weight', opening_weight::text, 'version', version,
        'created_at', created_at, 'updated_at', updated_at) order by book), '[]'::jsonb)
        from public.book_openings where owner_id = p_owner),
    'qat_entries', (select coalesce(jsonb_agg(ledger_private.qat_entry_json(e) order by e.seq), '[]'::jsonb)
        from public.qat_entries e where e.owner_id = p_owner),
    'insta_entries', (select coalesce(jsonb_agg(ledger_private.insta_entry_json(e) order by e.seq), '[]'::jsonb)
        from public.insta_entries e where e.owner_id = p_owner),
    'daily_values', (select coalesce(jsonb_agg(jsonb_build_object('value_date', value_date, 'cash', cash::text,
        'cash_set_at', cash_set_at, 'price', price::text, 'price_set_at', price_set_at, 'version', version,
        'created_at', created_at, 'updated_at', updated_at) order by value_date), '[]'::jsonb)
        from public.daily_values where owner_id = p_owner),
    'calc_snapshots', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'calc_date', calc_date,
        'q', q::text, 'i', i::text, 'c', c::text, 'p', p::text, 'a', a::text, 'd', d::text, 'decision', decision,
        'grams', grams::text, 'grams_approx', grams_approx, 'grams_below_min', grams_below_min,
        'inputs_fingerprint', inputs_fingerprint, 'data_version', data_version::text, 'rule_version', rule_version,
        'report', report, 'saved_at', saved_at) order by saved_at, id), '[]'::jsonb)
        from public.calc_snapshots where owner_id = p_owner),
    'people', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'note', note, 'version', version,
        'created_at', created_at, 'updated_at', updated_at) order by created_at, id), '[]'::jsonb)
        from public.people where owner_id = p_owner),
    'debt_entries', (select coalesce(jsonb_agg(ledger_private.debt_entry_json(e) order by e.seq), '[]'::jsonb)
        from public.debt_entries e where e.owner_id = p_owner),
    'audit_log', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'at', at, 'entity', entity,
        'record_id', record_id, 'action', action, 'old_data', old_data, 'new_data', new_data, 'reason', reason,
        'request_id', request_id, 'imported', imported) order by at, id), '[]'::jsonb)
        from public.audit_log where owner_id = p_owner));
  return jsonb_build_object(
    'format', 'gold-ledger-backup',
    'schema_version', 1,
    'rule_version', acc.rule_version,
    'exported_at', now(),
    'data_version', acc.data_version::text,
    'counts', jsonb_build_object(
       'qat_entries', jsonb_array_length(v_data -> 'qat_entries'),
       'insta_entries', jsonb_array_length(v_data -> 'insta_entries'),
       'daily_values', jsonb_array_length(v_data -> 'daily_values'),
       'calc_snapshots', jsonb_array_length(v_data -> 'calc_snapshots'),
       'people', jsonb_array_length(v_data -> 'people'),
       'debt_entries', jsonb_array_length(v_data -> 'debt_entries'),
       'audit_log', jsonb_array_length(v_data -> 'audit_log')),
    'checksum', md5(v_data::text),
    'data', v_data);
end $$;

create or replace function public.list_audit(p_entity text default null, p_record_id text default null,
  p_limit int default 100, p_offset int default 0) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner();
begin
  return jsonb_build_object(
    'total', (select count(*)::text from public.audit_log where owner_id = v_owner
       and (p_entity is null or entity = p_entity) and (p_record_id is null or record_id = p_record_id)),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'at', at, 'entity', entity, 'record_id', record_id,
        'action', action, 'old_data', old_data, 'new_data', new_data, 'reason', reason, 'imported', imported) order by at desc), '[]'::jsonb)
      from (select * from public.audit_log where owner_id = v_owner
              and (p_entity is null or entity = p_entity) and (p_record_id is null or record_id = p_record_id)
            order by at desc limit least(greatest(coalesce(p_limit, 100), 1), 500) offset greatest(coalesce(p_offset, 0), 0)) a));
end $$;

create or replace function public.restore_backup(p_request_id uuid, p_expected_data_version bigint, p_file jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_params jsonb; v_prev jsonb; v_data jsonb;
  v_current bigint; v_prev_backup jsonb; v_counts jsonb; v_max_seq bigint; v_basis text; v_bad record; v_err text;
  k text; v_created int;
begin
  if p_file is null or jsonb_typeof(p_file) <> 'object' then
    perform ledger_private.fail('invalid_backup', 'ملف النسخة غير صالح');
  end if;
  if p_file ->> 'format' is distinct from 'gold-ledger-backup' then
    perform ledger_private.fail('invalid_backup', 'الملف ليس نسخة احتياطية لدفاتر الذهب');
  end if;
  if (p_file ->> 'schema_version') is distinct from '1' then
    perform ledger_private.fail('unsupported_version', 'إصدار ملف النسخة غير مدعوم: ' || coalesce(p_file ->> 'schema_version', 'غير محدد'));
  end if;
  v_data := p_file -> 'data';
  if v_data is null or jsonb_typeof(v_data) <> 'object' then
    perform ledger_private.fail('invalid_backup', 'الملف لا يحتوي بيانات');
  end if;
  if md5(v_data::text) is distinct from (p_file ->> 'checksum') then
    perform ledger_private.fail('checksum_mismatch', 'بصمة الملف لا تطابق محتواه (الملف تالف أو معدّل)');
  end if;
  foreach k in array array['book_openings','qat_entries','insta_entries','daily_values','calc_snapshots','people','debt_entries','audit_log'] loop
    if jsonb_typeof(v_data -> k) is distinct from 'array' then
      perform ledger_private.fail('invalid_backup', 'الملف ناقص: ' || k);
    end if;
  end loop;
  v_basis := ledger_private.clean_text(v_data -> 'account' ->> 'weight_basis', 'أساس الوزن', 50, true);

  -- حساب جديد لا يملك دفترًا بعد: ننشئ صف الحساب ليُقفل (data_version الحالي = 0 للمعاينة).
  insert into public.ledger_accounts(owner_id, weight_basis) values (v_owner, v_basis) on conflict (owner_id) do nothing;
  get diagnostics v_created = row_count;
  v_params := jsonb_build_object('checksum', md5(p_file::text), 'expected_data_version', p_expected_data_version);
  v_prev := ledger_private.begin_write(v_owner, p_request_id, 'restore_backup', v_params);
  if v_prev is not null then return v_prev; end if;
  -- القراءة بعد أخذ القفل: أي كتابة اكتملت أثناء الانتظار تغيّر الإصدار فتُرفض الاستعادة القديمة.
  -- حساب أُنشئ داخل هذه المعاملة نفسها = إصدار 0 (لم يكن له دفتر عند المعاينة).
  if v_created = 1 then
    v_current := 0;
  else
    select data_version into v_current from public.ledger_accounts where owner_id = v_owner;
  end if;
  if p_expected_data_version is null or p_expected_data_version <> v_current then
    perform ledger_private.fail('conflict', 'تغيرت بيانات الدفتر منذ تجهيز الاستعادة (سُجلت حركة أخرى). أعد تحميل الملف وراجع المعاينة.');
  end if;

  -- 1) التحقق في مساحة مؤقتة
  begin
    drop table if exists pg_temp._r_open, pg_temp._r_qat, pg_temp._r_insta, pg_temp._r_daily, pg_temp._r_snap,
      pg_temp._r_people, pg_temp._r_debt, pg_temp._r_audit;
    create temp table _r_open on commit drop as
      select x ->> 'book' as book, ledger_private.parse_date(x ->> 'start_date', 'start_date') as start_date,
             ledger_private.parse_num(x ->> 'opening_money', 'opening_money', 12, 2, 'any') as opening_money,
             case when x ->> 'opening_weight' is null then null
                  else ledger_private.parse_num(x ->> 'opening_weight', 'opening_weight', 8, 6, 'any') end as opening_weight,
             coalesce((x ->> 'version')::int, 1) as version,
             coalesce((x ->> 'created_at')::timestamptz, now()) as created_at, coalesce((x ->> 'updated_at')::timestamptz, now()) as updated_at
        from jsonb_array_elements(v_data -> 'book_openings') x;
    create temp table _r_qat on commit drop as
      select (x ->> 'id')::uuid as id, (x ->> 'seq')::bigint as seq,
             ledger_private.parse_date(x ->> 'entry_date', 'entry_date') as entry_date, x ->> 'entry_type' as entry_type,
             case when x ->> 'weight' is null then null else ledger_private.parse_num(x ->> 'weight', 'weight', 6, 6, 'positive') end as weight,
             case when x ->> 'unit_price' is null then null else ledger_private.parse_num(x ->> 'unit_price', 'unit_price', 10, 2, 'positive') end as unit_price,
             ledger_private.parse_num(x ->> 'amount', 'amount', 16, 2, 'positive') as amount,
             x ->> 'trader_name' as trader_name, x ->> 'note' as note, x ->> 'reason' as reason,
             coalesce(x ->> 'status', 'active') as status, x ->> 'cancel_reason' as cancel_reason,
             (x ->> 'cancelled_at')::timestamptz as cancelled_at, coalesce((x ->> 'version')::int, 1) as version,
             coalesce((x ->> 'created_at')::timestamptz, now()) as created_at, coalesce((x ->> 'updated_at')::timestamptz, now()) as updated_at
        from jsonb_array_elements(v_data -> 'qat_entries') x;
    create temp table _r_insta on commit drop as
      select (x ->> 'id')::uuid as id, (x ->> 'seq')::bigint as seq,
             ledger_private.parse_date(x ->> 'entry_date', 'entry_date') as entry_date, x ->> 'entry_type' as entry_type,
             ledger_private.parse_num(x ->> 'amount', 'amount', 12, 2, 'positive') as amount,
             x ->> 'person_name' as person_name, x ->> 'note' as note, coalesce((x ->> 'marked_paid')::boolean, false) as marked_paid,
             coalesce(x ->> 'status', 'active') as status, x ->> 'cancel_reason' as cancel_reason,
             (x ->> 'cancelled_at')::timestamptz as cancelled_at, coalesce((x ->> 'version')::int, 1) as version,
             coalesce((x ->> 'created_at')::timestamptz, now()) as created_at, coalesce((x ->> 'updated_at')::timestamptz, now()) as updated_at
        from jsonb_array_elements(v_data -> 'insta_entries') x;
    create temp table _r_daily on commit drop as
      select ledger_private.parse_date(x ->> 'value_date', 'value_date') as value_date,
             case when x ->> 'cash' is null then null else ledger_private.parse_num(x ->> 'cash', 'cash', 12, 2, 'nonneg') end as cash,
             (x ->> 'cash_set_at')::timestamptz as cash_set_at,
             case when x ->> 'price' is null then null else ledger_private.parse_num(x ->> 'price', 'price', 10, 2, 'positive') end as price,
             (x ->> 'price_set_at')::timestamptz as price_set_at, coalesce((x ->> 'version')::int, 1) as version,
             coalesce((x ->> 'created_at')::timestamptz, now()) as created_at, coalesce((x ->> 'updated_at')::timestamptz, now()) as updated_at
        from jsonb_array_elements(v_data -> 'daily_values') x;
    create temp table _r_snap on commit drop as
      select (x ->> 'id')::uuid as id, (x ->> 'calc_date')::date as calc_date, (x ->> 'q')::numeric as q,
             (x ->> 'i')::numeric as i, (x ->> 'c')::numeric as c, (x ->> 'p')::numeric as p, (x ->> 'a')::numeric as a,
             (x ->> 'd')::numeric as d, x ->> 'decision' as decision, (x ->> 'grams')::numeric as grams,
             (x ->> 'grams_approx')::boolean as grams_approx, (x ->> 'grams_below_min')::boolean as grams_below_min,
             x ->> 'inputs_fingerprint' as inputs_fingerprint, (x ->> 'data_version')::bigint as data_version,
             (x ->> 'rule_version')::int as rule_version, x -> 'report' as report, (x ->> 'saved_at')::timestamptz as saved_at
        from jsonb_array_elements(v_data -> 'calc_snapshots') x;
    create temp table _r_people on commit drop as
      select (x ->> 'id')::uuid as id, x ->> 'name' as name, x ->> 'note' as note, coalesce((x ->> 'version')::int, 1) as version,
             coalesce((x ->> 'created_at')::timestamptz, now()) as created_at, coalesce((x ->> 'updated_at')::timestamptz, now()) as updated_at
        from jsonb_array_elements(v_data -> 'people') x;
    create temp table _r_debt on commit drop as
      select (x ->> 'id')::uuid as id, (x ->> 'person_id')::uuid as person_id, (x ->> 'seq')::bigint as seq,
             ledger_private.parse_date(x ->> 'entry_date', 'entry_date') as entry_date, x ->> 'entry_type' as entry_type,
             ledger_private.parse_num(x ->> 'amount', 'amount', 12, 2, 'positive') as amount, x ->> 'note' as note,
             coalesce(x ->> 'status', 'active') as status, x ->> 'cancel_reason' as cancel_reason,
             (x ->> 'cancelled_at')::timestamptz as cancelled_at, coalesce((x ->> 'version')::int, 1) as version,
             coalesce((x ->> 'created_at')::timestamptz, now()) as created_at, coalesce((x ->> 'updated_at')::timestamptz, now()) as updated_at
        from jsonb_array_elements(v_data -> 'debt_entries') x;
    create temp table _r_audit on commit drop as
      select (x ->> 'id')::uuid as id, (x ->> 'at')::timestamptz as at, x ->> 'entity' as entity, x ->> 'record_id' as record_id,
             x ->> 'action' as action, x -> 'old_data' as old_data, x -> 'new_data' as new_data, x ->> 'reason' as reason,
             (x ->> 'request_id')::uuid as request_id
        from jsonb_array_elements(v_data -> 'audit_log') x;
  exception when others then
    v_err := sqlerrm;
    perform ledger_private.fail('invalid_backup', 'ملف النسخة غير صالح ولم يتغير شيء: ' || v_err);
  end;

  -- فحوص العلاقات داخل الملف قبل اللمس
  if exists (select 1 from pg_temp._r_debt d where not exists (select 1 from pg_temp._r_people p where p.id = d.person_id)) then
    perform ledger_private.fail('invalid_backup', 'الملف يحتوي حركات لأشخاص غير موجودين؛ لم يتغير شيء');
  end if;
  if exists (select 1 from pg_temp._r_snap where id is null or calc_date is null or report is null or saved_at is null) then
    perform ledger_private.fail('invalid_backup', 'الملف يحتوي حسبة محفوظة ناقصة؛ لم يتغير شيء');
  end if;
  -- الحسبة المحفوظة يجب أن تكون متسقة مع قاعدة الحساب (القرار والجرامات من D وP)، وإلا فالملف معدّل
  if exists (select 1 from pg_temp._r_snap s
              where s.p is null or s.p <= 0 or s.a is distinct from s.c + s.i or s.d is distinct from s.q - s.a
                 or s.decision is distinct from (case when s.d > 0 then 'sell' when s.d < 0 then 'buy' else 'balanced' end)
                 or s.grams is distinct from round(div(2 * abs(s.d) * 100 * 1000000 + s.p * 100, 2 * s.p * 100) / 1000000, 6)
                 or s.grams_approx is distinct from (mod(abs(s.d) * 100 * 1000000, s.p * 100) <> 0)
                 or s.grams_below_min is distinct from (abs(s.d) > 0 and div(2 * abs(s.d) * 100 * 1000000 + s.p * 100, 2 * s.p * 100) = 0)) then
    perform ledger_private.fail('invalid_backup', 'الملف يحتوي حسبة محفوظة غير متسقة مع قاعدة الحساب؛ لم يتغير شيء');
  end if;

  -- 2) نسخة من الوضع الحالي
  v_prev_backup := coalesce(ledger_private.export_data(v_owner), '{}'::jsonb);

  -- 3) الاستبدال داخل نفس المعاملة
  begin
    delete from public.debt_entries where owner_id = v_owner;
    delete from public.people where owner_id = v_owner;
    delete from public.calc_snapshots where owner_id = v_owner;
    delete from public.qat_entries where owner_id = v_owner;
    delete from public.insta_entries where owner_id = v_owner;
    delete from public.daily_values where owner_id = v_owner;
    delete from public.book_openings where owner_id = v_owner;

    insert into public.book_openings(owner_id, book, start_date, opening_money, opening_weight, version, created_at, updated_at)
      select v_owner, book, start_date, opening_money, opening_weight, version, created_at, updated_at from pg_temp._r_open;
    insert into public.qat_entries(owner_id, id, seq, entry_date, entry_type, weight, unit_price, amount, trader_name, note,
        reason, status, cancel_reason, cancelled_at, version, created_at, updated_at)
      select v_owner, id, seq, entry_date, entry_type, weight, unit_price, amount,
             ledger_private.clean_text(trader_name, 'trader_name', 100, false), ledger_private.clean_text(note, 'note', 500, false),
             ledger_private.clean_text(reason, 'reason', 500, false), status, cancel_reason, cancelled_at, version, created_at, updated_at
        from pg_temp._r_qat;
    insert into public.insta_entries(owner_id, id, seq, entry_date, entry_type, amount, person_name, note, marked_paid,
        status, cancel_reason, cancelled_at, version, created_at, updated_at)
      select v_owner, id, seq, entry_date, entry_type, amount, ledger_private.clean_text(person_name, 'person_name', 100, false),
             ledger_private.clean_text(note, 'note', 500, false), marked_paid, status, cancel_reason, cancelled_at, version, created_at, updated_at
        from pg_temp._r_insta;
    insert into public.daily_values(owner_id, value_date, cash, cash_set_at, price, price_set_at, version, created_at, updated_at)
      select v_owner, value_date, cash, cash_set_at, price, price_set_at, version, created_at, updated_at from pg_temp._r_daily;
    insert into public.calc_snapshots(owner_id, id, calc_date, q, i, c, p, a, d, decision, grams, grams_approx, grams_below_min,
        inputs_fingerprint, data_version, rule_version, report, saved_at)
      select v_owner, id, calc_date, q, i, c, p, a, d, decision, grams, grams_approx, grams_below_min,
             inputs_fingerprint, data_version, rule_version, report, saved_at from pg_temp._r_snap;
    insert into public.people(owner_id, id, name, note, version, created_at, updated_at)
      select v_owner, id, ledger_private.clean_text(name, 'name', 100, true), ledger_private.clean_text(note, 'note', 500, false),
             version, created_at, updated_at from pg_temp._r_people;
    insert into public.debt_entries(owner_id, id, person_id, seq, entry_date, entry_type, amount, note, status, cancel_reason,
        cancelled_at, version, created_at, updated_at)
      select v_owner, id, person_id, seq, entry_date, entry_type, amount, ledger_private.clean_text(note, 'note', 500, false),
             status, cancel_reason, cancelled_at, version, created_at, updated_at from pg_temp._r_debt;
    -- سجل المراجعة الحالي لا يُحذف أبدًا؛ سجل الملف يُضاف موسومًا «مستورد» ويُتجاهل المكرر (استعادة نفس الملف مرتين).
    insert into public.audit_log(owner_id, id, at, entity, record_id, action, old_data, new_data, reason, request_id, imported)
      select v_owner, id, at, entity, record_id, action, old_data, new_data, reason, request_id, true from pg_temp._r_audit
      on conflict (owner_id, id) do nothing;

    -- 4) قواعد الدفاتر بعد الإدراج
    select 'qat' as b, e.entry_date into v_bad from public.qat_entries e
      left join public.book_openings o on o.owner_id = e.owner_id and o.book = 'qat'
     where e.owner_id = v_owner and e.status = 'active' and (o.start_date is null or e.entry_date < o.start_date) limit 1;
    if found then perform ledger_private.fail('invalid_backup', 'الملف يحتوي قطعية قبل تاريخ بداية الدفتر أو بدون افتتاحية'); end if;
    select 'insta' as b, e.entry_date into v_bad from public.insta_entries e
      left join public.book_openings o on o.owner_id = e.owner_id and o.book = 'insta'
     where e.owner_id = v_owner and e.status = 'active' and (o.start_date is null or e.entry_date < o.start_date) limit 1;
    if found then perform ledger_private.fail('invalid_backup', 'الملف يحتوي حركة إنستا قبل تاريخ بداية الدفتر أو بدون افتتاحية'); end if;
    for v_bad in select id from public.people where owner_id = v_owner loop
      perform ledger_private.assert_debt_timeline(v_owner, v_bad.id);
    end loop;

    select greatest(coalesce((select max(seq) from public.qat_entries where owner_id = v_owner), 0),
                    coalesce((select max(seq) from public.insta_entries where owner_id = v_owner), 0),
                    coalesce((select max(seq) from public.debt_entries where owner_id = v_owner), 0)) + 1 into v_max_seq;
    update public.ledger_accounts set weight_basis = v_basis, next_seq = greatest(next_seq, v_max_seq), version = version + 1,
           restore_epoch = restore_epoch + 1,
           updated_at = now() where owner_id = v_owner;
  exception when others then
    v_err := sqlerrm;
    perform ledger_private.fail('restore_failed', 'فشلت الاستعادة ولم يتغير أي شيء: ' || v_err);
  end;

  v_counts := jsonb_build_object(
    'qat_entries', (select count(*) from pg_temp._r_qat), 'insta_entries', (select count(*) from pg_temp._r_insta),
    'daily_values', (select count(*) from pg_temp._r_daily), 'calc_snapshots', (select count(*) from pg_temp._r_snap),
    'people', (select count(*) from pg_temp._r_people), 'debt_entries', (select count(*) from pg_temp._r_debt),
    'audit_log', (select count(*) from pg_temp._r_audit));
  insert into public.restore_events(owner_id, request_id, file_checksum, file_exported_at, file_schema_version, counts, previous_backup)
  values (v_owner, p_request_id, p_file ->> 'checksum', p_file ->> 'exported_at', 1, v_counts, v_prev_backup);
  perform ledger_private.audit(v_owner, 'restore', p_request_id::text, 'restore', null,
    jsonb_build_object('file_checksum', p_file ->> 'checksum', 'file_exported_at', p_file ->> 'exported_at', 'counts', v_counts),
    null, p_request_id);
  return ledger_private.finish_write(v_owner, p_request_id, 'restore_backup', v_params,
    jsonb_build_object('ok', true, 'counts', v_counts));
end $$;

-- تنزيل نسخة البيانات التي حُفظت تلقائيًا قبل استعادة معينة (للمالك فقط عبر RLS)
create or replace function public.get_restore_backup(p_id uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v jsonb;
begin
  select previous_backup into v from public.restore_events where owner_id = v_owner and id = p_id;
  if v is null then perform ledger_private.fail('not_found', 'لا توجد نسخة سابقة لهذه الاستعادة'); end if;
  return v;
end $$;
revoke all on function public.get_restore_backup(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_restore_backup(uuid) to authenticated;

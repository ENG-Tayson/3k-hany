-- دفاتر الذهب — الدوال (rule_version = 1)
-- القراءة: دوال SECURITY INVOKER + STABLE (تخضع لـRLS وتقرأ لقطة واحدة متسقة).
-- الكتابة: دوال SECURITY DEFINER يملكها ledger_writer (بلا BYPASSRLS) مع search_path فارغ.
--   السبب: إغلاق أي مسار كتابة مباشر على الجداول، حتى لا يمكن تجاوز قواعد الحساب أو سجل المراجعة
--   باستدعاء REST مباشر. كل دالة كتابة تتحقق من هوية الجلسة، وتقفل صف حساب المالك (تسلسل الكتابات)،
--   وتسجل request_id لمنع التكرار، وتكتب سجل المراجعة في نفس المعاملة.
-- الأرقام تدخل وتخرج نصوصًا عشرية ويُتحقق من دقتها قبل أي تحويل.

------------------------------------------------------------------------------
-- أدوات مساعدة
------------------------------------------------------------------------------
create function ledger_private.fail(p_code text, p_message text) returns void
language plpgsql volatile set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = p_message, detail = p_code;
end $$;

create function ledger_private.require_owner() returns uuid
language plpgsql stable set search_path = '' as $$
declare v uuid := ledger_private.current_owner();
begin
  if v is null then
    perform ledger_private.fail('not_authenticated', 'يجب تسجيل الدخول');
  end if;
  return v;
end $$;

-- p_sign: 'positive' (> 0) | 'nonneg' (>= 0) | 'any'
create function ledger_private.parse_num(p_value text, p_field text, p_int_digits int, p_scale int, p_sign text)
returns numeric language plpgsql immutable set search_path = '' as $$
declare v text; m text[]; r numeric;
begin
  if p_value is null or btrim(p_value) = '' then
    perform ledger_private.fail('required', p_field || ': القيمة مطلوبة');
  end if;
  v := btrim(p_value);
  m := regexp_match(v, '^(-?)([0-9]+)(\.([0-9]+))?$');
  if m is null then
    perform ledger_private.fail('invalid_number', p_field || ': رقم غير صالح «' || left(v, 40) || '»');
  end if;
  if m[1] = '-' and p_sign <> 'any' then
    perform ledger_private.fail('negative_not_allowed', p_field || ': القيمة السالبة غير مسموحة');
  end if;
  if length(coalesce(nullif(ltrim(m[2], '0'), ''), '0')) > p_int_digits then
    perform ledger_private.fail('too_large', p_field || ': الرقم أكبر من الحد المسموح');
  end if;
  if coalesce(length(m[4]), 0) > p_scale then
    perform ledger_private.fail('too_many_decimals', p_field || ': الحد الأقصى ' || p_scale || ' منازل عشرية');
  end if;
  r := v::numeric;
  if p_sign = 'positive' and r <= 0 then
    perform ledger_private.fail('must_be_positive', p_field || ': يجب أن تكون القيمة أكبر من صفر');
  end if;
  return r;
end $$;

create function ledger_private.parse_date(p_value text, p_field text) returns date
language plpgsql immutable set search_path = '' as $$
declare r date;
begin
  if p_value is null or p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    perform ledger_private.fail('invalid_date', p_field || ': تاريخ غير صالح (المطلوب YYYY-MM-DD)');
  end if;
  begin
    r := to_date(p_value, 'YYYY-MM-DD');
  exception when others then
    perform ledger_private.fail('invalid_date', p_field || ': تاريخ غير موجود');
  end;
  if to_char(r, 'YYYY-MM-DD') <> p_value then
    perform ledger_private.fail('invalid_date', p_field || ': تاريخ غير موجود');
  end if;
  if r < date '2000-01-01' or r > date '2100-12-31' then
    perform ledger_private.fail('invalid_date', p_field || ': التاريخ خارج المدى المسموح');
  end if;
  return r;
end $$;

create function ledger_private.clean_text(p_value text, p_field text, p_max int, p_required boolean)
returns text language plpgsql immutable set search_path = '' as $$
declare v text := nullif(btrim(coalesce(p_value, '')), '');
begin
  if v is null and p_required then
    perform ledger_private.fail('required', p_field || ': مطلوب');
  end if;
  if v is not null and char_length(v) > p_max then
    perform ledger_private.fail('too_long', p_field || ': الحد الأقصى ' || p_max || ' حرف');
  end if;
  if v ~ '[\x01-\x08\x0B\x0C\x0E-\x1F]' then
    perform ledger_private.fail('invalid_text', p_field || ': يحتوي رموز تحكم غير مسموحة');
  end if;
  return v;
end $$;

create function ledger_private.cairo_today() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'Africa/Cairo')::date
$$;

-- بداية الكتابة: قفل صف الحساب (يسلسل كل كتابات المالك) ثم فحص request_id.
create function ledger_private.begin_write(p_owner uuid, p_request_id uuid, p_op text, p_params jsonb)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare r public.save_requests;
begin
  if p_request_id is null then
    perform ledger_private.fail('missing_request_id', 'معرّف الطلب مطلوب');
  end if;
  perform 1 from public.ledger_accounts where owner_id = p_owner for update;
  if not found then
    perform ledger_private.fail('account_not_setup', 'لم يتم إعداد الدفتر بعد');
  end if;
  select * into r from public.save_requests where owner_id = p_owner and request_id = p_request_id;
  if found then
    if r.op <> p_op or r.params_hash <> md5(p_params::text) then
      perform ledger_private.fail('request_id_reused', 'معرّف الطلب استُخدم من قبل لعملية بمحتوى مختلف؛ لم يتم الحفظ');
    end if;
    return r.result || jsonb_build_object('replayed', true);
  end if;
  return null;
end $$;

create function ledger_private.finish_write(p_owner uuid, p_request_id uuid, p_op text, p_params jsonb, p_result jsonb)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare v_version bigint; v_result jsonb;
begin
  update public.ledger_accounts set data_version = data_version + 1, updated_at = now()
   where owner_id = p_owner returning data_version into v_version;
  v_result := p_result || jsonb_build_object('data_version', v_version::text, 'replayed', false);
  insert into public.save_requests(owner_id, request_id, op, params_hash, result)
  values (p_owner, p_request_id, p_op, md5(p_params::text), v_result);
  return v_result;
end $$;

create function ledger_private.next_seq(p_owner uuid) returns bigint
language plpgsql volatile set search_path = '' as $$
declare v bigint;
begin
  update public.ledger_accounts set next_seq = next_seq + 1 where owner_id = p_owner returning next_seq - 1 into v;
  return v;
end $$;

-- أرقام NUMERIC داخل jsonb تُحوّل لنصوص، حتى لا يفقد المتصفح دقتها (JSON number → float) فتتلف بصمة النسخة.
create function ledger_private.json_numbers_as_text(p jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case when p is null then null
    else (select coalesce(jsonb_object_agg(k, case when jsonb_typeof(v) = 'number' then to_jsonb(v #>> '{}') else v end), '{}'::jsonb)
            from jsonb_each(p) as t(k, v)) end
$$;

create function ledger_private.audit(p_owner uuid, p_entity text, p_record_id text, p_action text,
  p_old jsonb, p_new jsonb, p_reason text, p_request_id uuid) returns void
language sql volatile set search_path = '' as $$
  insert into public.audit_log(owner_id, entity, record_id, action, old_data, new_data, reason, request_id)
  values (p_owner, p_entity, p_record_id, p_action, ledger_private.json_numbers_as_text(p_old - 'owner_id'),
          ledger_private.json_numbers_as_text(p_new - 'owner_id'), p_reason, p_request_id);
$$;

create function ledger_private.assert_in_book(p_owner uuid, p_book text, p_date date) returns void
language plpgsql stable set search_path = '' as $$
declare v date;
  v_name text := case p_book when 'qat' then 'القطعيات' else 'إنستا' end;
begin
  select start_date into v from public.book_openings where owner_id = p_owner and book = p_book;
  if not found then
    perform ledger_private.fail('book_not_configured', 'يجب إدخال تاريخ بداية وافتتاحية دفتر ' || v_name || ' أولًا');
  end if;
  if p_date < v then
    perform ledger_private.fail('before_book_start',
      'لا يمكن تسجيل حركة بتاريخ ' || p_date || ' قبل تاريخ بداية دفتر ' || v_name || ' (' || v || ')');
  end if;
end $$;

-- يمنع أي سداد غير مغطى عند نهاية أي يوم في سجل الشخص.
create function ledger_private.assert_debt_timeline(p_owner uuid, p_person uuid) returns void
language plpgsql stable set search_path = '' as $$
declare r record;
begin
  select t.entry_date, t.bal into r from (
    select entry_date,
           sum(sum(case entry_type when 'sent' then amount else -amount end)) over (order by entry_date) as bal
      from public.debt_entries
     where owner_id = p_owner and person_id = p_person and status = 'active'
     group by entry_date) t
   where t.bal < 0 order by t.entry_date limit 1;
  if found then
    perform ledger_private.fail('overpayment',
      'السداد يتجاوز المتبقي على الشخص بتاريخ ' || r.entry_date || '؛ الرصيد سيصبح ' || r.bal || '. لم يتم الحفظ.');
  end if;
end $$;

create function ledger_private.debt_balance_at(p_owner uuid, p_person uuid, p_date date) returns numeric
language sql stable set search_path = '' as $$
  select coalesce(sum(case entry_type when 'sent' then amount else -amount end), 0)
    from public.debt_entries
   where owner_id = p_owner and person_id = p_person and status = 'active' and entry_date <= p_date
$$;

------------------------------------------------------------------------------
-- الحساب: بصمة المدخلات وتقرير اليوم
------------------------------------------------------------------------------
create function ledger_private.inputs_fingerprint(p_owner uuid, p_date date) returns text
language sql stable set search_path = '' as $$
  select md5(concat_ws('|',
    (select coalesce(string_agg(concat_ws(',', book, start_date, opening_money, opening_weight), ';' order by book), '')
       from public.book_openings where owner_id = p_owner),
    (select coalesce(string_agg(concat_ws(',', id, entry_date, entry_type, weight, unit_price, amount), ';' order by id), '')
       from public.qat_entries where owner_id = p_owner and status = 'active' and entry_date <= p_date),
    (select coalesce(string_agg(concat_ws(',', id, entry_date, entry_type, amount), ';' order by id), '')
       from public.insta_entries where owner_id = p_owner and status = 'active' and entry_date <= p_date),
    (select coalesce(cash::text, '-') || ',' || coalesce(price::text, '-')
       from public.daily_values where owner_id = p_owner and value_date = p_date)))
$$;

create function ledger_private.qat_entry_json(e public.qat_entries) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', e.id, 'seq', e.seq::text, 'entry_date', e.entry_date, 'entry_type', e.entry_type,
    'weight', e.weight::text, 'unit_price', e.unit_price::text, 'amount', e.amount::text,
    'trader_name', e.trader_name, 'note', e.note, 'reason', e.reason, 'status', e.status,
    'cancel_reason', e.cancel_reason, 'cancelled_at', e.cancelled_at, 'version', e.version,
    'created_at', e.created_at, 'updated_at', e.updated_at)
$$;

create function ledger_private.insta_entry_json(e public.insta_entries) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', e.id, 'seq', e.seq::text, 'entry_date', e.entry_date, 'entry_type', e.entry_type,
    'amount', e.amount::text, 'person_name', e.person_name, 'note', e.note, 'marked_paid', e.marked_paid,
    'status', e.status, 'cancel_reason', e.cancel_reason, 'cancelled_at', e.cancelled_at, 'version', e.version,
    'created_at', e.created_at, 'updated_at', e.updated_at)
$$;

create function ledger_private.debt_entry_json(e public.debt_entries) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', e.id, 'person_id', e.person_id, 'seq', e.seq::text, 'entry_date', e.entry_date,
    'entry_type', e.entry_type, 'amount', e.amount::text, 'note', e.note, 'status', e.status,
    'cancel_reason', e.cancel_reason, 'cancelled_at', e.cancelled_at, 'version', e.version,
    'created_at', e.created_at, 'updated_at', e.updated_at)
$$;

-- تقرير يوم d. كل المجاميع من الحركات المعتمدة (active) بتاريخ <= d.
-- D = Q − (C + I). موجب: بيع؛ سالب: شراء؛ صفر: متوازن. الجرامات = |D| / P مقربة HALF_UP لـ6 منازل بحساب صحيح.
create function ledger_private.day_report(p_owner uuid, p_date date) returns jsonb
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
        'grams', case when g6 is not null then (g6 / 1000000)::numeric(20,6)::text end,
        'grams_approx', g_approx, 'grams_below_min', g_below),
    'day_entries', jsonb_build_object('qat', v_qat, 'insta', v_insta),
    'fingerprint', ledger_private.inputs_fingerprint(p_owner, p_date));
end $$;

------------------------------------------------------------------------------
-- بناء/التحقق من الحركات
------------------------------------------------------------------------------
create function ledger_private.build_qat(p_owner uuid, p_entry_date text, p_entry_type text, p_weight text,
  p_unit_price text, p_amount text, p_trader_name text, p_note text, p_reason text)
returns public.qat_entries language plpgsql stable set search_path = '' as $$
declare r public.qat_entries; v_preview numeric;
begin
  r.owner_id := p_owner;
  r.entry_date := ledger_private.parse_date(p_entry_date, 'تاريخ العملية');
  if p_entry_type is null or p_entry_type not in ('buy', 'sell', 'cash_add', 'cash_deduct') then
    perform ledger_private.fail('invalid_type', 'نوع الحركة غير صالح');
  end if;
  r.entry_type := p_entry_type;
  perform ledger_private.assert_in_book(p_owner, 'qat', r.entry_date);
  if p_entry_type in ('buy', 'sell') then
    r.weight := ledger_private.parse_num(p_weight, 'الوزن', 6, 6, 'positive');
    r.unit_price := ledger_private.parse_num(p_unit_price, 'سعر الجرام', 10, 2, 'positive');
    r.amount := round(r.weight * r.unit_price, 2);
    if r.amount <= 0 then
      perform ledger_private.fail('amount_too_small', 'قيمة القطعية (الوزن × السعر) أقل من قرش واحد');
    end if;
    if nullif(btrim(coalesce(p_amount, '')), '') is not null then
      v_preview := ledger_private.parse_num(p_amount, 'القيمة المعروضة', 16, 2, 'positive');
      if v_preview <> r.amount then
        perform ledger_private.fail('amount_mismatch', 'القيمة المرسلة لا تساوي الوزن × السعر (' || r.amount || ')');
      end if;
    end if;
    r.reason := ledger_private.clean_text(p_reason, 'السبب', 500, false);
  else
    if nullif(btrim(coalesce(p_weight, '')), '') is not null or nullif(btrim(coalesce(p_unit_price, '')), '') is not null then
      perform ledger_private.fail('invalid_fields', 'الإضافة/الخصم المالي لا يحتوي وزنًا أو سعرًا');
    end if;
    r.amount := ledger_private.parse_num(p_amount, 'المبلغ', 12, 2, 'positive');
    r.reason := ledger_private.clean_text(p_reason, 'سبب الإضافة/الخصم', 500, true);
  end if;
  r.trader_name := ledger_private.clean_text(p_trader_name, 'اسم التاجر', 100, false);
  r.note := ledger_private.clean_text(p_note, 'الملاحظة', 500, false);
  return r;
end $$;

create function ledger_private.build_insta(p_owner uuid, p_entry_date text, p_entry_type text, p_amount text,
  p_person_name text, p_note text, p_marked_paid boolean)
returns public.insta_entries language plpgsql stable set search_path = '' as $$
declare r public.insta_entries;
begin
  r.owner_id := p_owner;
  r.entry_date := ledger_private.parse_date(p_entry_date, 'تاريخ العملية');
  if p_entry_type is null or p_entry_type not in ('in', 'out') then
    perform ledger_private.fail('invalid_type', 'نوع حركة إنستا غير صالح');
  end if;
  r.entry_type := p_entry_type;
  perform ledger_private.assert_in_book(p_owner, 'insta', r.entry_date);
  r.amount := ledger_private.parse_num(p_amount, 'المبلغ', 12, 2, 'positive');
  r.person_name := ledger_private.clean_text(p_person_name, 'الاسم', 100, false);
  r.note := ledger_private.clean_text(p_note, 'الملاحظة', 500, false);
  r.marked_paid := coalesce(p_marked_paid, false);
  return r;
end $$;

------------------------------------------------------------------------------
-- RPC: الإعداد والافتتاحيات
------------------------------------------------------------------------------
create function public.get_state() returns jsonb
language plpgsql stable set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); acc public.ledger_accounts;
begin
  select * into acc from public.ledger_accounts where owner_id = v_owner;
  return jsonb_build_object(
    'account', case when acc.owner_id is not null then jsonb_build_object(
        'weight_basis', acc.weight_basis, 'data_version', acc.data_version::text,
        'schema_version', acc.schema_version, 'rule_version', acc.rule_version,
        'version', acc.version, 'created_at', acc.created_at) end,
    'openings', (select coalesce(jsonb_object_agg(book, jsonb_build_object(
        'start_date', start_date, 'opening_money', opening_money::text,
        'opening_weight', opening_weight::text, 'version', version, 'updated_at', updated_at)), '{}'::jsonb)
        from public.book_openings where owner_id = v_owner),
    'cairo_today', ledger_private.cairo_today(),
    'server_time', now());
end $$;

create function public.setup_account(p_request_id uuid, p_weight_basis text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_basis text; v_params jsonb; v_prev jsonb;
  acc public.ledger_accounts; v_created int;
begin
  v_basis := ledger_private.clean_text(p_weight_basis, 'أساس/عيار الوزن', 50, true);
  insert into public.ledger_accounts(owner_id, weight_basis) values (v_owner, v_basis)
  on conflict (owner_id) do nothing;
  get diagnostics v_created = row_count;
  v_params := jsonb_build_object('weight_basis', p_weight_basis);
  v_prev := ledger_private.begin_write(v_owner, p_request_id, 'setup_account', v_params);
  if v_prev is not null then return v_prev; end if;
  select * into acc from public.ledger_accounts where owner_id = v_owner;
  if v_created = 1 then
    perform ledger_private.audit(v_owner, 'ledger_accounts', 'account', 'create', null,
      jsonb_build_object('weight_basis', v_basis), null, p_request_id);
  elsif acc.weight_basis <> v_basis then
    if exists (select 1 from public.qat_entries where owner_id = v_owner)
       or exists (select 1 from public.book_openings where owner_id = v_owner and book = 'qat') then
      perform ledger_private.fail('basis_locked', 'لا يمكن تغيير أساس الوزن بعد بدء دفتر القطعيات (لا يوجد تحويل عيارات)');
    end if;
    update public.ledger_accounts set weight_basis = v_basis, version = version + 1, updated_at = now()
     where owner_id = v_owner;
    perform ledger_private.audit(v_owner, 'ledger_accounts', 'account', 'update',
      jsonb_build_object('weight_basis', acc.weight_basis), jsonb_build_object('weight_basis', v_basis), null, p_request_id);
  end if;
  return ledger_private.finish_write(v_owner, p_request_id, 'setup_account', v_params,
    jsonb_build_object('ok', true, 'weight_basis', v_basis));
end $$;

create function public.set_opening(p_request_id uuid, p_book text, p_start_date text, p_opening_money text,
  p_opening_weight text default null, p_expected_version int default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_params jsonb; v_prev jsonb;
  old public.book_openings; v_start date; v_money numeric; v_weight numeric; v_reason text; v_first date; v_new public.book_openings;
begin
  v_params := jsonb_build_object('book', p_book, 'start_date', p_start_date, 'money', p_opening_money,
    'weight', p_opening_weight, 'expected_version', p_expected_version, 'reason', p_reason);
  v_prev := ledger_private.begin_write(v_owner, p_request_id, 'set_opening', v_params);
  if v_prev is not null then return v_prev; end if;

  if p_book is null or p_book not in ('qat', 'insta') then
    perform ledger_private.fail('invalid_book', 'دفتر غير صالح');
  end if;
  v_start := ledger_private.parse_date(p_start_date, 'تاريخ البداية');
  v_money := ledger_private.parse_num(p_opening_money, 'الرصيد الافتتاحي', 12, 2, 'any');
  if p_book = 'qat' then
    v_weight := ledger_private.parse_num(p_opening_weight, 'صافي الوزن الافتتاحي', 8, 6, 'any');
  elsif nullif(btrim(coalesce(p_opening_weight, '')), '') is not null then
    perform ledger_private.fail('invalid_fields', 'دفتر إنستا ليس له وزن');
  end if;
  v_reason := ledger_private.clean_text(p_reason, 'سبب التعديل', 500, false);

  select * into old from public.book_openings where owner_id = v_owner and book = p_book for update;
  if found then
    if p_expected_version is null or p_expected_version <> old.version then
      perform ledger_private.fail('conflict', 'تم تعديل الافتتاحية من مكان آخر؛ أعد تحميل الصفحة');
    end if;
    if v_reason is null then
      perform ledger_private.fail('required', 'سبب تعديل الافتتاحية مطلوب');
    end if;
  elsif p_expected_version is not null then
    perform ledger_private.fail('conflict', 'الافتتاحية غير موجودة؛ أعد تحميل الصفحة');
  end if;

  if p_book = 'qat' then
    select min(entry_date) into v_first from public.qat_entries where owner_id = v_owner and status = 'active';
  else
    select min(entry_date) into v_first from public.insta_entries where owner_id = v_owner and status = 'active';
  end if;
  if v_first is not null and v_first < v_start then
    perform ledger_private.fail('entries_before_start',
      'توجد حركات بتاريخ ' || v_first || ' قبل تاريخ البداية الجديد؛ لا يمكن نقل البداية بعدها');
  end if;

  insert into public.book_openings(owner_id, book, start_date, opening_money, opening_weight)
  values (v_owner, p_book, v_start, v_money, v_weight)
  on conflict (owner_id, book) do update
    set start_date = excluded.start_date, opening_money = excluded.opening_money,
        opening_weight = excluded.opening_weight, version = public.book_openings.version + 1, updated_at = now()
  returning * into v_new;

  perform ledger_private.audit(v_owner, 'book_openings', p_book, case when old.owner_id is null then 'create' else 'update' end,
    case when old.owner_id is null then null else to_jsonb(old) end, to_jsonb(v_new), v_reason, p_request_id);
  return ledger_private.finish_write(v_owner, p_request_id, 'set_opening', v_params,
    jsonb_build_object('ok', true, 'book', p_book, 'version', v_new.version));
end $$;

------------------------------------------------------------------------------
-- RPC: القطعيات
------------------------------------------------------------------------------
create function public.add_qat_entry(p_request_id uuid, p_entry_date text, p_entry_type text,
  p_weight text default null, p_unit_price text default null, p_amount text default null,
  p_trader_name text default null, p_note text default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_params jsonb; v_prev jsonb; r public.qat_entries;
begin
  v_params := jsonb_build_object('entry_date', p_entry_date, 'entry_type', p_entry_type, 'weight', p_weight,
    'unit_price', p_unit_price, 'amount', p_amount, 'trader_name', p_trader_name, 'note', p_note, 'reason', p_reason);
  v_prev := ledger_private.begin_write(v_owner, p_request_id, 'add_qat_entry', v_params);
  if v_prev is not null then return v_prev; end if;
  r := ledger_private.build_qat(v_owner, p_entry_date, p_entry_type, p_weight, p_unit_price, p_amount,
    p_trader_name, p_note, p_reason);
  r.id := gen_random_uuid();
  r.seq := ledger_private.next_seq(v_owner);
  r.status := 'active'; r.version := 1; r.created_at := now(); r.updated_at := now();
  insert into public.qat_entries select r.*;
  perform ledger_private.audit(v_owner, 'qat_entries', r.id::text, 'create', null, to_jsonb(r), null, p_request_id);
  return ledger_private.finish_write(v_owner, p_request_id, 'add_qat_entry', v_params,
    jsonb_build_object('ok', true, 'entry', ledger_private.qat_entry_json(r)));
end $$;

create function public.update_qat_entry(p_request_id uuid, p_id uuid, p_expected_version int, p_entry_date text,
  p_entry_type text, p_weight text default null, p_unit_price text default null, p_amount text default null,
  p_trader_name text default null, p_note text default null, p_reason text default null, p_change_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_params jsonb; v_prev jsonb;
  old public.qat_entries; r public.qat_entries; v_change text;
begin
  v_params := jsonb_build_object('id', p_id, 'expected_version', p_expected_version, 'entry_date', p_entry_date,
    'entry_type', p_entry_type, 'weight', p_weight, 'unit_price', p_unit_price, 'amount', p_amount,
    'trader_name', p_trader_name, 'note', p_note, 'reason', p_reason, 'change_reason', p_change_reason);
  v_prev := ledger_private.begin_write(v_owner, p_request_id, 'update_qat_entry', v_params);
  if v_prev is not null then return v_prev; end if;
  select * into old from public.qat_entries where owner_id = v_owner and id = p_id for update;
  if not found then perform ledger_private.fail('not_found', 'الحركة غير موجودة'); end if;
  if old.status <> 'active' then perform ledger_private.fail('cancelled', 'لا يمكن تعديل حركة ملغاة'); end if;
  if p_expected_version is null or old.version <> p_expected_version then
    perform ledger_private.fail('conflict', 'تم تعديل هذه الحركة من مكان آخر (نسخة أحدث موجودة)؛ أعد التحميل ثم عدّل');
  end if;
  r := ledger_private.build_qat(v_owner, p_entry_date, p_entry_type, p_weight, p_unit_price, p_amount,
    p_trader_name, p_note, p_reason);
  v_change := ledger_private.clean_text(p_change_reason, 'سبب التصحيح', 500,
    (r.entry_date, r.entry_type, r.weight, r.unit_price, r.amount) is distinct from
    (old.entry_date, old.entry_type, old.weight, old.unit_price, old.amount));
  update public.qat_entries
     set entry_date = r.entry_date, entry_type = r.entry_type, weight = r.weight, unit_price = r.unit_price,
         amount = r.amount, trader_name = r.trader_name, note = r.note, reason = r.reason,
         version = version + 1, updated_at = now()
   where owner_id = v_owner and id = p_id
  returning * into r;
  perform ledger_private.audit(v_owner, 'qat_entries', p_id::text, 'update', to_jsonb(old), to_jsonb(r), v_change, p_request_id);
  return ledger_private.finish_write(v_owner, p_request_id, 'update_qat_entry', v_params,
    jsonb_build_object('ok', true, 'entry', ledger_private.qat_entry_json(r)));
end $$;

create function public.cancel_qat_entry(p_request_id uuid, p_id uuid, p_expected_version int, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_params jsonb; v_prev jsonb;
  old public.qat_entries; r public.qat_entries; v_reason text;
begin
  v_params := jsonb_build_object('id', p_id, 'expected_version', p_expected_version, 'reason', p_reason);
  v_prev := ledger_private.begin_write(v_owner, p_request_id, 'cancel_qat_entry', v_params);
  if v_prev is not null then return v_prev; end if;
  v_reason := ledger_private.clean_text(p_reason, 'سبب الإلغاء', 500, true);
  select * into old from public.qat_entries where owner_id = v_owner and id = p_id for update;
  if not found then perform ledger_private.fail('not_found', 'الحركة غير موجودة'); end if;
  if old.status <> 'active' then perform ledger_private.fail('cancelled', 'الحركة ملغاة بالفعل'); end if;
  if p_expected_version is null or old.version <> p_expected_version then
    perform ledger_private.fail('conflict', 'تم تعديل هذه الحركة من مكان آخر؛ أعد التحميل');
  end if;
  update public.qat_entries set status = 'cancelled', cancel_reason = v_reason, cancelled_at = now(),
         version = version + 1, updated_at = now()
   where owner_id = v_owner and id = p_id returning * into r;
  perform ledger_private.audit(v_owner, 'qat_entries', p_id::text, 'cancel', to_jsonb(old), to_jsonb(r), v_reason, p_request_id);
  return ledger_private.finish_write(v_owner, p_request_id, 'cancel_qat_entry', v_params,
    jsonb_build_object('ok', true, 'entry', ledger_private.qat_entry_json(r)));
end $$;

------------------------------------------------------------------------------
-- RPC: إنستا
------------------------------------------------------------------------------
create function public.add_insta_entry(p_request_id uuid, p_entry_date text, p_entry_type text, p_amount text,
  p_person_name text default null, p_note text default null, p_marked_paid boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_params jsonb; v_prev jsonb; r public.insta_entries;
begin
  v_params := jsonb_build_object('entry_date', p_entry_date, 'entry_type', p_entry_type, 'amount', p_amount,
    'person_name', p_person_name, 'note', p_note, 'marked_paid', p_marked_paid);
  v_prev := ledger_private.begin_write(v_owner, p_request_id, 'add_insta_entry', v_params);
  if v_prev is not null then return v_prev; end if;
  r := ledger_private.build_insta(v_owner, p_entry_date, p_entry_type, p_amount, p_person_name, p_note, p_marked_paid);
  r.id := gen_random_uuid();
  r.seq := ledger_private.next_seq(v_owner);
  r.status := 'active'; r.version := 1; r.created_at := now(); r.updated_at := now();
  insert into public.insta_entries select r.*;
  perform ledger_private.audit(v_owner, 'insta_entries', r.id::text, 'create', null, to_jsonb(r), null, p_request_id);
  return ledger_private.finish_write(v_owner, p_request_id, 'add_insta_entry', v_params,
    jsonb_build_object('ok', true, 'entry', ledger_private.insta_entry_json(r)));
end $$;

create function public.update_insta_entry(p_request_id uuid, p_id uuid, p_expected_version int, p_entry_date text,
  p_entry_type text, p_amount text, p_person_name text default null, p_note text default null,
  p_marked_paid boolean default false, p_change_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_params jsonb; v_prev jsonb;
  old public.insta_entries; r public.insta_entries; v_change text;
begin
  v_params := jsonb_build_object('id', p_id, 'expected_version', p_expected_version, 'entry_date', p_entry_date,
    'entry_type', p_entry_type, 'amount', p_amount, 'person_name', p_person_name, 'note', p_note,
    'marked_paid', p_marked_paid, 'change_reason', p_change_reason);
  v_prev := ledger_private.begin_write(v_owner, p_request_id, 'update_insta_entry', v_params);
  if v_prev is not null then return v_prev; end if;
  select * into old from public.insta_entries where owner_id = v_owner and id = p_id for update;
  if not found then perform ledger_private.fail('not_found', 'الحركة غير موجودة'); end if;
  if old.status <> 'active' then perform ledger_private.fail('cancelled', 'لا يمكن تعديل حركة ملغاة'); end if;
  if p_expected_version is null or old.version <> p_expected_version then
    perform ledger_private.fail('conflict', 'تم تعديل هذه الحركة من مكان آخر (نسخة أحدث موجودة)؛ أعد التحميل ثم عدّل');
  end if;
  r := ledger_private.build_insta(v_owner, p_entry_date, p_entry_type, p_amount, p_person_name, p_note, p_marked_paid);
  v_change := ledger_private.clean_text(p_change_reason, 'سبب التصحيح', 500,
    (r.entry_date, r.entry_type, r.amount) is distinct from (old.entry_date, old.entry_type, old.amount));
  update public.insta_entries
     set entry_date = r.entry_date, entry_type = r.entry_type, amount = r.amount, person_name = r.person_name,
         note = r.note, marked_paid = r.marked_paid, version = version + 1, updated_at = now()
   where owner_id = v_owner and id = p_id
  returning * into r;
  perform ledger_private.audit(v_owner, 'insta_entries', p_id::text, 'update', to_jsonb(old), to_jsonb(r), v_change, p_request_id);
  return ledger_private.finish_write(v_owner, p_request_id, 'update_insta_entry', v_params,
    jsonb_build_object('ok', true, 'entry', ledger_private.insta_entry_json(r)));
end $$;

create function public.cancel_insta_entry(p_request_id uuid, p_id uuid, p_expected_version int, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_params jsonb; v_prev jsonb;
  old public.insta_entries; r public.insta_entries; v_reason text;
begin
  v_params := jsonb_build_object('id', p_id, 'expected_version', p_expected_version, 'reason', p_reason);
  v_prev := ledger_private.begin_write(v_owner, p_request_id, 'cancel_insta_entry', v_params);
  if v_prev is not null then return v_prev; end if;
  v_reason := ledger_private.clean_text(p_reason, 'سبب الإلغاء', 500, true);
  select * into old from public.insta_entries where owner_id = v_owner and id = p_id for update;
  if not found then perform ledger_private.fail('not_found', 'الحركة غير موجودة'); end if;
  if old.status <> 'active' then perform ledger_private.fail('cancelled', 'الحركة ملغاة بالفعل'); end if;
  if p_expected_version is null or old.version <> p_expected_version then
    perform ledger_private.fail('conflict', 'تم تعديل هذه الحركة من مكان آخر؛ أعد التحميل');
  end if;
  update public.insta_entries set status = 'cancelled', cancel_reason = v_reason, cancelled_at = now(),
         version = version + 1, updated_at = now()
   where owner_id = v_owner and id = p_id returning * into r;
  perform ledger_private.audit(v_owner, 'insta_entries', p_id::text, 'cancel', to_jsonb(old), to_jsonb(r), v_reason, p_request_id);
  return ledger_private.finish_write(v_owner, p_request_id, 'cancel_insta_entry', v_params,
    jsonb_build_object('ok', true, 'entry', ledger_private.insta_entry_json(r)));
end $$;

------------------------------------------------------------------------------
-- RPC: الخزنة وسعر اليوم
------------------------------------------------------------------------------
-- p_field: 'cash' أو 'price'. p_value NULL أو فارغ = مسح القيمة (تصبح «غير مسجلة»)، و"0" للخزنة = صفر صريح.
create function public.set_daily_value(p_request_id uuid, p_value_date text, p_field text, p_value text,
  p_expected_version int default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_params jsonb; v_prev jsonb;
  v_date date; v_val numeric; old public.daily_values; r public.daily_values; v_reason text;
begin
  v_params := jsonb_build_object('value_date', p_value_date, 'field', p_field, 'value', p_value,
    'expected_version', p_expected_version, 'reason', p_reason);
  v_prev := ledger_private.begin_write(v_owner, p_request_id, 'set_daily_value', v_params);
  if v_prev is not null then return v_prev; end if;
  v_date := ledger_private.parse_date(p_value_date, 'التاريخ');
  if p_field is null or p_field not in ('cash', 'price') then
    perform ledger_private.fail('invalid_field', 'حقل غير صالح');
  end if;
  if nullif(btrim(coalesce(p_value, '')), '') is not null then
    if p_field = 'cash' then
      v_val := ledger_private.parse_num(p_value, 'رصيد الخزنة', 12, 2, 'nonneg');
    else
      v_val := ledger_private.parse_num(p_value, 'سعر الجرام', 10, 2, 'positive');
    end if;
  end if;
  v_reason := ledger_private.clean_text(p_reason, 'سبب التعديل', 500, false);

  select * into old from public.daily_values where owner_id = v_owner and value_date = v_date for update;
  if found then
    if p_expected_version is null or p_expected_version <> old.version then
      perform ledger_private.fail('conflict', 'تم تسجيل/تعديل قيمة هذا اليوم من مكان آخر؛ أعد التحميل');
    end if;
    if p_field = 'cash' then
      update public.daily_values set cash = v_val, cash_set_at = case when v_val is null then null else now() end,
             version = version + 1, updated_at = now()
       where owner_id = v_owner and value_date = v_date returning * into r;
    else
      update public.daily_values set price = v_val, price_set_at = case when v_val is null then null else now() end,
             version = version + 1, updated_at = now()
       where owner_id = v_owner and value_date = v_date returning * into r;
    end if;
  else
    if p_expected_version is not null then
      perform ledger_private.fail('conflict', 'قيمة هذا اليوم غير موجودة؛ أعد التحميل');
    end if;
    if v_val is null then
      perform ledger_private.fail('required', 'القيمة مطلوبة');
    end if;
    insert into public.daily_values(owner_id, value_date, cash, cash_set_at, price, price_set_at)
    values (v_owner, v_date,
            case when p_field = 'cash' then v_val end, case when p_field = 'cash' then now() end,
            case when p_field = 'price' then v_val end, case when p_field = 'price' then now() end)
    returning * into r;
  end if;
  perform ledger_private.audit(v_owner, 'daily_values', v_date::text, case when old.owner_id is null then 'create' else 'update' end,
    case when old.owner_id is null then null else to_jsonb(old) end, to_jsonb(r), v_reason, p_request_id);
  return ledger_private.finish_write(v_owner, p_request_id, 'set_daily_value', v_params,
    jsonb_build_object('ok', true, 'value_date', v_date, 'version', r.version,
      'cash', r.cash::text, 'price', r.price::text));
end $$;

create function public.list_daily_values(p_from text default null, p_to text default null) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_from date; v_to date;
begin
  if p_from is not null then v_from := ledger_private.parse_date(p_from, 'من تاريخ'); end if;
  if p_to is not null then v_to := ledger_private.parse_date(p_to, 'إلى تاريخ'); end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('value_date', value_date, 'cash', cash::text,
      'cash_set_at', cash_set_at, 'price', price::text, 'price_set_at', price_set_at, 'version', version)
      order by value_date desc), '[]'::jsonb)
    from public.daily_values
   where owner_id = v_owner and (v_from is null or value_date >= v_from) and (v_to is null or value_date <= v_to));
end $$;

------------------------------------------------------------------------------
-- RPC: حسبة اليوم والأرشيف
------------------------------------------------------------------------------
create function public.get_day_report(p_date text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_date date; v_rep jsonb;
begin
  v_date := ledger_private.parse_date(p_date, 'التاريخ');
  v_rep := ledger_private.day_report(v_owner, v_date);
  return v_rep || jsonb_build_object(
    'snapshots', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'saved_at', saved_at, 'd', d::text,
        'decision', decision, 'grams', grams::text, 'stale', inputs_fingerprint <> (v_rep ->> 'fingerprint'))
        order by saved_at), '[]'::jsonb)
      from public.calc_snapshots where owner_id = v_owner and calc_date = v_date),
    'data_version', (select data_version::text from public.ledger_accounts where owner_id = v_owner));
end $$;

create function public.save_calc(p_request_id uuid, p_calc_date text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_params jsonb; v_prev jsonb; v_date date;
  rep jsonb; res jsonb; s public.calc_snapshots; v_dv bigint;
begin
  v_params := jsonb_build_object('calc_date', p_calc_date);
  v_prev := ledger_private.begin_write(v_owner, p_request_id, 'save_calc', v_params);
  if v_prev is not null then return v_prev; end if;
  v_date := ledger_private.parse_date(p_calc_date, 'تاريخ الحسبة');
  -- القفل مأخوذ في begin_write: لا كتابة متزامنة لنفس المالك، والتقرير محسوب في لقطة واحدة.
  rep := ledger_private.day_report(v_owner, v_date);
  res := rep -> 'result';
  if res ->> 'status' <> 'complete' then
    perform ledger_private.fail('incomplete', 'لا يمكن حفظ حسبة ناقصة: ' || (res ->> 'missing'));
  end if;
  if res ->> 'grams_status' <> 'ok' then
    perform ledger_private.fail('price_missing', 'سجّل سعر جرام صالحًا لهذا اليوم قبل حفظ الحسبة');
  end if;
  select data_version into v_dv from public.ledger_accounts where owner_id = v_owner;
  insert into public.calc_snapshots(owner_id, calc_date, q, i, c, p, a, d, decision, grams, grams_approx,
      grams_below_min, inputs_fingerprint, data_version, rule_version, report)
  values (v_owner, v_date, (rep -> 'qat' ->> 'q')::numeric, (rep -> 'insta' ->> 'i')::numeric,
      (rep -> 'cash' ->> 'value')::numeric, (rep -> 'price' ->> 'value')::numeric,
      (res ->> 'a')::numeric, (res ->> 'd')::numeric, res ->> 'decision', (res ->> 'grams')::numeric,
      (res ->> 'grams_approx')::boolean, (res ->> 'grams_below_min')::boolean,
      rep ->> 'fingerprint', v_dv, 1, rep)
  returning * into s;
  perform ledger_private.audit(v_owner, 'calc_snapshots', s.id::text, 'create', null,
    jsonb_build_object('calc_date', s.calc_date, 'd', s.d, 'decision', s.decision, 'grams', s.grams), null, p_request_id);
  return ledger_private.finish_write(v_owner, p_request_id, 'save_calc', v_params,
    jsonb_build_object('ok', true, 'id', s.id, 'saved_at', s.saved_at, 'calc_date', s.calc_date));
end $$;

create function public.list_calc_snapshots(p_from text default null, p_to text default null,
  p_limit int default 30, p_offset int default 0) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_from date; v_to date; v_total bigint; v_rows jsonb;
begin
  if p_from is not null then v_from := ledger_private.parse_date(p_from, 'من تاريخ'); end if;
  if p_to is not null then v_to := ledger_private.parse_date(p_to, 'إلى تاريخ'); end if;
  select count(*) into v_total from public.calc_snapshots
   where owner_id = v_owner and (v_from is null or calc_date >= v_from) and (v_to is null or calc_date <= v_to);
  with page as (
    select * from public.calc_snapshots
     where owner_id = v_owner and (v_from is null or calc_date >= v_from) and (v_to is null or calc_date <= v_to)
     order by calc_date desc, saved_at desc
     limit least(greatest(coalesce(p_limit, 30), 1), 200) offset greatest(coalesce(p_offset, 0), 0)),
  cur as (
    select s.*, ledger_private.day_report(v_owner, s.calc_date) as now_rep from page s)
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'calc_date', calc_date, 'saved_at', saved_at, 'q', q::text, 'i', i::text, 'c', c::text,
      'p', p::text, 'a', a::text, 'd', d::text, 'decision', decision, 'grams', grams::text,
      'grams_approx', grams_approx, 'grams_below_min', grams_below_min, 'rule_version', rule_version,
      'data_version', data_version::text,
      'stale', inputs_fingerprint <> (now_rep ->> 'fingerprint'),
      'current', case when inputs_fingerprint <> (now_rep ->> 'fingerprint') then jsonb_build_object(
          'q', now_rep -> 'qat' ->> 'q', 'i', now_rep -> 'insta' ->> 'i',
          'c', now_rep -> 'cash' ->> 'value', 'p', now_rep -> 'price' ->> 'value',
          'result', now_rep -> 'result') end)
      order by calc_date desc, saved_at desc), '[]'::jsonb)
    into v_rows from cur;
  return jsonb_build_object('total', v_total::text, 'rows', v_rows);
end $$;

------------------------------------------------------------------------------
-- RPC: قوائم الدفاتر مع الرصيد الجاري وكشف الفترة
------------------------------------------------------------------------------
create function ledger_private.like_pattern(p text) returns text
language sql immutable set search_path = '' as $$
  select case when p is null then null else '%' || replace(replace(replace(p, '\', '\\'), '%', '\%'), '_', '\_') || '%' end
$$;

create function public.list_qat_entries(p_from text default null, p_to text default null, p_type text default null,
  p_search text default null, p_limit int default 50, p_offset int default 0, p_order text default 'desc')
returns jsonb language plpgsql stable set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_from date; v_to date; o public.book_openings;
  v_search text := ledger_private.like_pattern(nullif(btrim(coalesce(p_search, '')), ''));
  v_rows jsonb; v_tot jsonb; v_book jsonb; v_period jsonb; v_asc boolean := coalesce(p_order, 'desc') = 'asc';
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 500); v_offset int := greatest(coalesce(p_offset, 0), 0);
begin
  if p_from is not null then v_from := ledger_private.parse_date(p_from, 'من تاريخ'); end if;
  if p_to is not null then v_to := ledger_private.parse_date(p_to, 'إلى تاريخ'); end if;
  if p_type is not null and p_type not in ('buy', 'sell', 'cash_add', 'cash_deduct', 'adjust') then
    perform ledger_private.fail('invalid_type', 'نوع غير صالح');
  end if;
  select * into o from public.book_openings where owner_id = v_owner and book = 'qat';

  with base as (
    select e,
           case when e.status <> 'active' then 0 when e.entry_type in ('buy', 'cash_add') then e.amount else -e.amount end as md,
           case when e.status <> 'active' then 0 when e.entry_type = 'buy' then e.weight
                when e.entry_type = 'sell' then -e.weight else 0 end as wd
      from public.qat_entries e where e.owner_id = v_owner),
  run as (
    select e, md, wd,
           case when (e).status = 'active' then coalesce(o.opening_money, 0) + sum(md) over w end as running_money,
           case when (e).status = 'active' then coalesce(o.opening_weight, 0) + sum(wd) over w end as running_weight
      from base
    window w as (order by (e).entry_date, (e).seq rows between unbounded preceding and current row)),
  filt as (
    select * from run
     where (v_from is null or (e).entry_date >= v_from) and (v_to is null or (e).entry_date <= v_to)
       and (p_type is null or (e).entry_type = p_type or (p_type = 'adjust' and (e).entry_type in ('cash_add', 'cash_deduct')))
       and (v_search is null or (e).trader_name ilike v_search or (e).note ilike v_search or (e).reason ilike v_search)),
  pg as (
    select *, row_number() over (order by
             case when v_asc then (e).entry_date end asc, case when v_asc then (e).seq end asc,
             case when not v_asc then (e).entry_date end desc, case when not v_asc then (e).seq end desc) as rn
      from filt
     order by rn limit v_limit offset v_offset)
  select
    -- المجموع لكل النتائج المطابقة للفلتر (وليس الصفحة الظاهرة فقط)
    (select jsonb_build_object(
        'count', count(*)::text,
        'buy_weight', coalesce(sum((e).weight) filter (where (e).status = 'active' and (e).entry_type = 'buy'), 0)::text,
        'sell_weight', coalesce(sum((e).weight) filter (where (e).status = 'active' and (e).entry_type = 'sell'), 0)::text,
        'buy_value', coalesce(sum((e).amount) filter (where (e).status = 'active' and (e).entry_type = 'buy'), 0)::text,
        'sell_value', coalesce(sum((e).amount) filter (where (e).status = 'active' and (e).entry_type = 'sell'), 0)::text,
        'cash_add', coalesce(sum((e).amount) filter (where (e).status = 'active' and (e).entry_type = 'cash_add'), 0)::text,
        'cash_deduct', coalesce(sum((e).amount) filter (where (e).status = 'active' and (e).entry_type = 'cash_deduct'), 0)::text,
        'money_net', coalesce(sum(md), 0)::text, 'weight_net', coalesce(sum(wd), 0)::text) from filt),
    (select coalesce(jsonb_agg(ledger_private.qat_entry_json(e) || jsonb_build_object(
        'running_money', running_money::text, 'running_weight', running_weight::text) order by rn), '[]'::jsonb) from pg),
    -- إجمالي الدفتر كله (لا يتأثر بالفلترة أو الصفحات)
    (select jsonb_build_object('opening_money', o.opening_money::text, 'opening_weight', o.opening_weight::text,
        'start_date', o.start_date, 'configured', o.owner_id is not null,
        'money', (coalesce(o.opening_money, 0) + coalesce(sum(md), 0))::text,
        'net_weight', (coalesce(o.opening_weight, 0) + coalesce(sum(wd), 0))::text,
        'buy_weight', coalesce(sum((e).weight) filter (where (e).status = 'active' and (e).entry_type = 'buy'), 0)::text,
        'sell_weight', coalesce(sum((e).weight) filter (where (e).status = 'active' and (e).entry_type = 'sell'), 0)::text,
        'buy_value', coalesce(sum((e).amount) filter (where (e).status = 'active' and (e).entry_type = 'buy'), 0)::text,
        'sell_value', coalesce(sum((e).amount) filter (where (e).status = 'active' and (e).entry_type = 'sell'), 0)::text,
        'cash_add', coalesce(sum((e).amount) filter (where (e).status = 'active' and (e).entry_type = 'cash_add'), 0)::text,
        'cash_deduct', coalesce(sum((e).amount) filter (where (e).status = 'active' and (e).entry_type = 'cash_deduct'), 0)::text)
       from run),
    -- كشف الفترة: رصيد قبل البداية + حركات الفترة = رصيد النهاية (كل حركات الدفتر، بغض النظر عن البحث والنوع)
    (select case when o.owner_id is not null and (v_from is not null or v_to is not null) then jsonb_build_object(
        'from', v_from, 'to', v_to,
        'before_money', (o.opening_money + coalesce(sum(md) filter (where v_from is not null and (e).entry_date < v_from), 0))::text,
        'before_weight', (o.opening_weight + coalesce(sum(wd) filter (where v_from is not null and (e).entry_date < v_from), 0))::text,
        'period_money', coalesce(sum(md) filter (where (v_from is null or (e).entry_date >= v_from) and (v_to is null or (e).entry_date <= v_to)), 0)::text,
        'period_weight', coalesce(sum(wd) filter (where (v_from is null or (e).entry_date >= v_from) and (v_to is null or (e).entry_date <= v_to)), 0)::text,
        'end_money', (o.opening_money + coalesce(sum(md) filter (where v_to is null or (e).entry_date <= v_to), 0))::text,
        'end_weight', (o.opening_weight + coalesce(sum(wd) filter (where v_to is null or (e).entry_date <= v_to), 0))::text,
        'from_before_start', v_from is null or v_from <= o.start_date) end
       from run)
  into v_tot, v_rows, v_book, v_period;

  return jsonb_build_object('rows', v_rows, 'filtered', v_tot, 'book', v_book, 'period', v_period);
end $$;

create function public.list_insta_entries(p_from text default null, p_to text default null, p_type text default null,
  p_search text default null, p_limit int default 50, p_offset int default 0, p_order text default 'desc')
returns jsonb language plpgsql stable set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_from date; v_to date; o public.book_openings;
  v_search text := ledger_private.like_pattern(nullif(btrim(coalesce(p_search, '')), ''));
  v_rows jsonb; v_tot jsonb; v_book jsonb; v_period jsonb; v_asc boolean := coalesce(p_order, 'desc') = 'asc';
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 500); v_offset int := greatest(coalesce(p_offset, 0), 0);
begin
  if p_from is not null then v_from := ledger_private.parse_date(p_from, 'من تاريخ'); end if;
  if p_to is not null then v_to := ledger_private.parse_date(p_to, 'إلى تاريخ'); end if;
  if p_type is not null and p_type not in ('in', 'out') then
    perform ledger_private.fail('invalid_type', 'نوع غير صالح');
  end if;
  select * into o from public.book_openings where owner_id = v_owner and book = 'insta';

  with base as (
    select e, case when e.status <> 'active' then 0 when e.entry_type = 'in' then e.amount else -e.amount end as md
      from public.insta_entries e where e.owner_id = v_owner),
  run as (
    select e, md, case when (e).status = 'active' then coalesce(o.opening_money, 0) + sum(md) over w end as running_money
      from base
    window w as (order by (e).entry_date, (e).seq rows between unbounded preceding and current row)),
  filt as (
    select * from run
     where (v_from is null or (e).entry_date >= v_from) and (v_to is null or (e).entry_date <= v_to)
       and (p_type is null or (e).entry_type = p_type)
       and (v_search is null or (e).person_name ilike v_search or (e).note ilike v_search)),
  pg as (
    select *, row_number() over (order by
             case when v_asc then (e).entry_date end asc, case when v_asc then (e).seq end asc,
             case when not v_asc then (e).entry_date end desc, case when not v_asc then (e).seq end desc) as rn
      from filt
     order by rn limit v_limit offset v_offset)
  select
    (select jsonb_build_object('count', count(*)::text,
        'total_in', coalesce(sum((e).amount) filter (where (e).status = 'active' and (e).entry_type = 'in'), 0)::text,
        'total_out', coalesce(sum((e).amount) filter (where (e).status = 'active' and (e).entry_type = 'out'), 0)::text,
        'money_net', coalesce(sum(md), 0)::text) from filt),
    (select coalesce(jsonb_agg(ledger_private.insta_entry_json(e) || jsonb_build_object('running_money', running_money::text)
        order by rn), '[]'::jsonb) from pg),
    (select jsonb_build_object('opening_money', o.opening_money::text, 'start_date', o.start_date,
        'configured', o.owner_id is not null,
        'money', (coalesce(o.opening_money, 0) + coalesce(sum(md), 0))::text,
        'total_in', coalesce(sum((e).amount) filter (where (e).status = 'active' and (e).entry_type = 'in'), 0)::text,
        'total_out', coalesce(sum((e).amount) filter (where (e).status = 'active' and (e).entry_type = 'out'), 0)::text)
       from run),
    (select case when o.owner_id is not null and (v_from is not null or v_to is not null) then jsonb_build_object(
        'from', v_from, 'to', v_to,
        'before_money', (o.opening_money + coalesce(sum(md) filter (where v_from is not null and (e).entry_date < v_from), 0))::text,
        'period_money', coalesce(sum(md) filter (where (v_from is null or (e).entry_date >= v_from) and (v_to is null or (e).entry_date <= v_to)), 0)::text,
        'end_money', (o.opening_money + coalesce(sum(md) filter (where v_to is null or (e).entry_date <= v_to), 0))::text,
        'from_before_start', v_from is null or v_from <= o.start_date) end
       from run)
  into v_tot, v_rows, v_book, v_period;

  return jsonb_build_object('rows', v_rows, 'filtered', v_tot, 'book', v_book, 'period', v_period);
end $$;

------------------------------------------------------------------------------
-- RPC: الباقي على الناس (مستقل تمامًا)
------------------------------------------------------------------------------
create function public.create_person(p_request_id uuid, p_name text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_params jsonb; v_prev jsonb; r public.people;
begin
  v_params := jsonb_build_object('name', p_name, 'note', p_note);
  v_prev := ledger_private.begin_write(v_owner, p_request_id, 'create_person', v_params);
  if v_prev is not null then return v_prev; end if;
  insert into public.people(owner_id, name, note)
  values (v_owner, ledger_private.clean_text(p_name, 'الاسم', 100, true), ledger_private.clean_text(p_note, 'الملاحظة', 500, false))
  returning * into r;
  perform ledger_private.audit(v_owner, 'people', r.id::text, 'create', null, to_jsonb(r), null, p_request_id);
  return ledger_private.finish_write(v_owner, p_request_id, 'create_person', v_params,
    jsonb_build_object('ok', true, 'id', r.id, 'name', r.name, 'version', r.version));
end $$;

create function public.update_person(p_request_id uuid, p_id uuid, p_expected_version int, p_name text,
  p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_params jsonb; v_prev jsonb; old public.people; r public.people;
begin
  v_params := jsonb_build_object('id', p_id, 'expected_version', p_expected_version, 'name', p_name, 'note', p_note);
  v_prev := ledger_private.begin_write(v_owner, p_request_id, 'update_person', v_params);
  if v_prev is not null then return v_prev; end if;
  select * into old from public.people where owner_id = v_owner and id = p_id for update;
  if not found then perform ledger_private.fail('not_found', 'الشخص غير موجود'); end if;
  if p_expected_version is null or old.version <> p_expected_version then
    perform ledger_private.fail('conflict', 'تم تعديل بيانات الشخص من مكان آخر؛ أعد التحميل');
  end if;
  update public.people set name = ledger_private.clean_text(p_name, 'الاسم', 100, true),
         note = ledger_private.clean_text(p_note, 'الملاحظة', 500, false), version = version + 1, updated_at = now()
   where owner_id = v_owner and id = p_id returning * into r;
  perform ledger_private.audit(v_owner, 'people', p_id::text, 'update', to_jsonb(old), to_jsonb(r), null, p_request_id);
  return ledger_private.finish_write(v_owner, p_request_id, 'update_person', v_params,
    jsonb_build_object('ok', true, 'id', r.id, 'version', r.version));
end $$;

create function ledger_private.build_debt(p_entry_date text, p_entry_type text, p_amount text, p_note text,
  out o_date date, out o_type text, out o_amount numeric, out o_note text)
language plpgsql immutable set search_path = '' as $$
begin
  o_date := ledger_private.parse_date(p_entry_date, 'التاريخ');
  if p_entry_type is null or p_entry_type not in ('sent', 'repaid') then
    perform ledger_private.fail('invalid_type', 'نوع الحركة غير صالح');
  end if;
  o_type := p_entry_type;
  o_amount := ledger_private.parse_num(p_amount, 'المبلغ', 12, 2, 'positive');
  o_note := ledger_private.clean_text(p_note, 'الملاحظة', 500, false);
end $$;

create function public.add_debt_entry(p_request_id uuid, p_person_id uuid, p_entry_date text, p_entry_type text,
  p_amount text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_params jsonb; v_prev jsonb; b record; r public.debt_entries;
  v_remaining numeric;
begin
  v_params := jsonb_build_object('person_id', p_person_id, 'entry_date', p_entry_date, 'entry_type', p_entry_type,
    'amount', p_amount, 'note', p_note);
  v_prev := ledger_private.begin_write(v_owner, p_request_id, 'add_debt_entry', v_params);
  if v_prev is not null then return v_prev; end if;
  perform 1 from public.people where owner_id = v_owner and id = p_person_id;
  if not found then perform ledger_private.fail('not_found', 'الشخص غير موجود'); end if;
  select * into b from ledger_private.build_debt(p_entry_date, p_entry_type, p_amount, p_note);
  if b.o_type = 'repaid' then
    v_remaining := ledger_private.debt_balance_at(v_owner, p_person_id, b.o_date);
    if b.o_amount > v_remaining then
      perform ledger_private.fail('overpayment', 'السداد (' || b.o_amount || ') أكبر من المتبقي على الشخص بتاريخ '
        || b.o_date || ' (' || v_remaining || '). لم يتم الحفظ.');
    end if;
  end if;
  insert into public.debt_entries(owner_id, person_id, seq, entry_date, entry_type, amount, note)
  values (v_owner, p_person_id, ledger_private.next_seq(v_owner), b.o_date, b.o_type, b.o_amount, b.o_note)
  returning * into r;
  perform ledger_private.assert_debt_timeline(v_owner, p_person_id);
  perform ledger_private.audit(v_owner, 'debt_entries', r.id::text, 'create', null, to_jsonb(r), null, p_request_id);
  return ledger_private.finish_write(v_owner, p_request_id, 'add_debt_entry', v_params,
    jsonb_build_object('ok', true, 'entry', ledger_private.debt_entry_json(r)));
end $$;

create function public.update_debt_entry(p_request_id uuid, p_id uuid, p_expected_version int, p_entry_date text,
  p_entry_type text, p_amount text, p_note text default null, p_change_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_params jsonb; v_prev jsonb; b record;
  old public.debt_entries; r public.debt_entries; v_change text;
begin
  v_params := jsonb_build_object('id', p_id, 'expected_version', p_expected_version, 'entry_date', p_entry_date,
    'entry_type', p_entry_type, 'amount', p_amount, 'note', p_note, 'change_reason', p_change_reason);
  v_prev := ledger_private.begin_write(v_owner, p_request_id, 'update_debt_entry', v_params);
  if v_prev is not null then return v_prev; end if;
  select * into old from public.debt_entries where owner_id = v_owner and id = p_id for update;
  if not found then perform ledger_private.fail('not_found', 'الحركة غير موجودة'); end if;
  if old.status <> 'active' then perform ledger_private.fail('cancelled', 'لا يمكن تعديل حركة ملغاة'); end if;
  if p_expected_version is null or old.version <> p_expected_version then
    perform ledger_private.fail('conflict', 'تم تعديل هذه الحركة من مكان آخر؛ أعد التحميل');
  end if;
  select * into b from ledger_private.build_debt(p_entry_date, p_entry_type, p_amount, p_note);
  v_change := ledger_private.clean_text(p_change_reason, 'سبب التصحيح', 500,
    (b.o_date, b.o_type, b.o_amount) is distinct from (old.entry_date, old.entry_type, old.amount));
  update public.debt_entries set entry_date = b.o_date, entry_type = b.o_type, amount = b.o_amount, note = b.o_note,
         version = version + 1, updated_at = now()
   where owner_id = v_owner and id = p_id returning * into r;
  perform ledger_private.assert_debt_timeline(v_owner, old.person_id);
  perform ledger_private.audit(v_owner, 'debt_entries', p_id::text, 'update', to_jsonb(old), to_jsonb(r), v_change, p_request_id);
  return ledger_private.finish_write(v_owner, p_request_id, 'update_debt_entry', v_params,
    jsonb_build_object('ok', true, 'entry', ledger_private.debt_entry_json(r)));
end $$;

create function public.cancel_debt_entry(p_request_id uuid, p_id uuid, p_expected_version int, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_params jsonb; v_prev jsonb;
  old public.debt_entries; r public.debt_entries; v_reason text;
begin
  v_params := jsonb_build_object('id', p_id, 'expected_version', p_expected_version, 'reason', p_reason);
  v_prev := ledger_private.begin_write(v_owner, p_request_id, 'cancel_debt_entry', v_params);
  if v_prev is not null then return v_prev; end if;
  v_reason := ledger_private.clean_text(p_reason, 'سبب الإلغاء', 500, true);
  select * into old from public.debt_entries where owner_id = v_owner and id = p_id for update;
  if not found then perform ledger_private.fail('not_found', 'الحركة غير موجودة'); end if;
  if old.status <> 'active' then perform ledger_private.fail('cancelled', 'الحركة ملغاة بالفعل'); end if;
  if p_expected_version is null or old.version <> p_expected_version then
    perform ledger_private.fail('conflict', 'تم تعديل هذه الحركة من مكان آخر؛ أعد التحميل');
  end if;
  update public.debt_entries set status = 'cancelled', cancel_reason = v_reason, cancelled_at = now(),
         version = version + 1, updated_at = now()
   where owner_id = v_owner and id = p_id returning * into r;
  perform ledger_private.assert_debt_timeline(v_owner, old.person_id);
  perform ledger_private.audit(v_owner, 'debt_entries', p_id::text, 'cancel', to_jsonb(old), to_jsonb(r), v_reason, p_request_id);
  return ledger_private.finish_write(v_owner, p_request_id, 'cancel_debt_entry', v_params,
    jsonb_build_object('ok', true, 'entry', ledger_private.debt_entry_json(r)));
end $$;

create function public.list_people(p_as_of text default null, p_status text default null, p_search text default null)
returns jsonb language plpgsql stable set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_as_of date; v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_rows jsonb; v_total numeric;
begin
  if p_as_of is not null then v_as_of := ledger_private.parse_date(p_as_of, 'التاريخ'); end if;
  if p_status is not null and p_status not in ('unpaid', 'partial', 'paid', 'open', 'none') then
    perform ledger_private.fail('invalid_status', 'حالة غير صالحة');
  end if;
  with t as (
    select p.id, p.name, p.note, p.version,
           coalesce(sum(d.amount) filter (where d.entry_type = 'sent'), 0) as sent,
           coalesce(sum(d.amount) filter (where d.entry_type = 'repaid'), 0) as repaid,
           max(d.entry_date) as last_date
      from public.people p
      left join public.debt_entries d on d.owner_id = p.owner_id and d.person_id = p.id and d.status = 'active'
            and (v_as_of is null or d.entry_date <= v_as_of)
     where p.owner_id = v_owner
     group by p.id, p.name, p.note, p.version),
  s as (
    select *, sent - repaid as remaining,
           case when sent = 0 then 'none' when sent - repaid = 0 then 'paid' when repaid = 0 then 'unpaid' else 'partial' end as status
      from t)
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'note', note, 'version', version,
           'sent', sent::text, 'repaid', repaid::text, 'remaining', remaining::text, 'status', status, 'last_date', last_date)
           order by remaining desc, name) filter (where (p_status is null or status = p_status
               or (p_status = 'open' and status in ('unpaid', 'partial')))
             and (v_search is null or name ilike ledger_private.like_pattern(v_search))), '[]'::jsonb),
         coalesce(sum(remaining), 0)
    into v_rows, v_total from s;
  return jsonb_build_object('as_of', v_as_of, 'rows', v_rows, 'total_outstanding', v_total::text);
end $$;

create function public.get_person(p_id uuid, p_as_of text default null) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v_as_of date; p public.people; v_rows jsonb;
begin
  if p_as_of is not null then v_as_of := ledger_private.parse_date(p_as_of, 'التاريخ'); end if;
  select * into p from public.people where owner_id = v_owner and id = p_id;
  if not found then perform ledger_private.fail('not_found', 'الشخص غير موجود'); end if;
  select coalesce(jsonb_agg(ledger_private.debt_entry_json(x.d) || jsonb_build_object('running', x.running::text)
      order by (x.d).entry_date, (x.d).seq), '[]'::jsonb)
    into v_rows
    from (select d, case when d.status = 'active' then sum(case when d.status <> 'active' then 0
                   when d.entry_type = 'sent' then d.amount else -d.amount end)
                   over (order by d.entry_date, d.seq rows between unbounded preceding and current row) end as running
            from public.debt_entries d
           where d.owner_id = v_owner and d.person_id = p_id and (v_as_of is null or d.entry_date <= v_as_of)) x;
  return jsonb_build_object('id', p.id, 'name', p.name, 'note', p.note, 'version', p.version, 'as_of', v_as_of,
    'entries', v_rows,
    'sent', (select coalesce(sum(amount), 0)::text from public.debt_entries where owner_id = v_owner and person_id = p_id
              and status = 'active' and entry_type = 'sent' and (v_as_of is null or entry_date <= v_as_of)),
    'repaid', (select coalesce(sum(amount), 0)::text from public.debt_entries where owner_id = v_owner and person_id = p_id
              and status = 'active' and entry_type = 'repaid' and (v_as_of is null or entry_date <= v_as_of)),
    'remaining', ledger_private.debt_balance_at(v_owner, p_id, coalesce(v_as_of, date '2100-12-31'))::text);
end $$;

------------------------------------------------------------------------------
-- RPC: سجل المراجعة
------------------------------------------------------------------------------
create function public.list_audit(p_entity text default null, p_record_id text default null,
  p_limit int default 100, p_offset int default 0) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner();
begin
  return jsonb_build_object(
    'total', (select count(*)::text from public.audit_log where owner_id = v_owner
       and (p_entity is null or entity = p_entity) and (p_record_id is null or record_id = p_record_id)),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'at', at, 'entity', entity, 'record_id', record_id,
        'action', action, 'old_data', old_data, 'new_data', new_data, 'reason', reason) order by at desc), '[]'::jsonb)
      from (select * from public.audit_log where owner_id = v_owner
              and (p_entity is null or entity = p_entity) and (p_record_id is null or record_id = p_record_id)
            order by at desc limit least(greatest(coalesce(p_limit, 100), 1), 500) offset greatest(coalesce(p_offset, 0), 0)) a));
end $$;

------------------------------------------------------------------------------
-- النسخ الاحتياطي والاستعادة
------------------------------------------------------------------------------
-- تصدير كل بيانات دفاتر المالك من لقطة واحدة (STABLE => كل الاستعلامات ترى نفس حالة القاعدة).
create function ledger_private.export_data(p_owner uuid) returns jsonb
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
        'request_id', request_id) order by at, id), '[]'::jsonb)
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

create function public.export_backup() returns jsonb
language plpgsql stable set search_path = '' as $$
declare v_owner uuid := ledger_private.require_owner(); v jsonb;
begin
  v := ledger_private.export_data(v_owner);
  if v is null then perform ledger_private.fail('account_not_setup', 'لا توجد بيانات دفتر لتصديرها'); end if;
  return v;
end $$;

-- استعادة = استبدال كامل لبيانات دفاتر المالك الحالي فقط، بشكل ذري.
-- 1) فحص الملف كله في جداول مؤقتة قبل لمس أي بيانات. 2) حفظ نسخة من الوضع الحالي في restore_events.
-- 3) حذف بيانات المالك ثم إدراج بيانات الملف بمالك = الجلسة (owner_id داخل الملف يُتجاهل).
-- 4) فحص القواعد بعد الإدراج؛ أي خطأ يلغي كل شيء. يرفض إذا تغير data_version منذ معاينة المستخدم.
create function public.restore_backup(p_request_id uuid, p_expected_data_version bigint, p_file jsonb) returns jsonb
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
    delete from public.audit_log where owner_id = v_owner;

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
    insert into public.audit_log(owner_id, id, at, entity, record_id, action, old_data, new_data, reason, request_id)
      select v_owner, id, at, entity, record_id, action, old_data, new_data, reason, request_id from pg_temp._r_audit;

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

create function public.list_restore_events() returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'restored_at', restored_at, 'file_checksum', file_checksum,
      'file_exported_at', file_exported_at, 'counts', counts) order by restored_at desc), '[]'::jsonb)
    from public.restore_events where owner_id = ledger_private.current_owner()
$$;

------------------------------------------------------------------------------
-- الصلاحيات والملكية
------------------------------------------------------------------------------
-- تغيير مالك الدالة يتطلب أن يملك المالك الجديد CREATE على المخطط؛ نمنحه مؤقتًا ثم نسحبه.
grant create on schema public to ledger_writer;
do $$
declare f record;
begin
  -- لا تنفيذ افتراضي لأي دالة لـ PUBLIC/anon. تقتصر على دوال الدفتر بالاسم:
  -- لا تمس دوال أخرى موجودة في public (مثل public.rls_auto_enable الخاصة بمنصة Supabase).
  for f in select p.oid::regprocedure as sig, n.nspname, p.proname, p.prosecdef
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where (n.nspname = 'ledger_private'
                   or (n.nspname = 'public' and p.proname in ('get_state', 'setup_account', 'set_opening',
                       'add_qat_entry', 'update_qat_entry', 'cancel_qat_entry', 'add_insta_entry', 'update_insta_entry',
                       'cancel_insta_entry', 'set_daily_value', 'list_daily_values', 'get_day_report', 'save_calc',
                       'list_calc_snapshots', 'list_qat_entries', 'list_insta_entries', 'create_person', 'update_person',
                       'add_debt_entry', 'update_debt_entry', 'cancel_debt_entry', 'list_people', 'get_person',
                       'list_audit', 'export_backup', 'restore_backup', 'list_restore_events')))
              and exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') is false
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
    if f.nspname = 'public' then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
    if f.prosecdef then
      execute format('alter function %s owner to ledger_writer', f.sig);
    end if;
  end loop;
end $$;
revoke create on schema public from ledger_writer;

-- دوال القراءة الخاصة يستخدمها المستدعي (INVOKER) ودوال الكتابة.
grant execute on function ledger_private.current_owner(), ledger_private.require_owner(), ledger_private.fail(text, text),
  ledger_private.parse_num(text, text, int, int, text), ledger_private.parse_date(text, text),
  ledger_private.clean_text(text, text, int, boolean), ledger_private.cairo_today(),
  ledger_private.inputs_fingerprint(uuid, date), ledger_private.day_report(uuid, date),
  ledger_private.qat_entry_json(public.qat_entries), ledger_private.insta_entry_json(public.insta_entries),
  ledger_private.debt_entry_json(public.debt_entries), ledger_private.debt_balance_at(uuid, uuid, date),
  ledger_private.like_pattern(text), ledger_private.export_data(uuid), ledger_private.json_numbers_as_text(jsonb)
  to authenticated, ledger_writer;
-- دوال الكتابة الخاصة لدور الكتابة فقط.
grant execute on function ledger_private.begin_write(uuid, uuid, text, jsonb),
  ledger_private.finish_write(uuid, uuid, text, jsonb, jsonb), ledger_private.next_seq(uuid),
  ledger_private.audit(uuid, text, text, text, jsonb, jsonb, text, uuid), ledger_private.assert_in_book(uuid, text, date),
  ledger_private.assert_debt_timeline(uuid, uuid),
  ledger_private.build_qat(uuid, text, text, text, text, text, text, text, text),
  ledger_private.build_insta(uuid, text, text, text, text, text, boolean),
  ledger_private.build_debt(text, text, text, text)
  to ledger_writer;
grant execute on function ledger_private.forbid_update() to ledger_writer, authenticated;

-- دفاتر الذهب — المخطط الأساسي (schema_version = 1, rule_version = 1)
-- كل الكيانات مرتبطة بصاحبها owner_id = هوية جلسة Supabase Auth.
-- المبالغ NUMERIC وليست float. التواريخ DATE بتوقيت القاهرة، والأوقات TIMESTAMPTZ.
-- العميل لا يملك صلاحية كتابة مباشرة على الجداول؛ الكتابة فقط عبر دوال RPC في الملف التالي.

create schema if not exists ledger_private;
revoke all on schema ledger_private from public;

-- دور مالك دوال الكتابة. ليس له BYPASSRLS ولا يسجل دخولًا، لذلك RLS تنطبق عليه داخل الدوال.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ledger_writer') then
    create role ledger_writer nologin noinherit nobypassrls;
  end if;
end $$;
grant ledger_writer to postgres;

------------------------------------------------------------------------------
-- الجداول
------------------------------------------------------------------------------

create table public.ledger_accounts (
  owner_id       uuid primary key references auth.users(id) on delete cascade,
  weight_basis   text not null check (char_length(btrim(weight_basis)) between 1 and 50),
  data_version   bigint not null default 1 check (data_version >= 1),
  next_seq       bigint not null default 1 check (next_seq >= 1),
  schema_version int not null default 1,
  rule_version   int not null default 1,
  version        int not null default 1 check (version >= 1),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
comment on table public.ledger_accounts is 'إعدادات دفتر المالك: أساس/عيار الوزن، رقم إصدار البيانات (قفل الاستعادة)، عداد الترتيب الثابت.';

create table public.book_openings (
  owner_id       uuid not null references public.ledger_accounts(owner_id) on delete cascade,
  book           text not null check (book in ('qat', 'insta')),
  start_date     date not null check (start_date between date '2000-01-01' and date '2100-12-31'),
  opening_money  numeric(18,2) not null,
  opening_weight numeric(14,6),
  version        int not null default 1 check (version >= 1),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (owner_id, book),
  check ((book = 'qat' and opening_weight is not null) or (book = 'insta' and opening_weight is null))
);
comment on table public.book_openings is 'افتتاحية وتاريخ بداية دفتري القطعيات وإنستا. تدخل مرة واحدة قبل حركات تاريخ البداية.';

create table public.qat_entries (
  owner_id      uuid not null references public.ledger_accounts(owner_id) on delete cascade,
  id            uuid not null default gen_random_uuid(),
  seq           bigint not null check (seq >= 1),
  entry_date    date not null check (entry_date between date '2000-01-01' and date '2100-12-31'),
  entry_type    text not null check (entry_type in ('buy', 'sell', 'cash_add', 'cash_deduct')),
  weight        numeric(12,6),
  unit_price    numeric(12,2),
  amount        numeric(18,2) not null check (amount > 0),
  trader_name   text check (char_length(trader_name) <= 100),
  note          text check (char_length(note) <= 500),
  reason        text check (char_length(reason) <= 500),
  status        text not null default 'active' check (status in ('active', 'cancelled')),
  cancel_reason text check (char_length(cancel_reason) <= 500),
  cancelled_at  timestamptz,
  version       int not null default 1 check (version >= 1),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (owner_id, id),
  unique (owner_id, seq),
  check (case when entry_type in ('buy', 'sell')
              then weight > 0 and unit_price > 0 and amount = round(weight * unit_price, 2)
              else weight is null and unit_price is null and reason is not null and btrim(reason) <> '' end),
  check ((status = 'active' and cancel_reason is null) or (status = 'cancelled' and cancel_reason is not null))
);
comment on table public.qat_entries is 'دفتر القطعيات: buy=شراء من التاجر (يزيد الفلوس اللي عليك)، sell=بيع للتاجر (ينقصها)، cash_add/cash_deduct=تسوية مالية بسبب إلزامي.';
create index qat_entries_owner_date_idx on public.qat_entries (owner_id, entry_date, seq);

create table public.insta_entries (
  owner_id      uuid not null references public.ledger_accounts(owner_id) on delete cascade,
  id            uuid not null default gen_random_uuid(),
  seq           bigint not null check (seq >= 1),
  entry_date    date not null check (entry_date between date '2000-01-01' and date '2100-12-31'),
  entry_type    text not null check (entry_type in ('in', 'out')),
  amount        numeric(18,2) not null check (amount > 0),
  person_name   text check (char_length(person_name) <= 100),
  note          text check (char_length(note) <= 500),
  marked_paid   boolean not null default false,
  status        text not null default 'active' check (status in ('active', 'cancelled')),
  cancel_reason text check (char_length(cancel_reason) <= 500),
  cancelled_at  timestamptz,
  version       int not null default 1 check (version >= 1),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (owner_id, id),
  unique (owner_id, seq),
  check ((status = 'active' and cancel_reason is null) or (status = 'cancelled' and cancel_reason is not null))
);
comment on column public.insta_entries.marked_paid is 'علامة «تم السداد» وصف فقط، لا تخصم أي مبلغ.';
create index insta_entries_owner_date_idx on public.insta_entries (owner_id, entry_date, seq);

create table public.daily_values (
  owner_id     uuid not null references public.ledger_accounts(owner_id) on delete cascade,
  value_date   date not null check (value_date between date '2000-01-01' and date '2100-12-31'),
  cash         numeric(18,2) check (cash >= 0),
  cash_set_at  timestamptz,
  price        numeric(12,2) check (price > 0),
  price_set_at timestamptz,
  version      int not null default 1 check (version >= 1),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (owner_id, value_date),
  check ((cash is null) = (cash_set_at is null)),
  check ((price is null) = (price_set_at is null))
);
comment on table public.daily_values is 'رقم الخزنة وسعر الجرام لكل يوم على حدة. غير تراكمي ولا يرث قيمة الأمس. NULL = غير مسجل، 0 = صفر مُدخل.';

create table public.calc_snapshots (
  owner_id           uuid not null references public.ledger_accounts(owner_id) on delete cascade,
  id                 uuid not null default gen_random_uuid(),
  calc_date          date not null,
  q                  numeric not null,
  i                  numeric not null,
  c                  numeric not null,
  p                  numeric not null check (p > 0),
  a                  numeric not null,
  d                  numeric not null,
  decision           text not null check (decision in ('sell', 'buy', 'balanced')),
  grams              numeric(20,6) not null check (grams >= 0),
  grams_approx       boolean not null,
  grams_below_min    boolean not null,
  inputs_fingerprint text not null,
  data_version       bigint not null,
  rule_version       int not null,
  report             jsonb not null,
  saved_at           timestamptz not null default now(),
  primary key (owner_id, id),
  check (a = c + i and d = q - a)
);
comment on table public.calc_snapshots is 'نسخ حسبة اليوم كما حفظها المستخدم. لا تُعدّل أبدًا؛ التصحيح يُحفظ كنسخة جديدة.';
create index calc_snapshots_owner_date_idx on public.calc_snapshots (owner_id, calc_date, saved_at);

create table public.people (
  owner_id   uuid not null references public.ledger_accounts(owner_id) on delete cascade,
  id         uuid not null default gen_random_uuid(),
  name       text not null check (char_length(btrim(name)) between 1 and 100),
  note       text check (char_length(note) <= 500),
  version    int not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, id)
);
comment on table public.people is 'تاب «الباقي على الناس» — مستقل تمامًا عن حساب المحل.';

create table public.debt_entries (
  owner_id      uuid not null references public.ledger_accounts(owner_id) on delete cascade,
  id            uuid not null default gen_random_uuid(),
  person_id     uuid not null,
  seq           bigint not null check (seq >= 1),
  entry_date    date not null check (entry_date between date '2000-01-01' and date '2100-12-31'),
  entry_type    text not null check (entry_type in ('sent', 'repaid')),
  amount        numeric(18,2) not null check (amount > 0),
  note          text check (char_length(note) <= 500),
  status        text not null default 'active' check (status in ('active', 'cancelled')),
  cancel_reason text check (char_length(cancel_reason) <= 500),
  cancelled_at  timestamptz,
  version       int not null default 1 check (version >= 1),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (owner_id, id),
  unique (owner_id, seq),
  foreign key (owner_id, person_id) references public.people(owner_id, id),
  check ((status = 'active' and cancel_reason is null) or (status = 'cancelled' and cancel_reason is not null))
);
create index debt_entries_owner_person_idx on public.debt_entries (owner_id, person_id, entry_date, seq);

create table public.audit_log (
  owner_id   uuid not null references public.ledger_accounts(owner_id) on delete cascade,
  id         uuid not null default gen_random_uuid(),
  at         timestamptz not null default now(),
  entity     text not null,
  record_id  text not null,
  action     text not null,
  old_data   jsonb,
  new_data   jsonb,
  reason     text,
  request_id uuid,
  primary key (owner_id, id)
);
create index audit_log_owner_record_idx on public.audit_log (owner_id, entity, record_id, at);
create index audit_log_owner_at_idx on public.audit_log (owner_id, at);

create table public.save_requests (
  owner_id    uuid not null references public.ledger_accounts(owner_id) on delete cascade,
  request_id  uuid not null,
  op          text not null,
  params_hash text not null,
  result      jsonb not null,
  created_at  timestamptz not null default now(),
  primary key (owner_id, request_id)
);
comment on table public.save_requests is 'منع تكرار الحفظ: نفس request_id يعيد نتيجة الطلب الأول، ومحتوى مختلف يُرفض.';

create table public.restore_events (
  owner_id            uuid not null references public.ledger_accounts(owner_id) on delete cascade,
  id                  uuid not null default gen_random_uuid(),
  restored_at         timestamptz not null default now(),
  request_id          uuid not null,
  file_checksum       text not null,
  file_exported_at    text,
  file_schema_version int not null,
  counts              jsonb not null,
  previous_backup     jsonb not null,
  primary key (owner_id, id)
);
comment on table public.restore_events is 'أثر عمليات الاستعادة ونسخة البيانات السابقة لها. لا تمسحه الاستعادة.';

------------------------------------------------------------------------------
-- منع تعديل السجلات غير القابلة للتغيير حتى من الدوال
------------------------------------------------------------------------------
create function ledger_private.forbid_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = 'هذا السجل غير قابل للتعديل', detail = 'immutable_record';
end $$;

create trigger calc_snapshots_immutable before update on public.calc_snapshots
  for each row execute function ledger_private.forbid_update();
create trigger audit_log_immutable before update on public.audit_log
  for each row execute function ledger_private.forbid_update();
create trigger restore_events_immutable before update on public.restore_events
  for each row execute function ledger_private.forbid_update();
create trigger save_requests_immutable before update on public.save_requests
  for each row execute function ledger_private.forbid_update();

------------------------------------------------------------------------------
-- هوية المستدعي وRLS
------------------------------------------------------------------------------
-- نفس منطق auth.uid() في Supabase (يقرأ الـJWT الذي تحققت منه PostgREST)،
-- معرف هنا لأن دور ledger_writer لا يملك USAGE على مخطط auth.
create function ledger_private.current_owner() returns uuid
language sql stable set search_path = '' as $$
  select case
    when coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
                  nullif(current_setting('request.jwt.claim.role', true), '')) = 'authenticated'
    then nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                         nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'), '')::uuid
  end
$$;

do $$
declare t text;
begin
  foreach t in array array['ledger_accounts','book_openings','qat_entries','insta_entries','daily_values',
                           'calc_snapshots','people','debt_entries','audit_log','save_requests','restore_events']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated, ledger_writer using (owner_id = (select ledger_private.current_owner()))', t || '_select_own', t);
    execute format('create policy %I on public.%I for insert to ledger_writer with check (owner_id = (select ledger_private.current_owner()))', t || '_insert_own', t);
    execute format('create policy %I on public.%I for update to ledger_writer using (owner_id = (select ledger_private.current_owner())) with check (owner_id = (select ledger_private.current_owner()))', t || '_update_own', t);
    execute format('create policy %I on public.%I for delete to ledger_writer using (owner_id = (select ledger_private.current_owner()))', t || '_delete_own', t);
  end loop;
end $$;

-- صلاحيات دور الكتابة: أقل ما يلزم. الحذف فقط للجداول التي تستبدلها الاستعادة.
grant select, insert, update on public.ledger_accounts, public.book_openings, public.qat_entries,
  public.insta_entries, public.daily_values, public.people, public.debt_entries to ledger_writer;
grant select, insert on public.calc_snapshots, public.audit_log, public.save_requests, public.restore_events to ledger_writer;
grant delete on public.book_openings, public.qat_entries, public.insta_entries, public.daily_values,
  public.people, public.debt_entries, public.calc_snapshots, public.audit_log to ledger_writer;
-- لا حذف لـ ledger_accounts أو save_requests أو restore_events لأي دور تطبيقي.
-- service_role يتجاوز RLS في Supabase؛ لا يستخدمه التطبيق. نزيل صلاحياته الافتراضية على هذه الجداول أيضًا.
revoke all on public.ledger_accounts, public.book_openings, public.qat_entries, public.insta_entries,
  public.daily_values, public.calc_snapshots, public.people, public.debt_entries, public.audit_log,
  public.save_requests, public.restore_events from service_role;
grant select on public.ledger_accounts, public.book_openings, public.qat_entries, public.insta_entries,
  public.daily_values, public.calc_snapshots, public.people, public.debt_entries, public.audit_log,
  public.save_requests, public.restore_events to service_role;

grant usage on schema ledger_private to authenticated, ledger_writer;
grant usage on schema public to ledger_writer;

-- Versioned, idempotent cloud synchronization protocol.

-- ---------------------------------------------------------------------------
-- Stable aggregate identities and optimistic versions.
-- ---------------------------------------------------------------------------

alter table public.races add column if not exists client_key text;
alter table public.races add column if not exists sync_version bigint not null default 1;
alter table public.races add column if not exists sync_updated_at timestamptz not null default now();
alter table public.races add column if not exists last_mutation_id uuid;
alter table public.races add column if not exists client_record jsonb;

update public.races
set client_key = id::text
where client_key is null;

-- Keep a complete client-facing aggregate alongside the normalized relational
-- rows. Existing installations are initialized from their canonical data.
update public.races r
set client_record = coalesce(public.build_race_record(r.id), '{}'::jsonb)
where r.client_record is null
   or jsonb_typeof(r.client_record) <> 'object';

alter table public.races alter column client_key set not null;
alter table public.races alter column client_record set default '{}'::jsonb;
alter table public.races alter column client_record set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.races'::regclass
      and conname = 'races_client_key_shape'
  ) then
    alter table public.races
      add constraint races_client_key_shape
      check (char_length(btrim(client_key)) between 1 and 160) not valid;
  end if;
  alter table public.races validate constraint races_client_key_shape;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.races'::regclass
      and conname = 'races_sync_version_positive'
  ) then
    alter table public.races
      add constraint races_sync_version_positive
      check (sync_version > 0) not valid;
  end if;
  alter table public.races validate constraint races_sync_version_positive;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.races'::regclass
      and conname = 'races_client_record_object'
  ) then
    alter table public.races
      add constraint races_client_record_object
      check (jsonb_typeof(client_record) = 'object') not valid;
  end if;
  alter table public.races validate constraint races_client_record_object;
end
$$;

create unique index if not exists races_user_client_key_uidx
  on public.races(user_id, client_key);
create index if not exists races_user_sync_updated_idx
  on public.races(user_id, sync_updated_at desc);

alter table public.prediction_rule_sets
  add column if not exists sync_version bigint not null default 1;
alter table public.prediction_rule_versions
  add column if not exists client_key text;
alter table public.prediction_rule_versions
  add column if not exists semantic_version text;
alter table public.prediction_rule_versions
  add column if not exists sync_version bigint not null default 1;
alter table public.prediction_rule_versions
  add column if not exists sync_updated_at timestamptz not null default now();
alter table public.prediction_rule_versions
  add column if not exists last_mutation_id uuid;

update public.prediction_rule_versions
set client_key = id::text
where client_key is null;

update public.prediction_rule_versions
set semantic_version = coalesce(
  nullif(parameters ->> 'semantic_version', ''),
  version_number::text
)
where semantic_version is null;

-- Preserve every legacy row if semantic_version was previously duplicated.
-- A row UUID provides a deterministic base. The collision retry suffix also
-- avoids colliding with an arbitrary pre-existing value that happens to use
-- the same legacy namespace.
do $$
declare
  v_row record;
  v_candidate text;
  v_attempt integer;
begin
  for v_row in
    select
      id,
      user_id,
      rule_set_id,
      row_number() over (
        partition by user_id, rule_set_id, semantic_version
        order by version_number, created_at, id
      ) as position
    from public.prediction_rule_versions
    order by user_id, rule_set_id, semantic_version, version_number, created_at, id
  loop
    if v_row.position > 1 then
      v_attempt := 0;
      loop
        v_candidate := 'legacy-' || replace(v_row.id::text, '-', '');
        if v_attempt > 0 then
          v_candidate := v_candidate || '-' || v_attempt::text;
        end if;

        exit when not exists (
          select 1
          from public.prediction_rule_versions existing
          where existing.user_id = v_row.user_id
            and existing.rule_set_id = v_row.rule_set_id
            and existing.id <> v_row.id
            and existing.semantic_version = v_candidate
        );
        v_attempt := v_attempt + 1;
      end loop;

      update public.prediction_rule_versions
      set semantic_version = v_candidate
      where id = v_row.id;
    end if;
  end loop;
end
$$;

alter table public.prediction_rule_versions alter column client_key set not null;
alter table public.prediction_rule_versions alter column semantic_version set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.prediction_rule_versions'::regclass
      and conname = 'prediction_rule_versions_client_key_shape'
  ) then
    alter table public.prediction_rule_versions
      add constraint prediction_rule_versions_client_key_shape
      check (char_length(btrim(client_key)) between 1 and 160) not valid;
  end if;
  alter table public.prediction_rule_versions
    validate constraint prediction_rule_versions_client_key_shape;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.prediction_rule_versions'::regclass
      and conname = 'prediction_rule_versions_semantic_version_shape'
  ) then
    alter table public.prediction_rule_versions
      add constraint prediction_rule_versions_semantic_version_shape
      check (char_length(btrim(semantic_version)) between 1 and 120) not valid;
  end if;
  alter table public.prediction_rule_versions
    validate constraint prediction_rule_versions_semantic_version_shape;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.prediction_rule_versions'::regclass
      and conname = 'prediction_rule_versions_sync_version_positive'
  ) then
    alter table public.prediction_rule_versions
      add constraint prediction_rule_versions_sync_version_positive
      check (sync_version > 0) not valid;
  end if;
  alter table public.prediction_rule_versions
    validate constraint prediction_rule_versions_sync_version_positive;
end
$$;

create unique index if not exists prediction_rule_versions_user_client_key_uidx
  on public.prediction_rule_versions(user_id, client_key);
create unique index if not exists prediction_rule_versions_user_semver_uidx
  on public.prediction_rule_versions(user_id, rule_set_id, semantic_version);

-- Existing schemas defaulted every newly-created rule set to active. Normalize
-- that legacy state before enforcing one active set per user.
with ranked as (
  select id,
         row_number() over (
           partition by user_id
           order by updated_at desc, created_at desc, id
         ) as position
  from public.prediction_rule_sets
  where is_active
)
update public.prediction_rule_sets rs
set is_active = false
from ranked r
where rs.id = r.id and r.position > 1;

create unique index if not exists prediction_rule_sets_one_active_per_user_uidx
  on public.prediction_rule_sets(user_id)
  where is_active;

-- ---------------------------------------------------------------------------
-- Synchronization state.
-- ---------------------------------------------------------------------------

create table if not exists public.sync_devices (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  installation_id uuid not null,
  label text,
  platform text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_ack_change_seq bigint not null default 0,
  revoked_at timestamptz,
  unique (user_id, installation_id),
  unique (user_id, id),
  constraint sync_devices_label_length check (label is null or char_length(label) <= 120),
  constraint sync_devices_ack_nonnegative check (last_ack_change_seq >= 0)
);

create table if not exists public.user_settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  active_rule_version_id uuid,
  preferences jsonb not null default '{}'::jsonb,
  sync_version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, active_rule_version_id),
  constraint user_settings_preferences_object check (jsonb_typeof(preferences) = 'object'),
  constraint user_settings_sync_version_positive check (sync_version > 0),
  constraint user_settings_active_rule_owner_fk
    foreign key (user_id, active_rule_version_id)
    references public.prediction_rule_versions(user_id, id)
    on delete no action deferrable initially deferred
);

create table if not exists public.sync_mutation_receipts (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  mutation_id uuid not null,
  device_id uuid not null,
  operation text not null,
  request_sha256 bytea not null,
  entity_type text not null,
  entity_id uuid,
  entity_client_key text,
  resulting_version bigint,
  change_seq bigint,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, mutation_id),
  constraint sync_receipts_user_device_fk
    foreign key (user_id, device_id)
    references public.sync_devices(user_id, id)
    on delete cascade,
  constraint sync_receipts_hash_shape check (octet_length(request_sha256) = 32),
  constraint sync_receipts_response_object check (jsonb_typeof(response) = 'object'),
  constraint sync_receipts_version_positive check (
    resulting_version is null or resulting_version > 0
  )
);

create table if not exists public.sync_change_log (
  change_seq bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  mutation_id uuid not null,
  device_id uuid not null,
  entity_type text not null,
  entity_id uuid not null,
  entity_client_key text,
  operation text not null,
  record_version bigint not null,
  changed_at timestamptz not null default now(),
  unique (user_id, mutation_id, entity_type, entity_id),
  constraint sync_change_log_user_device_fk
    foreign key (user_id, device_id)
    references public.sync_devices(user_id, id)
    on delete cascade,
  constraint sync_change_log_operation check (operation in ('upsert', 'delete', 'activate')),
  constraint sync_change_log_version_positive check (record_version > 0)
);

-- Carry the legacy active-set flag into the versioned settings row. Prefer the
-- latest published version in the one retained active set.
insert into public.user_settings (user_id, active_rule_version_id, preferences, sync_version)
select
  rs.user_id,
  rv.id,
  jsonb_build_object('activeRuleVersionId', rv.client_key),
  1
from public.prediction_rule_sets rs
join lateral (
  select v.id, v.client_key
  from public.prediction_rule_versions v
  where v.user_id = rs.user_id
    and v.rule_set_id = rs.id
    and v.status = 'published'
  order by v.version_number desc, v.created_at desc, v.id
  limit 1
) rv on true
where rs.is_active
on conflict (user_id) do nothing;

create index if not exists sync_devices_user_seen_idx
  on public.sync_devices(user_id, last_seen_at desc);
create index if not exists sync_change_log_user_sequence_idx
  on public.sync_change_log(user_id, change_seq);
create index if not exists sync_receipts_user_created_idx
  on public.sync_mutation_receipts(user_id, created_at desc);

-- Supabase Realtime is only a wake-up signal; clients still fetch and verify
-- the versioned RPC snapshot. Keep generic PostgreSQL installs compatible when
-- the managed publication does not exist.
do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'sync_change_log'
  ) then
    alter publication supabase_realtime add table public.sync_change_log;
  end if;
end;
$$;

create trigger user_settings_updated_at
before update on public.user_settings
for each row execute function public.set_updated_at();

create trigger sync_devices_protect_user_id
before update of user_id on public.sync_devices
for each row execute function public.protect_user_id();
create trigger user_settings_protect_user_id
before update of user_id on public.user_settings
for each row execute function public.protect_user_id();
create trigger sync_mutation_receipts_protect_user_id
before update of user_id on public.sync_mutation_receipts
for each row execute function public.protect_user_id();
create trigger sync_change_log_protect_user_id
before update of user_id on public.sync_change_log
for each row execute function public.protect_user_id();

create or replace function public.protect_sync_append_only_row()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and auth.uid() is null then
    return old;
  end if;
  raise exception using
    errcode = '55000',
    message = format('%s is append-only', tg_table_name);
end;
$$;

create trigger sync_mutation_receipts_append_only
before update or delete on public.sync_mutation_receipts
for each row execute function public.protect_sync_append_only_row();
create trigger sync_change_log_append_only
before update or delete on public.sync_change_log
for each row execute function public.protect_sync_append_only_row();

alter table public.sync_devices enable row level security;
alter table public.user_settings enable row level security;
alter table public.sync_mutation_receipts enable row level security;
alter table public.sync_change_log enable row level security;

create policy sync_devices_self_read on public.sync_devices
for select to authenticated
using (user_id = (select auth.uid()));

create policy user_settings_self_read on public.user_settings
for select to authenticated
using (user_id = (select auth.uid()));

create policy sync_mutation_receipts_self_read on public.sync_mutation_receipts
for select to authenticated
using (user_id = (select auth.uid()));

create policy sync_change_log_self_read on public.sync_change_log
for select to authenticated
using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Read helpers.
-- ---------------------------------------------------------------------------

create or replace function public.build_synced_race_record(p_race_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with source as (
    select
      r.*,
      coalesce(public.build_race_record(r.id), '{}'::jsonb) as canonical_record
    from public.races r
    where r.id = p_race_id
      and r.user_id = auth.uid()
  ), merged as (
    select
      s.canonical_record,
      s.canonical_record
        || coalesce(s.client_record, '{}'::jsonb)
        || jsonb_build_object(
          'client_key', s.client_key,
          'sync_version', s.sync_version,
          'sync_updated_at', s.sync_updated_at
        ) as record
    from source s
  )
  select case
    when jsonb_typeof(m.canonical_record -> 'prediction') = 'object' then
      jsonb_set(
        m.record,
        '{prediction}',
        case
          when jsonb_typeof(m.record -> 'prediction') = 'object'
            then m.record -> 'prediction'
          else '{}'::jsonb
        end || jsonb_build_object(
          'status', m.canonical_record #> '{prediction,status}',
          'effective_status', m.canonical_record #> '{prediction,effective_status}',
          'locked_at', m.canonical_record #> '{prediction,locked_at}'
        ),
        true
      )
    else m.record
  end
  from merged m;
$$;

create or replace function public.build_synced_rule_record(p_rule_version_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', rv.id,
    'client_key', rv.client_key,
    'sync_version', rv.sync_version,
    'semantic_version', rv.semantic_version,
    'version_number', rv.version_number,
    'status', rv.status,
    'content', rv.content,
    'parameters', rv.parameters,
    'change_note', rv.change_note,
    'published_at', rv.published_at,
    'created_at', rv.created_at,
    'updated_at', rv.updated_at,
    'rule_set', jsonb_build_object(
      'id', rs.id,
      'name', rs.name,
      'description', rs.description,
      'is_active', rs.is_active
    )
  )
  from public.prediction_rule_versions rv
  join public.prediction_rule_sets rs
    on rs.user_id = rv.user_id and rs.id = rv.rule_set_id
  where rv.id = p_rule_version_id
    and rv.user_id = auth.uid();
$$;

create or replace function public.get_sync_changes(
  p_after_change_seq bigint default 0,
  p_limit integer default 200
)
returns table (
  change_seq bigint,
  entity_type text,
  entity_id uuid,
  client_key text,
  operation text,
  record_version bigint,
  changed_at timestamptz,
  record jsonb
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    c.change_seq,
    c.entity_type,
    c.entity_id,
    c.entity_client_key,
    c.operation,
    c.record_version,
    c.changed_at,
    case c.entity_type
      when 'race' then public.build_synced_race_record(c.entity_id)
      when 'rule_version' then public.build_synced_rule_record(c.entity_id)
      when 'user_settings' then (
        select jsonb_build_object(
          'user_id', s.user_id,
          'active_rule_version_id', s.active_rule_version_id,
          'preferences', s.preferences,
          'sync_version', s.sync_version,
          'updated_at', s.updated_at
        )
        from public.user_settings s
        where s.user_id = auth.uid()
      )
      else null
    end
  from public.sync_change_log c
  where c.user_id = auth.uid()
    and c.change_seq > greatest(coalesce(p_after_change_seq, 0), 0)
  order by c.change_seq
  limit least(greatest(coalesce(p_limit, 200), 1), 1000);
$$;

create or replace function public.get_sync_bootstrap()
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'races', coalesce((
      select jsonb_agg(
        public.build_synced_race_record(r.id)
        order by r.starts_at desc, r.id
      )
      from public.races r
      where r.user_id = auth.uid()
    ), '[]'::jsonb),
    'rules', coalesce((
      select jsonb_agg(
        public.build_synced_rule_record(rv.id)
        order by rv.created_at desc, rv.id
      )
      from public.prediction_rule_versions rv
      where rv.user_id = auth.uid()
    ), '[]'::jsonb),
    'settings', (
      select jsonb_build_object(
        'user_id', s.user_id,
        'preferences', s.preferences,
        'active_rule_version_id', s.active_rule_version_id,
        'sync_version', s.sync_version,
        'updated_at', s.updated_at
      )
      from public.user_settings s
      where s.user_id = auth.uid()
    ),
    'latest_change_seq', coalesce((
      select max(c.change_seq)
      from public.sync_change_log c
      where c.user_id = auth.uid()
    ), 0)
  );
$$;

-- ---------------------------------------------------------------------------
-- Device registration.
-- ---------------------------------------------------------------------------

create or replace function public.register_sync_device(
  p_installation_id uuid,
  p_label text default null,
  p_platform text default null
)
returns public.sync_devices
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_device public.sync_devices;
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;
  if p_installation_id is null then
    raise exception using errcode = '22023', message = 'installation_id is required';
  end if;

  insert into public.sync_devices (
    user_id, installation_id, label, platform, last_seen_at
  ) values (
    v_user_id,
    p_installation_id,
    nullif(btrim(p_label), ''),
    nullif(btrim(p_platform), ''),
    now()
  )
  on conflict (user_id, installation_id) do update
  set label = coalesce(excluded.label, sync_devices.label),
      platform = coalesce(excluded.platform, sync_devices.platform),
      last_seen_at = now()
  where sync_devices.revoked_at is null
  returning * into v_device;

  if not found then
    raise exception using errcode = '42501', message = 'Sync device is revoked';
  end if;
  return v_device;
end;
$$;

-- ---------------------------------------------------------------------------
-- Race aggregate sync. A conflict response performs no write. A mutation ID
-- replay returns the original committed response with status='replayed'.
-- ---------------------------------------------------------------------------

create or replace function public.sync_race_record(
  p_payload jsonb,
  p_expected_version bigint,
  p_mutation_id uuid,
  p_installation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_client_key text;
  v_request_hash bytea;
  v_receipt public.sync_mutation_receipts%rowtype;
  v_device public.sync_devices%rowtype;
  v_race_id uuid;
  v_natural_race_id uuid;
  v_natural_version bigint;
  v_natural_client_key text;
  v_payload_id uuid;
  v_payload_id_text text;
  v_current_version bigint;
  v_current_client_key text;
  v_current_record jsonb;
  v_saved_record jsonb;
  v_legacy_result jsonb;
  v_effective_payload jsonb;
  v_existing_client_record jsonb := '{}'::jsonb;
  v_client_record jsonb;
  v_existing_prediction_locked boolean := false;
  v_defer_post_time_prediction boolean := false;
  v_payload_starts_at timestamptz;
  v_effective_starts_at timestamptz;
  v_change_seq bigint;
  v_response jsonb;
  v_course_key text;
  v_meeting_date date;
  v_meeting_number smallint;
  v_race_number smallint;
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'payload must be an object';
  end if;
  if p_expected_version is null or p_expected_version < 0 then
    raise exception using errcode = '22023', message = 'expected_version must be non-negative';
  end if;
  if p_mutation_id is null or p_installation_id is null then
    raise exception using errcode = '22023', message = 'mutation_id and installation_id are required';
  end if;

  v_client_key := nullif(btrim(coalesce(p_payload ->> 'client_key', p_payload ->> 'id')), '');
  if v_client_key is null or char_length(v_client_key) > 160 then
    raise exception using errcode = '22023', message = 'A valid client_key is required';
  end if;

  v_request_hash := extensions.digest(
    jsonb_build_object(
      'operation', 'sync_race_record',
      'payload', p_payload,
      'expected_version', p_expected_version,
      'installation_id', p_installation_id
    )::text,
    'sha256'
  );

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':mutation:' || p_mutation_id::text, 0));
  select * into v_receipt
  from public.sync_mutation_receipts
  where user_id = v_user_id and mutation_id = p_mutation_id;

  if found then
    if v_receipt.operation <> 'sync_race_record'
       or v_receipt.request_sha256 <> v_request_hash then
      raise exception using
        errcode = '22023',
        message = 'mutation_id was already used with a different request';
    end if;
    return v_receipt.response || jsonb_build_object('status', 'replayed');
  end if;

  -- Same aggregate and same natural race identity are serialized even when two
  -- devices accidentally use different mutation IDs.
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':race-client:' || v_client_key, 0));

  v_payload_id_text := p_payload ->> 'id';
  if v_payload_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    v_payload_id := v_payload_id_text::uuid;
    if exists (
      select 1 from public.races where id = v_payload_id and user_id <> v_user_id
    ) then
      raise exception using errcode = '42501', message = 'Race is not owned by the current user';
    end if;
  end if;

  select id, sync_version, client_key
  into v_race_id, v_current_version, v_current_client_key
  from public.races
  where user_id = v_user_id and client_key = v_client_key;

  if v_race_id is null and v_payload_id is not null then
    select id, sync_version, client_key
    into v_race_id, v_current_version, v_current_client_key
    from public.races
    where user_id = v_user_id and id = v_payload_id;
  end if;

  v_course_key := coalesce(
    p_payload #>> '{meeting,racecourse,code}',
    p_payload #>> '{meeting,racecourse_code}',
    p_payload ->> 'racecourse_code',
    p_payload ->> 'venue'
  );
  v_meeting_date := coalesce(
    nullif(p_payload #>> '{meeting,meeting_date}', '')::date,
    nullif(p_payload ->> 'race_date', '')::date,
    nullif(p_payload ->> 'date', '')::date
  );
  v_meeting_number := coalesce(
    nullif(p_payload #>> '{meeting,meeting_number}', '')::smallint,
    1
  );
  v_race_number := coalesce(
    nullif(p_payload #>> '{race,race_number}', '')::smallint,
    nullif(p_payload ->> 'race_number', '')::smallint,
    nullif(p_payload ->> 'race_no', '')::smallint
  );
  v_payload_starts_at := nullif(p_payload #>> '{race,starts_at}', '')::timestamptz;
  v_effective_starts_at := v_payload_starts_at;

  if v_course_key is not null and v_meeting_date is not null and v_race_number is not null then
    perform pg_advisory_xact_lock(hashtextextended(
      v_user_id::text || ':race-natural:' || upper(v_course_key) || ':' ||
      v_meeting_date::text || ':' || v_meeting_number::text || ':' || v_race_number::text,
      0
    ));

    select r.id, r.sync_version, r.client_key
    into v_natural_race_id, v_natural_version, v_natural_client_key
    from public.races r
    join public.race_meetings m
      on m.user_id = r.user_id and m.id = r.meeting_id
    join public.racecourses c on c.id = m.racecourse_id
    where r.user_id = v_user_id
      and m.meeting_date = v_meeting_date
      and m.meeting_number = v_meeting_number
      and r.race_number = v_race_number
      and (c.code = upper(v_course_key) or c.name_ja = v_course_key)
    for update of r;

    if v_race_id is null and v_natural_race_id is not null then
      if v_natural_client_key <> v_client_key then
        v_current_record := public.build_synced_race_record(v_natural_race_id);
        return jsonb_build_object(
          'status', 'conflict',
          'current', v_current_record,
          'current_version', v_natural_version,
          'reason', 'natural_key_exists'
        );
      end if;
      v_race_id := v_natural_race_id;
      v_current_version := v_natural_version;
      v_current_client_key := v_natural_client_key;
    elsif v_race_id is not null and v_natural_race_id is not null
          and v_natural_race_id <> v_race_id then
      v_current_record := public.build_synced_race_record(v_race_id);
      return jsonb_build_object(
        'status', 'conflict',
        'current', v_current_record,
        'current_version', v_current_version,
        'reason', 'identity_collision'
      );
    end if;
  end if;

  -- Refresh the version under a row lock only after the natural-identity lock.
  -- This lock order avoids a client-key/natural-key deadlock between devices.
  if v_race_id is not null then
    select sync_version, client_key, client_record, starts_at
    into v_current_version, v_current_client_key, v_existing_client_record,
         v_effective_starts_at
    from public.races
    where id = v_race_id and user_id = v_user_id
    for update;
    if not found then
      v_race_id := null;
      v_current_version := null;
      v_current_client_key := null;
      v_existing_client_record := '{}'::jsonb;
    end if;
  end if;

  v_defer_post_time_prediction :=
    jsonb_typeof(p_payload -> 'prediction') = 'object'
    and v_effective_starts_at is not null
    and clock_timestamp() >= v_effective_starts_at;

  if v_race_id is null then
    if p_expected_version <> 0 then
      return jsonb_build_object(
        'status', 'conflict',
        'current', null,
        'current_version', null,
        'reason', 'record_not_found'
      );
    end if;
  else
    if v_current_client_key <> v_client_key
       and v_current_client_key <> v_race_id::text then
      v_current_record := public.build_synced_race_record(v_race_id);
      return jsonb_build_object(
        'status', 'conflict',
        'current', v_current_record,
        'current_version', v_current_version,
        'reason', 'client_key_mismatch'
      );
    end if;
    if p_expected_version <> v_current_version then
      v_current_record := public.build_synced_race_record(v_race_id);
      return jsonb_build_object(
        'status', 'conflict',
        'current', v_current_record,
        'current_version', v_current_version,
        'reason', 'version_mismatch'
      );
    end if;
  end if;

  if v_race_id is not null then
    select exists (
      select 1
      from public.predictions p
      join public.races r
        on r.user_id = p.user_id and r.id = p.race_id
      where p.user_id = v_user_id
        and p.race_id = v_race_id
        and (p.status = 'locked' or clock_timestamp() >= r.starts_at)
    ) into v_existing_prediction_locked;
  end if;

  v_device := public.register_sync_device(p_installation_id);
  v_effective_payload := p_payload || jsonb_build_object('client_key', v_client_key);
  if v_race_id is not null then
    v_effective_payload := v_effective_payload || jsonb_build_object('id', v_race_id);
  else
    v_effective_payload := v_effective_payload - 'id';
  end if;

  -- A lock freezes the canonical prediction evidence, not the user's current
  -- working copy. The current prediction/proposals remain in client_record,
  -- while the legacy relational writer receives only still-mutable sections.
  if v_existing_prediction_locked or v_defer_post_time_prediction then
    v_effective_payload := v_effective_payload - 'prediction';
    if v_effective_payload ? 'bet_slips'
       and jsonb_typeof(v_effective_payload -> 'bet_slips') = 'array' then
      v_effective_payload := jsonb_set(
        v_effective_payload,
        '{bet_slips}',
        coalesce((
          select jsonb_agg(item.value order by item.ordinality)
          from jsonb_array_elements(v_effective_payload -> 'bet_slips')
            with ordinality as item(value, ordinality)
          where item.value ->> 'kind' = 'actual'
        ), '[]'::jsonb),
        true
      );
    end if;
  end if;

  -- The legacy aggregate writer remains an internal implementation detail. It
  -- executes as this function's owner, after explicit tenant/version checks.
  v_legacy_result := public.upsert_race_record(v_effective_payload);
  v_race_id := (v_legacy_result ->> 'id')::uuid;

  if not exists (
    select 1 from public.races where id = v_race_id and user_id = v_user_id
  ) then
    raise exception using errcode = '42501', message = 'Aggregate writer returned a foreign race';
  end if;

  -- A prediction first delivered after post time is retained as current client
  -- data. If it was explicitly locked before post, 0005 stores its client
  -- snapshot in a separate immutable, source-labelled evidence table. Dynamic
  -- dispatch keeps this migration independently installable before 0005.
  if v_defer_post_time_prediction
     and p_payload #>> '{prediction,status}' = 'locked'
     and jsonb_typeof(p_payload #> '{prediction,locked_snapshot}') = 'object'
     and nullif(p_payload #>> '{prediction,locked_at}', '') is not null then
    execute
      'select public.store_offline_prediction_lock($1, $2, $3, $4)'
      using v_race_id, p_payload, p_mutation_id, v_device.id;
  end if;

  -- The browser payload is never an ownership source. Server-owned identity and
  -- sync metadata are derived from the authenticated races row instead.
  v_client_record := (
    coalesce(public.build_race_record(v_race_id), '{}'::jsonb)
    || coalesce(v_existing_client_record, '{}'::jsonb)
    || (
      p_payload
      - 'user_id'
      - 'owner_id'
      - 'change_source'
      - 'sync_version'
      - 'sync_updated_at'
      - 'last_mutation_id'
    )
    || jsonb_build_object(
      'id', v_race_id,
      'client_key', v_client_key
    )
  ) - 'user_id' - 'owner_id';

  update public.races
  set client_key = v_client_key,
      client_record = v_client_record,
      sync_version = case
        when p_expected_version = 0 then sync_version
        else sync_version + 1
      end,
      sync_updated_at = clock_timestamp(),
      last_mutation_id = p_mutation_id
  where id = v_race_id and user_id = v_user_id
  returning sync_version into v_current_version;

  insert into public.sync_change_log (
    user_id, mutation_id, device_id, entity_type, entity_id,
    entity_client_key, operation, record_version
  ) values (
    v_user_id, p_mutation_id, v_device.id, 'race', v_race_id,
    v_client_key, 'upsert', v_current_version
  )
  returning change_seq into v_change_seq;

  v_saved_record := public.build_synced_race_record(v_race_id);
  v_response := jsonb_build_object(
    'status', 'applied',
    'record', v_saved_record,
    'version', v_current_version,
    'change_seq', v_change_seq
  );

  insert into public.sync_mutation_receipts (
    user_id, mutation_id, device_id, operation, request_sha256,
    entity_type, entity_id, entity_client_key, resulting_version,
    change_seq, response
  ) values (
    v_user_id, p_mutation_id, v_device.id, 'sync_race_record', v_request_hash,
    'race', v_race_id, v_client_key, v_current_version,
    v_change_seq, v_response
  );

  return v_response;
end;
$$;

-- ---------------------------------------------------------------------------
-- User preferences sync. Active-rule selection shares the same version row so
-- a preference write cannot silently overwrite a concurrent activation.
-- ---------------------------------------------------------------------------

create or replace function public.sync_user_settings(
  p_preferences jsonb,
  p_expected_version bigint,
  p_mutation_id uuid,
  p_installation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_request_hash bytea;
  v_receipt public.sync_mutation_receipts%rowtype;
  v_device public.sync_devices%rowtype;
  v_current_version bigint;
  v_current_active_rule_version_id uuid;
  v_active_key_present boolean := false;
  v_active_rule_client_key text;
  v_active_rule_version_id uuid;
  v_active_rule_set_id uuid;
  v_record jsonb;
  v_change_seq bigint;
  v_response jsonb;
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;
  if p_preferences is null or jsonb_typeof(p_preferences) <> 'object'
     or p_expected_version is null or p_expected_version < 0
     or p_mutation_id is null or p_installation_id is null then
    raise exception using errcode = '22023', message = 'Invalid sync_user_settings request';
  end if;
  v_active_key_present := p_preferences ? 'activeRuleVersionId'
    or p_preferences ? 'active_rule_version_id';
  if p_preferences ? 'activeRuleVersionId'
     and p_preferences ? 'active_rule_version_id'
     and p_preferences -> 'activeRuleVersionId'
       is distinct from p_preferences -> 'active_rule_version_id' then
    raise exception using
      errcode = '22023',
      message = 'activeRuleVersionId aliases must have the same value';
  end if;
  if v_active_key_present then
    if coalesce(
      jsonb_typeof(p_preferences -> 'activeRuleVersionId'),
      jsonb_typeof(p_preferences -> 'active_rule_version_id')
    ) not in ('string', 'null') then
      raise exception using
        errcode = '22023',
        message = 'activeRuleVersionId must be a client_key string or null';
    end if;
    v_active_rule_client_key := coalesce(
      p_preferences ->> 'activeRuleVersionId',
      p_preferences ->> 'active_rule_version_id'
    );
    if v_active_rule_client_key is not null then
      v_active_rule_client_key := nullif(btrim(v_active_rule_client_key), '');
      if v_active_rule_client_key is null then
        raise exception using
          errcode = '22023',
          message = 'activeRuleVersionId cannot be blank';
      end if;
    end if;
  end if;

  v_request_hash := extensions.digest(jsonb_build_object(
    'operation', 'sync_user_settings',
    'preferences', p_preferences,
    'expected_version', p_expected_version,
    'installation_id', p_installation_id
  )::text, 'sha256');

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':mutation:' || p_mutation_id::text, 0));
  select * into v_receipt
  from public.sync_mutation_receipts
  where user_id = v_user_id and mutation_id = p_mutation_id;
  if found then
    if v_receipt.operation <> 'sync_user_settings'
       or v_receipt.request_sha256 <> v_request_hash then
      raise exception using errcode = '22023', message = 'mutation_id was already used with a different request';
    end if;
    return v_receipt.response || jsonb_build_object('status', 'replayed');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':user-settings', 0));
  select sync_version, active_rule_version_id
  into v_current_version, v_current_active_rule_version_id
  from public.user_settings
  where user_id = v_user_id
  for update;

  if not found then
    if p_expected_version <> 0 then
      return jsonb_build_object(
        'status', 'conflict', 'current', null, 'current_version', null,
        'reason', 'settings_not_found'
      );
    end if;
  elsif p_expected_version <> v_current_version then
    select jsonb_build_object(
      'user_id', user_id,
      'preferences', preferences,
      'active_rule_version_id', active_rule_version_id,
      'sync_version', sync_version,
      'updated_at', updated_at
    ) into v_record
    from public.user_settings where user_id = v_user_id;
    return jsonb_build_object(
      'status', 'conflict', 'current', v_record,
      'current_version', v_current_version, 'reason', 'version_mismatch'
    );
  end if;

  if v_active_key_present and v_active_rule_client_key is not null then
    select rv.id, rv.rule_set_id
    into v_active_rule_version_id, v_active_rule_set_id
    from public.prediction_rule_versions rv
    where rv.user_id = v_user_id
      and rv.client_key = v_active_rule_client_key
      and rv.status = 'published';
    if not found then
      if v_current_version is not null then
        select jsonb_build_object(
          'user_id', user_id,
          'preferences', preferences,
          'active_rule_version_id', active_rule_version_id,
          'sync_version', sync_version,
          'updated_at', updated_at
        ) into v_record
        from public.user_settings where user_id = v_user_id;
      end if;
      return jsonb_build_object(
        'status', 'conflict',
        'current', v_record,
        'current_version', v_current_version,
        'reason', 'active_rule_not_found',
        'requested_client_key', v_active_rule_client_key
      );
    end if;
  elsif not v_active_key_present then
    v_active_rule_version_id := v_current_active_rule_version_id;
  end if;

  v_device := public.register_sync_device(p_installation_id);
  if v_active_key_present then
    update public.prediction_rule_sets
    set is_active = false
    where user_id = v_user_id and is_active;
    if v_active_rule_set_id is not null then
      update public.prediction_rule_sets
      set is_active = true
      where user_id = v_user_id and id = v_active_rule_set_id;
    end if;
  end if;

  insert into public.user_settings (
    user_id, preferences, active_rule_version_id, sync_version
  )
  values (v_user_id, p_preferences, v_active_rule_version_id, 1)
  on conflict (user_id) do update
  set preferences = excluded.preferences,
      active_rule_version_id = case
        when v_active_key_present then excluded.active_rule_version_id
        else user_settings.active_rule_version_id
      end,
      sync_version = user_settings.sync_version + 1
  returning sync_version into v_current_version;

  insert into public.sync_change_log (
    user_id, mutation_id, device_id, entity_type, entity_id,
    entity_client_key, operation, record_version
  ) values (
    v_user_id, p_mutation_id, v_device.id, 'user_settings', v_user_id,
    null, 'upsert', v_current_version
  ) returning change_seq into v_change_seq;

  select jsonb_build_object(
    'user_id', user_id,
    'preferences', preferences,
    'active_rule_version_id', active_rule_version_id,
    'sync_version', sync_version,
    'updated_at', updated_at
  ) into v_record
  from public.user_settings where user_id = v_user_id;

  v_response := jsonb_build_object(
    'status', 'applied', 'record', v_record,
    'version', v_current_version, 'change_seq', v_change_seq
  );
  insert into public.sync_mutation_receipts (
    user_id, mutation_id, device_id, operation, request_sha256,
    entity_type, entity_id, entity_client_key, resulting_version,
    change_seq, response
  ) values (
    v_user_id, p_mutation_id, v_device.id, 'sync_user_settings', v_request_hash,
    'user_settings', v_user_id, null, v_current_version,
    v_change_seq, v_response
  );
  return v_response;
end;
$$;

-- ---------------------------------------------------------------------------
-- Immutable rule-version sync and atomic active-rule selection.
-- ---------------------------------------------------------------------------

create or replace function public.sync_rule_version(
  p_payload jsonb,
  p_expected_version bigint,
  p_mutation_id uuid,
  p_installation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_client_key text;
  v_name text;
  v_semantic_version text;
  v_content text;
  v_parameters jsonb;
  v_request_hash bytea;
  v_receipt public.sync_mutation_receipts%rowtype;
  v_device public.sync_devices%rowtype;
  v_rule_set_id uuid;
  v_named_rule_set_id uuid;
  v_rule_version_id uuid;
  v_semantic_rule_version_id uuid;
  v_current_version bigint;
  v_status public.rule_version_status;
  v_existing_name text;
  v_existing_content text;
  v_existing_parameters jsonb;
  v_version_number integer;
  v_record jsonb;
  v_conflicting_record jsonb;
  v_change_seq bigint;
  v_response jsonb;
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or p_mutation_id is null or p_installation_id is null
     or p_expected_version is null or p_expected_version < 0 then
    raise exception using errcode = '22023', message = 'Invalid sync_rule_version request';
  end if;
  if p_payload ? 'rules' and jsonb_typeof(p_payload -> 'rules') <> 'array' then
    raise exception using errcode = '22023', message = 'rules must be an array';
  end if;
  if p_payload ? 'parameters' and jsonb_typeof(p_payload -> 'parameters') <> 'object' then
    raise exception using errcode = '22023', message = 'parameters must be an object';
  end if;

  v_client_key := nullif(btrim(coalesce(p_payload ->> 'client_key', p_payload ->> 'id')), '');
  v_name := nullif(btrim(p_payload ->> 'name'), '');
  v_semantic_version := nullif(btrim(coalesce(
    p_payload ->> 'semantic_version',
    p_payload ->> 'version'
  )), '');
  v_content := coalesce(
    p_payload ->> 'content',
    (select string_agg(value #>> '{}', E'\n')
     from jsonb_array_elements(coalesce(p_payload -> 'rules', '[]'::jsonb)))
  );
  if v_client_key is null or char_length(v_client_key) > 160
     or v_name is null or v_semantic_version is null
     or v_content is null or btrim(v_content) = '' then
    raise exception using errcode = '22023', message = 'client_key, name, semantic_version, and content are required';
  end if;

  v_parameters := coalesce(p_payload -> 'parameters', '{}'::jsonb) || jsonb_build_object(
    'semantic_version', v_semantic_version,
    'display_name', v_name,
    'rules', coalesce(p_payload -> 'rules', to_jsonb(string_to_array(v_content, E'\n')))
  );
  v_request_hash := extensions.digest(jsonb_build_object(
    'operation', 'sync_rule_version',
    'payload', p_payload,
    'expected_version', p_expected_version,
    'installation_id', p_installation_id
  )::text, 'sha256');

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':mutation:' || p_mutation_id::text, 0));
  select * into v_receipt from public.sync_mutation_receipts
  where user_id = v_user_id and mutation_id = p_mutation_id;
  if found then
    if v_receipt.operation <> 'sync_rule_version'
       or v_receipt.request_sha256 <> v_request_hash then
      raise exception using errcode = '22023', message = 'mutation_id was already used with a different request';
    end if;
    return v_receipt.response || jsonb_build_object('status', 'replayed');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':rule:' || v_client_key, 0));
  perform pg_advisory_xact_lock(hashtextextended(
    v_user_id::text || ':rule-semver:' || v_name || ':' || v_semantic_version,
    0
  ));
  select rv.id, rv.rule_set_id, rv.sync_version, rv.status, rs.name,
         rv.content, rv.parameters
  into v_rule_version_id, v_rule_set_id, v_current_version, v_status,
       v_existing_name, v_existing_content, v_existing_parameters
  from public.prediction_rule_versions rv
  join public.prediction_rule_sets rs
    on rs.user_id = rv.user_id and rs.id = rv.rule_set_id
  where rv.user_id = v_user_id and rv.client_key = v_client_key
  for update of rv;

  if v_rule_version_id is not null and v_existing_name <> v_name then
    v_record := public.build_synced_rule_record(v_rule_version_id);
    return jsonb_build_object(
      'status', 'conflict', 'current', v_record,
      'current_version', v_current_version,
      'reason', 'rule_set_name_mismatch',
      'requested_name', v_name,
      'current_name', v_existing_name
    );
  end if;

  if v_rule_version_id is not null then
    select id into v_semantic_rule_version_id
    from public.prediction_rule_versions
    where user_id = v_user_id
      and rule_set_id = v_rule_set_id
      and semantic_version = v_semantic_version
      and id <> v_rule_version_id;
    if v_semantic_rule_version_id is not null then
      v_record := public.build_synced_rule_record(v_rule_version_id);
      v_conflicting_record := public.build_synced_rule_record(v_semantic_rule_version_id);
      return jsonb_build_object(
        'status', 'conflict', 'current', v_record,
        'current_version', v_current_version,
        'reason', 'semantic_version_exists',
        'requested_client_key', v_client_key,
        'conflicting_record', v_conflicting_record
      );
    end if;
  end if;

  if v_rule_version_id is null then
    select id into v_named_rule_set_id
    from public.prediction_rule_sets
    where user_id = v_user_id and name = v_name;
    if v_named_rule_set_id is not null then
      select id into v_semantic_rule_version_id
      from public.prediction_rule_versions
      where user_id = v_user_id
        and rule_set_id = v_named_rule_set_id
        and semantic_version = v_semantic_version;
      if v_semantic_rule_version_id is not null then
        v_record := public.build_synced_rule_record(v_semantic_rule_version_id);
        return jsonb_build_object(
          'status', 'conflict', 'current', v_record,
          'current_version', (v_record ->> 'sync_version')::bigint,
          'reason', 'semantic_version_exists'
        );
      end if;
    end if;
  end if;

  if v_rule_version_id is null and p_expected_version <> 0 then
    return jsonb_build_object(
      'status', 'conflict', 'current', null, 'current_version', null,
      'reason', 'record_not_found'
    );
  elsif v_rule_version_id is not null and p_expected_version <> v_current_version then
    v_record := public.build_synced_rule_record(v_rule_version_id);
    return jsonb_build_object(
      'status', 'conflict', 'current', v_record,
      'current_version', v_current_version, 'reason', 'version_mismatch'
    );
  elsif v_rule_version_id is not null and v_status <> 'draft'
        and (v_existing_content <> v_content or v_existing_parameters <> v_parameters) then
    v_record := public.build_synced_rule_record(v_rule_version_id);
    return jsonb_build_object(
      'status', 'conflict', 'current', v_record,
      'current_version', v_current_version, 'reason', 'immutable_rule_version'
    );
  end if;

  v_device := public.register_sync_device(p_installation_id);

  if v_rule_version_id is null then
    insert into public.prediction_rule_sets (
      owner_id, user_id, name, description, is_active
    ) values (
      v_user_id, v_user_id, v_name, p_payload ->> 'description', false
    )
    on conflict (owner_id, name) do update
    set description = coalesce(excluded.description, prediction_rule_sets.description)
    returning id into v_rule_set_id;

    perform pg_advisory_xact_lock(hashtextextended(v_rule_set_id::text || ':version', 0));
    select coalesce(max(version_number), 0) + 1
    into v_version_number
    from public.prediction_rule_versions
    where user_id = v_user_id and rule_set_id = v_rule_set_id;

    insert into public.prediction_rule_versions (
      user_id, rule_set_id, version_number, semantic_version, client_key,
      status, content, parameters, change_note, published_at,
      sync_version, sync_updated_at, last_mutation_id
    ) values (
      v_user_id, v_rule_set_id, v_version_number, v_semantic_version, v_client_key,
      coalesce(nullif(p_payload ->> 'status', '')::public.rule_version_status, 'published'),
      v_content, v_parameters, coalesce(p_payload ->> 'change_note', p_payload ->> 'note'),
      case when coalesce(p_payload ->> 'status', 'published') = 'published'
        then now() end,
      1, clock_timestamp(), p_mutation_id
    ) returning id, sync_version into v_rule_version_id, v_current_version;
  elsif v_status = 'draft' then
    update public.prediction_rule_versions
    set content = v_content,
        parameters = v_parameters,
        semantic_version = v_semantic_version,
        change_note = coalesce(p_payload ->> 'change_note', p_payload ->> 'note', change_note),
        status = coalesce(nullif(p_payload ->> 'status', '')::public.rule_version_status, status),
        sync_version = sync_version + 1,
        sync_updated_at = clock_timestamp(),
        last_mutation_id = p_mutation_id
    where id = v_rule_version_id and user_id = v_user_id
    returning sync_version into v_current_version;
  end if;

  insert into public.sync_change_log (
    user_id, mutation_id, device_id, entity_type, entity_id,
    entity_client_key, operation, record_version
  ) values (
    v_user_id, p_mutation_id, v_device.id, 'rule_version', v_rule_version_id,
    v_client_key, 'upsert', v_current_version
  ) returning change_seq into v_change_seq;

  v_record := public.build_synced_rule_record(v_rule_version_id);
  v_response := jsonb_build_object(
    'status', 'applied', 'record', v_record,
    'version', v_current_version, 'change_seq', v_change_seq
  );
  insert into public.sync_mutation_receipts (
    user_id, mutation_id, device_id, operation, request_sha256,
    entity_type, entity_id, entity_client_key, resulting_version,
    change_seq, response
  ) values (
    v_user_id, p_mutation_id, v_device.id, 'sync_rule_version', v_request_hash,
    'rule_version', v_rule_version_id, v_client_key, v_current_version,
    v_change_seq, v_response
  );
  return v_response;
end;
$$;

create or replace function public.activate_rule_version(
  p_rule_version_id uuid,
  p_expected_settings_version bigint,
  p_mutation_id uuid,
  p_installation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_request_hash bytea;
  v_receipt public.sync_mutation_receipts%rowtype;
  v_device public.sync_devices%rowtype;
  v_rule_set_id uuid;
  v_rule_client_key text;
  v_current_version bigint;
  v_change_seq bigint;
  v_record jsonb;
  v_response jsonb;
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;
  if p_rule_version_id is null or p_mutation_id is null or p_installation_id is null
     or p_expected_settings_version is null or p_expected_settings_version < 0 then
    raise exception using errcode = '22023', message = 'Invalid activate_rule_version request';
  end if;

  v_request_hash := extensions.digest(jsonb_build_object(
    'operation', 'activate_rule_version',
    'rule_version_id', p_rule_version_id,
    'expected_settings_version', p_expected_settings_version,
    'installation_id', p_installation_id
  )::text, 'sha256');
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':mutation:' || p_mutation_id::text, 0));
  select * into v_receipt from public.sync_mutation_receipts
  where user_id = v_user_id and mutation_id = p_mutation_id;
  if found then
    if v_receipt.operation <> 'activate_rule_version'
       or v_receipt.request_sha256 <> v_request_hash then
      raise exception using errcode = '22023', message = 'mutation_id was already used with a different request';
    end if;
    return v_receipt.response || jsonb_build_object('status', 'replayed');
  end if;

  select rule_set_id, client_key into v_rule_set_id, v_rule_client_key
  from public.prediction_rule_versions
  where id = p_rule_version_id and user_id = v_user_id and status = 'published';
  if v_rule_set_id is null then
    raise exception using errcode = '22023', message = 'Published rule version not found';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':user-settings', 0));
  select sync_version into v_current_version
  from public.user_settings
  where user_id = v_user_id
  for update;

  if not found then
    if p_expected_settings_version <> 0 then
      return jsonb_build_object(
        'status', 'conflict', 'current', null, 'current_version', null,
        'reason', 'settings_not_found'
      );
    end if;
  elsif p_expected_settings_version <> v_current_version then
    select jsonb_build_object(
      'user_id', user_id,
      'active_rule_version_id', active_rule_version_id,
      'preferences', preferences,
      'sync_version', sync_version,
      'updated_at', updated_at
    ) into v_record
    from public.user_settings where user_id = v_user_id;
    return jsonb_build_object(
      'status', 'conflict', 'current', v_record,
      'current_version', v_current_version, 'reason', 'version_mismatch'
    );
  end if;

  v_device := public.register_sync_device(p_installation_id);
  update public.prediction_rule_sets
  set is_active = false
  where user_id = v_user_id and is_active;
  update public.prediction_rule_sets
  set is_active = true
  where user_id = v_user_id and id = v_rule_set_id;

  insert into public.user_settings (
    user_id, active_rule_version_id, preferences, sync_version
  ) values (
    v_user_id,
    p_rule_version_id,
    jsonb_build_object('activeRuleVersionId', v_rule_client_key),
    1
  )
  on conflict (user_id) do update
  set active_rule_version_id = excluded.active_rule_version_id,
      preferences = jsonb_set(
        user_settings.preferences - 'active_rule_version_id',
        '{activeRuleVersionId}',
        to_jsonb(v_rule_client_key),
        true
      ),
      sync_version = user_settings.sync_version + 1
  returning sync_version into v_current_version;

  insert into public.sync_change_log (
    user_id, mutation_id, device_id, entity_type, entity_id,
    entity_client_key, operation, record_version
  ) values (
    v_user_id, p_mutation_id, v_device.id, 'user_settings', v_user_id,
    null, 'activate', v_current_version
  ) returning change_seq into v_change_seq;

  select jsonb_build_object(
    'user_id', user_id,
    'active_rule_version_id', active_rule_version_id,
    'preferences', preferences,
    'sync_version', sync_version,
    'updated_at', updated_at
  ) into v_record
  from public.user_settings where user_id = v_user_id;

  v_response := jsonb_build_object(
    'status', 'applied', 'record', v_record,
    'version', v_current_version, 'change_seq', v_change_seq
  );
  insert into public.sync_mutation_receipts (
    user_id, mutation_id, device_id, operation, request_sha256,
    entity_type, entity_id, entity_client_key, resulting_version,
    change_seq, response
  ) values (
    v_user_id, p_mutation_id, v_device.id, 'activate_rule_version', v_request_hash,
    'user_settings', v_user_id, null, v_current_version,
    v_change_seq, v_response
  );
  return v_response;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privilege boundary: aggregate mutations are RPC-only.
-- ---------------------------------------------------------------------------

revoke insert, update, delete on
  public.prediction_rule_sets,
  public.prediction_rule_versions,
  public.race_meetings,
  public.races,
  public.race_entries,
  public.predictions,
  public.prediction_horse_selections,
  public.prediction_revisions,
  public.bet_slips,
  public.bet_tickets,
  public.race_results,
  public.race_finishers,
  public.payouts,
  public.race_reflections,
  public.race_reflection_tags,
  public.race_exchange_documents,
  public.sync_devices,
  public.user_settings,
  public.sync_mutation_receipts,
  public.sync_change_log
from authenticated;

revoke all on
  public.sync_devices,
  public.user_settings,
  public.sync_mutation_receipts,
  public.sync_change_log
from anon;

grant select on
  public.sync_devices,
  public.user_settings,
  public.sync_mutation_receipts,
  public.sync_change_log
to authenticated;

revoke usage on sequence public.prediction_revisions_id_seq from authenticated;

revoke execute on function public.upsert_race_record(jsonb) from authenticated;
revoke execute on function public.lock_prediction(uuid) from authenticated;

revoke all on function public.build_synced_race_record(uuid) from public;
revoke all on function public.build_synced_rule_record(uuid) from public;
revoke all on function public.get_sync_changes(bigint, integer) from public;
revoke all on function public.get_sync_bootstrap() from public;
revoke all on function public.register_sync_device(uuid, text, text) from public;
revoke all on function public.sync_race_record(jsonb, bigint, uuid, uuid) from public;
revoke all on function public.sync_user_settings(jsonb, bigint, uuid, uuid) from public;
revoke all on function public.sync_rule_version(jsonb, bigint, uuid, uuid) from public;
revoke all on function public.activate_rule_version(uuid, bigint, uuid, uuid) from public;
revoke all on function public.protect_sync_append_only_row() from public;

grant execute on function public.build_synced_race_record(uuid) to authenticated;
grant execute on function public.build_synced_rule_record(uuid) to authenticated;
grant execute on function public.get_sync_changes(bigint, integer) to authenticated;
grant execute on function public.get_sync_bootstrap() to authenticated;
grant execute on function public.register_sync_device(uuid, text, text) to authenticated;
grant execute on function public.sync_race_record(jsonb, bigint, uuid, uuid) to authenticated;
grant execute on function public.sync_user_settings(jsonb, bigint, uuid, uuid) to authenticated;
grant execute on function public.sync_rule_version(jsonb, bigint, uuid, uuid) to authenticated;
grant execute on function public.activate_rule_version(uuid, bigint, uuid, uuid) to authenticated;

comment on function public.sync_race_record(jsonb, bigint, uuid, uuid) is
  'Idempotent aggregate sync. Returns applied/replayed/conflict JSON envelopes.';

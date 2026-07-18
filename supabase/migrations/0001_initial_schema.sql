-- Keiba prediction and bankroll PWA - initial Supabase/PostgreSQL schema.
-- Target: Supabase PostgreSQL 15+.

create extension if not exists pgcrypto with schema extensions;

create type public.race_surface as enum ('turf', 'dirt', 'obstacle', 'other');
create type public.race_status as enum ('scheduled', 'closed', 'resulted', 'cancelled');
create type public.race_data_scope as enum ('live', 'demo', 'test');
create type public.going_condition as enum ('firm', 'good', 'yielding', 'soft', 'unknown');
create type public.rule_version_status as enum ('draft', 'published', 'retired');
create type public.prediction_status as enum ('draft', 'locked');
create type public.prediction_source as enum ('manual', 'import');
create type public.prediction_mark as enum (
  'honmei',       -- ◎
  'taikou',       -- ○
  'tanana',       -- ▲
  'renka',        -- △
  'hoshi',        -- ☆
  'chu',          -- 注
  'keshi',        -- 消
  'none'
);
create type public.pace_type as enum ('slow', 'middle', 'high', 'unknown');
create type public.buy_decision as enum ('buy', 'pass', 'watch', 'undecided');
create type public.bet_slip_kind as enum ('proposal', 'actual');
create type public.bet_type as enum ('trio', 'trifecta', 'quinella', 'wide', 'win');
create type public.result_status as enum ('provisional', 'official');
create type public.reflection_grade as enum ('good', 'neutral', 'bad');
create type public.exchange_direction as enum ('import', 'export');
create type public.exchange_status as enum ('pending', 'completed', 'failed');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  timezone text not null default 'Asia/Tokyo',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_display_name_length check (display_name is null or char_length(display_name) <= 80)
);

create table public.racecourses (
  id uuid primary key default extensions.gen_random_uuid(),
  code text not null unique,
  name_ja text not null unique,
  name_en text,
  is_active boolean not null default true,
  display_order smallint not null default 0,
  created_at timestamptz not null default now(),
  constraint racecourses_code_format check (code ~ '^[A-Z0-9_]{2,16}$')
);

create table public.prediction_rule_sets (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, name),
  constraint prediction_rule_sets_name_length check (char_length(name) between 1 and 120)
);

create table public.prediction_rule_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  rule_set_id uuid not null references public.prediction_rule_sets(id) on delete cascade,
  version_number integer not null,
  status public.rule_version_status not null default 'draft',
  content text not null,
  parameters jsonb not null default '{}'::jsonb,
  change_note text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rule_set_id, version_number),
  constraint prediction_rule_versions_positive_version check (version_number > 0),
  constraint prediction_rule_versions_parameters_object check (jsonb_typeof(parameters) = 'object'),
  constraint prediction_rule_versions_content_not_blank check (btrim(content) <> '')
);

create table public.race_meetings (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  racecourse_id uuid not null references public.racecourses(id) on delete restrict,
  meeting_date date not null,
  meeting_number smallint not null default 1,
  day_number smallint,
  title text,
  weather text,
  turf_going public.going_condition not null default 'unknown',
  dirt_going public.going_condition not null default 'unknown',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, racecourse_id, meeting_date, meeting_number),
  constraint race_meetings_number_positive check (meeting_number > 0),
  constraint race_meetings_day_positive check (day_number is null or day_number > 0)
);

create table public.races (
  id uuid primary key default extensions.gen_random_uuid(),
  meeting_id uuid not null references public.race_meetings(id) on delete cascade,
  race_number smallint not null,
  starts_at timestamptz not null,
  name text,
  grade text,
  surface public.race_surface not null default 'other',
  distance_m smallint,
  status public.race_status not null default 'scheduled',
  data_scope public.race_data_scope not null default 'live',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (meeting_id, race_number),
  constraint races_number_range check (race_number between 1 and 99),
  constraint races_distance_range check (distance_m is null or distance_m between 400 and 10000)
);

create table public.race_entries (
  id uuid primary key default extensions.gen_random_uuid(),
  race_id uuid not null references public.races(id) on delete cascade,
  horse_number smallint not null,
  bracket_number smallint,
  horse_name text not null,
  jockey_name text,
  trainer_name text,
  popularity smallint,
  win_odds numeric(8, 1),
  is_scratched boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (race_id, horse_number),
  constraint race_entries_horse_number_range check (horse_number between 1 and 99),
  constraint race_entries_bracket_number_range check (bracket_number is null or bracket_number between 1 and 99),
  constraint race_entries_popularity_positive check (popularity is null or popularity > 0),
  constraint race_entries_odds_nonnegative check (win_odds is null or win_odds >= 0),
  constraint race_entries_name_not_blank check (btrim(horse_name) <> '')
);

create table public.predictions (
  id uuid primary key default extensions.gen_random_uuid(),
  race_id uuid not null references public.races(id) on delete cascade,
  rule_version_id uuid references public.prediction_rule_versions(id)
    on delete no action deferrable initially deferred,
  rule_snapshot jsonb not null default '{}'::jsonb,
  status public.prediction_status not null default 'draft',
  source public.prediction_source not null default 'manual',
  pace public.pace_type not null default 'unknown',
  pace_scenario text,
  observed_going public.going_condition not null default 'unknown',
  track_bias text,
  decision public.buy_decision not null default 'undecided',
  confidence smallint,
  summary text,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (race_id),
  constraint predictions_confidence_range check (confidence is null or confidence between 0 and 100),
  constraint predictions_lock_shape check (
    (status = 'draft' and locked_at is null)
    or (status = 'locked' and locked_at is not null)
  ),
  constraint predictions_rule_snapshot_object check (jsonb_typeof(rule_snapshot) = 'object')
);

create table public.prediction_horse_selections (
  id uuid primary key default extensions.gen_random_uuid(),
  prediction_id uuid not null references public.predictions(id) on delete cascade,
  race_entry_id uuid not null references public.race_entries(id) on delete cascade,
  mark public.prediction_mark not null default 'none',
  is_selected boolean not null default true,
  is_key boolean not null default false,
  is_dangerous_favorite boolean not null default false,
  is_longshot boolean not null default false,
  expected_position text,
  evaluation text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (prediction_id, race_entry_id),
  constraint prediction_horse_selections_key_selected check (not is_key or is_selected)
);

-- prediction_id is deliberately not a foreign key. Audit history remains even if
-- the current prediction is removed as part of a user-authorized race deletion.
create table public.prediction_revisions (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  race_id uuid not null,
  prediction_id uuid not null,
  revision_number integer not null,
  entity_type text not null,
  entity_id uuid not null,
  operation text not null,
  before_data jsonb,
  after_data jsonb,
  summary text not null,
  snapshot jsonb,
  changed_by uuid references auth.users(id) on delete set null,
  change_source text not null default 'api',
  changed_at timestamptz not null default now(),
  unique (prediction_id, revision_number),
  constraint prediction_revisions_entity_type check (
    entity_type in ('prediction', 'horse_selection', 'proposal_slip', 'proposal_ticket', 'imported_snapshot')
  ),
  constraint prediction_revisions_operation check (operation in ('INSERT', 'UPDATE', 'DELETE', 'IMPORT')),
  constraint prediction_revisions_snapshot_object check (
    snapshot is null or jsonb_typeof(snapshot) = 'object'
  )
);

create table public.bet_slips (
  id uuid primary key default extensions.gen_random_uuid(),
  race_id uuid not null references public.races(id) on delete cascade,
  prediction_id uuid references public.predictions(id)
    on delete no action deferrable initially deferred,
  kind public.bet_slip_kind not null,
  source public.prediction_source not null default 'manual',
  client_key text,
  title text,
  memo text,
  purchased_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bet_slips_actual_purchase_time check (
    (kind = 'proposal' and purchased_at is null)
    or kind = 'actual'
  ),
  constraint bet_slips_client_key_shape check (
    client_key is null or (char_length(btrim(client_key)) between 1 and 120)
  )
);

-- One row is one concrete betting point. A box/formation is expanded into rows.
-- This keeps selection matching, point counting, and settlement deterministic.
create table public.bet_tickets (
  id uuid primary key default extensions.gen_random_uuid(),
  slip_id uuid not null references public.bet_slips(id) on delete cascade,
  bet_type public.bet_type not null,
  first_entry_id uuid not null references public.race_entries(id)
    on delete no action deferrable initially deferred,
  second_entry_id uuid references public.race_entries(id)
    on delete no action deferrable initially deferred,
  third_entry_id uuid references public.race_entries(id)
    on delete no action deferrable initially deferred,
  stake_yen integer not null default 100,
  memo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bet_tickets_stake_units check (stake_yen >= 100 and stake_yen % 100 = 0),
  constraint bet_tickets_selection_shape check (
    (bet_type = 'win' and second_entry_id is null and third_entry_id is null)
    or (bet_type in ('quinella', 'wide') and second_entry_id is not null and third_entry_id is null)
    or (bet_type in ('trio', 'trifecta') and second_entry_id is not null and third_entry_id is not null)
  )
);

create table public.race_results (
  id uuid primary key default extensions.gen_random_uuid(),
  race_id uuid not null unique references public.races(id) on delete cascade,
  status public.result_status not null default 'provisional',
  official_at timestamptz,
  memo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint race_results_official_shape check (
    (status = 'provisional' and official_at is null)
    or (status = 'official' and official_at is not null)
  )
);

create table public.race_finishers (
  id uuid primary key default extensions.gen_random_uuid(),
  race_result_id uuid not null references public.race_results(id) on delete cascade,
  race_entry_id uuid not null references public.race_entries(id)
    on delete no action deferrable initially deferred,
  finish_position smallint,
  finish_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (race_result_id, race_entry_id),
  constraint race_finishers_position_positive check (finish_position is null or finish_position > 0)
);

create table public.payouts (
  id uuid primary key default extensions.gen_random_uuid(),
  race_result_id uuid not null references public.race_results(id) on delete cascade,
  bet_type public.bet_type not null,
  first_entry_id uuid not null references public.race_entries(id)
    on delete no action deferrable initially deferred,
  second_entry_id uuid references public.race_entries(id)
    on delete no action deferrable initially deferred,
  third_entry_id uuid references public.race_entries(id)
    on delete no action deferrable initially deferred,
  payout_per_100_yen integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payouts_amount_nonnegative check (payout_per_100_yen >= 0),
  constraint payouts_selection_shape check (
    (bet_type = 'win' and second_entry_id is null and third_entry_id is null)
    or (bet_type in ('quinella', 'wide') and second_entry_id is not null and third_entry_id is null)
    or (bet_type in ('trio', 'trifecta') and second_entry_id is not null and third_entry_id is not null)
  )
);

create table public.reflection_categories (
  id uuid primary key default extensions.gen_random_uuid(),
  code text not null unique,
  name_ja text not null,
  description text,
  display_order smallint not null default 0,
  is_active boolean not null default true,
  constraint reflection_categories_code_format check (code ~ '^[a-z][a-z0-9_]{1,31}$')
);

create table public.race_reflections (
  id uuid primary key default extensions.gen_random_uuid(),
  race_id uuid not null unique references public.races(id) on delete cascade,
  prediction_id uuid references public.predictions(id) on delete set null,
  grade public.reflection_grade not null default 'neutral',
  what_worked text,
  what_failed text,
  next_action text,
  memo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.race_reflection_tags (
  reflection_id uuid not null references public.race_reflections(id) on delete cascade,
  category_id uuid not null references public.reflection_categories(id) on delete restrict,
  note text,
  created_at timestamptz not null default now(),
  primary key (reflection_id, category_id)
);

create table public.race_exchange_documents (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  race_id uuid references public.races(id) on delete set null,
  direction public.exchange_direction not null,
  format_version integer not null default 1,
  status public.exchange_status not null default 'pending',
  document_text text not null,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint race_exchange_documents_version_positive check (format_version > 0),
  constraint race_exchange_documents_status_shape check (
    (status = 'pending' and completed_at is null)
    or (status in ('completed', 'failed') and completed_at is not null)
  )
);

create index race_meetings_owner_date_idx on public.race_meetings(owner_id, meeting_date desc);
create index races_meeting_start_idx on public.races(meeting_id, starts_at);
create index race_entries_race_idx on public.race_entries(race_id, horse_number);
create index prediction_revisions_prediction_idx on public.prediction_revisions(prediction_id, revision_number desc);
create index prediction_revisions_owner_changed_idx on public.prediction_revisions(owner_id, changed_at desc);
create index bet_slips_race_kind_idx on public.bet_slips(race_id, kind);
create index bet_tickets_slip_idx on public.bet_tickets(slip_id);
create index payouts_result_idx on public.payouts(race_result_id, bet_type);
create index race_exchange_documents_owner_created_idx on public.race_exchange_documents(owner_id, created_at desc);

-- Prevent duplicate concrete points while allowing NULL legs on shorter bet types.
create unique index bet_tickets_unique_win
  on public.bet_tickets(slip_id, bet_type, first_entry_id)
  where bet_type = 'win';
create unique index bet_tickets_unique_two_horse
  on public.bet_tickets(slip_id, bet_type, first_entry_id, second_entry_id)
  where bet_type in ('quinella', 'wide');
create unique index bet_tickets_unique_three_horse
  on public.bet_tickets(slip_id, bet_type, first_entry_id, second_entry_id, third_entry_id)
  where bet_type in ('trio', 'trifecta');

create unique index payouts_unique_win
  on public.payouts(race_result_id, bet_type, first_entry_id)
  where bet_type = 'win';
create unique index payouts_unique_two_horse
  on public.payouts(race_result_id, bet_type, first_entry_id, second_entry_id)
  where bet_type in ('quinella', 'wide');
create unique index payouts_unique_three_horse
  on public.payouts(race_result_id, bet_type, first_entry_id, second_entry_id, third_entry_id)
  where bet_type in ('trio', 'trifecta');

create unique index bet_slips_unique_client_key
  on public.bet_slips(race_id, kind, client_key)
  where client_key is not null;

-- ---------------------------------------------------------------------------
-- Shared trigger and ownership helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, nullif(new.raw_user_meta_data ->> 'display_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

create or replace function public.is_rule_set_owner(p_rule_set_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.prediction_rule_sets s
    where s.id = p_rule_set_id and s.owner_id = auth.uid()
  );
$$;

create or replace function public.is_meeting_owner(p_meeting_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.race_meetings m
    where m.id = p_meeting_id and m.owner_id = auth.uid()
  );
$$;

create or replace function public.is_race_owner(p_race_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.races r
    join public.race_meetings m on m.id = r.meeting_id
    where r.id = p_race_id and m.owner_id = auth.uid()
  );
$$;

create or replace function public.is_prediction_owner(p_prediction_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.predictions p
    join public.races r on r.id = p.race_id
    join public.race_meetings m on m.id = r.meeting_id
    where p.id = p_prediction_id and m.owner_id = auth.uid()
  );
$$;

create or replace function public.is_slip_owner(p_slip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.bet_slips s
    join public.races r on r.id = s.race_id
    join public.race_meetings m on m.id = r.meeting_id
    where s.id = p_slip_id and m.owner_id = auth.uid()
  );
$$;

create or replace function public.is_result_owner(p_result_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.race_results rr
    join public.races r on r.id = rr.race_id
    join public.race_meetings m on m.id = r.meeting_id
    where rr.id = p_result_id and m.owner_id = auth.uid()
  );
$$;

create or replace function public.is_reflection_owner(p_reflection_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.race_reflections rf
    join public.races r on r.id = rf.race_id
    join public.race_meetings m on m.id = r.meeting_id
    where rf.id = p_reflection_id and m.owner_id = auth.uid()
  );
$$;

-- Published rule content is immutable. A published version can only be retired;
-- edits are represented by a new version row.
create or replace function public.protect_rule_version()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if not exists (
      select 1 from public.prediction_rule_sets where id = old.rule_set_id
    ) then
      return old;
    end if;
    if old.status <> 'draft' then
      raise exception 'Published or retired rule versions cannot be deleted';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.status in ('published', 'retired') then
    if new.rule_set_id is distinct from old.rule_set_id
      or new.version_number is distinct from old.version_number
      or new.content is distinct from old.content
      or new.parameters is distinct from old.parameters
      or new.change_note is distinct from old.change_note
      or new.created_at is distinct from old.created_at
      or new.published_at is distinct from old.published_at
      or (old.status = 'retired' and new.status is distinct from old.status)
      or (old.status = 'published' and new.status not in ('published', 'retired')) then
      raise exception 'Published rule version content is immutable; create a new version';
    end if;
  end if;

  if tg_op = 'UPDATE' and old.status = 'draft'
     and new.status not in ('draft', 'published') then
    raise exception 'A draft rule version can only remain draft or be published';
  end if;

  if new.status = 'published' and old.status is distinct from 'published' then
    new.published_at := now();
  elsif new.status = 'draft' then
    new.published_at := null;
  end if;

  return new;
end;
$$;

create trigger prediction_rule_versions_protect
before update or delete on public.prediction_rule_versions
for each row execute function public.protect_rule_version();

create or replace function public.prepare_rule_version_insert()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status = 'retired' then
    raise exception 'A rule version cannot be created directly as retired';
  end if;
  if new.status = 'published' then
    new.published_at := now();
  else
    new.published_at := null;
  end if;
  return new;
end;
$$;

create trigger prediction_rule_versions_prepare_insert
before insert on public.prediction_rule_versions
for each row execute function public.prepare_rule_version_insert();

-- Enforces the race start boundary and the one-way prediction lock.
create or replace function public.enforce_prediction_lock()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_starts_at timestamptz;
  v_owner_id uuid;
  v_rule_owner uuid;
begin
  if tg_op = 'DELETE' then
    -- The parent race/account cascade may remove the prediction. A direct
    -- deletion still observes its parent race and is subject to the lock.
    if not exists (select 1 from public.races where id = old.race_id) then
      return old;
    end if;
    select r.starts_at into v_starts_at
    from public.races r where r.id = old.race_id;

    if old.status = 'locked' or clock_timestamp() >= v_starts_at then
      raise exception 'A locked or started prediction cannot be deleted';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and new.race_id is distinct from old.race_id then
    raise exception 'Prediction cannot be moved to another race';
  end if;

  select r.starts_at, m.owner_id
  into v_starts_at, v_owner_id
  from public.races r
  join public.race_meetings m on m.id = r.meeting_id
  where r.id = new.race_id;

  if not found then
    raise exception 'Race does not exist';
  end if;

  if new.rule_version_id is not null then
    select rs.owner_id into v_rule_owner
    from public.prediction_rule_versions rv
    join public.prediction_rule_sets rs on rs.id = rv.rule_set_id
    where rv.id = new.rule_version_id;

    if v_rule_owner is distinct from v_owner_id then
      raise exception 'Rule version must belong to the race owner';
    end if;

    if tg_op = 'INSERT' or new.rule_version_id is distinct from old.rule_version_id then
      select jsonb_build_object(
        'rule_set_name', rs.name,
        'version_number', rv.version_number,
        'content', rv.content,
        'parameters', rv.parameters,
        'published_at', rv.published_at
      )
      into new.rule_snapshot
      from public.prediction_rule_versions rv
      join public.prediction_rule_sets rs on rs.id = rv.rule_set_id
      where rv.id = new.rule_version_id;
    elsif new.rule_snapshot is distinct from old.rule_snapshot then
      raise exception 'Rule snapshot is derived from rule_version_id and cannot be edited directly';
    end if;
  end if;

  if tg_op = 'INSERT' then
    if clock_timestamp() >= v_starts_at then
      -- Historic data can only enter as an immutable imported snapshot.
      if new.source <> 'import' then
        raise exception 'A new prediction cannot be created after the race start';
      end if;
      new.status := 'locked';
      new.locked_at := least(coalesce(new.locked_at, v_starts_at), v_starts_at);
    elsif new.status = 'locked' then
      if new.source = 'manual' then
        new.locked_at := clock_timestamp();
      else
        new.locked_at := coalesce(new.locked_at, clock_timestamp());
      end if;
      if new.locked_at >= v_starts_at then
        raise exception 'Prediction must be locked before the race start';
      end if;
    else
      new.locked_at := null;
    end if;
    return new;
  end if;

  if old.status = 'locked' or clock_timestamp() >= v_starts_at then
    raise exception 'A locked or started prediction is immutable';
  end if;

  if new.status = 'locked' then
    if new.source = 'manual' then
      new.locked_at := clock_timestamp();
    else
      new.locked_at := coalesce(new.locked_at, clock_timestamp());
    end if;
    if new.locked_at >= v_starts_at then
      raise exception 'Prediction must be locked before the race start';
    end if;
  else
    new.locked_at := null;
  end if;

  if to_jsonb(new) - 'updated_at' = to_jsonb(old) - 'updated_at' then
    return null;
  end if;

  return new;
end;
$$;

create trigger predictions_enforce_lock
before insert or update or delete on public.predictions
for each row execute function public.enforce_prediction_lock();

create or replace function public.validate_prediction_selection()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_prediction public.predictions%rowtype;
  v_entry_race_id uuid;
  v_starts_at timestamptz;
begin
  if tg_op = 'DELETE' then
    if not exists (
      select 1 from public.predictions where id = old.prediction_id
    ) or not exists (
      select 1
      from public.predictions p
      join public.races r on r.id = p.race_id
      where p.id = old.prediction_id
    ) then
      return old;
    end if;
  end if;
  if tg_op = 'UPDATE' and (
    new.prediction_id is distinct from old.prediction_id
    or new.race_entry_id is distinct from old.race_entry_id
  ) then
    raise exception 'Selection identity cannot be moved; delete and recreate it before lock';
  end if;
  select * into v_prediction
  from public.predictions
  where id = coalesce(new.prediction_id, old.prediction_id);

  select r.starts_at into v_starts_at
  from public.races r where r.id = v_prediction.race_id;

  if tg_op <> 'DELETE' then
    select race_id into v_entry_race_id
    from public.race_entries where id = new.race_entry_id;
    if v_entry_race_id is distinct from v_prediction.race_id then
      raise exception 'Selected horse must belong to the prediction race';
    end if;
  end if;

  -- The import RPC may assemble an imported snapshot in its creation transaction.
  if not (
    tg_op = 'INSERT'
    and v_prediction.source = 'import'
    and v_prediction.created_at = transaction_timestamp()
  ) and (v_prediction.status = 'locked' or clock_timestamp() >= v_starts_at) then
    raise exception 'Selections of a locked or started prediction are immutable';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'UPDATE'
     and to_jsonb(new) - 'updated_at' = to_jsonb(old) - 'updated_at' then
    return null;
  end if;
  return new;
end;
$$;

create trigger prediction_horse_selections_validate
before insert or update or delete on public.prediction_horse_selections
for each row execute function public.validate_prediction_selection();

-- Race-safe slip validation. Proposal slips are part of the prediction and
-- therefore become immutable with it. Actual slips remain separate records.
create or replace function public.validate_bet_slip()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_starts_at timestamptz;
  v_prediction_race uuid;
  v_prediction_status public.prediction_status;
  v_prediction_source public.prediction_source;
  v_prediction_created_at timestamptz;
  v_race_id uuid;
  v_kind public.bet_slip_kind;
  v_prediction_id uuid;
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.races where id = old.race_id
  ) then
    return old;
  end if;
  if tg_op = 'UPDATE' and (
    new.race_id is distinct from old.race_id
    or new.prediction_id is distinct from old.prediction_id
    or new.kind is distinct from old.kind
    or new.source is distinct from old.source
  ) then
    raise exception 'Slip race, prediction, kind, and source are immutable';
  end if;
  v_race_id := case when tg_op = 'DELETE' then old.race_id else new.race_id end;
  v_kind := case when tg_op = 'DELETE' then old.kind else new.kind end;
  v_prediction_id := case when tg_op = 'DELETE' then old.prediction_id else new.prediction_id end;

  select starts_at into v_starts_at from public.races where id = v_race_id;

  if v_prediction_id is not null then
    select race_id, status, source, created_at
    into v_prediction_race, v_prediction_status, v_prediction_source, v_prediction_created_at
    from public.predictions where id = v_prediction_id;
    if v_prediction_race is distinct from v_race_id then
      raise exception 'Slip prediction must belong to the same race';
    end if;
  elsif v_kind = 'proposal' then
    raise exception 'A proposal slip must reference its prediction';
  end if;

  -- A historic imported snapshot may assemble proposals only alongside the
  -- prediction created in this transaction. Checking the parent prediction,
  -- rather than caller-controlled slip source/timestamps, prevents a direct
  -- INSERT or a later RPC import from appending proposals to an existing lock.
  if v_kind = 'proposal' and not (
    tg_op = 'INSERT'
    and v_prediction_source = 'import'
    and v_prediction_created_at = transaction_timestamp()
  ) and clock_timestamp() >= v_starts_at then
    raise exception 'Proposal slips cannot be changed after the race start';
  end if;

  if v_kind = 'proposal' and v_prediction_status = 'locked'
     and not (
       tg_op = 'INSERT'
       and v_prediction_source = 'import'
       and v_prediction_created_at = transaction_timestamp()
     ) then
    raise exception 'Proposal slips of a locked prediction are immutable';
  end if;

  if tg_op <> 'DELETE' and new.kind = 'actual' and new.purchased_at is not null
     and new.purchased_at > v_starts_at then
    raise exception 'Purchase time cannot be after the race start';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'UPDATE'
     and to_jsonb(new) - 'updated_at' = to_jsonb(old) - 'updated_at' then
    return null;
  end if;
  return new;
end;
$$;

create trigger bet_slips_validate
before insert or update or delete on public.bet_slips
for each row execute function public.validate_bet_slip();

create or replace function public.validate_ticket_selections()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_slip public.bet_slips%rowtype;
  v_starts_at timestamptz;
  v_prediction_status public.prediction_status;
  v_prediction_source public.prediction_source;
  v_prediction_created_at timestamptz;
  v_race1 uuid;
  v_race2 uuid;
  v_race3 uuid;
  v_no1 smallint;
  v_no2 smallint;
  v_no3 smallint;
begin
  if tg_op = 'DELETE' then
    if not exists (
      select 1 from public.bet_slips where id = old.slip_id
    ) or not exists (
      select 1
      from public.bet_slips s
      join public.races r on r.id = s.race_id
      where s.id = old.slip_id
    ) then
      return old;
    end if;
  end if;
  if tg_op = 'UPDATE' and new.slip_id is distinct from old.slip_id then
    raise exception 'Ticket cannot be moved to another slip';
  end if;
  select * into v_slip from public.bet_slips
  where id = coalesce(new.slip_id, old.slip_id);
  select starts_at into v_starts_at from public.races where id = v_slip.race_id;

  if v_slip.prediction_id is not null then
    select status, source, created_at
    into v_prediction_status, v_prediction_source, v_prediction_created_at
    from public.predictions where id = v_slip.prediction_id;
  end if;

  if not (
    tg_op = 'INSERT'
    and v_slip.source = 'import'
    and v_slip.created_at = transaction_timestamp()
    and v_prediction_source = 'import'
    and v_prediction_created_at = transaction_timestamp()
  ) and v_slip.kind = 'proposal' and (
    clock_timestamp() >= v_starts_at or v_prediction_status = 'locked'
  ) then
    raise exception 'Tickets cannot be changed after prediction lock or race start';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  select race_id, horse_number into v_race1, v_no1
  from public.race_entries where id = new.first_entry_id;
  if new.second_entry_id is not null then
    select race_id, horse_number into v_race2, v_no2
    from public.race_entries where id = new.second_entry_id;
  end if;
  if new.third_entry_id is not null then
    select race_id, horse_number into v_race3, v_no3
    from public.race_entries where id = new.third_entry_id;
  end if;

  if v_race1 is distinct from v_slip.race_id
    or (new.second_entry_id is not null and v_race2 is distinct from v_slip.race_id)
    or (new.third_entry_id is not null and v_race3 is distinct from v_slip.race_id) then
    raise exception 'Every ticket horse must belong to the slip race';
  end if;

  if new.second_entry_id is not null and new.first_entry_id = new.second_entry_id
    or new.third_entry_id is not null and new.first_entry_id = new.third_entry_id
    or new.third_entry_id is not null and new.second_entry_id = new.third_entry_id then
    raise exception 'A horse cannot appear twice in one ticket';
  end if;

  if new.bet_type in ('quinella', 'wide') and not (v_no1 < v_no2) then
    raise exception 'Unordered two-horse tickets must be stored in horse-number order';
  end if;
  if new.bet_type = 'trio' and not (v_no1 < v_no2 and v_no2 < v_no3) then
    raise exception 'Trio tickets must be stored in horse-number order';
  end if;

  if tg_op = 'UPDATE'
     and to_jsonb(new) - 'updated_at' = to_jsonb(old) - 'updated_at' then
    return null;
  end if;

  return new;
end;
$$;

create trigger bet_tickets_validate
before insert or update or delete on public.bet_tickets
for each row execute function public.validate_ticket_selections();

-- Identity links that have dependent rows cannot be moved between races.
create or replace function public.protect_meeting_identity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (
    new.owner_id is distinct from old.owner_id
    or new.racecourse_id is distinct from old.racecourse_id
    or new.meeting_date is distinct from old.meeting_date
    or new.meeting_number is distinct from old.meeting_number
  ) and exists (select 1 from public.races where meeting_id = old.id) then
    raise exception 'Meeting owner, course, date, and number are fixed once races exist';
  end if;
  return new;
end;
$$;

create trigger race_meetings_protect_identity
before update on public.race_meetings
for each row execute function public.protect_meeting_identity();

create or replace function public.protect_race_timing_and_identity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_prediction_status public.prediction_status;
begin
  if new.meeting_id is distinct from old.meeting_id
    or new.race_number is distinct from old.race_number
    or new.starts_at is distinct from old.starts_at then
    select status into v_prediction_status
    from public.predictions where race_id = old.id;

    if clock_timestamp() >= old.starts_at
      or v_prediction_status = 'locked'
      or exists (select 1 from public.race_results where race_id = old.id) then
      raise exception 'Race meeting, number, and start time are fixed after prediction lock, race start, or result entry';
    end if;
  end if;
  return new;
end;
$$;

create trigger races_protect_timing_and_identity
before update on public.races
for each row execute function public.protect_race_timing_and_identity();

create or replace function public.protect_race_entry_parent()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.race_id is distinct from old.race_id
    or new.horse_number is distinct from old.horse_number then
    raise exception 'Race entry race and horse number are immutable';
  end if;
  return new;
end;
$$;

create trigger race_entries_protect_parent
before update on public.race_entries
for each row execute function public.protect_race_entry_parent();

create or replace function public.validate_race_result_parent()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_race_status public.race_status;
  v_starts_at timestamptz;
begin
  if tg_op = 'UPDATE' and new.race_id is distinct from old.race_id then
    raise exception 'Race result cannot be moved to another race';
  end if;
  select status, starts_at into v_race_status, v_starts_at
  from public.races where id = new.race_id;
  if new.status = 'official' and v_race_status = 'cancelled' then
    raise exception 'A cancelled race cannot receive an official result';
  end if;
  if new.status = 'official' and clock_timestamp() < v_starts_at then
    raise exception 'An official result cannot be recorded before the race start';
  end if;
  return new;
end;
$$;

create trigger race_results_validate_parent
before insert or update on public.race_results
for each row execute function public.validate_race_result_parent();

create or replace function public.validate_result_finisher()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_result_race uuid;
  v_entry_race uuid;
begin
  if tg_op = 'DELETE' then
    return old;
  end if;
  select race_id into v_result_race from public.race_results where id = new.race_result_id;
  select race_id into v_entry_race from public.race_entries where id = new.race_entry_id;
  if v_result_race is distinct from v_entry_race then
    raise exception 'Finisher must belong to the result race';
  end if;
  return new;
end;
$$;

create trigger race_finishers_validate
before insert or update on public.race_finishers
for each row execute function public.validate_result_finisher();

create or replace function public.validate_payout_selections()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_result_race uuid;
  v_race1 uuid;
  v_race2 uuid;
  v_race3 uuid;
  v_no1 smallint;
  v_no2 smallint;
  v_no3 smallint;
begin
  if tg_op = 'DELETE' then
    return old;
  end if;

  select race_id into v_result_race from public.race_results where id = new.race_result_id;
  select race_id, horse_number into v_race1, v_no1
  from public.race_entries where id = new.first_entry_id;
  if new.second_entry_id is not null then
    select race_id, horse_number into v_race2, v_no2
    from public.race_entries where id = new.second_entry_id;
  end if;
  if new.third_entry_id is not null then
    select race_id, horse_number into v_race3, v_no3
    from public.race_entries where id = new.third_entry_id;
  end if;

  if v_race1 is distinct from v_result_race
    or (new.second_entry_id is not null and v_race2 is distinct from v_result_race)
    or (new.third_entry_id is not null and v_race3 is distinct from v_result_race) then
    raise exception 'Every payout horse must belong to the result race';
  end if;

  if (new.second_entry_id is not null and new.first_entry_id = new.second_entry_id)
    or (new.third_entry_id is not null and new.first_entry_id = new.third_entry_id)
    or (new.third_entry_id is not null and new.second_entry_id = new.third_entry_id) then
    raise exception 'A horse cannot appear twice in one payout';
  end if;

  if new.bet_type in ('quinella', 'wide') and not (v_no1 < v_no2) then
    raise exception 'Unordered two-horse payouts must be stored in horse-number order';
  end if;
  if new.bet_type = 'trio' and not (v_no1 < v_no2 and v_no2 < v_no3) then
    raise exception 'Trio payouts must be stored in horse-number order';
  end if;
  return new;
end;
$$;

create trigger payouts_validate
before insert or update on public.payouts
for each row execute function public.validate_payout_selections();

create or replace function public.validate_reflection_prediction()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_prediction_race uuid;
begin
  if tg_op = 'UPDATE' and new.race_id is distinct from old.race_id then
    raise exception 'Reflection cannot be moved to another race';
  end if;
  if new.prediction_id is not null then
    select race_id into v_prediction_race
    from public.predictions where id = new.prediction_id;
    if v_prediction_race is distinct from new.race_id then
      raise exception 'Reflection prediction must belong to the same race';
    end if;
  end if;
  return new;
end;
$$;

create trigger race_reflections_validate
before insert or update on public.race_reflections
for each row execute function public.validate_reflection_prediction();

create or replace function public.mark_race_result_status()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_race_id uuid;
  v_result_status public.result_status;
begin
  v_race_id := case when tg_op = 'DELETE' then old.race_id else new.race_id end;
  v_result_status := case when tg_op = 'DELETE' then null else new.status end;

  if v_result_status = 'official' then
    update public.races set status = 'resulted' where id = v_race_id;
  else
    update public.races
    set status = case
      when starts_at <= clock_timestamp() then 'closed'::public.race_status
      else 'scheduled'::public.race_status
    end
    where id = v_race_id and status = 'resulted';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger race_results_mark_race
after insert or update or delete on public.race_results
for each row execute function public.mark_race_result_status();

-- Append-only snapshot audit for prediction fields and selected horses.
create or replace function public.build_prediction_snapshot(p_prediction_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'selectedHorses', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'horseNumber', e.horse_number,
          'horseName', e.horse_name,
          'mark', case ps.mark
            when 'honmei' then '◎' when 'taikou' then '○'
            when 'tanana' then '▲' when 'renka' then '△'
            when 'hoshi' then '☆' when 'chu' then '注'
            when 'keshi' then '消' else '' end,
          'comment', ps.evaluation
        ) order by e.horse_number
      )
      from public.prediction_horse_selections ps
      join public.race_entries e on e.id = ps.race_entry_id
      where ps.prediction_id = p.id and ps.is_selected
    ), '[]'::jsonb),
    'paceScenario', coalesce(p.pace_scenario, ''),
    'trackView', coalesce(p.track_bias, ''),
    'dangerousFavorites', coalesce((
      select jsonb_agg(e.horse_number order by e.horse_number)
      from public.prediction_horse_selections ps
      join public.race_entries e on e.id = ps.race_entry_id
      where ps.prediction_id = p.id and ps.is_dangerous_favorite
    ), '[]'::jsonb),
    'longshots', coalesce((
      select jsonb_agg(e.horse_number order by e.horse_number)
      from public.prediction_horse_selections ps
      join public.race_entries e on e.id = ps.race_entry_id
      where ps.prediction_id = p.id and ps.is_longshot
    ), '[]'::jsonb),
    'decision', case p.decision
      when 'buy' then 'buy' when 'pass' then 'skip' else 'pending' end,
    'note', coalesce(p.summary, '')
  )
  from public.predictions p
  where p.id = p_prediction_id;
$$;

create or replace function public.audit_prediction_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prediction_id uuid;
  v_race_id uuid;
  v_owner_id uuid;
  v_revision integer;
  v_entity_id uuid;
  v_source text;
  v_entity_type text;
  v_summary text;
  v_snapshot jsonb;
  v_slip_kind public.bet_slip_kind;
  v_lock_transition boolean := false;
begin
  if tg_table_name = 'predictions' then
    v_prediction_id := coalesce(new.id, old.id);
    v_race_id := coalesce(new.race_id, old.race_id);
    v_entity_id := v_prediction_id;
    v_entity_type := 'prediction';
    if tg_op = 'UPDATE' then
      v_lock_transition := new.status = 'locked' and old.status = 'draft';
    end if;
  elsif tg_table_name = 'prediction_horse_selections' then
    v_prediction_id := coalesce(new.prediction_id, old.prediction_id);
    v_entity_id := coalesce(new.id, old.id);
    select race_id into v_race_id
    from public.predictions where id = v_prediction_id;
    v_entity_type := 'horse_selection';
  elsif tg_table_name = 'bet_slips' then
    v_slip_kind := coalesce(new.kind, old.kind);
    if v_slip_kind <> 'proposal' then
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end if;
    v_prediction_id := coalesce(new.prediction_id, old.prediction_id);
    v_race_id := coalesce(new.race_id, old.race_id);
    v_entity_id := coalesce(new.id, old.id);
    v_entity_type := 'proposal_slip';
  elsif tg_table_name = 'bet_tickets' then
    v_entity_id := coalesce(new.id, old.id);
    select s.prediction_id, s.race_id, s.kind
    into v_prediction_id, v_race_id, v_slip_kind
    from public.bet_slips s
    where s.id = coalesce(new.slip_id, old.slip_id);
    if not found or v_slip_kind <> 'proposal' or v_prediction_id is null then
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end if;
    v_entity_type := 'proposal_ticket';
  end if;

  select m.owner_id into v_owner_id
  from public.races r
  join public.race_meetings m on m.id = r.meeting_id
  where r.id = v_race_id;

  if v_owner_id is null then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  -- Serialize revision allocation per prediction without a separate counter row.
  perform pg_advisory_xact_lock(hashtextextended(v_prediction_id::text, 0));
  select coalesce(max(revision_number), 0) + 1 into v_revision
  from public.prediction_revisions where prediction_id = v_prediction_id;

  v_source := coalesce(nullif(current_setting('keiba.change_source', true), ''), 'api');
  v_summary := case v_entity_type
    when 'prediction' then case tg_op
      when 'INSERT' then '予想を作成'
      when 'DELETE' then '予想を削除'
      else case when v_lock_transition
        then '予想をロック' else '予想内容を変更' end
    end
    when 'horse_selection' then case tg_op
      when 'INSERT' then '選出馬を追加' when 'DELETE' then '選出馬を削除'
      else '選出馬を変更' end
    when 'proposal_slip' then case tg_op
      when 'INSERT' then '予想券面を追加' when 'DELETE' then '予想券面を削除'
      else '予想券面を変更' end
    else case tg_op
      when 'INSERT' then '買い目を追加' when 'DELETE' then '買い目を削除'
      else '買い目を変更' end
  end;
  v_snapshot := public.build_prediction_snapshot(v_prediction_id);

  insert into public.prediction_revisions (
    owner_id,
    race_id,
    prediction_id,
    revision_number,
    entity_type,
    entity_id,
    operation,
    before_data,
    after_data,
    summary,
    snapshot,
    changed_by,
    change_source
  ) values (
    v_owner_id,
    v_race_id,
    v_prediction_id,
    v_revision,
    v_entity_type,
    v_entity_id,
    tg_op,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end,
    v_summary,
    v_snapshot,
    auth.uid(),
    v_source
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger predictions_audit
after insert or update or delete on public.predictions
for each row execute function public.audit_prediction_change();

create trigger prediction_horse_selections_audit
after insert or update or delete on public.prediction_horse_selections
for each row execute function public.audit_prediction_change();

create trigger bet_slips_prediction_audit
after insert or update or delete on public.bet_slips
for each row execute function public.audit_prediction_change();

create trigger bet_tickets_prediction_audit
after insert or update or delete on public.bet_tickets
for each row execute function public.audit_prediction_change();

-- A small RPC makes manual locking atomic and explicit from the client.
create or replace function public.lock_prediction(p_prediction_id uuid)
returns public.predictions
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_prediction public.predictions;
begin
  update public.predictions
  set status = 'locked', locked_at = clock_timestamp()
  where id = p_prediction_id
    and status = 'draft'
  returning * into v_prediction;

  if not found then
    raise exception 'Draft prediction not found or not accessible';
  end if;
  return v_prediction;
end;
$$;

-- Keep modification timestamps consistent.
create trigger profiles_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger prediction_rule_sets_updated_at before update on public.prediction_rule_sets
for each row execute function public.set_updated_at();
create trigger prediction_rule_versions_updated_at before update on public.prediction_rule_versions
for each row execute function public.set_updated_at();
create trigger race_meetings_updated_at before update on public.race_meetings
for each row execute function public.set_updated_at();
create trigger races_updated_at before update on public.races
for each row execute function public.set_updated_at();
create trigger race_entries_updated_at before update on public.race_entries
for each row execute function public.set_updated_at();
create trigger predictions_updated_at before update on public.predictions
for each row execute function public.set_updated_at();
create trigger prediction_horse_selections_updated_at before update on public.prediction_horse_selections
for each row execute function public.set_updated_at();
create trigger bet_slips_updated_at before update on public.bet_slips
for each row execute function public.set_updated_at();
create trigger bet_tickets_updated_at before update on public.bet_tickets
for each row execute function public.set_updated_at();
create trigger race_results_updated_at before update on public.race_results
for each row execute function public.set_updated_at();
create trigger race_finishers_updated_at before update on public.race_finishers
for each row execute function public.set_updated_at();
create trigger payouts_updated_at before update on public.payouts
for each row execute function public.set_updated_at();
create trigger race_reflections_updated_at before update on public.race_reflections
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Read models and financial calculations
-- ---------------------------------------------------------------------------

create view public.v_bet_slip_totals
with (security_invoker = true)
as
select
  s.id as slip_id,
  s.race_id,
  s.prediction_id,
  s.kind,
  count(t.id)::integer as point_count,
  coalesce(sum(t.stake_yen), 0)::bigint as total_stake_yen,
  min(t.stake_yen) as minimum_stake_yen,
  max(t.stake_yen) as maximum_stake_yen
from public.bet_slips s
left join public.bet_tickets t on t.slip_id = s.id
group by s.id, s.race_id, s.prediction_id, s.kind;

create view public.v_ticket_settlements
with (security_invoker = true)
as
select
  t.id as ticket_id,
  s.id as slip_id,
  s.race_id,
  t.bet_type,
  t.stake_yen,
  rr.status as result_status,
  p.id as payout_id,
  p.payout_per_100_yen,
  case
    when rr.status <> 'official' or rr.id is null then null
    when p.id is null then 0::bigint
    else (t.stake_yen::bigint / 100) * p.payout_per_100_yen::bigint
  end as gross_return_yen
from public.bet_tickets t
join public.bet_slips s on s.id = t.slip_id and s.kind = 'actual'
left join public.race_results rr on rr.race_id = s.race_id
left join public.payouts p
  on p.race_result_id = rr.id
 and p.bet_type = t.bet_type
 and p.first_entry_id = t.first_entry_id
 and p.second_entry_id is not distinct from t.second_entry_id
 and p.third_entry_id is not distinct from t.third_entry_id;

create view public.v_prediction_overview
with (security_invoker = true)
as
select
  p.id as prediction_id,
  p.race_id,
  p.rule_version_id,
  p.status as stored_status,
  case
    when p.status = 'locked' or statement_timestamp() >= r.starts_at then 'locked'::public.prediction_status
    else 'draft'::public.prediction_status
  end as effective_status,
  p.pace,
  p.decision,
  p.confidence,
  p.locked_at,
  count(ps.id) filter (where ps.is_selected)::integer as selected_horse_count,
  count(ps.id) filter (where ps.is_dangerous_favorite)::integer as dangerous_favorite_count,
  count(ps.id) filter (where ps.is_longshot)::integer as longshot_count,
  p.updated_at
from public.predictions p
join public.races r on r.id = p.race_id
left join public.prediction_horse_selections ps on ps.prediction_id = p.id
group by p.id, r.starts_at;

create view public.v_race_financial_summary
with (security_invoker = true)
as
with slip_totals as (
  select
    s.race_id,
    coalesce(sum(v.point_count) filter (where s.kind = 'proposal'), 0)::integer as proposal_points,
    coalesce(sum(v.total_stake_yen) filter (where s.kind = 'proposal'), 0)::bigint as proposal_stake_yen,
    coalesce(sum(v.point_count) filter (where s.kind = 'actual'), 0)::integer as actual_points,
    coalesce(sum(v.total_stake_yen) filter (where s.kind = 'actual'), 0)::bigint as actual_stake_yen
  from public.bet_slips s
  join public.v_bet_slip_totals v on v.slip_id = s.id
  group by s.race_id
), settlement_returns as (
  select
    race_id,
    coalesce(sum(gross_return_yen), 0)::bigint as gross_return_yen
  from public.v_ticket_settlements
  where result_status = 'official'
  group by race_id
)
select
  r.id as race_id,
  m.owner_id,
  m.meeting_date,
  m.racecourse_id,
  r.race_number,
  r.starts_at,
  rr.status as result_status,
  coalesce(st.proposal_points, 0) as proposal_points,
  coalesce(st.proposal_stake_yen, 0) as proposal_stake_yen,
  coalesce(st.actual_points, 0) as actual_points,
  coalesce(st.actual_stake_yen, 0) as actual_stake_yen,
  case when rr.status = 'official' then coalesce(rt.gross_return_yen, 0) end as gross_return_yen,
  case
    when rr.status = 'official'
      then coalesce(rt.gross_return_yen, 0) - coalesce(st.actual_stake_yen, 0)
  end as profit_yen,
  case
    when rr.status = 'official' and coalesce(st.actual_stake_yen, 0) > 0
      then round(coalesce(rt.gross_return_yen, 0)::numeric * 100 / st.actual_stake_yen, 2)
  end as recovery_rate_percent
from public.races r
join public.race_meetings m on m.id = r.meeting_id
left join public.race_results rr on rr.race_id = r.id
left join slip_totals st on st.race_id = r.id
left join settlement_returns rt on rt.race_id = r.id
where r.data_scope = 'live';

create view public.v_monthly_financial_summary
with (security_invoker = true)
as
select
  owner_id,
  date_trunc('month', meeting_date::timestamp)::date as month,
  count(*)::integer as race_count,
  count(*) filter (where actual_stake_yen > 0)::integer as purchased_race_count,
  sum(actual_stake_yen)::bigint as total_stake_yen,
  sum(gross_return_yen) filter (where result_status = 'official')::bigint as gross_return_yen,
  sum(profit_yen) filter (where result_status = 'official')::bigint as profit_yen,
  case
    when sum(actual_stake_yen) filter (where result_status = 'official') > 0
      then round(
        sum(gross_return_yen) filter (where result_status = 'official')::numeric * 100
        / sum(actual_stake_yen) filter (where result_status = 'official'),
        2
      )
  end as recovery_rate_percent
from public.v_race_financial_summary
group by owner_id, date_trunc('month', meeting_date::timestamp)::date;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.racecourses enable row level security;
alter table public.prediction_rule_sets enable row level security;
alter table public.prediction_rule_versions enable row level security;
alter table public.race_meetings enable row level security;
alter table public.races enable row level security;
alter table public.race_entries enable row level security;
alter table public.predictions enable row level security;
alter table public.prediction_horse_selections enable row level security;
alter table public.prediction_revisions enable row level security;
alter table public.bet_slips enable row level security;
alter table public.bet_tickets enable row level security;
alter table public.race_results enable row level security;
alter table public.race_finishers enable row level security;
alter table public.payouts enable row level security;
alter table public.reflection_categories enable row level security;
alter table public.race_reflections enable row level security;
alter table public.race_reflection_tags enable row level security;
alter table public.race_exchange_documents enable row level security;

create policy profiles_owner_all on public.profiles
for all to authenticated
using (id = auth.uid())
with check (id = auth.uid());

create policy racecourses_authenticated_read on public.racecourses
for select to authenticated
using (true);

create policy prediction_rule_sets_owner_all on public.prediction_rule_sets
for all to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy prediction_rule_versions_owner_all on public.prediction_rule_versions
for all to authenticated
using (public.is_rule_set_owner(rule_set_id))
with check (public.is_rule_set_owner(rule_set_id));

create policy race_meetings_owner_all on public.race_meetings
for all to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy races_owner_all on public.races
for all to authenticated
using (public.is_meeting_owner(meeting_id))
with check (public.is_meeting_owner(meeting_id));

create policy race_entries_owner_all on public.race_entries
for all to authenticated
using (public.is_race_owner(race_id))
with check (public.is_race_owner(race_id));

create policy predictions_owner_all on public.predictions
for all to authenticated
using (public.is_race_owner(race_id))
with check (public.is_race_owner(race_id));

create policy prediction_horse_selections_owner_all on public.prediction_horse_selections
for all to authenticated
using (public.is_prediction_owner(prediction_id))
with check (public.is_prediction_owner(prediction_id));

create policy prediction_revisions_owner_read on public.prediction_revisions
for select to authenticated
using (owner_id = auth.uid());

create policy prediction_revisions_owner_import on public.prediction_revisions
for insert to authenticated
with check (
  owner_id = auth.uid()
  and changed_by = auth.uid()
  and entity_type = 'imported_snapshot'
  and operation = 'IMPORT'
  and public.is_prediction_owner(prediction_id)
  and exists (
    select 1 from public.predictions p
    where p.id = prediction_revisions.prediction_id
      and p.race_id = prediction_revisions.race_id
      and p.created_at = transaction_timestamp()
  )
);

create policy bet_slips_owner_all on public.bet_slips
for all to authenticated
using (public.is_race_owner(race_id))
with check (public.is_race_owner(race_id));

create policy bet_tickets_owner_all on public.bet_tickets
for all to authenticated
using (public.is_slip_owner(slip_id))
with check (public.is_slip_owner(slip_id));

create policy race_results_owner_all on public.race_results
for all to authenticated
using (public.is_race_owner(race_id))
with check (public.is_race_owner(race_id));

create policy race_finishers_owner_all on public.race_finishers
for all to authenticated
using (public.is_result_owner(race_result_id))
with check (public.is_result_owner(race_result_id));

create policy payouts_owner_all on public.payouts
for all to authenticated
using (public.is_result_owner(race_result_id))
with check (public.is_result_owner(race_result_id));

create policy reflection_categories_authenticated_read on public.reflection_categories
for select to authenticated
using (true);

create policy race_reflections_owner_all on public.race_reflections
for all to authenticated
using (public.is_race_owner(race_id))
with check (public.is_race_owner(race_id));

create policy race_reflection_tags_owner_all on public.race_reflection_tags
for all to authenticated
using (public.is_reflection_owner(reflection_id))
with check (public.is_reflection_owner(reflection_id));

create policy race_exchange_documents_owner_all on public.race_exchange_documents
for all to authenticated
using (
  owner_id = auth.uid()
  and (race_id is null or public.is_race_owner(race_id))
)
with check (
  owner_id = auth.uid()
  and (race_id is null or public.is_race_owner(race_id))
);

grant usage on schema public to authenticated;
grant select on public.racecourses, public.reflection_categories to authenticated;
grant select, insert, update, delete on
  public.profiles,
  public.prediction_rule_sets,
  public.prediction_rule_versions,
  public.race_meetings,
  public.races,
  public.race_entries,
  public.predictions,
  public.prediction_horse_selections,
  public.bet_slips,
  public.bet_tickets,
  public.race_results,
  public.race_finishers,
  public.payouts,
  public.race_reflections,
  public.race_reflection_tags,
  public.race_exchange_documents
to authenticated;
grant select, insert on public.prediction_revisions to authenticated;
grant usage, select on sequence public.prediction_revisions_id_seq to authenticated;
grant select on
  public.v_bet_slip_totals,
  public.v_ticket_settlements,
  public.v_prediction_overview,
  public.v_race_financial_summary,
  public.v_monthly_financial_summary
to authenticated;

revoke all on function public.handle_new_auth_user() from public;
revoke all on function public.build_prediction_snapshot(uuid) from public;
revoke all on function public.is_rule_set_owner(uuid) from public;
revoke all on function public.is_meeting_owner(uuid) from public;
revoke all on function public.is_race_owner(uuid) from public;
revoke all on function public.is_prediction_owner(uuid) from public;
revoke all on function public.is_slip_owner(uuid) from public;
revoke all on function public.is_result_owner(uuid) from public;
revoke all on function public.is_reflection_owner(uuid) from public;
revoke all on function public.lock_prediction(uuid) from public;
grant execute on function public.is_rule_set_owner(uuid) to authenticated;
grant execute on function public.is_meeting_owner(uuid) to authenticated;
grant execute on function public.is_race_owner(uuid) to authenticated;
grant execute on function public.is_prediction_owner(uuid) to authenticated;
grant execute on function public.is_slip_owner(uuid) to authenticated;
grant execute on function public.is_result_owner(uuid) to authenticated;
grant execute on function public.is_reflection_owner(uuid) to authenticated;
grant execute on function public.lock_prediction(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Mobile-client JSON read/write RPCs
-- ---------------------------------------------------------------------------

create or replace function public.build_race_record(p_race_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', r.id,
    'meeting', jsonb_build_object(
      'id', m.id,
      'meeting_date', m.meeting_date,
      'meeting_number', m.meeting_number,
      'day_number', m.day_number,
      'title', m.title,
      'weather', m.weather,
      'turf_going', m.turf_going,
      'dirt_going', m.dirt_going,
      'notes', m.notes,
      'racecourse', jsonb_build_object(
        'id', c.id,
        'code', c.code,
        'name_ja', c.name_ja,
        'name_en', c.name_en
      )
    ),
    'race', jsonb_build_object(
      'race_number', r.race_number,
      'data_scope', r.data_scope,
      'starts_at', r.starts_at,
      'name', r.name,
      'grade', r.grade,
      'surface', r.surface,
      'distance_m', r.distance_m,
      'status', r.status,
      'notes', r.notes,
      'created_at', r.created_at,
      'updated_at', r.updated_at
    ),
    'entries', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', e.id,
          'horse_number', e.horse_number,
          'bracket_number', e.bracket_number,
          'horse_name', e.horse_name,
          'jockey_name', e.jockey_name,
          'trainer_name', e.trainer_name,
          'popularity', e.popularity,
          'win_odds', e.win_odds,
          'is_scratched', e.is_scratched,
          'notes', e.notes
        ) order by e.horse_number
      )
      from public.race_entries e where e.race_id = r.id
    ), '[]'::jsonb),
    'prediction', (
      select jsonb_build_object(
        'id', p.id,
        'rule_version_id', p.rule_version_id,
        'rule_snapshot', p.rule_snapshot,
        'status', p.status,
        'effective_status', case
          when p.status = 'locked' or statement_timestamp() >= r.starts_at then 'locked'
          else 'draft'
        end,
        'source', p.source,
        'pace', p.pace,
        'pace_scenario', p.pace_scenario,
        'observed_going', p.observed_going,
        'track_bias', p.track_bias,
        'decision', p.decision,
        'confidence', p.confidence,
        'summary', p.summary,
        'locked_at', p.locked_at,
        'created_at', p.created_at,
        'updated_at', p.updated_at,
        'selections', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', ps.id,
              'race_entry_id', ps.race_entry_id,
              'horse_number', e.horse_number,
              'horse_name', e.horse_name,
              'mark', ps.mark,
              'is_selected', ps.is_selected,
              'is_key', ps.is_key,
              'is_dangerous_favorite', ps.is_dangerous_favorite,
              'is_longshot', ps.is_longshot,
              'expected_position', ps.expected_position,
              'evaluation', ps.evaluation
            ) order by e.horse_number
          )
          from public.prediction_horse_selections ps
          join public.race_entries e on e.id = ps.race_entry_id
          where ps.prediction_id = p.id
        ), '[]'::jsonb),
        'revisions', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', pr.id::text,
              'revision', pr.revision_number,
              'changed_at', pr.changed_at,
              'summary', pr.summary,
              'snapshot', pr.snapshot
            ) order by pr.revision_number
          )
          from public.prediction_revisions pr
          where pr.prediction_id = p.id and pr.snapshot is not null
        ), '[]'::jsonb)
      )
      from public.predictions p where p.race_id = r.id
    ),
    'bet_slips', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', s.id,
          'prediction_id', s.prediction_id,
          'kind', s.kind,
          'source', s.source,
          'client_key', s.client_key,
          'title', s.title,
          'memo', s.memo,
          'purchased_at', s.purchased_at,
          'point_count', coalesce(st.point_count, 0),
          'total_stake_yen', coalesce(st.total_stake_yen, 0),
          'tickets', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', t.id,
                'bet_type', t.bet_type,
                'first_entry_id', t.first_entry_id,
                'first_horse_number', e1.horse_number,
                'second_entry_id', t.second_entry_id,
                'second_horse_number', e2.horse_number,
                'third_entry_id', t.third_entry_id,
                'third_horse_number', e3.horse_number,
                'stake_yen', t.stake_yen,
                'memo', t.memo
              ) order by t.bet_type, e1.horse_number, e2.horse_number, e3.horse_number
            )
            from public.bet_tickets t
            join public.race_entries e1 on e1.id = t.first_entry_id
            left join public.race_entries e2 on e2.id = t.second_entry_id
            left join public.race_entries e3 on e3.id = t.third_entry_id
            where t.slip_id = s.id
          ), '[]'::jsonb)
        ) order by s.kind, s.created_at, s.id
      )
      from public.bet_slips s
      left join public.v_bet_slip_totals st on st.slip_id = s.id
      where s.race_id = r.id
    ), '[]'::jsonb),
    'result', (
      select jsonb_build_object(
        'id', rr.id,
        'status', rr.status,
        'official_at', rr.official_at,
        'memo', rr.memo,
        'finishers', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', f.id,
              'race_entry_id', f.race_entry_id,
              'horse_number', e.horse_number,
              'horse_name', e.horse_name,
              'finish_position', f.finish_position,
              'finish_note', f.finish_note
            ) order by f.finish_position nulls last, e.horse_number
          )
          from public.race_finishers f
          join public.race_entries e on e.id = f.race_entry_id
          where f.race_result_id = rr.id
        ), '[]'::jsonb),
        'payouts', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', po.id,
              'bet_type', po.bet_type,
              'first_horse_number', e1.horse_number,
              'second_horse_number', e2.horse_number,
              'third_horse_number', e3.horse_number,
              'payout_per_100_yen', po.payout_per_100_yen
            ) order by po.bet_type, e1.horse_number, e2.horse_number, e3.horse_number
          )
          from public.payouts po
          join public.race_entries e1 on e1.id = po.first_entry_id
          left join public.race_entries e2 on e2.id = po.second_entry_id
          left join public.race_entries e3 on e3.id = po.third_entry_id
          where po.race_result_id = rr.id
        ), '[]'::jsonb)
      )
      from public.race_results rr where rr.race_id = r.id
    ),
    'reflection', (
      select jsonb_build_object(
        'id', rf.id,
        'prediction_id', rf.prediction_id,
        'grade', rf.grade,
        'what_worked', rf.what_worked,
        'what_failed', rf.what_failed,
        'next_action', rf.next_action,
        'memo', rf.memo,
        'categories', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'code', rc.code,
              'name_ja', rc.name_ja,
              'note', rt.note
            ) order by rc.display_order, rc.code
          )
          from public.race_reflection_tags rt
          join public.reflection_categories rc on rc.id = rt.category_id
          where rt.reflection_id = rf.id
        ), '[]'::jsonb)
      )
      from public.race_reflections rf where rf.race_id = r.id
    ),
    'financial', (
      select to_jsonb(fs) - 'owner_id' - 'racecourse_id' - 'race_id'
      from public.v_race_financial_summary fs where fs.race_id = r.id
    ),
    'revision_count', (
      select count(*)::integer from public.prediction_revisions pr where pr.race_id = r.id
    )
  )
  from public.races r
  join public.race_meetings m on m.id = r.meeting_id
  join public.racecourses c on c.id = m.racecourse_id
  where r.id = p_race_id;
$$;

create or replace function public.get_race_record(p_race_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_record jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  select public.build_race_record(p_race_id) into v_record;
  if v_record is null then
    raise exception 'Race not found or not accessible';
  end if;
  return v_record;
end;
$$;

create or replace function public.get_race_records()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_records jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  select coalesce(
    jsonb_agg(public.build_race_record(r.id) order by r.starts_at desc, r.race_number desc),
    '[]'::jsonb
  )
  into v_records
  from public.races r
  join public.race_meetings m on m.id = r.meeting_id
  where m.owner_id = auth.uid();
  return v_records;
end;
$$;

create or replace function public.upsert_race_record(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_meeting_json jsonb := coalesce(payload -> 'meeting', '{}'::jsonb);
  v_race_json jsonb := coalesce(payload -> 'race', '{}'::jsonb);
  v_prediction_json jsonb;
  v_result_json jsonb;
  v_reflection_json jsonb;
  v_item jsonb;
  v_child jsonb;
  v_course_key text;
  v_course_id uuid;
  v_meeting_date date;
  v_meeting_number smallint;
  v_meeting_id uuid;
  v_race_id uuid;
  v_race_number smallint;
  v_starts_at timestamptz;
  v_prediction_id uuid;
  v_slip_id uuid;
  v_slip_kind public.bet_slip_kind;
  v_result_id uuid;
  v_reflection_id uuid;
  v_entry1 uuid;
  v_entry2 uuid;
  v_entry3 uuid;
  v_no1 smallint;
  v_no2 smallint;
  v_no3 smallint;
  v_tmp_entry uuid;
  v_tmp_no smallint;
  v_status public.prediction_status;
  v_existing_prediction_status public.prediction_status;
  v_prediction_source public.prediction_source;
  v_result_status public.result_status;
  v_mark_text text;
  v_lock_after_upsert boolean := false;
  v_prediction_mutable boolean := true;
  v_slip_immutable boolean := false;
  v_race_is_past boolean := false;
  v_prediction_created boolean := false;
  v_revision_no integer;
  v_tickets_changed boolean;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'payload must be a JSON object';
  end if;

  perform set_config(
    'keiba.change_source',
    coalesce(nullif(payload ->> 'change_source', ''), 'upsert_race_record'),
    true
  );

  -- Existing records are resolved through RLS before any update occurs.
  if nullif(payload ->> 'id', '') is not null then
    v_race_id := (payload ->> 'id')::uuid;
    select r.meeting_id, m.racecourse_id, m.meeting_date, m.meeting_number,
           r.race_number, r.starts_at
    into v_meeting_id, v_course_id, v_meeting_date, v_meeting_number,
         v_race_number, v_starts_at
    from public.races r
    join public.race_meetings m on m.id = r.meeting_id
    where r.id = v_race_id;

    if not found then
      -- A UUID exported from another project/account is an external identity,
      -- not authority to update that row. Fall back to the natural race key.
      v_race_id := null;
    end if;
  end if;

  v_course_key := coalesce(
    v_meeting_json #>> '{racecourse,code}',
    v_meeting_json ->> 'racecourse_code',
    payload ->> 'racecourse_code',
    payload ->> 'venue'
  );
  if v_course_key is not null then
    select id into v_course_id
    from public.racecourses
    where code = upper(v_course_key) or name_ja = v_course_key
    limit 1;
    if not found then
      raise exception 'Unknown racecourse: %', v_course_key;
    end if;
  end if;

  v_meeting_date := coalesce(
    nullif(v_meeting_json ->> 'meeting_date', '')::date,
    nullif(payload ->> 'race_date', '')::date,
    nullif(payload ->> 'date', '')::date,
    v_meeting_date
  );
  v_meeting_number := coalesce(
    nullif(v_meeting_json ->> 'meeting_number', '')::smallint,
    v_meeting_number,
    1
  );

  if v_course_id is null or v_meeting_date is null then
    raise exception 'meeting.racecourse.code and meeting.meeting_date are required';
  end if;

  -- A race may move to a different meeting while its prediction is still a
  -- pre-start draft. Never rewrite the identity of the old meeting because it
  -- can be shared by other races; resolve/create the requested target instead.
  if v_meeting_id is null or not exists (
    select 1
    from public.race_meetings m
    where m.id = v_meeting_id
      and m.racecourse_id = v_course_id
      and m.meeting_date = v_meeting_date
      and m.meeting_number = v_meeting_number
  ) then
    insert into public.race_meetings (
      owner_id, racecourse_id, meeting_date, meeting_number, day_number,
      title, weather, turf_going, dirt_going, notes
    ) values (
      v_user_id,
      v_course_id,
      v_meeting_date,
      v_meeting_number,
      nullif(v_meeting_json ->> 'day_number', '')::smallint,
      v_meeting_json ->> 'title',
      v_meeting_json ->> 'weather',
      coalesce(nullif(v_meeting_json ->> 'turf_going', '')::public.going_condition, 'unknown'),
      coalesce(nullif(v_meeting_json ->> 'dirt_going', '')::public.going_condition, 'unknown'),
      v_meeting_json ->> 'notes'
    )
    on conflict (owner_id, racecourse_id, meeting_date, meeting_number)
    do update set
      day_number = coalesce(excluded.day_number, race_meetings.day_number),
      title = coalesce(excluded.title, race_meetings.title),
      weather = coalesce(excluded.weather, race_meetings.weather),
      turf_going = case when v_meeting_json ? 'turf_going'
        then excluded.turf_going else race_meetings.turf_going end,
      dirt_going = case when v_meeting_json ? 'dirt_going'
        then excluded.dirt_going else race_meetings.dirt_going end,
      notes = coalesce(excluded.notes, race_meetings.notes)
    returning id into v_meeting_id;
  else
    update public.race_meetings
    set day_number = coalesce(nullif(v_meeting_json ->> 'day_number', '')::smallint, day_number),
        title = coalesce(v_meeting_json ->> 'title', title),
        weather = coalesce(v_meeting_json ->> 'weather', weather),
        turf_going = coalesce(nullif(v_meeting_json ->> 'turf_going', '')::public.going_condition, turf_going),
        dirt_going = coalesce(nullif(v_meeting_json ->> 'dirt_going', '')::public.going_condition, dirt_going),
        notes = coalesce(v_meeting_json ->> 'notes', notes)
    where id = v_meeting_id;
  end if;

  v_race_number := coalesce(
    nullif(v_race_json ->> 'race_number', '')::smallint,
    nullif(payload ->> 'race_number', '')::smallint,
    nullif(payload ->> 'race_no', '')::smallint,
    v_race_number
  );
  if nullif(v_race_json ->> 'starts_at', '') is not null then
    v_starts_at := (v_race_json ->> 'starts_at')::timestamptz;
  elsif nullif(payload ->> 'starts_at', '') is not null then
    v_starts_at := (payload ->> 'starts_at')::timestamptz;
  elsif nullif(payload ->> 'start_time', '') is not null and v_meeting_date is not null then
    v_starts_at := (v_meeting_date::text || ' ' || (payload ->> 'start_time') || ' Asia/Tokyo')::timestamptz;
  end if;

  if v_race_number is null or v_starts_at is null then
    raise exception 'race.race_number and race.starts_at are required';
  end if;

  if v_race_id is null then
    insert into public.races (
      meeting_id, race_number, starts_at, name, grade, surface,
      distance_m, status, data_scope, notes
    ) values (
      v_meeting_id,
      v_race_number,
      v_starts_at,
      v_race_json ->> 'name',
      v_race_json ->> 'grade',
      coalesce(nullif(v_race_json ->> 'surface', '')::public.race_surface, 'other'),
      nullif(v_race_json ->> 'distance_m', '')::smallint,
      case
        when v_race_json ->> 'status' = 'official' then 'resulted'::public.race_status
        else coalesce(nullif(v_race_json ->> 'status', '')::public.race_status, 'scheduled')
      end,
      coalesce(nullif(v_race_json ->> 'data_scope', '')::public.race_data_scope, 'live'),
      v_race_json ->> 'notes'
    )
    on conflict (meeting_id, race_number)
    do update set
      starts_at = excluded.starts_at,
      name = coalesce(excluded.name, races.name),
      grade = coalesce(excluded.grade, races.grade),
      surface = case when v_race_json ? 'surface' then excluded.surface else races.surface end,
      distance_m = coalesce(excluded.distance_m, races.distance_m),
      status = case when v_race_json ? 'status' then excluded.status else races.status end,
      data_scope = case when v_race_json ? 'data_scope' then excluded.data_scope else races.data_scope end,
      notes = coalesce(excluded.notes, races.notes)
    returning id into v_race_id;
  else
    update public.races
    set meeting_id = v_meeting_id,
        race_number = v_race_number,
        starts_at = v_starts_at,
        name = coalesce(v_race_json ->> 'name', name),
        grade = coalesce(v_race_json ->> 'grade', grade),
        surface = coalesce(nullif(v_race_json ->> 'surface', '')::public.race_surface, surface),
        distance_m = coalesce(nullif(v_race_json ->> 'distance_m', '')::smallint, distance_m),
        status = case
          when not (v_race_json ? 'status') then status
          when v_race_json ->> 'status' = 'official' then 'resulted'::public.race_status
          else (v_race_json ->> 'status')::public.race_status
        end,
        data_scope = coalesce(nullif(v_race_json ->> 'data_scope', '')::public.race_data_scope, data_scope),
        notes = coalesce(v_race_json ->> 'notes', notes)
    where id = v_race_id;
  end if;

  -- Serialize the nested save after the race identity has been resolved. This
  -- prevents concurrent first saves from racing on one-per-race child rows.
  perform pg_advisory_xact_lock(hashtextextended(v_race_id::text, 1));
  v_race_is_past := clock_timestamp() >= v_starts_at;

  if payload ? 'entries' then
    if jsonb_typeof(payload -> 'entries') <> 'array' then
      raise exception 'entries must be an array';
    end if;
    for v_item in select value from jsonb_array_elements(payload -> 'entries') loop
      insert into public.race_entries (
        race_id, horse_number, bracket_number, horse_name, jockey_name,
        trainer_name, popularity, win_odds, is_scratched, notes
      ) values (
        v_race_id,
        (v_item ->> 'horse_number')::smallint,
        nullif(v_item ->> 'bracket_number', '')::smallint,
        coalesce(
          nullif(btrim(v_item ->> 'horse_name'), ''),
          (v_item ->> 'horse_number') || '番'
        ),
        v_item ->> 'jockey_name',
        v_item ->> 'trainer_name',
        nullif(v_item ->> 'popularity', '')::smallint,
        nullif(v_item ->> 'win_odds', '')::numeric,
        coalesce((v_item ->> 'is_scratched')::boolean, false),
        v_item ->> 'notes'
      )
      on conflict (race_id, horse_number)
      do update set
        bracket_number = coalesce(excluded.bracket_number, race_entries.bracket_number),
        horse_name = case
          when excluded.horse_name = excluded.horse_number::text || '番'
            then race_entries.horse_name
          else excluded.horse_name
        end,
        jockey_name = coalesce(excluded.jockey_name, race_entries.jockey_name),
        trainer_name = coalesce(excluded.trainer_name, race_entries.trainer_name),
        popularity = coalesce(excluded.popularity, race_entries.popularity),
        win_odds = coalesce(excluded.win_odds, race_entries.win_odds),
        is_scratched = case when v_item ? 'is_scratched'
          then excluded.is_scratched else race_entries.is_scratched end,
        notes = coalesce(excluded.notes, race_entries.notes);
    end loop;
  end if;

  v_prediction_json := payload -> 'prediction';
  if v_prediction_json is not null and jsonb_typeof(v_prediction_json) = 'object' then
    select id, status into v_prediction_id, v_existing_prediction_status
    from public.predictions where race_id = v_race_id;
    v_status := coalesce(
      nullif(v_prediction_json ->> 'status', '')::public.prediction_status,
      v_existing_prediction_status,
      'draft'
    );
    v_prediction_source := case
      when v_race_is_past then 'import'::public.prediction_source
      else coalesce(
        nullif(v_prediction_json ->> 'source', '')::public.prediction_source,
        'manual'
      )
    end;
    v_prediction_mutable := v_prediction_id is null
      or (v_existing_prediction_status = 'draft' and not v_race_is_past);

    if v_prediction_id is null then
      v_prediction_created := true;
      if v_status = 'locked' and not v_race_is_past then
        v_lock_after_upsert := true;
        v_status := 'draft';
      end if;
      insert into public.predictions (
        race_id, rule_version_id, rule_snapshot, status, source, pace,
        pace_scenario, observed_going, track_bias, decision, confidence,
        summary, locked_at
      ) values (
        v_race_id,
        nullif(v_prediction_json ->> 'rule_version_id', '')::uuid,
        coalesce(v_prediction_json -> 'rule_snapshot', '{}'::jsonb),
        v_status,
        v_prediction_source,
        coalesce(nullif(v_prediction_json ->> 'pace', '')::public.pace_type, 'unknown'),
        v_prediction_json ->> 'pace_scenario',
        coalesce(nullif(v_prediction_json ->> 'observed_going', '')::public.going_condition, 'unknown'),
        v_prediction_json ->> 'track_bias',
        coalesce(nullif(v_prediction_json ->> 'decision', '')::public.buy_decision, 'undecided'),
        nullif(v_prediction_json ->> 'confidence', '')::smallint,
        v_prediction_json ->> 'summary',
        case when v_prediction_source = 'import'
          then nullif(v_prediction_json ->> 'locked_at', '')::timestamptz
        end
      ) returning id into v_prediction_id;
    elsif v_prediction_mutable then
      if v_status = 'locked' then
        v_lock_after_upsert := true;
      end if;
      update public.predictions
      set rule_version_id = coalesce(nullif(v_prediction_json ->> 'rule_version_id', '')::uuid, rule_version_id),
          rule_snapshot = coalesce(v_prediction_json -> 'rule_snapshot', rule_snapshot),
          status = 'draft',
          pace = coalesce(nullif(v_prediction_json ->> 'pace', '')::public.pace_type, pace),
          pace_scenario = coalesce(v_prediction_json ->> 'pace_scenario', pace_scenario),
          observed_going = coalesce(nullif(v_prediction_json ->> 'observed_going', '')::public.going_condition, observed_going),
          track_bias = coalesce(v_prediction_json ->> 'track_bias', track_bias),
          decision = coalesce(nullif(v_prediction_json ->> 'decision', '')::public.buy_decision, decision),
          confidence = coalesce(nullif(v_prediction_json ->> 'confidence', '')::smallint, confidence),
          summary = coalesce(v_prediction_json ->> 'summary', summary),
          locked_at = null
      where id = v_prediction_id;
    end if;

    if v_prediction_mutable and v_prediction_json ? 'selections' then
      if jsonb_typeof(v_prediction_json -> 'selections') <> 'array' then
        raise exception 'prediction.selections must be an array';
      end if;

      delete from public.prediction_horse_selections ps
      where ps.prediction_id = v_prediction_id
        and not exists (
          select 1
          from jsonb_array_elements(v_prediction_json -> 'selections') x
          join public.race_entries e
            on e.race_id = v_race_id
           and e.horse_number = (x ->> 'horse_number')::smallint
          where e.id = ps.race_entry_id
        );

      for v_item in select value from jsonb_array_elements(v_prediction_json -> 'selections') loop
        select id into v_entry1 from public.race_entries
        where race_id = v_race_id and horse_number = (v_item ->> 'horse_number')::smallint;
        if v_entry1 is null then
          raise exception 'Unknown selected horse number: %', v_item ->> 'horse_number';
        end if;
        v_mark_text := coalesce(v_item ->> 'mark', 'none');
        v_mark_text := case v_mark_text
          when '◎' then 'honmei' when '○' then 'taikou' when '▲' then 'tanana'
          when '△' then 'renka' when '☆' then 'hoshi' when '注' then 'chu'
          when '消' then 'keshi'
          else v_mark_text end;

        insert into public.prediction_horse_selections (
          prediction_id, race_entry_id, mark, is_selected, is_key, is_dangerous_favorite,
          is_longshot, expected_position, evaluation
        ) values (
          v_prediction_id,
          v_entry1,
          v_mark_text::public.prediction_mark,
          coalesce((v_item ->> 'is_selected')::boolean, v_mark_text <> 'none'),
          coalesce((v_item ->> 'is_key')::boolean, false),
          coalesce((v_item ->> 'is_dangerous_favorite')::boolean, false),
          coalesce((v_item ->> 'is_longshot')::boolean, false),
          v_item ->> 'expected_position',
          v_item ->> 'evaluation'
        )
        on conflict (prediction_id, race_entry_id)
        do update set
          mark = excluded.mark,
          is_selected = excluded.is_selected,
          is_key = excluded.is_key,
          is_dangerous_favorite = excluded.is_dangerous_favorite,
          is_longshot = excluded.is_longshot,
          expected_position = excluded.expected_position,
          evaluation = excluded.evaluation;
      end loop;
    end if;
  else
    select id, status into v_prediction_id, v_existing_prediction_status
    from public.predictions where race_id = v_race_id;
    v_prediction_mutable := false;
  end if;

  if v_prediction_created and v_prediction_json ? 'revisions' then
    if jsonb_typeof(v_prediction_json -> 'revisions') <> 'array' then
      raise exception 'prediction.revisions must be an array';
    end if;
    for v_item in select value from jsonb_array_elements(v_prediction_json -> 'revisions') loop
      if jsonb_typeof(v_item -> 'snapshot') is distinct from 'object' then
        raise exception 'prediction.revisions[].snapshot must be an object';
      end if;
      select coalesce(max(revision_number), 0) + 1 into v_revision_no
      from public.prediction_revisions where prediction_id = v_prediction_id;
      insert into public.prediction_revisions (
        owner_id, race_id, prediction_id, revision_number, entity_type,
        entity_id, operation, before_data, after_data, summary, snapshot,
        changed_by, change_source, changed_at
      ) values (
        v_user_id, v_race_id, v_prediction_id, v_revision_no, 'imported_snapshot',
        v_prediction_id, 'IMPORT', null, v_item,
        coalesce(nullif(v_item ->> 'summary', ''), 'インポートした予想履歴'),
        v_item -> 'snapshot', v_user_id, 'race_record_import',
        coalesce(
          nullif(v_item ->> 'changed_at', '')::timestamptz,
          nullif(v_item ->> 'changedAt', '')::timestamptz,
          now()
        )
      );
    end loop;
  end if;

  if payload ? 'bet_slips' then
    if jsonb_typeof(payload -> 'bet_slips') <> 'array' then
      raise exception 'bet_slips must be an array';
    end if;

    -- A full slip array is authoritative for sections that are still mutable.
    -- Stable id/client_key matching makes deleting a plan in the UI durable.
    delete from public.bet_slips s
    where s.race_id = v_race_id
      and (
        s.kind = 'actual'
        or (s.kind = 'proposal' and v_prediction_mutable and not v_race_is_past)
      )
      and not exists (
        select 1
        from jsonb_array_elements(payload -> 'bet_slips') x
        where x ->> 'kind' = s.kind::text
          and (
            x ->> 'id' = s.id::text
            or (
              nullif(x ->> 'client_key', '') is not null
              and x ->> 'client_key' = s.client_key
            )
            or (
              nullif(x ->> 'client_key', '') is null
              and s.client_key is null
              and (x ->> 'title') is not distinct from s.title
            )
          )
      );

    for v_item in select value from jsonb_array_elements(payload -> 'bet_slips') loop
      v_slip_kind := (v_item ->> 'kind')::public.bet_slip_kind;
      v_slip_id := nullif(v_item ->> 'id', '')::uuid;

      if v_slip_id is not null then
        perform 1 from public.bet_slips
        where id = v_slip_id and race_id = v_race_id and kind = v_slip_kind;
        if not found then
          v_slip_id := null;
        end if;
      end if;
      if v_slip_id is null then
        select id into v_slip_id
        from public.bet_slips
        where race_id = v_race_id
          and kind = v_slip_kind
          and (
            (nullif(v_item ->> 'client_key', '') is not null
              and client_key = nullif(v_item ->> 'client_key', ''))
            or (nullif(v_item ->> 'client_key', '') is null
              and title is not distinct from (v_item ->> 'title'))
          )
        order by created_at
        limit 1;
      end if;

      v_slip_immutable := false;
      if v_slip_id is not null and v_slip_kind = 'proposal' then
        select v_race_is_past or p.status = 'locked'
        into v_slip_immutable
        from public.bet_slips s
        left join public.predictions p on p.id = s.prediction_id
        where s.id = v_slip_id;
      end if;
      if coalesce(v_slip_immutable, false) then
        continue;
      end if;

      if v_slip_id is null then
        insert into public.bet_slips (
          race_id, prediction_id, kind, source, client_key, title, memo, purchased_at
        ) values (
          v_race_id,
          coalesce(nullif(v_item ->> 'prediction_id', '')::uuid, v_prediction_id),
          v_slip_kind,
          case when v_race_is_past then 'import'::public.prediction_source
            else coalesce(nullif(v_item ->> 'source', '')::public.prediction_source, 'manual')
          end,
          nullif(v_item ->> 'client_key', ''),
          v_item ->> 'title',
          v_item ->> 'memo',
          case when v_slip_kind = 'actual'
            then case
              when nullif(v_item ->> 'purchased_at', '')::timestamptz <= v_starts_at
                then nullif(v_item ->> 'purchased_at', '')::timestamptz
              else null
            end
          end
        ) returning id into v_slip_id;
      else
        update public.bet_slips
        set client_key = coalesce(nullif(v_item ->> 'client_key', ''), client_key),
            title = coalesce(v_item ->> 'title', title),
            memo = coalesce(v_item ->> 'memo', memo),
            purchased_at = case when v_slip_kind = 'actual'
              then case
                when nullif(v_item ->> 'purchased_at', '')::timestamptz <= v_starts_at
                  then nullif(v_item ->> 'purchased_at', '')::timestamptz
                else purchased_at
              end
              else null
            end
        where id = v_slip_id;
      end if;

      if v_item ? 'tickets' then
        if jsonb_typeof(v_item -> 'tickets') <> 'array' then
          raise exception 'bet_slips[].tickets must be an array';
        end if;

        select not (
          (select count(*) from public.bet_tickets where slip_id = v_slip_id)
            = jsonb_array_length(v_item -> 'tickets')
          and not exists (
            select 1
            from public.bet_tickets et
            join public.race_entries ee1 on ee1.id = et.first_entry_id
            left join public.race_entries ee2 on ee2.id = et.second_entry_id
            left join public.race_entries ee3 on ee3.id = et.third_entry_id
            where et.slip_id = v_slip_id
              and not exists (
                select 1 from jsonb_array_elements(v_item -> 'tickets') it
                where it ->> 'bet_type' = et.bet_type::text
                  and coalesce(
                    nullif(it ->> 'stake_yen', '')::integer,
                    nullif(it ->> 'unit_amount_yen', '')::integer,
                    100
                  ) = et.stake_yen
                  and coalesce(
                    nullif(it ->> 'first_horse_number', '')::smallint,
                    nullif(it #>> '{selections,0}', '')::smallint
                  ) = ee1.horse_number
                  and coalesce(
                    nullif(it ->> 'second_horse_number', '')::smallint,
                    nullif(it #>> '{selections,1}', '')::smallint
                  ) is not distinct from ee2.horse_number
                  and coalesce(
                    nullif(it ->> 'third_horse_number', '')::smallint,
                    nullif(it #>> '{selections,2}', '')::smallint
                  ) is not distinct from ee3.horse_number
                  and (it ->> 'memo') is not distinct from et.memo
              )
          )
        ) into v_tickets_changed;

        if v_tickets_changed then
          delete from public.bet_tickets where slip_id = v_slip_id;

          for v_child in select value from jsonb_array_elements(v_item -> 'tickets') loop
          v_no1 := coalesce(
            nullif(v_child ->> 'first_horse_number', '')::smallint,
            nullif(v_child #>> '{selections,0}', '')::smallint
          );
          v_no2 := coalesce(
            nullif(v_child ->> 'second_horse_number', '')::smallint,
            nullif(v_child #>> '{selections,1}', '')::smallint
          );
          v_no3 := coalesce(
            nullif(v_child ->> 'third_horse_number', '')::smallint,
            nullif(v_child #>> '{selections,2}', '')::smallint
          );

          select id into v_entry1 from public.race_entries
          where race_id = v_race_id and horse_number = v_no1;
          if v_entry1 is null then
            raise exception 'Unknown first ticket horse number: %', v_no1;
          end if;
          v_entry2 := null;
          v_entry3 := null;
          if v_no2 is not null then
            select id into v_entry2 from public.race_entries
            where race_id = v_race_id and horse_number = v_no2;
            if v_entry2 is null then
              raise exception 'Unknown second ticket horse number: %', v_no2;
            end if;
          end if;
          if v_no3 is not null then
            select id into v_entry3 from public.race_entries
            where race_id = v_race_id and horse_number = v_no3;
            if v_entry3 is null then
              raise exception 'Unknown third ticket horse number: %', v_no3;
            end if;
          end if;

          -- Canonicalize unordered products so duplicate detection and payout
          -- matching work regardless of client selection order.
          if (v_child ->> 'bet_type')::public.bet_type in ('quinella', 'wide')
             and v_no1 > v_no2 then
            v_tmp_entry := v_entry1; v_entry1 := v_entry2; v_entry2 := v_tmp_entry;
            v_tmp_no := v_no1; v_no1 := v_no2; v_no2 := v_tmp_no;
          end if;
          if (v_child ->> 'bet_type')::public.bet_type = 'trio' then
            if v_no1 > v_no2 then
              v_tmp_entry := v_entry1; v_entry1 := v_entry2; v_entry2 := v_tmp_entry;
              v_tmp_no := v_no1; v_no1 := v_no2; v_no2 := v_tmp_no;
            end if;
            if v_no2 > v_no3 then
              v_tmp_entry := v_entry2; v_entry2 := v_entry3; v_entry3 := v_tmp_entry;
              v_tmp_no := v_no2; v_no2 := v_no3; v_no3 := v_tmp_no;
            end if;
            if v_no1 > v_no2 then
              v_tmp_entry := v_entry1; v_entry1 := v_entry2; v_entry2 := v_tmp_entry;
            end if;
          end if;

            insert into public.bet_tickets (
            slip_id, bet_type, first_entry_id, second_entry_id, third_entry_id,
            stake_yen, memo
          ) values (
            v_slip_id,
            (v_child ->> 'bet_type')::public.bet_type,
            v_entry1,
            v_entry2,
            v_entry3,
            coalesce(
              nullif(v_child ->> 'stake_yen', '')::integer,
              nullif(v_child ->> 'unit_amount_yen', '')::integer,
              100
            ),
            v_child ->> 'memo'
            );
          end loop;
        end if;
      end if;
    end loop;
  end if;

  v_result_json := payload -> 'result';
  if v_result_json is not null and jsonb_typeof(v_result_json) = 'object' then
    select id, status into v_result_id, v_result_status
    from public.race_results where race_id = v_race_id;
    v_result_status := coalesce(
      nullif(v_result_json ->> 'status', '')::public.result_status,
      v_result_status,
      'provisional'
    );

    if v_result_id is null then
      insert into public.race_results (race_id, status, official_at, memo)
      values (
        v_race_id,
        v_result_status,
        case when v_result_status = 'official'
          then coalesce(nullif(v_result_json ->> 'official_at', '')::timestamptz, now())
        end,
        v_result_json ->> 'memo'
      ) returning id into v_result_id;
    else
      update public.race_results
      set status = v_result_status,
          official_at = case when v_result_status = 'official'
            then coalesce(nullif(v_result_json ->> 'official_at', '')::timestamptz, official_at, now())
            else null
          end,
          memo = coalesce(v_result_json ->> 'memo', memo)
      where id = v_result_id;
    end if;

    if v_result_json ? 'finishers' then
      if jsonb_typeof(v_result_json -> 'finishers') <> 'array' then
        raise exception 'result.finishers must be an array';
      end if;
      delete from public.race_finishers where race_result_id = v_result_id;
      for v_item in select value from jsonb_array_elements(v_result_json -> 'finishers') loop
        select id into v_entry1 from public.race_entries
        where race_id = v_race_id and horse_number = (v_item ->> 'horse_number')::smallint;
        if v_entry1 is null then
          raise exception 'Unknown finisher horse number: %', v_item ->> 'horse_number';
        end if;
        insert into public.race_finishers (
          race_result_id, race_entry_id, finish_position, finish_note
        ) values (
          v_result_id,
          v_entry1,
          nullif(v_item ->> 'finish_position', '')::smallint,
          v_item ->> 'finish_note'
        );
      end loop;
    end if;

    if v_result_json ? 'payouts' then
      if jsonb_typeof(v_result_json -> 'payouts') <> 'array' then
        raise exception 'result.payouts must be an array';
      end if;
      delete from public.payouts where race_result_id = v_result_id;
      for v_item in select value from jsonb_array_elements(v_result_json -> 'payouts') loop
        v_no1 := coalesce(
          nullif(v_item ->> 'first_horse_number', '')::smallint,
          nullif(v_item #>> '{selections,0}', '')::smallint
        );
        v_no2 := coalesce(
          nullif(v_item ->> 'second_horse_number', '')::smallint,
          nullif(v_item #>> '{selections,1}', '')::smallint
        );
        v_no3 := coalesce(
          nullif(v_item ->> 'third_horse_number', '')::smallint,
          nullif(v_item #>> '{selections,2}', '')::smallint
        );
        select id into v_entry1 from public.race_entries
        where race_id = v_race_id and horse_number = v_no1;
        v_entry2 := null; v_entry3 := null;
        if v_no2 is not null then
          select id into v_entry2 from public.race_entries
          where race_id = v_race_id and horse_number = v_no2;
        end if;
        if v_no3 is not null then
          select id into v_entry3 from public.race_entries
          where race_id = v_race_id and horse_number = v_no3;
        end if;
        if v_entry1 is null or (v_no2 is not null and v_entry2 is null)
          or (v_no3 is not null and v_entry3 is null) then
          raise exception 'Payout contains an unknown horse number';
        end if;

        if (v_item ->> 'bet_type')::public.bet_type in ('quinella', 'wide')
           and v_no1 > v_no2 then
          v_tmp_entry := v_entry1; v_entry1 := v_entry2; v_entry2 := v_tmp_entry;
          v_tmp_no := v_no1; v_no1 := v_no2; v_no2 := v_tmp_no;
        end if;
        if (v_item ->> 'bet_type')::public.bet_type = 'trio' then
          if v_no1 > v_no2 then
            v_tmp_entry := v_entry1; v_entry1 := v_entry2; v_entry2 := v_tmp_entry;
            v_tmp_no := v_no1; v_no1 := v_no2; v_no2 := v_tmp_no;
          end if;
          if v_no2 > v_no3 then
            v_tmp_entry := v_entry2; v_entry2 := v_entry3; v_entry3 := v_tmp_entry;
            v_tmp_no := v_no2; v_no2 := v_no3; v_no3 := v_tmp_no;
          end if;
          if v_no1 > v_no2 then
            v_tmp_entry := v_entry1; v_entry1 := v_entry2; v_entry2 := v_tmp_entry;
          end if;
        end if;

        insert into public.payouts (
          race_result_id, bet_type, first_entry_id, second_entry_id,
          third_entry_id, payout_per_100_yen
        ) values (
          v_result_id,
          (v_item ->> 'bet_type')::public.bet_type,
          v_entry1,
          v_entry2,
          v_entry3,
          (v_item ->> 'payout_per_100_yen')::integer
        );
      end loop;
    end if;
  end if;

  v_reflection_json := payload -> 'reflection';
  if v_reflection_json is not null and jsonb_typeof(v_reflection_json) = 'object' then
    insert into public.race_reflections (
      race_id, prediction_id, grade, what_worked, what_failed,
      next_action, memo
    ) values (
      v_race_id,
      coalesce(nullif(v_reflection_json ->> 'prediction_id', '')::uuid, v_prediction_id),
      coalesce(nullif(v_reflection_json ->> 'grade', '')::public.reflection_grade, 'neutral'),
      v_reflection_json ->> 'what_worked',
      v_reflection_json ->> 'what_failed',
      v_reflection_json ->> 'next_action',
      v_reflection_json ->> 'memo'
    )
    on conflict (race_id) do update set
      prediction_id = coalesce(excluded.prediction_id, race_reflections.prediction_id),
      grade = excluded.grade,
      what_worked = excluded.what_worked,
      what_failed = excluded.what_failed,
      next_action = excluded.next_action,
      memo = excluded.memo
    returning id into v_reflection_id;

    if v_reflection_json ? 'categories' then
      if jsonb_typeof(v_reflection_json -> 'categories') <> 'array' then
        raise exception 'reflection.categories must be an array';
      end if;
      delete from public.race_reflection_tags where reflection_id = v_reflection_id;
      for v_item in select value from jsonb_array_elements(v_reflection_json -> 'categories') loop
        insert into public.race_reflection_tags (reflection_id, category_id, note)
        select v_reflection_id, c.id, v_item ->> 'note'
        from public.reflection_categories c
        where c.code = case
          when jsonb_typeof(v_item) = 'string' then v_item #>> '{}'
          else v_item ->> 'code'
        end
        on conflict (reflection_id, category_id) do update set note = excluded.note;
        if not found then
          raise exception 'Unknown reflection category: %', v_item ->> 'code';
        end if;
      end loop;
    end if;
  end if;

  -- Lock only after the complete future-race draft (selections and proposal
  -- tickets included) has been assembled in this transaction.
  if v_lock_after_upsert then
    update public.predictions
    set status = 'locked', locked_at = clock_timestamp()
    where id = v_prediction_id and status = 'draft';
  end if;

  return public.build_race_record(v_race_id);
end;
$$;

revoke all on function public.build_race_record(uuid) from public;
revoke all on function public.get_race_record(uuid) from public;
revoke all on function public.get_race_records() from public;
revoke all on function public.upsert_race_record(jsonb) from public;
grant execute on function public.build_race_record(uuid) to authenticated;
grant execute on function public.get_race_record(uuid) to authenticated;
grant execute on function public.get_race_records() to authenticated;
grant execute on function public.upsert_race_record(jsonb) to authenticated;

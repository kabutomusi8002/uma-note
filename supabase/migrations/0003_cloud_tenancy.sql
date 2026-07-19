-- Direct tenant ownership for every user-owned row.
-- Shared catalog tables (racecourses and reflection_categories) intentionally
-- remain tenant-neutral and authenticated-read-only.

-- ---------------------------------------------------------------------------
-- Add and backfill user_id without changing the legacy owner_id/id contract.
-- Keeping the legacy columns during this forward migration allows old read
-- models to continue working while the application moves to the sync RPCs.
-- ---------------------------------------------------------------------------

alter table public.profiles add column if not exists user_id uuid;
alter table public.prediction_rule_sets add column if not exists user_id uuid;
alter table public.prediction_rule_versions add column if not exists user_id uuid;
alter table public.race_meetings add column if not exists user_id uuid;
alter table public.races add column if not exists user_id uuid;
alter table public.race_entries add column if not exists user_id uuid;
alter table public.predictions add column if not exists user_id uuid;
alter table public.prediction_horse_selections add column if not exists user_id uuid;
alter table public.prediction_revisions add column if not exists user_id uuid;
alter table public.bet_slips add column if not exists user_id uuid;
alter table public.bet_tickets add column if not exists user_id uuid;
alter table public.race_results add column if not exists user_id uuid;
alter table public.race_finishers add column if not exists user_id uuid;
alter table public.payouts add column if not exists user_id uuid;
alter table public.race_reflections add column if not exists user_id uuid;
alter table public.race_reflection_tags add column if not exists user_id uuid;
alter table public.race_exchange_documents add column if not exists user_id uuid;

update public.profiles
set user_id = id
where user_id is null;

update public.prediction_rule_sets
set user_id = owner_id
where user_id is null;

update public.prediction_rule_versions rv
set user_id = rs.user_id
from public.prediction_rule_sets rs
where rv.rule_set_id = rs.id and rv.user_id is null;

update public.race_meetings
set user_id = owner_id
where user_id is null;

update public.races r
set user_id = m.user_id
from public.race_meetings m
where r.meeting_id = m.id and r.user_id is null;

update public.race_entries e
set user_id = r.user_id
from public.races r
where e.race_id = r.id and e.user_id is null;

update public.predictions p
set user_id = r.user_id
from public.races r
where p.race_id = r.id and p.user_id is null;

update public.prediction_horse_selections s
set user_id = p.user_id
from public.predictions p
where s.prediction_id = p.id and s.user_id is null;

update public.prediction_revisions
set user_id = owner_id
where user_id is null;

update public.bet_slips s
set user_id = r.user_id
from public.races r
where s.race_id = r.id and s.user_id is null;

update public.bet_tickets t
set user_id = s.user_id
from public.bet_slips s
where t.slip_id = s.id and t.user_id is null;

update public.race_results rr
set user_id = r.user_id
from public.races r
where rr.race_id = r.id and rr.user_id is null;

update public.race_finishers f
set user_id = rr.user_id
from public.race_results rr
where f.race_result_id = rr.id and f.user_id is null;

update public.payouts p
set user_id = rr.user_id
from public.race_results rr
where p.race_result_id = rr.id and p.user_id is null;

update public.race_reflections rf
set user_id = r.user_id
from public.races r
where rf.race_id = r.id and rf.user_id is null;

update public.race_reflection_tags t
set user_id = rf.user_id
from public.race_reflections rf
where t.reflection_id = rf.id and t.user_id is null;

update public.race_exchange_documents
set user_id = owner_id
where user_id is null;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'profiles',
    'prediction_rule_sets',
    'prediction_rule_versions',
    'race_meetings',
    'races',
    'race_entries',
    'predictions',
    'prediction_horse_selections',
    'prediction_revisions',
    'bet_slips',
    'bet_tickets',
    'race_results',
    'race_finishers',
    'payouts',
    'race_reflections',
    'race_reflection_tags',
    'race_exchange_documents'
  ] loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = v_table
        and column_name = 'user_id'
        and is_nullable = 'YES'
    ) then
      execute format(
        'alter table public.%I alter column user_id set not null',
        v_table
      );
    end if;
    execute format(
      'alter table public.%I alter column user_id set default auth.uid()',
      v_table
    );
  end loop;
end
$$;

-- The legacy owner columns remain canonical aliases during the transition.
do $$
declare
  v_item record;
begin
  for v_item in
    select * from (values
      ('profiles', 'profiles_user_id_matches_id', 'user_id = id'),
      ('prediction_rule_sets', 'prediction_rule_sets_user_owner_match', 'user_id = owner_id'),
      ('race_meetings', 'race_meetings_user_owner_match', 'user_id = owner_id'),
      ('prediction_revisions', 'prediction_revisions_user_owner_match', 'user_id = owner_id'),
      ('race_exchange_documents', 'race_exchange_documents_user_owner_match', 'user_id = owner_id')
    ) as x(table_name, constraint_name, expression)
  loop
    if not exists (
      select 1 from pg_constraint
      where conrelid = format('public.%I', v_item.table_name)::regclass
        and conname = v_item.constraint_name
    ) then
      execute format(
        'alter table public.%I add constraint %I check (%s) not valid',
        v_item.table_name,
        v_item.constraint_name,
        v_item.expression
      );
    end if;
    execute format(
      'alter table public.%I validate constraint %I',
      v_item.table_name,
      v_item.constraint_name
    );
  end loop;
end
$$;

-- Every referenced user-owned parent exposes a tenant-qualified candidate key.
create unique index if not exists profiles_user_id_id_uidx
  on public.profiles(user_id, id);
create unique index if not exists prediction_rule_sets_user_id_id_uidx
  on public.prediction_rule_sets(user_id, id);
create unique index if not exists prediction_rule_versions_user_id_id_uidx
  on public.prediction_rule_versions(user_id, id);
create unique index if not exists race_meetings_user_id_id_uidx
  on public.race_meetings(user_id, id);
create unique index if not exists races_user_id_id_uidx
  on public.races(user_id, id);
create unique index if not exists race_entries_user_id_id_uidx
  on public.race_entries(user_id, id);
create unique index if not exists predictions_user_id_id_uidx
  on public.predictions(user_id, id);
create unique index if not exists prediction_horse_selections_user_id_id_uidx
  on public.prediction_horse_selections(user_id, id);
create unique index if not exists prediction_revisions_user_id_id_uidx
  on public.prediction_revisions(user_id, id);
create unique index if not exists bet_slips_user_id_id_uidx
  on public.bet_slips(user_id, id);
create unique index if not exists bet_tickets_user_id_id_uidx
  on public.bet_tickets(user_id, id);
create unique index if not exists race_results_user_id_id_uidx
  on public.race_results(user_id, id);
create unique index if not exists race_finishers_user_id_id_uidx
  on public.race_finishers(user_id, id);
create unique index if not exists payouts_user_id_id_uidx
  on public.payouts(user_id, id);
create unique index if not exists race_reflections_user_id_id_uidx
  on public.race_reflections(user_id, id);
create unique index if not exists race_reflection_tags_user_key_uidx
  on public.race_reflection_tags(user_id, reflection_id, category_id);
create unique index if not exists race_exchange_documents_user_id_id_uidx
  on public.race_exchange_documents(user_id, id);

-- Composite foreign keys make a cross-tenant parent reference structurally
-- impossible even for table owners and future server-side functions.
do $$
declare
  v_item record;
begin
  for v_item in
    select * from (values
      ('prediction_rule_versions', 'prediction_rule_versions_user_rule_set_fk',
        'foreign key (user_id, rule_set_id) references public.prediction_rule_sets(user_id, id) on delete cascade'),
      ('races', 'races_user_meeting_fk',
        'foreign key (user_id, meeting_id) references public.race_meetings(user_id, id) on delete cascade'),
      ('race_entries', 'race_entries_user_race_fk',
        'foreign key (user_id, race_id) references public.races(user_id, id) on delete cascade'),
      ('predictions', 'predictions_user_race_fk',
        'foreign key (user_id, race_id) references public.races(user_id, id) on delete cascade'),
      ('predictions', 'predictions_user_rule_version_fk',
        'foreign key (user_id, rule_version_id) references public.prediction_rule_versions(user_id, id) on delete no action deferrable initially deferred'),
      ('prediction_horse_selections', 'prediction_selections_user_prediction_fk',
        'foreign key (user_id, prediction_id) references public.predictions(user_id, id) on delete cascade'),
      ('prediction_horse_selections', 'prediction_selections_user_entry_fk',
        'foreign key (user_id, race_entry_id) references public.race_entries(user_id, id) on delete cascade'),
      ('bet_slips', 'bet_slips_user_race_fk',
        'foreign key (user_id, race_id) references public.races(user_id, id) on delete cascade'),
      ('bet_slips', 'bet_slips_user_prediction_fk',
        'foreign key (user_id, prediction_id) references public.predictions(user_id, id) on delete no action deferrable initially deferred'),
      ('bet_tickets', 'bet_tickets_user_slip_fk',
        'foreign key (user_id, slip_id) references public.bet_slips(user_id, id) on delete cascade'),
      ('bet_tickets', 'bet_tickets_user_first_entry_fk',
        'foreign key (user_id, first_entry_id) references public.race_entries(user_id, id) on delete no action deferrable initially deferred'),
      ('bet_tickets', 'bet_tickets_user_second_entry_fk',
        'foreign key (user_id, second_entry_id) references public.race_entries(user_id, id) on delete no action deferrable initially deferred'),
      ('bet_tickets', 'bet_tickets_user_third_entry_fk',
        'foreign key (user_id, third_entry_id) references public.race_entries(user_id, id) on delete no action deferrable initially deferred'),
      ('race_results', 'race_results_user_race_fk',
        'foreign key (user_id, race_id) references public.races(user_id, id) on delete cascade'),
      ('race_finishers', 'race_finishers_user_result_fk',
        'foreign key (user_id, race_result_id) references public.race_results(user_id, id) on delete cascade'),
      ('race_finishers', 'race_finishers_user_entry_fk',
        'foreign key (user_id, race_entry_id) references public.race_entries(user_id, id) on delete no action deferrable initially deferred'),
      ('payouts', 'payouts_user_result_fk',
        'foreign key (user_id, race_result_id) references public.race_results(user_id, id) on delete cascade'),
      ('payouts', 'payouts_user_first_entry_fk',
        'foreign key (user_id, first_entry_id) references public.race_entries(user_id, id) on delete no action deferrable initially deferred'),
      ('payouts', 'payouts_user_second_entry_fk',
        'foreign key (user_id, second_entry_id) references public.race_entries(user_id, id) on delete no action deferrable initially deferred'),
      ('payouts', 'payouts_user_third_entry_fk',
        'foreign key (user_id, third_entry_id) references public.race_entries(user_id, id) on delete no action deferrable initially deferred'),
      ('race_reflections', 'race_reflections_user_race_fk',
        'foreign key (user_id, race_id) references public.races(user_id, id) on delete cascade'),
      ('race_reflections', 'race_reflections_user_prediction_fk',
        'foreign key (user_id, prediction_id) references public.predictions(user_id, id) on delete no action deferrable initially deferred'),
      ('race_reflection_tags', 'race_reflection_tags_user_reflection_fk',
        'foreign key (user_id, reflection_id) references public.race_reflections(user_id, id) on delete cascade'),
      ('race_exchange_documents', 'race_exchange_documents_user_race_fk',
        'foreign key (user_id, race_id) references public.races(user_id, id) on delete no action deferrable initially deferred')
    ) as x(table_name, constraint_name, definition)
  loop
    if not exists (
      select 1 from pg_constraint
      where conrelid = format('public.%I', v_item.table_name)::regclass
        and conname = v_item.constraint_name
    ) then
      execute format(
        'alter table public.%I add constraint %I %s not valid',
        v_item.table_name,
        v_item.constraint_name,
        v_item.definition
      );
    end if;
    execute format(
      'alter table public.%I validate constraint %I',
      v_item.table_name,
      v_item.constraint_name
    );
  end loop;
end
$$;

-- user_id is an immutable ownership attribute.
create or replace function public.protect_user_id()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
    raise exception using
      errcode = '42501',
      message = format('%s.user_id is immutable', tg_table_name);
  end if;
  return new;
end;
$$;

do $$
declare
  v_table text;
  v_trigger text;
begin
  foreach v_table in array array[
    'profiles',
    'prediction_rule_sets',
    'prediction_rule_versions',
    'race_meetings',
    'races',
    'race_entries',
    'predictions',
    'prediction_horse_selections',
    'prediction_revisions',
    'bet_slips',
    'bet_tickets',
    'race_results',
    'race_finishers',
    'payouts',
    'race_reflections',
    'race_reflection_tags',
    'race_exchange_documents'
  ] loop
    v_trigger := v_table || '_protect_user_id';
    if not exists (
      select 1 from pg_trigger
      where tgrelid = format('public.%I', v_table)::regclass
        and tgname = v_trigger
        and not tgisinternal
    ) then
      execute format(
        'create trigger %I before update of user_id on public.%I for each row execute function public.protect_user_id()',
        v_trigger,
        v_table
      );
    end if;
  end loop;
end
$$;

-- auth.users inserts do not carry a request JWT, so the profile trigger must
-- copy NEW.id explicitly instead of relying on the auth.uid() column default.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, user_id, display_name)
  values (new.id, new.id, nullif(new.raw_user_meta_data ->> 'display_name', ''))
  on conflict (id) do update
    set user_id = excluded.user_id;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Direct-user RLS. Ownership is no longer inferred through a mutable join.
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
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
alter table public.race_reflections enable row level security;
alter table public.race_reflection_tags enable row level security;
alter table public.race_exchange_documents enable row level security;
alter table public.racecourses enable row level security;
alter table public.reflection_categories enable row level security;

drop policy if exists profiles_owner_all on public.profiles;
drop policy if exists prediction_rule_sets_owner_all on public.prediction_rule_sets;
drop policy if exists prediction_rule_versions_owner_all on public.prediction_rule_versions;
drop policy if exists race_meetings_owner_all on public.race_meetings;
drop policy if exists races_owner_all on public.races;
drop policy if exists race_entries_owner_all on public.race_entries;
drop policy if exists predictions_owner_all on public.predictions;
drop policy if exists prediction_horse_selections_owner_all on public.prediction_horse_selections;
drop policy if exists prediction_revisions_owner_read on public.prediction_revisions;
drop policy if exists prediction_revisions_owner_import on public.prediction_revisions;
drop policy if exists bet_slips_owner_all on public.bet_slips;
drop policy if exists bet_tickets_owner_all on public.bet_tickets;
drop policy if exists race_results_owner_all on public.race_results;
drop policy if exists race_finishers_owner_all on public.race_finishers;
drop policy if exists payouts_owner_all on public.payouts;
drop policy if exists race_reflections_owner_all on public.race_reflections;
drop policy if exists race_reflection_tags_owner_all on public.race_reflection_tags;
drop policy if exists race_exchange_documents_owner_all on public.race_exchange_documents;

drop policy if exists profiles_self_all on public.profiles;
create policy profiles_self_all on public.profiles
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists prediction_rule_sets_self_all on public.prediction_rule_sets;
create policy prediction_rule_sets_self_all on public.prediction_rule_sets
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists prediction_rule_versions_self_all on public.prediction_rule_versions;
create policy prediction_rule_versions_self_all on public.prediction_rule_versions
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists race_meetings_self_all on public.race_meetings;
create policy race_meetings_self_all on public.race_meetings
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists races_self_all on public.races;
create policy races_self_all on public.races
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists race_entries_self_all on public.race_entries;
create policy race_entries_self_all on public.race_entries
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists predictions_self_all on public.predictions;
create policy predictions_self_all on public.predictions
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists prediction_horse_selections_self_all on public.prediction_horse_selections;
create policy prediction_horse_selections_self_all on public.prediction_horse_selections
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists prediction_revisions_self_read on public.prediction_revisions;
create policy prediction_revisions_self_read on public.prediction_revisions
for select to authenticated
using (user_id = (select auth.uid()));

-- Retain the narrowly scoped legacy import path until 0004 revokes direct DML.
drop policy if exists prediction_revisions_self_import on public.prediction_revisions;
create policy prediction_revisions_self_import on public.prediction_revisions
for insert to authenticated
with check (
  user_id = (select auth.uid())
  and owner_id = (select auth.uid())
  and changed_by = (select auth.uid())
  and entity_type = 'imported_snapshot'
  and operation = 'IMPORT'
  and exists (
    select 1 from public.predictions p
    where p.id = prediction_revisions.prediction_id
      and p.user_id = (select auth.uid())
      and p.race_id = prediction_revisions.race_id
      and p.created_at = transaction_timestamp()
  )
);

drop policy if exists bet_slips_self_all on public.bet_slips;
create policy bet_slips_self_all on public.bet_slips
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists bet_tickets_self_all on public.bet_tickets;
create policy bet_tickets_self_all on public.bet_tickets
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists race_results_self_all on public.race_results;
create policy race_results_self_all on public.race_results
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists race_finishers_self_all on public.race_finishers;
create policy race_finishers_self_all on public.race_finishers
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists payouts_self_all on public.payouts;
create policy payouts_self_all on public.payouts
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists race_reflections_self_all on public.race_reflections;
create policy race_reflections_self_all on public.race_reflections
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists race_reflection_tags_self_all on public.race_reflection_tags;
create policy race_reflection_tags_self_all on public.race_reflection_tags
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists race_exchange_documents_self_all on public.race_exchange_documents;
create policy race_exchange_documents_self_all on public.race_exchange_documents
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists racecourses_authenticated_read on public.racecourses;
create policy racecourses_authenticated_read on public.racecourses
for select to authenticated using (true);

drop policy if exists reflection_categories_authenticated_read on public.reflection_categories;
create policy reflection_categories_authenticated_read on public.reflection_categories
for select to authenticated using (true);

revoke all on public.racecourses, public.reflection_categories from anon;
revoke all on public.racecourses, public.reflection_categories from public;
revoke insert, update, delete on public.racecourses, public.reflection_categories from authenticated;
grant select on public.racecourses, public.reflection_categories to authenticated;

revoke all on function public.protect_user_id() from public;
revoke all on function public.handle_new_auth_user() from public;

comment on column public.races.user_id is
  'Direct immutable tenant owner; all child references are tenant-qualified.';

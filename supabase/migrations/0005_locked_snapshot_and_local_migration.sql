-- Immutable prediction lock evidence and resumable local-clean migration.

-- ---------------------------------------------------------------------------
-- Complete locked snapshot.
-- ---------------------------------------------------------------------------

create table if not exists public.prediction_locked_snapshots (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  race_id uuid not null,
  prediction_id uuid not null,
  schema_version integer not null default 1,
  snapshot jsonb not null,
  snapshot_sha256 bytea not null,
  locked_at timestamptz not null,
  lock_mutation_id uuid,
  locked_by_device_id uuid,
  source text not null default 'lock_rpc',
  created_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, prediction_id),
  unique (user_id, race_id),
  constraint prediction_locked_snapshots_user_race_fk
    foreign key (user_id, race_id)
    references public.races(user_id, id)
    on delete cascade,
  constraint prediction_locked_snapshots_user_prediction_fk
    foreign key (user_id, prediction_id)
    references public.predictions(user_id, id)
    on delete cascade,
  constraint prediction_locked_snapshots_user_device_fk
    foreign key (user_id, locked_by_device_id)
    references public.sync_devices(user_id, id)
    on delete no action deferrable initially deferred,
  constraint prediction_locked_snapshots_schema_positive check (schema_version > 0),
  constraint prediction_locked_snapshots_object check (jsonb_typeof(snapshot) = 'object'),
  constraint prediction_locked_snapshots_hash_shape check (octet_length(snapshot_sha256) = 32),
  constraint prediction_locked_snapshots_source check (
    source in ('lock_rpc', 'local_migration', 'legacy_backfill')
  )
);

create index if not exists prediction_locked_snapshots_user_created_idx
  on public.prediction_locked_snapshots(user_id, created_at desc);

create trigger prediction_locked_snapshots_protect_user_id
before update of user_id on public.prediction_locked_snapshots
for each row execute function public.protect_user_id();

alter table public.prediction_locked_snapshots enable row level security;

create policy prediction_locked_snapshots_self_read
on public.prediction_locked_snapshots
for select to authenticated
using (user_id = (select auth.uid()));

-- A client may explicitly lock while offline and reconnect only after post
-- time. That evidence cannot be reconstructed from the mutable relational
-- prediction, so it is retained separately with its provenance intact.
create table if not exists public.offline_prediction_locked_snapshots (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  race_id uuid not null,
  schema_version integer not null default 1,
  snapshot jsonb not null,
  snapshot_sha256 bytea not null,
  locked_at timestamptz not null,
  lock_mutation_id uuid not null,
  locked_by_device_id uuid not null,
  source text not null default 'offline_explicit_lock',
  created_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, race_id),
  unique (user_id, lock_mutation_id),
  constraint offline_prediction_locked_snapshots_user_race_fk
    foreign key (user_id, race_id)
    references public.races(user_id, id)
    on delete cascade,
  constraint offline_prediction_locked_snapshots_user_device_fk
    foreign key (user_id, locked_by_device_id)
    references public.sync_devices(user_id, id)
    on delete no action deferrable initially deferred,
  constraint offline_prediction_locked_snapshots_schema check (schema_version = 1),
  constraint offline_prediction_locked_snapshots_object
    check (jsonb_typeof(snapshot) = 'object'),
  constraint offline_prediction_locked_snapshots_hash_shape
    check (octet_length(snapshot_sha256) = 32),
  constraint offline_prediction_locked_snapshots_source
    check (source in ('offline_explicit_lock', 'legacy_local_upgrade'))
);

create index if not exists offline_prediction_locked_snapshots_user_created_idx
  on public.offline_prediction_locked_snapshots(user_id, created_at desc);

create trigger offline_prediction_locked_snapshots_protect_user_id
before update of user_id on public.offline_prediction_locked_snapshots
for each row execute function public.protect_user_id();

alter table public.offline_prediction_locked_snapshots enable row level security;

create policy offline_prediction_locked_snapshots_self_read
on public.offline_prediction_locked_snapshots
for select to authenticated
using (user_id = (select auth.uid()));

-- A canonical JSON document. Arrays have explicit deterministic ordering, and
-- post-race mutable entities (actual slips, result, payouts, reflection) are
-- deliberately excluded from the lock evidence.
create or replace function public.build_complete_prediction_snapshot(
  p_prediction_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'schema_version', 1,
    'race', jsonb_build_object(
      'id', r.id,
      'racecourse', jsonb_build_object(
        'code', c.code,
        'name_ja', c.name_ja
      ),
      'meeting_date', m.meeting_date,
      'meeting_number', m.meeting_number,
      'race_number', r.race_number,
      'starts_at', r.starts_at,
      'name', r.name,
      'grade', r.grade,
      'surface', r.surface,
      'distance_m', r.distance_m
    ),
    'prediction', jsonb_build_object(
      'id', p.id,
      'rule_version_id', p.rule_version_id,
      'rule_snapshot', p.rule_snapshot,
      'source', p.source,
      'pace', p.pace,
      'pace_scenario', p.pace_scenario,
      'observed_going', p.observed_going,
      'track_bias', p.track_bias,
      'decision', p.decision,
      'confidence', p.confidence,
      'summary', p.summary,
      'created_at', p.created_at
    ),
    'horse_selections', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'horse_number', e.horse_number,
          'bracket_number', e.bracket_number,
          'horse_name', e.horse_name,
          'jockey_name', e.jockey_name,
          'popularity', e.popularity,
          'win_odds', e.win_odds,
          'is_scratched', e.is_scratched,
          'mark', s.mark,
          'is_selected', s.is_selected,
          'is_key', s.is_key,
          'is_dangerous_favorite', s.is_dangerous_favorite,
          'is_longshot', s.is_longshot,
          'expected_position', s.expected_position,
          'evaluation', s.evaluation
        ) order by e.horse_number, s.id
      )
      from public.prediction_horse_selections s
      join public.race_entries e
        on e.user_id = s.user_id and e.id = s.race_entry_id
      where s.user_id = p.user_id and s.prediction_id = p.id
    ), '[]'::jsonb),
    'proposal_slips', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', s.id,
          'client_key', s.client_key,
          'title', s.title,
          'memo', s.memo,
          'tickets', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', t.id,
                'bet_type', t.bet_type,
                'first_horse_number', e1.horse_number,
                'second_horse_number', e2.horse_number,
                'third_horse_number', e3.horse_number,
                'stake_yen', t.stake_yen,
                'memo', t.memo
              ) order by
                t.bet_type,
                e1.horse_number,
                e2.horse_number nulls first,
                e3.horse_number nulls first,
                t.id
            )
            from public.bet_tickets t
            join public.race_entries e1
              on e1.user_id = t.user_id and e1.id = t.first_entry_id
            left join public.race_entries e2
              on e2.user_id = t.user_id and e2.id = t.second_entry_id
            left join public.race_entries e3
              on e3.user_id = t.user_id and e3.id = t.third_entry_id
            where t.user_id = s.user_id and t.slip_id = s.id
          ), '[]'::jsonb)
        ) order by s.client_key nulls first, s.id
      )
      from public.bet_slips s
      where s.user_id = p.user_id
        and s.prediction_id = p.id
        and s.kind = 'proposal'
    ), '[]'::jsonb)
  )
  from public.predictions p
  join public.races r
    on r.user_id = p.user_id and r.id = p.race_id
  join public.race_meetings m
    on m.user_id = r.user_id and m.id = r.meeting_id
  join public.racecourses c on c.id = m.racecourse_id
  where p.id = p_prediction_id;
$$;

create or replace function public.protect_locked_snapshot()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and auth.uid() is null then
    -- Permit service-role account erasure/cascade while preventing a signed-in
    -- user from selectively deleting evidence.
    return old;
  end if;
  raise exception using
    errcode = '55000',
    message = 'A locked prediction snapshot is immutable';
end;
$$;

create or replace function public.validate_locked_snapshot_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prediction public.predictions%rowtype;
  v_canonical jsonb;
begin
  select * into v_prediction
  from public.predictions
  where id = new.prediction_id;
  if not found
     or v_prediction.user_id <> new.user_id
     or v_prediction.race_id <> new.race_id
     or v_prediction.status <> 'locked'
     or v_prediction.locked_at is distinct from new.locked_at then
    raise exception using
      errcode = '23514',
      message = 'Locked snapshot does not match a locked prediction';
  end if;

  v_canonical := public.build_complete_prediction_snapshot(new.prediction_id);
  if new.snapshot is distinct from v_canonical
     or new.snapshot_sha256 <> extensions.digest(v_canonical::text, 'sha256') then
    raise exception using
      errcode = '23514',
      message = 'Locked snapshot or hash is not canonical';
  end if;
  return new;
end;
$$;

create trigger prediction_locked_snapshots_validate_insert
before insert on public.prediction_locked_snapshots
for each row execute function public.validate_locked_snapshot_insert();

create trigger prediction_locked_snapshots_immutable
before update or delete on public.prediction_locked_snapshots
for each row execute function public.protect_locked_snapshot();

create trigger offline_prediction_locked_snapshots_immutable
before update or delete on public.offline_prediction_locked_snapshots
for each row execute function public.protect_locked_snapshot();

-- Existing import/write paths may set status=locked. A deferred constraint
-- trigger runs after all proposal tickets have been assembled and creates the
-- same canonical evidence before commit.
create or replace function public.ensure_locked_prediction_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prediction public.predictions%rowtype;
  v_snapshot jsonb;
  v_source text;
begin
  select * into v_prediction
  from public.predictions
  where id = new.id;

  if not found or v_prediction.status <> 'locked' then
    return null;
  end if;
  if exists (
    select 1 from public.prediction_locked_snapshots
    where prediction_id = v_prediction.id
  ) then
    return null;
  end if;

  v_snapshot := public.build_complete_prediction_snapshot(v_prediction.id);
  if v_snapshot is null then
    raise exception using errcode = '23514', message = 'Cannot build locked prediction snapshot';
  end if;
  v_source := case
    when current_setting('keiba.trusted_local_migration', true) = 'on'
      then 'local_migration'
    else 'legacy_backfill'
  end;

  insert into public.prediction_locked_snapshots (
    user_id, race_id, prediction_id, schema_version, snapshot,
    snapshot_sha256, locked_at, source
  ) values (
    v_prediction.user_id,
    v_prediction.race_id,
    v_prediction.id,
    1,
    v_snapshot,
    extensions.digest(v_snapshot::text, 'sha256'),
    v_prediction.locked_at,
    v_source
  );
  return null;
end;
$$;

create constraint trigger predictions_locked_snapshot_required
after insert or update on public.predictions
deferrable initially deferred
for each row execute function public.ensure_locked_prediction_snapshot();

-- Imported provenance is only available through the migration-item RPC below.
create or replace function public.require_trusted_prediction_import()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.source = 'import'
     and coalesce(current_setting('keiba.trusted_local_migration', true), '') <> 'on'
     and (tg_op = 'INSERT' or new.source is distinct from old.source) then
    raise exception using
      errcode = '42501',
      message = 'Imported predictions require a trusted local migration item';
  end if;
  return new;
end;
$$;

create trigger predictions_require_trusted_import
before insert or update of source on public.predictions
for each row execute function public.require_trusted_prediction_import();

-- Backfill immutable evidence for any prediction that was already locked when
-- this migration was applied. Canonical rows are inserted exactly once.
insert into public.prediction_locked_snapshots (
  user_id, race_id, prediction_id, schema_version, snapshot,
  snapshot_sha256, locked_at, source
)
select
  p.user_id,
  p.race_id,
  p.id,
  1,
  s.snapshot,
  extensions.digest(s.snapshot::text, 'sha256'),
  p.locked_at,
  'legacy_backfill'
from public.predictions p
cross join lateral (
  select public.build_complete_prediction_snapshot(p.id) as snapshot
) s
where p.status = 'locked'
  and s.snapshot is not null
  and not exists (
    select 1 from public.prediction_locked_snapshots ls
    where ls.user_id = p.user_id and ls.prediction_id = p.id
  );

create or replace function public.store_offline_prediction_lock(
  p_race_id uuid,
  p_payload jsonb,
  p_mutation_id uuid,
  p_device_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_starts_at timestamptz;
  v_meeting_date date;
  v_race_number smallint;
  v_course_code text;
  v_course_name text;
  v_snapshot jsonb;
  v_snapshot_race jsonb;
  v_snapshot_prediction jsonb;
  v_snapshot_rule jsonb;
  v_snapshot_provenance text;
  v_evidence_source text;
  v_prediction_locked_at timestamptz;
  v_snapshot_locked_at timestamptz;
  v_snapshot_hash bytea;
  v_canonical public.prediction_locked_snapshots%rowtype;
  v_existing public.offline_prediction_locked_snapshots%rowtype;
  v_inserted public.offline_prediction_locked_snapshots%rowtype;
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;
  if p_race_id is null or p_mutation_id is null or p_device_id is null
     or p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'Invalid offline lock request';
  end if;

  select
    r.starts_at,
    m.meeting_date,
    r.race_number,
    c.code,
    c.name_ja
  into
    v_starts_at,
    v_meeting_date,
    v_race_number,
    v_course_code,
    v_course_name
  from public.races r
  join public.race_meetings m
    on m.user_id = r.user_id and m.id = r.meeting_id
  join public.racecourses c on c.id = m.racecourse_id
  where r.id = p_race_id and r.user_id = v_user_id
  for update of r;
  if not found then
    raise exception using errcode = '42501', message = 'Race is not owned by the current user';
  end if;

  if not exists (
    select 1
    from public.sync_devices d
    where d.id = p_device_id
      and d.user_id = v_user_id
      and d.revoked_at is null
  ) then
    raise exception using errcode = '42501', message = 'Sync device is not active for the current user';
  end if;

  -- A canonical server-side lock is stronger evidence. A later post-time edit
  -- must reuse it rather than create or validate a redundant offline row.
  select * into v_canonical
  from public.prediction_locked_snapshots ls
  where ls.user_id = v_user_id and ls.race_id = p_race_id;
  if found then
    return jsonb_build_object(
      'status', 'canonical',
      'snapshot_id', v_canonical.id,
      'snapshot_sha256', encode(v_canonical.snapshot_sha256, 'hex'),
      'source', v_canonical.source
    );
  end if;

  if p_payload #>> '{prediction,status}' is distinct from 'locked' then
    raise exception using errcode = '22023', message = 'Offline lock does not match the server race';
  end if;

  v_snapshot := p_payload #> '{prediction,locked_snapshot}';
  if jsonb_typeof(v_snapshot) is distinct from 'object'
     or not (v_snapshot ?& array[
       'schemaVersion', 'race', 'prediction', 'proposedBets',
       'ruleVersion', 'lockedAt'
     ])
     or jsonb_typeof(v_snapshot -> 'schemaVersion') <> 'number'
     or v_snapshot ->> 'schemaVersion' <> '1'
     or jsonb_typeof(v_snapshot -> 'race') <> 'object'
     or jsonb_typeof(v_snapshot -> 'prediction') <> 'object'
     or jsonb_typeof(v_snapshot -> 'proposedBets') <> 'array'
     or jsonb_typeof(v_snapshot -> 'ruleVersion') not in ('object', 'null')
     or jsonb_typeof(v_snapshot -> 'lockedAt') <> 'string' then
    raise exception using errcode = '22023', message = 'Offline locked snapshot is incomplete';
  end if;

  v_snapshot_race := v_snapshot -> 'race';
  v_snapshot_prediction := v_snapshot -> 'prediction';
  v_snapshot_rule := v_snapshot -> 'ruleVersion';
  v_snapshot_provenance := coalesce(
    nullif(v_snapshot ->> 'provenance', ''),
    'explicit_lock'
  );
  if v_snapshot_provenance not in ('explicit_lock', 'legacy_local_upgrade') then
    raise exception using errcode = '22023', message = 'Offline lock provenance is invalid';
  end if;
  v_evidence_source := case v_snapshot_provenance
    when 'legacy_local_upgrade' then 'legacy_local_upgrade'
    else 'offline_explicit_lock'
  end;

  if not (v_snapshot_race ?& array[
       'id', 'date', 'course', 'raceNumber', 'startTime', 'name', 'dataScope'
     ])
     or jsonb_typeof(v_snapshot_race -> 'id') <> 'string'
     or jsonb_typeof(v_snapshot_race -> 'date') <> 'string'
     or jsonb_typeof(v_snapshot_race -> 'course') <> 'string'
     or jsonb_typeof(v_snapshot_race -> 'raceNumber') <> 'number'
     or jsonb_typeof(v_snapshot_race -> 'startTime') <> 'string'
     or jsonb_typeof(v_snapshot_race -> 'name') <> 'string'
     or jsonb_typeof(v_snapshot_race -> 'dataScope') <> 'string'
     or v_snapshot_race ->> 'dataScope' not in ('live', 'demo', 'test')
     or v_snapshot_race ->> 'date' !~ '^\d{4}-\d{2}-\d{2}$'
     or v_snapshot_race ->> 'raceNumber' !~ '^\d{1,2}$'
     or v_snapshot_race ->> 'startTime' !~ '^\d{2}:\d{2}$' then
    raise exception using errcode = '22023', message = 'Offline locked snapshot race is incomplete';
  end if;

  if not (v_snapshot_prediction ?& array[
       'selectedHorses', 'paceScenario', 'trackView', 'dangerousFavorites',
       'longshots', 'decision', 'note'
     ])
     or jsonb_typeof(v_snapshot_prediction -> 'selectedHorses') <> 'array'
     or jsonb_typeof(v_snapshot_prediction -> 'paceScenario') <> 'string'
     or jsonb_typeof(v_snapshot_prediction -> 'trackView') <> 'string'
     or jsonb_typeof(v_snapshot_prediction -> 'dangerousFavorites') <> 'array'
     or jsonb_typeof(v_snapshot_prediction -> 'longshots') <> 'array'
     or jsonb_typeof(v_snapshot_prediction -> 'decision') <> 'string'
     or v_snapshot_prediction ->> 'decision' not in ('buy', 'skip', 'pending')
     or jsonb_typeof(v_snapshot_prediction -> 'note') <> 'string' then
    raise exception using errcode = '22023', message = 'Offline locked snapshot prediction is incomplete';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_snapshot_prediction -> 'selectedHorses') horse
    where jsonb_typeof(horse) <> 'object'
       or not (horse ?& array['horseNumber', 'horseName', 'mark'])
       or jsonb_typeof(horse -> 'horseNumber') <> 'number'
       or jsonb_typeof(horse -> 'horseName') <> 'string'
       or jsonb_typeof(horse -> 'mark') <> 'string'
  ) or exists (
    select 1
    from jsonb_array_elements(
      (v_snapshot_prediction -> 'dangerousFavorites')
      || (v_snapshot_prediction -> 'longshots')
    ) horse_number
    where jsonb_typeof(horse_number) <> 'number'
  ) then
    raise exception using errcode = '22023', message = 'Offline locked snapshot selections are incomplete';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_snapshot -> 'proposedBets') bet
    where jsonb_typeof(bet) <> 'object'
       or not (bet ?& array['id', 'betType', 'selection', 'stakePerPoint'])
       or jsonb_typeof(bet -> 'id') <> 'string'
       or jsonb_typeof(bet -> 'betType') <> 'string'
       or bet ->> 'betType' not in ('win', 'quinella', 'wide', 'trio', 'trifecta')
       or jsonb_typeof(bet -> 'stakePerPoint') <> 'number'
       or jsonb_typeof(bet -> 'selection') <> 'object'
       or bet #>> '{selection,method}' not in ('normal', 'box', 'formation')
       or case bet #>> '{selection,method}'
         when 'normal' then jsonb_typeof(bet #> '{selection,combinations}') is distinct from 'array'
         when 'box' then jsonb_typeof(bet #> '{selection,horses}') is distinct from 'array'
         when 'formation' then jsonb_typeof(bet #> '{selection,positions}') is distinct from 'array'
         else true
       end
  ) then
    raise exception using errcode = '22023', message = 'Offline locked snapshot proposals are incomplete';
  end if;

  if jsonb_typeof(v_snapshot_rule) = 'object' and (
    not (v_snapshot_rule ?& array[
      'id', 'name', 'version', 'rules', 'createdAt', 'isActive'
    ])
    or jsonb_typeof(v_snapshot_rule -> 'id') <> 'string'
    or jsonb_typeof(v_snapshot_rule -> 'name') <> 'string'
    or jsonb_typeof(v_snapshot_rule -> 'version') <> 'string'
    or jsonb_typeof(v_snapshot_rule -> 'rules') <> 'array'
    or jsonb_typeof(v_snapshot_rule -> 'createdAt') <> 'string'
    or jsonb_typeof(v_snapshot_rule -> 'isActive') <> 'boolean'
    or exists (
      select 1 from jsonb_array_elements(v_snapshot_rule -> 'rules') rule
      where jsonb_typeof(rule) <> 'string'
    )
  ) then
    raise exception using errcode = '22023', message = 'Offline locked snapshot rule is incomplete';
  end if;

  begin
    v_prediction_locked_at := nullif(p_payload #>> '{prediction,locked_at}', '')::timestamptz;
    v_snapshot_locked_at := nullif(v_snapshot ->> 'lockedAt', '')::timestamptz;
  exception when others then
    raise exception using errcode = '22023', message = 'Offline lock timestamp is invalid';
  end;
  if v_prediction_locked_at is null
     or v_snapshot_locked_at is distinct from v_prediction_locked_at
     or not (v_snapshot_locked_at < v_starts_at) then
    raise exception using
      errcode = '22023',
      message = 'Offline lock must match prediction.locked_at and precede server post time';
  end if;

  if (v_snapshot_race ->> 'date')::date is distinct from v_meeting_date
     or v_snapshot_race ->> 'course' not in (v_course_code, v_course_name)
     or (v_snapshot_race ->> 'raceNumber')::smallint is distinct from v_race_number
     or v_snapshot_race ->> 'startTime' is distinct from
       to_char(v_starts_at at time zone 'Asia/Tokyo', 'HH24:MI') then
    raise exception using errcode = '22023', message = 'Offline snapshot race identity differs from the server race';
  end if;

  v_snapshot_hash := extensions.digest(v_snapshot::text, 'sha256');
  perform pg_advisory_xact_lock(hashtextextended(
    v_user_id::text || ':offline-lock-race:' || p_race_id::text,
    0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    v_user_id::text || ':offline-lock-mutation:' || p_mutation_id::text,
    0
  ));

  select * into v_existing
  from public.offline_prediction_locked_snapshots os
  where os.user_id = v_user_id and os.race_id = p_race_id
  for update;
  if found then
    if v_existing.snapshot_sha256 <> v_snapshot_hash
       or v_existing.snapshot is distinct from v_snapshot
       or v_existing.locked_at is distinct from v_snapshot_locked_at then
      raise exception using errcode = '55000', message = 'Offline locked snapshot is immutable';
    end if;
    return jsonb_build_object(
      'status', 'replayed',
      'snapshot_id', v_existing.id,
      'snapshot_sha256', encode(v_existing.snapshot_sha256, 'hex'),
      'source', v_existing.source
    );
  end if;

  if exists (
    select 1
    from public.offline_prediction_locked_snapshots os
    where os.user_id = v_user_id and os.lock_mutation_id = p_mutation_id
  ) then
    raise exception using errcode = '22023', message = 'Offline lock mutation belongs to another race';
  end if;

  insert into public.offline_prediction_locked_snapshots (
    user_id, race_id, schema_version, snapshot, snapshot_sha256,
    locked_at, lock_mutation_id, locked_by_device_id, source
  ) values (
    v_user_id, p_race_id, 1, v_snapshot, v_snapshot_hash,
    v_snapshot_locked_at, p_mutation_id, p_device_id, v_evidence_source
  ) returning * into v_inserted;

  return jsonb_build_object(
    'status', 'applied',
    'snapshot_id', v_inserted.id,
    'snapshot_sha256', encode(v_inserted.snapshot_sha256, 'hex'),
    'source', v_inserted.source
  );
end;
$$;

-- The editable/current client aggregate remains the primary read model after a
-- lock. Only server-owned lock state and immutable evidence are overlaid from
-- canonical rows, so a browser payload can never replace the original proof.
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
      coalesce(public.build_race_record(r.id), '{}'::jsonb) as canonical_record,
      ls.snapshot as canonical_locked_snapshot,
      ls.source as canonical_locked_source,
      os.snapshot as offline_locked_snapshot,
      os.locked_at as offline_locked_at,
      os.source as offline_locked_source
    from public.races r
    left join public.prediction_locked_snapshots ls
      on ls.user_id = r.user_id and ls.race_id = r.id
    left join public.offline_prediction_locked_snapshots os
      on os.user_id = r.user_id and os.race_id = r.id
    where r.id = p_race_id
      and r.user_id = auth.uid()
  ), merged as (
    select
      s.canonical_record,
      s.canonical_locked_snapshot,
      s.offline_locked_snapshot,
      s.offline_locked_at,
      coalesce(s.canonical_locked_snapshot, s.offline_locked_snapshot) as locked_snapshot,
      coalesce(s.canonical_locked_source, s.offline_locked_source) as locked_snapshot_source,
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
    when jsonb_typeof(m.record -> 'prediction') = 'object'
      or jsonb_typeof(m.canonical_record -> 'prediction') = 'object'
      or m.locked_snapshot is not null then
      jsonb_set(
        m.record,
        '{prediction}',
        (
          (
            case
              when jsonb_typeof(m.record -> 'prediction') = 'object'
                then m.record -> 'prediction'
              when jsonb_typeof(m.canonical_record -> 'prediction') = 'object'
                then m.canonical_record -> 'prediction'
              else '{}'::jsonb
            end
            - 'locked_snapshot'
            - 'locked_snapshot_source'
          )
          || case
            when m.canonical_locked_snapshot is not null then
              jsonb_build_object(
                'status', m.canonical_record #> '{prediction,status}',
                'effective_status', m.canonical_record #> '{prediction,effective_status}',
                'locked_at', m.canonical_record #> '{prediction,locked_at}'
              )
            when m.offline_locked_snapshot is not null then
              jsonb_build_object(
                'status', 'locked',
                'effective_status', 'locked',
                'locked_at', to_jsonb(m.offline_locked_at)
              )
            when jsonb_typeof(m.canonical_record -> 'prediction') = 'object' then
              jsonb_build_object(
                'status', m.canonical_record #> '{prediction,status}',
                'effective_status', m.canonical_record #> '{prediction,effective_status}',
                'locked_at', m.canonical_record #> '{prediction,locked_at}'
              )
            else '{}'::jsonb
          end
          || case
            when m.locked_snapshot is not null
              then jsonb_build_object(
                'locked_snapshot', m.locked_snapshot,
                'locked_snapshot_source', m.locked_snapshot_source
              )
            else '{}'::jsonb
          end
        ),
        true
      )
    else m.record
  end
  from merged m;
$$;

-- ---------------------------------------------------------------------------
-- Explicit lock RPC with optimistic conflict and idempotent replay envelopes.
-- ---------------------------------------------------------------------------

create or replace function public.finalize_prediction_lock(
  p_prediction_id uuid,
  p_expected_race_version bigint,
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
  v_prediction public.predictions%rowtype;
  v_race public.races%rowtype;
  v_race_id uuid;
  v_snapshot jsonb;
  v_snapshot_hash bytea;
  v_record jsonb;
  v_version bigint;
  v_change_seq bigint;
  v_response jsonb;
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;
  if p_prediction_id is null or p_mutation_id is null or p_installation_id is null
     or p_expected_race_version is null or p_expected_race_version < 1 then
    raise exception using errcode = '22023', message = 'Invalid finalize_prediction_lock request';
  end if;

  v_request_hash := extensions.digest(jsonb_build_object(
    'operation', 'finalize_prediction_lock',
    'prediction_id', p_prediction_id,
    'expected_race_version', p_expected_race_version,
    'installation_id', p_installation_id
  )::text, 'sha256');

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':mutation:' || p_mutation_id::text, 0));
  select * into v_receipt
  from public.sync_mutation_receipts
  where user_id = v_user_id and mutation_id = p_mutation_id;
  if found then
    if v_receipt.operation <> 'finalize_prediction_lock'
       or v_receipt.request_sha256 <> v_request_hash then
      raise exception using errcode = '22023', message = 'mutation_id was already used with a different request';
    end if;
    return v_receipt.response || jsonb_build_object('status', 'replayed');
  end if;

  select p.race_id into v_race_id
  from public.predictions p
  where p.id = p_prediction_id and p.user_id = v_user_id;
  if not found then
    return jsonb_build_object(
      'status', 'conflict', 'current', null, 'current_version', null,
      'reason', 'prediction_not_found'
    );
  end if;

  select * into v_race
  from public.races
  where id = v_race_id and user_id = v_user_id
  for update;
  if not found then
    return jsonb_build_object(
      'status', 'conflict', 'current', null, 'current_version', null,
      'reason', 'race_not_found'
    );
  end if;

  select * into v_prediction
  from public.predictions
  where id = p_prediction_id and user_id = v_user_id and race_id = v_race.id
  for update;
  if not found then
    return jsonb_build_object(
      'status', 'conflict', 'current', null,
      'current_version', v_race.sync_version,
      'reason', 'prediction_changed'
    );
  end if;

  v_record := public.build_race_record(v_race.id) || jsonb_build_object(
    'client_key', v_race.client_key,
    'sync_version', v_race.sync_version,
    'sync_updated_at', v_race.sync_updated_at
  );
  if p_expected_race_version <> v_race.sync_version then
    return jsonb_build_object(
      'status', 'conflict', 'current', v_record,
      'current_version', v_race.sync_version, 'reason', 'version_mismatch'
    );
  end if;
  if v_prediction.status = 'locked' then
    return jsonb_build_object(
      'status', 'conflict', 'current', v_record,
      'current_version', v_race.sync_version, 'reason', 'already_locked'
    );
  end if;
  if clock_timestamp() >= v_race.starts_at then
    return jsonb_build_object(
      'status', 'conflict', 'current', v_record,
      'current_version', v_race.sync_version, 'reason', 'race_started'
    );
  end if;

  v_device := public.register_sync_device(p_installation_id);
  update public.predictions
  set status = 'locked', locked_at = clock_timestamp()
  where id = v_prediction.id and user_id = v_user_id
  returning * into v_prediction;

  v_snapshot := public.build_complete_prediction_snapshot(v_prediction.id);
  v_snapshot_hash := extensions.digest(v_snapshot::text, 'sha256');
  insert into public.prediction_locked_snapshots (
    user_id, race_id, prediction_id, schema_version, snapshot,
    snapshot_sha256, locked_at, lock_mutation_id, locked_by_device_id, source
  ) values (
    v_user_id, v_race.id, v_prediction.id, 1, v_snapshot,
    v_snapshot_hash, v_prediction.locked_at, p_mutation_id, v_device.id, 'lock_rpc'
  );

  update public.races
  set sync_version = sync_version + 1,
      sync_updated_at = clock_timestamp(),
      last_mutation_id = p_mutation_id
  where id = v_race.id and user_id = v_user_id
  returning sync_version into v_version;

  insert into public.sync_change_log (
    user_id, mutation_id, device_id, entity_type, entity_id,
    entity_client_key, operation, record_version
  ) values (
    v_user_id, p_mutation_id, v_device.id, 'race', v_race.id,
    v_race.client_key, 'upsert', v_version
  ) returning change_seq into v_change_seq;

  v_record := public.build_race_record(v_race.id) || jsonb_build_object(
    'client_key', v_race.client_key,
    'sync_version', v_version,
    'sync_updated_at', (select sync_updated_at from public.races where id = v_race.id),
    'locked_snapshot_sha256', encode(v_snapshot_hash, 'hex')
  );
  v_response := jsonb_build_object(
    'status', 'applied', 'record', v_record,
    'version', v_version, 'change_seq', v_change_seq
  );

  insert into public.sync_mutation_receipts (
    user_id, mutation_id, device_id, operation, request_sha256,
    entity_type, entity_id, entity_client_key, resulting_version,
    change_seq, response
  ) values (
    v_user_id, p_mutation_id, v_device.id, 'finalize_prediction_lock', v_request_hash,
    'race', v_race.id, v_race.client_key, v_version, v_change_seq, v_response
  );
  return v_response;
end;
$$;

-- ---------------------------------------------------------------------------
-- v0.1.1-local-clean migration documents and per-item receipts.
-- The client stages one immutable document, then applies each stored item. This
-- makes interruption/retry observable without trusting client-reported success.
-- ---------------------------------------------------------------------------

create table if not exists public.local_migration_documents (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  device_id uuid not null,
  import_key uuid not null,
  source_version text not null,
  document jsonb not null,
  document_sha256 bytea not null,
  status text not null default 'staged',
  item_count integer not null default 0,
  applied_count integer not null default 0,
  conflict_count integer not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  unique (user_id, id),
  unique (user_id, import_key),
  constraint local_migration_documents_user_device_fk
    foreign key (user_id, device_id)
    references public.sync_devices(user_id, id)
    on delete cascade,
  constraint local_migration_documents_version check (
    source_version = 'v0.1.1-local-clean'
  ),
  constraint local_migration_documents_object check (jsonb_typeof(document) = 'object'),
  constraint local_migration_documents_hash check (octet_length(document_sha256) = 32),
  constraint local_migration_documents_status check (
    status in ('staged', 'processing', 'completed', 'conflict')
  ),
  constraint local_migration_documents_counts check (
    item_count >= 0 and applied_count >= 0 and conflict_count >= 0
    and applied_count + conflict_count <= item_count
  )
);

create table if not exists public.local_migration_items (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  document_id uuid not null,
  ordinal integer not null,
  entity_type text not null,
  client_key text not null,
  mutation_id uuid not null default extensions.gen_random_uuid(),
  expected_version bigint not null default 0,
  payload jsonb not null,
  payload_sha256 bytea not null,
  status text not null default 'staged',
  target_entity_id uuid,
  resulting_version bigint,
  result jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  unique (user_id, id),
  unique (user_id, mutation_id),
  unique (user_id, document_id, entity_type, client_key),
  unique (user_id, document_id, ordinal),
  constraint local_migration_items_user_document_fk
    foreign key (user_id, document_id)
    references public.local_migration_documents(user_id, id)
    on delete cascade,
  constraint local_migration_items_entity_type check (
    entity_type in ('race', 'rule_version')
  ),
  constraint local_migration_items_client_key check (
    char_length(btrim(client_key)) between 1 and 160
  ),
  constraint local_migration_items_expected_version check (expected_version >= 0),
  constraint local_migration_items_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint local_migration_items_hash check (octet_length(payload_sha256) = 32),
  constraint local_migration_items_status check (
    status in ('staged', 'applied', 'conflict')
  ),
  constraint local_migration_items_result_object check (
    result is null or jsonb_typeof(result) = 'object'
  )
);

create index if not exists local_migration_documents_user_created_idx
  on public.local_migration_documents(user_id, created_at desc);
create index if not exists local_migration_items_document_status_idx
  on public.local_migration_items(user_id, document_id, status, ordinal);

create trigger local_migration_documents_protect_user_id
before update of user_id on public.local_migration_documents
for each row execute function public.protect_user_id();
create trigger local_migration_items_protect_user_id
before update of user_id on public.local_migration_items
for each row execute function public.protect_user_id();

alter table public.local_migration_documents enable row level security;
alter table public.local_migration_items enable row level security;

create policy local_migration_documents_self_read
on public.local_migration_documents
for select to authenticated
using (user_id = (select auth.uid()));

create policy local_migration_items_self_read
on public.local_migration_items
for select to authenticated
using (user_id = (select auth.uid()));

create or replace function public.stage_local_migration(
  p_source_version text,
  p_import_key uuid,
  p_installation_id uuid,
  p_document jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_device public.sync_devices%rowtype;
  v_document_id uuid;
  v_existing_hash bytea;
  v_document_hash bytea;
  v_item jsonb;
  v_payload jsonb;
  v_client_key text;
  v_entity_type text;
  v_ordinal integer := 0;
  v_item_count integer := 0;
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;
  if p_source_version <> 'v0.1.1-local-clean'
     or p_import_key is null or p_installation_id is null
     or p_document is null or jsonb_typeof(p_document) <> 'object' then
    raise exception using errcode = '22023', message = 'Invalid local migration document';
  end if;
  if (p_document ? 'races' and jsonb_typeof(p_document -> 'races') <> 'array')
     or (p_document ? 'rules' and jsonb_typeof(p_document -> 'rules') <> 'array') then
    raise exception using errcode = '22023', message = 'races and rules must be arrays';
  end if;

  v_document_hash := extensions.digest(p_document::text, 'sha256');
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':local-import:' || p_import_key::text, 0));
  select id, document_sha256
  into v_document_id, v_existing_hash
  from public.local_migration_documents
  where user_id = v_user_id and import_key = p_import_key;

  if found then
    if v_existing_hash <> v_document_hash then
      raise exception using errcode = '22023', message = 'import_key was already used with a different document';
    end if;
    return jsonb_build_object(
      'status', 'replayed',
      'document_id', v_document_id,
      'item_count', (
        select item_count from public.local_migration_documents where id = v_document_id
      )
    );
  end if;

  v_device := public.register_sync_device(p_installation_id);
  insert into public.local_migration_documents (
    user_id, device_id, import_key, source_version,
    document, document_sha256, status
  ) values (
    v_user_id, v_device.id, p_import_key, p_source_version,
    p_document, v_document_hash, 'staged'
  ) returning id into v_document_id;

  for v_entity_type, v_item in
    select 'rule_version'::text, value
    from jsonb_array_elements(coalesce(p_document -> 'rules', '[]'::jsonb))
    union all
    select 'race'::text, value
    from jsonb_array_elements(coalesce(p_document -> 'races', '[]'::jsonb))
  loop
    v_ordinal := v_ordinal + 1;
    if jsonb_typeof(v_item) <> 'object' then
      raise exception using errcode = '22023', message = 'Every migration item must be an object';
    end if;
    v_payload := case
      when jsonb_typeof(v_item -> 'payload') = 'object' then v_item -> 'payload'
      else v_item
    end;
    v_client_key := nullif(btrim(coalesce(
      v_item ->> 'client_key',
      v_payload ->> 'client_key',
      v_payload ->> 'id'
    )), '');
    if v_client_key is null or char_length(v_client_key) > 160 then
      raise exception using errcode = '22023', message = 'Every migration item requires a valid client_key';
    end if;
    v_payload := v_payload || jsonb_build_object('client_key', v_client_key);

    insert into public.local_migration_items (
      user_id, document_id, ordinal, entity_type, client_key,
      expected_version, payload, payload_sha256
    ) values (
      v_user_id, v_document_id, v_ordinal, v_entity_type, v_client_key,
      coalesce(nullif(v_item ->> 'expected_version', '')::bigint, 0),
      v_payload,
      extensions.digest(v_payload::text, 'sha256')
    );
    v_item_count := v_item_count + 1;
  end loop;

  update public.local_migration_documents
  set item_count = v_item_count
  where id = v_document_id and user_id = v_user_id;

  return jsonb_build_object(
    'status', 'staged',
    'document_id', v_document_id,
    'item_count', v_item_count
  );
end;
$$;

create or replace function public.apply_local_migration_item(
  p_item_id uuid,
  p_installation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_item public.local_migration_items%rowtype;
  v_document public.local_migration_documents%rowtype;
  v_response jsonb;
  v_target_id uuid;
  v_version bigint;
  v_receipt_exists boolean;
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;
  if p_item_id is null or p_installation_id is null then
    raise exception using errcode = '22023', message = 'item_id and installation_id are required';
  end if;

  select * into v_item
  from public.local_migration_items
  where id = p_item_id and user_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Migration item not found';
  end if;

  select * into v_document
  from public.local_migration_documents
  where id = v_item.document_id and user_id = v_user_id
  for update;

  if not exists (
    select 1 from public.sync_devices d
    where d.id = v_document.device_id
      and d.user_id = v_user_id
      and d.installation_id = p_installation_id
      and d.revoked_at is null
  ) then
    raise exception using errcode = '42501', message = 'Migration must resume on its source installation';
  end if;

  if v_item.status = 'applied' then
    return coalesce(v_item.result, '{}'::jsonb) || jsonb_build_object(
      'status', 'replayed', 'migration_item_id', v_item.id
    );
  end if;

  perform set_config('keiba.trusted_local_migration', 'on', true);
  if v_item.entity_type = 'race' then
    v_response := public.sync_race_record(
      v_item.payload,
      v_item.expected_version,
      v_item.mutation_id,
      p_installation_id
    );
  else
    v_response := public.sync_rule_version(
      v_item.payload,
      v_item.expected_version,
      v_item.mutation_id,
      p_installation_id
    );
  end if;

  if v_response ->> 'status' in ('applied', 'replayed') then
    v_target_id := nullif(v_response #>> '{record,id}', '')::uuid;
    v_version := nullif(v_response ->> 'version', '')::bigint;
    select exists (
      select 1 from public.sync_mutation_receipts r
      where r.user_id = v_user_id
        and r.mutation_id = v_item.mutation_id
        and r.entity_id = v_target_id
    ) into v_receipt_exists;
    if not v_receipt_exists then
      raise exception using errcode = '23514', message = 'Applied migration item has no mutation receipt';
    end if;

    update public.local_migration_items
    set status = 'applied',
        target_entity_id = v_target_id,
        resulting_version = v_version,
        result = v_response,
        error_message = null,
        applied_at = now()
    where id = v_item.id and user_id = v_user_id;
  else
    update public.local_migration_items
    set status = 'conflict',
        result = v_response,
        error_message = v_response ->> 'reason'
    where id = v_item.id and user_id = v_user_id;
  end if;

  update public.local_migration_documents d
  set status = case
        when exists (
          select 1 from public.local_migration_items i
          where i.document_id = d.id and i.user_id = d.user_id and i.status = 'conflict'
        ) then 'conflict'
        else 'processing'
      end,
      started_at = coalesce(started_at, now()),
      applied_count = (
        select count(*)::integer from public.local_migration_items i
        where i.document_id = d.id and i.user_id = d.user_id and i.status = 'applied'
      ),
      conflict_count = (
        select count(*)::integer from public.local_migration_items i
        where i.document_id = d.id and i.user_id = d.user_id and i.status = 'conflict'
      )
  where d.id = v_document.id and d.user_id = v_user_id;

  return v_response || jsonb_build_object('migration_item_id', v_item.id);
end;
$$;

create or replace function public.complete_local_migration(p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_document public.local_migration_documents%rowtype;
  v_pending integer;
  v_conflicts integer;
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;
  select * into v_document
  from public.local_migration_documents
  where id = p_document_id and user_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Migration document not found';
  end if;
  if v_document.status = 'completed' then
    return jsonb_build_object(
      'status', 'replayed', 'document_id', v_document.id,
      'item_count', v_document.item_count,
      'applied_count', v_document.applied_count,
      'conflict_count', v_document.conflict_count
    );
  end if;

  select
    count(*) filter (where status = 'staged')::integer,
    count(*) filter (where status = 'conflict')::integer
  into v_pending, v_conflicts
  from public.local_migration_items
  where user_id = v_user_id and document_id = v_document.id;

  if v_pending > 0 or v_conflicts > 0 then
    return jsonb_build_object(
      'status', 'conflict',
      'document_id', v_document.id,
      'current_version', null,
      'reason', case when v_conflicts > 0 then 'items_conflicted' else 'items_pending' end,
      'pending_count', v_pending,
      'conflict_count', v_conflicts
    );
  end if;

  update public.local_migration_documents
  set status = 'completed',
      applied_count = item_count,
      conflict_count = 0,
      completed_at = now()
  where id = v_document.id and user_id = v_user_id
  returning * into v_document;

  return jsonb_build_object(
    'status', 'applied',
    'document_id', v_document.id,
    'item_count', v_document.item_count,
    'applied_count', v_document.applied_count,
    'conflict_count', v_document.conflict_count
  );
end;
$$;

revoke insert, update, delete on
  public.prediction_locked_snapshots,
  public.offline_prediction_locked_snapshots,
  public.local_migration_documents,
  public.local_migration_items
from authenticated;
revoke all on
  public.prediction_locked_snapshots,
  public.offline_prediction_locked_snapshots,
  public.local_migration_documents,
  public.local_migration_items
from anon;
grant select on
  public.prediction_locked_snapshots,
  public.offline_prediction_locked_snapshots,
  public.local_migration_documents,
  public.local_migration_items
to authenticated;

revoke all on function public.build_complete_prediction_snapshot(uuid) from public;
revoke all on function public.protect_locked_snapshot() from public;
revoke all on function public.validate_locked_snapshot_insert() from public;
revoke all on function public.ensure_locked_prediction_snapshot() from public;
revoke all on function public.require_trusted_prediction_import() from public;
revoke all on function public.store_offline_prediction_lock(uuid, jsonb, uuid, uuid) from public;
revoke execute on function public.store_offline_prediction_lock(uuid, jsonb, uuid, uuid)
from anon, authenticated;
revoke all on function public.finalize_prediction_lock(uuid, bigint, uuid, uuid) from public;
revoke all on function public.stage_local_migration(text, uuid, uuid, jsonb) from public;
revoke all on function public.apply_local_migration_item(uuid, uuid) from public;
revoke all on function public.complete_local_migration(uuid) from public;

grant execute on function public.finalize_prediction_lock(uuid, bigint, uuid, uuid) to authenticated;
grant execute on function public.stage_local_migration(text, uuid, uuid, jsonb) to authenticated;
grant execute on function public.apply_local_migration_item(uuid, uuid) to authenticated;
grant execute on function public.complete_local_migration(uuid) to authenticated;

comment on table public.prediction_locked_snapshots is
  'Canonical immutable evidence for prediction, selections, rule snapshot, and proposal tickets at lock time.';
comment on table public.offline_prediction_locked_snapshots is
  'Immutable, source-labelled client evidence for a pre-post lock first synchronized after post time.';
comment on table public.local_migration_documents is
  'Idempotent v0.1.1-local-clean import receipt and immutable source document.';

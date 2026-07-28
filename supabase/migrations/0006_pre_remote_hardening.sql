-- Pre-remote hardening for immutable lock evidence, rule-set concurrency,
-- and consistent modification timestamps.

-- ---------------------------------------------------------------------------
-- Consistent updated_at columns.
-- ---------------------------------------------------------------------------

alter table public.race_exchange_documents
  add column if not exists updated_at timestamptz not null default now();
alter table public.local_migration_documents
  add column if not exists updated_at timestamptz not null default now();
alter table public.local_migration_items
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists race_exchange_documents_updated_at
  on public.race_exchange_documents;
create trigger race_exchange_documents_updated_at
before update on public.race_exchange_documents
for each row execute function public.set_updated_at();

drop trigger if exists local_migration_documents_updated_at
  on public.local_migration_documents;
create trigger local_migration_documents_updated_at
before update on public.local_migration_documents
for each row execute function public.set_updated_at();

drop trigger if exists local_migration_items_updated_at
  on public.local_migration_items;
create trigger local_migration_items_updated_at
before update on public.local_migration_items
for each row execute function public.set_updated_at();

comment on column public.race_exchange_documents.updated_at is
  'Last modification time; created_at and completed_at retain their original meanings.';
comment on column public.local_migration_documents.updated_at is
  'Last modification time; migration processing timestamps remain separate.';
comment on column public.local_migration_items.updated_at is
  'Last modification time; created_at and applied_at remain separate.';

-- ---------------------------------------------------------------------------
-- Freeze data_scope inside canonical immutable lock evidence.
-- ---------------------------------------------------------------------------

alter table public.prediction_locked_snapshots
  add column if not exists data_scope public.race_data_scope;

-- 0005 predates this column. The cloud migration has not yet been applied to a
-- remote project, but make an in-place upgrade deterministic as well. Existing
-- canonical JSON is amended only with the missing scope, then re-hashed. The
-- immutability trigger is restored before any user transaction can observe it.
drop trigger if exists prediction_locked_snapshots_immutable
  on public.prediction_locked_snapshots;

with scoped as (
  select
    ls.id,
    case
      when ls.snapshot #>> '{race,data_scope}' in ('live', 'demo', 'test')
        then (ls.snapshot #>> '{race,data_scope}')::public.race_data_scope
      else r.data_scope
    end as data_scope
  from public.prediction_locked_snapshots ls
  join public.races r
    on r.user_id = ls.user_id and r.id = ls.race_id
), hardened as (
  select
    ls.id,
    s.data_scope,
    jsonb_set(
      ls.snapshot,
      '{race,data_scope}',
      to_jsonb(s.data_scope::text),
      true
    ) as snapshot
  from public.prediction_locked_snapshots ls
  join scoped s on s.id = ls.id
)
update public.prediction_locked_snapshots ls
set data_scope = h.data_scope,
    snapshot = h.snapshot,
    snapshot_sha256 = extensions.digest(h.snapshot::text, 'sha256')
from hardened h
where ls.id = h.id;

alter table public.prediction_locked_snapshots
  alter column data_scope set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.prediction_locked_snapshots'::regclass
      and conname = 'prediction_locked_snapshots_data_scope_allowed'
  ) then
    alter table public.prediction_locked_snapshots
      add constraint prediction_locked_snapshots_data_scope_allowed
      check (data_scope in ('live', 'demo', 'test')) not valid;
  end if;
  alter table public.prediction_locked_snapshots
    validate constraint prediction_locked_snapshots_data_scope_allowed;
end
$$;

create trigger prediction_locked_snapshots_immutable
before update or delete on public.prediction_locked_snapshots
for each row execute function public.protect_locked_snapshot();

comment on column public.prediction_locked_snapshots.data_scope is
  'Race scope frozen at lock time; later changes to races.data_scope never cascade here.';

-- The canonical JSON is the hash input. Adding data_scope here therefore makes
-- any scope change produce a different SHA-256 value.
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
      'distance_m', r.distance_m,
      'data_scope', r.data_scope
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

-- Existing insert paths in 0005 intentionally omit the new column. This
-- canonical validator fills it from races while the row is being locked, then
-- proves both the JSON and hash were built from that same scope.
create or replace function public.validate_locked_snapshot_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prediction public.predictions%rowtype;
  v_race_scope public.race_data_scope;
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

  select r.data_scope into v_race_scope
  from public.races r
  where r.id = new.race_id and r.user_id = new.user_id;
  if not found then
    raise exception using
      errcode = '23514',
      message = 'Locked snapshot race is not owned by the prediction owner';
  end if;

  if new.data_scope is null then
    new.data_scope := v_race_scope;
  elsif new.data_scope is distinct from v_race_scope then
    raise exception using
      errcode = '23514',
      message = 'Locked snapshot data_scope differs from the race at lock time';
  end if;

  v_canonical := public.build_complete_prediction_snapshot(new.prediction_id);
  if v_canonical #>> '{race,data_scope}' is distinct from new.data_scope::text
     or new.snapshot is distinct from v_canonical
     or new.snapshot_sha256 <> extensions.digest(v_canonical::text, 'sha256') then
    raise exception using
      errcode = '23514',
      message = 'Locked snapshot, data_scope, or hash is not canonical';
  end if;
  return new;
end;
$$;

-- An explicit browser lock made while offline is client-sourced evidence even
-- when the device reconnects before post time. Persist it in the source-labelled
-- offline table before the deferred canonical trigger runs, and never rebuild
-- that historical lock from a later editable prediction or race data_scope.
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
  if exists (
    select 1
    from public.offline_prediction_locked_snapshots os
    where os.user_id = v_prediction.user_id
      and os.race_id = v_prediction.race_id
  ) then
    return null;
  end if;

  v_snapshot := public.build_complete_prediction_snapshot(v_prediction.id);
  if v_snapshot is null then
    raise exception using
      errcode = '23514',
      message = 'Cannot build locked prediction snapshot';
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

do $$
begin
  if to_regprocedure(
    'public.sync_race_record_0004_internal(jsonb,bigint,uuid,uuid)'
  ) is null then
    execute
      'alter function public.sync_race_record(jsonb, bigint, uuid, uuid) '
      || 'rename to sync_race_record_0004_internal';
  end if;
end
$$;

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
  v_response jsonb;
  v_race_id uuid;
  v_device_id uuid;
  v_has_explicit_lock boolean;
begin
  v_response := public.sync_race_record_0004_internal(
    p_payload,
    p_expected_version,
    p_mutation_id,
    p_installation_id
  );

  v_has_explicit_lock :=
    p_payload #>> '{prediction,status}' = 'locked'
    and jsonb_typeof(p_payload #> '{prediction,locked_snapshot}') = 'object'
    and nullif(p_payload #>> '{prediction,locked_at}', '') is not null;

  if v_response ->> 'status' in ('applied', 'replayed')
     and v_has_explicit_lock then
    begin
      v_race_id := nullif(
        coalesce(
          v_response #>> '{record,id}',
          p_payload ->> 'id'
        ),
        ''
      )::uuid;
    exception when others then
      raise exception using
        errcode = '22023',
        message = 'Synced race identity is invalid';
    end;

    select d.id into v_device_id
    from public.sync_devices d
    where d.user_id = v_user_id
      and d.installation_id = p_installation_id
      and d.revoked_at is null;
    if v_race_id is null or v_device_id is null then
      raise exception using
        errcode = '23514',
        message = 'Explicit offline lock has no synced race or active device';
    end if;

    perform public.store_offline_prediction_lock(
      v_race_id,
      p_payload,
      p_mutation_id,
      v_device_id
    );
    v_response := v_response || jsonb_build_object(
      'record',
      public.build_synced_race_record(v_race_id)
    );
  end if;

  return v_response;
end;
$$;

-- ---------------------------------------------------------------------------
-- prediction_rule_sets optimistic concurrency.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.prediction_rule_sets'::regclass
      and conname = 'prediction_rule_sets_sync_version_positive'
  ) then
    alter table public.prediction_rule_sets
      add constraint prediction_rule_sets_sync_version_positive
      check (sync_version > 0) not valid;
  end if;
  alter table public.prediction_rule_sets
    validate constraint prediction_rule_sets_sync_version_positive;
end
$$;

create or replace function public.build_synced_rule_record(
  p_rule_version_id uuid
)
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
      'is_active', rs.is_active,
      'sync_version', rs.sync_version,
      'updated_at', rs.updated_at
    )
  )
  from public.prediction_rule_versions rv
  join public.prediction_rule_sets rs
    on rs.user_id = rv.user_id and rs.id = rv.rule_set_id
  where rv.id = p_rule_version_id
    and rv.user_id = auth.uid();
$$;

-- All terminal sync_rule_version outcomes, including conflicts, receive one
-- immutable receipt. This preserves the original conflict on mutation replay.
create or replace function public.store_rule_sync_terminal_receipt(
  p_user_id uuid,
  p_mutation_id uuid,
  p_device_id uuid,
  p_request_hash bytea,
  p_entity_id uuid,
  p_entity_client_key text,
  p_resulting_version bigint,
  p_change_seq bigint,
  p_response jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() is distinct from p_user_id then
    raise exception using errcode = '42501', message = 'Receipt owner mismatch';
  end if;
  if p_response is null or jsonb_typeof(p_response) <> 'object' then
    raise exception using errcode = '22023', message = 'Receipt response must be an object';
  end if;

  insert into public.sync_mutation_receipts (
    user_id, mutation_id, device_id, operation, request_sha256,
    entity_type, entity_id, entity_client_key, resulting_version,
    change_seq, response
  ) values (
    p_user_id, p_mutation_id, p_device_id, 'sync_rule_version', p_request_hash,
    'rule_version', p_entity_id, p_entity_client_key, p_resulting_version,
    p_change_seq, p_response
  );
  return p_response;
end;
$$;

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
  v_description text;
  -- Legacy outbox entries may not carry the newly-added parent precondition.
  -- Treat omission as version zero: it may create a missing set, but it can
  -- never overwrite an existing set without first surfacing a conflict.
  v_expected_rule_set_version bigint := 0;
  v_request_hash bytea;
  v_receipt public.sync_mutation_receipts%rowtype;
  v_device public.sync_devices%rowtype;
  v_rule_set_id uuid;
  v_named_rule_set_id uuid;
  v_rule_version_id uuid;
  v_semantic_rule_version_id uuid;
  v_current_version bigint;
  v_rule_set_version bigint;
  v_status public.rule_version_status;
  v_existing_name text;
  v_existing_description text;
  v_existing_content text;
  v_existing_parameters jsonb;
  v_existing_change_note text;
  v_rule_set_updated_at timestamptz;
  v_version_number integer;
  v_record jsonb;
  v_conflicting_record jsonb;
  v_rule_set_record jsonb;
  v_change_seq bigint;
  v_response jsonb;
  v_rule_set_existed boolean := false;
  v_new_rule_version boolean := false;
  v_rule_version_changed boolean := false;
  v_description_changed boolean := false;
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
  if p_payload ? 'parameters'
     and jsonb_typeof(p_payload -> 'parameters') <> 'object' then
    raise exception using errcode = '22023', message = 'parameters must be an object';
  end if;
  if p_payload ? 'description'
     and jsonb_typeof(p_payload -> 'description') not in ('string', 'null') then
    raise exception using errcode = '22023', message = 'description must be a string or null';
  end if;
  if p_payload ? 'expected_rule_set_version' then
    if jsonb_typeof(p_payload -> 'expected_rule_set_version') <> 'number'
       or p_payload ->> 'expected_rule_set_version' !~ '^[0-9]+$' then
      raise exception using
        errcode = '22023',
        message = 'expected_rule_set_version must be a non-negative integer';
    end if;
    v_expected_rule_set_version :=
      (p_payload ->> 'expected_rule_set_version')::bigint;
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
  v_description := p_payload ->> 'description';
  if v_client_key is null or char_length(v_client_key) > 160
     or v_name is null or v_semantic_version is null
     or v_content is null or btrim(v_content) = '' then
    raise exception using
      errcode = '22023',
      message = 'client_key, name, semantic_version, and content are required';
  end if;

  v_parameters := coalesce(p_payload -> 'parameters', '{}'::jsonb)
    || jsonb_build_object(
      'semantic_version', v_semantic_version,
      'display_name', v_name,
      'rules', coalesce(
        p_payload -> 'rules',
        to_jsonb(string_to_array(v_content, E'\n'))
      )
    );

  -- Keep the 0004 request envelope byte-for-byte compatible. The optional
  -- parent precondition is already inside p_payload and is therefore covered.
  v_request_hash := extensions.digest(jsonb_build_object(
    'operation', 'sync_rule_version',
    'payload', p_payload,
    'expected_version', p_expected_version,
    'installation_id', p_installation_id
  )::text, 'sha256');

  perform pg_advisory_xact_lock(hashtextextended(
    v_user_id::text || ':mutation:' || p_mutation_id::text,
    0
  ));
  select * into v_receipt
  from public.sync_mutation_receipts
  where user_id = v_user_id and mutation_id = p_mutation_id;
  if found then
    if v_receipt.operation <> 'sync_rule_version'
       or v_receipt.request_sha256 <> v_request_hash then
      raise exception using
        errcode = '22023',
        message = 'mutation_id was already used with a different request';
    end if;
    if v_receipt.response ->> 'status' = 'conflict' then
      return v_receipt.response || jsonb_build_object('replayed', true);
    end if;
    return v_receipt.response || jsonb_build_object(
      'status', 'replayed',
      'replayed', true
    );
  end if;

  v_device := public.register_sync_device(p_installation_id);

  -- Serialize both a client version identity and its parent set identity.
  perform pg_advisory_xact_lock(hashtextextended(
    v_user_id::text || ':rule:' || v_client_key,
    0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    v_user_id::text || ':rule-set:' || v_name,
    0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    v_user_id::text || ':rule-semver:' || v_name || ':' || v_semantic_version,
    0
  ));

  select
    rv.id,
    rv.rule_set_id,
    rv.sync_version,
    rv.status,
    rs.name,
    rs.description,
    rs.sync_version,
    rs.updated_at,
    rv.content,
    rv.parameters,
    rv.change_note
  into
    v_rule_version_id,
    v_rule_set_id,
    v_current_version,
    v_status,
    v_existing_name,
    v_existing_description,
    v_rule_set_version,
    v_rule_set_updated_at,
    v_existing_content,
    v_existing_parameters,
    v_existing_change_note
  from public.prediction_rule_versions rv
  join public.prediction_rule_sets rs
    on rs.user_id = rv.user_id and rs.id = rv.rule_set_id
  where rv.user_id = v_user_id and rv.client_key = v_client_key
  for update of rv, rs;

  if v_rule_version_id is null then
    select
      rs.id,
      rs.name,
      rs.description,
      rs.sync_version,
      rs.updated_at
    into
      v_rule_set_id,
      v_existing_name,
      v_existing_description,
      v_rule_set_version,
      v_rule_set_updated_at
    from public.prediction_rule_sets rs
    where rs.user_id = v_user_id and rs.name = v_name
    for update;
  end if;
  v_rule_set_existed := v_rule_set_id is not null;

  if v_rule_set_existed then
    v_rule_set_record := jsonb_build_object(
      'id', v_rule_set_id,
      'name', v_existing_name,
      'description', v_existing_description,
      'sync_version', v_rule_set_version,
      'updated_at', v_rule_set_updated_at
    );
  end if;

  if v_rule_version_id is null and v_rule_set_id is not null then
    select rv.id into v_semantic_rule_version_id
    from public.prediction_rule_versions rv
    where rv.user_id = v_user_id
      and rv.rule_set_id = v_rule_set_id
      and rv.semantic_version = v_semantic_version;
  elsif v_rule_version_id is not null then
    select rv.id into v_semantic_rule_version_id
    from public.prediction_rule_versions rv
    where rv.user_id = v_user_id
      and rv.rule_set_id = v_rule_set_id
      and rv.semantic_version = v_semantic_version
      and rv.id <> v_rule_version_id;
  end if;

  if v_rule_version_id is null and p_expected_version <> 0 then
    v_response := jsonb_build_object(
      'status', 'conflict',
      'current', null,
      'current_version', null,
      'current_rule_set', v_rule_set_record,
      'current_rule_set_version', v_rule_set_version,
      'reason', 'record_not_found'
    );
    return public.store_rule_sync_terminal_receipt(
      v_user_id, p_mutation_id, v_device.id, v_request_hash,
      null, v_client_key, null, null, v_response
    );
  elsif v_rule_version_id is not null
        and p_expected_version <> v_current_version then
    v_record := public.build_synced_rule_record(v_rule_version_id);
    v_response := jsonb_build_object(
      'status', 'conflict',
      'current', v_record,
      'current_version', v_current_version,
      'current_rule_set', v_rule_set_record,
      'current_rule_set_version', v_rule_set_version,
      'reason', 'version_mismatch'
    );
    return public.store_rule_sync_terminal_receipt(
      v_user_id, p_mutation_id, v_device.id, v_request_hash,
      v_rule_version_id, v_client_key, v_current_version, null, v_response
    );
  end if;

  if not v_rule_set_existed
     and v_expected_rule_set_version is not null
     and v_expected_rule_set_version <> 0 then
    v_response := jsonb_build_object(
      'status', 'conflict',
      'current', null,
      'current_version', v_current_version,
      'current_rule_set', null,
      'current_rule_set_version', null,
      'reason', 'rule_set_not_found'
    );
    return public.store_rule_sync_terminal_receipt(
      v_user_id, p_mutation_id, v_device.id, v_request_hash,
      v_rule_version_id, v_client_key, v_current_version, null, v_response
    );
  elsif v_rule_set_existed
        and v_expected_rule_set_version is not null
        and v_expected_rule_set_version <> v_rule_set_version then
    if v_rule_version_id is not null then
      v_record := public.build_synced_rule_record(v_rule_version_id);
    end if;
    v_response := jsonb_build_object(
      'status', 'conflict',
      'current', v_record,
      'current_version', v_current_version,
      'current_rule_set', v_rule_set_record,
      'current_rule_set_version', v_rule_set_version,
      'reason', 'rule_set_version_mismatch'
    );
    return public.store_rule_sync_terminal_receipt(
      v_user_id, p_mutation_id, v_device.id, v_request_hash,
      v_rule_version_id, v_client_key, v_current_version, null, v_response
    );
  end if;

  if v_rule_version_id is not null and v_existing_name <> v_name then
    v_record := public.build_synced_rule_record(v_rule_version_id);
    v_response := jsonb_build_object(
      'status', 'conflict',
      'current', v_record,
      'current_version', v_current_version,
      'current_rule_set', v_rule_set_record,
      'current_rule_set_version', v_rule_set_version,
      'reason', 'rule_set_name_mismatch',
      'requested_name', v_name,
      'current_name', v_existing_name
    );
    return public.store_rule_sync_terminal_receipt(
      v_user_id, p_mutation_id, v_device.id, v_request_hash,
      v_rule_version_id, v_client_key, v_current_version, null, v_response
    );
  end if;

  if v_semantic_rule_version_id is not null then
    v_conflicting_record :=
      public.build_synced_rule_record(v_semantic_rule_version_id);
    if v_rule_version_id is not null then
      v_record := public.build_synced_rule_record(v_rule_version_id);
    else
      v_record := v_conflicting_record;
    end if;
    v_response := jsonb_build_object(
      'status', 'conflict',
      'current', v_record,
      'current_version', coalesce(
        v_current_version,
        (v_conflicting_record ->> 'sync_version')::bigint
      ),
      'current_rule_set', v_rule_set_record,
      'current_rule_set_version', v_rule_set_version,
      'reason', 'semantic_version_exists',
      'requested_client_key', v_client_key,
      'conflicting_record', v_conflicting_record
    );
    return public.store_rule_sync_terminal_receipt(
      v_user_id, p_mutation_id, v_device.id, v_request_hash,
      coalesce(v_rule_version_id, v_semantic_rule_version_id),
      v_client_key,
      coalesce(
        v_current_version,
        (v_conflicting_record ->> 'sync_version')::bigint
      ),
      null,
      v_response
    );
  end if;

  if v_rule_version_id is not null and v_status <> 'draft'
     and (
       v_existing_content <> v_content
       or v_existing_parameters <> v_parameters
       or coalesce(
         nullif(p_payload ->> 'status', '')::public.rule_version_status,
         v_status
       ) <> v_status
       or (
         (p_payload ? 'change_note' or p_payload ? 'note')
         and v_existing_change_note is distinct from coalesce(
           p_payload ->> 'change_note',
           p_payload ->> 'note'
         )
       )
     ) then
    v_record := public.build_synced_rule_record(v_rule_version_id);
    v_response := jsonb_build_object(
      'status', 'conflict',
      'current', v_record,
      'current_version', v_current_version,
      'current_rule_set', v_rule_set_record,
      'current_rule_set_version', v_rule_set_version,
      'reason', 'immutable_rule_version'
    );
    return public.store_rule_sync_terminal_receipt(
      v_user_id, p_mutation_id, v_device.id, v_request_hash,
      v_rule_version_id, v_client_key, v_current_version, null, v_response
    );
  end if;

  if not v_rule_set_existed then
    insert into public.prediction_rule_sets (
      owner_id, user_id, name, description, is_active, sync_version
    ) values (
      v_user_id, v_user_id, v_name, v_description, false, 1
    )
    returning id, sync_version
    into v_rule_set_id, v_rule_set_version;
  else
    v_description_changed :=
      p_payload ? 'description'
      and v_existing_description is distinct from v_description;
  end if;

  if v_rule_version_id is null then
    v_new_rule_version := true;
    perform pg_advisory_xact_lock(hashtextextended(
      v_rule_set_id::text || ':version',
      0
    ));
    select coalesce(max(version_number), 0) + 1
    into v_version_number
    from public.prediction_rule_versions
    where user_id = v_user_id and rule_set_id = v_rule_set_id;

    insert into public.prediction_rule_versions (
      user_id, rule_set_id, version_number, semantic_version, client_key,
      status, content, parameters, change_note, published_at,
      sync_version, sync_updated_at, last_mutation_id
    ) values (
      v_user_id,
      v_rule_set_id,
      v_version_number,
      v_semantic_version,
      v_client_key,
      coalesce(
        nullif(p_payload ->> 'status', '')::public.rule_version_status,
        'published'
      ),
      v_content,
      v_parameters,
      coalesce(p_payload ->> 'change_note', p_payload ->> 'note'),
      case
        when coalesce(p_payload ->> 'status', 'published') = 'published'
          then now()
      end,
      1,
      clock_timestamp(),
      p_mutation_id
    )
    returning id, sync_version
    into v_rule_version_id, v_current_version;
  elsif v_status = 'draft' then
    v_rule_version_changed := true;
    update public.prediction_rule_versions
    set content = v_content,
        parameters = v_parameters,
        semantic_version = v_semantic_version,
        change_note = coalesce(
          p_payload ->> 'change_note',
          p_payload ->> 'note',
          change_note
        ),
        status = coalesce(
          nullif(p_payload ->> 'status', '')::public.rule_version_status,
          status
        ),
        published_at = case
          when status <> 'published'
            and coalesce(
              nullif(p_payload ->> 'status', '')::public.rule_version_status,
              status
            ) = 'published'
            then clock_timestamp()
          else published_at
        end,
        sync_version = sync_version + 1,
        sync_updated_at = clock_timestamp(),
        last_mutation_id = p_mutation_id
    where id = v_rule_version_id and user_id = v_user_id
    returning sync_version into v_current_version;
  end if;

  -- A set version represents the complete version collection plus editable set
  -- metadata. New sets start at one; every successful child/metadata mutation
  -- against an existing set advances it exactly once.
  if v_rule_set_existed
     and (v_new_rule_version or v_rule_version_changed or v_description_changed) then
    update public.prediction_rule_sets
    set description = case
          when v_description_changed then v_description
          else description
        end,
        sync_version = sync_version + 1
    where id = v_rule_set_id and user_id = v_user_id
    returning sync_version into v_rule_set_version;
  end if;

  insert into public.sync_change_log (
    user_id, mutation_id, device_id, entity_type, entity_id,
    entity_client_key, operation, record_version
  ) values (
    v_user_id,
    p_mutation_id,
    v_device.id,
    'rule_version',
    v_rule_version_id,
    v_client_key,
    'upsert',
    v_current_version
  )
  returning change_seq into v_change_seq;

  v_record := public.build_synced_rule_record(v_rule_version_id);
  v_response := jsonb_build_object(
    'status', 'applied',
    'record', v_record,
    'version', v_current_version,
    'rule_set_version', v_rule_set_version,
    'change_seq', v_change_seq
  );
  return public.store_rule_sync_terminal_receipt(
    v_user_id,
    p_mutation_id,
    v_device.id,
    v_request_hash,
    v_rule_version_id,
    v_client_key,
    v_current_version,
    v_change_seq,
    v_response
  );
end;
$$;

-- is_active is edited through settings/activation RPCs rather than
-- sync_rule_version. Keep those changes inside the same parent optimistic
-- version so a parent record can never change while retaining its old version.
create or replace function public.bump_rule_set_version_on_active_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.is_active is distinct from old.is_active then
    new.sync_version := greatest(new.sync_version, old.sync_version + 1);
  end if;
  return new;
end;
$$;

drop trigger if exists prediction_rule_sets_active_sync_version
  on public.prediction_rule_sets;
create trigger prediction_rule_sets_active_sync_version
before update of is_active on public.prediction_rule_sets
for each row execute function public.bump_rule_set_version_on_active_change();

revoke all on function public.store_rule_sync_terminal_receipt(
  uuid, uuid, uuid, bytea, uuid, text, bigint, bigint, jsonb
) from public;
revoke all on function public.sync_race_record_0004_internal(
  jsonb, bigint, uuid, uuid
) from public, anon, authenticated;
revoke all on function public.sync_race_record(jsonb, bigint, uuid, uuid)
  from public;
revoke all on function public.build_complete_prediction_snapshot(uuid) from public;
revoke all on function public.validate_locked_snapshot_insert() from public;
revoke all on function public.ensure_locked_prediction_snapshot() from public;
revoke all on function public.build_synced_rule_record(uuid) from public;
revoke all on function public.sync_rule_version(jsonb, bigint, uuid, uuid) from public;
revoke all on function public.bump_rule_set_version_on_active_change()
  from public;

grant execute on function public.sync_race_record(jsonb, bigint, uuid, uuid)
  to authenticated;
grant execute on function public.build_synced_rule_record(uuid) to authenticated;
grant execute on function public.sync_rule_version(jsonb, bigint, uuid, uuid)
  to authenticated;

comment on function public.sync_rule_version(jsonb, bigint, uuid, uuid) is
  'Idempotent dual-CAS sync: p_expected_version protects the rule version and payload.expected_rule_set_version protects its parent set.';

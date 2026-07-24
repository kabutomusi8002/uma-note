-- Future local-Supabase integration test for 0006.
--
-- This file intentionally uses plain PostgreSQL assertions instead of pgTAP.
-- Run it only after a fresh local database has applied migrations 0001-0006.
-- The outer transaction guarantees that every fixture is removed.

begin;

do $test$
declare
  v_user_id uuid := extensions.gen_random_uuid();
  v_course_id uuid := extensions.gen_random_uuid();
  v_meeting_id uuid := extensions.gen_random_uuid();
  v_race_id uuid := extensions.gen_random_uuid();
  v_prediction_id uuid := extensions.gen_random_uuid();
  v_installation_id uuid := extensions.gen_random_uuid();
  v_lock_mutation_id uuid := extensions.gen_random_uuid();
  v_rule_create_mutation_id uuid := extensions.gen_random_uuid();
  v_rule_update_mutation_id uuid := extensions.gen_random_uuid();
  v_rule_conflict_mutation_id uuid := extensions.gen_random_uuid();
  v_course_code text;
  v_snapshot jsonb;
  v_snapshot_hash bytea;
  v_snapshot_scope text;
  v_current_scope text;
  v_lock_response jsonb;
  v_create_payload jsonb;
  v_update_payload jsonb;
  v_conflict_payload jsonb;
  v_create_response jsonb;
  v_update_response jsonb;
  v_replay_response jsonb;
  v_conflict_response jsonb;
  v_conflict_replay jsonb;
  v_rule_set_id uuid;
  v_rule_set_version bigint;
  v_rule_version bigint;
  v_device_id uuid;
  v_exchange_id uuid := extensions.gen_random_uuid();
  v_document_id uuid := extensions.gen_random_uuid();
  v_item_id uuid := extensions.gen_random_uuid();
  v_updated_at timestamptz;
  v_count integer;
begin
  v_course_code :=
    'H' || upper(substr(replace(v_course_id::text, '-', ''), 1, 11));

  -- A normal local Supabase auth row. The application auth trigger creates
  -- the matching profile row.
  insert into auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000',
    v_user_id,
    'authenticated',
    'authenticated',
    'hardening-' || v_user_id::text || '@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

  perform set_config('request.jwt.claim.sub', v_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  insert into public.racecourses (
    id, code, name_ja, name_en, display_order
  ) values (
    v_course_id,
    v_course_code,
    'Hardening ' || v_course_id::text,
    'Hardening',
    32760
  );

  insert into public.race_meetings (
    id,
    owner_id,
    user_id,
    racecourse_id,
    meeting_date,
    meeting_number
  ) values (
    v_meeting_id,
    v_user_id,
    v_user_id,
    v_course_id,
    current_date + 1,
    1
  );

  insert into public.races (
    id,
    user_id,
    meeting_id,
    race_number,
    starts_at,
    name,
    data_scope,
    client_key,
    client_record
  ) values (
    v_race_id,
    v_user_id,
    v_meeting_id,
    1,
    clock_timestamp() + interval '1 day',
    '0006 lock scope test',
    'demo',
    'hardening-race-' || v_race_id::text,
    '{}'::jsonb
  );

  insert into public.predictions (
    id,
    user_id,
    race_id,
    rule_snapshot,
    status,
    source
  ) values (
    v_prediction_id,
    v_user_id,
    v_race_id,
    '{}'::jsonb,
    'draft',
    'manual'
  );

  v_lock_response := public.finalize_prediction_lock(
    v_prediction_id,
    1,
    v_lock_mutation_id,
    v_installation_id
  );
  if v_lock_response ->> 'status' <> 'applied' then
    raise exception 'Expected lock to apply, got %', v_lock_response;
  end if;

  select snapshot, snapshot_sha256, data_scope::text
  into v_snapshot, v_snapshot_hash, v_snapshot_scope
  from public.prediction_locked_snapshots
  where user_id = v_user_id and prediction_id = v_prediction_id;

  if v_snapshot_scope <> 'demo'
     or v_snapshot #>> '{race,data_scope}' <> 'demo' then
    raise exception 'Lock-time demo scope was not frozen in both representations';
  end if;
  if extensions.digest(v_snapshot::text, 'sha256') <> v_snapshot_hash then
    raise exception 'Stored lock hash does not cover the canonical snapshot';
  end if;
  if extensions.digest(
       jsonb_set(v_snapshot, '{race,data_scope}', '"test"'::jsonb, true)::text,
       'sha256'
     ) = v_snapshot_hash then
    raise exception 'Changing only data_scope did not change the snapshot hash';
  end if;

  update public.races
  set data_scope = 'test'
  where id = v_race_id and user_id = v_user_id;

  select data_scope::text
  into v_current_scope
  from public.races
  where id = v_race_id and user_id = v_user_id;
  select snapshot, snapshot_sha256, data_scope::text
  into v_snapshot, v_snapshot_hash, v_snapshot_scope
  from public.prediction_locked_snapshots
  where user_id = v_user_id and prediction_id = v_prediction_id;

  if v_current_scope <> 'test'
     or v_snapshot_scope <> 'demo'
     or v_snapshot #>> '{race,data_scope}' <> 'demo' then
    raise exception 'Current scope update rewrote immutable lock-time scope';
  end if;

  begin
    insert into public.prediction_locked_snapshots (
      user_id,
      race_id,
      prediction_id,
      schema_version,
      data_scope,
      snapshot,
      snapshot_sha256,
      locked_at,
      source
    ) values (
      v_user_id,
      v_race_id,
      v_prediction_id,
      1,
      'demo',
      v_snapshot,
      v_snapshot_hash,
      (select locked_at from public.predictions where id = v_prediction_id),
      'lock_rpc'
    );
    raise exception using
      errcode = 'ZX003',
      message = 'A stale lock-time data_scope unexpectedly passed validation';
  exception
    when check_violation then null;
  end;

  begin
    perform 'invalid'::public.race_data_scope;
    raise exception using
      errcode = 'ZX001',
      message = 'Invalid race_data_scope unexpectedly passed';
  exception
    when invalid_text_representation then null;
  end;

  begin
    update public.prediction_locked_snapshots
    set data_scope = 'test'
    where user_id = v_user_id and prediction_id = v_prediction_id;
    raise exception using
      errcode = 'ZX002',
      message = 'Immutable locked snapshot unexpectedly changed';
  exception
    when sqlstate '55000' then null;
  end;

  -- Dual CAS: the child rule version and its parent set each have an
  -- independent optimistic version.
  v_create_payload := jsonb_build_object(
    'client_key', 'hardening-rule-' || v_user_id::text,
    'name', 'Hardening rule ' || v_user_id::text,
    'semantic_version', '1.0.0',
    'content', 'initial rule',
    'rules', jsonb_build_array('initial rule'),
    'status', 'draft',
    'description', 'initial description'
  );
  v_create_response := public.sync_rule_version(
    v_create_payload,
    0,
    v_rule_create_mutation_id,
    v_installation_id
  );
  if v_create_response ->> 'status' <> 'applied'
     or (v_create_response ->> 'version')::bigint <> 1
     or (v_create_response ->> 'rule_set_version')::bigint <> 1 then
    raise exception 'Unexpected initial rule response: %', v_create_response;
  end if;

  v_update_payload := v_create_payload || jsonb_build_object(
    'content', 'updated rule',
    'rules', jsonb_build_array('updated rule'),
    'description', 'updated description',
    'expected_rule_set_version', 1
  );
  v_update_response := public.sync_rule_version(
    v_update_payload,
    1,
    v_rule_update_mutation_id,
    v_installation_id
  );
  if v_update_response ->> 'status' <> 'applied'
     or (v_update_response ->> 'version')::bigint <> 2
     or (v_update_response ->> 'rule_set_version')::bigint <> 2 then
    raise exception 'Successful rule update did not advance both versions once: %',
      v_update_response;
  end if;

  v_replay_response := public.sync_rule_version(
    v_update_payload,
    1,
    v_rule_update_mutation_id,
    v_installation_id
  );
  if v_replay_response ->> 'status' <> 'replayed'
     or v_replay_response ->> 'replayed' <> 'true' then
    raise exception 'Applied mutation replay was not idempotent: %',
      v_replay_response;
  end if;

  v_rule_set_id :=
    (v_update_response #>> '{record,rule_set,id}')::uuid;
  select sync_version into v_rule_set_version
  from public.prediction_rule_sets
  where id = v_rule_set_id and user_id = v_user_id;
  select sync_version into v_rule_version
  from public.prediction_rule_versions
  where id = (v_update_response #>> '{record,id}')::uuid
    and user_id = v_user_id;
  if v_rule_set_version <> 2 or v_rule_version <> 2 then
    raise exception 'Replay double-applied a version increment';
  end if;

  v_conflict_payload := v_update_payload || jsonb_build_object(
    'content', 'must not be applied',
    'rules', jsonb_build_array('must not be applied'),
    'expected_rule_set_version', 1
  );
  v_conflict_response := public.sync_rule_version(
    v_conflict_payload,
    2,
    v_rule_conflict_mutation_id,
    v_installation_id
  );
  if v_conflict_response ->> 'status' <> 'conflict'
     or v_conflict_response ->> 'reason' <> 'rule_set_version_mismatch'
     or (v_conflict_response ->> 'current_rule_set_version')::bigint <> 2 then
    raise exception 'Stale parent CAS did not return the expected conflict: %',
      v_conflict_response;
  end if;

  select count(*) into v_count
  from public.sync_mutation_receipts
  where user_id = v_user_id
    and mutation_id = v_rule_conflict_mutation_id
    and response ->> 'status' = 'conflict';
  if v_count <> 1 then
    raise exception 'Rule-set conflict did not create one terminal receipt';
  end if;

  v_conflict_replay := public.sync_rule_version(
    v_conflict_payload,
    2,
    v_rule_conflict_mutation_id,
    v_installation_id
  );
  if v_conflict_replay ->> 'status' <> 'conflict'
     or v_conflict_replay ->> 'reason' <> 'rule_set_version_mismatch'
     or v_conflict_replay ->> 'replayed' <> 'true' then
    raise exception 'Conflict replay changed the original terminal outcome: %',
      v_conflict_replay;
  end if;

  select sync_version into v_rule_set_version
  from public.prediction_rule_sets
  where id = v_rule_set_id and user_id = v_user_id;
  select sync_version into v_rule_version
  from public.prediction_rule_versions
  where id = (v_update_response #>> '{record,id}')::uuid
    and user_id = v_user_id;
  if v_rule_set_version <> 2 or v_rule_version <> 2 then
    raise exception 'Conflict or conflict replay mutated rule versions';
  end if;

  select count(*) into v_count
  from public.sync_change_log
  where user_id = v_user_id
    and entity_type = 'rule_version'
    and entity_client_key = v_create_payload ->> 'client_key';
  if v_count <> 2 then
    raise exception 'Expected exactly two rule change-log entries, found %', v_count;
  end if;

  -- updated_at must be maintained independently from the domain timestamps.
  select id into v_device_id
  from public.sync_devices
  where user_id = v_user_id and installation_id = v_installation_id;

  insert into public.race_exchange_documents (
    id,
    owner_id,
    user_id,
    direction,
    status,
    document_text
  ) values (
    v_exchange_id,
    v_user_id,
    v_user_id,
    'export',
    'pending',
    'hardening test'
  );
  update public.race_exchange_documents
  set document_text = document_text,
      updated_at = '2000-01-01 00:00:00+00'
  where id = v_exchange_id and user_id = v_user_id;
  select updated_at into v_updated_at
  from public.race_exchange_documents
  where id = v_exchange_id and user_id = v_user_id;
  if v_updated_at <= '2000-01-01 00:00:00+00'::timestamptz then
    raise exception 'race_exchange_documents.updated_at trigger did not run';
  end if;

  insert into public.local_migration_documents (
    id,
    user_id,
    device_id,
    import_key,
    source_version,
    document,
    document_sha256,
    status,
    item_count
  ) values (
    v_document_id,
    v_user_id,
    v_device_id,
    extensions.gen_random_uuid(),
    'v0.1.1-local-clean',
    '{"races":[],"rules":[]}'::jsonb,
    extensions.digest('{"races":[],"rules":[]}'::jsonb::text, 'sha256'),
    'staged',
    1
  );

  insert into public.local_migration_items (
    id,
    user_id,
    document_id,
    ordinal,
    entity_type,
    client_key,
    expected_version,
    payload,
    payload_sha256,
    status
  ) values (
    v_item_id,
    v_user_id,
    v_document_id,
    1,
    'race',
    'timestamp-test',
    0,
    '{"client_key":"timestamp-test"}'::jsonb,
    extensions.digest(
      '{"client_key":"timestamp-test"}'::jsonb::text,
      'sha256'
    ),
    'staged'
  );

  update public.local_migration_documents
  set status = status,
      updated_at = '2000-01-01 00:00:00+00'
  where id = v_document_id and user_id = v_user_id;
  select updated_at into v_updated_at
  from public.local_migration_documents
  where id = v_document_id and user_id = v_user_id;
  if v_updated_at <= '2000-01-01 00:00:00+00'::timestamptz then
    raise exception 'local_migration_documents.updated_at trigger did not run';
  end if;

  update public.local_migration_items
  set status = status,
      updated_at = '2000-01-01 00:00:00+00'
  where id = v_item_id and user_id = v_user_id;
  select updated_at into v_updated_at
  from public.local_migration_items
  where id = v_item_id and user_id = v_user_id;
  if v_updated_at <= '2000-01-01 00:00:00+00'::timestamptz then
    raise exception 'local_migration_items.updated_at trigger did not run';
  end if;
end
$test$;

rollback;

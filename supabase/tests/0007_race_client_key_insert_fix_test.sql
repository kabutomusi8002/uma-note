-- Local-Supabase integration test for 0007.
--
-- Run only after a fresh local database has applied migrations 0001-0007.
-- Plain PostgreSQL assertions keep the test independent from pgTAP. The outer
-- transaction rolls back the auth user, fixtures, receipts, and change log.

begin;

do $test$
declare
  v_user_id uuid := extensions.gen_random_uuid();
  v_course_id uuid := extensions.gen_random_uuid();
  v_installation_id uuid := extensions.gen_random_uuid();
  v_create_mutation_id uuid := extensions.gen_random_uuid();
  v_update_mutation_id uuid := extensions.gen_random_uuid();
  v_conflict_mutation_id uuid := extensions.gen_random_uuid();
  v_natural_conflict_mutation_id uuid := extensions.gen_random_uuid();
  v_rekey_mutation_id uuid := extensions.gen_random_uuid();
  v_lock_mutation_id uuid := extensions.gen_random_uuid();
  v_scope_update_mutation_id uuid := extensions.gen_random_uuid();
  v_course_code text;
  v_client_key text;
  v_other_client_key text;
  v_starts_at timestamptz := clock_timestamp() + interval '7 days';
  v_base_payload jsonb;
  v_changed_payload jsonb;
  v_update_payload jsonb;
  v_scope_update_payload jsonb;
  v_natural_conflict_payload jsonb;
  v_rekey_payload jsonb;
  v_response jsonb;
  v_replay jsonb;
  v_conflict jsonb;
  v_race_id uuid;
  v_prediction_id uuid;
  v_stored_key text;
  v_stored_name text;
  v_stored_scope text;
  v_stored_version bigint;
  v_snapshot_scope text;
  v_snapshot jsonb;
  v_snapshot_hash bytea;
  v_original_snapshot jsonb;
  v_original_snapshot_hash bytea;
  v_upsert_definition text;
  v_internal_definition text;
  v_count integer;
begin
  v_course_code :=
    'K' || upper(substr(replace(v_course_id::text, '-', ''), 1, 11));
  v_client_key := 'race-0007-' || v_user_id::text;
  v_other_client_key := 'race-0007-other-' || v_user_id::text;

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
    'race-key-' || v_user_id::text || '@example.invalid',
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
    'Race key test ' || v_course_id::text,
    'Race key test',
    32759
  );

  v_base_payload := jsonb_build_object(
    'client_key', v_client_key,
    'meeting', jsonb_build_object(
      'racecourse', jsonb_build_object('code', v_course_code),
      'meeting_date', (current_date + 7)::text,
      'meeting_number', 1
    ),
    'race', jsonb_build_object(
      'race_number', 1,
      'starts_at', v_starts_at,
      'name', '0007 initial race',
      'surface', 'turf',
      'data_scope', 'demo'
    ),
    'prediction', jsonb_build_object(
      'status', 'draft',
      'summary', '0007 original prediction'
    )
  );

  -- The migration must contain a direct atomic insert and must not retain the
  -- old post-insert re-key update.
  select pg_get_functiondef(
    'public.upsert_race_record(jsonb)'::regprocedure
  ) into v_upsert_definition;
  if v_upsert_definition !~*
       'insert\s+into\s+public[.]races\s*[(]\s*user_id\s*,\s*meeting_id\s*,\s*client_key' then
    raise exception 'upsert_race_record does not insert client_key atomically';
  end if;

  select pg_get_functiondef(
    'public.sync_race_record_0004_internal(jsonb,bigint,uuid,uuid)'::regprocedure
  ) into v_internal_definition;
  if v_internal_definition ~*
       'update\s+public[.]races\s+set\s+client_key\s*=' then
    raise exception 'Internal race sync still post-updates client_key';
  end if;

  if not exists (
    select 1
    from pg_trigger t
    where t.tgrelid = 'public.races'::regclass
      and t.tgname = 'races_reject_client_key_change'
      and not t.tgisinternal
  ) then
    raise exception 'Race client_key immutability trigger is missing';
  end if;

  if not exists (
    select 1
    from pg_attribute a
    where a.attrelid = 'public.races'::regclass
      and a.attname = 'client_key'
      and a.attnotnull
      and not a.attisdropped
  ) then
    raise exception 'races.client_key is not NOT NULL';
  end if;

  if not exists (
    select 1
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    where i.indrelid = 'public.races'::regclass
      and c.relname = 'races_user_client_key_uidx'
      and i.indisunique
      and i.indisvalid
  ) then
    raise exception 'Per-user race client_key unique index is missing';
  end if;

  -- A new mutation must provide a non-blank explicit client key. Validation
  -- happens before any meeting/race write.
  begin
    perform public.sync_race_record(
      v_base_payload - 'client_key',
      0,
      extensions.gen_random_uuid(),
      v_installation_id
    );
    raise exception using
      errcode = 'ZX001',
      message = 'Missing client_key unexpectedly passed';
  exception
    when sqlstate '22023' then null;
  end;

  begin
    perform public.sync_race_record(
      v_base_payload || jsonb_build_object('client_key', null),
      0,
      extensions.gen_random_uuid(),
      v_installation_id
    );
    raise exception using
      errcode = 'ZX002',
      message = 'Null client_key unexpectedly passed';
  exception
    when sqlstate '22023' then null;
  end;

  begin
    perform public.sync_race_record(
      v_base_payload || jsonb_build_object('client_key', ''),
      0,
      extensions.gen_random_uuid(),
      v_installation_id
    );
    raise exception using
      errcode = 'ZX003',
      message = 'Empty client_key unexpectedly passed';
  exception
    when sqlstate '22023' then null;
  end;

  begin
    perform public.sync_race_record(
      v_base_payload || jsonb_build_object('client_key', '   '),
      0,
      extensions.gen_random_uuid(),
      v_installation_id
    );
    raise exception using
      errcode = 'ZX004',
      message = 'Whitespace client_key unexpectedly passed';
  exception
    when sqlstate '22023' then null;
  end;

  begin
    perform public.sync_race_record(
      v_base_payload || jsonb_build_object('client_key', repeat('x', 161)),
      0,
      extensions.gen_random_uuid(),
      v_installation_id
    );
    raise exception using
      errcode = 'ZX005',
      message = 'Overlong client_key unexpectedly passed';
  exception
    when sqlstate '22023' then null;
  end;

  select count(*) into v_count
  from public.races
  where user_id = v_user_id;
  if v_count <> 0 then
    raise exception 'Invalid client_key request created a race';
  end if;

  -- First cloud save succeeds even though client_key is NOT NULL, proving the
  -- key is supplied by the INSERT itself.
  v_response := public.sync_race_record(
    v_base_payload,
    0,
    v_create_mutation_id,
    v_installation_id
  );
  if v_response ->> 'status' <> 'applied'
     or (v_response ->> 'version')::bigint <> 1 then
    raise exception 'Unexpected initial race response: %', v_response;
  end if;
  v_race_id := (v_response #>> '{record,id}')::uuid;

  select client_key, name, data_scope::text, sync_version
  into v_stored_key, v_stored_name, v_stored_scope, v_stored_version
  from public.races
  where id = v_race_id and user_id = v_user_id;
  if v_stored_key <> v_client_key
     or v_stored_name <> '0007 initial race'
     or v_stored_scope <> 'demo'
     or v_stored_version <> 1 then
    raise exception 'Initial race identity or content is wrong';
  end if;

  select count(*) into v_count
  from public.sync_mutation_receipts
  where user_id = v_user_id
    and mutation_id = v_create_mutation_id
    and entity_client_key = v_client_key
    and resulting_version = 1;
  if v_count <> 1 then
    raise exception 'Initial race mutation receipt is missing or duplicated';
  end if;

  -- Exact replay returns the committed response without applying a second
  -- version or change-log entry.
  v_replay := public.sync_race_record(
    v_base_payload,
    0,
    v_create_mutation_id,
    v_installation_id
  );
  if v_replay ->> 'status' <> 'replayed'
     or (v_replay ->> 'version')::bigint <> 1 then
    raise exception 'Exact race mutation did not replay idempotently: %',
      v_replay;
  end if;

  select count(*) into v_count
  from public.sync_change_log
  where user_id = v_user_id
    and mutation_id = v_create_mutation_id;
  if v_count <> 1 then
    raise exception 'Race mutation replay duplicated the change log';
  end if;

  v_changed_payload := jsonb_set(
    v_base_payload,
    '{race,name}',
    to_jsonb('0007 changed replay'::text),
    true
  );
  begin
    perform public.sync_race_record(
      v_changed_payload,
      0,
      v_create_mutation_id,
      v_installation_id
    );
    raise exception using
      errcode = 'ZX006',
      message = 'Mutation id reuse with changed content unexpectedly passed';
  exception
    when sqlstate '22023' then null;
  end;

  -- Same client key with new content and a create-version expectation is a
  -- conflict, not an implicit duplicate insert or overwrite.
  v_conflict := public.sync_race_record(
    v_changed_payload,
    0,
    v_conflict_mutation_id,
    v_installation_id
  );
  if v_conflict ->> 'status' <> 'conflict'
     or v_conflict ->> 'reason' <> 'version_mismatch'
     or (v_conflict ->> 'current_version')::bigint <> 1 then
    raise exception 'Duplicate client_key did not produce a version conflict: %',
      v_conflict;
  end if;

  select name, sync_version into v_stored_name, v_stored_version
  from public.races
  where id = v_race_id and user_id = v_user_id;
  if v_stored_name <> '0007 initial race' or v_stored_version <> 1 then
    raise exception 'Client-key conflict silently changed the race';
  end if;

  -- A legitimate compare-and-swap update keeps the key and advances once.
  v_update_payload := v_changed_payload
    || jsonb_build_object('id', v_race_id);
  v_response := public.sync_race_record(
    v_update_payload,
    1,
    v_update_mutation_id,
    v_installation_id
  );
  if v_response ->> 'status' <> 'applied'
     or (v_response ->> 'version')::bigint <> 2 then
    raise exception 'Valid race CAS update failed: %', v_response;
  end if;

  select client_key, name, sync_version
  into v_stored_key, v_stored_name, v_stored_version
  from public.races
  where id = v_race_id and user_id = v_user_id;
  if v_stored_key <> v_client_key
     or v_stored_name <> '0007 changed replay'
     or v_stored_version <> 2 then
    raise exception 'Valid race update changed identity or wrong version';
  end if;

  -- Freeze a canonical snapshot, then edit only the current race scope. The
  -- lock-time scope, JSON, and hash must not move.
  select id into v_prediction_id
  from public.predictions
  where race_id = v_race_id and user_id = v_user_id;
  v_response := public.finalize_prediction_lock(
    v_prediction_id,
    2,
    v_lock_mutation_id,
    v_installation_id
  );
  if v_response ->> 'status' <> 'applied'
     or (v_response ->> 'version')::bigint <> 3 then
    raise exception 'Prediction lock failed: %', v_response;
  end if;

  select data_scope::text, snapshot, snapshot_sha256
  into v_snapshot_scope, v_snapshot, v_snapshot_hash
  from public.prediction_locked_snapshots
  where prediction_id = v_prediction_id and user_id = v_user_id;
  v_original_snapshot := v_snapshot;
  v_original_snapshot_hash := v_snapshot_hash;
  if v_snapshot_scope <> 'demo'
     or v_snapshot #>> '{race,data_scope}' <> 'demo' then
    raise exception 'Lock did not freeze the demo data_scope';
  end if;

  v_scope_update_payload := jsonb_set(
    v_update_payload,
    '{race,data_scope}',
    '"test"'::jsonb,
    true
  );
  v_response := public.sync_race_record(
    v_scope_update_payload,
    3,
    v_scope_update_mutation_id,
    v_installation_id
  );
  if v_response ->> 'status' <> 'applied'
     or (v_response ->> 'version')::bigint <> 4 then
    raise exception 'Current data_scope update failed: %', v_response;
  end if;

  select data_scope::text, client_key, sync_version
  into v_stored_scope, v_stored_key, v_stored_version
  from public.races
  where id = v_race_id and user_id = v_user_id;
  select data_scope::text, snapshot, snapshot_sha256
  into v_snapshot_scope, v_snapshot, v_snapshot_hash
  from public.prediction_locked_snapshots
  where prediction_id = v_prediction_id and user_id = v_user_id;
  if v_stored_scope <> 'test'
     or v_stored_key <> v_client_key
     or v_stored_version <> 4
     or v_snapshot_scope <> 'demo'
     or v_snapshot is distinct from v_original_snapshot
     or v_snapshot_hash <> v_original_snapshot_hash then
    raise exception 'Current race update changed immutable lock evidence';
  end if;

  select count(*) into v_count
  from public.v_race_financial_summary
  where race_id = v_race_id;
  if v_count <> 0 then
    raise exception 'A test race leaked into the live financial summary';
  end if;

  -- A second client identity cannot claim the same natural race.
  v_natural_conflict_payload := v_scope_update_payload
    || jsonb_build_object(
      'client_key', v_other_client_key,
      'id', extensions.gen_random_uuid()
    );
  v_conflict := public.sync_race_record(
    v_natural_conflict_payload,
    0,
    v_natural_conflict_mutation_id,
    v_installation_id
  );
  if v_conflict ->> 'status' <> 'conflict'
     or v_conflict ->> 'reason' <> 'natural_key_exists' then
    raise exception 'Natural-key duplicate was not rejected: %', v_conflict;
  end if;

  select count(*) into v_count
  from public.races
  where user_id = v_user_id;
  if v_count <> 1 then
    raise exception 'Natural-key conflict created a duplicate race';
  end if;

  -- Neither the sync RPC nor direct table access may re-key an existing row.
  v_rekey_payload := v_scope_update_payload
    || jsonb_build_object(
      'client_key', v_other_client_key,
      'id', v_race_id
    );
  v_conflict := public.sync_race_record(
    v_rekey_payload,
    4,
    v_rekey_mutation_id,
    v_installation_id
  );
  if v_conflict ->> 'status' <> 'conflict'
     or v_conflict ->> 'reason' <> 'client_key_mismatch' then
    raise exception 'Sync RPC allowed or misclassified a race re-key: %',
      v_conflict;
  end if;

  begin
    update public.races
    set client_key = v_other_client_key
    where id = v_race_id and user_id = v_user_id;
    raise exception using
      errcode = 'ZX007',
      message = 'Direct race re-key unexpectedly passed';
  exception
    when sqlstate '42501' then null;
  end;

  select client_key, data_scope::text, sync_version
  into v_stored_key, v_stored_scope, v_stored_version
  from public.races
  where id = v_race_id and user_id = v_user_id;
  if v_stored_key <> v_client_key
     or v_stored_scope <> 'test'
     or v_stored_version <> 4 then
    raise exception 'Rejected re-key changed the stored race';
  end if;
end
$test$;

rollback;

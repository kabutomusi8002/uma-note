-- Fix first cloud race inserts after races.client_key became NOT NULL.
--
-- The public 0006 wrapper remains unchanged. This migration replaces only its
-- private 0004 implementation and the legacy aggregate writer that it invokes.
-- Existing rows, data_scope values, and immutable lock snapshots are untouched.

create or replace function public.upsert_race_record(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_client_key text;
  v_existing_client_key text;
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

  -- 0007: cloud identity is explicit and canonical. A row must never be
  -- inserted with a temporary/default key and re-keyed after the aggregate save.
  v_client_key := nullif(btrim(payload ->> 'client_key'), '');
  if v_client_key is null or char_length(v_client_key) > 160 then
    raise exception using
      errcode = '22023',
      message = 'A valid explicit client_key is required';
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
           r.race_number, r.starts_at, r.client_key
    into v_meeting_id, v_course_id, v_meeting_date, v_meeting_number,
         v_race_number, v_starts_at, v_existing_client_key
    from public.races r
    join public.race_meetings m on m.id = r.meeting_id
    where r.id = v_race_id
      and r.user_id = v_user_id;

    if found and v_existing_client_key is distinct from v_client_key then
      raise exception using
        errcode = '22023',
        message = 'Existing race client_key is immutable';
    elsif not found then
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
      user_id, meeting_id, client_key, race_number, starts_at, name, grade,
      surface, distance_m, status, data_scope, notes
    ) values (
      v_user_id,
      v_meeting_id,
      v_client_key,
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
    where races.user_id = v_user_id
      and races.client_key = v_client_key
    returning id into v_race_id;

    if not found then
      raise exception using
        errcode = '23505',
        message = 'Race natural identity already belongs to a different client_key';
    end if;
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
    where id = v_race_id
      and user_id = v_user_id
      and client_key = v_client_key;

    if not found then
      raise exception using
        errcode = '22023',
        message = 'Existing race client_key is immutable';
    end if;
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

-- Enforce client identity immutability for every write path, including future
-- security-definer helpers and direct authenticated table updates.
create or replace function public.reject_race_client_key_change()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.client_key is distinct from old.client_key then
    raise exception using
      errcode = '42501',
      message = 'Race client_key is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists races_reject_client_key_change on public.races;
create trigger races_reject_client_key_change
before update of client_key on public.races
for each row execute function public.reject_race_client_key_change();

create or replace function public.sync_race_record_0004_internal(
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
  v_payload_owned_race_id uuid;
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

  -- Preserve replay compatibility with receipts committed before 0007, then
  -- require an explicit key for every new mutation. The payload id is not a
  -- substitute because server ids and client identities have different roles.
  v_client_key := nullif(btrim(p_payload ->> 'client_key'), '');
  if v_client_key is null or char_length(v_client_key) > 160 then
    raise exception using
      errcode = '22023',
      message = 'A valid explicit client_key is required';
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
    select r.id into v_payload_owned_race_id
    from public.races r
    where r.id = v_payload_id and r.user_id = v_user_id;
  end if;

  select id, sync_version, client_key
  into v_race_id, v_current_version, v_current_client_key
  from public.races
  where user_id = v_user_id and client_key = v_client_key;

  if v_race_id is not null
     and v_payload_owned_race_id is not null
     and v_payload_owned_race_id <> v_race_id then
    v_current_record := public.build_synced_race_record(v_race_id);
    return jsonb_build_object(
      'status', 'conflict',
      'current', v_current_record,
      'current_version', v_current_version,
      'reason', 'identity_collision'
    );
  end if;

  if v_race_id is null and v_payload_owned_race_id is not null then
    select id, sync_version, client_key
    into v_race_id, v_current_version, v_current_client_key
    from public.races
    where user_id = v_user_id and id = v_payload_owned_race_id;
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
    if v_current_client_key is distinct from v_client_key then
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
    select 1
    from public.races
    where id = v_race_id
      and user_id = v_user_id
      and client_key = v_client_key
  ) then
    raise exception using
      errcode = '42501',
      message = 'Aggregate writer returned an unexpected race identity';
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
  set client_record = v_client_record,
      sync_version = case
        when p_expected_version = 0 then sync_version
        else sync_version + 1
      end,
      sync_updated_at = clock_timestamp(),
      last_mutation_id = p_mutation_id
  where id = v_race_id
    and user_id = v_user_id
    and client_key = v_client_key
  returning sync_version into v_current_version;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'Race client_key changed during sync';
  end if;

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


revoke all on function public.upsert_race_record(jsonb)
  from public, anon, authenticated;
revoke all on function public.sync_race_record_0004_internal(
  jsonb, bigint, uuid, uuid
) from public, anon, authenticated;
revoke all on function public.reject_race_client_key_change()
  from public, anon, authenticated;

comment on function public.sync_race_record_0004_internal(
  jsonb, bigint, uuid, uuid
) is
  'Internal race sync writer. 0007 requires an explicit immutable client_key and inserts it atomically with the race.';

-- Keep demo/test races available for product evaluation without allowing them
-- to affect live bankroll and performance summaries.

do $$
begin
  create type public.race_data_scope as enum ('live', 'demo', 'test');
exception
  when duplicate_object then null;
end
$$;

alter table public.races
  add column if not exists data_scope public.race_data_scope not null default 'live';

comment on column public.races.data_scope is
  'live contributes to financial analytics; demo and test are excluded';

create or replace view public.v_race_financial_summary
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

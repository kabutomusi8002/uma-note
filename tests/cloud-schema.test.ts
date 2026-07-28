import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tenancy = readFileSync(
  new URL("../supabase/migrations/0003_cloud_tenancy.sql", import.meta.url),
  "utf8",
);
const protocol = readFileSync(
  new URL("../supabase/migrations/0004_cloud_sync_protocol.sql", import.meta.url),
  "utf8",
);
const lockedMigration = readFileSync(
  new URL(
    "../supabase/migrations/0005_locked_snapshot_and_local_migration.sql",
    import.meta.url,
  ),
  "utf8",
);

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing start marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing end marker: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("cloud tenancy migration", () => {
  const userTables = [
    "profiles",
    "prediction_rule_sets",
    "prediction_rule_versions",
    "race_meetings",
    "races",
    "race_entries",
    "predictions",
    "prediction_horse_selections",
    "prediction_revisions",
    "bet_slips",
    "bet_tickets",
    "race_results",
    "race_finishers",
    "payouts",
    "race_reflections",
    "race_reflection_tags",
    "race_exchange_documents",
  ];

  it("adds, backfills, and makes direct user_id mandatory on every user table", () => {
    for (const table of userTables) {
      expect(tenancy).toContain(
        `alter table public.${table} add column if not exists user_id uuid`,
      );
      expect(tenancy).toContain(`alter table public.${table} enable row level security`);
      expect(tenancy).toContain(`'${table}'`);
    }
    expect(tenancy).toContain("alter column user_id set not null");
    expect(tenancy).toContain("alter column user_id set default auth.uid()");
    expect(tenancy).toContain("set user_id = owner_id");
    expect(tenancy).toContain("set user_id = m.user_id");
    expect(tenancy).toContain("set user_id = r.user_id");
  });

  it("uses tenant-qualified foreign keys instead of join-only ownership", () => {
    const requiredConstraints = [
      "races_user_meeting_fk",
      "race_entries_user_race_fk",
      "predictions_user_race_fk",
      "prediction_selections_user_prediction_fk",
      "prediction_selections_user_entry_fk",
      "bet_slips_user_race_fk",
      "bet_tickets_user_slip_fk",
      "race_results_user_race_fk",
      "race_finishers_user_result_fk",
      "payouts_user_result_fk",
      "race_reflections_user_race_fk",
      "race_reflection_tags_user_reflection_fk",
    ];
    for (const constraint of requiredConstraints) {
      expect(tenancy).toContain(`'${constraint}'`);
    }
    expect(tenancy).toContain("foreign key (user_id, race_id)");
    expect(tenancy).toContain("references public.races(user_id, id)");
    expect(tenancy).toContain("create or replace function public.protect_user_id()");
    expect(tenancy).toContain("new.user_id is distinct from old.user_id");
  });

  it("applies direct auth.uid ownership while keeping shared catalogs read-only", () => {
    expect(tenancy.match(/user_id = \(select auth\.uid\(\)\)/g)?.length).toBeGreaterThan(
      20,
    );
    expect(tenancy).toContain(
      "revoke insert, update, delete on public.racecourses, public.reflection_categories from authenticated",
    );
    expect(tenancy).toContain(
      "grant select on public.racecourses, public.reflection_categories to authenticated",
    );
    expect(tenancy).not.toContain(
      "alter table public.racecourses add column if not exists user_id",
    );
    expect(tenancy).not.toContain(
      "alter table public.reflection_categories add column if not exists user_id",
    );
  });
});

describe("cloud sync protocol", () => {
  it("carries the active rule client key into user settings", () => {
    expect(protocol).toContain("select v.id, v.client_key");
    expect(protocol).toContain(
      "jsonb_build_object('activeRuleVersionId', rv.client_key)",
    );
  });

  it("publishes only the user-RLS change log as a realtime wake-up signal", () => {
    expect(protocol).toContain(
      "alter publication supabase_realtime add table public.sync_change_log",
    );
    expect(protocol).toContain("pg_publication_tables");
  });
  it("defines stable IDs, versions, devices, settings, receipts, and a change cursor", () => {
    expect(protocol).toContain("alter table public.races add column if not exists client_key text");
    expect(protocol).toContain("alter table public.races add column if not exists client_record jsonb");
    expect(protocol).toContain("races_client_record_object");
    expect(protocol).toContain("check (jsonb_typeof(client_record) = 'object')");
    expect(protocol).toContain("sync_version bigint not null default 1");
    expect(protocol).toContain("create unique index if not exists races_user_client_key_uidx");
    for (const table of [
      "sync_devices",
      "user_settings",
      "sync_mutation_receipts",
      "sync_change_log",
    ]) {
      expect(protocol).toContain(`create table if not exists public.${table}`);
      expect(protocol).toContain(`alter table public.${table} enable row level security`);
      expect(protocol).toContain(`public.${table}`);
    }
    expect(protocol).toContain("request_sha256 bytea not null");
    expect(protocol).toContain("change_seq bigint generated always as identity primary key");
    expect(protocol).toContain("primary key (user_id, mutation_id)");
    expect(protocol).toContain("create trigger sync_mutation_receipts_append_only");
    expect(protocol).toContain("create trigger sync_change_log_append_only");
  });

  it("normalizes duplicated legacy semantic versions without secondary collisions", () => {
    expect(protocol).toContain(
      "v_candidate := 'legacy-' || replace(v_row.id::text, '-', '')",
    );
    expect(protocol).toContain("if v_attempt > 0 then");
    expect(protocol).toContain("existing.semantic_version = v_candidate");
    expect(protocol).toContain("exit when not exists");
    expect(protocol).not.toContain(
      "left(rv.semantic_version, 8) || '-legacy-' || rv.version_number::text",
    );
  });

  it("returns applied, replayed, and non-writing conflict envelopes", () => {
    const raceSync = between(
      protocol,
      "create or replace function public.sync_race_record(",
      "-- ---------------------------------------------------------------------------\n-- Immutable rule-version sync",
    );
    expect(raceSync).toContain("'status', 'applied'");
    expect(raceSync).toContain("jsonb_build_object('status', 'replayed')");
    expect(raceSync).toContain("'status', 'conflict'");
    expect(raceSync).toContain("'current', v_current_record");
    expect(raceSync).toContain("'current_version', v_current_version");
    expect(raceSync).toContain("'reason', 'version_mismatch'");
    expect(raceSync).toContain("'record', v_saved_record");
    expect(raceSync).toContain("'change_seq', v_change_seq");
    expect(raceSync.indexOf("'reason', 'version_mismatch'")).toBeLessThan(
      raceSync.indexOf("v_device := public.register_sync_device"),
    );
  });

  it("serializes aggregate identity and rejects mutation-id payload substitution", () => {
    expect(protocol).toContain(":mutation:");
    expect(protocol).toContain(":race-client:");
    expect(protocol).toContain(":race-natural:");
    expect(protocol).toContain("request_sha256 <> v_request_hash");
    expect(protocol).toContain(
      "mutation_id was already used with a different request",
    );
    expect(protocol).toContain("extensions.digest(");
  });

  it("returns structured rule identity conflicts before updating a draft", () => {
    const ruleSync = between(
      protocol,
      "create or replace function public.sync_rule_version(",
      "create or replace function public.activate_rule_version(",
    );
    expect(ruleSync).toContain("v_existing_name <> v_name");
    expect(ruleSync).toContain("'reason', 'rule_set_name_mismatch'");
    expect(ruleSync).toContain("'requested_name', v_name");
    expect(ruleSync).toContain("'current_name', v_existing_name");
    expect(ruleSync).toContain("and semantic_version = v_semantic_version");
    expect(ruleSync).toContain("and id <> v_rule_version_id");
    expect(ruleSync).toContain("'reason', 'semantic_version_exists'");
    expect(ruleSync).toContain("'conflicting_record', v_conflicting_record");
    expect(ruleSync).toContain("'current_version', v_current_version");
    expect(ruleSync.indexOf("'reason', 'rule_set_name_mismatch'")).toBeLessThan(
      ruleSync.indexOf("update public.prediction_rule_versions"),
    );
    expect(ruleSync.indexOf("and id <> v_rule_version_id")).toBeLessThan(
      ruleSync.indexOf("update public.prediction_rule_versions"),
    );
  });

  it("keeps the editable client record while canonical lock fields stay authoritative", () => {
    const reader = between(
      protocol,
      "create or replace function public.build_synced_race_record(",
      "create or replace function public.build_synced_rule_record(",
    );
    const raceSync = between(
      protocol,
      "create or replace function public.sync_race_record(",
      "-- ---------------------------------------------------------------------------\n-- User preferences sync",
    );

    expect(reader).toContain("|| coalesce(s.client_record, '{}'::jsonb)");
    expect(reader).toContain("'status', m.canonical_record #> '{prediction,status}'");
    expect(reader).toContain(
      "'effective_status', m.canonical_record #> '{prediction,effective_status}'",
    );
    expect(reader).toContain("'locked_at', m.canonical_record #> '{prediction,locked_at}'");
    expect(reader).toContain("and r.user_id = auth.uid()");
    expect(protocol).toContain("public.build_synced_race_record(r.id)");

    expect(raceSync).toContain("v_effective_payload := v_effective_payload - 'prediction'");
    expect(raceSync).toContain("where item.value ->> 'kind' = 'actual'");
    expect(raceSync).toContain("|| coalesce(v_existing_client_record, '{}'::jsonb)");
    expect(raceSync).toContain("p_payload\n      - 'user_id'\n      - 'owner_id'");
    expect(raceSync).toContain("client_record = v_client_record");
    expect(raceSync).toContain(
      "'select public.store_offline_prediction_lock($1, $2, $3, $4)'",
    );
    expect(raceSync).toContain("p_payload #>> '{prediction,status}' = 'locked'");
    expect(raceSync).toContain(
      "jsonb_typeof(p_payload #> '{prediction,locked_snapshot}') = 'object'",
    );
    expect(raceSync).toContain(
      "nullif(p_payload #>> '{prediction,locked_at}', '') is not null",
    );
    expect(raceSync.indexOf("v_effective_payload := v_effective_payload - 'prediction'")).toBeLessThan(
      raceSync.indexOf("public.upsert_race_record(v_effective_payload)"),
    );
    expect(raceSync).not.toContain("prediction_locked_snapshots");
  });

  it("uses the same optimistic envelope for user preferences", () => {
    const settingsSync = between(
      protocol,
      "create or replace function public.sync_user_settings(",
      "-- ---------------------------------------------------------------------------\n-- Immutable rule-version sync",
    );
    expect(protocol).toContain("preferences jsonb not null default '{}'::jsonb");
    expect(protocol).toContain("user_settings_sync_version_positive");
    expect(settingsSync).toContain("p_preferences jsonb");
    expect(settingsSync).toContain("'status', 'applied'");
    expect(settingsSync).toContain("jsonb_build_object('status', 'replayed')");
    expect(settingsSync).toContain("'status', 'conflict'");
    expect(settingsSync).toContain("'current', v_record");
    expect(settingsSync).toContain("'sync_version', sync_version");
    expect(settingsSync).toContain("p_preferences ? 'activeRuleVersionId'");
    expect(settingsSync).toContain("rv.client_key = v_active_rule_client_key");
    expect(settingsSync).toContain("'reason', 'active_rule_not_found'");
    expect(settingsSync).toContain("active_rule_version_id = case");
    expect(protocol).toContain(
      "grant execute on function public.sync_user_settings(jsonb, bigint, uuid, uuid) to authenticated",
    );
  });

  it("makes aggregate writes RPC-only and keeps change reads RLS-scoped", () => {
    expect(protocol).toContain("create or replace function public.get_sync_changes(");
    expect(protocol).toContain("create or replace function public.get_sync_bootstrap()");
    expect(protocol).toContain("'latest_change_seq'");
    expect(protocol).toContain("where c.user_id = auth.uid()");
    expect(protocol).toContain("revoke insert, update, delete on");
    expect(protocol).toContain(
      "revoke execute on function public.upsert_race_record(jsonb) from authenticated",
    );
    expect(protocol).toContain(
      "grant execute on function public.sync_race_record(jsonb, bigint, uuid, uuid) to authenticated",
    );
  });
});

describe("locked evidence and local migration", () => {
  it("stores a separately immutable complete pre-race snapshot", () => {
    expect(lockedMigration).toContain(
      "create table if not exists public.prediction_locked_snapshots",
    );
    expect(lockedMigration).toContain("snapshot_sha256 bytea not null");
    expect(lockedMigration).toContain("create trigger prediction_locked_snapshots_immutable");
    expect(lockedMigration).toContain("A locked prediction snapshot is immutable");

    const builder = between(
      lockedMigration,
      "create or replace function public.build_complete_prediction_snapshot(",
      "create or replace function public.protect_locked_snapshot()",
    );
    expect(builder).toContain("'rule_snapshot', p.rule_snapshot");
    expect(builder).toContain("'horse_selections'");
    expect(builder).toContain("'proposal_slips'");
    expect(builder).toContain("from public.bet_tickets t");
    expect(builder).toContain("and s.kind = 'proposal'");
    expect(builder).not.toContain("public.race_results");
    expect(builder).not.toContain("public.payouts");
    expect(builder).not.toContain("public.race_reflections");
  });

  it("stores source-labelled immutable evidence for explicit locks first synced offline", () => {
    expect(lockedMigration).toContain(
      "create table if not exists public.offline_prediction_locked_snapshots",
    );
    expect(lockedMigration).toContain(
      "offline_prediction_locked_snapshots_user_race_fk",
    );
    expect(lockedMigration).toContain(
      "offline_prediction_locked_snapshots_user_device_fk",
    );
    expect(lockedMigration).toContain("unique (user_id, race_id)");
    expect(lockedMigration).toContain("unique (user_id, lock_mutation_id)");
    expect(lockedMigration).toContain("check (schema_version = 1)");
    expect(lockedMigration).toContain("check (octet_length(snapshot_sha256) = 32)");
    expect(lockedMigration).toContain(
      "source in ('offline_explicit_lock', 'legacy_local_upgrade')",
    );
    expect(lockedMigration).toContain(
      "alter table public.offline_prediction_locked_snapshots enable row level security",
    );
    expect(lockedMigration).toContain(
      "create policy offline_prediction_locked_snapshots_self_read",
    );
    expect(lockedMigration).toContain(
      "create trigger offline_prediction_locked_snapshots_immutable",
    );
  });

  it("validates and idempotently stores a complete owned offline lock", () => {
    const offlineStore = between(
      lockedMigration,
      "create or replace function public.store_offline_prediction_lock(",
      "-- The editable/current client aggregate remains the primary read model",
    );

    expect(offlineStore).toContain("security definer");
    expect(offlineStore).toContain("v_user_id uuid := auth.uid()");
    expect(offlineStore).toContain("r.id = p_race_id and r.user_id = v_user_id");
    expect(offlineStore).toContain("d.user_id = v_user_id");
    expect(offlineStore).toContain("d.revoked_at is null");
    expect(offlineStore).toContain("from public.prediction_locked_snapshots ls");
    expect(offlineStore).toContain("'status', 'canonical'");
    expect(offlineStore.indexOf("'status', 'canonical'")).toBeLessThan(
      offlineStore.indexOf("v_snapshot := p_payload #> '{prediction,locked_snapshot}'"),
    );
    for (const key of [
      "'schemaVersion'",
      "'race'",
      "'prediction'",
      "'proposedBets'",
      "'ruleVersion'",
      "'lockedAt'",
    ]) {
      expect(offlineStore).toContain(key);
    }
    expect(offlineStore).toContain(
      "v_snapshot_locked_at is distinct from v_prediction_locked_at",
    );
    expect(offlineStore).toContain("v_snapshot_locked_at < v_starts_at");
    expect(offlineStore).toContain("v_snapshot_provenance not in");
    expect(offlineStore).toContain("when 'legacy_local_upgrade' then 'legacy_local_upgrade'");
    expect(offlineStore).not.toContain(
      "v_snapshot_race ->> 'id' is distinct from",
    );
    expect(offlineStore).toContain(
      "v_snapshot_race ->> 'dataScope' not in ('live', 'demo', 'test')",
    );
    expect(offlineStore).not.toContain("dataScope' is distinct from v_data_scope");
    expect(offlineStore).toContain("at time zone 'Asia/Tokyo'");
    expect(offlineStore).toContain("extensions.digest(v_snapshot::text, 'sha256')");
    expect(offlineStore).toContain("v_existing.snapshot_sha256 <> v_snapshot_hash");
    expect(offlineStore).toContain("Offline locked snapshot is immutable");
    expect(offlineStore).toContain(
      "insert into public.offline_prediction_locked_snapshots",
    );
    expect(offlineStore).not.toContain(
      "update public.offline_prediction_locked_snapshots",
    );
  });

  it("overlays immutable lock evidence without trusting the client copy", () => {
    const evidenceReader = between(
      lockedMigration,
      "create or replace function public.build_synced_race_record(",
      "-- ---------------------------------------------------------------------------\n-- Explicit lock RPC",
    );

    expect(evidenceReader).toContain("coalesce(s.client_record, '{}'::jsonb)");
    expect(evidenceReader).toContain("left join public.prediction_locked_snapshots ls");
    expect(evidenceReader).toContain("ls.user_id = r.user_id and ls.race_id = r.id");
    expect(evidenceReader).toContain(
      "left join public.offline_prediction_locked_snapshots os",
    );
    expect(evidenceReader).toContain(
      "coalesce(s.canonical_locked_snapshot, s.offline_locked_snapshot)",
    );
    expect(evidenceReader).toContain("'locked_snapshot', m.locked_snapshot");
    expect(evidenceReader).toContain("'locked_snapshot_source', m.locked_snapshot_source");
    expect(evidenceReader).toContain("- 'locked_snapshot'");
    expect(evidenceReader).toContain("and r.user_id = auth.uid()");
    expect(evidenceReader.indexOf("coalesce(s.client_record, '{}'::jsonb)")).toBeLessThan(
      evidenceReader.indexOf("'locked_snapshot', m.locked_snapshot"),
    );
  });

  it("creates evidence at commit for every locked prediction and gates imports", () => {
    expect(lockedMigration).toContain("create constraint trigger predictions_locked_snapshot_required");
    expect(lockedMigration).toContain("deferrable initially deferred");
    expect(lockedMigration).toContain("public.ensure_locked_prediction_snapshot()");
    expect(lockedMigration).toContain("predictions_require_trusted_import");
    expect(lockedMigration).toContain("keiba.trusted_local_migration");
    expect(lockedMigration).not.toContain("new.status = 'draft' and new.locked_at is null");
    expect(lockedMigration).toContain(
      "new.source is distinct from old.source",
    );
  });

  it("keeps offline evidence read-only and its internal writer non-callable", () => {
    expect(lockedMigration).toContain(
      "public.offline_prediction_locked_snapshots,\n  public.local_migration_documents",
    );
    expect(lockedMigration).toContain(
      "revoke all on function public.store_offline_prediction_lock(uuid, jsonb, uuid, uuid) from public",
    );
    expect(lockedMigration).toContain(
      "revoke execute on function public.store_offline_prediction_lock(uuid, jsonb, uuid, uuid)\nfrom anon, authenticated",
    );
    expect(lockedMigration).not.toContain(
      "grant execute on function public.store_offline_prediction_lock",
    );
  });

  it("uses the requested lock conflict/replay response contract", () => {
    const lockRpc = between(
      lockedMigration,
      "create or replace function public.finalize_prediction_lock(",
      "-- ---------------------------------------------------------------------------\n-- v0.1.1-local-clean migration",
    );
    expect(lockRpc).toContain("'status', 'applied'");
    expect(lockRpc).toContain("jsonb_build_object('status', 'replayed')");
    expect(lockRpc).toContain("'status', 'conflict'");
    expect(lockRpc).toContain("'current', v_record");
    expect(lockRpc).toContain("'current_version', v_race.sync_version");
    expect(lockRpc).toContain("'reason', 'version_mismatch'");
    expect(lockRpc).toContain("'record', v_record");
    expect(lockRpc).toContain("'change_seq', v_change_seq");
  });

  it("stages an immutable v0.1.1 document and verifies each applied item receipt", () => {
    for (const table of [
      "local_migration_documents",
      "local_migration_items",
    ]) {
      expect(lockedMigration).toContain(`create table if not exists public.${table}`);
      expect(lockedMigration).toContain(`alter table public.${table} enable row level security`);
    }
    expect(lockedMigration).toContain("source_version = 'v0.1.1-local-clean'");
    expect(lockedMigration).toContain("unique (user_id, import_key)");
    expect(lockedMigration).toContain("unique (user_id, mutation_id)");
    expect(lockedMigration).toContain("create or replace function public.stage_local_migration(");
    expect(lockedMigration).toContain("create or replace function public.apply_local_migration_item(");
    expect(lockedMigration).toContain("create or replace function public.complete_local_migration(");
    expect(lockedMigration).toContain("Applied migration item has no mutation receipt");
  });
});

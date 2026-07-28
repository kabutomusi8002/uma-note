import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationDirectory = new URL("../supabase/migrations/", import.meta.url);
const expectedMigrationFiles = [
  "0001_initial_schema.sql",
  "0002_race_data_scope.sql",
  "0003_cloud_tenancy.sql",
  "0004_cloud_sync_protocol.sql",
  "0005_locked_snapshot_and_local_migration.sql",
  "0006_pre_remote_hardening.sql",
  "0007_race_client_key_insert_fix.sql",
] as const;
const expectedIntegrationTestFiles = [
  "0006_pre_remote_hardening_test.sql",
  "0007_race_client_key_insert_fix_test.sql",
] as const;

function readNormalizedText(url: URL): string {
  return readFileSync(url, "utf8").replace(/\r\n?/g, "\n");
}

const migrationFiles = readdirSync(migrationDirectory)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
const migrations = new Map(
  migrationFiles.map((name) => [
    name,
    readNormalizedText(new URL(name, migrationDirectory)),
  ]),
);
const hardening = migrations.get("0006_pre_remote_hardening.sql") ?? "";
const raceClientKeyFix =
  migrations.get("0007_race_client_key_insert_fix.sql") ?? "";
const integrationTestDirectory = new URL(
  "../supabase/tests/",
  import.meta.url,
);
const integrationTests = new Map(
  expectedIntegrationTestFiles.map((name) => [
    name,
    readNormalizedText(new URL(name, integrationTestDirectory)),
  ]),
);
const raceClientKeyIntegrationTest =
  integrationTests.get("0007_race_client_key_insert_fix_test.sql") ?? "";

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing start marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing end marker: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

/**
 * Checks the lexical boundaries that are most likely to make a complete
 * PostgreSQL migration fail before any statement can run. Function bodies are
 * deliberately treated as dollar-quoted strings, rather than splitting SQL on
 * semicolons.
 */
function postgresLexicalErrors(source: string): string[] {
  const errors: string[] = [];
  let parenthesisDepth = 0;
  let blockCommentDepth = 0;
  let dollarTag: string | null = null;
  let inLineComment = false;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (inLineComment) {
      if (current === "\n") inLineComment = false;
      continue;
    }

    if (blockCommentDepth > 0) {
      if (current === "/" && next === "*") {
        blockCommentDepth += 1;
        index += 1;
      } else if (current === "*" && next === "/") {
        blockCommentDepth -= 1;
        index += 1;
      }
      continue;
    }

    if (dollarTag !== null) {
      if (source.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }

    if (inSingleQuote) {
      if (current === "\\") {
        index += 1;
      } else if (current === "'" && next === "'") {
        index += 1;
      } else if (current === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (current === '"' && next === '"') {
        index += 1;
      } else if (current === '"') {
        inDoubleQuote = false;
      }
      continue;
    }

    if (current === "-" && next === "-") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      blockCommentDepth = 1;
      index += 1;
      continue;
    }
    if (current === "'") {
      inSingleQuote = true;
      continue;
    }
    if (current === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (current === "$") {
      const tag = source.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (tag) {
        dollarTag = tag;
        index += tag.length - 1;
        continue;
      }
    }
    if (current === "(") {
      parenthesisDepth += 1;
    } else if (current === ")") {
      parenthesisDepth -= 1;
      if (parenthesisDepth < 0) {
        errors.push(`unexpected closing parenthesis at offset ${index}`);
        parenthesisDepth = 0;
      }
    }
  }

  if (inSingleQuote) errors.push("unterminated single-quoted string");
  if (inDoubleQuote) errors.push("unterminated quoted identifier");
  if (dollarTag !== null) errors.push(`unterminated dollar quote ${dollarTag}`);
  if (blockCommentDepth > 0) errors.push("unterminated block comment");
  if (parenthesisDepth !== 0) {
    errors.push(`unbalanced parentheses: depth ${parenthesisDepth}`);
  }
  return errors;
}

describe("pre-remote migration chain", () => {
  it("contains exactly the reviewed 0001 through 0007 sequence", () => {
    expect(migrationFiles).toEqual(expectedMigrationFiles);
  });

  it.each(expectedMigrationFiles)(
    "%s has balanced PostgreSQL lexical structure",
    (name) => {
      expect(postgresLexicalErrors(migrations.get(name) ?? ""), name).toEqual([]);
    },
  );

  it("contains no credential-shaped values or browser-public secret names", () => {
    const combined = expectedMigrationFiles
      .map((name) => migrations.get(name) ?? "")
      .join("\n");
    const forbiddenPatterns = [
      /\bsb_secret_[A-Za-z0-9_-]{16,}\b/i,
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
      /\bpostgres(?:ql)?:\/\/[^\s"'`]+/i,
      /\bNEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|SERVICE_ROLE|PASSWORD|DATABASE_URL)\b/i,
      /\b(?:SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|DATABASE_URL|DB_PASSWORD|POSTGRES_PASSWORD)\s*=/i,
    ];
    for (const pattern of forbiddenPatterns) {
      expect(combined).not.toMatch(pattern);
    }
  });

  it.each(expectedIntegrationTestFiles)(
    "%s stays transactional and lexically complete",
    (name) => {
      const integrationTest = integrationTests.get(name) ?? "";
      expect(integrationTest).toMatch(/^\s*--[\s\S]*\nbegin;\s/im);
      expect(integrationTest).toMatch(/\brollback;\s*$/i);
      expect(postgresLexicalErrors(integrationTest)).toEqual([]);
    },
  );
});

describe("0006 immutable lock scope hardening", () => {
  it("stores a required constrained data_scope beside the immutable snapshot", () => {
    expect(hardening).toMatch(
      /alter table public\.prediction_locked_snapshots\s+add column if not exists data_scope public\.race_data_scope;/,
    );
    expect(hardening).toContain("alter column data_scope set not null");
    expect(hardening).toContain(
      "constraint prediction_locked_snapshots_data_scope_allowed",
    );
    expect(hardening).toContain(
      "check (data_scope in ('live', 'demo', 'test')) not valid",
    );
    expect(hardening).toContain(
      "validate constraint prediction_locked_snapshots_data_scope_allowed",
    );
  });

  it("puts lock-time data_scope inside canonical JSON and its hash input", () => {
    const builder = between(
      hardening,
      "create or replace function public.build_complete_prediction_snapshot(",
      "-- Existing insert paths in 0005 intentionally omit the new column.",
    );
    expect(builder).toContain("'data_scope', r.data_scope");

    const backfill = between(
      hardening,
      "with scoped as (",
      "alter table public.prediction_locked_snapshots\n  alter column data_scope set not null;",
    );
    expect(backfill).toContain("'{race,data_scope}'");
    expect(backfill).toContain(
      "snapshot_sha256 = extensions.digest(h.snapshot::text, 'sha256')",
    );
  });

  it("validates the column, canonical JSON, and hash on every insert", () => {
    const validator = between(
      hardening,
      "create or replace function public.validate_locked_snapshot_insert()",
      "-- ---------------------------------------------------------------------------\n-- prediction_rule_sets optimistic concurrency.",
    );
    expect(validator).toContain("v_race_scope public.race_data_scope");
    expect(validator).toContain("new.data_scope := v_race_scope");
    expect(validator).toContain(
      "new.data_scope is distinct from v_race_scope",
    );
    expect(validator).toContain(
      "v_canonical #>> '{race,data_scope}' is distinct from new.data_scope::text",
    );
    expect(validator).toContain(
      "new.snapshot_sha256 <> extensions.digest(v_canonical::text, 'sha256')",
    );
  });

  it("restores immutability only after the deterministic backfill", () => {
    const dropIndex = hardening.indexOf(
      "drop trigger if exists prediction_locked_snapshots_immutable",
    );
    const backfillIndex = hardening.indexOf(
      "update public.prediction_locked_snapshots ls",
    );
    const createIndex = hardening.indexOf(
      "create trigger prediction_locked_snapshots_immutable",
    );
    expect(dropIndex).toBeGreaterThanOrEqual(0);
    expect(backfillIndex).toBeGreaterThan(dropIndex);
    expect(createIndex).toBeGreaterThan(backfillIndex);
    expect(hardening.slice(createIndex)).toContain(
      "execute function public.protect_locked_snapshot()",
    );
  });
});

describe("0006 explicit offline lock preservation", () => {
  it("stores an explicit client lock before the deferred canonical trigger runs", () => {
    const wrapper = between(
      hardening,
      "create or replace function public.sync_race_record(",
      "-- ---------------------------------------------------------------------------\n-- prediction_rule_sets optimistic concurrency.",
    );
    expect(hardening).toContain(
      "rename to sync_race_record_0004_internal",
    );
    expect(wrapper).toContain("v_has_explicit_lock");
    expect(wrapper).toContain(
      "perform public.store_offline_prediction_lock(",
    );
    expect(wrapper).toContain("public.build_synced_race_record(v_race_id)");
    expect(wrapper).not.toContain("clock_timestamp() >= ");
  });

  it("does not rebuild canonical evidence when source-labelled offline evidence exists", () => {
    const deferredCanonical = between(
      hardening,
      "create or replace function public.ensure_locked_prediction_snapshot()",
      "create or replace function public.sync_race_record(",
    );
    expect(deferredCanonical).toContain(
      "from public.offline_prediction_locked_snapshots os",
    );
    expect(deferredCanonical.indexOf("offline_prediction_locked_snapshots")).toBeLessThan(
      deferredCanonical.indexOf(
        "v_snapshot := public.build_complete_prediction_snapshot",
      ),
    );
  });
});

describe("0006 rule-set dual CAS and replay safety", () => {
  const ruleSync = between(
    hardening,
    "create or replace function public.sync_rule_version(",
    "revoke all on function public.store_rule_sync_terminal_receipt(",
  );
  const terminalReceipt = between(
    hardening,
    "create or replace function public.store_rule_sync_terminal_receipt(",
    "create or replace function public.sync_rule_version(",
  );

  it("checks both the child version and optional parent-set version", () => {
    expect(ruleSync).toContain("p_expected_version bigint");
    expect(ruleSync).toContain("expected_rule_set_version");
    expect(ruleSync).toContain(
      "v_expected_rule_set_version bigint := 0",
    );
    expect(ruleSync).toContain(
      "v_expected_rule_set_version <> v_rule_set_version",
    );
    expect(ruleSync).toContain("'reason', 'version_mismatch'");
    expect(ruleSync).toContain("'reason', 'rule_set_version_mismatch'");
    expect(ruleSync).toContain("'current_rule_set_version', v_rule_set_version");
    expect(ruleSync).toContain("for update of rv, rs");
    expect(ruleSync).toContain(":rule-set:");
  });

  it("increments an existing parent set exactly once for a successful mutation", () => {
    const parentUpdate = between(
      ruleSync,
      "-- A set version represents the complete version collection",
      "insert into public.sync_change_log (",
    );
    expect(parentUpdate).toContain("update public.prediction_rule_sets");
    expect(parentUpdate).toContain("sync_version = sync_version + 1");
    expect(
      parentUpdate.match(/sync_version = sync_version \+ 1/g),
    ).toHaveLength(1);
    expect(ruleSync).toContain("'rule_set_version', v_rule_set_version");
  });

  it("tracks nullable description, publish time, and active-set changes", () => {
    expect(ruleSync).toContain(
      "p_payload ? 'description'\n      and v_existing_description is distinct from v_description",
    );
    expect(ruleSync).toContain("published_at = case");
    expect(ruleSync).toContain(
      "create trigger prediction_rule_sets_active_sync_version",
    );
    expect(ruleSync).toContain(
      "new.sync_version := greatest(new.sync_version, old.sync_version + 1)",
    );
  });

  it("persists conflicts as terminal receipts before returning", () => {
    expect(terminalReceipt).toContain(
      "insert into public.sync_mutation_receipts",
    );
    expect(terminalReceipt).toContain("'sync_rule_version'");
    expect(
      ruleSync.match(/return public\.store_rule_sync_terminal_receipt\(/g)?.length,
    ).toBeGreaterThanOrEqual(7);
    for (const reason of [
      "record_not_found",
      "version_mismatch",
      "rule_set_not_found",
      "rule_set_version_mismatch",
      "rule_set_name_mismatch",
      "semantic_version_exists",
      "immutable_rule_version",
    ]) {
      expect(ruleSync).toContain(`'reason', '${reason}'`);
    }
  });

  it("replays the stored conflict without changing it into applied or replayed", () => {
    const receiptReplay = between(
      ruleSync,
      "select * into v_receipt",
      "v_device := public.register_sync_device",
    );
    expect(receiptReplay).toContain(
      "v_receipt.response ->> 'status' = 'conflict'",
    );
    expect(receiptReplay).toContain(
      "return v_receipt.response || jsonb_build_object('replayed', true)",
    );
    expect(receiptReplay).toContain(
      "mutation_id was already used with a different request",
    );
    expect(ruleSync.indexOf("return v_receipt.response")).toBeLessThan(
      ruleSync.indexOf("v_device := public.register_sync_device"),
    );
  });
});

describe("0006 modification timestamps", () => {
  for (const table of [
    "race_exchange_documents",
    "local_migration_documents",
    "local_migration_items",
  ]) {
    it(`adds and maintains ${table}.updated_at`, () => {
      expect(hardening).toMatch(
        new RegExp(
          `alter table public\\.${table}\\s+add column if not exists updated_at timestamptz not null default now\\(\\);`,
        ),
      );
      expect(hardening).toContain(`drop trigger if exists ${table}_updated_at`);
      expect(hardening).toContain(`create trigger ${table}_updated_at`);
      expect(hardening).toMatch(
        new RegExp(
          `create trigger ${table}_updated_at\\s+before update on public\\.${table}\\s+for each row execute function public\\.set_updated_at\\(\\);`,
        ),
      );
    });
  }
});

describe("0007 immutable race client identity", () => {
  const aggregateUpsert = between(
    raceClientKeyFix,
    "create or replace function public.upsert_race_record(",
    "-- Enforce client identity immutability",
  );
  const raceIdentityWrite = between(
    aggregateUpsert,
    "if v_race_id is null then",
    "-- Serialize the nested save",
  );
  const identityTrigger = between(
    raceClientKeyFix,
    "create or replace function public.reject_race_client_key_change()",
    "create or replace function public.sync_race_record_0004_internal(",
  );
  const syncWriter = between(
    raceClientKeyFix,
    "create or replace function public.sync_race_record_0004_internal(",
    "revoke all on function public.upsert_race_record(jsonb)",
  );

  it("requires one trimmed explicit client key for both race write paths", () => {
    for (const writer of [aggregateUpsert, syncWriter]) {
      expect(writer).toMatch(
        /v_client_key := nullif\(btrim\(.+ ->> 'client_key'\), ''\);/,
      );
      expect(writer).toContain(
        "v_client_key is null or char_length(v_client_key) > 160",
      );
      expect(writer).toContain("errcode = '22023'");
      expect(writer).toContain(
        "message = 'A valid explicit client_key is required'",
      );
    }
  });

  it("inserts the owner and immutable client key atomically", () => {
    expect(raceIdentityWrite).toMatch(
      /insert into public\.races\s*\(\s*user_id,\s*meeting_id,\s*client_key,/,
    );
    expect(raceIdentityWrite).toMatch(
      /\)\s*values\s*\(\s*v_user_id,\s*v_meeting_id,\s*v_client_key,/,
    );
    expect(raceIdentityWrite).toContain(
      "where races.user_id = v_user_id\n      and races.client_key = v_client_key",
    );
    expect(raceIdentityWrite).toContain(
      "Race natural identity already belongs to a different client_key",
    );
    expect(raceIdentityWrite).not.toContain("client_key = excluded.client_key");
    expect(raceIdentityWrite).not.toMatch(/\bset\s+client_key\s*=/i);
  });

  it("rejects re-keying at the table boundary", () => {
    expect(aggregateUpsert).toContain(
      "v_existing_client_key is distinct from v_client_key",
    );
    expect(aggregateUpsert).toContain(
      "message = 'Existing race client_key is immutable'",
    );
    expect(identityTrigger).toContain(
      "if new.client_key is distinct from old.client_key then",
    );
    expect(identityTrigger).toContain(
      "create trigger races_reject_client_key_change",
    );
    expect(identityTrigger).toContain(
      "before update of client_key on public.races",
    );
  });

  it("checks a committed receipt before enforcing the new key contract", () => {
    const receiptLookup = syncWriter.indexOf(
      "select * into v_receipt",
    );
    const keyValidation = syncWriter.indexOf(
      "v_client_key := nullif(btrim(p_payload ->> 'client_key'), '')",
    );
    expect(receiptLookup).toBeGreaterThanOrEqual(0);
    expect(keyValidation).toBeGreaterThan(receiptLookup);
    expect(syncWriter.slice(receiptLookup, keyValidation)).toContain(
      "v_receipt.request_sha256 <> v_request_hash",
    );
    expect(syncWriter.slice(receiptLookup, keyValidation)).toContain(
      "mutation_id was already used with a different request",
    );
    expect(syncWriter.slice(receiptLookup, keyValidation)).toContain(
      "return v_receipt.response || jsonb_build_object('status', 'replayed')",
    );
  });

  it("returns non-writing identity/version conflicts and never re-keys later", () => {
    expect(syncWriter).toContain("'reason', 'natural_key_exists'");
    expect(syncWriter).toContain("'reason', 'identity_collision'");
    expect(syncWriter).toContain("'reason', 'client_key_mismatch'");
    expect(syncWriter).toContain("'reason', 'version_mismatch'");
    expect(syncWriter).toContain(
      "where id = v_race_id\n    and user_id = v_user_id\n    and client_key = v_client_key",
    );

    const finalRaceUpdate = between(
      syncWriter,
      "update public.races\n  set client_record = v_client_record",
      "insert into public.sync_change_log (",
    );
    const finalRaceSetClause = between(
      finalRaceUpdate,
      "update public.races\n  set",
      "where id = v_race_id",
    );
    expect(finalRaceSetClause).not.toMatch(/\bclient_key\s*=/i);
  });

  it("keeps aggregate writers private after replacing their definitions", () => {
    expect(raceClientKeyFix).toContain(
      "revoke all on function public.upsert_race_record(jsonb)",
    );
    expect(raceClientKeyFix).toContain(
      "revoke all on function public.sync_race_record_0004_internal(",
    );
    expect(raceClientKeyFix).toContain(
      "revoke all on function public.reject_race_client_key_change()",
    );
    expect(raceClientKeyFix).toContain("from public, anon, authenticated");
  });

  it("ships a fresh-DB integration scenario for every identity invariant", () => {
    expect(raceClientKeyIntegrationTest).toContain(
      "fresh local database has applied migrations 0001-0007",
    );
    for (const contract of [
      "repeat('x', 161)",
      "Mutation id reuse with changed content unexpectedly passed",
      "when sqlstate '22023'",
      "'version_mismatch'",
      "'natural_key_exists'",
      "'client_key_mismatch'",
      "races_reject_client_key_change",
      "prediction_locked_snapshots",
      "v_original_snapshot_hash",
      "v_race_financial_summary",
    ]) {
      expect(raceClientKeyIntegrationTest).toContain(contract);
    }
  });
});

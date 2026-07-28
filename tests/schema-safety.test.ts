import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readNormalizedSql(url: URL): string {
  return readFileSync(url, "utf8").replace(/\r\n?/g, "\n");
}

const schema = readNormalizedSql(
  new URL("../supabase/migrations/0001_initial_schema.sql", import.meta.url),
);
const dataScopeMigration = readNormalizedSql(
  new URL("../supabase/migrations/0002_race_data_scope.sql", import.meta.url),
);

describe("database lock safety", () => {
  it("ties the historic proposal-slip exception to a newly created import prediction", () => {
    const validateSlip = schema.slice(
      schema.indexOf("create or replace function public.validate_bet_slip()"),
      schema.indexOf("create trigger bet_slips_validate"),
    );

    expect(validateSlip).toContain("v_prediction_source = 'import'");
    expect(validateSlip).toContain(
      "v_prediction_created_at = transaction_timestamp()",
    );
    expect(validateSlip).not.toContain(
      "v_source = 'import' and v_created_at = transaction_timestamp()",
    );
  });

  it("retains a stored horse name when the incoming value is only N番", () => {
    expect(schema).toContain(
      "when excluded.horse_name = excluded.horse_number::text || '番'",
    );
    expect(schema).toContain("then race_entries.horse_name");
  });

  it("allows client-carried revisions only for a prediction created in the same transaction", () => {
    const policy = schema.slice(
      schema.indexOf("create policy prediction_revisions_owner_import"),
      schema.indexOf("create policy bet_slips_owner_all"),
    );
    expect(policy).toContain("p.created_at = transaction_timestamp()");
    expect(schema).toContain(
      "if v_prediction_created and v_prediction_json ? 'revisions' then",
    );
  });

  it("keeps draft pre-start race metadata correctable without rewriting a shared meeting", () => {
    const protection = schema.slice(
      schema.indexOf("create or replace function public.protect_race_timing_and_identity()"),
      schema.indexOf("create trigger races_protect_timing_and_identity"),
    );
    expect(protection).toContain("v_prediction_status = 'locked'");
    expect(protection).not.toContain("from public.race_entries");

    const upsert = schema.slice(
      schema.indexOf("create or replace function public.upsert_race_record"),
      schema.indexOf("revoke all on function public.build_race_record"),
    );
    expect(upsert).toContain("Never rewrite the identity of the old meeting");
    expect(upsert).toContain("m.racecourse_id = v_course_id");
  });

  it("defaults existing races to live and excludes demo/test from financial views", () => {
    expect(schema).toContain(
      "data_scope public.race_data_scope not null default 'live'",
    );
    expect(schema).toContain("'data_scope', r.data_scope");
    expect(schema).toContain("where r.data_scope = 'live'");
    expect(dataScopeMigration).toContain(
      "add column if not exists data_scope public.race_data_scope not null default 'live'",
    );
    expect(dataScopeMigration).toContain("where r.data_scope = 'live'");
  });
});

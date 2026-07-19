import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { DEMO_RULE_VERSION, DEMO_UPCOMING_RACE } from "../lib/demo-data";
import { applyTrustedLocalMigration } from "../lib/supabase/migration-repository";

const IMPORT_KEY = "11111111-1111-4111-8111-111111111111";
const INSTALLATION_ID = "22222222-2222-4222-8222-222222222222";
const DOCUMENT_ID = "33333333-3333-4333-8333-333333333333";

interface MigrationItemRow {
  id: string;
  entity_type: "race" | "rule_version";
  client_key: string;
  ordinal: number;
}

function migrationInput() {
  return {
    importKey: IMPORT_KEY,
    installationId: INSTALLATION_ID,
    backupSha256: "backup-sha256",
    planHash: "plan-sha256",
    races: [{
      race: structuredClone(DEMO_UPCOMING_RACE),
      clientKey: "local-race-1",
      expectedVersion: 0,
    }],
    rules: [{
      rule: structuredClone(DEMO_RULE_VERSION),
      clientKey: "local-rule-1",
      expectedVersion: 2,
    }],
  };
}

function mockMigrationClient(
  items: MigrationItemRow[],
  rpcImplementation: (
    name: string,
    parameters: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>,
) {
  const abortSignals: ReturnType<typeof vi.fn>[] = [];
  const order = vi.fn().mockImplementation(() => {
    const request = Promise.resolve({ data: items, error: null });
    const abortSignal = vi.fn().mockReturnValue(request);
    abortSignals.push(abortSignal);
    return Object.assign(request, { abortSignal });
  });
  const eq = vi.fn().mockReturnValue({ order });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  const rpc = vi.fn((name: string, parameters: Record<string, unknown>) => {
    const request = rpcImplementation(name, parameters);
    const abortSignal = vi.fn().mockReturnValue(request);
    abortSignals.push(abortSignal);
    return Object.assign(request, { abortSignal });
  });
  return {
    client: { rpc, from } as unknown as SupabaseClient,
    rpc,
    from,
    select,
    eq,
    order,
    abortSignals,
  };
}

describe("trusted local migration repository", () => {
  it("stages, applies in ordinal order, and completes a successful document", async () => {
    const rows: MigrationItemRow[] = [
      {
        id: "race-item",
        entity_type: "race",
        client_key: "local-race-1",
        ordinal: 2,
      },
      {
        id: "rule-item",
        entity_type: "rule_version",
        client_key: "local-rule-1",
        ordinal: 1,
      },
    ];
    const mocked = mockMigrationClient(rows, async (name, parameters) => {
      if (name === "stage_local_migration") {
        return {
          data: { status: "applied", document_id: DOCUMENT_ID, item_count: 2 },
          error: null,
        };
      }
      if (name === "apply_local_migration_item") {
        return {
          data: {
            status: parameters.p_item_id === "rule-item" ? "replayed" : "applied",
          },
          error: null,
        };
      }
      if (name === "complete_local_migration") {
        return { data: { status: "applied" }, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    const result = await applyTrustedLocalMigration(mocked.client, migrationInput());

    expect(result).toEqual({
      documentId: DOCUMENT_ID,
      itemCount: 2,
      appliedCount: 2,
      conflicts: [],
      completed: true,
    });
    expect(mocked.rpc.mock.calls.map(([name]) => name)).toEqual([
      "stage_local_migration",
      "apply_local_migration_item",
      "apply_local_migration_item",
      "complete_local_migration",
    ]);
    expect(mocked.rpc.mock.calls.slice(1, 3).map(([, parameters]) =>
      (parameters as Record<string, unknown>).p_item_id
    )).toEqual(["rule-item", "race-item"]);
    expect(mocked.from).toHaveBeenCalledWith("local_migration_items");
    expect(mocked.select).toHaveBeenCalledWith("id,entity_type,client_key,ordinal");
    expect(mocked.eq).toHaveBeenCalledWith("document_id", DOCUMENT_ID);
    expect(mocked.order).toHaveBeenCalledWith("ordinal", { ascending: true });

    const stageParameters = mocked.rpc.mock.calls[0]?.[1];
    expect(stageParameters).toMatchObject({
      p_source_version: "v0.1.1-local-clean",
      p_import_key: IMPORT_KEY,
      p_installation_id: INSTALLATION_ID,
      p_document: {
        backup_sha256: "backup-sha256",
        plan_hash: "plan-sha256",
        races: [{
          client_key: "local-race-1",
          expected_version: 0,
          payload: {
            client_key: "local-race-1",
            change_source: "local_migration",
          },
        }],
        rules: [{
          client_key: "local-rule-1",
          expected_version: 2,
          payload: { client_key: "local-rule-1" },
        }],
      },
    });
    expect(JSON.stringify(stageParameters)).not.toMatch(/user_id|service_role|secret/i);
  });

  it("returns item conflicts and never completes the document", async () => {
    const rows: MigrationItemRow[] = [
      {
        id: "race-item",
        entity_type: "race",
        client_key: "local-race-1",
        ordinal: 1,
      },
      {
        id: "rule-item",
        entity_type: "rule_version",
        client_key: "local-rule-1",
        ordinal: 2,
      },
    ];
    const current = { client_key: "local-rule-1", sync_version: 7 };
    const mocked = mockMigrationClient(rows, async (name, parameters) => {
      if (name === "stage_local_migration") {
        return {
          data: { status: "replayed", document_id: DOCUMENT_ID, item_count: 2 },
          error: null,
        };
      }
      if (name === "apply_local_migration_item") {
        if (parameters.p_item_id === "race-item") {
          return { data: { status: "applied" }, error: null };
        }
        return {
          data: {
            status: "conflict",
            current,
            current_version: 7,
            reason: "version_mismatch",
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    await expect(
      applyTrustedLocalMigration(mocked.client, migrationInput()),
    ).resolves.toEqual({
      documentId: DOCUMENT_ID,
      itemCount: 2,
      appliedCount: 1,
      conflicts: [{
        migrationItemId: "rule-item",
        entityType: "rule",
        clientKey: "local-rule-1",
        current,
        currentVersion: 7,
        reason: "version_mismatch",
      }],
      completed: false,
    });
    expect(mocked.rpc.mock.calls.map(([name]) => name)).not.toContain(
      "complete_local_migration",
    );
  });

  it("can retry the same stage request after an error and resume replayed items", async () => {
    const rows: MigrationItemRow[] = [{
      id: "race-item",
      entity_type: "race",
      client_key: "local-race-1",
      ordinal: 1,
    }];
    let stageAttempts = 0;
    const mocked = mockMigrationClient(rows, async (name) => {
      if (name === "stage_local_migration") {
        stageAttempts += 1;
        if (stageAttempts === 1) {
          return { data: null, error: { message: "temporary network failure" } };
        }
        return {
          data: { status: "replayed", document_id: DOCUMENT_ID, item_count: 1 },
          error: null,
        };
      }
      if (name === "apply_local_migration_item") {
        return { data: { status: "replayed" }, error: null };
      }
      if (name === "complete_local_migration") {
        return { data: { status: "replayed" }, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const input = migrationInput();

    await expect(applyTrustedLocalMigration(mocked.client, input)).rejects.toThrow(
      "temporary network failure",
    );
    expect(mocked.from).not.toHaveBeenCalled();
    expect(mocked.rpc).toHaveBeenCalledTimes(1);

    await expect(applyTrustedLocalMigration(mocked.client, input)).resolves.toEqual({
      documentId: DOCUMENT_ID,
      itemCount: 1,
      appliedCount: 1,
      conflicts: [],
      completed: true,
    });
    const stageCalls = mocked.rpc.mock.calls.filter(
      ([name]) => name === "stage_local_migration",
    );
    expect(stageCalls).toHaveLength(2);
    expect(stageCalls[1]?.[1]).toEqual(stageCalls[0]?.[1]);
  });

  it("binds every migration query and RPC to the caller abort signal", async () => {
    const rows: MigrationItemRow[] = [{
      id: "race-item",
      entity_type: "race",
      client_key: "local-race-1",
      ordinal: 1,
    }];
    const mocked = mockMigrationClient(rows, async (name) => {
      if (name === "stage_local_migration") {
        return {
          data: { status: "applied", document_id: DOCUMENT_ID, item_count: 1 },
          error: null,
        };
      }
      if (name === "apply_local_migration_item") {
        return { data: { status: "applied" }, error: null };
      }
      if (name === "complete_local_migration") {
        return { data: { status: "applied" }, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const controller = new AbortController();

    await applyTrustedLocalMigration(mocked.client, {
      ...migrationInput(),
      signal: controller.signal,
    });

    expect(mocked.abortSignals).toHaveLength(4);
    for (const abortSignal of mocked.abortSignals) {
      expect(abortSignal).toHaveBeenCalledWith(controller.signal);
    }
  });

  it("does not stage any data when the migration signal is already aborted", async () => {
    const mocked = mockMigrationClient([], async () => {
      throw new Error("RPC must not be called");
    });
    const controller = new AbortController();
    controller.abort();

    await expect(applyTrustedLocalMigration(mocked.client, {
      ...migrationInput(),
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocked.rpc).not.toHaveBeenCalled();
    expect(mocked.from).not.toHaveBeenCalled();
  });
});

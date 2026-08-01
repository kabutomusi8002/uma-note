import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { DEMO_RULE_VERSION, DEMO_UPCOMING_RACE } from "../lib/demo-data";
import { raceToDatabasePayload } from "../lib/supabase/race-repository";
import {
  loadSyncBootstrap,
  loadSyncChanges,
} from "../lib/supabase/sync-repository";
import { DEFAULT_USER_SETTINGS } from "../lib/types";
import { buildMigrationPlan } from "../lib/sync/migration-plan";
import { createOutboxMutation } from "../lib/sync/outbox";
import { pushOutboxMutation } from "../lib/sync/supabase-adapter";

const MUTATION_ID = "11111111-1111-4111-8111-111111111111";
const INSTALLATION_ID = "22222222-2222-4222-8222-222222222222";

function clientWithResponse(data: unknown) {
  const rpc = vi.fn().mockResolvedValue({ data, error: null });
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe("Supabase Outbox adapter", () => {
  it("pushes a race through the version-checked idempotent RPC", async () => {
    const race = structuredClone(DEMO_UPCOMING_RACE);
    const record = {
      ...raceToDatabasePayload(race),
      id: "33333333-3333-4333-8333-333333333333",
      client_key: race.id,
      sync_version: 4,
    };
    const { client, rpc } = clientWithResponse({
      status: "applied",
      record,
      version: 4,
      change_seq: 12,
    });
    const mutation = createOutboxMutation(
      {
        ownerScope: "user:44444444-4444-4444-8444-444444444444",
        entityType: "race",
        entityKey: race.id,
        payload: race,
        expectedVersion: 3,
      },
      { randomUUID: () => MUTATION_ID },
    );

    const result = await pushOutboxMutation(client, mutation, INSTALLATION_ID);

    expect(result).toMatchObject({ status: "applied", cloudVersion: 4 });
    expect(rpc).toHaveBeenCalledWith("sync_race_record", expect.objectContaining({
      p_expected_version: 3,
      p_mutation_id: MUTATION_ID,
      p_installation_id: INSTALLATION_ID,
    }));
    expect(JSON.stringify(rpc.mock.calls)).not.toMatch(/service_role|secret|password/i);
  });

  it("sends the persisted clientKey when the local UI id is different", async () => {
    const race = {
      ...structuredClone(DEMO_UPCOMING_RACE),
      id: "local-ui-race-id",
      clientKey: "stable-outbox-client-key",
    };
    const record = {
      ...raceToDatabasePayload(race),
      id: "33333333-3333-4333-8333-333333333333",
      sync_version: 1,
    };
    const { client, rpc } = clientWithResponse({
      status: "applied",
      record,
      version: 1,
      change_seq: 1,
    });
    const mutation = createOutboxMutation(
      {
        ownerScope: "user:44444444-4444-4444-8444-444444444444",
        entityType: "race",
        entityKey: race.clientKey,
        payload: race,
        expectedVersion: 0,
      },
      { randomUUID: () => MUTATION_ID },
    );

    await pushOutboxMutation(client, mutation, INSTALLATION_ID);

    expect(rpc).toHaveBeenCalledWith("sync_race_record", expect.objectContaining({
      p_payload: expect.objectContaining({
        client_key: "stable-outbox-client-key",
      }),
    }));
    const rpcPayload = rpc.mock.calls[0]?.[1]?.p_payload as Record<string, unknown>;
    expect(rpcPayload).not.toHaveProperty("id");
  });

  it("rejects an Outbox/clientKey mismatch before calling Supabase", async () => {
    const race = {
      ...structuredClone(DEMO_UPCOMING_RACE),
      clientKey: "persisted-client-key",
    };
    const { client, rpc } = clientWithResponse(null);
    const mutation = createOutboxMutation(
      {
        ownerScope: "user:44444444-4444-4444-8444-444444444444",
        entityType: "race",
        entityKey: "different-entity-key",
        payload: race,
        expectedVersion: 0,
      },
      { randomUUID: () => MUTATION_ID },
    );

    await expect(
      pushOutboxMutation(client, mutation, INSTALLATION_ID),
    ).resolves.toMatchObject({ status: "rejected" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("passes the coordinator abort signal to the Supabase RPC", async () => {
    const race = structuredClone(DEMO_UPCOMING_RACE);
    const record = {
      ...raceToDatabasePayload(race),
      id: "33333333-3333-4333-8333-333333333333",
      client_key: race.id,
      sync_version: 1,
    };
    const abortSignal = vi.fn().mockResolvedValue({
      data: { status: "applied", record, version: 1, change_seq: 1 },
      error: null,
    });
    const rpc = vi.fn().mockReturnValue({ abortSignal });
    const mutation = createOutboxMutation(
      {
        ownerScope: "user:44444444-4444-4444-8444-444444444444",
        entityType: "race",
        entityKey: race.id,
        payload: race,
        expectedVersion: 0,
      },
      { randomUUID: () => MUTATION_ID },
    );
    const controller = new AbortController();

    await pushOutboxMutation(
      { rpc } as unknown as SupabaseClient,
      mutation,
      INSTALLATION_ID,
      controller.signal,
    );

    expect(abortSignal).toHaveBeenCalledWith(controller.signal);
  });

  it("returns a cloud race as a conflict instead of overwriting it", async () => {
    const race = structuredClone(DEMO_UPCOMING_RACE);
    const current = {
      ...raceToDatabasePayload({ ...race, name: "クラウド側の名称" }),
      id: "33333333-3333-4333-8333-333333333333",
      client_key: race.id,
      sync_version: 8,
    };
    const { client } = clientWithResponse({
      status: "conflict",
      current,
      current_version: 8,
      reason: "version_mismatch",
    });
    const mutation = createOutboxMutation(
      {
        ownerScope: "user:44444444-4444-4444-8444-444444444444",
        entityType: "race",
        entityKey: race.id,
        payload: race,
        baseSnapshot: null,
        expectedVersion: 7,
      },
      { randomUUID: () => MUTATION_ID },
    );

    await expect(pushOutboxMutation(client, mutation, INSTALLATION_ID)).resolves.toMatchObject({
      status: "conflict",
      cloudVersion: 8,
      serverValue: { name: "クラウド側の名称" },
    });
  });

  it("preserves a null cloud value in a version conflict", async () => {
    const race = structuredClone(DEMO_UPCOMING_RACE);
    const { client } = clientWithResponse({
      status: "conflict",
      current: null,
      current_version: 0,
      reason: "record_not_found",
    });
    const mutation = createOutboxMutation(
      {
        ownerScope: "user:44444444-4444-4444-8444-444444444444",
        entityType: "race",
        entityKey: race.id,
        payload: race,
        expectedVersion: 7,
      },
      { randomUUID: () => MUTATION_ID },
    );

    await expect(pushOutboxMutation(client, mutation, INSTALLATION_ID)).resolves.toEqual({
      status: "conflict",
      cloudVersion: 0,
      serverValue: null,
    });
  });

  it("does not classify an acknowledged PostgreSQL rejection as an offline retry", async () => {
    const race = structuredClone(DEMO_UPCOMING_RACE);
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "Imported predictions require review", code: "42501" },
    });
    const mutation = createOutboxMutation(
      {
        ownerScope: "user:44444444-4444-4444-8444-444444444444",
        entityType: "race",
        entityKey: race.id,
        payload: race,
        expectedVersion: 0,
      },
      { randomUUID: () => MUTATION_ID },
    );

    await expect(
      pushOutboxMutation({ rpc } as unknown as SupabaseClient, mutation, INSTALLATION_ID),
    ).rejects.toMatchObject({ status: 403, code: "42501" });
  });

  it("keeps a browser fetch failure retryable in the durable Outbox", async () => {
    const race = structuredClone(DEMO_UPCOMING_RACE);
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "Failed to fetch", code: "" },
    });
    const mutation = createOutboxMutation(
      {
        ownerScope: "user:44444444-4444-4444-8444-444444444444",
        entityType: "race",
        entityKey: race.id,
        payload: race,
        expectedVersion: 0,
      },
      { randomUUID: () => MUTATION_ID },
    );

    await expect(
      pushOutboxMutation({ rpc } as unknown as SupabaseClient, mutation, INSTALLATION_ID),
    ).rejects.toMatchObject({ status: 0, code: "network_error" });
  });

  it("syncs immutable rule content by client key", async () => {
    const rule = structuredClone(DEMO_RULE_VERSION);
    const { client, rpc } = clientWithResponse({
      status: "applied",
      record: {
        id: "55555555-5555-4555-8555-555555555555",
        client_key: rule.id,
        sync_version: 1,
        semantic_version: rule.version,
        content: rule.rules.join("\n"),
        parameters: { display_name: rule.name, rules: rule.rules },
        rule_set: {
          id: "66666666-6666-4666-8666-666666666666",
          name: rule.name,
          is_active: true,
          sync_version: 7,
        },
        created_at: rule.createdAt,
      },
      version: 1,
      rule_set_version: 7,
      change_seq: 2,
    });
    const mutation = createOutboxMutation(
      {
        ownerScope: "user:44444444-4444-4444-8444-444444444444",
        entityType: "rule",
        entityKey: rule.id,
        payload: rule,
        expectedVersion: 0,
        expectedParentVersion: 6,
      },
      { randomUUID: () => MUTATION_ID },
    );

    await expect(pushOutboxMutation(client, mutation, INSTALLATION_ID)).resolves.toMatchObject({
      status: "applied",
      cloudVersion: 1,
      cloudParentVersion: 7,
    });
    expect(rpc).toHaveBeenCalledWith("sync_rule_version", expect.objectContaining({
      p_payload: expect.objectContaining({
        client_key: rule.id,
        semantic_version: rule.version,
        content: rule.rules.join("\n"),
        expected_rule_set_version: 6,
      }),
      p_expected_version: 0,
    }));
  });

  it("omits the optional rule-set precondition for legacy Outbox entries", async () => {
    const rule = structuredClone(DEMO_RULE_VERSION);
    const { client, rpc } = clientWithResponse({
      status: "applied",
      record: {
        id: "55555555-5555-4555-8555-555555555555",
        client_key: rule.id,
        sync_version: 1,
        semantic_version: rule.version,
        content: rule.rules.join("\n"),
        parameters: { display_name: rule.name, rules: rule.rules },
        rule_set: { name: rule.name, is_active: false },
        created_at: rule.createdAt,
      },
      version: 1,
      change_seq: 2,
    });
    const mutation = createOutboxMutation(
      {
        ownerScope: "user:44444444-4444-4444-8444-444444444444",
        entityType: "rule",
        entityKey: rule.id,
        payload: rule,
        expectedVersion: 0,
      },
      { randomUUID: () => MUTATION_ID },
    );

    await pushOutboxMutation(client, mutation, INSTALLATION_ID);

    const rpcArguments = rpc.mock.calls[0]?.[1] as {
      p_payload?: Record<string, unknown>;
    };
    expect(rpcArguments.p_payload).not.toHaveProperty("expected_rule_set_version");
  });

  it("keeps a replayed rule-set version conflict as a conflict", async () => {
    const rule = structuredClone(DEMO_RULE_VERSION);
    const current = {
      id: "55555555-5555-4555-8555-555555555555",
      client_key: rule.id,
      sync_version: 4,
      semantic_version: rule.version,
      content: rule.rules.join("\n"),
      parameters: { display_name: rule.name, rules: rule.rules },
      rule_set: {
        id: "66666666-6666-4666-8666-666666666666",
        name: rule.name,
        is_active: false,
        sync_version: 6,
      },
      created_at: rule.createdAt,
    };
    const { client } = clientWithResponse({
      status: "conflict",
      replayed: true,
      current,
      current_version: 4,
      current_rule_set_version: 6,
      reason: "rule_set_version_mismatch",
    });
    const mutation = createOutboxMutation(
      {
        ownerScope: "user:44444444-4444-4444-8444-444444444444",
        entityType: "rule",
        entityKey: rule.id,
        payload: rule,
        expectedVersion: 3,
        expectedParentVersion: 5,
      },
      { randomUUID: () => MUTATION_ID },
    );

    await expect(pushOutboxMutation(client, mutation, INSTALLATION_ID)).resolves.toMatchObject({
      status: "conflict",
      cloudVersion: 4,
      cloudParentVersion: 6,
      serverValue: { id: rule.id },
    });
  });

  it("syncs user settings without placing a user_id in the browser payload", async () => {
    const settings = { ...DEFAULT_USER_SETTINGS, defaultStakePerPoint: 300 };
    const { client, rpc } = clientWithResponse({
      status: "applied",
      record: { preferences: settings, sync_version: 2 },
      version: 2,
      change_seq: 4,
    });
    const mutation = createOutboxMutation(
      {
        ownerScope: "user:44444444-4444-4444-8444-444444444444",
        entityType: "settings",
        entityKey: "profile",
        payload: settings,
        expectedVersion: 1,
      },
      { randomUUID: () => MUTATION_ID },
    );

    await expect(pushOutboxMutation(client, mutation, INSTALLATION_ID)).resolves.toMatchObject({
      status: "applied",
      cloudVersion: 2,
    });
    const rpcArguments = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(rpcArguments).not.toHaveProperty("user_id");
    expect(rpcArguments).toMatchObject({
      p_expected_version: 1,
      p_mutation_id: MUTATION_ID,
      p_installation_id: INSTALLATION_ID,
    });
  });

  it("loads bootstrap values with client keys and cloud versions", async () => {
    const race = structuredClone(DEMO_UPCOMING_RACE);
    const rule = structuredClone(DEMO_RULE_VERSION);
    const { client } = clientWithResponse({
      races: [{
        ...raceToDatabasePayload(race),
        id: "33333333-3333-4333-8333-333333333333",
        client_key: race.id,
        sync_version: 6,
      }],
      rules: [{
        id: "55555555-5555-4555-8555-555555555555",
        client_key: rule.id,
        sync_version: 3,
        semantic_version: rule.version,
        content: rule.rules.join("\n"),
        parameters: { display_name: rule.name, rules: rule.rules },
        rule_set: {
          id: "66666666-6666-4666-8666-666666666666",
          name: rule.name,
          is_active: true,
          sync_version: 9,
        },
        created_at: rule.createdAt,
      }],
      settings: {
        user_id: "44444444-4444-4444-8444-444444444444",
        active_rule_version_id: "55555555-5555-4555-8555-555555555555",
        preferences: { ...DEFAULT_USER_SETTINGS, activeRuleVersionId: null },
        sync_version: 2,
      },
      latest_change_seq: 21,
    });

    const bootstrap = await loadSyncBootstrap(client);

    expect(bootstrap.races[0]).toMatchObject({ clientKey: race.id, version: 6 });
    expect(bootstrap.rules[0]).toMatchObject({
      clientKey: rule.id,
      version: 3,
      parentCloudId: "66666666-6666-4666-8666-666666666666",
      parentVersion: 9,
    });
    expect(bootstrap.settings).toMatchObject({
      clientKey: "profile",
      version: 2,
      value: { activeRuleVersionId: rule.id },
    });
    expect(bootstrap.latestChangeSequence).toBe(21);
  });

  it("previews live races when an unselected test race has an invalid race number", async () => {
    const live = {
      ...structuredClone(DEMO_UPCOMING_RACE),
      dataScope: "live" as const,
      proposedBets: [],
      purchasedBets: [],
    };
    const invalidTest = {
      ...structuredClone(DEMO_UPCOMING_RACE),
      id: "invalid-test-race",
      clientKey: "invalid-test-race",
      dataScope: "test" as const,
      raceNumber: 91,
      proposedBets: [],
      purchasedBets: [],
    };
    const { client } = clientWithResponse({
      races: [raceToDatabasePayload(live), raceToDatabasePayload(invalidTest)],
      rules: [],
      settings: null,
      latest_change_seq: 1,
    });

    const bootstrap = await loadSyncBootstrap(client, undefined, ["live"]);
    const plan = await buildMigrationPlan({
      localRaces: [live],
      cloudRaces: bootstrap.races.map((record) => record.value),
      includeScopes: { live: true, demo: false, test: false },
    });

    expect(bootstrap.races).toHaveLength(1);
    expect(bootstrap.races[0]?.value.dataScope).toBe("live");
    expect(plan.items).toHaveLength(1);
  });

  it("keeps validating an invalid test race when test is selected", async () => {
    const invalidTest = {
      ...structuredClone(DEMO_UPCOMING_RACE),
      id: "invalid-test-race",
      clientKey: "invalid-test-race",
      dataScope: "test" as const,
      raceNumber: 91,
      proposedBets: [],
      purchasedBets: [],
    };
    const { client } = clientWithResponse({
      races: [raceToDatabasePayload(invalidTest)],
      rules: [],
      settings: null,
      latest_change_seq: 1,
    });

    const bootstrap = await loadSyncBootstrap(client, undefined, ["test"]);

    await expect(buildMigrationPlan({
      localRaces: [],
      cloudRaces: bootstrap.races.map((record) => record.value),
      includeScopes: { live: false, demo: false, test: true },
    })).rejects.toThrow("raceNumber must be an integer from 1 to 12");
  });

  it("ignores invalid demo and test races when neither scope is selected", async () => {
    const live = {
      ...structuredClone(DEMO_UPCOMING_RACE),
      dataScope: "live" as const,
      proposedBets: [],
      purchasedBets: [],
    };
    const invalidScopes = (["demo", "test"] as const).map((dataScope, index) => ({
      ...structuredClone(DEMO_UPCOMING_RACE),
      id: "invalid-" + dataScope + "-race",
      clientKey: "invalid-" + dataScope + "-race",
      dataScope,
      raceNumber: 91 + index,
      proposedBets: [],
      purchasedBets: [],
    }));
    const { client } = clientWithResponse({
      races: [
        raceToDatabasePayload(live),
        ...invalidScopes.map(raceToDatabasePayload),
      ],
      rules: [],
      settings: null,
      latest_change_seq: 1,
    });

    const bootstrap = await loadSyncBootstrap(client, undefined, ["live"]);

    await expect(buildMigrationPlan({
      localRaces: [live],
      cloudRaces: bootstrap.races.map((record) => record.value),
      includeScopes: { live: true, demo: false, test: false },
    })).resolves.toMatchObject({ counts: { excluded: 0 } });
  });

  it("keeps live filtering while rule and settings migrate in separate attempts", async () => {
    const live = {
      ...structuredClone(DEMO_UPCOMING_RACE),
      dataScope: "live" as const,
      proposedBets: [],
      purchasedBets: [],
    };
    const invalidTest = {
      ...structuredClone(DEMO_UPCOMING_RACE),
      id: "invalid-test-race",
      clientKey: "invalid-test-race",
      dataScope: "test" as const,
      raceNumber: 91,
      proposedBets: [],
      purchasedBets: [],
    };
    const rule = structuredClone(DEMO_RULE_VERSION);
    const settings = {
      ...DEFAULT_USER_SETTINGS,
      activeRuleVersionId: rule.id,
    };
    const ruleRecord = {
      id: "55555555-5555-4555-8555-555555555555",
      client_key: rule.id,
      sync_version: 1,
      semantic_version: rule.version,
      content: rule.rules.join("\n"),
      parameters: { display_name: rule.name, rules: rule.rules },
      rule_set: {
        id: "66666666-6666-4666-8666-666666666666",
        name: rule.name,
        is_active: true,
        sync_version: 1,
      },
      created_at: rule.createdAt,
    };
    let cloudRule: typeof ruleRecord | null = null;
    let cloudSettings: Record<string, unknown> | null = null;
    const rpc = vi.fn(async (name: string) => {
      if (name === "get_sync_bootstrap") {
        return {
          data: {
            races: [raceToDatabasePayload(live), raceToDatabasePayload(invalidTest)],
            rules: cloudRule ? [cloudRule] : [],
            settings: cloudSettings,
            latest_change_seq: cloudSettings ? 3 : cloudRule ? 2 : 1,
          },
          error: null,
        };
      }
      if (name === "sync_rule_version") {
        cloudRule = ruleRecord;
        return {
          data: {
            status: "applied",
            record: ruleRecord,
            version: 1,
            rule_set_version: 1,
            change_seq: 2,
          },
          error: null,
        };
      }
      if (name === "sync_user_settings") {
        cloudSettings = {
          user_id: "44444444-4444-4444-8444-444444444444",
          active_rule_version_id: ruleRecord.id,
          preferences: settings,
          sync_version: 1,
        };
        return {
          data: {
            status: "applied",
            record: cloudSettings,
            version: 1,
            change_seq: 3,
          },
          error: null,
        };
      }
      throw new Error("Unexpected RPC: " + name);
    });
    const client = { rpc } as unknown as SupabaseClient;

    const initial = await loadSyncBootstrap(client, undefined, ["live"]);
    const plannedCount = 1 + (initial.settings ? 0 : 1);
    expect(initial.races).toHaveLength(1);
    expect(initial.rules).toHaveLength(0);
    expect(initial.settings).toBeNull();
    expect(plannedCount).toBe(2);

    const ruleMutation = createOutboxMutation(
      {
        ownerScope: "user:44444444-4444-4444-8444-444444444444",
        entityType: "rule",
        entityKey: rule.id,
        payload: rule,
        expectedVersion: 0,
      },
      { randomUUID: () => MUTATION_ID },
    );
    await expect(
      pushOutboxMutation(client, ruleMutation, INSTALLATION_ID),
    ).resolves.toMatchObject({ status: "applied" });

    const afterRule = await loadSyncBootstrap(client, undefined, ["live"]);
    expect(afterRule.races).toHaveLength(1);
    expect(afterRule.rules).toHaveLength(1);
    expect(afterRule.settings).toBeNull();

    const settingsMutation = createOutboxMutation(
      {
        ownerScope: "user:44444444-4444-4444-8444-444444444444",
        entityType: "settings",
        entityKey: "profile",
        payload: settings,
        expectedVersion: 0,
      },
      { randomUUID: () => "33333333-3333-4333-8333-333333333333" },
    );
    await expect(
      pushOutboxMutation(client, settingsMutation, INSTALLATION_ID),
    ).resolves.toMatchObject({ status: "applied" });

    const afterSettings = await loadSyncBootstrap(client, undefined, ["live"]);
    expect(afterSettings.races).toHaveLength(1);
    expect(afterSettings.settings?.value.activeRuleVersionId).toBe(rule.id);
  });

  it("uses the database get_sync_changes parameter contract", async () => {
    const { client, rpc } = clientWithResponse([
      {
        change_seq: 10,
        entity_type: "rule_version",
        entity_id: "55555555-5555-4555-8555-555555555555",
        operation: "upsert",
        record_version: 4,
        changed_at: "2026-07-18T00:00:00.000Z",
      },
    ]);

    await expect(loadSyncChanges(client, 9)).resolves.toMatchObject({
      cursor: 10,
      changes: [{ entityType: "rule", version: 4 }],
    });
    expect(rpc).toHaveBeenCalledWith("get_sync_changes", {
      p_after_change_seq: 9,
      p_limit: 200,
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import { DEMO_RULE_VERSION, DEMO_UPCOMING_RACE } from "../lib/demo-data";
import {
  validateOutboxMutation,
  validateRaceRecords,
  validateRuleVersions,
  validateUserSettings,
} from "../lib/runtime-validation";
import { createOutboxMutation } from "../lib/sync/outbox";
import { pushOutboxMutation } from "../lib/sync/supabase-adapter";
import type { SupabaseClient } from "@supabase/supabase-js";

const OWNER = "user:runtime-validation" as const;

describe("runtime trust-boundary validation", () => {
  it("rejects missing fields, invalid dates, enums, ranges, and nested elements", () => {
    expect(() => validateRaceRecords([{ ...DEMO_UPCOMING_RACE, prediction: undefined }]))
      .toThrow(/prediction/);
    expect(() => validateRaceRecords([{ ...DEMO_UPCOMING_RACE, date: "2026-02-30" }]))
      .toThrow(/date/);
    expect(() => validateRaceRecords([{ ...DEMO_UPCOMING_RACE, dataScope: "archive" }]))
      .toThrow(/dataScope/);
    expect(() => validateRaceRecords([{ ...DEMO_UPCOMING_RACE, raceNumber: 13 }]))
      .toThrow(/raceNumber/);
    expect(() => validateRaceRecords([{
      ...DEMO_UPCOMING_RACE,
      prediction: { ...DEMO_UPCOMING_RACE.prediction, selectedHorses: [{ horseNumber: 0 }] },
    }])).toThrow(/selectedHorses/);
    expect(() => validateRuleVersions([{ ...DEMO_RULE_VERSION, rules: [1] }]))
      .toThrow(/rules/);
    expect(() => validateUserSettings({ timezone: "Asia/Tokyo" }))
      .toThrow(/defaultDataScope/);
  });

  it("allows only the documented legacy race clientKey backfill", () => {
    const legacy = structuredClone(DEMO_UPCOMING_RACE) as unknown as Record<string, unknown>;
    delete legacy.clientKey;
    expect(validateRaceRecords([legacy])[0]?.clientKey).toBe(DEMO_UPCOMING_RACE.id);
  });

  it("does not call a write RPC for an invalid Outbox payload", async () => {
    const rpc = vi.fn();
    const mutation = createOutboxMutation({
      ownerScope: OWNER,
      entityType: "race",
      entityKey: DEMO_UPCOMING_RACE.clientKey,
      payload: { ...DEMO_UPCOMING_RACE, date: "not-a-date" },
      expectedVersion: 0,
    });
    expect(() => validateOutboxMutation(mutation, OWNER)).toThrow(/date/);
    await expect(pushOutboxMutation(
      { rpc } as unknown as SupabaseClient,
      mutation,
      "installation",
    )).resolves.toMatchObject({ status: "rejected" });
    expect(rpc).not.toHaveBeenCalled();
  });
});

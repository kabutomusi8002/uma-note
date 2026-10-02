import type { SupabaseClient } from "@supabase/supabase-js";
import type { PredictionRuleVersion, RaceRecord, UserSettings } from "../types";
import { raceClientKey } from "../race-identity";
import { syncRaceRecord } from "../supabase/race-repository";
import { syncRuleVersion } from "../supabase/rule-repository";
import { syncUserSettings } from "../supabase/sync-repository";
import type { OutboxMutation, PushResult } from "./types";
import {
  validateOutboxMutation,
  validateUserSettings,
} from "../runtime-validation";
import { validatePredictionRuleVersion, validateRaceRecord } from "../race-format";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRaceRecord(value: unknown): value is RaceRecord {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.date === "string" &&
    typeof value.course === "string" &&
    typeof value.raceNumber === "number"
  );
}

function isRuleVersion(value: unknown): value is PredictionRuleVersion {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    Array.isArray(value.rules)
  );
}

function isUserSettings(value: unknown): value is UserSettings {
  return (
    isObject(value) &&
    value.timezone === "Asia/Tokyo" &&
    typeof value.defaultStakePerPoint === "number" &&
    (value.defaultDataScope === "live" ||
      value.defaultDataScope === "demo" ||
      value.defaultDataScope === "test")
  );
}

/**
 * Converts one durable local Outbox intent into an idempotent, version-checked
 * Supabase RPC. Only the public browser client is accepted; no privileged key
 * or server-side credential is used here.
 */
export async function pushOutboxMutation(
  client: SupabaseClient,
  mutation: OutboxMutation,
  installationId: string,
  signal?: AbortSignal,
): Promise<PushResult> {
  try {
    mutation = validateOutboxMutation(mutation, mutation.ownerScope);
  } catch (error) {
    return {
      status: "rejected",
      message: error instanceof Error ? error.message : "Invalid Outbox mutation",
    };
  }
  if (mutation.operation === "delete") {
    return {
      status: "rejected",
      message: "削除同期は未対応です。端末内データは保持されています。",
    };
  }

  const expectedVersion = mutation.expectedVersion ?? 0;
  if (mutation.entityType === "race") {
    if (!isRaceRecord(mutation.payload)) {
      return { status: "rejected", message: "レース同期データが不正です。" };
    }
    let payload: RaceRecord;
    try { payload = validateRaceRecord(mutation.payload); }
    catch (error) { return { status: "rejected", message: error instanceof Error ? error.message : "Invalid race" }; }
    if (raceClientKey(payload) !== mutation.entityKey) {
      return {
        status: "rejected",
        message: "Race Outbox entityKey does not match the persisted clientKey.",
      };
    }
    const result = await syncRaceRecord(client, payload, {
      expectedVersion,
      mutationId: mutation.mutationId,
      installationId,
      signal,
    });
    if (result.status === "conflict") {
      return {
        status: "conflict",
        cloudVersion: result.currentVersion,
        serverValue: result.current?.race ?? null,
      };
    }
    return {
      status: "applied",
      cloudVersion: result.version,
      serverValue: result.race,
    };
  }

  if (mutation.entityType === "rule") {
    if (!isRuleVersion(mutation.payload)) {
      return { status: "rejected", message: "ルール同期データが不正です。" };
    }
    let payload: PredictionRuleVersion;
    try { payload = validatePredictionRuleVersion(mutation.payload); }
    catch (error) { return { status: "rejected", message: error instanceof Error ? error.message : "Invalid rule" }; }
    const result = await syncRuleVersion(client, payload, {
      expectedVersion,
      expectedParentVersion: mutation.expectedParentVersion,
      mutationId: mutation.mutationId,
      installationId,
      activate: payload.isActive,
      signal,
    });
    if (result.status === "conflict") {
      return {
        status: "conflict",
        cloudVersion: result.currentVersion,
        ...(result.currentParentVersion === undefined
          ? {}
          : { cloudParentVersion: result.currentParentVersion }),
        serverValue: result.current ?? null,
      };
    }
    return {
      status: "applied",
      cloudVersion: result.version,
      ...(result.parentVersion === undefined
        ? {}
        : { cloudParentVersion: result.parentVersion }),
      serverValue: result.rule,
    };
  }

  if (!isUserSettings(mutation.payload)) {
    return { status: "rejected", message: "設定同期データが不正です。" };
  }
  let payload: UserSettings;
  try { payload = validateUserSettings(mutation.payload, "outbox.payload"); }
  catch (error) { return { status: "rejected", message: error instanceof Error ? error.message : "Invalid settings" }; }
  const result = await syncUserSettings(client, payload, {
    expectedVersion,
    mutationId: mutation.mutationId,
    installationId,
    signal,
  });
  if (result.status === "conflict") {
    return {
      status: "conflict",
      cloudVersion: result.currentVersion,
      serverValue: result.current,
    };
  }
  return {
    status: "applied",
    cloudVersion: result.version,
    serverValue: result.settings,
  };
}

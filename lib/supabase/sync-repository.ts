import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_USER_SETTINGS,
  RACE_DATA_SCOPES,
  type PredictionRuleVersion,
  type RaceDataScope,
  type RaceRecord,
  type UserSettings,
} from "@/lib/types";
import { databaseRecordToRace } from "@/lib/supabase/race-repository";
import { repositoryError } from "@/lib/supabase/repository-error";
import { databaseRecordToRule } from "@/lib/supabase/rule-repository";
import { normalizeRaceNumber } from "@/lib/race-identity";
import { validatePredictionRuleVersion, validateRaceRecord } from "@/lib/race-format";
import { RuntimeDataError, validateUserSettings } from "@/lib/runtime-validation";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function relatedRuleSet(row: JsonObject): JsonObject {
  if (row.rule_set) return object(row.rule_set);
  if (Array.isArray(row.prediction_rule_sets)) {
    return object(row.prediction_rule_sets[0]);
  }
  return object(row.prediction_rule_sets);
}

export interface CloudChange {
  sequence: number;
  entityType: "race" | "rule" | "settings";
  entityId: string;
  operation: "upsert" | "delete" | "lock" | "activate";
  version: number;
  changedAt: string;
}

export interface CloudVersionedRecord<T> {
  value: T;
  clientKey: string;
  cloudId: string;
  version: number;
  parentCloudId?: string;
  parentVersion?: number;
}

export interface SyncBootstrap {
  races: CloudVersionedRecord<RaceRecord>[];
  rules: CloudVersionedRecord<PredictionRuleVersion>[];
  settings: CloudVersionedRecord<UserSettings> | null;
  latestChangeSequence: number;
  excludedInvalidRaceCount: number;
}

export async function loadSyncBootstrap(
  client: SupabaseClient,
  signal?: AbortSignal,
  dataScopes?: readonly RaceDataScope[],
): Promise<SyncBootstrap> {
  const request = client.rpc("get_sync_bootstrap");
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw repositoryError("同期初期データの取得に失敗しました", error);
  const response = requiredObject(data, "get_sync_bootstrap");
  const responseRaces = requiredArray(response.races, "get_sync_bootstrap.races");
  const responseRules = requiredArray(response.rules, "get_sync_bootstrap.rules");
  const latestChangeSequence = requiredInteger(response.latest_change_seq, "get_sync_bootstrap.latest_change_seq");
  const selectedScopes = dataScopes ? new Set(dataScopes) : null;
  let excludedInvalidRaceCount = 0;
  const rawRaces = responseRaces.filter((item) => {
    const row = object(item);
    const race = object(row.race);
    assertRaceRpcRecord(row);
    const dataScope = text(race.data_scope ?? row.data_scope, "live") as RaceDataScope;
    if (!RACE_DATA_SCOPES.includes(dataScope as never)) {
      throw new RuntimeDataError("get_sync_bootstrap.races.data_scope", "invalid data scope");
    }
    if (selectedScopes && !selectedScopes.has(dataScope)) return false;
    try {
      normalizeRaceNumber(numberValue(race.race_number));
      validateRaceRecord(databaseRecordToRace(row));
      return true;
    } catch (cause) {
      if (!selectedScopes && (dataScope === "demo" || dataScope === "test")) {
        excludedInvalidRaceCount += 1;
        return false;
      }
      throw cause;
    }
  });
  const races = rawRaces.map((item, index) => {
    const row = object(item);
    const value = validateRaceRecord(databaseRecordToRace(row));
    return {
      value,
      clientKey: requiredText(row.client_key, `get_sync_bootstrap.races[${index}].client_key`),
      cloudId: requiredText(row.id ?? value.cloudId ?? value.id, `get_sync_bootstrap.races[${index}].id`),
      version: requiredInteger(row.sync_version ?? value.syncVersion ?? 1, `get_sync_bootstrap.races[${index}].sync_version`, 1),
    };
  });
  const rules = responseRules.map((item, index) => {
    const row = object(item);
    assertRuleRpcRecord(row, `get_sync_bootstrap.rules[${index}]`);
    const value = validatePredictionRuleVersion(databaseRecordToRule(row));
    const ruleSet = relatedRuleSet(row);
    const parentCloudId = text(ruleSet.id);
    const parentVersion = optionalNumberValue(ruleSet.sync_version);
    return {
      value,
      clientKey: requiredText(row.client_key, `get_sync_bootstrap.rules[${index}].client_key`),
      cloudId: requiredText(row.id, `get_sync_bootstrap.rules[${index}].id`),
      version: requiredInteger(row.sync_version, `get_sync_bootstrap.rules[${index}].sync_version`, 1),
      ...(parentCloudId ? { parentCloudId } : {}),
      ...(parentVersion === undefined ? {} : { parentVersion }),
    };
  });
  const rawSettings = response.settings ? object(response.settings) : null;
  const settings = rawSettings
    ? (() => {
        assertSettingsRpcRecord(rawSettings);
        const value = validateUserSettings(databaseRecordToSettings(rawSettings), "get_sync_bootstrap.settings");
        const activeRule = value.activeRuleVersionId
          ? rules.find(
              (rule) =>
                rule.cloudId === value.activeRuleVersionId ||
                rule.clientKey === value.activeRuleVersionId,
            )
          : undefined;
        return {
          value: activeRule
            ? { ...value, activeRuleVersionId: activeRule.clientKey }
            : value,
          clientKey: "profile",
          cloudId: requiredText(rawSettings.user_id, "get_sync_bootstrap.settings.user_id"),
          version: requiredInteger(rawSettings.sync_version, "get_sync_bootstrap.settings.sync_version", 1),
        };
      })()
    : null;
  return {
    races,
    rules,
    settings,
    latestChangeSequence,
    excludedInvalidRaceCount,
  };
}

function requiredObject(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeDataError(path, "expected an object");
  }
  return value as JsonObject;
}

function requiredArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new RuntimeDataError(path, "expected an array");
  return value;
}

function requiredInteger(value: unknown, path: string, minimum = 0): number {
  if (!Number.isInteger(value) || (value as number) < minimum) throw new RuntimeDataError(path, `expected an integer >= ${minimum}`);
  return value as number;
}

function requiredText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new RuntimeDataError(path, "expected a non-empty string");
  return value;
}

function requiredField(value: JsonObject, key: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    throw new RuntimeDataError(`${path}.${key}`, "required field is missing");
  }
  return value[key];
}

function assertRaceRpcRecord(row: JsonObject): void {
  const path = "get_sync_bootstrap.races[]";
  requiredText(requiredField(row, "client_key", path), `${path}.client_key`);
  const meeting = requiredObject(requiredField(row, "meeting", path), `${path}.meeting`);
  requiredText(requiredField(meeting, "meeting_date", `${path}.meeting`), `${path}.meeting.meeting_date`);
  requiredObject(requiredField(meeting, "racecourse", `${path}.meeting`), `${path}.meeting.racecourse`);
  const race = requiredObject(requiredField(row, "race", path), `${path}.race`);
  requiredField(race, "race_number", `${path}.race`);
  requiredField(race, "starts_at", `${path}.race`);
  requiredField(race, "name", `${path}.race`);
  requiredField(race, "data_scope", `${path}.race`);
  const prediction = requiredObject(requiredField(row, "prediction", path), `${path}.prediction`);
  requiredArray(requiredField(prediction, "selections", `${path}.prediction`), `${path}.prediction.selections`);
  requiredArray(requiredField(row, "entries", path), `${path}.entries`);
  requiredArray(requiredField(row, "bet_slips", path), `${path}.bet_slips`);
}

function assertRuleRpcRecord(row: JsonObject, path: string): void {
  requiredText(requiredField(row, "client_key", path), `${path}.client_key`);
  requiredText(requiredField(row, "semantic_version", path), `${path}.semantic_version`);
  requiredField(row, "content", path);
  requiredObject(requiredField(row, "parameters", path), `${path}.parameters`);
  requiredText(requiredField(row, "created_at", path), `${path}.created_at`);
}

function assertSettingsRpcRecord(row: JsonObject): void {
  const path = "get_sync_bootstrap.settings";
  const preferences = requiredObject(requiredField(row, "preferences", path), `${path}.preferences`);
  requiredField(preferences, "timezone", `${path}.preferences`);
  requiredField(preferences, "defaultStakePerPoint", `${path}.preferences`);
  requiredField(preferences, "defaultDataScope", `${path}.preferences`);
  requiredField(preferences, "activeRuleVersionId", `${path}.preferences`);
}

export async function loadSyncChanges(
  client: SupabaseClient,
  afterSequence: number,
): Promise<{ changes: CloudChange[]; cursor: number }> {
  const { data, error } = await client.rpc("get_sync_changes", {
    p_after_change_seq: afterSequence,
    p_limit: 200,
  });
  if (error) throw repositoryError("同期差分の取得に失敗しました", error);
  const response = object(data);
  const rawChanges = Array.isArray(response.changes)
    ? response.changes
    : Array.isArray(data)
      ? data
      : [];
  const changes = rawChanges.map((item) => {
    const row = object(item);
    const entityType = text(row.entity_type);
    const operation = text(row.operation);
    return {
      sequence: numberValue(row.change_seq, numberValue(row.sequence)),
      entityType:
        entityType === "rule" || entityType === "rule_version"
          ? "rule"
          : entityType === "settings" || entityType === "user_settings"
            ? "settings"
            : "race",
      entityId: text(row.entity_id),
      operation:
        operation === "delete" || operation === "lock" || operation === "activate"
          ? operation
          : "upsert",
      version: numberValue(
        row.record_version,
        numberValue(row.entity_version, numberValue(row.version)),
      ),
      changedAt: text(row.changed_at),
    } satisfies CloudChange;
  });
  return {
    changes,
    cursor: numberValue(
      response.cursor,
      changes.reduce((maximum, change) => Math.max(maximum, change.sequence), afterSequence),
    ),
  };
}

export type SettingsSyncResult =
  | {
      status: "applied" | "replayed";
      settings: UserSettings;
      version: number;
      changeSequence: number;
    }
  | {
      status: "conflict";
      reason: string;
      current: UserSettings | null;
      currentVersion: number;
    };

export function databaseRecordToSettings(value: unknown): UserSettings {
  const row = object(value);
  const preferences = object(row.preferences ?? row);
  const dataScope = text(preferences.defaultDataScope ?? preferences.default_data_scope);
  const defaultStake = numberValue(
    preferences.defaultStakePerPoint ?? preferences.default_stake_per_point,
    DEFAULT_USER_SETTINGS.defaultStakePerPoint,
  );
  return {
    timezone: "Asia/Tokyo",
    defaultStakePerPoint:
      Number.isInteger(defaultStake) && defaultStake >= 100
        ? defaultStake
        : DEFAULT_USER_SETTINGS.defaultStakePerPoint,
    defaultDataScope: RACE_DATA_SCOPES.includes(dataScope as never)
      ? (dataScope as UserSettings["defaultDataScope"])
      : DEFAULT_USER_SETTINGS.defaultDataScope,
    activeRuleVersionId:
      text(
        preferences.activeRuleVersionId ??
          preferences.active_rule_version_id ??
          row.active_rule_version_id,
      ) || null,
  };
}

export async function syncUserSettings(
  client: SupabaseClient,
  settings: UserSettings,
  options: {
    expectedVersion: number;
    mutationId: string;
    installationId: string;
    signal?: AbortSignal;
  },
): Promise<SettingsSyncResult> {
  const request = client.rpc("sync_user_settings", {
    p_preferences: settings,
    p_expected_version: options.expectedVersion,
    p_mutation_id: options.mutationId,
    p_installation_id: options.installationId,
  });
  const { data, error } = await (
    options.signal ? request.abortSignal(options.signal) : request
  );
  if (error) throw repositoryError("設定の同期に失敗しました", error);
  const response = object(data);
  if (text(response.status) === "conflict") {
    const current = response.current === null || response.current === undefined
      ? null
      : object(response.current);
    return {
      status: "conflict",
      reason: text(response.reason, "クラウド側の設定が変更されています。"),
      current: current ? databaseRecordToSettings(current) : null,
      currentVersion: numberValue(
        current?.sync_version,
        numberValue(response.current_version),
      ),
    };
  }
  return {
    status: text(response.status) === "replayed" ? "replayed" : "applied",
    settings: databaseRecordToSettings(response.record ?? data),
    version: numberValue(response.version),
    changeSequence: numberValue(response.change_seq),
  };
}

export function subscribeToSyncChanges(
  client: SupabaseClient,
  userId: string,
  onChange: () => void,
): RealtimeChannel {
  return client
    .channel(`uma-note-sync:${userId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "sync_change_log",
        filter: `user_id=eq.${userId}`,
      },
      () => onChange(),
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") onChange();
    });
}

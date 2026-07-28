import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_USER_SETTINGS,
  RACE_DATA_SCOPES,
  type PredictionRuleVersion,
  type RaceRecord,
  type UserSettings,
} from "@/lib/types";
import { databaseRecordToRace } from "@/lib/supabase/race-repository";
import { repositoryError } from "@/lib/supabase/repository-error";
import { databaseRecordToRule } from "@/lib/supabase/rule-repository";

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
}

export async function loadSyncBootstrap(
  client: SupabaseClient,
  signal?: AbortSignal,
): Promise<SyncBootstrap> {
  const request = client.rpc("get_sync_bootstrap");
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw repositoryError("同期初期データの取得に失敗しました", error);
  const response = object(data);
  const races = (Array.isArray(response.races) ? response.races : []).map((item) => {
    const row = object(item);
    const value = databaseRecordToRace(row);
    return {
      value,
      clientKey: text(row.client_key, value.clientKey),
      cloudId: text(row.id),
      version: numberValue(row.sync_version),
    };
  });
  const rules = (Array.isArray(response.rules) ? response.rules : []).map((item) => {
    const row = object(item);
    const value = databaseRecordToRule(row);
    const ruleSet = relatedRuleSet(row);
    const parentCloudId = text(ruleSet.id);
    const parentVersion = optionalNumberValue(ruleSet.sync_version);
    return {
      value,
      clientKey: text(row.client_key, value.id),
      cloudId: text(row.id),
      version: numberValue(row.sync_version),
      ...(parentCloudId ? { parentCloudId } : {}),
      ...(parentVersion === undefined ? {} : { parentVersion }),
    };
  });
  const rawSettings = response.settings ? object(response.settings) : null;
  const settings = rawSettings
    ? (() => {
        const value = databaseRecordToSettings(rawSettings);
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
          cloudId: text(rawSettings.user_id),
          version: numberValue(rawSettings.sync_version),
        };
      })()
    : null;
  return {
    races,
    rules,
    settings,
    latestChangeSequence: numberValue(response.latest_change_seq),
  };
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

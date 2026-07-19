import type { SupabaseClient } from "@supabase/supabase-js";
import { repositoryError } from "@/lib/supabase/repository-error";
import type { PredictionRuleVersion } from "@/lib/types";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function rulesFrom(value: unknown, content: string): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : content.split("\n").map((item) => item.trim()).filter(Boolean);
}

export function databaseRecordToRule(raw: unknown): PredictionRuleVersion {
  const row = object(raw);
  const parameters = object(row.parameters);
  const joined = row.rule_set
    ? object(row.rule_set)
    : Array.isArray(row.prediction_rule_sets)
    ? object(row.prediction_rule_sets[0])
    : object(row.prediction_rule_sets);
  const content = text(row.content);
  return {
    id: text(row.client_key, text(row.id)),
    name: text(parameters.display_name, text(joined.description, text(joined.name, "予想ルール"))),
    version: text(
      row.semantic_version,
      text(parameters.semantic_version, String(row.version_number ?? "1")),
    ),
    rules: rulesFrom(parameters.rules, content),
    createdAt: text(row.created_at, new Date().toISOString()),
    note: text(row.change_note) || undefined,
    isActive: booleanValue(joined.is_active),
  };
}

export async function loadRuleVersions(
  client: SupabaseClient,
): Promise<PredictionRuleVersion[]> {
  const { data, error } = await client
    .from("prediction_rule_versions")
    .select(
      "id, client_key, sync_version, semantic_version, version_number, content, parameters, change_note, created_at, prediction_rule_sets!inner(name, description, is_active)",
    )
    .order("created_at", { ascending: false });
  if (error) throw repositoryError("予想ルールの読み込みに失敗しました", error);
  return (Array.isArray(data) ? data : []).map(databaseRecordToRule);
}

export type RuleSyncResult =
  | {
      status: "applied" | "replayed";
      rule: PredictionRuleVersion;
      cloudId: string;
      version: number;
      changeSequence: number;
    }
  | {
      status: "conflict";
      reason: string;
      current: PredictionRuleVersion | null;
      currentVersion: number;
    };

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function ruleToSyncPayload(rule: PredictionRuleVersion): JsonObject {
  return {
    client_key: rule.id,
    name: rule.name,
    semantic_version: rule.version,
    content: rule.rules.join("\n"),
    rules: rule.rules,
    change_note: rule.note ?? null,
    is_active: rule.isActive,
    created_at: rule.createdAt,
  };
}

export async function syncRuleVersion(
  client: SupabaseClient,
  rule: PredictionRuleVersion,
  options: {
    expectedVersion: number;
    mutationId: string;
    installationId: string;
    activate?: boolean;
    signal?: AbortSignal;
  },
): Promise<RuleSyncResult> {
  const request = client.rpc("sync_rule_version", {
    p_payload: {
      ...ruleToSyncPayload(rule),
      is_active: options.activate ?? rule.isActive,
    },
    p_expected_version: options.expectedVersion,
    p_mutation_id: options.mutationId,
    p_installation_id: options.installationId,
  });
  const { data, error } = await (
    options.signal ? request.abortSignal(options.signal) : request
  );
  if (error) throw repositoryError("予想ルールの同期に失敗しました", error);
  const response = object(data);
  if (text(response.status) === "conflict") {
    const currentRecord = response.current === null || response.current === undefined
      ? null
      : object(response.current);
    return {
      status: "conflict",
      reason: text(response.reason, "クラウド側のルールが変更されています。"),
      current: currentRecord ? databaseRecordToRule(currentRecord) : null,
      currentVersion: numberValue(
        currentRecord?.sync_version,
        numberValue(response.current_version),
      ),
    };
  }
  const record = object(response.record ?? data);
  return {
    status: text(response.status) === "replayed" ? "replayed" : "applied",
    rule: databaseRecordToRule(record),
    cloudId: text(response.entity_id, text(record.id)),
    version: numberValue(response.version, numberValue(record.sync_version)),
    changeSequence: numberValue(response.change_seq),
  };
}

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PredictionRuleVersion, RaceRecord } from "../types";
import { raceToDatabasePayload } from "./race-repository";
import { repositoryError } from "./repository-error";
import { ruleToSyncPayload } from "./rule-repository";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Local migration was aborted", "AbortError");
  }
}

export interface LocalMigrationRaceInput {
  race: RaceRecord;
  clientKey: string;
  expectedVersion: number;
}

export interface LocalMigrationRuleInput {
  rule: PredictionRuleVersion;
  clientKey: string;
  expectedVersion: number;
}

export interface LocalMigrationConflict {
  migrationItemId: string;
  entityType: "race" | "rule";
  clientKey: string;
  current: unknown | null;
  currentVersion: number;
  reason: string;
}

export interface LocalMigrationResult {
  documentId: string;
  itemCount: number;
  appliedCount: number;
  conflicts: LocalMigrationConflict[];
  completed: boolean;
}

interface MigrationRow {
  id: string;
  entity_type: "race" | "rule_version";
  client_key: string;
  ordinal: number;
}

/**
 * Stages and resumes the trusted v0.1.1 local import protocol. The same
 * importKey and document may be retried safely after a network interruption.
 */
export async function applyTrustedLocalMigration(
  client: SupabaseClient,
  input: {
    importKey: string;
    installationId: string;
    backupSha256: string;
    planHash: string;
    races: LocalMigrationRaceInput[];
    rules: LocalMigrationRuleInput[];
    signal?: AbortSignal;
  },
): Promise<LocalMigrationResult> {
  throwIfAborted(input.signal);
  const document = {
    backup_sha256: input.backupSha256,
    plan_hash: input.planHash,
    races: input.races.map(({ race, clientKey, expectedVersion }) => ({
      client_key: clientKey,
      expected_version: expectedVersion,
      payload: {
        ...raceToDatabasePayload({ ...race, id: clientKey }),
        client_key: clientKey,
        change_source: "local_migration",
      },
    })),
    rules: input.rules.map(({ rule, clientKey, expectedVersion }) => ({
      client_key: clientKey,
      expected_version: expectedVersion,
      payload: {
        ...ruleToSyncPayload({ ...rule, id: clientKey }),
        client_key: clientKey,
      },
    })),
  };
  const stageRequest = client.rpc(
    "stage_local_migration",
    {
      p_source_version: "v0.1.1-local-clean",
      p_import_key: input.importKey,
      p_installation_id: input.installationId,
      p_document: document,
    },
  );
  const { data: stagedData, error: stageError } = await (
    input.signal ? stageRequest.abortSignal(input.signal) : stageRequest
  );
  throwIfAborted(input.signal);
  if (stageError) {
    throw repositoryError("ローカル移行の準備に失敗しました", stageError);
  }
  const staged = object(stagedData);
  const documentId = text(staged.document_id);
  if (!documentId) throw new Error("ローカル移行document IDを取得できませんでした。");

  const itemListRequest = client
    .from("local_migration_items")
    .select("id,entity_type,client_key,ordinal")
    .eq("document_id", documentId)
    .order("ordinal", { ascending: true });
  const { data: itemData, error: itemError } = await (
    input.signal ? itemListRequest.abortSignal(input.signal) : itemListRequest
  );
  throwIfAborted(input.signal);
  if (itemError) {
    throw repositoryError("ローカル移行項目の取得に失敗しました", itemError);
  }
  const rows = (Array.isArray(itemData) ? itemData : [])
    .map((value) => object(value))
    .map((row): MigrationRow => ({
      id: text(row.id),
      entity_type: text(row.entity_type) === "rule_version"
        ? "rule_version"
        : "race",
      client_key: text(row.client_key),
      ordinal: numberValue(row.ordinal),
    }))
    .filter((row) => row.id && row.client_key)
    .sort((left, right) => left.ordinal - right.ordinal);

  const conflicts: LocalMigrationConflict[] = [];
  let appliedCount = 0;
  for (const row of rows) {
    throwIfAborted(input.signal);
    const applyRequest = client.rpc("apply_local_migration_item", {
      p_item_id: row.id,
      p_installation_id: input.installationId,
    });
    const { data, error } = await (
      input.signal ? applyRequest.abortSignal(input.signal) : applyRequest
    );
    throwIfAborted(input.signal);
    if (error) {
      throw repositoryError(`移行項目 ${row.client_key} の適用に失敗しました`, error);
    }
    const response = object(data);
    const status = text(response.status);
    if (status === "applied" || status === "replayed") {
      appliedCount += 1;
    } else {
      conflicts.push({
        migrationItemId: row.id,
        entityType: row.entity_type === "rule_version" ? "rule" : "race",
        clientKey: row.client_key,
        current: response.current ?? null,
        currentVersion: numberValue(response.current_version),
        reason: text(response.reason, "migration_conflict"),
      });
    }
  }

  let completed = false;
  if (conflicts.length === 0) {
    throwIfAborted(input.signal);
    const completeRequest = client.rpc("complete_local_migration", {
      p_document_id: documentId,
    });
    const { data, error } = await (
      input.signal ? completeRequest.abortSignal(input.signal) : completeRequest
    );
    throwIfAborted(input.signal);
    if (error) throw repositoryError("ローカル移行の完了処理に失敗しました", error);
    completed = ["applied", "replayed"].includes(text(object(data).status));
  }
  return {
    documentId,
    itemCount: numberValue(staged.item_count, rows.length),
    appliedCount,
    conflicts,
    completed,
  };
}

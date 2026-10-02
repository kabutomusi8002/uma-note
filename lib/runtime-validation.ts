import { validatePredictionRuleVersion, validateRaceRecord } from "./race-format";
import {
  RACE_DATA_SCOPES,
  type PredictionRuleVersion,
  type RaceRecord,
  type UserSettings,
} from "./types";
import type { OutboxMutation, OwnerScope, WorkspaceSnapshot } from "./sync/types";

export class RuntimeDataError extends Error {
  constructor(path: string, message: string) {
    super(`Invalid persisted or remote data at ${path}: ${message}`);
    this.name = "RuntimeDataError";
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeDataError(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "") || value.length > 4096) {
    throw new RuntimeDataError(path, "expected a valid string");
  }
  return value;
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new RuntimeDataError(path, `expected an integer from ${min} to ${max}`);
  }
  return value as number;
}

function timestamp(value: unknown, path: string): string {
  const result = string(value, path);
  if (!Number.isFinite(Date.parse(result))) throw new RuntimeDataError(path, "expected a valid timestamp");
  return result;
}

export function validateUserSettings(value: unknown, path = "settings"): UserSettings {
  const input = record(value, path);
  if (input.timezone !== "Asia/Tokyo") throw new RuntimeDataError(`${path}.timezone`, "expected Asia/Tokyo");
  const defaultDataScope = input.defaultDataScope;
  if (!RACE_DATA_SCOPES.includes(defaultDataScope as never)) {
    throw new RuntimeDataError(`${path}.defaultDataScope`, "expected live, demo, or test");
  }
  const activeRuleVersionId = input.activeRuleVersionId;
  if (activeRuleVersionId !== null && typeof activeRuleVersionId !== "string") {
    throw new RuntimeDataError(`${path}.activeRuleVersionId`, "expected a string or null");
  }
  return {
    timezone: "Asia/Tokyo",
    defaultStakePerPoint: integer(input.defaultStakePerPoint, `${path}.defaultStakePerPoint`, 100, Number.MAX_SAFE_INTEGER),
    defaultDataScope: defaultDataScope as UserSettings["defaultDataScope"],
    activeRuleVersionId,
  };
}

export function validateRaceRecords(value: unknown, path = "races"): RaceRecord[] {
  if (!Array.isArray(value)) throw new RuntimeDataError(path, "expected an array");
  return value.map((item, index) => {
    try { return validateRaceRecord(item); }
    catch (error) { throw new RuntimeDataError(`${path}[${index}]`, error instanceof Error ? error.message : String(error)); }
  });
}

export function validateRuleVersions(value: unknown, path = "rules"): PredictionRuleVersion[] {
  if (!Array.isArray(value)) throw new RuntimeDataError(path, "expected an array");
  const rules = value.map((item, index) => {
    try { return validatePredictionRuleVersion(item); }
    catch (error) { throw new RuntimeDataError(`${path}[${index}]`, error instanceof Error ? error.message : String(error)); }
  });
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) throw new RuntimeDataError(path, "duplicate rule IDs");
  return rules;
}

export function validateWorkspaceSnapshot(value: unknown, expectedOwner?: OwnerScope): WorkspaceSnapshot {
  const input = record(value, "workspace");
  const ownerScope = string(input.ownerScope, "workspace.ownerScope") as OwnerScope;
  if (!/^(anonymous|user):.+$/.test(ownerScope)) throw new RuntimeDataError("workspace.ownerScope", "invalid owner scope");
  if (expectedOwner && ownerScope !== expectedOwner) throw new RuntimeDataError("workspace.ownerScope", "owner mismatch");
  const settings = record(input.settings, "workspace.settings");
  if (settings.userSettings !== undefined) validateUserSettings(settings.userSettings, "workspace.settings.userSettings");
  return {
    ownerScope,
    races: validateRaceRecords(input.races, "workspace.races"),
    rules: validateRuleVersions(input.rules, "workspace.rules"),
    settings: structuredClone(settings),
    updatedAt: timestamp(input.updatedAt, "workspace.updatedAt"),
  };
}

export function validateOutboxMutation(
  value: unknown,
  expectedOwner?: OwnerScope,
  validatePayload = true,
): OutboxMutation {
  const input = record(value, "outbox");
  const ownerScope = string(input.ownerScope, "outbox.ownerScope") as OwnerScope;
  if (!/^(anonymous|user):.+$/.test(ownerScope) || (expectedOwner && ownerScope !== expectedOwner)) throw new RuntimeDataError("outbox.ownerScope", "invalid or mismatched owner");
  const entityType = input.entityType;
  if (entityType !== "race" && entityType !== "rule" && entityType !== "settings") throw new RuntimeDataError("outbox.entityType", "invalid entity type");
  if (input.operation !== "upsert" && input.operation !== "delete") throw new RuntimeDataError("outbox.operation", "invalid operation");
  if (input.operation === "upsert" && input.payload === null) throw new RuntimeDataError("outbox.payload", "upsert payload is required");
  if (validatePayload && input.payload !== null) {
    if (entityType === "race") validateRaceRecord(input.payload);
    else if (entityType === "rule") validatePredictionRuleVersion(input.payload);
    else validateUserSettings(input.payload, "outbox.payload");
  }
  integer(input.attempts, "outbox.attempts", 0, Number.MAX_SAFE_INTEGER);
  timestamp(input.nextAttemptAt, "outbox.nextAttemptAt");
  timestamp(input.createdAt, "outbox.createdAt");
  timestamp(input.updatedAt, "outbox.updatedAt");
  string(input.mutationId, "outbox.mutationId");
  string(input.entityKey, "outbox.entityKey");
  if (input.expectedVersion !== null) integer(input.expectedVersion, "outbox.expectedVersion", 0, Number.MAX_SAFE_INTEGER);
  return structuredClone(input) as unknown as OutboxMutation;
}

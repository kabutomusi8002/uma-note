import { exportRaces, parseRaces } from "../race-format";
import { upgradeLegacyPredictionLocks } from "../prediction-lock";
import { assertNoDuplicateRaces } from "../race-identity";
import type { PredictionRuleVersion, RaceRecord } from "../types";

export const LOCAL_BACKUP_FORMAT = "UMA_NOTE_BACKUP/1" as const;
export const EMBEDDED_RACE_FORMAT = "RACE/1" as const;
export const EMPTY_RACE_DOCUMENT = "# RACE/1\n# No races" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface LocalBackupContent {
  format: typeof LOCAL_BACKUP_FORMAT;
  createdAt: string;
  raceFormat: typeof EMBEDDED_RACE_FORMAT;
  raceDocument: string;
  rules: PredictionRuleVersion[];
  activeRuleId: string | null;
  settings: JsonObject;
}

export interface LocalBackupDocument extends LocalBackupContent {
  sha256: string;
}

export interface LocalBackup {
  text: string;
  sha256: string;
  content: LocalBackupContent;
  document: LocalBackupDocument;
  races: RaceRecord[];
  rules: PredictionRuleVersion[];
  activeRuleId: string | null;
  settings: JsonObject;
}

export interface CreateLocalBackupInput {
  races: readonly RaceRecord[];
  rules: readonly PredictionRuleVersion[];
  activeRuleId?: string | null;
  settings?: Readonly<Record<string, unknown>>;
  createdAt?: string;
}

export class BackupFormatError extends Error {
  constructor(message: string) {
    super(`UMA_NOTE_BACKUP/1: ${message}`);
    this.name = "BackupFormatError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value: unknown, seen: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new BackupFormatError("non-finite numbers cannot be serialized");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new BackupFormatError(`unsupported JSON value: ${typeof value}`);
  }
  if (seen.has(value)) {
    throw new BackupFormatError("cyclic values cannot be serialized");
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalize(item, seen));
    }
    if (!isPlainObject(value)) {
      throw new BackupFormatError("only plain objects can be serialized");
    }

    const result = Object.create(null) as JsonObject;
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize(value[key], seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/** Deeply clone a JSON value while sorting every object key. */
export function canonicalizeJson(value: unknown): JsonValue {
  return canonicalize(value, new Set<object>());
}

/** Compact canonical JSON used as the input to every SHA-256 digest. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

export async function sha256Hex(input: string): Promise<string> {
  if (typeof input !== "string") {
    throw new BackupFormatError("SHA-256 input must be a string");
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new BackupFormatError("Web Crypto SHA-256 is unavailable");
  }
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new BackupFormatError(`${path} must be an object`);
  }
  return value;
}

function stringAt(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new BackupFormatError(`${path} must be a string`);
  }
  return value;
}

function timestampAt(value: unknown, path: string): string {
  const timestamp = stringAt(value, path);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new BackupFormatError(`${path} must be a valid timestamp`);
  }
  return timestamp;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new BackupFormatError(`${path} must be a boolean`);
  }
  return value;
}

function stringArrayAt(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new BackupFormatError(`${path} must be an array`);
  }
  return value.map((item, index) => stringAt(item, `${path}[${index}]`));
}

function validateRule(value: unknown, path: string): PredictionRuleVersion {
  const rule = objectAt(value, path);
  const allowed = new Set(["id", "name", "version", "rules", "createdAt", "note", "isActive"]);
  for (const key of Object.keys(rule)) {
    if (!allowed.has(key)) throw new BackupFormatError(`${path}.${key} is unsupported`);
  }
  return {
    id: stringAt(rule.id, `${path}.id`),
    name: stringAt(rule.name, `${path}.name`),
    version: stringAt(rule.version, `${path}.version`),
    rules: stringArrayAt(rule.rules, `${path}.rules`),
    createdAt: timestampAt(rule.createdAt, `${path}.createdAt`),
    ...(rule.note === undefined
      ? {}
      : { note: stringAt(rule.note, `${path}.note`, true) }),
    isActive: booleanAt(rule.isActive, `${path}.isActive`),
  };
}

function normalizeRules(
  values: readonly unknown[],
  requestedActiveRuleId: string | null | undefined,
  rewriteActiveFlags = true,
): { rules: PredictionRuleVersion[]; activeRuleId: string | null } {
  const rules = values.map((rule, index) => validateRule(rule, `rules[${index}]`));
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
    throw new BackupFormatError("rule IDs must be unique");
  }

  const activeRules = rules.filter((rule) => rule.isActive);
  if (requestedActiveRuleId === undefined && activeRules.length > 1) {
    throw new BackupFormatError("only one rule can be active");
  }
  const activeRuleId =
    requestedActiveRuleId === undefined ? (activeRules[0]?.id ?? null) : requestedActiveRuleId;
  if (activeRuleId !== null && !rules.some((rule) => rule.id === activeRuleId)) {
    throw new BackupFormatError(`active rule ${activeRuleId} is not included`);
  }

  if (!rewriteActiveFlags) {
    const actualActiveId = activeRules[0]?.id ?? null;
    if (activeRules.length > 1 || actualActiveId !== activeRuleId) {
      throw new BackupFormatError("rule isActive flags must match activeRuleId");
    }
    return { activeRuleId, rules };
  }

  return {
    activeRuleId,
    rules: rules.map((rule) => ({
      ...rule,
      isActive: rule.id === activeRuleId,
    })),
  };
}

function settingsAt(value: unknown): JsonObject {
  const settings = objectAt(value, "settings");
  return canonicalizeJson(settings) as JsonObject;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new BackupFormatError(`document keys must be: ${sortedExpected.join(", ")}`);
  }
}

function copyContent(content: LocalBackupContent): LocalBackupContent {
  return canonicalizeJson(content) as unknown as LocalBackupContent;
}

async function assembleBackup(
  content: LocalBackupContent,
  races: RaceRecord[],
): Promise<LocalBackup> {
  const normalizedContent = copyContent(content);
  const sha256 = await sha256Hex(canonicalJson(normalizedContent));
  const document = canonicalizeJson({ ...normalizedContent, sha256 }) as unknown as LocalBackupDocument;
  const text = JSON.stringify(document, null, 2);
  return {
    text,
    sha256,
    content: normalizedContent,
    document,
    races,
    rules: normalizedContent.rules,
    activeRuleId: normalizedContent.activeRuleId,
    settings: normalizedContent.settings,
  };
}

/** Create a complete local safety backup before any cloud migration. */
export async function createLocalBackup(
  input: CreateLocalBackupInput,
): Promise<LocalBackup> {
  if (!Array.isArray(input.races) || !Array.isArray(input.rules)) {
    throw new BackupFormatError("races and rules must be arrays");
  }
  const upgradedRaces = upgradeLegacyPredictionLocks(input.races);
  assertNoDuplicateRaces(upgradedRaces);
  const raceDocument =
    upgradedRaces.length === 0 ? EMPTY_RACE_DOCUMENT : exportRaces(upgradedRaces);
  const races = upgradedRaces.length === 0 ? [] : parseRaces(raceDocument);
  const { rules, activeRuleId } = normalizeRules(input.rules, input.activeRuleId);
  const createdAt = timestampAt(input.createdAt ?? new Date().toISOString(), "createdAt");
  const settings = settingsAt(input.settings ?? {});

  return assembleBackup(
    {
      format: LOCAL_BACKUP_FORMAT,
      createdAt,
      raceFormat: EMBEDDED_RACE_FORMAT,
      raceDocument,
      rules,
      activeRuleId,
      settings,
    },
    races,
  );
}

/** Parse, checksum and validate a backup without mutating application state. */
export async function parseLocalBackup(text: string): Promise<LocalBackup> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new BackupFormatError(
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const document = objectAt(parsed, "document");
  assertExactKeys(document, [
    "format",
    "createdAt",
    "raceFormat",
    "raceDocument",
    "rules",
    "activeRuleId",
    "settings",
    "sha256",
  ]);
  if (document.format !== LOCAL_BACKUP_FORMAT) {
    throw new BackupFormatError(`unsupported format: ${String(document.format)}`);
  }
  if (document.raceFormat !== EMBEDDED_RACE_FORMAT) {
    throw new BackupFormatError(`unsupported race format: ${String(document.raceFormat)}`);
  }

  const createdAt = timestampAt(document.createdAt, "createdAt");
  const raceDocument = stringAt(document.raceDocument, "raceDocument");
  if (!Array.isArray(document.rules)) {
    throw new BackupFormatError("rules must be an array");
  }
  const requestedActiveRuleId =
    document.activeRuleId === null
      ? null
      : stringAt(document.activeRuleId, "activeRuleId");
  const { rules, activeRuleId } = normalizeRules(
    document.rules,
    requestedActiveRuleId,
    false,
  );
  const settings = settingsAt(document.settings);
  const suppliedHash = stringAt(document.sha256, "sha256").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(suppliedHash)) {
    throw new BackupFormatError("sha256 must contain 64 hexadecimal characters");
  }

  const content: LocalBackupContent = {
    format: LOCAL_BACKUP_FORMAT,
    createdAt,
    raceFormat: EMBEDDED_RACE_FORMAT,
    raceDocument,
    rules,
    activeRuleId,
    settings,
  };
  const expectedHash = await sha256Hex(canonicalJson(content));
  if (expectedHash !== suppliedHash) {
    throw new BackupFormatError("SHA-256 checksum does not match the backup contents");
  }

  const races =
    raceDocument === EMPTY_RACE_DOCUMENT ? [] : parseRaces(raceDocument);
  assertNoDuplicateRaces(races);
  const normalizedContent = copyContent(content);
  const normalizedDocument = canonicalizeJson({
    ...normalizedContent,
    sha256: suppliedHash,
  }) as unknown as LocalBackupDocument;
  return {
    text: JSON.stringify(normalizedDocument, null, 2),
    sha256: suppliedHash,
    content: normalizedContent,
    document: normalizedDocument,
    races,
    rules: normalizedContent.rules,
    activeRuleId: normalizedContent.activeRuleId,
    settings: normalizedContent.settings,
  };
}

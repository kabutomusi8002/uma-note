import { expandBetCombinations } from "../calculations";
import {
  assertNoDuplicateRaces,
  normalizeRaceIdentity,
  raceNaturalKey,
} from "../race-identity";
import { exportRace } from "../race-format";
import {
  RACE_DATA_SCOPES,
  type BetPlan,
  type PredictionRuleVersion,
  type RaceDataScope,
  type RacePrediction,
  type RaceRecord,
} from "../types";
import { canonicalJson, sha256Hex, type JsonValue } from "./backup-format";

export const MIGRATION_PLAN_VERSION = 1 as const;

export type MigrationAction =
  | "create"
  | "identical"
  | "conflict"
  | "immutable"
  | "excluded";

export type MigrationReason =
  | "new-race"
  | "same-content"
  | "already-applied"
  | "scope-excluded"
  | "cloud-immutable"
  | "cloud-deleted"
  | "no-base"
  | "local-changed"
  | "cloud-changed"
  | "both-changed";

export interface MigrationScopeSelection {
  live: boolean;
  demo: boolean;
  test: boolean;
}

export interface MigrationPlanItem {
  sourceId: string;
  naturalKey: string;
  dataScope: RaceDataScope;
  selected: boolean;
  action: MigrationAction;
  reason: MigrationReason;
  localRace: RaceRecord;
  cloudRace?: RaceRecord;
  baseRace?: RaceRecord;
  recordHash: string;
  idempotencyKey: string;
  localSemanticHash: string;
  cloudSemanticHash?: string;
  baseSemanticHash?: string;
  localChangedSinceBase: boolean | null;
  cloudChangedSinceBase: boolean | null;
}

export interface MigrationPlan {
  version: typeof MIGRATION_PLAN_VERSION;
  hash: string;
  backupHash?: string;
  items: MigrationPlanItem[];
  counts: Record<MigrationAction, number>;
  scopeSelection: MigrationScopeSelection;
}

export interface BuildMigrationPlanInput {
  localRaces: readonly RaceRecord[];
  cloudRaces: readonly RaceRecord[];
  baseRaces?: readonly RaceRecord[];
  includeScopes?: Partial<Record<RaceDataScope, boolean>>;
  /** Successful record hashes or idempotency keys returned by a prior apply. */
  appliedRecordHashes?: ReadonlySet<string> | readonly string[];
  backupHash?: string;
}

export type MigrationConflictResolution = "keep-cloud" | "replace-local";

export interface MigrationConfirmation {
  planHash: string;
  backupSaved: boolean;
  backupHash?: string;
  previewReviewed: boolean;
  selectedSourceIds: readonly string[];
  /** Rules and settings selected alongside the race plan. */
  selectedAdditionalCount?: number;
  conflictResolutions?: Readonly<Record<string, MigrationConflictResolution>>;
  confirmationText: string;
}

export class MigrationPlanError extends Error {
  constructor(message: string) {
    super(`Migration plan: ${message}`);
    this.name = "MigrationPlanError";
  }
}

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : value;
}

function sortedUniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sortCanonical<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) =>
    compareText(canonicalJson(left), canonicalJson(right)),
  );
}

function semanticPrediction(prediction: RacePrediction): JsonValue {
  return {
    selectedHorses: sortCanonical(
      prediction.selectedHorses.map((horse) => ({
        horseNumber: horse.horseNumber,
        horseName: horse.horseName,
        mark: horse.mark,
        comment: horse.comment ?? "",
      })),
    ),
    paceScenario: prediction.paceScenario,
    trackView: prediction.trackView,
    dangerousFavorites: sortedUniqueNumbers(prediction.dangerousFavorites),
    longshots: sortedUniqueNumbers(prediction.longshots),
    decision: prediction.decision,
    note: prediction.note,
  };
}

function semanticRule(rule: PredictionRuleVersion | null): JsonValue {
  if (!rule) return null;
  return {
    name: rule.name,
    version: rule.version,
    rules: [...rule.rules],
    note: rule.note ?? "",
  };
}

function semanticBets(plans: readonly BetPlan[]): JsonValue[] {
  const tickets = plans.flatMap((plan) =>
    expandBetCombinations(plan).map((combination) => ({
      betType: plan.betType,
      combination,
      stakePerPoint: plan.stakePerPoint,
      memo: plan.memo ?? "",
    })),
  );
  return sortCanonical(tickets);
}

function normalizedStatus(race: RaceRecord): NonNullable<RaceRecord["status"]> {
  if (race.status) return race.status;
  if (race.result) return "resulted";
  if (race.lock.isLocked || race.lock.postTimeLockedAt) return "closed";
  return "scheduled";
}

function semanticRace(race: RaceRecord): JsonValue {
  const identity = normalizeRaceIdentity(race);
  const lockedSnapshot = race.lock.lockedSnapshot;
  return {
    identity: {
      date: identity.date,
      course: identity.course,
      raceNumber: identity.raceNumber,
    },
    dataScope: race.dataScope ?? "live",
    status: normalizedStatus(race),
    startTime: race.startTime.normalize("NFKC").trim(),
    name: race.name,
    entries: sortCanonical(
      (race.entries ?? []).map((entry) => ({
        horseNumber: entry.horseNumber,
        horseName: entry.horseName,
      })),
    ),
    prediction: semanticPrediction(race.prediction),
    proposedBets: semanticBets(race.proposedBets),
    purchasedBets: semanticBets(race.purchasedBets),
    lock: {
      isLocked: race.lock.isLocked,
      lockedAt: normalizeTimestamp(race.lock.lockedAt),
      postTimeLockedAt: normalizeTimestamp(race.lock.postTimeLockedAt),
      lockedSnapshot: lockedSnapshot
        ? {
            schemaVersion: lockedSnapshot.schemaVersion,
            race: {
              date: normalizeRaceIdentity(lockedSnapshot.race).date,
              course: normalizeRaceIdentity(lockedSnapshot.race).course,
              raceNumber: normalizeRaceIdentity(lockedSnapshot.race).raceNumber,
              startTime: lockedSnapshot.race.startTime.normalize("NFKC").trim(),
              name: lockedSnapshot.race.name,
              dataScope: lockedSnapshot.race.dataScope ?? "live",
            },
            prediction: semanticPrediction(lockedSnapshot.prediction),
            proposedBets: semanticBets(lockedSnapshot.proposedBets),
            ruleVersion: semanticRule(lockedSnapshot.ruleVersion),
            lockedAt: normalizeTimestamp(lockedSnapshot.lockedAt),
          }
        : null,
      revisions: sortCanonical(
        race.lock.revisions.map((revision) => ({
          revision: revision.revision,
          changedAt: normalizeTimestamp(revision.changedAt),
          summary: revision.summary,
          snapshot: semanticPrediction(revision.snapshot),
        })),
      ),
    },
    result: race.result
      ? {
          status: race.result.status ?? "official",
          finishOrder: sortCanonical(
            race.result.finishOrder.map((finish) => ({
              position: finish.position,
              horseNumber: finish.horseNumber,
              horseName: finish.horseName ?? "",
            })),
          ),
          payouts: sortCanonical(
            race.result.payouts.map((payout) => ({
              betType: payout.betType,
              combination:
                payout.betType === "trifecta"
                  ? [...payout.combination]
                  : sortedUniqueNumbers(payout.combination),
              payoutPer100: payout.payoutPer100,
            })),
          ),
          confirmedAt: normalizeTimestamp(race.result.confirmedAt),
        }
      : null,
    reflection: race.reflection
      ? {
          categories: [...race.reflection.categories].sort(),
          note: race.reflection.note,
          nextAction: race.reflection.nextAction ?? "",
        }
      : null,
    ruleVersion: semanticRule(race.ruleVersion),
  };
}

async function semanticHash(race: RaceRecord): Promise<string> {
  return sha256Hex(canonicalJson(semanticRace(race)));
}

function assertUniqueIds(races: readonly RaceRecord[], label: string): void {
  const ids = new Set<string>();
  for (const race of races) {
    if (ids.has(race.id)) {
      throw new MigrationPlanError(`${label} contains duplicate ID ${race.id}`);
    }
    ids.add(race.id);
  }
}

function indexRaces(races: readonly RaceRecord[]): {
  byId: Map<string, RaceRecord>;
  byNaturalKey: Map<string, RaceRecord>;
} {
  return {
    byId: new Map(races.map((race) => [race.id, race])),
    byNaturalKey: new Map(races.map((race) => [raceNaturalKey(race), race])),
  };
}

function matchingRace(
  race: RaceRecord,
  index: ReturnType<typeof indexRaces>,
): RaceRecord | undefined {
  return index.byId.get(race.id) ?? index.byNaturalKey.get(raceNaturalKey(race));
}

function immutableCloudRace(race: RaceRecord): boolean {
  return Boolean(
    race.lock.isLocked ||
      race.lock.postTimeLockedAt ||
      race.result ||
      race.status === "closed" ||
      race.status === "resulted" ||
      race.status === "cancelled",
  );
}

function scopeSelection(
  requested: BuildMigrationPlanInput["includeScopes"],
): MigrationScopeSelection {
  return {
    live: requested?.live ?? true,
    demo: requested?.demo ?? false,
    test: requested?.test ?? false,
  };
}

function appliedHashes(
  values: BuildMigrationPlanInput["appliedRecordHashes"],
): ReadonlySet<string> {
  if (!values) return new Set<string>();
  return values instanceof Set ? values : new Set(values);
}

function classifyConflict(
  baseExists: boolean,
  localChanged: boolean | null,
  cloudChanged: boolean | null,
): MigrationReason {
  if (!baseExists) return "no-base";
  if (localChanged && cloudChanged) return "both-changed";
  if (localChanged) return "local-changed";
  return "cloud-changed";
}

async function buildItem(
  localRace: RaceRecord,
  cloudRace: RaceRecord | undefined,
  baseRace: RaceRecord | undefined,
  scopes: MigrationScopeSelection,
  applied: ReadonlySet<string>,
  backupHash: string | undefined,
): Promise<MigrationPlanItem> {
  const dataScope = localRace.dataScope ?? "live";
  const recordHash = await sha256Hex(exportRace(localRace));
  const idempotencyKey = `${backupHash ?? "unversioned"}:${recordHash}`;
  const [localSemanticHash, cloudSemanticHash, baseSemanticHash] = await Promise.all([
    semanticHash(localRace),
    cloudRace ? semanticHash(cloudRace) : Promise.resolve(undefined),
    baseRace ? semanticHash(baseRace) : Promise.resolve(undefined),
  ]);
  const localChangedSinceBase = baseSemanticHash
    ? localSemanticHash !== baseSemanticHash
    : null;
  const cloudChangedSinceBase = baseSemanticHash && cloudSemanticHash
    ? cloudSemanticHash !== baseSemanticHash
    : null;

  let action: MigrationAction;
  let reason: MigrationReason;
  if (!scopes[dataScope]) {
    action = "excluded";
    reason = "scope-excluded";
  } else if (applied.has(recordHash) || applied.has(idempotencyKey)) {
    action = "identical";
    reason = "already-applied";
  } else if (!cloudRace) {
    if (baseRace) {
      action = "conflict";
      reason = "cloud-deleted";
    } else {
      action = "create";
      reason = "new-race";
    }
  } else if (localSemanticHash === cloudSemanticHash) {
    action = "identical";
    reason = "same-content";
  } else if (immutableCloudRace(cloudRace)) {
    action = "immutable";
    reason = "cloud-immutable";
  } else {
    action = "conflict";
    reason = classifyConflict(
      Boolean(baseRace),
      localChangedSinceBase,
      cloudChangedSinceBase,
    );
  }

  return {
    sourceId: localRace.id,
    naturalKey: raceNaturalKey(localRace),
    dataScope,
    selected: action === "create",
    action,
    reason,
    localRace,
    ...(cloudRace ? { cloudRace } : {}),
    ...(baseRace ? { baseRace } : {}),
    recordHash,
    idempotencyKey,
    localSemanticHash,
    ...(cloudSemanticHash ? { cloudSemanticHash } : {}),
    ...(baseSemanticHash ? { baseSemanticHash } : {}),
    localChangedSinceBase,
    cloudChangedSinceBase,
  };
}

/** Build a read-only preview. No local or cloud state is changed. */
export async function buildMigrationPlan(
  input: BuildMigrationPlanInput,
): Promise<MigrationPlan> {
  const baseRaces = input.baseRaces ?? [];
  for (const [label, races] of [
    ["localRaces", input.localRaces],
    ["cloudRaces", input.cloudRaces],
    ["baseRaces", baseRaces],
  ] as const) {
    assertNoDuplicateRaces(races);
    assertUniqueIds(races, label);
  }

  const scopes = scopeSelection(input.includeScopes);
  const cloudIndex = indexRaces(input.cloudRaces);
  const baseIndex = indexRaces(baseRaces);
  const applied = appliedHashes(input.appliedRecordHashes);
  const items = await Promise.all(
    input.localRaces.map((localRace) =>
      buildItem(
        localRace,
        matchingRace(localRace, cloudIndex),
        matchingRace(localRace, baseIndex),
        scopes,
        applied,
        input.backupHash,
      ),
    ),
  );
  items.sort((left, right) => {
    const leftIdentity = normalizeRaceIdentity(left.localRace);
    const rightIdentity = normalizeRaceIdentity(right.localRace);
    return (
      compareText(leftIdentity.date, rightIdentity.date) ||
      compareText(leftIdentity.course, rightIdentity.course) ||
      leftIdentity.raceNumber - rightIdentity.raceNumber ||
      compareText(left.sourceId, right.sourceId)
    );
  });

  const counts: Record<MigrationAction, number> = {
    create: 0,
    identical: 0,
    conflict: 0,
    immutable: 0,
    excluded: 0,
  };
  for (const item of items) counts[item.action] += 1;

  const hash = await sha256Hex(
    canonicalJson({
      version: MIGRATION_PLAN_VERSION,
      backupHash: input.backupHash ?? null,
      scopeSelection: scopes,
      items: items.map((item) => ({
        sourceId: item.sourceId,
        naturalKey: item.naturalKey,
        dataScope: item.dataScope,
        action: item.action,
        reason: item.reason,
        recordHash: item.recordHash,
        idempotencyKey: item.idempotencyKey,
        localSemanticHash: item.localSemanticHash,
        cloudSemanticHash: item.cloudSemanticHash ?? null,
        baseSemanticHash: item.baseSemanticHash ?? null,
      })),
    }),
  );

  return {
    version: MIGRATION_PLAN_VERSION,
    hash,
    ...(input.backupHash ? { backupHash: input.backupHash } : {}),
    items,
    counts,
    scopeSelection: scopes,
  };
}

export function migrationConfirmationText(selectedCount: number): string {
  if (!Number.isInteger(selectedCount) || selectedCount < 0) {
    throw new MigrationPlanError("selected count must be a non-negative integer");
  }
  return `${selectedCount}件を移行`;
}

export function migrationConfirmationIssues(
  plan: MigrationPlan,
  confirmation: MigrationConfirmation,
): string[] {
  const issues: string[] = [];
  if (confirmation.planHash !== plan.hash) issues.push("plan hash does not match");
  if (!confirmation.backupSaved) issues.push("a local backup has not been saved");
  if (plan.backupHash && confirmation.backupHash !== plan.backupHash) {
    issues.push("backup hash does not match");
  }
  if (!confirmation.previewReviewed) issues.push("the preview has not been reviewed");

  const selectedIds = [...new Set(confirmation.selectedSourceIds)];
  if (selectedIds.length !== confirmation.selectedSourceIds.length) {
    issues.push("selected source IDs must be unique");
  }
  const selectedAdditionalCount = confirmation.selectedAdditionalCount ?? 0;
  if (
    !Number.isInteger(selectedAdditionalCount) ||
    selectedAdditionalCount < 0
  ) {
    issues.push("additional selected count must be a non-negative integer");
  }
  if (selectedIds.length + selectedAdditionalCount === 0) {
    issues.push("no migration entities are selected");
  }
  const byId = new Map(plan.items.map((item) => [item.sourceId, item]));
  for (const sourceId of selectedIds) {
    const item = byId.get(sourceId);
    if (!item) {
      issues.push(`unknown race ${sourceId}`);
      continue;
    }
    if (item.action === "conflict") {
      if (confirmation.conflictResolutions?.[sourceId] !== "replace-local") {
        issues.push(`conflict ${sourceId} is not explicitly resolved to local`);
      }
    } else if (item.action !== "create") {
      issues.push(`${item.action} race ${sourceId} cannot be applied`);
    }
  }

  if (
    confirmation.confirmationText !==
    migrationConfirmationText(selectedIds.length + selectedAdditionalCount)
  ) {
    issues.push("confirmation text does not match the selected count");
  }
  return issues;
}

/** True only after backup, preview, selection and typed confirmation all agree. */
export function canConfirmMigration(
  plan: MigrationPlan,
  confirmation: MigrationConfirmation,
): boolean {
  return migrationConfirmationIssues(plan, confirmation).length === 0;
}

export const isMigrationConfirmable = canConfirmMigration;

/** Public for deterministic diagnostics and tests; it performs no I/O. */
export function migrationSemanticProjection(race: RaceRecord): JsonValue {
  return semanticRace(race);
}

export { RACE_DATA_SCOPES };

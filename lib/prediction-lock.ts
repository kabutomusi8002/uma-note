import type { PredictionRevision, RaceRecord } from "./types";

export interface PredictionLockOptions {
  revisionId: string;
  changedAt: string;
  lockedAt: string;
}

function completeLockedSnapshot(
  race: RaceRecord,
  lockedAt: string,
  provenance: "explicit_lock" | "legacy_local_upgrade",
): NonNullable<RaceRecord["lock"]["lockedSnapshot"]> {
  return {
    schemaVersion: 1,
    provenance,
    race: {
      id: race.id,
      dataScope: race.dataScope ?? "live",
      date: race.date,
      course: race.course,
      raceNumber: race.raceNumber,
      startTime: race.startTime,
      name: race.name,
    },
    prediction: structuredClone(race.prediction),
    proposedBets: structuredClone(race.proposedBets),
    ruleVersion: race.ruleVersion ? structuredClone(race.ruleVersion) : null,
    lockedAt,
  };
}

/**
 * v0.1.1 stored an explicit lock and frozen fields but did not yet persist the
 * complete snapshot object. Reconstruct it before backup/sync and label the
 * provenance so it is never mistaken for a new server-timestamped lock.
 */
export function upgradeLegacyPredictionLock(race: RaceRecord): RaceRecord {
  const lockedAt = race.lock.lockedAt;
  if (
    !race.lock.isLocked ||
    !lockedAt ||
    race.lock.lockedSnapshot
  ) {
    return race;
  }
  const source = structuredClone(race);
  return {
    ...source,
    lock: {
      ...source.lock,
      lockedSnapshot: completeLockedSnapshot(
        source,
        lockedAt,
        "legacy_local_upgrade",
      ),
    },
  };
}

export function upgradeLegacyPredictionLocks(
  races: readonly RaceRecord[],
): RaceRecord[] {
  return races.map(upgradeLegacyPredictionLock);
}

/**
 * Create the immutable snapshot recorded when a user explicitly locks a
 * pre-race prediction.
 */
export function lockRacePrediction(
  race: RaceRecord,
  options: PredictionLockOptions,
): RaceRecord {
  const source = JSON.parse(JSON.stringify(race)) as RaceRecord;
  const revision: PredictionRevision = {
    id: options.revisionId,
    revision: source.lock.revisions.length + 1,
    changedAt: options.changedAt,
    summary: "発走前の最終予想をロック",
    snapshot: JSON.parse(JSON.stringify(source.prediction)) as RaceRecord["prediction"],
  };

  const lockedSnapshot: NonNullable<RaceRecord["lock"]["lockedSnapshot"]> = {
    ...completeLockedSnapshot(source, options.lockedAt, "explicit_lock"),
  };

  return {
    ...source,
    lock: {
      ...source.lock,
      isLocked: true,
      lockedAt: options.lockedAt,
      lockedSnapshot,
      revisions: [...source.lock.revisions, revision],
    },
  };
}

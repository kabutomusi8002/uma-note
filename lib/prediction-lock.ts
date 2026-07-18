import type { PredictionRevision, RaceRecord } from "./types";

export interface PredictionLockOptions {
  revisionId: string;
  changedAt: string;
  lockedAt: string;
}

/**
 * Create the immutable snapshot recorded when a user explicitly locks a
 * pre-race prediction.
 */
export function lockRacePrediction(
  race: RaceRecord,
  options: PredictionLockOptions,
): RaceRecord {
  const revision: PredictionRevision = {
    id: options.revisionId,
    revision: race.lock.revisions.length + 1,
    changedAt: options.changedAt,
    summary: "発走前の最終予想をロック",
    snapshot: JSON.parse(JSON.stringify(race.prediction)) as RaceRecord["prediction"],
  };

  return {
    ...race,
    lock: {
      ...race.lock,
      isLocked: true,
      lockedAt: options.lockedAt,
      revisions: [...race.lock.revisions, revision],
    },
  };
}

import type { RaceDataScope, RaceRecord } from "./types";

export const RACE_DATA_SCOPE_LABELS: Readonly<Record<RaceDataScope, string>> = {
  live: "実収支（集計対象）",
  demo: "デモ（集計対象外）",
  test: "テスト（集計対象外）",
};

/** Backward compatibility: records created before dataScope existed are live. */
export function getRaceDataScope(race: Pick<RaceRecord, "dataScope">): RaceDataScope {
  return race.dataScope ?? "live";
}

export function isRaceIncludedInPerformance(
  race: Pick<RaceRecord, "dataScope">,
): boolean {
  return getRaceDataScope(race) === "live";
}

export function filterPerformanceRaces<T extends Pick<RaceRecord, "dataScope">>(
  races: readonly T[],
): T[] {
  return races.filter(isRaceIncludedInPerformance);
}

/**
 * Migrates snapshots written before dataScope existed. Only fixed, known demo
 * IDs are changed; every other legacy record keeps the live default.
 */
export function normalizeKnownDemoRaceScopes(
  races: readonly RaceRecord[],
  knownDemoIds: ReadonlySet<string>,
): RaceRecord[] {
  return races.map((race) => (
    knownDemoIds.has(race.id) && race.dataScope !== "demo"
      ? { ...race, dataScope: "demo" }
      : race
  ));
}

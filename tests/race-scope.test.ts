import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { calculateRaceSettlement } from "../lib/calculations";
import {
  createDemoRace,
  DEMO_RACE,
  DEMO_RACE_IDS,
  DEMO_UPCOMING_RACE,
} from "../lib/demo-data";
import {
  filterPerformanceRaces,
  getRaceDataScope,
  isRaceIncludedInPerformance,
  normalizeKnownDemoRaceScopes,
} from "../lib/race-scope";

describe("race data scope", () => {
  it("treats legacy records as live while excluding demo and test", () => {
    const legacy = createDemoRace();
    delete legacy.dataScope;
    const testRace = { ...createDemoRace(), id: "test-race", dataScope: "test" as const };

    expect(getRaceDataScope(legacy)).toBe("live");
    expect(isRaceIncludedInPerformance(legacy)).toBe(true);
    expect(isRaceIncludedInPerformance(DEMO_RACE)).toBe(false);
    expect(isRaceIncludedInPerformance(testRace)).toBe(false);
    expect(DEMO_UPCOMING_RACE.dataScope).toBe("demo");
  });

  it("keeps demo/test settlements out of aggregate totals", () => {
    const live = { ...createDemoRace(), id: "live-race", dataScope: "live" as const };
    const testRace = { ...createDemoRace(), id: "test-race", dataScope: "test" as const };
    const included = filterPerformanceRaces([DEMO_RACE, testRace, live]);
    const total = included
      .map((race) => calculateRaceSettlement(race.purchasedBets, race.result?.payouts ?? []))
      .reduce(
        (summary, settlement) => ({
          investment: summary.investment + settlement.investment,
          payout: summary.payout + settlement.payout,
        }),
        { investment: 0, payout: 0 },
      );
    const liveSettlement = calculateRaceSettlement(
      live.purchasedBets,
      live.result?.payouts ?? [],
    );

    expect(included.map((race) => race.id)).toEqual(["live-race"]);
    expect(total).toEqual({
      investment: liveSettlement.investment,
      payout: liveSettlement.payout,
    });
  });

  it("migrates only known legacy demo IDs during hydration", () => {
    const legacyDemo = createDemoRace();
    delete legacyDemo.dataScope;
    const legacyUserRace = { ...createDemoRace(), id: "legacy-user-race" };
    delete legacyUserRace.dataScope;

    const migrated = normalizeKnownDemoRaceScopes(
      [legacyDemo, legacyUserRace],
      DEMO_RACE_IDS,
    );

    expect(migrated[0]?.dataScope).toBe("demo");
    expect(migrated[1]?.dataScope).toBeUndefined();
    expect(getRaceDataScope(migrated[1] ?? legacyUserRace)).toBe("live");
  });

  it("keeps the scope selector editable after lock except for fixed demo data", () => {
    const source = readFileSync(
      new URL("../app/components/uma-note-app.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain('aria-label="収支区分"');
    expect(source).toContain('disabled={dataScope === "demo"}');
    expect(source).toContain("filter(isRaceIncludedInPerformance)");
    expect(source).toContain("normalizeKnownDemoRaceScopes");
  });
});

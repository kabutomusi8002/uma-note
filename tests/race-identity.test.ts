import { describe, expect, it } from "vitest";
import { createDemoRace } from "../lib/demo-data";
import {
  RaceIdentityError,
  assertNoDuplicateRaces,
  findDuplicateRaces,
  normalizeRaceIdentity,
  raceNaturalKey,
} from "../lib/race-identity";

describe("race natural identity", () => {
  it("日付・競馬場・レース番号を自然キー用に正規化する", () => {
    expect(
      normalizeRaceIdentity({
        date: "２０２６/７/１２",
        course: "  TOKYO　Racecourse  ",
        raceNumber: "１１",
      }),
    ).toEqual({
      date: "2026-07-12",
      course: "tokyo racecourse",
      raceNumber: 11,
    });
  });

  it("表記揺れとIDに影響されない同じキーを作る", () => {
    const left = {
      id: "local-id",
      date: "2026-7-12",
      course: "TOKYO  Racecourse",
      raceNumber: 11,
    };
    const right = {
      id: "cloud-id",
      date: "２０２６.０７.１２",
      course: " Tokyo　Racecourse ",
      raceNumber: "11",
    };

    expect(raceNaturalKey(left)).toBe(raceNaturalKey(right));
  });

  it("IDが違っても同じ自然キーの重複を拒否する", () => {
    const first = { ...createDemoRace(), id: "local-a" };
    const second = {
      ...createDemoRace(),
      id: "local-b",
      date: "2026/7/12",
      course: " 福島 ",
    };

    expect(findDuplicateRaces([first, second])).toHaveLength(1);
    expect(() => assertNoDuplicateRaces([first, second])).toThrow(
      RaceIdentityError,
    );
    expect(() => assertNoDuplicateRaces([first, second])).toThrow(/local-a.*local-b/);
  });

  it("自然キーが異なるレースは許可する", () => {
    const first = createDemoRace();
    const second = { ...createDemoRace(), id: "other", raceNumber: 10 };
    expect(() => assertNoDuplicateRaces([first, second])).not.toThrow();
  });

  it("存在しない日付と範囲外レース番号を拒否する", () => {
    expect(() =>
      raceNaturalKey({ date: "2026-02-30", course: "東京", raceNumber: 1 }),
    ).toThrow(/real calendar date/);
    expect(() =>
      raceNaturalKey({ date: "2026-02-28", course: "東京", raceNumber: 13 }),
    ).toThrow(/1 to 12/);
  });
});

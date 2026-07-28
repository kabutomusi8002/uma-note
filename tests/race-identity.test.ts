import { describe, expect, it } from "vitest";
import { createDemoRace } from "../lib/demo-data";
import {
  RaceIdentityError,
  assertNoDuplicateRaces,
  backfillRaceClientKey,
  findDuplicateRaces,
  normalizeRaceIdentity,
  raceClientKey,
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
    const second = {
      ...createDemoRace(),
      id: "other",
      clientKey: "other",
      raceNumber: 10,
    };
    expect(() => assertNoDuplicateRaces([first, second])).not.toThrow();
  });

  it("自然キーが異なっても同じclientKeyの二重Outbox候補を拒否する", () => {
    const first = createDemoRace();
    const second = {
      ...createDemoRace(),
      id: "other-local-id",
      clientKey: first.clientKey,
      raceNumber: 10,
    };
    expect(() => assertNoDuplicateRaces([first, second])).toThrow(
      /client keys.*race-2026-07-12-fukushima-11/,
    );
  });

  it("存在しない日付と範囲外レース番号を拒否する", () => {
    expect(() =>
      raceNaturalKey({ date: "2026-02-30", course: "東京", raceNumber: 1 }),
    ).toThrow(/real calendar date/);
    expect(() =>
      raceNaturalKey({ date: "2026-02-28", course: "東京", raceNumber: 13 }),
    ).toThrow(/1 to 12/);
  });

  it("保存済みclientKeyを自然キー変更後も再計算しない", () => {
    const race = {
      ...createDemoRace(),
      id: "local-ui-id",
      clientKey: "stable-cloud-key",
    };
    const movedRace = { ...race, date: "2027-01-01", raceNumber: 1 };
    expect(raceClientKey(movedRace)).toBe(
      "stable-cloud-key",
    );
  });

  it("旧レースは新しい乱数を作らずOutboxキー、次に旧idを採用する", () => {
    const legacy = createDemoRace();
    delete (legacy as Partial<typeof legacy>).clientKey;
    expect(backfillRaceClientKey(legacy, "queued-cloud-key").clientKey).toBe(
      "queued-cloud-key",
    );
    expect(backfillRaceClientKey(legacy).clientKey).toBe(legacy.id);
  });

  it("空白を正規化しDB上限を超えるclientKeyを拒否する", () => {
    expect(raceClientKey({ id: "legacy", clientKey: " stable-key " })).toBe(
      "stable-key",
    );
    expect(() => raceClientKey({
      id: "legacy",
      clientKey: "x".repeat(161),
    })).toThrow(/160/);
  });
});

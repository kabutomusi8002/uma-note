import { describe, expect, it } from "vitest";
import { DEMO_RACE } from "../lib/demo-data";
import {
  databaseRecordToRace,
  raceToDatabasePayload,
} from "../lib/supabase/race-repository";

describe("Supabase race adapter", () => {
  it("expands proposed and actual plans into separate database slips", () => {
    const payload = raceToDatabasePayload(DEMO_RACE);
    expect((payload.race as { data_scope: string }).data_scope).toBe("demo");
    const slips = payload.bet_slips as Array<{
      kind: string;
      tickets: unknown[];
    }>;

    expect(slips.filter((slip) => slip.kind === "proposal")).toHaveLength(2);
    expect(slips.filter((slip) => slip.kind === "actual")).toHaveLength(3);
    expect(slips.every((slip) => slip.tickets.length > 0)).toBe(true);
    expect(
      (payload.prediction as { revisions: unknown[] }).revisions,
    ).toHaveLength(2);
  });

  it("maps a database RPC record to the client race model", () => {
    const race = databaseRecordToRace({
      id: "18d13b92-4e17-43e5-8eb5-3e94b70c1c3d",
      meeting: {
        meeting_date: "2026-07-19",
        racecourse: { code: "HAKODATE", name_ja: "函館" },
      },
      race: {
        race_number: 11,
        data_scope: "test",
        starts_at: "2026-07-19T15:25:00+09:00",
        name: "函館テスト",
        created_at: "2026-07-17T01:00:00Z",
        updated_at: "2026-07-17T02:00:00Z",
      },
      entries: [
        { horse_number: 1, horse_name: "人気馬" },
        { horse_number: 4, horse_name: "ノースライト" },
        { horse_number: 8, horse_name: "登録だけの馬" },
      ],
      prediction: {
        status: "locked",
        effective_status: "locked",
        decision: "pass",
        pace_scenario: "ハイペース",
        track_bias: "外伸び",
        summary: "見送り",
        selections: [
          {
            horse_number: 4,
            horse_name: "ノースライト",
            mark: "honmei",
            is_key: true,
            is_dangerous_favorite: false,
            is_longshot: false,
          },
          {
            horse_number: 1,
            horse_name: "人気馬",
            mark: "none",
            is_dangerous_favorite: true,
            is_longshot: false,
          },
        ],
        revisions: [
          {
            id: "1",
            revision: 1,
            changed_at: "2026-07-17T01:30:00Z",
            summary: "初回予想",
            snapshot: {
              selectedHorses: [
                { horseNumber: 4, horseName: "ノースライト", mark: "◎" },
              ],
              paceScenario: "ハイペース",
              trackView: "外伸び",
              dangerousFavorites: [1],
              longshots: [],
              decision: "skip",
              note: "見送り",
            },
          },
        ],
      },
      bet_slips: [],
      result: null,
      reflection: null,
    });

    expect(race.course).toBe("函館");
    expect(race.dataScope).toBe("test");
    expect(race.raceNumber).toBe(11);
    expect(race.startTime).toBe("15:25");
    expect(race.prediction.decision).toBe("skip");
    expect(race.prediction.selectedHorses[0]?.mark).toBe("◎");
    expect(race.prediction.dangerousFavorites).toEqual([1]);
    expect(race.lock.isLocked).toBe(true);
    expect(race.lock.revisions[0]?.summary).toBe("初回予想");
    expect(race.lock.revisions[0]?.snapshot.selectedHorses[0]?.mark).toBe("◎");

    const roundTripEntries = raceToDatabasePayload(race).entries as Array<{
      horse_number: number;
      horse_name: string;
    }>;
    expect(roundTripEntries).toContainEqual({
      horse_number: 8,
      horse_name: "登録だけの馬",
    });
  });

  it("does not replace a known runner name with a generated placeholder", () => {
    const race = {
      ...DEMO_RACE,
      entries: [{ horseNumber: 99, horseName: "リアルホース" }],
      prediction: {
        ...DEMO_RACE.prediction,
        selectedHorses: [
          ...DEMO_RACE.prediction.selectedHorses,
          { horseNumber: 99, horseName: "99番", mark: "△" as const },
        ],
      },
    };

    const entries = raceToDatabasePayload(race).entries as Array<{
      horse_number: number;
      horse_name: string;
    }>;
    expect(entries).toContainEqual({
      horse_number: 99,
      horse_name: "リアルホース",
    });
  });

  it("preserves provisional results and cancelled race status", () => {
    const race = databaseRecordToRace({
      id: "18d13b92-4e17-43e5-8eb5-3e94b70c1c3e",
      meeting: {
        meeting_date: "2026-07-19",
        racecourse: { code: "TOKYO", name_ja: "東京" },
      },
      race: {
        race_number: 9,
        starts_at: "2026-07-19T14:35:00+09:00",
        name: "状態保持テスト",
        status: "cancelled",
      },
      entries: [{ horse_number: 3, horse_name: "テストホース" }],
      prediction: { status: "locked", selections: [], revisions: [] },
      bet_slips: [],
      result: {
        status: "provisional",
        official_at: null,
        finishers: [
          { horse_number: 3, horse_name: "テストホース", finish_position: 1 },
        ],
        payouts: [],
      },
      reflection: null,
    });

    expect(race.status).toBe("cancelled");
    expect(race.result?.status).toBe("provisional");
    const payload = raceToDatabasePayload(race);
    expect((payload.race as { status: string }).status).toBe("cancelled");
    expect((payload.result as { status: string }).status).toBe("provisional");
    expect(payload.result).not.toHaveProperty("official_at");
  });

  it("round-trips a database-derived semantic rule snapshot by version id", () => {
    const ruleVersionId = "28d13b92-4e17-43e5-8eb5-3e94b70c1c3d";
    const race = databaseRecordToRace({
      id: "38d13b92-4e17-43e5-8eb5-3e94b70c1c3d",
      meeting: {
        meeting_date: "2026-07-20",
        racecourse: { code: "HAKODATE", name_ja: "函館" },
      },
      race: {
        race_number: 11,
        starts_at: "2026-07-20T15:25:00+09:00",
        name: "ルール版テスト",
      },
      entries: [],
      prediction: {
        status: "draft",
        rule_version_id: ruleVersionId,
        rule_snapshot: {
          rule_set_name: "期待値ルール · v2.3.0",
          version_number: 1,
          content: "条件A\n条件B",
          parameters: {
            display_name: "期待値ルール",
            semantic_version: "2.3.0",
            rules: ["条件A", "条件B"],
          },
          published_at: "2026-07-18T00:00:00Z",
        },
        selections: [],
        revisions: [],
      },
      bet_slips: [],
      result: null,
      reflection: null,
    });

    expect(race.ruleVersion).toMatchObject({
      id: ruleVersionId,
      name: "期待値ルール",
      version: "2.3.0",
      rules: ["条件A", "条件B"],
    });
    const prediction = raceToDatabasePayload(race).prediction as Record<string, unknown>;
    expect(prediction.rule_version_id).toBe(ruleVersionId);
    expect(prediction).not.toHaveProperty("rule_snapshot");
  });
});

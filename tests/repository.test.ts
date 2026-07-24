import { describe, expect, it } from "vitest";
import { DEMO_RACE } from "../lib/demo-data";
import { exportRace, parseRace } from "../lib/race-format";
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

  it("keeps a post-time-only lock as imported current data, not immutable evidence", () => {
    const payload = raceToDatabasePayload({
      ...DEMO_RACE,
      lock: {
        ...DEMO_RACE.lock,
        isLocked: false,
        lockedAt: null,
        lockedSnapshot: undefined,
        postTimeLockedAt: "2026-07-12T06:45:00.000Z",
      },
    });
    expect(payload.prediction).toMatchObject({
      status: "draft",
      locked_at: null,
      post_time_locked_at: "2026-07-12T06:45:00.000Z",
    });
  });

  it("does not turn the automatic post-time boundary into an explicit lock", () => {
    const race = databaseRecordToRace({
      id: "28d13b92-4e17-43e5-8eb5-3e94b70c1c3d",
      client_key: "post-time-draft",
      meeting: {
        meeting_date: "2026-07-12",
        racecourse: { code: "TOKYO", name_ja: "東京" },
      },
      race: {
        race_number: 11,
        data_scope: "test",
        starts_at: "2026-07-12T15:45:00+09:00",
        name: "発走時刻境界テスト",
      },
      entries: [],
      prediction: {
        status: "draft",
        effective_status: "locked",
        locked_at: null,
        post_time_locked_at: "2026-07-12T06:45:00.000Z",
        selections: [],
        revisions: [],
      },
      bet_slips: [],
      result: null,
      reflection: null,
    });

    expect(race.lock).toMatchObject({
      isLocked: false,
      lockedAt: null,
      postTimeLockedAt: "2026-07-12T06:45:00.000Z",
    });
    expect(race.lock.lockedSnapshot).toBeUndefined();
    expect(raceToDatabasePayload(race).prediction).toMatchObject({
      status: "draft",
      locked_at: null,
      locked_snapshot: null,
    });
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

  it("maps canonical locked evidence back to the immutable client snapshot", () => {
    const race = databaseRecordToRace({
      id: "48d13b92-4e17-43e5-8eb5-3e94b70c1c3d",
      client_key: "locked-client-race",
      meeting: {
        meeting_date: "2026-07-20",
        racecourse: { code: "HAKODATE", name_ja: "函館" },
      },
      race: {
        race_number: 12,
        data_scope: "test",
        starts_at: "2026-07-20T16:05:00+09:00",
        name: "ロック証跡往復",
      },
      entries: [{ horse_number: 4, horse_name: "ノースライト" }],
      prediction: {
        status: "locked",
        effective_status: "locked",
        locked_at: "2026-07-20T06:50:00.000Z",
        selections: [],
        revisions: [],
        locked_snapshot: {
          schema_version: 1,
          race: {
            id: "48d13b92-4e17-43e5-8eb5-3e94b70c1c3d",
            racecourse: { code: "HAKODATE", name_ja: "函館" },
            meeting_date: "2026-07-20",
            race_number: 12,
            starts_at: "2026-07-20T16:05:00+09:00",
            name: "ロック証跡往復",
            data_scope: "demo",
          },
          prediction: {
            rule_version_id: null,
            rule_snapshot: {
              id: "rule-v1",
              name: "ロック用ルール",
              version: "1.0.0",
              rules: ["発走前に固定"],
              createdAt: "2026-07-18T00:00:00.000Z",
              isActive: true,
            },
            pace_scenario: "先行争い",
            track_bias: "内有利",
            decision: "buy",
            summary: "固定済み",
            created_at: "2026-07-20T06:00:00.000Z",
          },
          horse_selections: [
            {
              horse_number: 4,
              horse_name: "ノースライト",
              mark: "honmei",
              is_selected: true,
              is_dangerous_favorite: false,
              is_longshot: true,
              evaluation: "展開向く",
            },
          ],
          proposal_slips: [
            {
              id: "proposal-1",
              client_key: "proposal-1",
              memo: "固定買い目",
              tickets: [
                {
                  bet_type: "win",
                  first_horse_number: 4,
                  stake_yen: 300,
                },
              ],
            },
          ],
        },
      },
      bet_slips: [],
      result: null,
      reflection: null,
    });

    expect(race.lock.lockedSnapshot).toMatchObject({
      schemaVersion: 1,
      race: {
        id: "locked-client-race",
        date: "2026-07-20",
        course: "函館",
        raceNumber: 12,
        startTime: "16:05",
        dataScope: "demo",
      },
      prediction: {
        selectedHorses: [
          { horseNumber: 4, horseName: "ノースライト", mark: "◎" },
        ],
        longshots: [4],
        decision: "buy",
      },
      proposedBets: [{ betType: "win", stakePerPoint: 300 }],
      ruleVersion: { id: "rule-v1", version: "1.0.0" },
      lockedAt: "2026-07-20T06:50:00.000Z",
    });
    const restored = parseRace(exportRace(race));
    expect(restored.lock.lockedSnapshot).toEqual(race.lock.lockedSnapshot);
  });

  it("falls back to the current race scope for a legacy canonical snapshot", () => {
    const race = databaseRecordToRace({
      id: "58d13b92-4e17-43e5-8eb5-3e94b70c1c3d",
      client_key: "legacy-locked-client-race",
      meeting: {
        meeting_date: "2026-07-21",
        racecourse: { code: "HAKODATE", name_ja: "函館" },
      },
      race: {
        race_number: 10,
        data_scope: "test",
        starts_at: "2026-07-21T15:30:00+09:00",
        name: "旧ロックスナップショット",
      },
      entries: [],
      prediction: {
        status: "locked",
        effective_status: "locked",
        locked_at: "2026-07-21T06:20:00.000Z",
        selections: [],
        revisions: [],
        locked_snapshot: {
          schema_version: 1,
          race: {
            id: "58d13b92-4e17-43e5-8eb5-3e94b70c1c3d",
            racecourse: { code: "HAKODATE", name_ja: "函館" },
            meeting_date: "2026-07-21",
            race_number: 10,
            starts_at: "2026-07-21T15:30:00+09:00",
            name: "旧ロックスナップショット",
          },
          prediction: {},
          horse_selections: [],
          proposal_slips: [],
        },
      },
      bet_slips: [],
      result: null,
      reflection: null,
    });

    expect(race.lock.lockedSnapshot?.race.dataScope).toBe("test");
  });
});

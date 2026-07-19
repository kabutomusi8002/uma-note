import { describe, expect, it } from "vitest";
import {
  RACE_BLOCK_END,
  RACE_FORMAT_SPECIFICATION,
  RaceFormatError,
  exportRace,
  exportRaces,
  parseRace,
  parseRaces,
  validateRaceRecord,
} from "../lib/race-format";
import {
  DEMO_RACE,
  DEMO_RACE_IDS,
  DEMO_RACES,
  DEMO_UPCOMING_RACE,
  createDemoRace,
  createDemoRaces,
} from "../lib/demo-data";
import { lockRacePrediction } from "../lib/prediction-lock";
import { normalizeKnownDemoRaceScopes } from "../lib/race-scope";

describe("RACE/1 round trip", () => {
  it("全フィールドを失わず1レースを往復する", () => {
    const exported = exportRace(DEMO_RACE);

    expect(exported).toMatch(/^---RACE---\nFORMAT_VERSION: 1/);
    expect(exported).toContain('DATA_SCOPE: "demo"');
    expect(exported.endsWith(RACE_BLOCK_END)).toBe(true);
    expect(parseRace(exported)).toEqual(DEMO_RACE);
  });

  it("test区分を保持し、区分のない旧データも読み込める", () => {
    const testRace = { ...createDemoRace(), dataScope: "test" as const };
    expect(parseRace(exportRace(testRace)).dataScope).toBe("test");

    const legacyRace = createDemoRace();
    delete legacyRace.dataScope;
    const parsedLegacy = parseRace(exportRace(legacyRace));
    expect(parsedLegacy.dataScope).toBeUndefined();
  });

  it("区分のない既知デモの旧バックアップを取り込み時にdemoへ正規化する", () => {
    const legacyDemo = createDemoRace();
    delete legacyDemo.dataScope;

    const imported = parseRaces(exportRace(legacyDemo));
    expect(normalizeKnownDemoRaceScopes(imported, DEMO_RACE_IDS)[0].dataScope).toBe("demo");
  });

  it("live・demo・testが混在するバックアップを区分ごと往復する", () => {
    const mixedScopes = (["live", "demo", "test"] as const).map(
      (dataScope, index) => ({
        ...createDemoRace(),
        id: `race-scope-${index + 1}`,
        dataScope,
      }),
    );

    expect(parseRaces(exportRaces(mixedScopes))).toEqual(mixedScopes);
  });

  it("レース状態・出走馬一覧・発走時刻ロックを失わず往復する", () => {
    const race = createDemoRace();
    race.status = "closed";
    race.entries = [
      { horseNumber: 1, horseName: "未選出ホース" },
      { horseNumber: 2, horseName: "サクラフェザー" },
    ];
    race.lock.postTimeLockedAt = "2026-07-12T06:45:00.000Z";

    const exported = exportRace(race);

    expect(exported).toContain('\nSTATUS: "closed"');
    expect(exported).toContain(
      '\nENTRIES: [{"horseNumber":1,"horseName":"未選出ホース"}',
    );
    expect(exported).toContain(
      '"postTimeLockedAt":"2026-07-12T06:45:00.000Z"',
    );
    expect(parseRace(exported)).toEqual(race);
  });

  it("独立した発走前ロックスナップショットを往復する", () => {
    const locked = lockRacePrediction(structuredClone(DEMO_UPCOMING_RACE), {
      revisionId: "backup-lock-revision",
      changedAt: "2026-07-19T06:20:00.000Z",
      lockedAt: "2026-07-19T06:20:01.000Z",
    });

    const restored = parseRace(exportRace(locked));
    expect(restored.lock.lockedSnapshot).toEqual(
      locked.lock.lockedSnapshot,
    );
    expect(restored.lock.lockedSnapshot?.proposedBets).toEqual(
      locked.proposedBets,
    );
  });

  it("任意拡張のない従来RACE/1文書も同じ既定値で読み込む", () => {
    const legacyRace = createDemoRace();
    delete legacyRace.status;
    delete legacyRace.entries;
    delete legacyRace.lock.postTimeLockedAt;

    const exported = exportRace(legacyRace);

    expect(exported).not.toMatch(/^STATUS:/m);
    expect(exported).not.toMatch(/^ENTRIES:/m);
    expect(exported).not.toContain("postTimeLockedAt");
    expect(parseRace(exported)).toEqual(legacyRace);
  });

  it("改行・引用符・日本語をJSON文字列として安全に往復する", () => {
    const race = createDemoRace();
    race.prediction.note = '1行目 "引用"\n2行目：日本語';
    race.reflection = {
      categories: ["other"],
      note: "検証\n完了",
    };

    const exported = exportRace(race);
    expect(exported).toContain('1行目 \\"引用\\"\\n2行目：日本語');
    expect(parseRace(exported)).toEqual(race);
  });

  it("複数レースとCRLF、空行、コメントを読み込む", () => {
    const exported = `# RACE/1 backup\r\n\r\n${exportRaces(DEMO_RACES).replace(
      /\n/g,
      "\r\n",
    )}\r\n# end`;

    expect(parseRaces(exported)).toEqual(DEMO_RACES);
    expect(() => parseRace(exported)).toThrow(/1レースだけ/);
  });

  it("デモデータのコピーは呼び出しごとに独立している", () => {
    const first = createDemoRaces();
    const second = createDemoRaces();
    first[0].prediction.note = "変更";
    expect(second[0].prediction.note).not.toBe("変更");
  });

  it("公開仕様に境界行とJSON値ルールを記載する", () => {
    expect(RACE_FORMAT_SPECIFICATION).toContain("---RACE---");
    expect(RACE_FORMAT_SPECIFICATION).toContain("JSON値");
  });
});

describe("RACE/1 invalid input", () => {
  it("レースがない場合は空のバックアップを書き出さない", () => {
    expect(() => exportRaces([])).toThrow(/エクスポートするレースがありません/);
  });

  it("必須キー不足をキー名と行番号つきで報告する", () => {
    const invalid = exportRace(DEMO_RACE)
      .split("\n")
      .filter((line) => !line.startsWith("COURSE:"))
      .join("\n");

    expect(() => parseRace(invalid)).toThrow(RaceFormatError);
    expect(() => parseRace(invalid)).toThrow(/1行目.*COURSE/);
  });

  it("壊れたJSONを項目名と行番号つきで報告する", () => {
    const invalid = exportRace(DEMO_RACE).replace(
      /DATE: .*/,
      "DATE: 2026-07-12",
    );

    expect(() => parseRace(invalid)).toThrow(/DATE のJSONが不正/);
    expect(() => parseRace(invalid)).toThrow(/4行目/);
  });

  it("重複キーを拒否する", () => {
    const invalid = exportRace(DEMO_RACE).replace(
      "ID: ",
      'ID: "duplicate"\nID: ',
    );
    expect(() => parseRace(invalid)).toThrow(/ID が重複/);
  });

  it("複数ブロック内の同一レースIDを拒否する", () => {
    const block = exportRace(DEMO_RACE);

    expect(() => exportRaces([DEMO_RACE, DEMO_RACE])).toThrow(
      /レースID .* が重複/,
    );
    expect(() => parseRaces(`${block}\n\n${block}`)).toThrow(
      /レースID .* が重複/,
    );
  });

  it("未定義キーを拒否する", () => {
    const invalid = exportRace(DEMO_RACE).replace(
      "FORMAT_VERSION: 1",
      "FORMAT_VERSION: 1\nUNKNOWN: true",
    );
    expect(() => parseRace(invalid)).toThrow(/未定義のキー.*UNKNOWN/);
  });

  it("未定義の収支区分を拒否する", () => {
    const invalid = exportRace(DEMO_RACE).replace(
      'DATA_SCOPE: "demo"',
      'DATA_SCOPE: "invalid"',
    );

    expect(() => parseRace(invalid)).toThrow(/race\.dataScope/);
  });

  it("未対応バージョンを拒否する", () => {
    const invalid = exportRace(DEMO_RACE).replace(
      "FORMAT_VERSION: 1",
      "FORMAT_VERSION: 2",
    );
    expect(() => parseRace(invalid)).toThrow(/FORMAT_VERSION は 1/);
  });

  it("終了境界がない入力を拒否する", () => {
    const invalid = exportRace(DEMO_RACE).replace(`\n${RACE_BLOCK_END}`, "");
    expect(() => parseRace(invalid)).toThrow(/---END RACE--- がありません/);
  });

  it("レースブロックのない入力を拒否する", () => {
    expect(() => parseRaces("# comment only\n\n")).toThrow(
      /レースブロックがありません/,
    );
  });

  it("意味的に不正な時刻を明確なフィールド名で拒否する", () => {
    const invalid = exportRace(DEMO_RACE).replace(
      'START_TIME: "15:45"',
      'START_TIME: "25:99"',
    );
    expect(() => parseRace(invalid)).toThrow(/race.startTime.*HH:mm/);
  });

  it("不正な買い目をエクスポート時にも拒否する", () => {
    const invalid = createDemoRace();
    invalid.purchasedBets[0].stakePerPoint = 150;
    expect(() => exportRace(invalid)).toThrow(/100円単位/);
  });

  it("任意のレース状態と出走馬一覧も厳格に検証する", () => {
    const invalidStatus = {
      ...createDemoRace(),
      status: "archived",
    };
    expect(() => validateRaceRecord(invalidStatus)).toThrow(/race.status/);

    const duplicateEntries = createDemoRace();
    duplicateEntries.entries = [
      { horseNumber: 2, horseName: "サクラフェザー" },
      { horseNumber: 2, horseName: "別名" },
    ];
    expect(() => exportRace(duplicateEntries)).toThrow(/race.entries.*重複/);
  });

  it("validateRaceRecordで外部入力を正規化・検証できる", () => {
    expect(validateRaceRecord(DEMO_RACE)).toEqual(DEMO_RACE);
    expect(() =>
      validateRaceRecord({ ...DEMO_RACE, date: "2026-02-30" }),
    ).toThrow(/実在する日付/);
  });
});

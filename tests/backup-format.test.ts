import { describe, expect, it } from "vitest";
import { createDemoRace } from "../lib/demo-data";
import { upgradeLegacyPredictionLock } from "../lib/prediction-lock";
import type { PredictionRuleVersion } from "../lib/types";
import {
  BackupFormatError,
  EMPTY_RACE_DOCUMENT,
  LOCAL_BACKUP_FORMAT,
  canonicalJson,
  createLocalBackup,
  parseLocalBackup,
  sha256Hex,
} from "../lib/sync/backup-format";

const ACTIVE_RULE: PredictionRuleVersion = {
  id: "active-rule",
  name: "現行ルール",
  version: "2.0.0",
  rules: ["期待値を確認する"],
  createdAt: "2026-07-01T00:00:00.000Z",
  isActive: true,
};

const UNUSED_RULE: PredictionRuleVersion = {
  id: "unused-rule",
  name: "旧ルール",
  version: "1.0.0",
  rules: ["旧基準"],
  createdAt: "2026-06-01T00:00:00.000Z",
  note: "現在は未使用",
  isActive: false,
};

describe("UMA_NOTE_BACKUP/1", () => {
  it("RACE/1、未使用ルール、activeRule、settingsを完全に往復する", async () => {
    const race = { ...createDemoRace(), dataScope: "live" as const };
    const backup = await createLocalBackup({
      races: [race],
      rules: [ACTIVE_RULE, UNUSED_RULE],
      activeRuleId: ACTIVE_RULE.id,
      settings: {
        timezone: "Asia/Tokyo",
        defaultStakePerPoint: 200,
        nested: { enabled: true },
      },
      createdAt: "2026-07-18T00:00:00.000Z",
    });

    expect(backup.text).toContain(LOCAL_BACKUP_FORMAT);
    expect(backup.text).toContain("---RACE---");
    expect(backup.sha256).toMatch(/^[0-9a-f]{64}$/);

    const parsed = await parseLocalBackup(backup.text);
    expect(parsed.races).toEqual([upgradeLegacyPredictionLock(race)]);
    expect(parsed.rules).toEqual([ACTIVE_RULE, UNUSED_RULE]);
    expect(parsed.activeRuleId).toBe(ACTIVE_RULE.id);
    expect(parsed.settings).toEqual({
      defaultStakePerPoint: 200,
      nested: { enabled: true },
      timezone: "Asia/Tokyo",
    });
    expect(parsed.sha256).toBe(backup.sha256);
  });

  it("v0.1.1の旧ロックを移行前バックアップで完全snapshotへ昇格する", async () => {
    const legacyRace = createDemoRace();
    expect(legacyRace.lock.isLocked).toBe(true);
    expect(legacyRace.lock.lockedSnapshot).toBeUndefined();

    const backup = await createLocalBackup({
      races: [legacyRace],
      rules: [ACTIVE_RULE],
      createdAt: "2026-07-18T00:00:00.000Z",
    });

    expect(backup.races[0]?.lock.lockedSnapshot).toMatchObject({
      provenance: "legacy_local_upgrade",
      lockedAt: legacyRace.lock.lockedAt,
      prediction: legacyRace.prediction,
      proposedBets: legacyRace.proposedBets,
    });
    expect(backup.content.raceDocument).toContain(
      '"provenance":"legacy_local_upgrade"',
    );
  });

  it("preserves the lock-time scope through backup and restore", async () => {
    const locked = upgradeLegacyPredictionLock(createDemoRace());
    const lockTimeScope = locked.lock.lockedSnapshot?.race.dataScope;
    const current = { ...locked, dataScope: "test" as const };
    const backup = await createLocalBackup({
      races: [current],
      rules: [ACTIVE_RULE],
      createdAt: "2026-07-18T00:00:00.000Z",
    });

    const restored = await parseLocalBackup(backup.text);
    expect(restored.races[0]?.dataScope).toBe("test");
    expect(
      restored.races[0]?.lock.lockedSnapshot?.race.dataScope,
    ).toBe(lockTimeScope);
  });

  it("オブジェクトのキー挿入順に依存しないcanonical JSONとハッシュを作る", async () => {
    const left = await createLocalBackup({
      races: [createDemoRace()],
      rules: [ACTIVE_RULE],
      settings: { z: 1, nested: { b: 2, a: 1 }, a: 2 },
      createdAt: "2026-07-18T00:00:00.000Z",
    });
    const right = await createLocalBackup({
      races: [createDemoRace()],
      rules: [ACTIVE_RULE],
      settings: { a: 2, nested: { a: 1, b: 2 }, z: 1 },
      createdAt: "2026-07-18T00:00:00.000Z",
    });

    expect(canonicalJson({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
    expect(left.sha256).toBe(right.sha256);
    expect(left.text).toBe(right.text);
    await expect(sha256Hex("uma-note")).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it("内容が変更されたバックアップをchecksumで拒否する", async () => {
    const backup = await createLocalBackup({
      races: [createDemoRace()],
      rules: [ACTIVE_RULE],
      createdAt: "2026-07-18T00:00:00.000Z",
    });
    const tampered = JSON.parse(backup.text) as Record<string, unknown>;
    tampered.raceDocument = `${String(tampered.raceDocument)}\n# tampered`;

    await expect(parseLocalBackup(JSON.stringify(tampered))).rejects.toThrow(
      /checksum/i,
    );
  });

  it("未収録のactiveRuleと未対応formatを拒否する", async () => {
    await expect(
      createLocalBackup({
        races: [createDemoRace()],
        rules: [UNUSED_RULE],
        activeRuleId: "missing-rule",
      }),
    ).rejects.toThrow(/not included/);

    await expect(
      parseLocalBackup(
        JSON.stringify({
          format: "UMA_NOTE_BACKUP/2",
          createdAt: "2026-07-18T00:00:00.000Z",
          raceFormat: "RACE/1",
          raceDocument: EMPTY_RACE_DOCUMENT,
          rules: [],
          activeRuleId: null,
          settings: {},
          sha256: "0".repeat(64),
        }),
      ),
    ).rejects.toThrow(BackupFormatError);
  });

  it("レースが0件でもルールと設定の安全バックアップを作れる", async () => {
    const backup = await createLocalBackup({
      races: [],
      rules: [ACTIVE_RULE, UNUSED_RULE],
      settings: { defaultDataScope: "live" },
      createdAt: "2026-07-18T00:00:00.000Z",
    });
    const parsed = await parseLocalBackup(backup.text);

    expect(parsed.races).toEqual([]);
    expect(parsed.content.raceDocument).toBe(EMPTY_RACE_DOCUMENT);
    expect(parsed.rules).toHaveLength(2);
  });
});

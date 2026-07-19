import { describe, expect, it } from "vitest";
import { createDemoRace, createDemoRaces } from "../lib/demo-data";
import type { RaceRecord } from "../lib/types";
import {
  buildMigrationPlan,
  canConfirmMigration,
  migrationConfirmationIssues,
  migrationConfirmationText,
} from "../lib/sync/migration-plan";

function liveUpcoming(): RaceRecord {
  return {
    ...createDemoRaces()[0],
    id: "local-upcoming",
    dataScope: "live",
  };
}

describe("migration preview", () => {
  it("liveだけを既定選択し、demo/testのscopeを保持して除外する", async () => {
    const live = liveUpcoming();
    const demo = { ...liveUpcoming(), id: "demo", raceNumber: 10, dataScope: "demo" as const };
    const test = { ...liveUpcoming(), id: "test", raceNumber: 9, dataScope: "test" as const };

    const plan = await buildMigrationPlan({
      localRaces: [test, live, demo],
      cloudRaces: [],
    });

    expect(plan.scopeSelection).toEqual({ live: true, demo: false, test: false });
    expect(plan.items.map(({ sourceId, dataScope, action, selected }) => ({
      sourceId,
      dataScope,
      action,
      selected,
    }))).toEqual([
      { sourceId: "test", dataScope: "test", action: "excluded", selected: false },
      { sourceId: "demo", dataScope: "demo", action: "excluded", selected: false },
      { sourceId: "local-upcoming", dataScope: "live", action: "create", selected: true },
    ]);

    const withDemo = await buildMigrationPlan({
      localRaces: [demo],
      cloudRaces: [],
      includeScopes: { demo: true },
    });
    expect(withDemo.items[0]).toMatchObject({ dataScope: "demo", action: "create" });
  });

  it("IDや保存時刻だけが違う同一自然キーをidenticalと判定する", async () => {
    const local = { ...createDemoRace(), dataScope: "live" as const };
    const cloud = structuredClone(local);
    cloud.id = "cloud-id";
    cloud.createdAt = "2026-07-12T04:10:00.000Z";
    cloud.updatedAt = "2026-07-18T00:00:00.000Z";
    cloud.proposedBets[0].id = "cloud-proposal-id";
    cloud.lock.revisions[0].id = "cloud-revision-id";
    if (cloud.ruleVersion) cloud.ruleVersion.id = "cloud-rule-id";

    const plan = await buildMigrationPlan({ localRaces: [local], cloudRaces: [cloud] });

    expect(plan.items[0]).toMatchObject({
      action: "identical",
      reason: "same-content",
      cloudRace: cloud,
    });
  });

  it("BOXと同じ具体的な通常買い目を意味的に同一とみなす", async () => {
    const local = liveUpcoming();
    const cloud = structuredClone(local);
    cloud.id = "cloud-upcoming";
    cloud.proposedBets = [
      {
        id: "expanded",
        betType: "wide",
        selection: {
          method: "normal",
          combinations: [
            [4, 6], [4, 11], [4, 13], [6, 11], [6, 13], [11, 13],
          ],
        },
        stakePerPoint: 100,
      },
    ];

    const plan = await buildMigrationPlan({ localRaces: [local], cloudRaces: [cloud] });
    expect(plan.items[0].action).toBe("identical");
  });

  it("base/local/cloudの三者を比較して両側変更をconflictにする", async () => {
    const base = liveUpcoming();
    const local = structuredClone(base);
    const cloud = structuredClone(base);
    local.prediction.note = "local edit";
    cloud.id = "cloud-upcoming";
    cloud.prediction.trackView = "cloud edit";

    const plan = await buildMigrationPlan({
      localRaces: [local],
      cloudRaces: [cloud],
      baseRaces: [base],
    });

    expect(plan.items[0]).toMatchObject({
      action: "conflict",
      reason: "both-changed",
      localChangedSinceBase: true,
      cloudChangedSinceBase: true,
    });
  });

  it("cloudから消えたbaseレースとロック済みcloudを保護する", async () => {
    const deleted = liveUpcoming();
    const deletedPlan = await buildMigrationPlan({
      localRaces: [deleted],
      cloudRaces: [],
      baseRaces: [structuredClone(deleted)],
    });
    expect(deletedPlan.items[0]).toMatchObject({
      action: "conflict",
      reason: "cloud-deleted",
    });

    const local = { ...createDemoRace(), dataScope: "live" as const };
    local.prediction.note = "replace request";
    const cloud = { ...createDemoRace(), id: "cloud-locked", dataScope: "live" as const };
    const immutablePlan = await buildMigrationPlan({
      localRaces: [local],
      cloudRaces: [cloud],
    });
    expect(immutablePlan.items[0]).toMatchObject({
      action: "immutable",
      reason: "cloud-immutable",
      selected: false,
    });
  });

  it("record hashとplan hashで同じ移行の再適用を冪等に止める", async () => {
    const local = liveUpcoming();
    const first = await buildMigrationPlan({
      localRaces: [local],
      cloudRaces: [],
      backupHash: "backup-123",
    });
    const same = await buildMigrationPlan({
      localRaces: [structuredClone(local)],
      cloudRaces: [],
      backupHash: "backup-123",
    });
    expect(first.hash).toBe(same.hash);
    expect(first.items[0].action).toBe("create");

    const replay = await buildMigrationPlan({
      localRaces: [local],
      cloudRaces: [],
      backupHash: "backup-123",
      appliedRecordHashes: [first.items[0].recordHash],
    });
    expect(replay.items[0]).toMatchObject({
      action: "identical",
      reason: "already-applied",
      selected: false,
    });
  });

  it("backup・preview・選択・明示文言が揃った時だけconfirmできる", async () => {
    const plan = await buildMigrationPlan({
      localRaces: [liveUpcoming()],
      cloudRaces: [],
      backupHash: "backup-123",
    });
    const confirmation = {
      planHash: plan.hash,
      backupSaved: true,
      backupHash: "backup-123",
      previewReviewed: true,
      selectedSourceIds: ["local-upcoming"],
      confirmationText: migrationConfirmationText(1),
    } as const;

    expect(canConfirmMigration(plan, confirmation)).toBe(true);
    expect(
      migrationConfirmationIssues(plan, {
        ...confirmation,
        confirmationText: "移行する",
      }),
    ).toContain("confirmation text does not match the selected count");
    expect(canConfirmMigration(plan, { ...confirmation, backupSaved: false })).toBe(false);
  });

  it("ルールまたは設定だけを選んだ移行も明示確認できる", async () => {
    const plan = await buildMigrationPlan({
      localRaces: [],
      cloudRaces: [],
      backupHash: "backup-extra-only",
    });

    expect(canConfirmMigration(plan, {
      planHash: plan.hash,
      backupSaved: true,
      backupHash: "backup-extra-only",
      previewReviewed: true,
      selectedSourceIds: [],
      selectedAdditionalCount: 1,
      confirmationText: migrationConfirmationText(1),
    })).toBe(true);
    expect(canConfirmMigration(plan, {
      planHash: plan.hash,
      backupSaved: true,
      backupHash: "backup-extra-only",
      previewReviewed: true,
      selectedSourceIds: [],
      selectedAdditionalCount: 0,
      confirmationText: migrationConfirmationText(0),
    })).toBe(false);
  });

  it("IDが違う同一自然キーレースを移行前に拒否する", async () => {
    const first = liveUpcoming();
    const duplicate = { ...liveUpcoming(), id: "other-id" };
    await expect(
      buildMigrationPlan({ localRaces: [first, duplicate], cloudRaces: [] }),
    ).rejects.toThrow(/Duplicate race natural keys/);
  });
});

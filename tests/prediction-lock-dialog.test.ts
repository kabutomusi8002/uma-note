import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEMO_UPCOMING_RACE } from "../lib/demo-data";
import {
  lockRacePrediction,
  upgradeLegacyPredictionLock,
} from "../lib/prediction-lock";

describe("prediction lock", () => {
  it("locks the prediction and appends an immutable final snapshot", () => {
    const original = structuredClone(DEMO_UPCOMING_RACE);
    const originalNote = original.prediction.note;
    const locked = lockRacePrediction(original, {
      revisionId: "revision-final",
      changedAt: "2026-07-19T06:20:00.000Z",
      lockedAt: "2026-07-19T06:20:01.000Z",
    });

    expect(locked.lock.isLocked).toBe(true);
    expect(locked.lock.lockedAt).toBe("2026-07-19T06:20:01.000Z");
    expect(locked.lock.revisions).toHaveLength(original.lock.revisions.length + 1);
    expect(locked.lock.revisions.at(-1)).toMatchObject({
      id: "revision-final",
      revision: original.lock.revisions.length + 1,
      changedAt: "2026-07-19T06:20:00.000Z",
      summary: "発走前の最終予想をロック",
      snapshot: original.prediction,
    });
    expect(locked.lock.lockedSnapshot).toEqual({
      schemaVersion: 1,
      provenance: "explicit_lock",
      race: {
        id: original.id,
        dataScope: original.dataScope,
        date: original.date,
        course: original.course,
        raceNumber: original.raceNumber,
        startTime: original.startTime,
        name: original.name,
      },
      prediction: original.prediction,
      proposedBets: original.proposedBets,
      ruleVersion: original.ruleVersion,
      lockedAt: "2026-07-19T06:20:01.000Z",
    });

    locked.prediction.note = "ロック後に別オブジェクト側だけ変更";
    locked.proposedBets.length = 0;
    expect(locked.lock.revisions.at(-1)?.snapshot.note).toBe(originalNote);
    expect(locked.lock.lockedSnapshot?.prediction.note).toBe(originalNote);
    expect(locked.lock.lockedSnapshot?.proposedBets).toEqual(
      original.proposedBets,
    );
  });

  it("upgrades a v0.1.1 lock into source-labelled immutable evidence", () => {
    const legacy = structuredClone(DEMO_UPCOMING_RACE);
    legacy.lock = {
      isLocked: true,
      lockedAt: "2026-07-19T06:20:01.000Z",
      revisions: [],
    };
    delete legacy.dataScope;

    const upgraded = upgradeLegacyPredictionLock(legacy);

    expect(upgraded.lock.lockedSnapshot).toMatchObject({
      schemaVersion: 1,
      provenance: "legacy_local_upgrade",
      race: { id: legacy.id, dataScope: "live" },
      prediction: legacy.prediction,
      proposedBets: legacy.proposedBets,
      lockedAt: legacy.lock.lockedAt,
    });
    legacy.prediction.note = "元オブジェクトだけ変更";
    expect(upgraded.lock.lockedSnapshot?.prediction.note).not.toBe(
      legacy.prediction.note,
    );
    expect(upgradeLegacyPredictionLock(upgraded)).toBe(upgraded);
  });

  it("uses an accessible in-app confirmation dialog instead of window.confirm", () => {
    const sourcePath = fileURLToPath(
      new URL("../app/components/uma-note-app.tsx", import.meta.url),
    );
    const source = readFileSync(sourcePath, "utf8");

    expect(source).not.toContain("window.confirm");
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain('aria-labelledby="lock-dialog-title"');
    expect(source).toContain('aria-describedby="lock-dialog-description"');
    expect(source).toContain("キャンセル");
    expect(source).toContain("予想をロック");
  });
});

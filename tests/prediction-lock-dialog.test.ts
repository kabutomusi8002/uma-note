import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEMO_UPCOMING_RACE } from "../lib/demo-data";
import { lockRacePrediction } from "../lib/prediction-lock";

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

    locked.prediction.note = "ロック後に別オブジェクト側だけ変更";
    expect(locked.lock.revisions.at(-1)?.snapshot.note).toBe(originalNote);
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

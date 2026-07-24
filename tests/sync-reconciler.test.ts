import { describe, expect, it } from "vitest";
import { createOutboxMutation } from "../lib/sync/outbox";
import { createSyncConflict, reconcileEntity } from "../lib/sync/reconciler";

describe("three-way reconciliation", () => {
  it("merges disjoint object edits", () => {
    const base = {
      name: "Race",
      prediction: { note: "base", paceScenario: "middle" },
    };
    const local = {
      name: "Race",
      prediction: { note: "local note", paceScenario: "middle" },
    };
    const remote = {
      name: "Renamed race",
      prediction: { note: "base", paceScenario: "middle" },
    };

    expect(reconcileEntity(base, local, remote)).toEqual({
      kind: "merged",
      value: {
        name: "Renamed race",
        prediction: { note: "local note", paceScenario: "middle" },
      },
      conflicts: [],
    });
  });

  it("does not expose a persistable value for the same-field conflict", () => {
    const result = reconcileEntity(
      { prediction: { note: "base" } },
      { prediction: { note: "phone" } },
      { prediction: { note: "desktop" } },
    );

    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") throw new Error("Expected a conflict");
    expect(result.conflicts).toEqual([
      {
        path: "/prediction/note",
        base: "base",
        local: "phone",
        remote: "desktop",
      },
    ]);
    expect(result).not.toHaveProperty("value");
  });

  it("treats both-side locked snapshot edits as atomic", () => {
    const base = { lock: { isLocked: true, lockedAt: "10:00", revisions: [] } };
    const local = { lock: { isLocked: true, lockedAt: "10:00", revisions: ["phone"] } };
    const remote = { lock: { isLocked: true, lockedAt: "10:01", revisions: [] } };
    const result = reconcileEntity(base, local, remote);

    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      expect(result.conflicts.map((field) => field.path)).toEqual(["/lock"]);
    }
  });

  it("recognizes when only local or only remote changed", () => {
    expect(reconcileEntity({ a: 1 }, { a: 2 }, { a: 1 })).toMatchObject({
      kind: "local",
      value: { a: 2 },
    });
    expect(reconcileEntity({ a: 1 }, { a: 1 }, { a: 2 })).toMatchObject({
      kind: "remote",
      value: { a: 2 },
    });
  });

  it("handles the same property deletion on both devices", () => {
    expect(reconcileEntity({ note: "base" }, {}, {})).toEqual({
      kind: "equal",
      value: {},
      conflicts: [],
    });
  });

  it("creates a durable unresolved conflict from a version mismatch", () => {
    const mutation = createOutboxMutation(
      {
        ownerScope: "user:user-a",
        entityType: "race",
        entityKey: "race-a",
        payload: { note: "phone" },
        baseSnapshot: { note: "base" },
        expectedVersion: 7,
        expectedParentVersion: 11,
      },
      {
        now: () => new Date("2026-07-18T00:00:00.000Z"),
        randomUUID: () => "mutation-a",
      },
    );
    const conflict = createSyncConflict(
      mutation,
      { note: "desktop" },
      8,
      new Date("2026-07-18T00:01:00.000Z"),
      12,
    );

    expect(conflict).toMatchObject({
      conflictId: "user:user-a:race:race-a:mutation-a",
      mutationId: "mutation-a",
      expectedVersion: 7,
      expectedParentVersion: 11,
      remoteVersion: 8,
      remoteParentVersion: 12,
      reconciliation: "conflict",
      status: "unresolved",
    });
    expect(conflict.fields[0]?.path).toBe("/note");
  });
});

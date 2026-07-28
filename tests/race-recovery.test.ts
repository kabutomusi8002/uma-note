import { describe, expect, it } from "vitest";

import { createDemoRace } from "../lib/demo-data";
import {
  prepareAppliedRaceRecovery,
  prepareRaceConflictResolution,
  raceNameIsOnlyDifference,
  type CloudRaceState,
} from "../lib/sync/race-recovery";
import { createOutboxMutation } from "../lib/sync/outbox";
import type {
  OwnerScope,
  SyncConflict,
  WorkspaceSnapshot,
} from "../lib/sync/types";
import type { RaceRecord } from "../lib/types";

const OWNER: OwnerScope = "user:recovery-user";
const CLIENT_KEY = "stable-race-client-key";

function race(name: string): RaceRecord {
  return {
    ...createDemoRace(),
    id: "local-race-id",
    clientKey: CLIENT_KEY,
    dataScope: "test",
    date: "2026-07-26",
    course: "NAKAYAMA",
    raceNumber: 12,
    name,
    status: "scheduled",
    entries: [],
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
  };
}

function workspace(local: RaceRecord): WorkspaceSnapshot {
  return {
    ownerScope: OWNER,
    races: [local],
    rules: [],
    settings: { activeRaceId: local.id },
    updatedAt: "2026-07-26T00:00:00.000Z",
  };
}

function original(payload: RaceRecord) {
  return {
    ...createOutboxMutation(
      {
        ownerScope: OWNER,
        entityType: "race",
        entityKey: CLIENT_KEY,
        payload,
        expectedVersion: 0,
      },
      { randomUUID: () => "original-mutation" },
    ),
    status: "conflict" as const,
  };
}

function cloud(value: RaceRecord): CloudRaceState {
  return {
    cloudId: "cloud-race-uuid",
    clientKey: CLIENT_KEY,
    version: 3,
    race: {
      ...value,
      id: CLIENT_KEY,
      cloudId: "cloud-race-uuid",
      syncVersion: 3,
    },
  };
}

function conflict(
  mutationId: string,
  local: RaceRecord,
  remote: RaceRecord,
): SyncConflict {
  return {
    conflictId: "race-name-conflict",
    mutationId,
    ownerScope: OWNER,
    entityType: "race",
    entityKey: CLIENT_KEY,
    expectedVersion: 0,
    remoteVersion: 3,
    baseSnapshot: null,
    localSnapshot: local,
    remoteSnapshot: remote,
    reconciliation: "conflict",
    fields: [{
      path: "/name",
      base: null,
      local: local.name,
      remote: remote.name,
    }],
    status: "unresolved",
    createdAt: "2026-07-26T00:00:00.000Z",
  };
}

describe("safe race sync recovery", () => {
  it("persists cloud identity/version and creates one fresh successor for a later name edit", () => {
    const sent = race("sent name");
    const current = { ...sent, name: "current local name" };
    const mutation = original(sent);

    const prepared = prepareAppliedRaceRecovery({
      workspace: workspace(current),
      original: mutation,
      cloud: cloud(sent),
      receiptVerified: true,
      now: new Date("2026-07-26T01:00:00.000Z"),
      randomUUID: () => "fresh-successor",
    });

    expect(prepared.nameChanged).toBe(true);
    expect(prepared.workspace.races[0]).toMatchObject({
      name: "current local name",
      clientKey: CLIENT_KEY,
      cloudId: "cloud-race-uuid",
      syncVersion: 3,
      dataScope: "test",
    });
    expect(prepared.successor).toMatchObject({
      mutationId: "fresh-successor",
      predecessorMutationId: mutation.mutationId,
      entityKey: CLIENT_KEY,
      expectedVersion: 3,
      status: "pending",
    });
    expect(
      (prepared.workspace.settings.cloudSync as {
        versions: Record<string, number>;
      }).versions[`race:${CLIENT_KEY}`],
    ).toBe(3);
  });

  it("requires a receipt before retiring an applied mutation", () => {
    const sent = race("sent");
    expect(() =>
      prepareAppliedRaceRecovery({
        workspace: workspace(sent),
        original: original(sent),
        cloud: cloud(sent),
        receiptVerified: false,
      })
    ).toThrow("receipt");
  });

  it("rejects recovery when a non-name field changed", () => {
    const sent = race("sent");
    const changed = { ...sent, raceNumber: 11, name: "current" };
    expect(() =>
      prepareAppliedRaceRecovery({
        workspace: workspace(changed),
        original: original(sent),
        cloud: cloud(sent),
        receiptVerified: true,
      })
    ).toThrow("natural key");
  });

  it("cloud choice adopts only the cloud name and creates no successor", () => {
    const local = race("local name");
    const remote = race("cloud name");
    const mutation = original(local);
    const prepared = prepareRaceConflictResolution({
      workspace: workspace(local),
      original: mutation,
      conflict: conflict(mutation.mutationId, local, remote),
      cloud: cloud(remote),
      choice: "cloud",
      now: new Date("2026-07-26T01:00:00.000Z"),
    });

    expect(prepared.workspace.races[0]).toMatchObject({
      name: "cloud name",
      cloudId: "cloud-race-uuid",
      syncVersion: 3,
      dataScope: "test",
    });
    expect(prepared.successor).toBeNull();
    expect(prepared.resolvedConflict).toMatchObject({
      status: "resolved",
      resolution: "remote",
    });
  });

  it("local choice keeps the local name and creates a versioned successor", () => {
    const local = race("local name");
    const remote = race("cloud name");
    const mutation = original(local);
    const prepared = prepareRaceConflictResolution({
      workspace: workspace(local),
      original: mutation,
      conflict: conflict(mutation.mutationId, local, remote),
      cloud: cloud(remote),
      choice: "local",
      now: new Date("2026-07-26T01:00:00.000Z"),
      randomUUID: () => "local-successor",
    });

    expect(prepared.workspace.races[0]?.name).toBe("local name");
    expect(prepared.successor).toMatchObject({
      mutationId: "local-successor",
      predecessorMutationId: mutation.mutationId,
      expectedVersion: 3,
      entityKey: CLIENT_KEY,
    });
    expect(prepared.resolvedConflict).toMatchObject({
      status: "resolved",
      resolution: "local",
    });
  });

  it("recognizes a race-name-only difference after database normalization", () => {
    expect(
      raceNameIsOnlyDifference(
        race("local"),
        { ...race("cloud"), course: "NAKAYAMA" },
      ),
    ).toBe(true);
  });
});

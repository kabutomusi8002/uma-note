import { describe, expect, it } from "vitest";
import { createDemoRace, DEMO_RULE_VERSION } from "../lib/demo-data";
import {
  enqueueMutation,
  getWorkspace,
  listConflicts,
  listOutbox,
  openLocalDatabase,
  putConflict,
  replaceWorkspace,
  resolveConflict,
  updateOutbox,
} from "../lib/storage/local-db";
import { createOutboxMutation } from "../lib/sync/outbox";
import type { OwnerScope, SyncConflict, WorkspaceSnapshot } from "../lib/sync/types";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const OWNER: OwnerScope = "user:user-a";
const OTHER_OWNER: OwnerScope = "user:user-b";

function workspace(ownerScope: OwnerScope, name = "A"): WorkspaceSnapshot {
  const race = createDemoRace();
  return {
    ownerScope,
    races: [{ ...race, id: `race-${name}`, name }],
    rules: [{ ...DEMO_RULE_VERSION, id: `rule-${name}` }],
    settings: { activeRaceId: `race-${name}` },
    updatedAt: "2026-07-18T00:00:00.000Z",
  };
}

describe("LOCAL database", () => {
  it("migrates localStorage v1 without deleting its recoverable backup", async () => {
    const storage = new MemoryStorage();
    const race = { ...createDemoRace(), id: "legacy-race" };
    storage.setItem("uma-note:races:v1", JSON.stringify([race]));
    storage.setItem("uma-note:rules:v1", JSON.stringify([DEMO_RULE_VERSION]));
    storage.setItem("uma-note:active-race:v1", race.id);
    storage.setItem("uma-note:dirty-races:v1", JSON.stringify([race.id]));

    const database = await openLocalDatabase({
      indexedDB: null,
      localStorage: storage,
      legacyOwnerScope: "anonymous:test-device",
      now: () => new Date("2026-07-18T01:00:00.000Z"),
      randomUUID: () => "00000000-0000-4000-8000-000000000001",
    });

    expect(database.backend).toBe("localstorage");
    const migrated = await getWorkspace(database, "anonymous:test-device");
    expect(migrated?.races.map((value) => value.id)).toEqual([race.id]);
    expect(migrated?.settings.activeRaceId).toBe(race.id);
    expect(await listOutbox(database, "anonymous:test-device")).toMatchObject([
      {
        mutationId: "00000000-0000-4000-8000-000000000001",
        ownerScope: "anonymous:test-device",
        entityKey: race.id,
        status: "pending",
      },
    ]);
    expect(storage.getItem("uma-note:races:v1")).not.toBeNull();
  });

  it("atomically stores a workspace snapshot and its outbox intent by owner", async () => {
    const database = await openLocalDatabase({ indexedDB: null, localStorage: null });
    const snapshot = workspace(OWNER);
    const mutation = createOutboxMutation(
      {
        ownerScope: OWNER,
        entityType: "race",
        entityKey: snapshot.races[0]!.id,
        payload: snapshot.races[0],
        expectedVersion: 3,
        baseSnapshot: { name: "before" },
      },
      {
        now: () => new Date("2026-07-18T00:00:00.000Z"),
        randomUUID: () => "mutation-a",
      },
    );

    await replaceWorkspace(database, snapshot, [mutation]);

    expect(await getWorkspace(database, OWNER)).toEqual(snapshot);
    expect(await getWorkspace(database, OTHER_OWNER)).toBeNull();
    expect(await listOutbox(database, OWNER)).toEqual([mutation]);
    expect(await listOutbox(database, OTHER_OWNER)).toEqual([]);

    await expect(
      replaceWorkspace(database, snapshot, [{ ...mutation, ownerScope: OTHER_OWNER }]),
    ).rejects.toThrow("owner scopes must match");
  });

  it("coalesces unsent edits but appends a successor to an in-flight mutation", async () => {
    const database = await openLocalDatabase({ indexedDB: null, localStorage: null });
    const makeMutation = (id: string, note: string, timestamp: string) =>
      createOutboxMutation(
        {
          ownerScope: OWNER,
          entityType: "race",
          entityKey: "race-a",
          payload: { note },
          baseSnapshot: { note: "base" },
          expectedVersion: 5,
        },
        { now: () => new Date(timestamp), randomUUID: () => id },
      );

    await enqueueMutation(
      database,
      makeMutation("first", "draft 1", "2026-07-18T00:00:00.000Z"),
    );
    const coalesced = await enqueueMutation(
      database,
      makeMutation("second", "draft 2", "2026-07-18T00:01:00.000Z"),
    );
    expect(coalesced.mutationId).toBe("first");
    expect(coalesced.payload).toEqual({ note: "draft 2" });
    expect(await listOutbox(database, OWNER)).toHaveLength(1);

    await updateOutbox(database, "first", {
      status: "syncing",
      inFlightAt: "2026-07-18T00:02:00.000Z",
    });
    await enqueueMutation(
      database,
      makeMutation("third", "draft 3", "2026-07-18T00:03:00.000Z"),
    );
    const queued = await listOutbox(database, OWNER);
    expect(queued.map((item) => item.mutationId)).toEqual(["first", "third"]);
    expect(queued[0]?.payload).toEqual({ note: "draft 2" });
    expect(queued[1]?.payload).toEqual({ note: "draft 3" });
  });

  it("coalesces repeated edits inside atomic workspace plus Outbox writes", async () => {
    const database = await openLocalDatabase({ indexedDB: null, localStorage: null });
    const firstWorkspace = workspace(OWNER, "first");
    const first = createOutboxMutation(
      {
        ownerScope: OWNER,
        entityType: "settings",
        entityKey: "profile",
        payload: { stake: 100 },
        expectedVersion: 2,
        baseSnapshot: { stake: 50 },
      },
      {
        now: () => new Date("2026-07-18T00:00:00.000Z"),
        randomUUID: () => "first-atomic",
      },
    );
    const second = createOutboxMutation(
      {
        ownerScope: OWNER,
        entityType: "settings",
        entityKey: "profile",
        payload: { stake: 300 },
        expectedVersion: 2,
        baseSnapshot: { stake: 999 },
      },
      {
        now: () => new Date("2026-07-18T00:01:00.000Z"),
        randomUUID: () => "second-atomic",
      },
    );

    await replaceWorkspace(database, firstWorkspace, [first]);
    await replaceWorkspace(database, workspace(OWNER, "second"), [second]);

    expect((await getWorkspace(database, OWNER))?.races[0]?.name).toBe("second");
    expect(await listOutbox(database, OWNER)).toMatchObject([
      {
        mutationId: "first-atomic",
        payload: { stake: 300 },
        baseSnapshot: { stake: 50 },
        expectedVersion: 2,
      },
    ]);
  });

  it("keeps conflicts isolated by owner", async () => {
    const database = await openLocalDatabase({ indexedDB: null, localStorage: null });
    const conflict: SyncConflict = {
      conflictId: "conflict-a",
      mutationId: "mutation-a",
      ownerScope: OWNER,
      entityType: "race",
      entityKey: "race-a",
      expectedVersion: 1,
      remoteVersion: 2,
      baseSnapshot: {},
      localSnapshot: { note: "local" },
      remoteSnapshot: { note: "remote" },
      reconciliation: "conflict",
      fields: [],
      status: "unresolved",
      createdAt: "2026-07-18T00:00:00.000Z",
    };
    await putConflict(database, conflict);

    expect(await listConflicts(database, OWNER)).toEqual([conflict]);
    expect(await listConflicts(database, OTHER_OWNER)).toEqual([]);
  });

  it("atomically resolves a conflict, removes the stale intent, and queues its successor", async () => {
    const database = await openLocalDatabase({ indexedDB: null, localStorage: null });
    const stale = createOutboxMutation(
      {
        ownerScope: OWNER,
        entityType: "race",
        entityKey: "race-a",
        payload: { note: "stale" },
        expectedVersion: 1,
        baseSnapshot: { note: "base" },
      },
      { randomUUID: () => "mutation-a" },
    );
    const conflict: SyncConflict = {
      conflictId: "conflict-a",
      mutationId: stale.mutationId,
      ownerScope: OWNER,
      entityType: "race",
      entityKey: "race-a",
      expectedVersion: 1,
      remoteVersion: 2,
      baseSnapshot: { note: "base" },
      localSnapshot: { note: "local" },
      remoteSnapshot: { note: "remote" },
      reconciliation: "conflict",
      fields: [],
      status: "unresolved",
      createdAt: "2026-07-18T00:00:00.000Z",
    };
    const successor = createOutboxMutation(
      {
        ownerScope: OWNER,
        entityType: "race",
        entityKey: "race-a",
        payload: conflict.localSnapshot,
        expectedVersion: conflict.remoteVersion,
        baseSnapshot: conflict.remoteSnapshot,
      },
      { randomUUID: () => "mutation-b" },
    );
    await enqueueMutation(database, stale);
    await putConflict(database, conflict);

    await resolveConflict(
      database,
      {
        ...conflict,
        status: "resolved",
        resolution: "local",
        resolvedAt: "2026-07-18T00:01:00.000Z",
      },
      successor,
    );

    expect(await listOutbox(database, OWNER)).toEqual([successor]);
    expect(await listConflicts(database, OWNER)).toMatchObject([
      { conflictId: "conflict-a", status: "resolved", resolution: "local" },
    ]);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  enqueueMutation,
  listConflicts,
  listOutbox,
  openLocalDatabase,
} from "../lib/storage/local-db";
import { createSyncCoordinator } from "../lib/sync/coordinator";
import {
  calculateRetryDelay,
  classifySyncError,
  createOutboxMutation,
  isMutationDue,
  isOwnerAuthorized,
  markMutationForRetry,
} from "../lib/sync/outbox";
import type { AuthState, OwnerScope, PushResult } from "../lib/sync/types";

const OWNER: OwnerScope = "user:user-a";

function mutation() {
  return createOutboxMutation(
    {
      ownerScope: OWNER,
      entityType: "race",
      entityKey: "race-a",
      payload: { prediction: { note: "phone" } },
      baseSnapshot: { prediction: { note: "base" } },
      expectedVersion: 4,
    },
    {
      now: () => new Date("2026-07-18T00:00:00.000Z"),
      randomUUID: () => "mutation-a",
    },
  );
}

async function eventually(assertion: () => void, attempts = 30): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

describe("outbox policy", () => {
  it("uses bounded exponential backoff with deterministic jitter", () => {
    expect(
      calculateRetryDelay(1, {
        baseDelayMs: 1_000,
        maxDelayMs: 10_000,
        jitterRatio: 0.2,
        random: () => 0.5,
      }),
    ).toBe(1_000);
    expect(
      calculateRetryDelay(8, {
        baseDelayMs: 1_000,
        maxDelayMs: 10_000,
        jitterRatio: 0,
      }),
    ).toBe(10_000);
  });

  it("retains a failed mutation until its retry time", () => {
    const queued = mutation();
    const retry = markMutationForRetry(queued, "offline", {
      now: new Date("2026-07-18T00:00:00.000Z"),
      retryAfterMs: 2_000,
    });

    expect(retry).toMatchObject({ status: "retry", attempts: 1 });
    expect(retry.nextAttemptAt).toBe("2026-07-18T00:00:02.000Z");
    expect(isMutationDue(retry, new Date("2026-07-18T00:00:01.999Z"))).toBe(false);
    expect(isMutationDue(retry, new Date("2026-07-18T00:00:02.000Z"))).toBe(true);
  });

  it("never authorizes another user's or anonymous workspace", () => {
    const signedIn: AuthState = { status: "authenticated", userId: "user-a" };
    expect(isOwnerAuthorized(OWNER, signedIn)).toBe(true);
    expect(isOwnerAuthorized("user:user-b", signedIn)).toBe(false);
    expect(isOwnerAuthorized("anonymous:device-a", signedIn)).toBe(false);
  });

  it("classifies auth, conflict, transient and validation errors", () => {
    expect(classifySyncError({ status: 401 }).kind).toBe("auth");
    expect(classifySyncError({ status: 409 }).kind).toBe("conflict");
    expect(classifySyncError({ status: 503 }).kind).toBe("retryable");
    expect(classifySyncError({ status: 422 }).kind).toBe("permanent");
    expect(classifySyncError(new DOMException("cancelled", "AbortError")).kind).toBe(
      "retryable",
    );
  });
});

describe("sync coordinator", () => {
  it("keeps the outbox untouched while offline", async () => {
    const database = await openLocalDatabase({ indexedDB: null, localStorage: null });
    await enqueueMutation(database, mutation());
    const push = vi.fn<() => Promise<PushResult>>(async () => ({
      status: "applied",
      cloudVersion: 5,
    }));
    const coordinator = createSyncCoordinator({
      database,
      getOwnerScope: () => OWNER,
      getAuthState: () => ({ status: "authenticated", userId: "user-a" }),
      isOnline: () => false,
      push,
    });

    await coordinator.flush("manual");

    expect(push).not.toHaveBeenCalled();
    expect(await listOutbox(database, OWNER)).toHaveLength(1);
    expect(coordinator.getStatus().phase).toBe("offline");
  });

  it("blocks cloud calls on an owner/auth mismatch", async () => {
    const database = await openLocalDatabase({ indexedDB: null, localStorage: null });
    await enqueueMutation(database, mutation());
    const pull = vi.fn(async () => ({ changes: [] }));
    const push = vi.fn(async (): Promise<PushResult> => ({
      status: "applied",
      cloudVersion: 5,
    }));
    const coordinator = createSyncCoordinator({
      database,
      getOwnerScope: () => OWNER,
      getAuthState: () => ({ status: "authenticated", userId: "user-b" }),
      pull,
      push,
    });

    await coordinator.flush("manual");

    expect(pull).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(coordinator.getStatus().phase).toBe("owner-mismatch");
  });

  it("retries after reconnect and removes only an acknowledged mutation", async () => {
    const database = await openLocalDatabase({ indexedDB: null, localStorage: null });
    await enqueueMutation(database, mutation());
    let clock = new Date("2026-07-18T00:00:00.000Z");
    const push = vi
      .fn<(value: unknown) => Promise<PushResult>>()
      .mockResolvedValueOnce({
        status: "retryable",
        message: "network unavailable",
        retryAfterMs: 1_000,
      })
      .mockResolvedValueOnce({ status: "applied", cloudVersion: 5 });
    const coordinator = createSyncCoordinator({
      database,
      getOwnerScope: () => OWNER,
      getAuthState: () => ({ status: "authenticated", userId: "user-a" }),
      now: () => clock,
      pullAfterPush: false,
      push,
    });

    await coordinator.flush("manual");
    expect(await listOutbox(database, OWNER)).toMatchObject([
      { status: "retry", attempts: 1, nextAttemptAt: "2026-07-18T00:00:01.000Z" },
    ]);

    clock = new Date("2026-07-18T00:00:01.000Z");
    await coordinator.flush("online");
    expect(push).toHaveBeenCalledTimes(2);
    expect(await listOutbox(database, OWNER)).toEqual([]);
  });

  it("stores a visible conflict and does not overwrite or discard local data", async () => {
    const database = await openLocalDatabase({ indexedDB: null, localStorage: null });
    await enqueueMutation(database, mutation());
    const push = vi.fn(async (): Promise<PushResult> => ({
      status: "conflict",
      cloudVersion: 5,
      serverValue: { prediction: { note: "desktop" } },
    }));
    const coordinator = createSyncCoordinator({
      database,
      getOwnerScope: () => OWNER,
      getAuthState: () => ({ status: "authenticated", userId: "user-a" }),
      push,
    });

    await coordinator.flush("manual");

    const queued = await listOutbox(database, OWNER);
    expect(queued).toMatchObject([
      {
        mutationId: "mutation-a",
        status: "conflict",
        payload: { prediction: { note: "phone" } },
      },
    ]);
    const conflicts = await listConflicts(database, OWNER);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      remoteVersion: 5,
      reconciliation: "conflict",
      status: "unresolved",
    });
    expect(coordinator.getStatus().phase).toBe("conflict");
  });

  it("keeps synchronization stopped while a permanent Outbox failure remains", async () => {
    const database = await openLocalDatabase({ indexedDB: null, localStorage: null });
    await enqueueMutation(database, mutation());
    const push = vi.fn(async (): Promise<PushResult> => ({
      status: "rejected",
      message: "validation failed",
    }));
    const coordinator = createSyncCoordinator({
      database,
      getOwnerScope: () => OWNER,
      getAuthState: () => ({ status: "authenticated", userId: "user-a" }),
      pullAfterPush: false,
      push,
    });

    await coordinator.flush("manual");
    expect(await listOutbox(database, OWNER)).toMatchObject([
      { mutationId: "mutation-a", status: "failed", lastError: "validation failed" },
    ]);
    expect(coordinator.getStatus()).toMatchObject({
      phase: "error",
      message: "validation failed",
    });

    await coordinator.flush("manual");
    expect(push).toHaveBeenCalledTimes(1);
    expect(coordinator.getStatus().phase).toBe("error");
  });

  it("flushes when online, authentication and visibility signals become ready", async () => {
    const database = await openLocalDatabase({ indexedDB: null, localStorage: null });
    await enqueueMutation(database, mutation());
    let online = false;
    let visible = false;
    let auth: AuthState = { status: "anonymous" };
    let onlineListener: () => void = () => undefined;
    let authListener: () => void = () => undefined;
    let visibilityListener: () => void = () => undefined;
    const push = vi.fn(async (): Promise<PushResult> => ({
      status: "applied",
      cloudVersion: 5,
    }));
    const coordinator = createSyncCoordinator({
      database,
      getOwnerScope: () => OWNER,
      getAuthState: () => auth,
      isOnline: () => online,
      isVisible: () => visible,
      subscribeOnline: (listener) => {
        onlineListener = listener;
        return () => undefined;
      },
      subscribeAuth: (listener) => {
        authListener = listener;
        return () => undefined;
      },
      subscribeVisibility: (listener) => {
        visibilityListener = listener;
        return () => undefined;
      },
      pullAfterPush: false,
      push,
    });

    coordinator.start();
    online = true;
    onlineListener();
    visible = true;
    visibilityListener();
    auth = { status: "authenticated", userId: "user-a" };
    authListener();

    await eventually(() => expect(push).toHaveBeenCalledTimes(1));
    expect(await listOutbox(database, OWNER)).toEqual([]);
    coordinator.stop();
  });

  it("aborts an in-flight push and retains its Outbox item when auth changes", async () => {
    const database = await openLocalDatabase({ indexedDB: null, localStorage: null });
    await enqueueMutation(database, mutation());
    let auth: AuthState = { status: "authenticated", userId: "user-a" };
    let ownerScope: OwnerScope = OWNER;
    const pushState: {
      resolve?: (result: PushResult) => void;
      signal?: AbortSignal;
    } = {};
    const push = vi.fn((_value, context) => {
      pushState.signal = context.signal;
      return new Promise<PushResult>((resolve) => {
        pushState.resolve = resolve;
      });
    });
    const coordinator = createSyncCoordinator({
      database,
      getOwnerScope: () => ownerScope,
      getAuthState: () => auth,
      pullAfterPush: false,
      push,
    });

    coordinator.start();
    await eventually(() => expect(push).toHaveBeenCalledTimes(1));
    auth = { status: "authenticated", userId: "user-b" };
    ownerScope = "user:user-b";
    coordinator.notifyAuthChanged();
    expect(pushState.signal?.aborted).toBe(true);
    pushState.resolve?.({ status: "applied", cloudVersion: 5 });

    await eventually(() => {
      expect(coordinator.getStatus().phase).not.toBe("syncing");
    });
    expect(await listOutbox(database, OWNER)).toMatchObject([
      { mutationId: "mutation-a", status: "pending" },
    ]);
    expect(push).toHaveBeenCalledTimes(1);
    coordinator.stop();
  });
});

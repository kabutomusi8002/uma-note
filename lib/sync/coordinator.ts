import {
  listOutbox,
  putConflict,
  removeOutbox,
  updateOutbox,
  type LocalDatabase,
} from "../storage/local-db";
import {
  classifySyncError,
  isMutationDue,
  isOwnerAuthorized,
  markMutationForRetry,
  type RetryPolicy,
} from "./outbox";
import { createSyncConflict } from "./reconciler";
import type {
  AuthState,
  OutboxMutation,
  OwnerScope,
  PullContext,
  PullResult,
  PushContext,
  PushResult,
  SyncConflict,
  SyncCoordinatorStatus,
  SyncTrigger,
} from "./types";

type Unsubscribe = () => void;
type TimerHandle = ReturnType<typeof setTimeout>;

export interface SyncCoordinatorOptions {
  database: LocalDatabase;
  getOwnerScope: () => OwnerScope;
  getAuthState: () => AuthState;
  pull?: (context: PullContext) => Promise<PullResult>;
  push: (
    mutation: OutboxMutation,
    context: PushContext,
  ) => Promise<PushResult>;
  /** Apply all pulled changes atomically before its cursor is advanced. */
  applyPull?: (
    result: PullResult,
    context: Omit<PullContext, "signal">,
  ) => Promise<void>;
  getCursor?: (ownerScope: OwnerScope) => Promise<string | undefined>;
  setCursor?: (ownerScope: OwnerScope, cursor: string) => Promise<void>;
  onApplied?: (
    mutation: OutboxMutation,
    result: Extract<PushResult, { status: "applied" }>,
  ) => void | Promise<void>;
  onConflict?: (conflict: SyncConflict) => void | Promise<void>;
  onStatus?: (status: SyncCoordinatorStatus) => void;
  isOnline?: () => boolean;
  isVisible?: () => boolean;
  subscribeOnline?: (listener: () => void) => Unsubscribe;
  subscribeAuth?: (listener: () => void) => Unsubscribe;
  subscribeVisibility?: (listener: () => void) => Unsubscribe;
  now?: () => Date;
  retryPolicy?: RetryPolicy;
  staleInFlightMs?: number;
  pullAfterPush?: boolean;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export interface SyncCoordinator {
  start(): void;
  stop(): void;
  flush(trigger?: SyncTrigger): Promise<void>;
  notifyOnline(): void;
  notifyAuthChanged(): void;
  notifyVisibilityChanged(): void;
  getStatus(): SyncCoordinatorStatus;
}

function defaultIsOnline(): boolean {
  return typeof navigator === "undefined" || typeof navigator.onLine !== "boolean"
    ? true
    : navigator.onLine;
}

function defaultIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function subscribeWindowOnline(listener: () => void): Unsubscribe {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

function subscribeDocumentVisibility(listener: () => void): Unsubscribe {
  if (typeof document === "undefined") return () => undefined;
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

/**
 * Testable LOCAL-first synchronization loop. The server adapter is injected so
 * this module has no Supabase or UI dependency.
 */
export function createSyncCoordinator(
  options: SyncCoordinatorOptions,
): SyncCoordinator {
  const now = options.now ?? (() => new Date());
  const isOnline = options.isOnline ?? defaultIsOnline;
  const isVisible = options.isVisible ?? defaultIsVisible;
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  const pull: (context: PullContext) => Promise<PullResult> =
    options.pull ?? (async () => ({ changes: [] }));
  const staleInFlightMs = options.staleInFlightMs ?? 60_000;
  let running = false;
  let activeFlush: Promise<void> | null = null;
  let rerunRequested = false;
  let retryTimer: TimerHandle | null = null;
  let abortController: AbortController | null = null;
  let unsubscribers: Unsubscribe[] = [];
  let status: SyncCoordinatorStatus = { phase: "idle", pendingCount: 0 };

  function publish(next: SyncCoordinatorStatus): void {
    status = { ...next };
    options.onStatus?.({ ...status });
  }

  function scheduleRetry(delayMs: number): void {
    if (!running) return;
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = setTimer(() => {
      retryTimer = null;
      void flush("retry");
    }, Math.max(1, delayMs));
  }

  async function pullAndApply(
    ownerScope: OwnerScope,
    userId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const cursor = await options.getCursor?.(ownerScope);
    const context: PullContext = { ownerScope, userId, cursor, signal };
    const result = await pull(context);
    if (signal.aborted || !isCurrentSyncContext(ownerScope, userId)) {
      throw new DOMException("Cloud identity changed during synchronization", "AbortError");
    }
    if (result.changes.length > 0 && !options.applyPull) {
      throw new Error("applyPull is required when the server returns changes");
    }
    await options.applyPull?.(result, { ownerScope, userId, cursor });
    if (signal.aborted || !isCurrentSyncContext(ownerScope, userId)) {
      throw new DOMException("Cloud identity changed during synchronization", "AbortError");
    }
    if (result.cursor !== undefined) {
      await options.setCursor?.(ownerScope, result.cursor);
    }
  }

  async function refreshPendingCount(ownerScope: OwnerScope): Promise<number> {
    return (await listOutbox(options.database, ownerScope)).length;
  }

  function isCurrentSyncContext(ownerScope: OwnerScope, userId: string): boolean {
    const currentAuth = options.getAuthState();
    return (
      currentAuth.status === "authenticated" &&
      currentAuth.userId === userId &&
      options.getOwnerScope() === ownerScope &&
      isOwnerAuthorized(ownerScope, currentAuth)
    );
  }

  async function run(trigger: SyncTrigger): Promise<void> {
    const ownerScope = options.getOwnerScope();
    let pendingCount = await refreshPendingCount(ownerScope);

    if (!isOnline()) {
      publish({ phase: "offline", trigger, pendingCount });
      return;
    }
    if (!isVisible() && trigger !== "manual") {
      publish({ phase: "hidden", trigger, pendingCount });
      return;
    }

    const auth = options.getAuthState();
    if (auth.status !== "authenticated") {
      publish({
        phase: "auth-required",
        trigger,
        pendingCount,
        message:
          auth.status === "expired"
            ? "Cloud session expired"
            : "Cloud synchronization is paused until sign-in",
      });
      return;
    }
    if (!isOwnerAuthorized(ownerScope, auth)) {
      publish({
        phase: "owner-mismatch",
        trigger,
        pendingCount,
        message: "This local workspace belongs to a different user",
      });
      return;
    }

    abortController = new AbortController();
    const context: PushContext = {
      ownerScope,
      userId: auth.userId,
      signal: abortController.signal,
    };
    publish({ phase: "syncing", trigger, pendingCount });

    try {
      await pullAndApply(ownerScope, auth.userId, abortController.signal);
    } catch (error) {
      const classified = classifySyncError(error);
      const phase = classified.kind === "auth" ? "auth-required" : "error";
      publish({ phase, trigger, pendingCount, message: classified.message });
      if (classified.kind === "retryable") {
        scheduleRetry(classified.retryAfterMs ?? 1_000);
      }
      return;
    }
    if (!isCurrentSyncContext(ownerScope, auth.userId)) {
      publish({
        phase: "auth-required",
        trigger,
        pendingCount,
        message: "Cloud identity changed during synchronization",
      });
      return;
    }

    const currentTime = now();
    const entityPriority = { rule: 0, race: 1, settings: 2 } as const;
    const mutations = (await listOutbox(options.database, ownerScope))
      .filter((mutation) => isMutationDue(mutation, currentTime, staleInFlightMs))
      .sort((left, right) =>
        entityPriority[left.entityType] - entityPriority[right.entityType] ||
        left.createdAt.localeCompare(right.createdAt),
      );
    let pushedAny = false;
    let sawConflict = false;
    let authFailed = false;

    for (const queued of mutations) {
      if (abortController.signal.aborted) break;
      if (!isCurrentSyncContext(ownerScope, auth.userId)) {
        authFailed = true;
        break;
      }
      const inFlight =
        (await updateOutbox(options.database, queued.mutationId, {
          status: "syncing",
          inFlightAt: now().toISOString(),
          updatedAt: now().toISOString(),
          lastError: undefined,
        })) ?? queued;

      try {
        const result = await options.push(inFlight, context);
        if (
          abortController.signal.aborted ||
          !isCurrentSyncContext(ownerScope, auth.userId)
        ) {
          await updateOutbox(options.database, inFlight.mutationId, {
            status: "pending",
            inFlightAt: undefined,
            updatedAt: now().toISOString(),
            lastError: "Cloud identity changed during synchronization",
          });
          authFailed = true;
          break;
        }
        if (result.status === "applied") {
          await options.onApplied?.(inFlight, result);
          await removeOutbox(options.database, inFlight.mutationId);
          pushedAny = true;
          continue;
        }
        if (result.status === "conflict") {
          const conflict = createSyncConflict(
            inFlight,
            result.serverValue,
            result.cloudVersion,
            now(),
          );
          await putConflict(options.database, conflict);
          await updateOutbox(options.database, inFlight.mutationId, {
            status: "conflict",
            inFlightAt: undefined,
            updatedAt: now().toISOString(),
            lastError: "Cloud version changed; user resolution is required",
          });
          await options.onConflict?.(conflict);
          sawConflict = true;
          continue;
        }
        if (result.status === "retryable") {
          const retry = markMutationForRetry(inFlight, result.message, {
            ...options.retryPolicy,
            now: now(),
            retryAfterMs: result.retryAfterMs,
          });
          await updateOutbox(options.database, inFlight.mutationId, retry);
          continue;
        }
        if (result.status === "auth-required") {
          await updateOutbox(options.database, inFlight.mutationId, {
            status: "pending",
            inFlightAt: undefined,
            updatedAt: now().toISOString(),
            lastError: result.message ?? "Cloud authentication is required",
          });
          authFailed = true;
          break;
        }
        await updateOutbox(options.database, inFlight.mutationId, {
          status: "failed",
          attempts: inFlight.attempts + 1,
          inFlightAt: undefined,
          updatedAt: now().toISOString(),
          lastError: result.message,
        });
      } catch (error) {
        if (
          abortController.signal.aborted ||
          !isCurrentSyncContext(ownerScope, auth.userId)
        ) {
          await updateOutbox(options.database, inFlight.mutationId, {
            status: "pending",
            inFlightAt: undefined,
            updatedAt: now().toISOString(),
            lastError: "Cloud identity changed during synchronization",
          });
          authFailed = true;
          break;
        }
        const classified = classifySyncError(error);
        if (classified.kind === "auth") {
          await updateOutbox(options.database, inFlight.mutationId, {
            status: "pending",
            inFlightAt: undefined,
            updatedAt: now().toISOString(),
            lastError: classified.message,
          });
          authFailed = true;
          break;
        }
        if (classified.kind === "conflict") {
          // The adapter did not provide a remote value, so preserve the local
          // mutation and make the conflict visible instead of guessing.
          const conflict = createSyncConflict(
            inFlight,
            null,
            inFlight.expectedVersion ?? 0,
            now(),
          );
          await putConflict(options.database, conflict);
          await updateOutbox(options.database, inFlight.mutationId, {
            status: "conflict",
            inFlightAt: undefined,
            updatedAt: now().toISOString(),
            lastError: classified.message,
          });
          await options.onConflict?.(conflict);
          sawConflict = true;
          continue;
        }
        if (classified.kind === "retryable") {
          const retry = markMutationForRetry(inFlight, classified.message, {
            ...options.retryPolicy,
            now: now(),
            retryAfterMs: classified.retryAfterMs,
          });
          await updateOutbox(options.database, inFlight.mutationId, retry);
          continue;
        }
        await updateOutbox(options.database, inFlight.mutationId, {
          status: "failed",
          attempts: inFlight.attempts + 1,
          inFlightAt: undefined,
          updatedAt: now().toISOString(),
          lastError: classified.message,
        });
      }
    }

    if (pushedAny && options.pullAfterPush !== false && !authFailed) {
      try {
        await pullAndApply(ownerScope, auth.userId, abortController.signal);
      } catch (error) {
        const classified = classifySyncError(error);
        publish({
          phase: classified.kind === "auth" ? "auth-required" : "error",
          trigger,
          pendingCount: await refreshPendingCount(ownerScope),
          message: classified.message,
        });
        if (classified.kind === "retryable") {
          scheduleRetry(classified.retryAfterMs ?? 1_000);
        }
        return;
      }
    }

    const remaining = await listOutbox(options.database, ownerScope);
    pendingCount = remaining.length;
    const unresolvedConflict = remaining.some(
      (mutation) => mutation.status === "conflict",
    );
    const failedMutation = remaining.find(
      (mutation) => mutation.status === "failed",
    );
    const retryTimes = remaining
      .filter((mutation) => mutation.status === "retry")
      .map((mutation) => Date.parse(mutation.nextAttemptAt))
      .filter(Number.isFinite);
    if (retryTimes.length > 0) {
      scheduleRetry(Math.max(1, Math.min(...retryTimes) - now().getTime()));
    }

    if (authFailed) {
      publish({ phase: "auth-required", trigger, pendingCount });
    } else if (sawConflict || unresolvedConflict) {
      publish({
        phase: "conflict",
        trigger,
        pendingCount,
        message: "Cloud changes need review before synchronization can continue",
      });
    } else if (failedMutation) {
      publish({
        phase: "error",
        trigger,
        pendingCount,
        message:
          failedMutation.lastError ??
          "A local change could not be synchronized and needs review",
      });
    } else {
      publish({
        phase: "idle",
        trigger,
        pendingCount,
        lastSyncedAt: now().toISOString(),
      });
    }
  }

  function flush(trigger: SyncTrigger = "manual"): Promise<void> {
    if (activeFlush) {
      rerunRequested = true;
      return activeFlush;
    }
    activeFlush = run(trigger).finally(() => {
      activeFlush = null;
      abortController = null;
      if (rerunRequested && running) {
        rerunRequested = false;
        void flush("retry");
      }
    });
    return activeFlush;
  }

  function notifyOnline(): void {
    if (running && isOnline()) void flush("online");
  }

  function notifyAuthChanged(): void {
    if (!running) return;
    abortController?.abort();
    void flush("auth");
  }

  function notifyVisibilityChanged(): void {
    if (running && isVisible()) void flush("visibility");
  }

  return {
    start() {
      if (running) return;
      running = true;
      unsubscribers = [
        (options.subscribeOnline ?? subscribeWindowOnline)(notifyOnline),
        (options.subscribeAuth ?? (() => () => undefined))(notifyAuthChanged),
        (options.subscribeVisibility ?? subscribeDocumentVisibility)(
          notifyVisibilityChanged,
        ),
      ];
      void flush("start");
    },
    stop() {
      running = false;
      rerunRequested = false;
      abortController?.abort();
      if (retryTimer !== null) {
        clearTimer(retryTimer);
        retryTimer = null;
      }
      for (const unsubscribe of unsubscribers) unsubscribe();
      unsubscribers = [];
      publish({ ...status, phase: "stopped" });
    },
    flush,
    notifyOnline,
    notifyAuthChanged,
    notifyVisibilityChanged,
    getStatus: () => ({ ...status }),
  };
}

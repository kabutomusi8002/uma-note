import type {
  AuthState,
  OutboxMutation,
  OwnerScope,
  SyncEntityType,
  SyncOperation,
} from "./types";

export interface CreateMutationInput<T = unknown> {
  ownerScope: OwnerScope;
  entityType: SyncEntityType;
  entityKey: string;
  operation?: SyncOperation;
  payload: T | null;
  baseSnapshot?: unknown | null;
  expectedVersion?: number | null;
  expectedParentVersion?: number | null;
}

export interface MutationFactoryOptions {
  now?: () => Date;
  randomUUID?: () => string;
}

function fallbackUuid(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

export function createMutationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? fallbackUuid();
}

export function createOutboxMutation<T>(
  input: CreateMutationInput<T>,
  options: MutationFactoryOptions = {},
): OutboxMutation<T> {
  const now = (options.now ?? (() => new Date()))();
  const timestamp = now.toISOString();
  const mutation: OutboxMutation<T> = {
    mutationId: (options.randomUUID ?? createMutationId)(),
    ownerScope: input.ownerScope,
    entityType: input.entityType,
    entityKey: input.entityKey,
    operation: input.operation ?? "upsert",
    payload: input.payload,
    baseSnapshot: input.baseSnapshot ?? null,
    expectedVersion: input.expectedVersion ?? null,
    status: "pending",
    attempts: 0,
    nextAttemptAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (input.expectedParentVersion !== undefined) {
    mutation.expectedParentVersion = input.expectedParentVersion;
  }
  return mutation;
}

export function ownerScopeForUser(userId: string): OwnerScope {
  if (!userId.trim()) throw new Error("userId is required");
  return `user:${userId}`;
}

export function ownerScopeForAnonymous(deviceId: string): OwnerScope {
  if (!deviceId.trim()) throw new Error("deviceId is required");
  return `anonymous:${deviceId}`;
}

export function userIdFromOwnerScope(scope: OwnerScope): string | null {
  return scope.startsWith("user:") ? scope.slice("user:".length) : null;
}

export function isOwnerAuthorized(
  ownerScope: OwnerScope,
  auth: AuthState,
): auth is Extract<AuthState, { status: "authenticated" }> {
  return (
    auth.status === "authenticated" &&
    ownerScope === ownerScopeForUser(auth.userId)
  );
}

/**
 * Consecutive unsent writes to the same entity are collapsed. A write already
 * in flight keeps its mutation id and payload immutable; callers must append a
 * successor instead so an acknowledgement cannot erase a newer local edit.
 */
export function canCoalesceMutation(
  existing: OutboxMutation,
  incoming: OutboxMutation,
): boolean {
  return (
    existing.ownerScope === incoming.ownerScope &&
    existing.entityType === incoming.entityType &&
    existing.entityKey === incoming.entityKey &&
    (existing.status === "pending" || existing.status === "retry")
  );
}

export function coalesceOutboxMutation<T>(
  existing: OutboxMutation<T>,
  incoming: OutboxMutation<T>,
): OutboxMutation<T> {
  if (!canCoalesceMutation(existing, incoming)) return incoming;

  return {
    ...existing,
    operation: incoming.operation,
    payload: incoming.payload,
    // Keep the original base/version. The combined mutation represents edits
    // that started from that same server observation. The optional parent
    // precondition is retained by the spread for the same reason.
    status: "pending",
    attempts: 0,
    nextAttemptAt: incoming.nextAttemptAt,
    updatedAt: incoming.updatedAt,
    inFlightAt: undefined,
    lastError: undefined,
  };
}

export interface RetryPolicy {
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
}

export function calculateRetryDelay(
  attempts: number,
  policy: RetryPolicy = {},
): number {
  const base = Math.max(1, policy.baseDelayMs ?? 1_000);
  const maximum = Math.max(base, policy.maxDelayMs ?? 5 * 60_000);
  const exponent = Math.min(Math.max(0, attempts - 1), 20);
  const withoutJitter = Math.min(maximum, base * 2 ** exponent);
  const ratio = Math.min(1, Math.max(0, policy.jitterRatio ?? 0.2));
  const random = Math.min(1, Math.max(0, (policy.random ?? Math.random)()));
  const multiplier = 1 - ratio + random * ratio * 2;
  return Math.max(1, Math.round(Math.min(maximum, withoutJitter * multiplier)));
}

export function markMutationForRetry<T>(
  mutation: OutboxMutation<T>,
  error: string,
  options: RetryPolicy & { now?: Date; retryAfterMs?: number } = {},
): OutboxMutation<T> {
  const now = options.now ?? new Date();
  const attempts = mutation.attempts + 1;
  const delay = Math.max(
    1,
    options.retryAfterMs ?? calculateRetryDelay(attempts, options),
  );
  return {
    ...mutation,
    status: "retry",
    attempts,
    nextAttemptAt: new Date(now.getTime() + delay).toISOString(),
    updatedAt: now.toISOString(),
    inFlightAt: undefined,
    lastError: error,
  };
}

export function isMutationDue(
  mutation: OutboxMutation,
  now: Date = new Date(),
  staleInFlightMs = 60_000,
): boolean {
  if (mutation.status === "pending") return true;
  if (mutation.status === "retry") {
    return Date.parse(mutation.nextAttemptAt) <= now.getTime();
  }
  if (mutation.status === "syncing" && mutation.inFlightAt) {
    return Date.parse(mutation.inFlightAt) + staleInFlightMs <= now.getTime();
  }
  return false;
}

export type SyncErrorKind = "auth" | "conflict" | "retryable" | "permanent";

export function classifySyncError(error: unknown): {
  kind: SyncErrorKind;
  message: string;
  retryAfterMs?: number;
} {
  const candidate =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : {};
  const status = Number(candidate.status ?? candidate.statusCode ?? 0);
  const code = String(candidate.code ?? "").toLowerCase();
  const name = String(candidate.name ?? "").toLowerCase();
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Cloud synchronization failed";
  const retryAfter = Number(candidate.retryAfterMs ?? 0);

  if (status === 401 || status === 403 || code.includes("jwt")) {
    return { kind: "auth", message };
  }
  if (status === 409 || code.includes("conflict") || code.includes("version")) {
    return { kind: "conflict", message };
  }
  if (
    status === 0 ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500 ||
    code === "aborterror" ||
    name === "aborterror" ||
    code.includes("network") ||
    code.includes("timeout")
  ) {
    return {
      kind: "retryable",
      message,
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    };
  }
  return { kind: "permanent", message };
}

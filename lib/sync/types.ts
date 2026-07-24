import type { PredictionRuleVersion, RaceRecord } from "../types";

/**
 * A workspace is deliberately tied to either one anonymous browser profile or
 * one authenticated Supabase user. Mutations must never cross this boundary.
 */
export type OwnerScope = `anonymous:${string}` | `user:${string}`;

export type AuthState =
  | { status: "unknown" }
  | { status: "anonymous" }
  | { status: "authenticated"; userId: string }
  | { status: "expired"; userId?: string };

export interface WorkspaceSettings {
  activeRaceId?: string;
  /** The last server change cursor successfully applied to this workspace. */
  syncCursor?: string;
  [key: string]: unknown;
}

export interface WorkspaceSnapshot {
  ownerScope: OwnerScope;
  races: RaceRecord[];
  rules: PredictionRuleVersion[];
  settings: WorkspaceSettings;
  updatedAt: string;
}

export type SyncEntityType = "race" | "rule" | "settings";
export type SyncOperation = "upsert" | "delete";
export type OutboxStatus =
  | "pending"
  | "syncing"
  | "retry"
  | "conflict"
  | "failed";

/**
 * A durable, idempotent write intent. `baseSnapshot` is the cloud value the
 * user originally edited; it is needed for a non-destructive three-way merge.
 */
export interface OutboxMutation<T = unknown> {
  mutationId: string;
  ownerScope: OwnerScope;
  entityType: SyncEntityType;
  entityKey: string;
  operation: SyncOperation;
  payload: T | null;
  baseSnapshot: unknown | null;
  expectedVersion: number | null;
  /** Optional optimistic version of a parent aggregate, such as a rule set. */
  expectedParentVersion?: number | null;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
  inFlightAt?: string;
  lastError?: string;
}

export interface ConflictField {
  /** JSON pointer, for example `/prediction/note`. */
  path: string;
  base: unknown;
  local: unknown;
  remote: unknown;
}

export type ReconciliationKind =
  | "equal"
  | "local"
  | "remote"
  | "merged"
  | "conflict";

export interface SyncConflict {
  conflictId: string;
  mutationId: string;
  ownerScope: OwnerScope;
  entityType: SyncEntityType;
  entityKey: string;
  expectedVersion: number | null;
  expectedParentVersion?: number | null;
  remoteVersion: number;
  remoteParentVersion?: number;
  baseSnapshot: unknown | null;
  localSnapshot: unknown | null;
  remoteSnapshot: unknown | null;
  reconciliation: ReconciliationKind;
  fields: ConflictField[];
  status: "unresolved" | "resolved";
  createdAt: string;
  resolvedAt?: string;
  resolution?: "local" | "remote" | "merged" | "exported";
}

export interface RemoteChange<T = unknown> {
  entityType: SyncEntityType;
  entityKey: string;
  operation: SyncOperation;
  value: T | null;
  cloudVersion: number;
}

export interface PullContext {
  ownerScope: OwnerScope;
  userId: string;
  cursor?: string;
  signal: AbortSignal;
}

export interface PullResult {
  cursor?: string;
  changes: RemoteChange[];
}

export interface PushContext {
  ownerScope: OwnerScope;
  userId: string;
  signal: AbortSignal;
}

export type PushResult =
  | {
      status: "applied";
      cloudVersion: number;
      cloudParentVersion?: number;
      serverValue?: unknown;
    }
  | {
      status: "conflict";
      cloudVersion: number;
      cloudParentVersion?: number;
      serverValue: unknown | null;
    }
  | {
      status: "retryable";
      message: string;
      retryAfterMs?: number;
    }
  | {
      status: "auth-required";
      message?: string;
    }
  | {
      status: "rejected";
      message: string;
    };

export type SyncTrigger =
  | "start"
  | "online"
  | "auth"
  | "visibility"
  | "manual"
  | "retry";

export type SyncPhase =
  | "idle"
  | "syncing"
  | "offline"
  | "hidden"
  | "auth-required"
  | "owner-mismatch"
  | "conflict"
  | "error"
  | "stopped";

export interface SyncCoordinatorStatus {
  phase: SyncPhase;
  trigger?: SyncTrigger;
  pendingCount: number;
  lastSyncedAt?: string;
  message?: string;
}

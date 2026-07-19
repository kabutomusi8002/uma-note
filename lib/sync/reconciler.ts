import type {
  ConflictField,
  OutboxMutation,
  ReconciliationKind,
  SyncConflict,
} from "./types";

const MISSING = Symbol("missing");
type PossiblyMissing = unknown | typeof MISSING;

const DEFAULT_ATOMIC_PATHS = [
  "/dataScope",
  "/lock",
  "/prediction/revisions",
  "/purchasedBets",
  "/result",
] as const;

export interface ReconcileOptions {
  /**
   * Both-side edits anywhere below these JSON pointers are treated as one
   * indivisible change. This protects locked predictions and settled money.
   */
  atomicPaths?: readonly string[];
}

export type ReconciliationResult<T> =
  | {
      kind: Exclude<ReconciliationKind, "conflict">;
      value: T;
      conflicts: [];
    }
  | {
      kind: "conflict";
      /** Safe preview only; it must not replace either stored value. */
      mergedPreview: T;
      conflicts: ConflictField[];
    };

function isPlainObject(value: PossiblyMissing): value is Record<string, unknown> {
  if (value === MISSING || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone<T>(value: T): T {
  if (value === MISSING || value === undefined || value === null) return value;
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function equal(left: PossiblyMissing, right: PossiblyMissing): boolean {
  if (left === MISSING || right === MISSING) return left === right;
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => equal(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => {
        const leftValue = Object.prototype.hasOwnProperty.call(left, key)
          ? left[key]
          : MISSING;
        const rightValue = Object.prototype.hasOwnProperty.call(right, key)
          ? right[key]
          : MISSING;
        return key === rightKeys[index] && equal(leftValue, rightValue);
      })
    );
  }
  return false;
}

function pointerPart(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function exposed(value: PossiblyMissing): unknown {
  return value === MISSING ? undefined : clone(value);
}

function isAtomicPath(path: string, atomicPaths: readonly string[]): boolean {
  return atomicPaths.some((atomic) => path === atomic);
}

interface WalkResult {
  value: PossiblyMissing;
  conflicts: ConflictField[];
}

function walk(
  base: PossiblyMissing,
  local: PossiblyMissing,
  remote: PossiblyMissing,
  path: string,
  atomicPaths: readonly string[],
): WalkResult {
  if (equal(local, remote)) return { value: clone(local), conflicts: [] };
  if (equal(local, base)) return { value: clone(remote), conflicts: [] };
  if (equal(remote, base)) return { value: clone(local), conflicts: [] };

  if (
    isAtomicPath(path, atomicPaths) ||
    !isPlainObject(local) ||
    !isPlainObject(remote) ||
    (base !== MISSING && !isPlainObject(base))
  ) {
    return {
      // A preview retains the local value, but callers are explicitly forbidden
      // from persisting it while conflicts are present.
      value: clone(local),
      conflicts: [
        {
          path: path || "/",
          base: exposed(base),
          local: exposed(local),
          remote: exposed(remote),
        },
      ],
    };
  }

  const baseObject = base === MISSING ? {} : base;
  const keys = new Set([
    ...Object.keys(baseObject),
    ...Object.keys(local),
    ...Object.keys(remote),
  ]);
  const value: Record<string, unknown> = {};
  const conflicts: ConflictField[] = [];

  for (const key of [...keys].sort()) {
    const childPath = `${path}/${pointerPart(key)}`;
    const child = walk(
      Object.prototype.hasOwnProperty.call(baseObject, key) ? baseObject[key] : MISSING,
      Object.prototype.hasOwnProperty.call(local, key) ? local[key] : MISSING,
      Object.prototype.hasOwnProperty.call(remote, key) ? remote[key] : MISSING,
      childPath,
      atomicPaths,
    );
    conflicts.push(...child.conflicts);
    if (child.value !== MISSING) value[key] = child.value;
  }

  return { value, conflicts };
}

/**
 * Performs a conservative three-way comparison. Conflicting results never
 * expose a persistable `value`, preventing accidental last-writer-wins saves.
 */
export function reconcileEntity<T>(
  base: T,
  local: T,
  remote: T,
  options: ReconcileOptions = {},
): ReconciliationResult<T> {
  const atomicPaths = options.atomicPaths ?? DEFAULT_ATOMIC_PATHS;
  const result = walk(base, local, remote, "", atomicPaths);

  if (result.conflicts.length > 0) {
    return {
      kind: "conflict",
      mergedPreview: clone(result.value) as T,
      conflicts: result.conflicts,
    };
  }

  let kind: Exclude<ReconciliationKind, "conflict">;
  if (equal(local, remote)) kind = "equal";
  else if (equal(remote, base)) kind = "local";
  else if (equal(local, base)) kind = "remote";
  else kind = "merged";

  return { kind, value: clone(result.value) as T, conflicts: [] };
}

export function createSyncConflict(
  mutation: OutboxMutation,
  remoteSnapshot: unknown | null,
  remoteVersion: number,
  now: Date = new Date(),
): SyncConflict {
  const analysis = reconcileEntity(
    mutation.baseSnapshot,
    mutation.payload,
    remoteSnapshot,
  );
  return {
    conflictId: `${mutation.ownerScope}:${mutation.entityType}:${mutation.entityKey}:${mutation.mutationId}`,
    mutationId: mutation.mutationId,
    ownerScope: mutation.ownerScope,
    entityType: mutation.entityType,
    entityKey: mutation.entityKey,
    expectedVersion: mutation.expectedVersion,
    remoteVersion,
    baseSnapshot: clone(mutation.baseSnapshot),
    localSnapshot: clone(mutation.payload),
    remoteSnapshot: clone(remoteSnapshot),
    reconciliation: analysis.kind,
    fields: analysis.kind === "conflict" ? analysis.conflicts : [],
    status: "unresolved",
    createdAt: now.toISOString(),
  };
}

export { DEFAULT_ATOMIC_PATHS };

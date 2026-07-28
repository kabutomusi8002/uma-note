import type {
  OutboxMutation,
  OwnerScope,
  SyncConflict,
  TerminalOutboxStatus,
  WorkspaceSnapshot,
} from "../sync/types";
import type { RaceRecord } from "../types";
import {
  backfillRaceClientKey,
  raceNaturalKey,
} from "../race-identity";
import {
  canCoalesceMutation,
  coalesceOutboxMutation,
  createOutboxMutation,
} from "../sync/outbox";

const DATABASE_NAME = "uma-note-local";
const DATABASE_VERSION = 1;
const FALLBACK_STATE_KEY = "uma-note:local-db:v2";
const LEGACY_RACES_KEY = "uma-note:races:v1";
const LEGACY_RULES_KEY = "uma-note:rules:v1";
const LEGACY_ACTIVE_RACE_KEY = "uma-note:active-race:v1";
const LEGACY_DIRTY_RACES_KEY = "uma-note:dirty-races:v1";
const LEGACY_MIGRATION_KEY = "migration:local-storage-v1";

export const LEGACY_OWNER_SCOPE: OwnerScope = "anonymous:legacy";

type BackendKind = "indexeddb" | "localstorage" | "memory";

interface LocalStorageState {
  version: 2;
  workspaces: Record<string, WorkspaceSnapshot>;
  outbox: Record<string, OutboxMutation>;
  conflicts: Record<string, SyncConflict>;
  metadata: Record<string, unknown>;
}

export interface SyncSafetyBackup {
  format: "UMA_NOTE_OUTBOX_SAFETY_BACKUP_V1";
  createdAt: string;
  ownerScope: OwnerScope;
  workspace: WorkspaceSnapshot | null;
  outbox: OutboxMutation[];
  conflicts: SyncConflict[];
}

export interface SyncResolutionCommit {
  workspace: WorkspaceSnapshot;
  originalMutationId: string;
  entityType: OutboxMutation["entityType"];
  entityKey: string;
  successor?: OutboxMutation;
  /** Already-durable successors replaced by this explicit user decision. */
  supersededMutationIds?: string[];
  resolvedConflict?: SyncConflict;
}

export interface SyncResolutionCommitResult {
  successor: OutboxMutation | null;
  originalRemoved: boolean;
}

export interface RaceOutboxConvergenceItem {
  mutationId: string;
  expectedStatus: OutboxMutation["status"];
  terminalStatus: TerminalOutboxStatus;
  reason: string;
}

export interface RaceOutboxConvergenceInput {
  workspace: WorkspaceSnapshot;
  entityKey: string;
  cloudId: string;
  cloudVersion: number;
  verifiedReceiptMutationId: string;
  items: RaceOutboxConvergenceItem[];
  rebase?: OutboxMutation<RaceRecord>;
  convergedAt: string;
}

export interface RaceOutboxConvergenceResult {
  archivedCount: number;
  resolvedConflictCount: number;
  rebase: OutboxMutation<RaceRecord> | null;
}

export interface HeldRebaseConflictSettlementInput {
  ownerScope: OwnerScope;
  mutationId: string;
  entityKey: string;
  cloudId: string;
  cloudVersion: number;
  settledAt: string;
}

export interface HeldRebaseConflictSettlementResult {
  mutation: OutboxMutation;
  resolvedConflictCount: number;
}

export interface AppliedRebaseCommitInput {
  workspace: WorkspaceSnapshot;
  mutationId: string;
  entityKey: string;
  cloudId: string;
  expectedVersion: number;
  resultingVersion: number;
  receiptMutationId: string;
  changeSequence: number;
  completedAt: string;
}

export interface AppliedRebaseCommitResult {
  mutation: OutboxMutation;
  workspace: WorkspaceSnapshot;
}

interface LocalDatabaseAdapter {
  readonly backend: BackendKind;
  getWorkspace(ownerScope: OwnerScope): Promise<WorkspaceSnapshot | null>;
  replaceWorkspace(
    workspace: WorkspaceSnapshot,
    mutations: readonly OutboxMutation[],
  ): Promise<void>;
  enqueueMutation(mutation: OutboxMutation): Promise<OutboxMutation>;
  listOutbox(ownerScope?: OwnerScope): Promise<OutboxMutation[]>;
  updateOutbox(
    mutationId: string,
    patch: Partial<OutboxMutation>,
  ): Promise<OutboxMutation | null>;
  removeOutbox(mutationId: string): Promise<void>;
  listConflicts(ownerScope?: OwnerScope): Promise<SyncConflict[]>;
  putConflict(conflict: SyncConflict): Promise<void>;
  resolveConflict(
    conflict: SyncConflict,
    successor?: OutboxMutation,
  ): Promise<OutboxMutation | null>;
  exportSyncSafetyBackup(
    ownerScope: OwnerScope,
    now: Date,
  ): Promise<SyncSafetyBackup>;
  commitSyncResolution(
    input: SyncResolutionCommit,
  ): Promise<SyncResolutionCommitResult>;
  convergeRaceOutbox(
    input: RaceOutboxConvergenceInput,
  ): Promise<RaceOutboxConvergenceResult>;
  settleHeldRebaseConflict(
    input: HeldRebaseConflictSettlementInput,
  ): Promise<HeldRebaseConflictSettlementResult>;
  commitAppliedRebase(
    input: AppliedRebaseCommitInput,
  ): Promise<AppliedRebaseCommitResult>;
  getMetadata(key: string): Promise<unknown>;
  setMetadata(key: string, value: unknown): Promise<void>;
  close(): void;
}

const INTERNAL = Symbol("LocalDatabaseAdapter");

export interface LocalDatabase {
  readonly name: string;
  readonly backend: BackendKind;
  close(): void;
  readonly [INTERNAL]: LocalDatabaseAdapter;
}

export interface OpenLocalDatabaseOptions {
  name?: string;
  /** Pass null to explicitly disable IndexedDB (useful in SSR and tests). */
  indexedDB?: IDBFactory | null;
  /** Pass null to use the in-memory last-resort adapter. */
  localStorage?: Storage | null;
  legacyOwnerScope?: OwnerScope;
  now?: () => Date;
  randomUUID?: () => string;
}

function clone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

type LegacyRaceRecord = Omit<RaceRecord, "clientKey"> & {
  clientKey?: unknown;
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function safeRaceNaturalKey(value: unknown): string | null {
  const record = objectValue(value);
  if (
    !record ||
    typeof record.date !== "string" ||
    typeof record.course !== "string" ||
    (typeof record.raceNumber !== "number" &&
      typeof record.raceNumber !== "string")
  ) {
    return null;
  }
  try {
    return raceNaturalKey({
      date: record.date,
      course: record.course,
      raceNumber: record.raceNumber,
    });
  } catch {
    return null;
  }
}

function normalizeRaceOutboxMutation(
  mutation: OutboxMutation,
): { mutation: OutboxMutation; changed: boolean } {
  if (mutation.entityType !== "race" || mutation.payload === null) {
    return { mutation, changed: false };
  }
  const payload = objectValue(mutation.payload);
  const payloadId = nonEmptyString(payload?.id);
  const isCompleteRacePayload = Boolean(
    payloadId &&
      typeof payload?.date === "string" &&
      typeof payload?.course === "string" &&
      typeof payload?.raceNumber === "number",
  );
  if (!payload || !isCompleteRacePayload || nonEmptyString(payload.clientKey)) {
    return { mutation, changed: false };
  }
  return {
    mutation: {
      ...mutation,
      payload: {
        ...payload,
        clientKey: mutation.entityKey,
      },
    },
    changed: true,
  };
}

function matchingOutboxEntityKey(
  race: LegacyRaceRecord,
  mutations: readonly OutboxMutation[],
): string | null {
  const raceKey = safeRaceNaturalKey(race);
  const matching = mutations
    .filter((mutation) => {
      if (mutation.entityType !== "race") return false;
      const payload = objectValue(mutation.payload);
      if (!payload) return false;
      if (nonEmptyString(payload.id) === race.id) return true;
      return raceKey !== null && safeRaceNaturalKey(payload) === raceKey;
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return nonEmptyString(matching[0]?.entityKey);
}

function normalizeWorkspaceRaceClientKeys(
  workspace: WorkspaceSnapshot,
  mutations: readonly OutboxMutation[],
): { workspace: WorkspaceSnapshot; changed: boolean } {
  let changed = false;
  const races = workspace.races.map((race) => {
    const legacy = race as unknown as LegacyRaceRecord;
    if (nonEmptyString(legacy.clientKey)) return race;
    const normalized = backfillRaceClientKey(
      legacy,
      matchingOutboxEntityKey(legacy, mutations),
    ) as RaceRecord;
    changed = true;
    return normalized;
  });
  return {
    workspace: changed ? { ...workspace, races } : workspace,
    changed,
  };
}

function emptyState(): LocalStorageState {
  return {
    version: 2,
    workspaces: {},
    outbox: {},
    conflicts: {},
    metadata: {},
  };
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("IndexedDB transaction failed")),
      { once: true },
    );
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("IndexedDB request failed")),
      { once: true },
    );
  });
}

class IndexedDatabaseAdapter implements LocalDatabaseAdapter {
  readonly backend = "indexeddb" as const;

  constructor(private readonly database: IDBDatabase) {}

  private async read<T>(
    stores: string | string[],
    operation: (transaction: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    const transaction = this.database.transaction(stores, "readonly");
    const done = transactionDone(transaction);
    const result = await operation(transaction);
    await done;
    return clone(result);
  }

  private async write<T>(
    stores: string | string[],
    operation: (transaction: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    const transaction = this.database.transaction(stores, "readwrite");
    const done = transactionDone(transaction);
    try {
      const result = await operation(transaction);
      await done;
      return clone(result);
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // It may already have aborted due to the failed request.
      }
      await done.catch(() => undefined);
      throw error;
    }
  }

  async getWorkspace(ownerScope: OwnerScope): Promise<WorkspaceSnapshot | null> {
    return this.read("workspaces", async (transaction) => {
      const value = await requestResult(
        transaction.objectStore("workspaces").get(ownerScope),
      );
      return (value as WorkspaceSnapshot | undefined) ?? null;
    });
  }

  async replaceWorkspace(
    workspace: WorkspaceSnapshot,
    mutations: readonly OutboxMutation[],
  ): Promise<void> {
    await this.write(["workspaces", "outbox"], async (transaction) => {
      transaction.objectStore("workspaces").put(clone(workspace));
      const store = transaction.objectStore("outbox");
      for (const mutation of mutations) {
        const sameId = (await requestResult(store.get(mutation.mutationId))) as
          | OutboxMutation
          | undefined;
        if (sameId) continue;
        const matching = (await requestResult(
          store
            .index("ownerEntity")
            .getAll([mutation.ownerScope, mutation.entityType, mutation.entityKey]),
        )) as OutboxMutation[];
        const coalescible = matching
          .filter((candidate) => canCoalesceMutation(candidate, mutation))
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
        store.put(clone(
          coalescible
            ? coalesceOutboxMutation(coalescible, mutation)
            : mutation,
        ));
      }
    });
  }

  async enqueueMutation(mutation: OutboxMutation): Promise<OutboxMutation> {
    return this.write("outbox", async (transaction) => {
      const store = transaction.objectStore("outbox");
      const sameId = (await requestResult(store.get(mutation.mutationId))) as
        | OutboxMutation
        | undefined;
      if (sameId) return sameId;
      const matching = (await requestResult(
        store
          .index("ownerEntity")
          .getAll([mutation.ownerScope, mutation.entityType, mutation.entityKey]),
      )) as OutboxMutation[];
      const coalescible = matching
        .filter((candidate) => canCoalesceMutation(candidate, mutation))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      const result = coalescible
        ? coalesceOutboxMutation(coalescible, mutation)
        : mutation;
      store.put(clone(result));
      return result;
    });
  }

  async listOutbox(ownerScope?: OwnerScope): Promise<OutboxMutation[]> {
    return this.read("outbox", async (transaction) => {
      const store = transaction.objectStore("outbox");
      const values = ownerScope
        ? await requestResult(store.index("ownerScope").getAll(ownerScope))
        : await requestResult(store.getAll());
      return (values as OutboxMutation[]).sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
    });
  }

  async updateOutbox(
    mutationId: string,
    patch: Partial<OutboxMutation>,
  ): Promise<OutboxMutation | null> {
    return this.write("outbox", async (transaction) => {
      const store = transaction.objectStore("outbox");
      const current = (await requestResult(store.get(mutationId))) as
        | OutboxMutation
        | undefined;
      if (!current) return null;
      const updated = {
        ...current,
        ...clone(patch),
        mutationId: current.mutationId,
        ownerScope: current.ownerScope,
        entityType: current.entityType,
        entityKey: current.entityKey,
        createdAt: current.createdAt,
      };
      store.put(updated);
      return updated;
    });
  }

  async removeOutbox(mutationId: string): Promise<void> {
    await this.write("outbox", async (transaction) => {
      transaction.objectStore("outbox").delete(mutationId);
    });
  }

  async listConflicts(ownerScope?: OwnerScope): Promise<SyncConflict[]> {
    return this.read("conflicts", async (transaction) => {
      const store = transaction.objectStore("conflicts");
      const values = ownerScope
        ? await requestResult(store.index("ownerScope").getAll(ownerScope))
        : await requestResult(store.getAll());
      return (values as SyncConflict[]).sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      );
    });
  }

  async putConflict(conflict: SyncConflict): Promise<void> {
    await this.write("conflicts", async (transaction) => {
      transaction.objectStore("conflicts").put(clone(conflict));
    });
  }

  async resolveConflict(
    conflict: SyncConflict,
    successor?: OutboxMutation,
  ): Promise<OutboxMutation | null> {
    return this.write(["conflicts", "outbox"], async (transaction) => {
      transaction.objectStore("conflicts").put(clone(conflict));
      const store = transaction.objectStore("outbox");
      store.delete(conflict.mutationId);
      if (!successor) return null;

      const sameId = (await requestResult(store.get(successor.mutationId))) as
        | OutboxMutation
        | undefined;
      if (sameId) return sameId;
      const matching = (await requestResult(
        store
          .index("ownerEntity")
          .getAll([
            successor.ownerScope,
            successor.entityType,
            successor.entityKey,
          ]),
      )) as OutboxMutation[];
      const coalescible = matching
        .filter((candidate) => canCoalesceMutation(candidate, successor))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      const result = coalescible
        ? coalesceOutboxMutation(coalescible, successor)
        : successor;
      store.put(clone(result));
      return result;
    });
  }

  async exportSyncSafetyBackup(
    ownerScope: OwnerScope,
    now: Date,
  ): Promise<SyncSafetyBackup> {
    return this.read(
      ["workspaces", "outbox", "conflicts"],
      async (transaction) => {
        const workspace = await requestResult(
          transaction.objectStore("workspaces").get(ownerScope),
        );
        const outbox = await requestResult(
          transaction.objectStore("outbox").index("ownerScope").getAll(ownerScope),
        );
        const conflicts = await requestResult(
          transaction.objectStore("conflicts").index("ownerScope").getAll(ownerScope),
        );
        return {
          format: "UMA_NOTE_OUTBOX_SAFETY_BACKUP_V1",
          createdAt: now.toISOString(),
          ownerScope,
          workspace: (workspace as WorkspaceSnapshot | undefined) ?? null,
          outbox: outbox as OutboxMutation[],
          conflicts: conflicts as SyncConflict[],
        };
      },
    );
  }

  async commitSyncResolution(
    input: SyncResolutionCommit,
  ): Promise<SyncResolutionCommitResult> {
    return this.write(
      ["workspaces", "outbox", "conflicts"],
      async (transaction) => {
        const outboxStore = transaction.objectStore("outbox");
        const original = (await requestResult(
          outboxStore.get(input.originalMutationId),
        )) as OutboxMutation | undefined;
        if (!original) {
          throw new Error("The original Outbox mutation no longer exists");
        }
        if (
          original.ownerScope !== input.workspace.ownerScope ||
          original.entityType !== input.entityType ||
          original.entityKey !== input.entityKey
        ) {
          throw new Error("The original Outbox mutation identity changed");
        }

        let successor: OutboxMutation | null = null;
        if (input.successor) {
          const candidate = input.successor;
          if (
            candidate.mutationId === original.mutationId ||
            candidate.predecessorMutationId !== original.mutationId ||
            candidate.ownerScope !== original.ownerScope ||
            candidate.entityType !== original.entityType ||
            candidate.entityKey !== original.entityKey
          ) {
            throw new Error("The successor mutation is not safely linked");
          }
          const matching = (await requestResult(
            outboxStore
              .index("ownerEntity")
              .getAll([original.ownerScope, original.entityType, original.entityKey]),
          )) as OutboxMutation[];
          const existingSuccessor = matching.find(
            (item) => item.predecessorMutationId === original.mutationId,
          );
          successor = existingSuccessor ?? candidate;
          if (!existingSuccessor) {
            await requestResult(outboxStore.put(clone(candidate)));
          }
        }

        if (input.resolvedConflict) {
          if (
            input.resolvedConflict.mutationId !== original.mutationId ||
            input.resolvedConflict.status !== "resolved" ||
            !input.resolvedConflict.resolution
          ) {
            throw new Error("The conflict resolution is incomplete");
          }
          await requestResult(
            transaction.objectStore("conflicts").put(
              clone(input.resolvedConflict),
            ),
          );
        }
        await requestResult(
          transaction.objectStore("workspaces").put(clone(input.workspace)),
        );
        for (const mutationId of input.supersededMutationIds ?? []) {
          if (mutationId === original.mutationId) {
            throw new Error("The original mutation cannot supersede itself");
          }
          const superseded = (await requestResult(
            outboxStore.get(mutationId),
          )) as OutboxMutation | undefined;
          if (
            !superseded ||
            !superseded.predecessorMutationId ||
            superseded.ownerScope !== original.ownerScope ||
            superseded.entityType !== original.entityType ||
            superseded.entityKey !== original.entityKey
          ) {
            throw new Error("A superseded mutation is not a linked successor");
          }
          await requestResult(outboxStore.delete(mutationId));
        }
        await requestResult(outboxStore.delete(original.mutationId));
        return { successor, originalRemoved: true };
      },
    );
  }

  async convergeRaceOutbox(
    input: RaceOutboxConvergenceInput,
  ): Promise<RaceOutboxConvergenceResult> {
    return this.write(
      ["workspaces", "outbox", "conflicts"],
      async (transaction) => {
        const outboxStore = transaction.objectStore("outbox");
        const matching = (await requestResult(
          outboxStore
            .index("ownerEntity")
            .getAll([input.workspace.ownerScope, "race", input.entityKey]),
        )) as OutboxMutation[];
        const expectedIds = new Set(input.items.map((item) => item.mutationId));
        if (
          expectedIds.size !== input.items.length ||
          matching.length !== input.items.length ||
          matching.some((mutation) => !expectedIds.has(mutation.mutationId))
        ) {
          throw new Error("The race Outbox changed before convergence");
        }

        const converged: OutboxMutation[] = [];
        for (const item of input.items) {
          const mutation = matching.find(
            (candidate) => candidate.mutationId === item.mutationId,
          );
          if (!mutation || mutation.status !== item.expectedStatus) {
            throw new Error("An Outbox mutation changed before convergence");
          }
          const archived: OutboxMutation = {
            ...mutation,
            status: item.terminalStatus,
            audit: {
              status: item.terminalStatus,
              convergedAt: input.convergedAt,
              cloudId: input.cloudId,
              cloudVersion: input.cloudVersion,
              reason: item.reason,
              ...(input.rebase
                ? { replacementMutationId: input.rebase.mutationId }
                : {}),
            },
            updatedAt: input.convergedAt,
            inFlightAt: undefined,
            lastError: item.reason,
          };
          await requestResult(outboxStore.put(clone(archived)));
          converged.push(archived);
        }

        let rebase: OutboxMutation<RaceRecord> | null = null;
        if (input.rebase) {
          const candidate = input.rebase;
          const payload = objectValue(candidate.payload);
          if (
            candidate.ownerScope !== input.workspace.ownerScope ||
            candidate.entityType !== "race" ||
            candidate.entityKey !== input.entityKey ||
            candidate.status !== "pending" ||
            candidate.deliveryPolicy !== "manual-review" ||
            candidate.expectedVersion !== input.cloudVersion ||
            candidate.predecessorMutationId !== undefined ||
            candidate.rebase?.kind !== "verified-receipt" ||
            candidate.rebase.receiptMutationId !==
              input.verifiedReceiptMutationId ||
            candidate.rebase.cloudId !== input.cloudId ||
            candidate.rebase.cloudVersion !== input.cloudVersion ||
            nonEmptyString(payload?.clientKey) !== input.entityKey ||
            payload?.dataScope !== "test" ||
            expectedIds.has(candidate.mutationId)
          ) {
            throw new Error("The rebased mutation is not safely anchored");
          }
          const sameId = await requestResult(outboxStore.get(candidate.mutationId));
          if (sameId) throw new Error("The rebased mutation id already exists");
          await requestResult(outboxStore.put(clone(candidate)));
          rebase = clone(candidate);
        }

        const conflictStore = transaction.objectStore("conflicts");
        const conflicts = (await requestResult(
          conflictStore.index("ownerScope").getAll(input.workspace.ownerScope),
        )) as SyncConflict[];
        let resolvedConflictCount = 0;
        for (const conflict of conflicts) {
          if (
            conflict.status === "unresolved" &&
            expectedIds.has(conflict.mutationId)
          ) {
            await requestResult(conflictStore.put(clone({
              ...conflict,
              status: "resolved",
              resolution: "superseded",
              resolvedAt: input.convergedAt,
            })));
            resolvedConflictCount += 1;
          }
        }
        await requestResult(
          transaction.objectStore("workspaces").put(clone(input.workspace)),
        );
        return {
          archivedCount: converged.length,
          resolvedConflictCount,
          rebase,
        };
      },
    );
  }

  async settleHeldRebaseConflict(
    input: HeldRebaseConflictSettlementInput,
  ): Promise<HeldRebaseConflictSettlementResult> {
    return this.write(["outbox", "conflicts"], async (transaction) => {
      const outboxStore = transaction.objectStore("outbox");
      const mutation = (await requestResult(
        outboxStore.get(input.mutationId),
      )) as OutboxMutation | undefined;
      if (
        !mutation ||
        mutation.ownerScope !== input.ownerScope ||
        mutation.entityType !== "race" ||
        mutation.entityKey !== input.entityKey ||
        mutation.status !== "conflict" ||
        mutation.deliveryPolicy !== "manual-review" ||
        mutation.expectedVersion !== input.cloudVersion ||
        mutation.rebase?.kind !== "verified-receipt" ||
        mutation.rebase.cloudId !== input.cloudId ||
        mutation.rebase.cloudVersion !== input.cloudVersion
      ) {
        throw new Error("The held rebase conflict evidence changed");
      }
      const conflictStore = transaction.objectStore("conflicts");
      const conflicts = (await requestResult(
        conflictStore.index("ownerScope").getAll(input.ownerScope),
      )) as SyncConflict[];
      const matching = conflicts.filter(
        (conflict) =>
          conflict.mutationId === input.mutationId &&
          conflict.status === "unresolved" &&
          conflict.entityType === "race" &&
          conflict.entityKey === input.entityKey &&
          conflict.remoteVersion === input.cloudVersion &&
          conflict.remoteSnapshot !== null,
      );
      if (matching.length !== 1) {
        throw new Error("The held rebase conflict is not uniquely verifiable");
      }
      const restored: OutboxMutation = {
        ...mutation,
        status: "pending",
        updatedAt: input.settledAt,
        inFlightAt: undefined,
        lastError: undefined,
      };
      await requestResult(outboxStore.put(clone(restored)));
      await requestResult(conflictStore.put(clone({
        ...matching[0]!,
        status: "resolved",
        resolution: "superseded",
        resolvedAt: input.settledAt,
      })));
      return { mutation: restored, resolvedConflictCount: 1 };
    });
  }

  async commitAppliedRebase(
    input: AppliedRebaseCommitInput,
  ): Promise<AppliedRebaseCommitResult> {
    return this.write(["workspaces", "outbox"], async (transaction) => {
      const outboxStore = transaction.objectStore("outbox");
      const mutation = (await requestResult(
        outboxStore.get(input.mutationId),
      )) as OutboxMutation | undefined;
      const payload = objectValue(mutation?.payload);
      const persistedRace = input.workspace.races.find(
        (race) => race.clientKey === input.entityKey,
      );
      if (
        !mutation ||
        mutation.ownerScope !== input.workspace.ownerScope ||
        mutation.entityType !== "race" ||
        mutation.entityKey !== input.entityKey ||
        mutation.status !== "pending" ||
        mutation.deliveryPolicy !== "manual-review" ||
        mutation.expectedVersion !== input.expectedVersion ||
        mutation.rebase?.kind !== "verified-receipt" ||
        mutation.rebase.cloudId !== input.cloudId ||
        mutation.rebase.cloudVersion !== input.expectedVersion ||
        input.receiptMutationId !== mutation.mutationId ||
        input.resultingVersion !== input.expectedVersion + 1 ||
        input.changeSequence < 1 ||
        nonEmptyString(payload?.clientKey) !== input.entityKey ||
        payload?.dataScope !== "test" ||
        !persistedRace ||
        persistedRace.clientKey !== input.entityKey ||
        persistedRace.dataScope !== "test" ||
        persistedRace.cloudId !== input.cloudId ||
        persistedRace.syncVersion !== input.resultingVersion
      ) {
        throw new Error("Applied rebase evidence is incomplete");
      }
      const applied: OutboxMutation = {
        ...mutation,
        status: "applied_audited",
        audit: {
          status: "applied_audited",
          convergedAt: input.completedAt,
          cloudId: input.cloudId,
          cloudVersion: input.resultingVersion,
          reason: "Verified receipt and change log; retained as applied audit history.",
          receiptMutationId: input.receiptMutationId,
          changeSequence: input.changeSequence,
        },
        updatedAt: input.completedAt,
        inFlightAt: undefined,
        lastError: undefined,
      };
      await requestResult(outboxStore.put(clone(applied)));
      await requestResult(
        transaction.objectStore("workspaces").put(clone(input.workspace)),
      );
      return { mutation: applied, workspace: clone(input.workspace) };
    });
  }

  async getMetadata(key: string): Promise<unknown> {
    return this.read("metadata", async (transaction) => {
      const record = (await requestResult(
        transaction.objectStore("metadata").get(key),
      )) as { key: string; value: unknown } | undefined;
      return record?.value;
    });
  }

  async setMetadata(key: string, value: unknown): Promise<void> {
    await this.write("metadata", async (transaction) => {
      transaction.objectStore("metadata").put({ key, value: clone(value) });
    });
  }

  close(): void {
    this.database.close();
  }
}

class StateDatabaseAdapter implements LocalDatabaseAdapter {
  readonly backend: "localstorage" | "memory";
  private state: LocalStorageState;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: Storage | null) {
    this.backend = storage ? "localstorage" : "memory";
    this.state = this.readState();
  }

  private readState(): LocalStorageState {
    if (!this.storage) return emptyState();
    try {
      const parsed = JSON.parse(this.storage.getItem(FALLBACK_STATE_KEY) ?? "null") as
        | Partial<LocalStorageState>
        | null;
      if (parsed?.version !== 2) return emptyState();
      return {
        version: 2,
        workspaces: parsed.workspaces ?? {},
        outbox: parsed.outbox ?? {},
        conflicts: parsed.conflicts ?? {},
        metadata: parsed.metadata ?? {},
      };
    } catch {
      return emptyState();
    }
  }

  private async afterQueued<T>(reader: () => T): Promise<T> {
    await this.queue.catch(() => undefined);
    return clone(reader());
  }

  private mutate<T>(mutation: (draft: LocalStorageState) => T): Promise<T> {
    const run = this.queue.then(() => {
      const draft = clone(this.state);
      const result = mutation(draft);
      if (this.storage) {
        // One write is the fallback's atomic boundary. If setItem throws, the
        // in-memory state is not advanced and the caller can retry later.
        this.storage.setItem(FALLBACK_STATE_KEY, JSON.stringify(draft));
      }
      this.state = draft;
      return clone(result);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  getWorkspace(ownerScope: OwnerScope): Promise<WorkspaceSnapshot | null> {
    return this.afterQueued(() => this.state.workspaces[ownerScope] ?? null);
  }

  replaceWorkspace(
    workspace: WorkspaceSnapshot,
    mutations: readonly OutboxMutation[],
  ): Promise<void> {
    return this.mutate((draft) => {
      draft.workspaces[workspace.ownerScope] = clone(workspace);
      for (const mutation of mutations) {
        const sameId = draft.outbox[mutation.mutationId];
        if (sameId) continue;
        const coalescible = Object.values(draft.outbox)
          .filter((candidate) => canCoalesceMutation(candidate, mutation))
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
        const result = coalescible
          ? coalesceOutboxMutation(coalescible, mutation)
          : mutation;
        draft.outbox[result.mutationId] = clone(result);
      }
    });
  }

  enqueueMutation(mutation: OutboxMutation): Promise<OutboxMutation> {
    return this.mutate((draft) => {
      const sameId = draft.outbox[mutation.mutationId];
      if (sameId) return sameId;
      const coalescible = Object.values(draft.outbox)
        .filter((candidate) => canCoalesceMutation(candidate, mutation))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      const result = coalescible
        ? coalesceOutboxMutation(coalescible, mutation)
        : mutation;
      draft.outbox[result.mutationId] = clone(result);
      return result;
    });
  }

  listOutbox(ownerScope?: OwnerScope): Promise<OutboxMutation[]> {
    return this.afterQueued(() =>
      Object.values(this.state.outbox)
        .filter((mutation) => !ownerScope || mutation.ownerScope === ownerScope)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    );
  }

  updateOutbox(
    mutationId: string,
    patch: Partial<OutboxMutation>,
  ): Promise<OutboxMutation | null> {
    return this.mutate((draft) => {
      const current = draft.outbox[mutationId];
      if (!current) return null;
      const updated = {
        ...current,
        ...clone(patch),
        mutationId,
        ownerScope: current.ownerScope,
        entityType: current.entityType,
        entityKey: current.entityKey,
        createdAt: current.createdAt,
      };
      draft.outbox[mutationId] = updated;
      return updated;
    });
  }

  removeOutbox(mutationId: string): Promise<void> {
    return this.mutate((draft) => {
      delete draft.outbox[mutationId];
    });
  }

  listConflicts(ownerScope?: OwnerScope): Promise<SyncConflict[]> {
    return this.afterQueued(() =>
      Object.values(this.state.conflicts)
        .filter((conflict) => !ownerScope || conflict.ownerScope === ownerScope)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    );
  }

  putConflict(conflict: SyncConflict): Promise<void> {
    return this.mutate((draft) => {
      draft.conflicts[conflict.conflictId] = clone(conflict);
    });
  }

  resolveConflict(
    conflict: SyncConflict,
    successor?: OutboxMutation,
  ): Promise<OutboxMutation | null> {
    return this.mutate((draft) => {
      draft.conflicts[conflict.conflictId] = clone(conflict);
      delete draft.outbox[conflict.mutationId];
      if (!successor) return null;

      const sameId = draft.outbox[successor.mutationId];
      if (sameId) return sameId;
      const coalescible = Object.values(draft.outbox)
        .filter((candidate) => canCoalesceMutation(candidate, successor))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      const result = coalescible
        ? coalesceOutboxMutation(coalescible, successor)
        : successor;
      draft.outbox[result.mutationId] = clone(result);
      return result;
    });
  }

  exportSyncSafetyBackup(
    ownerScope: OwnerScope,
    now: Date,
  ): Promise<SyncSafetyBackup> {
    return this.afterQueued(() => ({
      format: "UMA_NOTE_OUTBOX_SAFETY_BACKUP_V1",
      createdAt: now.toISOString(),
      ownerScope,
      workspace: clone(this.state.workspaces[ownerScope] ?? null),
      outbox: Object.values(this.state.outbox).filter(
        (mutation) => mutation.ownerScope === ownerScope,
      ),
      conflicts: Object.values(this.state.conflicts).filter(
        (conflict) => conflict.ownerScope === ownerScope,
      ),
    }));
  }

  commitSyncResolution(
    input: SyncResolutionCommit,
  ): Promise<SyncResolutionCommitResult> {
    return this.mutate((draft) => {
      const original = draft.outbox[input.originalMutationId];
      if (!original) {
        throw new Error("The original Outbox mutation no longer exists");
      }
      if (
        original.ownerScope !== input.workspace.ownerScope ||
        original.entityType !== input.entityType ||
        original.entityKey !== input.entityKey
      ) {
        throw new Error("The original Outbox mutation identity changed");
      }

      let successor: OutboxMutation | null = null;
      if (input.successor) {
        const candidate = input.successor;
        if (
          candidate.mutationId === original.mutationId ||
          candidate.predecessorMutationId !== original.mutationId ||
          candidate.ownerScope !== original.ownerScope ||
          candidate.entityType !== original.entityType ||
          candidate.entityKey !== original.entityKey
        ) {
          throw new Error("The successor mutation is not safely linked");
        }
        const matching = Object.values(draft.outbox).filter(
          (item) =>
            item.ownerScope === original.ownerScope &&
            item.entityType === original.entityType &&
            item.entityKey === original.entityKey,
        );
        const existingSuccessor = matching.find(
          (item) => item.predecessorMutationId === original.mutationId,
        );
        successor = existingSuccessor ?? candidate;
        draft.outbox[successor.mutationId] = clone(successor);
      }

      if (input.resolvedConflict) {
        if (
          input.resolvedConflict.mutationId !== original.mutationId ||
          input.resolvedConflict.status !== "resolved" ||
          !input.resolvedConflict.resolution
        ) {
          throw new Error("The conflict resolution is incomplete");
        }
        draft.conflicts[input.resolvedConflict.conflictId] =
          clone(input.resolvedConflict);
      }
      draft.workspaces[input.workspace.ownerScope] = clone(input.workspace);
      for (const mutationId of input.supersededMutationIds ?? []) {
        if (mutationId === original.mutationId) {
          throw new Error("The original mutation cannot supersede itself");
        }
        const superseded = draft.outbox[mutationId];
        if (
          !superseded ||
          !superseded.predecessorMutationId ||
          superseded.ownerScope !== original.ownerScope ||
          superseded.entityType !== original.entityType ||
          superseded.entityKey !== original.entityKey
        ) {
          throw new Error("A superseded mutation is not a linked successor");
        }
        delete draft.outbox[mutationId];
      }
      delete draft.outbox[original.mutationId];
      return { successor, originalRemoved: true };
    });
  }

  convergeRaceOutbox(
    input: RaceOutboxConvergenceInput,
  ): Promise<RaceOutboxConvergenceResult> {
    return this.mutate((draft) => {
      const matching = Object.values(draft.outbox).filter(
        (mutation) =>
          mutation.ownerScope === input.workspace.ownerScope &&
          mutation.entityType === "race" &&
          mutation.entityKey === input.entityKey,
      );
      const expectedIds = new Set(input.items.map((item) => item.mutationId));
      if (
        expectedIds.size !== input.items.length ||
        matching.length !== input.items.length ||
        matching.some((mutation) => !expectedIds.has(mutation.mutationId))
      ) {
        throw new Error("The race Outbox changed before convergence");
      }

      for (const item of input.items) {
        const mutation = draft.outbox[item.mutationId];
        if (!mutation || mutation.status !== item.expectedStatus) {
          throw new Error("An Outbox mutation changed before convergence");
        }
        draft.outbox[item.mutationId] = clone({
          ...mutation,
          status: item.terminalStatus,
          audit: {
            status: item.terminalStatus,
            convergedAt: input.convergedAt,
            cloudId: input.cloudId,
            cloudVersion: input.cloudVersion,
            reason: item.reason,
            ...(input.rebase
              ? { replacementMutationId: input.rebase.mutationId }
              : {}),
          },
          updatedAt: input.convergedAt,
          inFlightAt: undefined,
          lastError: item.reason,
        });
      }

      let rebase: OutboxMutation<RaceRecord> | null = null;
      if (input.rebase) {
        const candidate = input.rebase;
        const payload = objectValue(candidate.payload);
        if (
          candidate.ownerScope !== input.workspace.ownerScope ||
          candidate.entityType !== "race" ||
          candidate.entityKey !== input.entityKey ||
          candidate.status !== "pending" ||
          candidate.deliveryPolicy !== "manual-review" ||
          candidate.expectedVersion !== input.cloudVersion ||
          candidate.predecessorMutationId !== undefined ||
          candidate.rebase?.kind !== "verified-receipt" ||
          candidate.rebase.receiptMutationId !==
            input.verifiedReceiptMutationId ||
          candidate.rebase.cloudId !== input.cloudId ||
          candidate.rebase.cloudVersion !== input.cloudVersion ||
          nonEmptyString(payload?.clientKey) !== input.entityKey ||
          payload?.dataScope !== "test" ||
          expectedIds.has(candidate.mutationId) ||
          draft.outbox[candidate.mutationId]
        ) {
          throw new Error("The rebased mutation is not safely anchored");
        }
        draft.outbox[candidate.mutationId] = clone(candidate);
        rebase = clone(candidate);
      }

      let resolvedConflictCount = 0;
      for (const [conflictId, conflict] of Object.entries(draft.conflicts)) {
        if (
          conflict.ownerScope === input.workspace.ownerScope &&
          conflict.status === "unresolved" &&
          expectedIds.has(conflict.mutationId)
        ) {
          draft.conflicts[conflictId] = clone({
            ...conflict,
            status: "resolved",
            resolution: "superseded",
            resolvedAt: input.convergedAt,
          });
          resolvedConflictCount += 1;
        }
      }
      draft.workspaces[input.workspace.ownerScope] = clone(input.workspace);
      return {
        archivedCount: input.items.length,
        resolvedConflictCount,
        rebase,
      };
    });
  }

  settleHeldRebaseConflict(
    input: HeldRebaseConflictSettlementInput,
  ): Promise<HeldRebaseConflictSettlementResult> {
    return this.mutate((draft) => {
      const mutation = draft.outbox[input.mutationId];
      if (
        !mutation ||
        mutation.ownerScope !== input.ownerScope ||
        mutation.entityType !== "race" ||
        mutation.entityKey !== input.entityKey ||
        mutation.status !== "conflict" ||
        mutation.deliveryPolicy !== "manual-review" ||
        mutation.expectedVersion !== input.cloudVersion ||
        mutation.rebase?.kind !== "verified-receipt" ||
        mutation.rebase.cloudId !== input.cloudId ||
        mutation.rebase.cloudVersion !== input.cloudVersion
      ) {
        throw new Error("The held rebase conflict evidence changed");
      }
      const matching = Object.values(draft.conflicts).filter(
        (conflict) =>
          conflict.mutationId === input.mutationId &&
          conflict.status === "unresolved" &&
          conflict.entityType === "race" &&
          conflict.entityKey === input.entityKey &&
          conflict.remoteVersion === input.cloudVersion &&
          conflict.remoteSnapshot !== null,
      );
      if (matching.length !== 1) {
        throw new Error("The held rebase conflict is not uniquely verifiable");
      }
      const restored: OutboxMutation = {
        ...mutation,
        status: "pending",
        updatedAt: input.settledAt,
        inFlightAt: undefined,
        lastError: undefined,
      };
      draft.outbox[mutation.mutationId] = clone(restored);
      const conflict = matching[0]!;
      draft.conflicts[conflict.conflictId] = clone({
        ...conflict,
        status: "resolved",
        resolution: "superseded",
        resolvedAt: input.settledAt,
      });
      return { mutation: restored, resolvedConflictCount: 1 };
    });
  }

  commitAppliedRebase(
    input: AppliedRebaseCommitInput,
  ): Promise<AppliedRebaseCommitResult> {
    return this.mutate((draft) => {
      const mutation = draft.outbox[input.mutationId];
      const payload = objectValue(mutation?.payload);
      const persistedRace = input.workspace.races.find(
        (race) => race.clientKey === input.entityKey,
      );
      if (
        !mutation ||
        mutation.ownerScope !== input.workspace.ownerScope ||
        mutation.entityType !== "race" ||
        mutation.entityKey !== input.entityKey ||
        mutation.status !== "pending" ||
        mutation.deliveryPolicy !== "manual-review" ||
        mutation.expectedVersion !== input.expectedVersion ||
        mutation.rebase?.kind !== "verified-receipt" ||
        mutation.rebase.cloudId !== input.cloudId ||
        mutation.rebase.cloudVersion !== input.expectedVersion ||
        input.receiptMutationId !== mutation.mutationId ||
        input.resultingVersion !== input.expectedVersion + 1 ||
        input.changeSequence < 1 ||
        nonEmptyString(payload?.clientKey) !== input.entityKey ||
        payload?.dataScope !== "test" ||
        !persistedRace ||
        persistedRace.clientKey !== input.entityKey ||
        persistedRace.dataScope !== "test" ||
        persistedRace.cloudId !== input.cloudId ||
        persistedRace.syncVersion !== input.resultingVersion
      ) {
        throw new Error("Applied rebase evidence is incomplete");
      }
      const applied: OutboxMutation = {
        ...mutation,
        status: "applied_audited",
        audit: {
          status: "applied_audited",
          convergedAt: input.completedAt,
          cloudId: input.cloudId,
          cloudVersion: input.resultingVersion,
          reason: "Verified receipt and change log; retained as applied audit history.",
          receiptMutationId: input.receiptMutationId,
          changeSequence: input.changeSequence,
        },
        updatedAt: input.completedAt,
        inFlightAt: undefined,
        lastError: undefined,
      };
      draft.outbox[mutation.mutationId] = clone(applied);
      draft.workspaces[input.workspace.ownerScope] = clone(input.workspace);
      return { mutation: applied, workspace: clone(input.workspace) };
    });
  }

  getMetadata(key: string): Promise<unknown> {
    return this.afterQueued(() => this.state.metadata[key]);
  }

  setMetadata(key: string, value: unknown): Promise<void> {
    return this.mutate((draft) => {
      draft.metadata[key] = clone(value);
    });
  }

  close(): void {
    // Nothing to release for the fallback adapters.
  }
}

async function openIndexedDatabase(
  factory: IDBFactory,
  name: string,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(name, DATABASE_VERSION);
    } catch (error) {
      reject(error);
      return;
    }

    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("workspaces")) {
        database.createObjectStore("workspaces", { keyPath: "ownerScope" });
      }
      if (!database.objectStoreNames.contains("outbox")) {
        const outbox = database.createObjectStore("outbox", { keyPath: "mutationId" });
        outbox.createIndex("ownerScope", "ownerScope", { unique: false });
        outbox.createIndex(
          "ownerEntity",
          ["ownerScope", "entityType", "entityKey"],
          { unique: false },
        );
      }
      if (!database.objectStoreNames.contains("conflicts")) {
        const conflicts = database.createObjectStore("conflicts", {
          keyPath: "conflictId",
        });
        conflicts.createIndex("ownerScope", "ownerScope", { unique: false });
      }
      if (!database.objectStoreNames.contains("metadata")) {
        database.createObjectStore("metadata", { keyPath: "key" });
      }
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("Unable to open IndexedDB")),
      { once: true },
    );
    request.addEventListener(
      "blocked",
      () => reject(new Error("IndexedDB upgrade is blocked by another tab")),
      { once: true },
    );
  });
}

function safelyGetBrowserStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined"
      ? null
      : globalThis.localStorage;
  } catch {
    return null;
  }
}

function safelyGetBrowserIndexedDB(): IDBFactory | null {
  try {
    return typeof globalThis.indexedDB === "undefined" ? null : globalThis.indexedDB;
  } catch {
    return null;
  }
}

function parseLegacyArray(storage: Storage | null, key: string): unknown[] | null {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(key) ?? "null") as unknown;
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function migrateLegacyV1(
  adapter: LocalDatabaseAdapter,
  storage: Storage | null,
  ownerScope: OwnerScope,
  now: () => Date,
  randomUUID?: () => string,
): Promise<void> {
  if (!storage || (await adapter.getMetadata(LEGACY_MIGRATION_KEY))) return;

  const races = parseLegacyArray(storage, LEGACY_RACES_KEY);
  const rules = parseLegacyArray(storage, LEGACY_RULES_KEY);
  const dirtyRaceIds = parseLegacyArray(storage, LEGACY_DIRTY_RACES_KEY)?.filter(
    (value): value is string => typeof value === "string",
  );
  let activeRaceId: string | undefined;
  try {
    activeRaceId = storage.getItem(LEGACY_ACTIVE_RACE_KEY) || undefined;
  } catch {
    activeRaceId = undefined;
  }

  const existing = await adapter.getWorkspace(ownerScope);
  if (!existing && (races || rules || activeRaceId)) {
    const timestamp = now().toISOString();
    const normalizedRaces = ((races ?? []) as LegacyRaceRecord[]).map((race) =>
      backfillRaceClientKey(race) as RaceRecord
    );
    const workspace: WorkspaceSnapshot = {
      ownerScope,
      races: normalizedRaces,
      rules: (rules ?? []) as WorkspaceSnapshot["rules"],
      settings: activeRaceId ? { activeRaceId } : {},
      updatedAt: timestamp,
    };
    const byId = new Map(workspace.races.map((race) => [race.id, race]));
    const mutations = (dirtyRaceIds ?? [])
      .map((id) => byId.get(id))
      .filter(
        (race): race is WorkspaceSnapshot["races"][number] => race !== undefined,
      )
      .map((race) =>
        createOutboxMutation(
          {
            ownerScope,
            entityType: "race",
            entityKey: race.id,
            payload: race,
            baseSnapshot: null,
            expectedVersion: null,
          },
          { now, randomUUID },
        ),
      );
    await adapter.replaceWorkspace(workspace, mutations);
  }

  // Legacy keys are intentionally retained as a recoverable backup.
  await adapter.setMetadata(LEGACY_MIGRATION_KEY, {
    ownerScope,
    migratedAt: now().toISOString(),
  });
}

/** Opens IndexedDB first, falling back to one localStorage document, then RAM. */
export async function openLocalDatabase(
  options: OpenLocalDatabaseOptions = {},
): Promise<LocalDatabase> {
  const name = options.name ?? DATABASE_NAME;
  const storage =
    options.localStorage === undefined
      ? safelyGetBrowserStorage()
      : options.localStorage;
  const factory =
    options.indexedDB === undefined
      ? safelyGetBrowserIndexedDB()
      : options.indexedDB;
  let adapter: LocalDatabaseAdapter;

  if (factory) {
    try {
      adapter = new IndexedDatabaseAdapter(await openIndexedDatabase(factory, name));
    } catch {
      adapter = new StateDatabaseAdapter(storage);
    }
  } else {
    adapter = new StateDatabaseAdapter(storage);
  }

  const legacyOwnerScope = options.legacyOwnerScope ?? LEGACY_OWNER_SCOPE;
  const clock = options.now ?? (() => new Date());
  try {
    await migrateLegacyV1(
      adapter,
      storage,
      legacyOwnerScope,
      clock,
      options.randomUUID,
    );
  } catch {
    adapter.close();
    // A database can open successfully and still fail later (private mode,
    // quota, blocked transaction). Preserve access by stepping down through
    // localStorage and finally RAM while still reading the v1 backup.
    adapter = new StateDatabaseAdapter(
      adapter.backend === "localstorage" ? null : storage,
    );
    try {
      await migrateLegacyV1(
        adapter,
        storage,
        legacyOwnerScope,
        clock,
        options.randomUUID,
      );
    } catch {
      adapter = new StateDatabaseAdapter(null);
      await migrateLegacyV1(
        adapter,
        storage,
        legacyOwnerScope,
        clock,
        options.randomUUID,
      );
    }
  }

  return {
    name,
    backend: adapter.backend,
    close: () => adapter.close(),
    [INTERNAL]: adapter,
  };
}

export function getWorkspace(
  database: LocalDatabase,
  ownerScope: OwnerScope,
): Promise<WorkspaceSnapshot | null> {
  return (async () => {
    const adapter = database[INTERNAL];
    const workspace = await adapter.getWorkspace(ownerScope);
    if (!workspace) return null;
    const storedMutations = await adapter.listOutbox(ownerScope);
    const normalizedMutations: OutboxMutation[] = [];
    for (const stored of storedMutations) {
      const normalized = normalizeRaceOutboxMutation(stored);
      normalizedMutations.push(normalized.mutation);
      if (normalized.changed) {
        await adapter.updateOutbox(stored.mutationId, {
          payload: normalized.mutation.payload,
        });
      }
    }
    const normalizedWorkspace = normalizeWorkspaceRaceClientKeys(
      workspace,
      normalizedMutations,
    );
    if (normalizedWorkspace.changed) {
      await adapter.replaceWorkspace(normalizedWorkspace.workspace, []);
    }
    return normalizedWorkspace.workspace;
  })();
}

/**
 * Atomically writes the race/rule/settings snapshot and any corresponding
 * outbox intents. Every mutation must belong to the same owner workspace.
 */
export function replaceWorkspace(
  database: LocalDatabase,
  workspace: WorkspaceSnapshot,
  mutations: readonly OutboxMutation[] = [],
): Promise<void> {
  if (mutations.some((mutation) => mutation.ownerScope !== workspace.ownerScope)) {
    return Promise.reject(new Error("Workspace and outbox owner scopes must match"));
  }
  const normalizedMutations = mutations.map(
    (mutation) => normalizeRaceOutboxMutation(mutation).mutation,
  );
  const normalizedWorkspace = normalizeWorkspaceRaceClientKeys(
    workspace,
    normalizedMutations,
  ).workspace;
  return database[INTERNAL].replaceWorkspace(
    clone(normalizedWorkspace),
    clone(normalizedMutations),
  );
}

export function enqueueMutation(
  database: LocalDatabase,
  mutation: OutboxMutation,
): Promise<OutboxMutation> {
  return database[INTERNAL].enqueueMutation(
    clone(normalizeRaceOutboxMutation(mutation).mutation),
  );
}

export function listOutbox(
  database: LocalDatabase,
  ownerScope?: OwnerScope,
): Promise<OutboxMutation[]> {
  return (async () => {
    const adapter = database[INTERNAL];
    const stored = await adapter.listOutbox(ownerScope);
    const normalized: OutboxMutation[] = [];
    for (const mutation of stored) {
      const result = normalizeRaceOutboxMutation(mutation);
      normalized.push(result.mutation);
      if (result.changed) {
        await adapter.updateOutbox(mutation.mutationId, {
          payload: result.mutation.payload,
        });
      }
    }
    return normalized;
  })();
}

export function updateOutbox(
  database: LocalDatabase,
  mutationId: string,
  patch: Partial<OutboxMutation>,
): Promise<OutboxMutation | null> {
  return database[INTERNAL].updateOutbox(mutationId, clone(patch));
}

export function removeOutbox(
  database: LocalDatabase,
  mutationId: string,
): Promise<void> {
  return database[INTERNAL].removeOutbox(mutationId);
}

export function listConflicts(
  database: LocalDatabase,
  ownerScope?: OwnerScope,
): Promise<SyncConflict[]> {
  return database[INTERNAL].listConflicts(ownerScope);
}

export function putConflict(
  database: LocalDatabase,
  conflict: SyncConflict,
): Promise<void> {
  return database[INTERNAL].putConflict(clone(conflict));
}

/**
 * Marks a conflict resolved, removes its stale mutation, and optionally queues
 * the chosen local successor inside one durable transaction.
 */
export function resolveConflict(
  database: LocalDatabase,
  conflict: SyncConflict,
  successor?: OutboxMutation,
): Promise<OutboxMutation | null> {
  if (conflict.status !== "resolved" || !conflict.resolution) {
    return Promise.reject(new Error("A conflict must be resolved before committing it"));
  }
  if (
    successor &&
    (successor.ownerScope !== conflict.ownerScope ||
      successor.entityType !== conflict.entityType ||
      successor.entityKey !== conflict.entityKey)
  ) {
    return Promise.reject(
      new Error("Conflict successor must target the same owner and entity"),
    );
  }
  return database[INTERNAL].resolveConflict(
    clone(conflict),
    successor
      ? clone(normalizeRaceOutboxMutation(successor).mutation)
      : undefined,
  );
}

export function exportSyncSafetyBackup(
  database: LocalDatabase,
  ownerScope: OwnerScope,
  now: Date = new Date(),
): Promise<SyncSafetyBackup> {
  return database[INTERNAL].exportSyncSafetyBackup(ownerScope, now);
}

/**
 * Persists cloud identity/version metadata, an optional successor mutation,
 * the resolved conflict marker, and retirement of the original mutation in
 * one local transaction. Any failure leaves the original mutation untouched.
 */
export function commitSyncResolution(
  database: LocalDatabase,
  input: SyncResolutionCommit,
): Promise<SyncResolutionCommitResult> {
  if (input.workspace.ownerScope.trim() === "") {
    return Promise.reject(new Error("A workspace owner is required"));
  }
  if (
    input.successor &&
    (input.successor.ownerScope !== input.workspace.ownerScope ||
      input.successor.entityType !== input.entityType ||
      input.successor.entityKey !== input.entityKey)
  ) {
    return Promise.reject(
      new Error("The successor must target the same owner and entity"),
    );
  }
  return database[INTERNAL].commitSyncResolution({
    ...clone(input),
    successor: input.successor
      ? clone(normalizeRaceOutboxMutation(input.successor).mutation)
      : undefined,
  });
}

/**
 * Retains stale/conflicted writes as terminal audit records and optionally
 * appends one manually held, receipt-anchored rebase in the same transaction.
 * No Outbox record is physically deleted.
 */
export function convergeRaceOutbox(
  database: LocalDatabase,
  input: RaceOutboxConvergenceInput,
): Promise<RaceOutboxConvergenceResult> {
  if (
    input.workspace.ownerScope.trim() === "" ||
    input.entityKey.trim() === "" ||
    input.cloudId.trim() === "" ||
    input.verifiedReceiptMutationId.trim() === "" ||
    input.cloudVersion < 1 ||
    input.items.length === 0
  ) {
    return Promise.reject(new Error("Race Outbox convergence evidence is incomplete"));
  }
  return database[INTERNAL].convergeRaceOutbox(clone(input));
}

/**
 * Clears a pull-generated conflict for a verified, manually held rebase
 * without deleting or transmitting the mutation.
 */
export function settleHeldRebaseConflict(
  database: LocalDatabase,
  input: HeldRebaseConflictSettlementInput,
): Promise<HeldRebaseConflictSettlementResult> {
  if (
    input.ownerScope.trim() === "" ||
    input.mutationId.trim() === "" ||
    input.entityKey.trim() === "" ||
    input.cloudId.trim() === "" ||
    input.cloudVersion < 1
  ) {
    return Promise.reject(new Error("Held rebase evidence is incomplete"));
  }
  return database[INTERNAL].settleHeldRebaseConflict(clone(input));
}

/**
 * Persists verified cloud v2 metadata and retires a manually held rebase into
 * terminal audit history. The mutation is retained rather than deleted.
 */
export function commitAppliedRebase(
  database: LocalDatabase,
  input: AppliedRebaseCommitInput,
): Promise<AppliedRebaseCommitResult> {
  if (
    input.workspace.ownerScope.trim() === "" ||
    input.mutationId.trim() === "" ||
    input.entityKey.trim() === "" ||
    input.cloudId.trim() === "" ||
    input.receiptMutationId.trim() === "" ||
    input.expectedVersion < 1 ||
    input.resultingVersion !== input.expectedVersion + 1 ||
    input.changeSequence < 1
  ) {
    return Promise.reject(new Error("Applied rebase evidence is incomplete"));
  }
  return database[INTERNAL].commitAppliedRebase(clone(input));
}

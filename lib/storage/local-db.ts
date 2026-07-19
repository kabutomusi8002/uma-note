import type {
  OutboxMutation,
  OwnerScope,
  SyncConflict,
  WorkspaceSnapshot,
} from "../sync/types";
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
    const workspace: WorkspaceSnapshot = {
      ownerScope,
      races: (races ?? []) as WorkspaceSnapshot["races"],
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
  return database[INTERNAL].getWorkspace(ownerScope);
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
  return database[INTERNAL].replaceWorkspace(clone(workspace), clone(mutations));
}

export function enqueueMutation(
  database: LocalDatabase,
  mutation: OutboxMutation,
): Promise<OutboxMutation> {
  return database[INTERNAL].enqueueMutation(clone(mutation));
}

export function listOutbox(
  database: LocalDatabase,
  ownerScope?: OwnerScope,
): Promise<OutboxMutation[]> {
  return database[INTERNAL].listOutbox(ownerScope);
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
    successor ? clone(successor) : undefined,
  );
}

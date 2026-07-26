import type { RaceRecord } from "../types";
import type {
  OutboxMutation,
  SyncConflict,
  WorkspaceSnapshot,
} from "./types";
import { createOutboxMutation } from "./outbox";
import { raceToDatabasePayload } from "../supabase/race-repository";

export interface CloudRaceState {
  cloudId: string;
  clientKey: string;
  version: number;
  race: RaceRecord;
}

export interface PreparedRaceResolution {
  workspace: WorkspaceSnapshot;
  successor: OutboxMutation<RaceRecord> | null;
  nameChanged: boolean;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function semanticRace(
  race: RaceRecord,
  options: { omitName?: boolean } = {},
): unknown {
  const payload = raceToDatabasePayload(race);
  if (!options.omitName) return payload;
  const racePayload = object(payload.race);
  return {
    ...payload,
    race: Object.fromEntries(
      Object.entries(racePayload).filter(([key]) => key !== "name"),
    ),
  };
}

export function raceNameIsOnlyDifference(
  local: RaceRecord,
  cloud: RaceRecord,
): boolean {
  return local.name !== cloud.name &&
    sameRace(local, cloud, { omitName: true });
}

function sameRace(
  left: RaceRecord,
  right: RaceRecord,
  options?: { omitName?: boolean },
): boolean {
  return canonical(semanticRace(left, options)) ===
    canonical(semanticRace(right, options));
}

function normalizedNaturalKey(race: RaceRecord): string {
  const payload = raceToDatabasePayload(race);
  const meeting = object(payload.meeting);
  const racePayload = object(payload.race);
  const racecourse = object(meeting.racecourse);
  return canonical({
    course: racecourse.code,
    date: meeting.meeting_date,
    meetingNumber: meeting.meeting_number,
    raceNumber: racePayload.race_number,
  });
}

function mutationRace(mutation: OutboxMutation): RaceRecord {
  if (
    mutation.entityType !== "race" ||
    mutation.operation !== "upsert" ||
    mutation.payload === null ||
    typeof mutation.payload !== "object"
  ) {
    throw new Error("A complete race upsert mutation is required");
  }
  return mutation.payload as RaceRecord;
}

function findLocalRace(
  workspace: WorkspaceSnapshot,
  mutation: OutboxMutation,
  payload: RaceRecord,
): RaceRecord {
  const race = workspace.races.find(
    (candidate) =>
      candidate.clientKey === mutation.entityKey ||
      candidate.id === payload.id,
  );
  if (!race) throw new Error("The local race no longer exists");
  return race;
}

function assertStableIdentity(
  local: RaceRecord,
  payload: RaceRecord,
  cloud: CloudRaceState,
  entityKey: string,
): void {
  if (
    local.clientKey !== entityKey ||
    payload.clientKey !== entityKey ||
    cloud.clientKey !== entityKey ||
    cloud.race.clientKey !== entityKey
  ) {
    throw new Error("The race clientKey changed");
  }
  if (
    normalizedNaturalKey(local) !== normalizedNaturalKey(payload) ||
    normalizedNaturalKey(payload) !== normalizedNaturalKey(cloud.race)
  ) {
    throw new Error("The race natural key changed");
  }
  if (
    local.dataScope !== payload.dataScope ||
    payload.dataScope !== cloud.race.dataScope
  ) {
    throw new Error("The race data scope changed");
  }
}

function workspaceWithCloudRace(
  workspace: WorkspaceSnapshot,
  local: RaceRecord,
  nextRace: RaceRecord,
  cloud: CloudRaceState,
  now: Date,
): WorkspaceSnapshot {
  const cloudSync = object(workspace.settings.cloudSync);
  const versions = { ...object(cloudSync.versions) };
  const bases = { ...object(cloudSync.bases) };
  const cloudIds = { ...object(cloudSync.cloudIds) };
  const syncKey = `race:${cloud.clientKey}`;
  versions[syncKey] = cloud.version;
  bases[syncKey] = cloud.race;
  cloudIds[syncKey] = cloud.cloudId;
  return {
    ...workspace,
    races: workspace.races.map((race) =>
      race.id === local.id
        ? {
            ...nextRace,
            id: local.id,
            clientKey: cloud.clientKey,
            cloudId: cloud.cloudId,
            syncVersion: cloud.version,
          }
        : race,
    ),
    settings: {
      ...workspace.settings,
      cloudSync: {
        ...cloudSync,
        versions,
        bases,
        cloudIds,
      },
    },
    updatedAt: now.toISOString(),
  };
}

export function prepareAppliedRaceRecovery(input: {
  workspace: WorkspaceSnapshot;
  original: OutboxMutation;
  cloud: CloudRaceState;
  receiptVerified: boolean;
  now?: Date;
  randomUUID?: () => string;
}): PreparedRaceResolution {
  if (!input.receiptVerified) {
    throw new Error("A matching mutation receipt is required");
  }
  const payload = mutationRace(input.original);
  const local = findLocalRace(input.workspace, input.original, payload);
  assertStableIdentity(local, payload, input.cloud, input.original.entityKey);
  if (!sameRace(payload, input.cloud.race)) {
    throw new Error("The receipt payload and cloud race differ");
  }
  if (!sameRace(local, payload, { omitName: true })) {
    throw new Error("The local race changed in fields other than the name");
  }
  const now = input.now ?? new Date();
  const nameChanged = local.name !== payload.name;
  const nextLocal: RaceRecord = {
    ...local,
    cloudId: input.cloud.cloudId,
    syncVersion: input.cloud.version,
  };
  const workspace = workspaceWithCloudRace(
    input.workspace,
    local,
    nextLocal,
    input.cloud,
    now,
  );
  const successor = nameChanged
    ? createOutboxMutation<RaceRecord>(
        {
          ownerScope: input.original.ownerScope,
          entityType: "race",
          entityKey: input.original.entityKey,
          payload: nextLocal,
          baseSnapshot: input.cloud.race,
          expectedVersion: input.cloud.version,
          predecessorMutationId: input.original.mutationId,
        },
        { now: () => now, randomUUID: input.randomUUID },
      )
    : null;
  return { workspace, successor, nameChanged };
}

export function prepareRaceConflictResolution(input: {
  workspace: WorkspaceSnapshot;
  original: OutboxMutation;
  conflict: SyncConflict;
  cloud: CloudRaceState;
  choice: "cloud" | "local";
  now?: Date;
  randomUUID?: () => string;
}): PreparedRaceResolution & { resolvedConflict: SyncConflict } {
  const payload = mutationRace(input.original);
  const local = findLocalRace(input.workspace, input.original, payload);
  assertStableIdentity(local, payload, input.cloud, input.original.entityKey);
  if (
    input.conflict.mutationId !== input.original.mutationId ||
    input.conflict.entityKey !== input.original.entityKey ||
    input.conflict.status !== "unresolved"
  ) {
    throw new Error("The stored conflict no longer matches the Outbox mutation");
  }
  if (input.conflict.remoteVersion !== input.cloud.version) {
    throw new Error("The cloud version changed after the comparison");
  }
  if (!sameRace(local, input.cloud.race, { omitName: true })) {
    throw new Error("The race differs in fields other than the name");
  }

  const now = input.now ?? new Date();
  const nameChanged = local.name !== input.cloud.race.name;
  if (!nameChanged) {
    throw new Error("The race-name conflict no longer exists");
  }
  const nextLocal: RaceRecord = {
    ...local,
    ...(input.choice === "cloud" ? { name: input.cloud.race.name } : {}),
    cloudId: input.cloud.cloudId,
    syncVersion: input.cloud.version,
  };
  const workspace = workspaceWithCloudRace(
    input.workspace,
    local,
    nextLocal,
    input.cloud,
    now,
  );
  const successor = input.choice === "local"
    ? createOutboxMutation<RaceRecord>(
        {
          ownerScope: input.original.ownerScope,
          entityType: "race",
          entityKey: input.original.entityKey,
          payload: nextLocal,
          baseSnapshot: input.cloud.race,
          expectedVersion: input.cloud.version,
          predecessorMutationId: input.original.mutationId,
        },
        { now: () => now, randomUUID: input.randomUUID },
      )
    : null;
  const resolvedConflict: SyncConflict = {
    ...input.conflict,
    status: "resolved",
    resolution: input.choice === "cloud" ? "remote" : "local",
    resolvedAt: now.toISOString(),
  };
  return {
    workspace,
    successor,
    nameChanged,
    resolvedConflict,
  };
}
